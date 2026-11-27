import { describe, expect, it } from "vitest";
import { FrameIndex } from "../src/core/frames";
import { SessionHost } from "../src/core/host";
import { Channel, parseMessage } from "../src/core/protocol";
import type { Envelope, Message, StrokeOp } from "../src/core/protocol";
import type { SessionState } from "../src/core/session";
import { labelsFor } from "./frames.test";

/** A host wired to arrays, with a clock the test controls. */
function setup() {
  const sent: Message[] = [];
  const applied: SessionState[] = [];
  const pointers: [number, number, boolean][] = [];
  let ended = 0;
  let now = 1_000_000;
  const host = new SessionHost(
    { frames: new FrameIndex(labelsFor([1, 3, 1])), split: null, linksFor: () => undefined },
    { deckPublished: "2026-11-26T00:00:00.000Z", targetMs: 600_000, device: "Room PC", self: "0000000000000000" },
    {
      now: () => now,
      send: (m) => sent.push(m),
      applied: (s) => applied.push(s),
      pointer: (x, y, v) => pointers.push([x, y, v]),
      end: () => ended++,
      status: () => ({ relay: "connected", draw: { count: 0, medianMs: null, lastMs: null, maxMs: null }, cacheMisses: 0 }),
      view: () => "audience",
      since: () => 500_000,
    },
  );
  let seq = 0;
  /** `to` is the session quoted on the message; null for none. */
  const from = (sid: string, message: Message, to: string | null = host.session): Envelope => ({ sid, seq: ++seq, ...(to ? { to } : {}), ...message });
  const states = () => sent.filter((m) => m.type === "state").map((m) => (m.type === "state" ? m.body : null)!);
  const strokes = () => sent.filter((m) => m.type === "strokes").map((m) => (m.type === "strokes" ? m.body : null)!);
  return { host, sent, applied, pointers, from, states, strokes, ended: () => ended, tick: (ms: number) => (now += ms) };
}
const A = "aaaaaaaaaaaaaaaa";
const B = "bbbbbbbbbbbbbbbb";
const hello = (device: string): Message => ({ type: "hello", body: { role: "presenter", device, appVersion: "t" } });
const next: Message = { type: "command", body: { name: "next" } };

describe("SessionHost", () => {
  it("tells a joining device who it is, the state, and its session; the clock waits for the first slide change", () => {
    const t = setup();
    t.host.receive(t.from(A, hello("iPhone"), null));
    expect(t.sent[0]).toMatchObject({ type: "hello", body: { role: "room", device: "Room PC", session: t.host.session } });
    const state = t.states().at(-1)!;
    expect(state).toMatchObject({ page: 0, pageCount: 5, session: t.host.session, timer: { running: false, targetMs: 600_000 }, hostView: "audience", since: 500_000 });
    expect(state.room).toMatchObject({ devices: ["Room PC", "iPhone"], audiences: 1 });
    t.host.receive(t.from(A, next));
    expect(t.states().at(-1)?.timer.running).toBe(true);
    expect(t.host.session).toMatch(/^[0-9a-f]{16}$/);
  });

  it("applies commands, answers with the sender's ack, and draws", () => {
    const t = setup();
    const envelope = t.from(A, next);
    t.host.receive(envelope);
    expect(t.host.state.committedPage).toBe(1);
    expect(t.applied).toHaveLength(1);
    expect(t.states().at(-1)).toMatchObject({ page: 1, ack: { sid: A, seq: envelope.seq } });
  });

  it("still answers a command that changes nothing", () => {
    const t = setup();
    const envelope = t.from(A, { type: "command", body: { name: "previous" } });
    t.host.receive(envelope);
    expect(t.applied).toHaveLength(0);
    expect(t.states().at(-1)?.ack).toEqual({ sid: A, seq: envelope.seq });
  });

  it("ignores commands, ink, pointer and end that do not quote this session", () => {
    const t = setup();
    // A frame recorded in an earlier session of the same talk code carries the old session id, or none.
    for (const to of [null, "0000000000000000"]) {
      t.host.receive({ ...t.from(A, next, to) });
      t.host.receive({ ...t.from(A, { type: "end", body: {} }, to) });
      t.host.receive({ ...t.from(A, { type: "pointer", body: { x: 0.5, y: 0.5, visible: true } }, to) });
      t.host.receive({ ...t.from(A, { type: "ink", body: { op: "begin", id: 1, x: 0, y: 0, color: 0, width: 0.006 } }, to) });
    }
    expect(t.host.state.committedPage).toBe(0);
    expect(t.host.state.ink.page).toEqual([]);
    expect(t.ended()).toBe(0);
    expect(t.pointers).toEqual([]);
    expect(t.states()).toEqual([]);
  });

  it("answers pings and hellos without a session, since that is how a view learns it", () => {
    const t = setup();
    t.host.receive(t.from(A, { type: "ping", body: { t: 42 } }, null));
    expect(t.sent).toEqual([{ type: "pong", body: { t: 42 } }]);
  });

  it("freezes on the page the audience is actually seeing, whatever page the view thought it was", () => {
    const t = setup();
    t.host.receive(t.from(A, next));
    t.host.receive(t.from(A, next));
    // The view sent this before it had heard about those two steps.
    t.host.receive(t.from(A, { type: "command", body: { name: "setAudienceMode", mode: { kind: "frozen", page: 0 } } }));
    expect(t.host.state.audienceMode).toEqual({ kind: "frozen", page: 2 });
  });

  it("passes on the pointer and the request to end", () => {
    const t = setup();
    t.host.receive(t.from(A, { type: "pointer", body: { x: 0.25, y: 0.75, visible: true } }));
    t.host.receive(t.from(A, { type: "end", body: {} }));
    expect(t.pointers).toEqual([[0.25, 0.75, true]]);
    expect(t.ended()).toBe(1);
  });

  it("ignores another room PC's hello", () => {
    const t = setup();
    t.host.receive(t.from(B, { type: "hello", body: { role: "room", device: "x", appVersion: "t" } }, null));
    expect(t.sent).toEqual([]);
  });

  it("lists devices heard from recently and forgets silent ones", () => {
    const t = setup();
    t.host.receive(t.from(A, hello("iPhone"), null));
    t.host.receive(t.from(B, hello("Mac"), null));
    expect(t.states().at(-1)?.room?.devices).toEqual(["Room PC", "iPhone", "Mac"]);
    t.tick(8000);
    t.host.receive(t.from(B, { type: "ping", body: { t: 1 } }, null));
    t.tick(4000);
    t.host.broadcast();
    expect(t.states().at(-1)?.room?.devices).toEqual(["Room PC", "Mac"]);
  });

  it("relays ink to every view, naming who drew it and on which layer", () => {
    const t = setup();
    t.host.receive(t.from(A, { type: "ink", body: { op: "begin", id: 7, x: 0.1, y: 0.2, color: 1, width: 0.006 } }));
    t.host.receive(t.from(A, { type: "ink", body: { op: "append", id: 7, points: [0.3, 0.4] } }));
    t.host.receive(t.from(A, { type: "ink", body: { op: "end", id: 7 } }));
    expect(t.strokes()).toEqual([
      { op: "begin", from: A, layer: "page", id: `${A}:7`, x: 0.1, y: 0.2, color: 1, width: 0.006 },
      { op: "append", from: A, id: `${A}:7`, points: [0.3, 0.4] },
    ]);
    // A `state` goes out when a stroke starts (the count changed), not for every batch of points.
    expect(t.states().map((s) => s.ink)).toEqual([1]);

    t.host.receive(t.from(B, { type: "command", body: { name: "setAudienceMode", mode: { kind: "white" } } }));
    t.host.receive(t.from(B, { type: "ink", body: { op: "begin", id: 1, x: 0.5, y: 0.5, color: 0, width: 0.006 } }));
    expect(t.strokes().at(-1)).toMatchObject({ op: "begin", from: B, layer: "board", id: `${B}:1` });
    t.host.receive(t.from(A, { type: "ink", body: { op: "undo" } }));
    expect(t.strokes().at(-1)).toEqual({ op: "undo", from: A, layer: "board" });
    // Clear from the room PC's own keyboard is attributed to the host itself.
    t.host.dispatch({ name: "setAudienceMode", mode: { kind: "live" } });
    t.host.dispatch({ name: "inkClear" });
    expect(t.strokes().at(-1)).toEqual({ op: "clear", from: t.host.session, layer: "page" });
  });

  it("does not relay ink that was refused", () => {
    const t = setup();
    t.host.dispatch({ name: "setAudienceMode", mode: { kind: "black" } });
    t.host.receive(t.from(A, { type: "ink", body: { op: "begin", id: 1, x: 0, y: 0, color: 0, width: 0.006 } }));
    t.host.receive(t.from(A, { type: "ink", body: { op: "undo" } }));
    expect(t.strokes()).toEqual([]);
  });

  it("gives a late joiner a full copy of the ink, in pieces that fit the relay", async () => {
    const t = setup();
    t.host.receive(t.from(A, { type: "ink", body: { op: "begin", id: 1, x: 0, y: 0, color: 2, width: 0.006 } }));
    for (let i = 0; i < 5; i++) t.host.receive(t.from(A, { type: "ink", body: { op: "append", id: 1, points: new Array<number>(400).fill(0.5) } }));
    t.host.dispatch({ name: "setAudienceMode", mode: { kind: "white" } });
    t.host.receive(t.from(A, { type: "ink", body: { op: "begin", id: 2, x: 1, y: 1, color: 0, width: 0.006 } }));
    t.sent.length = 0;

    t.host.receive(t.from(B, hello("Mac"), null));
    const copy = t.strokes();
    expect(copy[0]).toEqual({ op: "reset" });
    // Rebuilding from the copy gives exactly the host's ink.
    const rebuilt = new Map<string, { layer: string; points: number[]; color: number }>();
    for (const op of copy as StrokeOp[]) {
      if (op.op === "begin") rebuilt.set(op.id, { layer: op.layer, points: [op.x, op.y], color: op.color });
      else if (op.op === "append") rebuilt.get(op.id)?.points.push(...op.points);
    }
    expect(rebuilt.get(`${A}:1`)).toEqual({ layer: "page", color: 2, points: [...t.host.state.ink.page[0]!.points] });
    expect(rebuilt.get(`${A}:2`)).toMatchObject({ layer: "board", points: [1, 1] });
    expect(copy.every((op) => op.op !== "append" || op.points.length <= 256)).toBe(true);

    // Every message the host sends survives validation and fits in one encrypted relay frame.
    const key = await crypto.subtle.importKey("raw", new Uint8Array(32), "AES-GCM", false, ["encrypt", "decrypt"]);
    const channel = new Channel(key);
    for (const message of t.sent) {
      expect(parseMessage(message.type, JSON.parse(JSON.stringify(message.body)))).toEqual(message);
      expect((await channel.seal(message)).length).toBeLessThan(64 * 1024);
    }
  });

  it("sends no ink copy when there is none", () => {
    const t = setup();
    t.host.receive(t.from(A, hello("iPhone"), null));
    expect(t.strokes()).toEqual([]);
  });
});

describe("session id on the wire", () => {
  it("travels inside the encrypted envelope and is validated", async () => {
    const key = await crypto.subtle.importKey("raw", new Uint8Array(32).fill(3), "AES-GCM", false, ["encrypt", "decrypt"]);
    const a = new Channel(key);
    const b = new Channel(key);
    expect((await b.open(await a.seal(next, "0123456789abcdef")))?.to).toBe("0123456789abcdef");
    expect((await b.open(await a.seal(next)))?.to).toBeUndefined();
    expect((await b.open(await a.seal(next, "not-a-session")))?.to).toBeUndefined();
  });
});
