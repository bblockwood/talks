// The authoritative side of a talk (SPEC §8.2): it owns the session state, applies commands from
// any device, and tells every device what happened. No DOM here. Exactly one device in a talk
// runs this at a time; which one, and how it hands over, is decided in peer.ts.
import type { FrameIndex } from "./frames";
import type { InkLayer, InkState } from "./ink";
import type { PageLink } from "./links";
import { APP_VERSION, inkCommand, randomSid, stateBody } from "./protocol";
import type { Ack, Envelope, Message, RoomInfo, StateBody, StrokeOp, View } from "./protocol";
import { apply, initialState, inkLayer } from "./session";
import type { Command, SessionState } from "./session";

/** The deck as the host needs it. `frames` and `split` are read each time: the split can change before Start. */
export interface HostDeck {
  readonly frames: FrameIndex;
  readonly split: string | null;
  linksFor(page: number): readonly PageLink[] | undefined;
}

export interface HostHooks {
  /** Wall-clock milliseconds. */
  now(): number;
  /** Deliver a message to every presenter view, over whatever connections exist. */
  send(message: Message): void;
  /** The state changed: draw it. `inputTime` is when the causing input arrived, for timing. */
  applied(state: SessionState, inputTime: number | undefined): void;
  pointer(x: number, y: number, visible: boolean): void;
  /** A presenter view asked to end the talk. */
  end(): void;
  /** Status that only the caller knows: relay connection, draw timings. */
  status(): Omit<RoomInfo, "devices" | "audiences">;
  /** What the hosting device itself shows right now. */
  view(): View;
  /** When (ms, this device's clock) its connection to the others opened: see `outranks` in peer.ts. */
  since(): number;
}

export interface HostOptions {
  readonly deckPublished: string;
  readonly targetMs: number | null;
  readonly device: string;
  /** The hosting device's own sender id: its own views are not counted as further devices. */
  readonly self: string;
}

/**
 * The session state a new host starts from when it takes a talk over: what the last host
 * reported, plus this device's copy of the ink. The clock carries on from the reported time.
 */
export function restoreState(body: StateBody, ink: InkState, elapsedSince: number, now: number): SessionState {
  const elapsed = body.timer.elapsedMs + (body.timer.running ? Math.max(0, elapsedSince) : 0);
  return {
    ...initialState,
    committedPage: body.page,
    audienceMode: body.audienceMode,
    history: body.history,
    forwardHistory: body.forwardHistory,
    timer: { accumulatedMs: elapsed, runningSince: body.timer.running ? now : null, targetMs: body.timer.targetMs },
    ink,
  };
}

const DEVICE_TIMEOUT_MS = 10_000;
const APPEND_CHUNK = 256;

export class SessionHost {
  /** Random per talk; presenter views must quote it, so old recorded frames can't be replayed. */
  readonly session = randomSid();
  private current: SessionState;
  private readonly devices = new Map<string, { device: string; view: View | undefined; at: number }>();
  private readonly deck: HostDeck;
  private readonly options: HostOptions;
  private readonly hooks: HostHooks;

  /** `from` is the state to carry on from when taking a talk over; without it the talk starts fresh. */
  constructor(deck: HostDeck, options: HostOptions, hooks: HostHooks, from?: SessionState) {
    this.deck = deck;
    this.options = options;
    this.hooks = hooks;
    // The clock waits for the first slide change (see session.ts).
    this.current = from ?? { ...initialState, timer: { accumulatedMs: 0, runningSince: null, targetMs: options.targetMs } };
  }

  get state(): SessionState {
    return this.current;
  }

  /** Announces this host and its state, e.g. at Start and after a reconnect. */
  announce(): void {
    this.hooks.send({
      type: "hello",
      body: { role: "room", device: this.options.device, appVersion: APP_VERSION, session: this.session, view: this.hooks.view() },
    });
    this.broadcast();
  }

  /**
   * Applies a command. `origin` is the sender id of the presenter view it came from (absent for
   * the room PC's own keyboard and mouse); `ack` names its message so the sender can time it.
   */
  dispatch(requested: Command, inputTime?: number, origin?: string, ack?: Ack): void {
    const previous = this.current;
    // "Freeze" means freeze what the audience sees now. A presenter view names the page it last
    // heard about, which lags by a round trip, so the page is always taken from here.
    const command: Command =
      requested.name === "setAudienceMode" && requested.mode.kind === "frozen"
        ? { name: "setAudienceMode", mode: { kind: "frozen", page: previous.committedPage } }
        : requested;
    const layer = inkLayer(previous);
    const next = apply(previous, command, { frames: this.deck.frames, linksFor: (p) => this.deck.linksFor(p) }, this.hooks.now());
    if (next === previous) {
      if (ack) this.broadcast(ack); // nothing changed (Next on the last slide), but the sender still gets its answer
      return;
    }
    this.current = next;
    this.hooks.applied(next, inputTime);
    this.relayInk(command, previous, next, layer, origin ?? this.session);
    // Points streaming into a stroke change nothing a presenter view needs a `state` for.
    const onlyPoints =
      command.name === "inkAppend" && next.ink.page.length === previous.ink.page.length && next.ink.board.length === previous.ink.board.length;
    if (!onlyPoints || ack) this.broadcast(ack);
  }

  /**
   * Handles a message from another device, or (`own`) from one of the hosting device's own views.
   * Anything not meant for this session is ignored.
   */
  receive(envelope: Envelope, own = false): void {
    const now = this.hooks.now();
    own ||= envelope.sid === this.options.self;
    if (envelope.type === "hello") {
      if (envelope.body.role === "room") return; // another host: peer.ts settles that
      if (!own) this.devices.set(envelope.sid, { device: envelope.body.device, view: envelope.body.view, at: now });
      this.announce(); // late joiners sync: who we are, the state, and the ink so far
      this.sendInkCopy();
      return;
    }
    const known = own ? undefined : this.devices.get(envelope.sid);
    if (known) known.at = now;

    if (envelope.type === "ping") {
      this.hooks.send({ type: "pong", body: { t: envelope.body.t } });
      return;
    }
    // Everything that changes the talk must quote this session's id.
    if (envelope.to !== this.session) return;
    if (!known && !own) this.devices.set(envelope.sid, { device: "", view: undefined, at: now });
    switch (envelope.type) {
      case "command":
        // Anyone who can decrypt is authorised: knowing the code is the credential (SPEC §8.2).
        this.dispatch(envelope.body, undefined, envelope.sid, { sid: envelope.sid, seq: envelope.seq });
        break;
      case "ink": {
        const command = inkCommand(envelope.sid, envelope.body);
        if (command) this.dispatch(command, undefined, envelope.sid);
        break;
      }
      case "pointer":
        this.hooks.pointer(envelope.body.x, envelope.body.y, envelope.body.visible);
        break;
      case "end":
        this.hooks.end();
        break;
      default:
        break;
    }
  }

  /** The room PC is authoritative: `state` goes out after every change and as a heartbeat. */
  broadcast(ack?: Ack): void {
    const now = this.hooks.now();
    for (const [sid, d] of this.devices) if (now - d.at > DEVICE_TIMEOUT_MS) this.devices.delete(sid);
    const others = [...this.devices.values()];
    const view = this.hooks.view();
    const room: RoomInfo = {
      ...this.hooks.status(),
      devices: [this.options.device, ...others.map((d) => d.device || "device")],
      audiences: (view === "audience" ? 1 : 0) + others.filter((d) => d.view === "audience").length,
    };
    this.hooks.send({
      type: "state",
      body: stateBody(this.current, this.deck.frames, now, {
        deckPublished: this.options.deckPublished,
        split: this.deck.split,
        session: this.session,
        hostView: view,
        since: this.hooks.since(),
        room,
        ...(ack ? { ack } : {}),
      }),
    });
  }

  /** Tells the other presenter views about ink the host just applied. */
  private relayInk(command: Command, previous: SessionState, next: SessionState, layer: InkLayer, from: string): void {
    let op: StrokeOp | null = null;
    switch (command.name) {
      case "inkBegin":
        if (next.ink !== previous.ink) {
          op = { op: "begin", from, layer, id: command.id, x: command.x, y: command.y, color: command.color, width: command.width };
        }
        break;
      case "inkAppend":
        if (next.ink !== previous.ink) op = { op: "append", from, id: command.id, points: command.points };
        break;
      case "inkUndo":
      case "inkClear":
        if (next.ink !== previous.ink) op = { op: command.name === "inkUndo" ? "undo" : "clear", from, layer };
        break;
      default:
        break;
    }
    if (op) this.hooks.send({ type: "strokes", body: op });
  }

  /** A full copy of the ink, in pieces small enough for the relay. */
  sendInkCopy(): void {
    const { ink } = this.current;
    if (ink.page.length === 0 && ink.board.length === 0) return;
    const send = (body: StrokeOp): void => this.hooks.send({ type: "strokes", body });
    send({ op: "reset" });
    for (const layer of ["page", "board"] as const) {
      for (const stroke of ink[layer]) {
        const [x = 0, y = 0] = stroke.points;
        send({ op: "begin", from: this.session, layer, id: stroke.id, x, y, color: stroke.color, width: stroke.width });
        for (let i = 2; i < stroke.points.length; i += APPEND_CHUNK) {
          send({ op: "append", from: this.session, id: stroke.id, points: stroke.points.slice(i, i + APPEND_CHUNK) });
        }
      }
    }
  }
}
