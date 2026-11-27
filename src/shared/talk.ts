// A talk as one device sees it (Ben, 2026-11-27): the deck, the connection to the other devices
// that opened the same code, and the peer that decides who runs the talk. Whatever this device
// shows (the slides, the presenter view, or both on two screens) draws from here, and can change
// without the talk noticing.
import type { TalkKeys } from "../core/crypto";
import { Peer } from "../core/peer";
import { randomSid } from "../core/protocol";
import type { Envelope, RoomInfo } from "../core/protocol";
import type { Deck } from "./deck";
import type { PresenterDeck } from "./local-channel";
import { RELAY_URL, RelayClient, deviceName } from "./relay-client";
import type { LinkStatus } from "./relay-client";

export interface TalkSource {
  readonly deck: Deck;
  /** A copy of the PDF, for a presenter view in a second window. In memory only. */
  readonly pdf: ArrayBuffer;
  readonly title: string;
  readonly notes: Pick<PresenterDeck, "noteOverrides" | "pdfpcText" | "pptxNotes">;
  readonly targetMs: number | null;
  /** `meta.published` of this copy of the deck; empty for a PDF opened from disk. */
  readonly published: string;
  /** Null for a PDF opened from disk: the talk then lives on this device alone. */
  readonly keys: TalkKeys | null;
}

/** What the slides screen gives the talk while it is showing. */
export interface AudienceSink {
  changed(inputTime: number | undefined): void;
  pointer(x: number, y: number, visible: boolean): void;
  status(): Pick<RoomInfo, "draw" | "cacheMisses">;
}

const NO_DRAWS: RoomInfo["draw"] = { count: 0, medianMs: null, lastMs: null, maxMs: null };

export class Talk {
  readonly deck: Deck;
  readonly source: TalkSource;
  readonly sid = randomSid();
  readonly peer: Peer;
  /** "none" when the talk has no way to reach other devices. */
  relayStatus: LinkStatus | "none" = "none";
  audience: AudienceSink | null = null;
  /** The talk was ended for every device. */
  onEnd: (() => void) | null = null;
  /** Something a start page might show changed: the connection, or what the host reports. */
  onNews: (() => void) | null = null;

  private readonly relay: RelayClient | null;
  private readonly listeners = new Set<(envelope: Envelope) => void>();
  private readonly statusListeners = new Set<(status: LinkStatus) => void>();
  private readonly ticker: number;
  private closed = false;

  constructor(source: TalkSource) {
    this.source = source;
    this.deck = source.deck;
    const { deck } = source;
    const networked = source.keys !== null && RELAY_URL !== "";
    this.peer = new Peer(
      {
        get frames() {
          return deck.frames;
        },
        get split() {
          return deck.split;
        },
        linksFor: (page) => deck.linksNow(page),
      },
      { sid: this.sid, device: deviceName(), deckPublished: source.published, targetMs: source.targetMs, networked },
      {
        now: () => Date.now(),
        transmit: (message, to) => this.relay?.send(message, to) ?? 0,
        deliver: (envelope) => {
          for (const listener of [...this.listeners]) listener(envelope);
          if (envelope.type === "state") this.onNews?.();
        },
        changed: (inputTime) => this.audience?.changed(inputTime),
        pointer: (x, y, visible) => this.audience?.pointer(x, y, visible),
        end: () => this.onEnd?.(),
        status: () => ({ relay: this.relayStatus, ...(this.audience?.status() ?? { draw: NO_DRAWS, cacheMisses: 0 }) }),
      },
    );
    // Never waited on: with no connection the talk simply runs on this device (SPEC §8.4).
    this.relay =
      source.keys && networked
        ? new RelayClient({
            roomId: source.keys.roomId,
            channelKey: source.keys.channelKey,
            sid: this.sid,
            onMessage: (envelope) => this.peer.receive(envelope),
            onStatus: (status) => this.setRelayStatus(status),
          })
        : null;
    if (this.relay) this.relayStatus = this.relay.connected ? "connected" : "connecting";
    this.ticker = window.setInterval(() => this.peer.tick(), 250);
  }

  private setRelayStatus(status: LinkStatus): void {
    if (this.closed) return;
    const was = this.relayStatus;
    this.relayStatus = status;
    if ((status === "connected") !== (was === "connected")) this.peer.online(status === "connected");
    for (const listener of [...this.statusListeners]) listener(status);
    this.onNews?.();
  }

  /** Every message from whoever hosts the talk, for a view on this device. Returns the way to stop. */
  subscribe(listener: (envelope: Envelope) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The connection to the other devices, now and as it changes. A talk that has none counts as connected. */
  watchConnection(listener: (status: LinkStatus) => void): () => void {
    this.statusListeners.add(listener);
    listener(this.relayStatus === "none" ? "connected" : this.relayStatus);
    return () => this.statusListeners.delete(listener);
  }

  reconnectNow(): void {
    this.relay?.reconnectNow();
  }

  /** Development and tests only. */
  dropForTest(): void {
    this.relay?.dropForTest();
  }

  /**
   * This device leaves the talk, which goes on for the others. Resolves once the goodbye has
   * gone out (or at once if there is nobody to tell). The deck is the caller's to destroy.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.peer.leave();
    this.closed = true;
    window.clearInterval(this.ticker);
    this.listeners.clear();
    this.statusListeners.clear();
    this.audience = null;
    this.onNews = null;
    this.onEnd = null;
    const relay = this.relay;
    if (relay) await Promise.race([relay.close(), new Promise((resolve) => window.setTimeout(resolve, 400))]);
  }
}
