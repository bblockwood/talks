// Relay protocol (SPEC §8). The relay forwards opaque binary frames; everything here is end to
// end between devices that know the talk code. WebCrypto only, no DOM.
import type { AudienceMode, Command, SessionState } from "./session";
import { elapsedMs, inkLayer } from "./session";
import type { FrameIndex } from "./frames";

export const APP_VERSION = "web-w3";
const IV_BYTES = 12;
const MAX_FRAME_BYTES = 64 * 1024; // the relay drops anything larger

export type Role = "room" | "presenter" | "remote";

export interface TimerSnapshot {
  readonly running: boolean;
  /** Elapsed at the moment the state was sent. The receiver extrapolates from when it arrived. */
  readonly elapsedMs: number;
  readonly targetMs: number | null;
}

/** Identifies the command a state message answers, so the sender can time the round trip. */
export interface Ack {
  readonly sid: string;
  readonly seq: number;
}

export interface StateBody {
  /** 0-based committed page. */
  readonly page: number;
  readonly frameLabel: string;
  /** 0-based build index within the frame. */
  readonly build: number;
  /** Number of builds in the frame. */
  readonly builds: number;
  readonly pageCount: number;
  readonly audienceMode: AudienceMode;
  readonly history: readonly number[];
  readonly forwardHistory: readonly number[];
  readonly timer: TimerSnapshot;
  /** `meta.published` of the deck the room PC has open; a phone with another copy offers to reload. */
  readonly deckPublished: string;
  /** Beamer notes layout the room PC is cropping to ("left", "right", "top", "bottom"), or null. */
  readonly split: string | null;
  /** Number of ink strokes the audience currently sees, so a phone knows when its own copy is stale. */
  readonly ink: number;
  readonly ack?: Ack;
}

export type Message =
  | { readonly type: "hello"; readonly body: { readonly role: Role; readonly device: string; readonly appVersion: string } }
  | { readonly type: "state"; readonly body: StateBody }
  | { readonly type: "command"; readonly body: Command }
  | { readonly type: "pointer"; readonly body: { readonly x: number; readonly y: number; readonly visible: boolean } }
  | { readonly type: "ping"; readonly body: { readonly t: number } }
  | { readonly type: "pong"; readonly body: { readonly t: number } }
  | { readonly type: "ink"; readonly body: InkMessage }
  | { readonly type: "end"; readonly body: Record<string, never> };

/**
 * Ink from a remote (SPEC §8.2): stroke begin, append and end with normalised points. `id` is
 * the sender's own stroke number; the room PC prefixes it with the sender id.
 */
export type InkMessage =
  | { readonly op: "begin"; readonly id: number; readonly x: number; readonly y: number; readonly color: number; readonly width: number }
  | { readonly op: "append"; readonly id: number; readonly points: readonly number[] }
  | { readonly op: "end"; readonly id: number }
  | { readonly op: "undo" }
  | { readonly op: "clear" };

/** The session command an ink message stands for, or null for `end`, which changes nothing. */
export function inkCommand(sid: string, ink: InkMessage): Command | null {
  switch (ink.op) {
    case "begin":
      return { name: "inkBegin", id: `${sid}:${ink.id}`, x: ink.x, y: ink.y, color: ink.color, width: ink.width };
    case "append":
      return { name: "inkAppend", id: `${sid}:${ink.id}`, points: ink.points };
    case "undo":
      return { name: "inkUndo" };
    case "clear":
      return { name: "inkClear" };
    default:
      return null;
  }
}

export type Envelope = Message & {
  /** Sender session id: 64 random bits as 16 hex characters. */
  readonly sid: string;
  /** Increments per sender. Receivers drop anything not newer than the last one seen. */
  readonly seq: number;
};

export function stateBody(
  state: SessionState,
  frames: FrameIndex,
  now: number,
  deckPublished: string,
  ack?: Ack,
  split: string | null = null,
): StateBody {
  const frame = frames.frameContaining(state.committedPage);
  return {
    page: state.committedPage,
    frameLabel: frame?.label ?? "",
    build: frames.buildIndex(state.committedPage),
    builds: frame ? frame.lastPage - frame.firstPage + 1 : 1,
    pageCount: frames.pageCount,
    audienceMode: state.audienceMode,
    history: state.history,
    forwardHistory: state.forwardHistory,
    timer: {
      running: state.timer.runningSince !== null,
      elapsedMs: elapsedMs(state.timer, now),
      targetMs: state.timer.targetMs,
    },
    deckPublished,
    split,
    ink: state.ink[inkLayer(state)].length,
    ...(ack ? { ack } : {}),
  };
}

// ---------------------------------------------------------------- validation

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isIndex = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v < 1e7;
const isUnit = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function parseAudienceMode(v: unknown): AudienceMode | null {
  if (!isRecord(v)) return null;
  switch (v["kind"]) {
    case "live":
      return { kind: "live" };
    case "black":
      return { kind: "black" };
    case "white":
      return { kind: "white" };
    case "frozen":
      return isIndex(v["page"]) ? { kind: "frozen", page: v["page"] } : null;
    default:
      return null;
  }
}

/** A command from the network, rebuilt field by field. Anything unexpected is rejected. */
export function parseCommand(v: unknown): Command | null {
  if (!isRecord(v)) return null;
  switch (v["name"]) {
    case "next":
    case "previous":
    case "nextFrame":
    case "previousFrame":
    case "back":
    case "forward":
    case "timerStart":
    case "timerPause":
    case "timerToggle":
    case "timerReset":
    case "inkUndo":
    case "inkClear":
      return { name: v["name"] };
    case "goToPage":
      return isIndex(v["page"]) ? { name: "goToPage", page: v["page"] } : null;
    case "goToFrameLabel":
      return typeof v["label"] === "string" && v["label"].length <= 32 ? { name: "goToFrameLabel", label: v["label"] } : null;
    case "followLink":
      return isIndex(v["page"]) && isIndex(v["index"]) ? { name: "followLink", page: v["page"], index: v["index"] } : null;
    case "setAudienceMode": {
      const mode = parseAudienceMode(v["mode"]);
      return mode ? { name: "setAudienceMode", mode } : null;
    }
    default:
      return null;
  }
}

function parseState(v: unknown): StateBody | null {
  if (!isRecord(v) || !isRecord(v["timer"])) return null;
  const mode = parseAudienceMode(v["audienceMode"]);
  const t = v["timer"];
  const pages = (list: unknown): number[] | null =>
    Array.isArray(list) && list.length <= 10_000 && list.every(isIndex) ? (list as number[]) : null;
  const history = pages(v["history"]);
  const forwardHistory = pages(v["forwardHistory"] ?? []);
  if (
    !isIndex(v["page"]) ||
    typeof v["frameLabel"] !== "string" ||
    !isIndex(v["build"]) ||
    !isIndex(v["builds"]) ||
    !isIndex(v["pageCount"]) ||
    !mode ||
    !history ||
    !forwardHistory ||
    typeof t["running"] !== "boolean" ||
    !isUnit(t["elapsedMs"]) ||
    !(t["targetMs"] === null || isUnit(t["targetMs"])) ||
    typeof v["deckPublished"] !== "string"
  ) {
    return null;
  }
  const ackIn = v["ack"];
  const ack = isRecord(ackIn) && typeof ackIn["sid"] === "string" && isIndex(ackIn["seq"]) ? { sid: ackIn["sid"], seq: ackIn["seq"] } : undefined;
  return {
    page: v["page"],
    frameLabel: v["frameLabel"],
    build: v["build"],
    builds: v["builds"],
    pageCount: v["pageCount"],
    audienceMode: mode,
    history,
    forwardHistory,
    timer: { running: t["running"], elapsedMs: t["elapsedMs"], targetMs: t["targetMs"] as number | null },
    deckPublished: v["deckPublished"],
    split: typeof v["split"] === "string" && v["split"].length <= 8 ? v["split"] : null,
    ink: isIndex(v["ink"]) ? v["ink"] : 0,
    ...(ack ? { ack } : {}),
  };
}

function parseInk(v: Record<string, unknown>): InkMessage | null {
  const id = v["id"];
  switch (v["op"]) {
    case "begin":
      return isIndex(id) && isUnit(v["x"]) && isUnit(v["y"]) && isIndex(v["color"]) && isUnit(v["width"])
        ? { op: "begin", id, x: v["x"], y: v["y"], color: v["color"], width: v["width"] }
        : null;
    case "append": {
      const points = v["points"];
      return isIndex(id) && Array.isArray(points) && points.length >= 2 && points.length <= 512 && points.every(isUnit)
        ? { op: "append", id, points: points as number[] }
        : null;
    }
    case "end":
      return isIndex(id) ? { op: "end", id } : null;
    case "undo":
      return { op: "undo" };
    case "clear":
      return { op: "clear" };
    default:
      return null;
  }
}

export function parseMessage(type: unknown, body: unknown): Message | null {
  if (!isRecord(body)) return null;
  switch (type) {
    case "hello": {
      const role = body["role"];
      if (role !== "room" && role !== "presenter" && role !== "remote") return null;
      return {
        type,
        body: {
          role,
          device: typeof body["device"] === "string" ? body["device"].slice(0, 64) : "",
          appVersion: typeof body["appVersion"] === "string" ? body["appVersion"].slice(0, 32) : "",
        },
      };
    }
    case "state": {
      const state = parseState(body);
      return state ? { type, body: state } : null;
    }
    case "command": {
      const command = parseCommand(body);
      return command ? { type, body: command } : null;
    }
    case "pointer":
      return isUnit(body["x"]) && isUnit(body["y"]) && typeof body["visible"] === "boolean"
        ? { type, body: { x: Math.min(1, Math.max(0, body["x"])), y: Math.min(1, Math.max(0, body["y"])), visible: body["visible"] } }
        : null;
    case "ping":
    case "pong":
      return isUnit(body["t"]) ? { type, body: { t: body["t"] } } : null;
    case "ink": {
      const ink = parseInk(body);
      return ink ? { type, body: ink } : null;
    }
    case "end":
      return { type, body: {} };
    default:
      return null;
  }
}

// ---------------------------------------------------------------- encryption and ordering

const SID = /^[0-9a-f]{16}$/;

export function randomSid(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/** One device's end of the encrypted channel: seals outgoing messages, opens and filters incoming ones. */
export class Channel {
  readonly sid: string;
  private seq = 0;
  private readonly lastSeen = new Map<string, number>();
  private readonly key: CryptoKey;

  constructor(key: CryptoKey, sid: string = randomSid()) {
    this.key = key;
    this.sid = sid;
  }

  /** The seq the next sealed message will carry. */
  get nextSeq(): number {
    return this.seq + 1;
  }

  /** `iv (12 bytes) || AES-256-GCM(channel-key, iv, JSON)`, with a fresh random iv per frame. */
  async seal(message: Message): Promise<Uint8Array<ArrayBuffer>> {
    this.seq += 1;
    const envelope: Envelope = { sid: this.sid, seq: this.seq, ...message };
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const plaintext = new TextEncoder().encode(JSON.stringify(envelope));
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, this.key, plaintext));
    const frame = new Uint8Array(IV_BYTES + ciphertext.length);
    frame.set(iv, 0);
    frame.set(ciphertext, IV_BYTES);
    if (frame.length > MAX_FRAME_BYTES) throw new Error("message too large for the relay");
    return frame;
  }

  /**
   * Returns the message, or null for anything that should be ignored: frames that don't decrypt
   * (another code, or tampering), malformed messages, our own echoes, and replays or reorderings.
   */
  async open(frame: Uint8Array): Promise<Envelope | null> {
    if (frame.length <= IV_BYTES + 16 || frame.length > MAX_FRAME_BYTES) return null;
    let text: string;
    try {
      const plaintext = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: new Uint8Array(frame.subarray(0, IV_BYTES)) },
        this.key,
        new Uint8Array(frame.subarray(IV_BYTES)),
      );
      text = new TextDecoder().decode(plaintext);
    } catch {
      return null;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return null;
    }
    if (!isRecord(raw)) return null;
    const { sid, seq } = raw;
    if (typeof sid !== "string" || !SID.test(sid) || sid === this.sid) return null;
    if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1) return null;
    const message = parseMessage(raw["type"], raw["body"]);
    if (!message) return null;
    if (seq <= (this.lastSeen.get(sid) ?? 0)) return null;
    if (this.lastSeen.size > 256 && !this.lastSeen.has(sid)) this.lastSeen.clear(); // bound memory
    this.lastSeen.set(sid, seq);
    return { sid, seq, ...message };
  }
}
