// One talk, any number of devices (Ben, 2026-11-27). Every device that opens a talk runs a Peer.
// Exactly one peer hosts the talk (it runs the SessionHost and is authoritative); the others
// follow it. Which one hosts:
//   - the first device in, whatever it shows;
//   - a device showing the slides takes over from a host that is not, so the audience screen's
//     own keyboard and clicker never depend on the network;
//   - when the host leaves or falls silent, a follower takes over from the last state it heard;
//   - two hosts that meet (after a network split) settle it at once with `outranks`.
// No DOM and no timers here: the owner calls `tick` regularly and supplies the clock.
import { SessionHost, restoreState } from "./host";
import type { HostDeck } from "./host";
import { NO_INK, appendToStroke, beginStroke, clearLayer, undoStroke } from "./ink";
import type { InkState } from "./ink";
import { APP_VERSION } from "./protocol";
import type { Envelope, Message, RoomInfo, StateBody, StrokeOp, View } from "./protocol";
import { initialState } from "./session";
import type { Command, SessionState } from "./session";

/** How long a newcomer listens for a host before starting the talk itself. */
export const JOIN_WAIT_MS = 1500;
/** The host sends `state` at least this often. */
export const HEARTBEAT_MS = 2500;
/** A host silent for this long is gone. */
export const HOST_TIMEOUT_MS = 8000;
const KEEPALIVE_MS = 4000;
const REASSERT_MS = 1000;

const NEVER = Number.MAX_SAFE_INTEGER;

export type PeerRole = "listening" | "host" | "follower";

/** A host as others see it. */
export interface HostClaim {
  readonly sid: string;
  readonly view: View;
  /** When its connection opened, on its own clock. A device with no connection claims `NEVER`. */
  readonly since: number;
}

/**
 * Which of two hosts keeps the talk. A slides screen beats a presenter view; then the one that
 * has been connected longer (the one that just came back from a network drop gives way); then
 * the lower id. Both sides compute this from the same numbers, so they agree.
 */
export function outranks(a: HostClaim, b: HostClaim): boolean {
  if (a.view !== b.view) return a.view === "audience";
  if (a.since !== b.since) return a.since < b.since;
  return a.sid < b.sid;
}

/** Applies ink as the host reports it to a follower's copy. */
export function followInk(ink: InkState, op: StrokeOp): InkState {
  switch (op.op) {
    case "reset":
      return NO_INK;
    case "begin":
      return beginStroke(ink, op.layer, op.id, op.x, op.y, op.color, op.width);
    case "append":
      return appendToStroke(ink, op.id, op.points);
    case "undo":
      return undoStroke(ink, op.layer);
    case "clear":
      return clearLayer(ink, op.layer);
  }
}

export interface PeerHooks {
  /** Wall-clock milliseconds. */
  now(): number;
  /** Sends to the other devices. Returns the message's sequence number, or 0 if it could not be sent. */
  transmit(message: Message, to?: string): number;
  /** A message from whoever hosts the talk (possibly this device), for this device's own views. */
  deliver(envelope: Envelope): void;
  /** What the slides screen should show changed. `inputTime` is set when a local input caused it. */
  changed(inputTime: number | undefined): void;
  pointer(x: number, y: number, visible: boolean): void;
  /** The talk was ended for everyone. */
  end(): void;
  status(): Omit<RoomInfo, "devices" | "audiences">;
}

export interface PeerOptions {
  /** This device's sender id: the one its messages to other devices carry. */
  readonly sid: string;
  readonly device: string;
  readonly deckPublished: string;
  readonly targetMs: number | null;
  /** True when the talk starts on this device (a PDF opened here): there is nobody to listen for. */
  readonly originator?: boolean;
}

interface Followed extends HostClaim {
  session: string;
  seenAt: number;
  /** When it said it was leaving. */
  goneAt: number | null;
}

export class Peer {
  private readonly deck: HostDeck;
  private readonly options: PeerOptions;
  private readonly hooks: PeerHooks;

  private currentView: View | null = null;
  private currentRole: PeerRole = "listening";
  private sessionHost: SessionHost | null = null;
  private followed: Followed | null = null;
  /** The last state the followed host reported, and when. */
  private last: StateBody | null = null;
  private lastAt = 0;
  /** This device's copy of the ink while following. */
  private mirror: InkState = NO_INK;

  private readonly createdAt: number;
  /** When the connection to the other devices last opened; null while there is none. */
  private onlineSince: number | null = null;
  /** False for a talk that has no way to reach other devices (a PDF opened from disk). */
  private readonly networked: boolean;
  private lastHeartbeat = 0;
  private lastKeepalive = 0;
  private lastReassert = 0;
  private lastTick: number;
  private localSeq = 0;
  private closed = false;

  constructor(deck: HostDeck, options: PeerOptions & { networked: boolean }, hooks: PeerHooks) {
    this.deck = deck;
    this.options = options;
    this.hooks = hooks;
    this.networked = options.networked;
    this.createdAt = hooks.now();
    this.lastTick = this.createdAt;
  }

  get sid(): string {
    return this.options.sid;
  }
  get role(): PeerRole {
    return this.currentRole;
  }
  get view(): View | null {
    return this.currentView;
  }
  get hosting(): boolean {
    return this.sessionHost !== null;
  }
  /** True when another device runs the talk, as far as this one knows. */
  get following(): boolean {
    return this.sessionHost === null && this.followed !== null;
  }
  /** The session id messages must quote, once known. */
  get session(): string | undefined {
    return this.sessionHost?.session ?? this.followed?.session;
  }
  /** The host's last report, for a device that is choosing its view: is a talk already going? */
  get heard(): StateBody | null {
    return this.sessionHost ? null : this.last;
  }

  /** What the slides screen shows: the host's own state, or the followed host's as last reported. */
  viewState(): SessionState | null {
    if (this.sessionHost) return this.sessionHost.state;
    const last = this.last;
    if (!last) return null;
    return {
      ...initialState,
      committedPage: Math.min(last.page, Math.max(0, this.deck.frames.pageCount - 1)),
      audienceMode: last.audienceMode,
      history: last.history,
      forwardHistory: last.forwardHistory,
      ink: this.mirror,
    };
  }

  // ---------------------------------------------------------------- this device

  /** Chooses what this device shows. Until this is called the peer only listens. */
  setView(view: View): void {
    if (this.closed) return;
    this.currentView = view;
    if (this.sessionHost) {
      this.sessionHost.announce(); // the host's view is part of what it claims
      return;
    }
    this.hello(); // tells the host what this device now shows
    if (this.followed) this.currentRole = "follower";
    this.settle();
  }

  /** The connection to the other devices opened or closed. */
  online(connected: boolean): void {
    if (this.closed) return;
    const now = this.hooks.now();
    if (!connected) {
      this.onlineSince = null;
      return;
    }
    this.onlineSince = now;
    if (this.followed) this.followed.seenAt = now; // back from a drop: give the host a moment to answer
    if (this.sessionHost) this.sessionHost.announce();
    else this.hello();
  }

  /** A command from this device's own keyboard, mouse or clicker on the slides screen. */
  dispatch(command: Command, inputTime?: number): void {
    if (this.closed) return;
    this.hostIfAlone();
    if (this.sessionHost) this.sessionHost.dispatch(command, inputTime);
    else if (this.followed) this.hooks.transmit({ type: "command", body: command }, this.followed.session);
  }

  /** A message from one of this device's own views. Returns its sequence number, or 0 if it went nowhere. */
  send(message: Message): number {
    if (this.closed) return 0;
    if (message.type === "end") {
      this.endForEveryone();
      return 0;
    }
    if (message.type === "command" || message.type === "ink") this.hostIfAlone();
    if (this.sessionHost) {
      const host = this.sessionHost;
      const seq = ++this.localSeq;
      host.receive({ sid: this.options.sid, seq, to: host.session, ...message }, true);
      return seq;
    }
    if (!this.followed) return 0;
    if (message.type === "hello") return this.hello();
    return this.hooks.transmit(message, this.followed.session);
  }

  /** A message from this device's second window (two-screen mode), which has its own sender id. */
  fromLocal(envelope: Envelope): void {
    if (this.closed) return;
    if (envelope.type === "end") {
      this.endForEveryone();
      return;
    }
    if (this.sessionHost) {
      this.sessionHost.receive({ ...envelope, to: this.sessionHost.session }, true);
      return;
    }
    if (!this.followed) return;
    switch (envelope.type) {
      case "hello":
        this.hello(); // the host's answer reaches the window like every other message
        break;
      case "command":
      case "pointer":
      case "ping":
        this.hooks.transmit({ type: envelope.type, body: envelope.body } as Message, this.followed.session);
        break;
      default:
        break; // ink from a second window is only carried when this device hosts
    }
  }

  /** Ends the talk on every device, this one included. */
  endForEveryone(): void {
    const session = this.session;
    if (session) this.hooks.transmit({ type: "end", body: {} }, session);
    this.hooks.end();
  }

  /** This device is leaving; the talk goes on without it. */
  leave(): void {
    if (this.closed) return;
    if (this.sessionHost) this.hooks.transmit({ type: "bye", body: {} });
    this.closed = true;
    this.sessionHost = null;
  }

  // ---------------------------------------------------------------- the other devices

  receive(envelope: Envelope): void {
    if (this.closed) return;
    const now = this.hooks.now();
    const host = this.sessionHost;

    // Another device says it hosts.
    if (envelope.type === "state" || (envelope.type === "hello" && envelope.body.role === "room")) {
      const claim: HostClaim =
        envelope.type === "state"
          ? { sid: envelope.sid, view: envelope.body.hostView, since: envelope.body.since }
          : { sid: envelope.sid, view: envelope.body.view ?? "presenter", since: this.followed?.sid === envelope.sid ? this.followed.since : NEVER };
      const session = envelope.type === "state" ? envelope.body.session : (envelope.body.session ?? "");
      if (host) {
        if (envelope.type !== "state") return; // a hello lacks what `outranks` needs; its state follows
        if (outranks(this.claim(), claim)) {
          // Ours stands. Say so, so the other one follows; not more than once a second.
          if (now - this.lastReassert >= REASSERT_MS) {
            this.lastReassert = now;
            host.announce();
          }
          return;
        }
        this.sessionHost = null; // theirs stands: follow it
        this.currentRole = "follower";
        this.followed = null;
      }
      const current = this.followed;
      const stale = current !== null && (current.goneAt !== null || now - current.seenAt > HOST_TIMEOUT_MS);
      if (current && current.sid !== envelope.sid && !stale && !outranks(claim, current)) return; // a host about to give way
      const switched = !current || current.sid !== envelope.sid;
      if (switched) {
        this.mirror = NO_INK;
        this.last = null;
      }
      this.followed = { ...claim, session: session || (switched ? "" : (current?.session ?? "")), seenAt: now, goneAt: null };
      if (envelope.type === "state") {
        // Ink belongs to its page.
        if (this.last && this.last.page !== envelope.body.page) this.mirror = clearLayer(this.mirror, "page");
        else if (envelope.body.ink === 0) this.mirror = clearLayer(this.mirror, envelope.body.audienceMode.kind === "white" ? "board" : "page");
        this.last = envelope.body;
        this.lastAt = now;
      }
      if (switched) this.hello(); // a host new to us: be counted, and ask for the state and the ink
      this.hooks.deliver(envelope);
      if (this.currentView !== null) {
        this.currentRole = "follower";
        this.settle();
        if (!this.sessionHost) this.hooks.changed(undefined);
      }
      return;
    }

    if (host) {
      if (envelope.type === "end") {
        if (envelope.to === host.session) this.hooks.end();
        return;
      }
      if (envelope.type === "bye" || envelope.type === "strokes" || envelope.type === "pong") return;
      host.receive(envelope);
      return;
    }

    const followed = this.followed;
    if (!followed) return;
    const fromHost = envelope.sid === followed.sid;
    if (fromHost) followed.seenAt = now;
    switch (envelope.type) {
      case "strokes":
        if (!fromHost) return;
        this.mirror = followInk(this.mirror, envelope.body);
        this.hooks.deliver(envelope);
        if (this.currentView !== null) this.hooks.changed(undefined);
        break;
      case "pong":
        if (fromHost) this.hooks.deliver(envelope);
        break;
      case "pointer":
        // Every slides screen shows the pointer, not only the host's.
        if (envelope.to === followed.session) this.hooks.pointer(envelope.body.x, envelope.body.y, envelope.body.visible);
        break;
      case "end":
        if (envelope.to === followed.session) this.hooks.end();
        break;
      case "bye":
        if (fromHost) followed.goneAt = now; // `tick` picks a successor
        break;
      default:
        break; // commands and ink are the host's to handle
    }
  }

  /** Call a few times a second: heartbeats, keepalives, and noticing that the host has gone. */
  tick(): void {
    if (this.closed) return;
    const now = this.hooks.now();
    // A device that was asleep (a laptop lid, a tab the browser froze) has been as good as
    // disconnected: if someone took the talk over meanwhile, theirs is the one to keep.
    if (now - this.lastTick > HOST_TIMEOUT_MS && this.onlineSince !== null) this.onlineSince = now;
    this.lastTick = now;
    if (this.sessionHost) {
      if (now - this.lastHeartbeat >= HEARTBEAT_MS) {
        this.lastHeartbeat = now;
        this.sessionHost.broadcast();
      }
      return;
    }
    if (this.followed && now - this.lastKeepalive >= KEEPALIVE_MS) {
      this.lastKeepalive = now;
      this.hooks.transmit({ type: "ping", body: { t: 0 } }, this.followed.session); // so the host keeps counting this device
    }
    this.settle();
  }

  // ---------------------------------------------------------------- deciding who hosts

  private claim(): HostClaim {
    return { sid: this.options.sid, view: this.currentView ?? "presenter", since: this.onlineSince ?? NEVER };
  }

  private hello(): number {
    return this.hooks.transmit({
      type: "hello",
      body: { role: "presenter", device: this.options.device, appVersion: APP_VERSION, ...(this.currentView ? { view: this.currentView } : {}) },
    });
  }

  /**
   * Input on this device never waits: if no host has been heard yet, the talk starts here now.
   * Should another host turn up after all, `outranks` settles it.
   */
  private hostIfAlone(): void {
    if (!this.sessionHost && !this.followed && this.currentView !== null) this.becomeHost();
  }

  /** Becomes the host if the rules say this device should be. */
  private settle(): void {
    if (this.sessionHost || this.currentView === null) return;
    const now = this.hooks.now();
    const followed = this.followed;
    if (followed) {
      // Followers take over in an order set by their ids, so two of them rarely try at once
      // (and `outranks` settles it if they do).
      const stagger = (parseInt(this.options.sid.slice(0, 4), 16) / 0xffff) * 1500;
      const gone = followed.goneAt !== null ? now - followed.goneAt >= stagger / 3 : now - followed.seenAt > HOST_TIMEOUT_MS + stagger;
      // A slides screen takes over from a host that is not one, once it knows where the talk is.
      const takeOver = this.currentView === "audience" && followed.view === "presenter" && this.last !== null;
      if (gone || takeOver) this.becomeHost();
      return;
    }
    // Nobody heard yet: listen for a moment after connecting, then start the talk here. Without
    // a connection, a networked talk waits a little longer for one; a local talk does not wait.
    const waited =
      this.options.originator === true ||
      (this.onlineSince !== null ? now - this.onlineSince >= JOIN_WAIT_MS : !this.networked || now - this.createdAt >= 2 * JOIN_WAIT_MS);
    if (waited) this.becomeHost();
  }

  private becomeHost(): void {
    const now = this.hooks.now();
    const from = this.last ? restoreState(this.last, this.mirror, now - this.lastAt, now) : undefined;
    const host = new SessionHost(
      this.deck,
      { deckPublished: this.options.deckPublished, targetMs: this.options.targetMs, device: this.options.device, self: this.options.sid },
      {
        now: this.hooks.now,
        send: (message) => {
          if (this.sessionHost !== host) return;
          const seq = this.hooks.transmit(message);
          this.hooks.deliver({ sid: this.options.sid, seq: seq || ++this.localSeq, ...message });
        },
        applied: (_state, inputTime) => {
          if (this.sessionHost === host) this.hooks.changed(inputTime);
        },
        pointer: this.hooks.pointer,
        end: this.hooks.end,
        status: this.hooks.status,
        view: () => this.currentView ?? "presenter",
        since: () => this.onlineSince ?? NEVER,
      },
      from,
    );
    this.sessionHost = host;
    this.currentRole = "host";
    this.followed = null;
    this.last = null;
    this.mirror = NO_INK;
    this.lastHeartbeat = now;
    host.announce();
    this.hooks.changed(undefined);
  }
}
