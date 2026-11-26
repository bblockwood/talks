// The audience window's side of Mode B: opens the presenter window on the other screen and keeps
// it supplied with the deck and the session state. If the window can't be opened or is closed,
// the talk simply continues as Mode A.
import { inkCommand, parseCommand, parseMessage } from "../core/protocol";
import type { Presentation } from "./presentation";
import { SWAP_MESSAGE, randomChannelName } from "./presenter-channel";
import type { PresenterDeck, ToAudience, ToPresenter } from "./presenter-channel";

const INFO_EVERY_MS = 1000;

export class PresenterHost {
  private readonly channelName = randomChannelName();
  private readonly channel: BroadcastChannel;
  private popup: Window | null = null;
  private timer: number | undefined;
  private deck: PresenterDeck | null;
  private closed = false;
  /** Which screen has the slides and which the presenter window, when the browser told us. */
  private placement: { audience: ScreenDetailed; presenter: ScreenDetailed } | null = null;

  constructor(
    private readonly presentation: Presentation,
    deck: PresenterDeck,
  ) {
    this.deck = deck;
    this.channel = new BroadcastChannel(`lectern-${this.channelName}`);
    this.channel.onmessage = (ev: MessageEvent) => this.onMessage(ev.data as ToAudience);
    presentation.onChange = () => this.sendState();
    presentation.onEnd = () => this.close();
    presentation.onSwapKey = () => void this.swap();
    window.addEventListener("message", this.onWindowMessage);
  }

  /**
   * The presenter window's Swap button arrives here directly (not over the BroadcastChannel),
   * because only a direct postMessage can hand over the click's permission to change full screen.
   */
  private readonly onWindowMessage = (ev: MessageEvent): void => {
    if (ev.origin !== window.location.origin || ev.source !== this.popup || ev.data !== SWAP_MESSAGE) return;
    void this.swap();
  };

  /** Swap displays (Native §6.1): slides move to the presenter's screen and the presenter window to the other. */
  async swap(): Promise<void> {
    const placement = this.placement;
    if (this.closed || !placement) return;
    try {
      await this.presentation.moveToScreen(placement.presenter);
    } catch {
      this.post({ t: "notice", text: "Could not swap: click the slides once, then press Ctrl+D (Cmd+D on a Mac) there." });
      return;
    }
    this.placement = { audience: placement.presenter, presenter: placement.audience };
    const to = placement.audience;
    try {
      this.popup?.moveTo(to.availLeft, to.availTop);
      this.popup?.resizeTo(to.availWidth, to.availHeight);
      this.popup?.focus();
    } catch {
      // The browser would not move the window; it can be dragged across by hand.
    }
  }

  /**
   * Opens the presenter window filling `screen` (or wherever the browser puts it). Call this in
   * the Start click, right after full screen was granted: Chromium allows one such companion
   * window from the same gesture. Returns false if the browser blocked it.
   */
  open(screen: ScreenDetailed | null, audience: ScreenDetailed | null = null): boolean {
    if (screen && audience) this.placement = { audience, presenter: screen };
    const features = screen
      ? `popup,left=${screen.availLeft},top=${screen.availTop},width=${screen.availWidth},height=${screen.availHeight}`
      : "popup,width=1200,height=750";
    const popup = window.open(`${import.meta.env.BASE_URL}presenter/#ch=${this.channelName}`, "lectern-presenter", features);
    if (!popup) {
      this.close();
      return false;
    }
    this.popup = popup;
    this.timer = window.setInterval(() => {
      if (popup.closed) this.close(); // the user closed it: carry on with the audience view alone
      else this.sendState();
    }, INFO_EVERY_MS);
    return true;
  }

  private post(message: ToPresenter): void {
    if (!this.closed) this.channel.postMessage(message);
  }

  private sendState(): void {
    this.post({ t: "state", state: this.presentation.currentState, info: this.presentation.info() });
  }

  private onMessage(message: ToAudience): void {
    if (this.closed || typeof message !== "object" || message === null) return;
    switch (message.t) {
      case "ready":
        if (this.deck) {
          // A copy per request, so a reloaded presenter window can ask again.
          this.post({ t: "deck", deck: { ...this.deck, pdf: this.deck.pdf.slice(0) } });
          this.sendState();
        }
        break;
      case "command": {
        const command = parseCommand(message.command);
        if (command) this.presentation.dispatch(command, performance.now());
        break;
      }
      case "pointer":
        this.presentation.pointer(Number(message.x), Number(message.y), message.visible === true);
        break;
      case "ink": {
        // Validated exactly like ink from a phone; "presenter" stands in for a sender id.
        const parsed = parseMessage("ink", message.ink);
        const command = parsed?.type === "ink" ? inkCommand("presenter", parsed.body) : null;
        if (command) this.presentation.dispatch(command, performance.now());
        break;
      }
      case "end":
        void this.presentation.end();
        break;
      case "closed":
        this.close();
        break;
      default:
        break;
    }
  }

  /** Ends Mode B: tells the presenter window to go, and drops the deck copy held for it. */
  close(): void {
    if (this.closed) return;
    this.post({ t: "end" });
    this.closed = true;
    window.clearInterval(this.timer);
    this.presentation.onChange = null;
    this.presentation.onEnd = null;
    this.presentation.onSwapKey = null;
    window.removeEventListener("message", this.onWindowMessage);
    this.deck = null;
    this.channel.close();
    try {
      this.popup?.close();
    } catch {
      // Already gone.
    }
    this.popup = null;
  }
}
