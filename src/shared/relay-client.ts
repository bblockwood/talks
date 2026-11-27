// Relay connection (SPEC §8): encrypts and orders messages, reconnects by itself with backoff
// and jitter from 0.5 s up to 10 s. Nothing here ever blocks the caller: with the relay down,
// `send` simply drops the message, and the room PC keeps presenting.
import { Channel } from "../core/protocol";
import type { Envelope, Message } from "../core/protocol";

export const RELAY_URL: string = import.meta.env.VITE_RELAY_URL ?? "";

export type LinkStatus = "unavailable" | "connecting" | "connected" | "reconnecting";

export interface RelayOptions {
  readonly roomId: string;
  readonly channelKey: CryptoKey;
  /** This device's sender id. */
  readonly sid: string;
  onMessage(envelope: Envelope): void;
  onStatus(status: LinkStatus): void;
}

export function deviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  if (/Windows/.test(ua)) return "Windows PC";
  if (/Macintosh/.test(ua)) return "Mac";
  if (/Linux/.test(ua)) return "Linux PC";
  return "Browser";
}

export class RelayClient {
  readonly channel: Channel;

  /** This device's sender id. */
  get sid(): string {
    return this.channel.sid;
  }

  private socket: WebSocket | null = null;
  private attempt = 0;
  private retryTimer: number | undefined;
  private closed = false;
  private status: LinkStatus = "connecting";
  /** Seal and open are asynchronous; chaining them keeps messages in order. */
  private outgoing: Promise<void> = Promise.resolve();
  private incoming: Promise<void> = Promise.resolve();

  constructor(private readonly options: RelayOptions) {
    this.channel = new Channel(options.channelKey, options.sid);
    if (!RELAY_URL) {
      this.closed = true;
      this.setStatus("unavailable");
      return;
    }
    window.addEventListener("online", this.reconnectNow);
    this.connect();
  }

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  /**
   * Sends if connected; otherwise the message is dropped. `to` is the talk session it is meant
   * for. Returns the message's seq, or 0 if not sent.
   */
  send(message: Message, to?: string): number {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return 0;
    const seq = this.channel.nextSeq;
    const sealed = this.channel.seal(message, to);
    this.outgoing = this.outgoing
      .then(() => sealed)
      .then((frame) => {
        if (socket.readyState === WebSocket.OPEN) socket.send(frame);
      })
      .catch(() => {});
    return seq;
  }

  /** Skips the backoff wait, e.g. when the page returns from the background. */
  readonly reconnectNow = (): void => {
    if (this.closed || this.connected) return;
    window.clearTimeout(this.retryTimer);
    this.attempt = 0;
    this.connect();
  };

  /** Development and tests only: drops the socket as a network failure would, so the client must recover. */
  dropForTest(): void {
    this.socket?.close(4000);
  }

  /** Closes once anything already handed to `send` has gone out. */
  close(): Promise<void> {
    this.closed = true;
    window.clearTimeout(this.retryTimer);
    window.removeEventListener("online", this.reconnectNow);
    const socket = this.socket;
    this.socket = null;
    return this.outgoing.then(() => socket?.close(1000));
  }

  private setStatus(status: LinkStatus): void {
    if (status === this.status) return;
    this.status = status;
    this.options.onStatus(status);
  }

  private connect(): void {
    if (this.closed) return;
    const old = this.socket;
    this.socket = null;
    old?.close();
    this.setStatus(this.attempt === 0 && this.status !== "reconnecting" ? "connecting" : "reconnecting");

    let socket: WebSocket;
    try {
      socket = new WebSocket(`${RELAY_URL}/room/${this.options.roomId}`);
    } catch {
      this.scheduleRetry();
      return;
    }
    socket.binaryType = "arraybuffer";
    this.socket = socket;

    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.attempt = 0;
      this.setStatus("connected");
    };
    socket.onmessage = (ev: MessageEvent) => {
      if (this.socket !== socket || !(ev.data instanceof ArrayBuffer)) return;
      const frame = new Uint8Array(ev.data);
      this.incoming = this.incoming
        .then(() => this.channel.open(frame))
        .then((envelope) => {
          if (envelope && !this.closed) this.options.onMessage(envelope);
        })
        .catch(() => {});
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.scheduleRetry();
    };
  }

  private scheduleRetry(): void {
    if (this.closed) return;
    this.setStatus("reconnecting");
    const ceiling = Math.min(10_000, 500 * 2 ** this.attempt);
    this.attempt += 1;
    // Full jitter on the upper half, so a room of devices doesn't reconnect in step.
    const delay = ceiling * (0.5 + Math.random() / 2);
    this.retryTimer = window.setTimeout(() => this.connect(), delay);
  }
}
