// How a presenter view talks to whatever is running the talk. Three ways in, one interface:
// the relay (another device, joined by code), a local channel (a second window on the room PC),
// and none at all (rehearsal, where the talk runs inside the presenter view itself).
import { SessionHost } from "../core/host";
import { parseMessage, randomSid } from "../core/protocol";
import type { Envelope, Message } from "../core/protocol";
import type { Deck } from "../shared/deck";
import { openLocalChannel } from "../shared/local-channel";
import type { LocalFrame, PresenterDeck } from "../shared/local-channel";
import { deviceName } from "../shared/relay-client";
import type { LinkStatus } from "../shared/relay-client";

export type ClientKind = "relay" | "local" | "solo";

export interface ClientHandlers {
  onMessage(envelope: Envelope): void;
  onStatus(status: LinkStatus): void;
}

export interface ConsoleClient {
  readonly kind: ClientKind;
  /** This presenter view's sender id. */
  readonly sid: string;
  /** The session id of the talk being driven, once known; quoted on everything sent. */
  target: string | undefined;
  /** Sends if connected. Returns the message's sequence number, or 0 if it was not sent. */
  send(message: Message): number;
  reconnectNow(): void;
  close(): void;
}

/** A second window on the room PC, joined to the audience window by a BroadcastChannel. */
export class LocalClient implements ConsoleClient {
  readonly kind = "local";
  readonly sid = randomSid();
  target: string | undefined;
  private readonly channel: BroadcastChannel;
  private seq = 0;
  private closed = false;

  constructor(
    channelName: string,
    private readonly handlers: ClientHandlers & { onDeck(deck: PresenterDeck): void; onNotice(text: string): void; onEnd(): void },
  ) {
    this.channel = openLocalChannel(channelName);
    this.channel.onmessage = (ev: MessageEvent) => {
      const frame = ev.data as LocalFrame;
      if (this.closed || typeof frame !== "object" || frame === null) return;
      if (frame.k === "deck") handlers.onDeck(frame.deck);
      else if (frame.k === "notice") handlers.onNotice(String(frame.text));
      else if (frame.k === "end") handlers.onEnd();
      else if (frame.k === "msg") {
        const message = parseMessage(frame.type, frame.body);
        if (message) handlers.onMessage({ sid: String(frame.sid), seq: Number(frame.seq), ...message });
      }
    };
    queueMicrotask(() => handlers.onStatus("connected"));
  }

  requestDeck(): void {
    this.post({ k: "deck-request" });
  }

  send(message: Message): number {
    this.seq += 1;
    this.post({ k: "msg", sid: this.sid, seq: this.seq, ...(this.target ? { to: this.target } : {}), type: message.type, body: message.body });
    return this.seq;
  }

  reconnectNow(): void {}

  close(): void {
    if (this.closed) return;
    this.post({ k: "closed" });
    this.closed = true;
    this.channel.close();
  }

  private post(frame: LocalFrame): void {
    if (this.closed) return;
    try {
      this.channel.postMessage(frame);
    } catch {
      // The channel is already closed because the talk has ended.
    }
  }
}

/**
 * Rehearsal: no room PC and no network. The same session host that runs on the room PC runs
 * here, so slides, links, the clock and ink all behave exactly as they will in the talk.
 */
export class SoloClient implements ConsoleClient {
  readonly kind = "solo";
  readonly sid = randomSid();
  target: string | undefined;
  private readonly host: SessionHost;
  private seq = 0;
  private hostSeq = 0;
  private closed = false;
  private readonly heartbeat: number;

  constructor(deck: Deck, targetMs: number | null, handlers: ClientHandlers & { onEnd(): void }) {
    this.host = new SessionHost(
      {
        get frames() {
          return deck.frames;
        },
        get split() {
          return deck.split;
        },
        linksFor: (page) => deck.linksNow(page),
      },
      { deckPublished: "", targetMs, device: deviceName() },
      {
        now: () => Date.now(),
        send: (message) => {
          const envelope: Envelope = { sid: this.host.session, seq: ++this.hostSeq, ...message };
          queueMicrotask(() => {
            if (!this.closed) handlers.onMessage(envelope);
          });
        },
        applied: () => {},
        pointer: () => {},
        end: () => handlers.onEnd(),
        status: () => ({ relay: "rehearsal", draw: { count: 0, medianMs: null, lastMs: null, maxMs: null }, cacheMisses: 0 }),
      },
    );
    this.target = this.host.session;
    this.heartbeat = window.setInterval(() => this.host.broadcast(), 5000);
    queueMicrotask(() => {
      handlers.onStatus("connected");
      this.host.announce();
    });
  }

  send(message: Message): number {
    if (this.closed) return 0;
    this.seq += 1;
    const envelope: Envelope = { sid: this.sid, seq: this.seq, ...(this.target ? { to: this.target } : {}), ...message };
    queueMicrotask(() => {
      if (!this.closed) this.host.receive(envelope);
    });
    return this.seq;
  }

  reconnectNow(): void {}

  close(): void {
    this.closed = true;
    window.clearInterval(this.heartbeat);
  }
}
