// How a presenter view reaches the talk. In the page that opened the talk it attaches to the
// Talk directly; in the second window of two-screen mode it goes through a local channel to the
// window that did.
import { parseMessage, randomSid } from "../core/protocol";
import type { Envelope, Message } from "../core/protocol";
import { openLocalChannel } from "../shared/local-channel";
import type { LocalFrame, PresenterDeck } from "../shared/local-channel";
import type { LinkStatus } from "../shared/relay-client";
import type { Talk } from "../shared/talk";

export type ClientKind = "talk" | "local";

export interface ClientHandlers {
  onMessage(envelope: Envelope): void;
  onStatus(status: LinkStatus): void;
}

export interface ConsoleClient {
  readonly kind: ClientKind;
  /** The sender id this view's own messages carry. */
  readonly sid: string;
  /** True while this very device runs the talk: nothing to wait for, nothing to measure. */
  readonly hosting: boolean;
  /** Sends if possible. Returns the message's sequence number, or 0 if it was not sent. */
  send(message: Message): number;
  reconnectNow(): void;
  close(): void;
}

/** The presenter view in the page that holds the talk. */
export class TalkClient implements ConsoleClient {
  readonly kind = "talk";
  private readonly stop: () => void;
  private readonly stopWatching: () => void;
  private closed = false;

  constructor(
    private readonly talk: Talk,
    handlers: ClientHandlers,
  ) {
    // Handed over after the current task, so an answer never arrives in the middle of sending.
    this.stop = talk.subscribe((envelope) =>
      queueMicrotask(() => {
        if (!this.closed) handlers.onMessage(envelope);
      }),
    );
    this.stopWatching = talk.watchConnection((status) =>
      queueMicrotask(() => {
        if (!this.closed) handlers.onStatus(status);
      }),
    );
  }

  get sid(): string {
    return this.talk.sid;
  }
  get hosting(): boolean {
    return this.talk.peer.hosting;
  }

  send(message: Message): number {
    return this.closed ? 0 : this.talk.peer.send(message);
  }

  reconnectNow(): void {
    this.talk.reconnectNow();
  }

  close(): void {
    this.closed = true;
    this.stop();
    this.stopWatching();
  }
}

/** A second window on the same computer, joined to the window that holds the talk by a BroadcastChannel. */
export class LocalClient implements ConsoleClient {
  readonly kind = "local";
  readonly sid = randomSid();
  readonly hosting = false;
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
    this.post({ k: "msg", sid: this.sid, seq: this.seq, type: message.type, body: message.body });
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
