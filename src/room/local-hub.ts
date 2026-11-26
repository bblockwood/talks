// The audience window's side of two-screen mode: opens the presenter view in a second window on
// the other screen, hands it the deck, and carries protocol messages to and from it. If the
// window can't be opened or is closed, the talk simply continues without it.
import { parseMessage } from "../core/protocol";
import type { Envelope, Message } from "../core/protocol";
import { SWAP_MESSAGE, openLocalChannel, randomChannelName } from "../shared/local-channel";
import type { LocalFrame, PresenterDeck } from "../shared/local-channel";
import type { HostTransport, Presentation } from "./presentation";

export class LocalHub implements HostTransport {
  onMessage: ((envelope: Envelope) => void) | null = null;
  onStatus: ((status: string) => void) | null = null;
  readonly status = "connected";

  private readonly channelName = randomChannelName();
  private readonly channel: BroadcastChannel;
  private popup: Window | null = null;
  private watch: number | undefined;
  private deck: PresenterDeck | null;
  private closed = false;
  private seq = 0;
  /** Which screen has the slides and which the presenter window, when the browser told us. */
  private placement: { audience: ScreenDetailed; presenter: ScreenDetailed } | null = null;

  constructor(
    private readonly presentation: Presentation,
    deck: PresenterDeck,
  ) {
    this.deck = deck;
    this.channel = openLocalChannel(this.channelName);
    this.channel.onmessage = (ev: MessageEvent) => this.onFrame(ev.data as LocalFrame);
    window.addEventListener("message", this.onWindowMessage);
    presentation.onSwapKey = () => void this.swap();
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
    const popup = window.open(`${import.meta.env.BASE_URL}present/#ch=${this.channelName}`, "lectern-presenter", features);
    if (!popup) {
      this.close();
      return false;
    }
    this.popup = popup;
    this.presentation.addTransport(this);
    this.watch = window.setInterval(() => {
      if (popup.closed) this.close(); // the user closed it: carry on with the audience view alone
    }, 1000);
    return true;
  }

  send(message: Message): void {
    // The host's own id is not needed by the receiver, which has exactly one room: this window.
    this.post({ k: "msg", sid: "room", seq: ++this.seq, type: message.type, body: message.body });
  }

  private post(frame: LocalFrame): void {
    if (!this.closed) this.channel.postMessage(frame);
  }

  private onFrame(frame: LocalFrame): void {
    if (this.closed || typeof frame !== "object" || frame === null) return;
    switch (frame.k) {
      case "deck-request":
        // A copy per request, so a reloaded presenter window can ask again.
        if (this.deck) this.post({ k: "deck", deck: { ...this.deck, pdf: this.deck.pdf.slice(0) } });
        break;
      case "msg": {
        // Validated exactly like a message from the relay.
        const message = parseMessage(frame.type, frame.body);
        if (!message || typeof frame.sid !== "string" || typeof frame.seq !== "number") return;
        this.onMessage?.({ sid: frame.sid, seq: frame.seq, ...(typeof frame.to === "string" ? { to: frame.to } : {}), ...message });
        break;
      }
      case "closed":
        this.close();
        break;
      default:
        break;
    }
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
      this.post({ k: "notice", text: "Could not swap: click the slides once, then press Ctrl+D (Cmd+D on a Mac) there." });
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

  /** Ends two-screen mode: tells the presenter window to go, and drops the deck copy held for it. */
  close(): void {
    if (this.closed) return;
    this.post({ k: "end" });
    this.closed = true;
    window.clearInterval(this.watch);
    window.removeEventListener("message", this.onWindowMessage);
    this.presentation.removeTransport(this);
    if (this.presentation.onSwapKey) this.presentation.onSwapKey = null;
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
