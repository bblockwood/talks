import { describe, expect, it } from "vitest";
import { FrameIndex } from "../src/core/frames";
import { Channel, parseCommand, parseMessage, randomSid, stateBody } from "../src/core/protocol";
import type { Message } from "../src/core/protocol";
import { apply, elapsedMs, initialState } from "../src/core/session";
import type { DeckContext, SessionState } from "../src/core/session";
import { labelsFor } from "./frames.test";

const key = (seed: number): Promise<CryptoKey> =>
  crypto.subtle.importKey("raw", new Uint8Array(32).fill(seed), "AES-GCM", false, ["encrypt", "decrypt"]);
const next: Message = { type: "command", body: { name: "next" } };

describe("Channel", () => {
  it("round-trips a message between two devices with the same key", async () => {
    const a = new Channel(await key(1));
    const b = new Channel(await key(1));
    const frame = await a.seal(next);
    expect(await b.open(frame)).toEqual({ sid: a.sid, seq: 1, ...next });
  });

  it("puts a fresh 12-byte iv in front and nothing readable on the wire", async () => {
    const a = new Channel(await key(1));
    const f1 = await a.seal({ type: "command", body: { name: "goToFrameLabel", label: "secretlabel" } });
    const f2 = await a.seal({ type: "command", body: { name: "goToFrameLabel", label: "secretlabel" } });
    expect(Buffer.from(f1.subarray(0, 12)).equals(Buffer.from(f2.subarray(0, 12)))).toBe(false);
    const wire = Buffer.from(f1).toString("latin1");
    expect(wire).not.toContain("secretlabel");
    expect(wire).not.toContain("command");
    expect(wire).not.toContain(a.sid);
  });

  it("ignores frames sealed with another talk's key, tampered frames and junk", async () => {
    const a = new Channel(await key(1));
    const other = new Channel(await key(2));
    const b = new Channel(await key(1));
    expect(await b.open(await other.seal(next))).toBeNull();
    const frame = await a.seal(next);
    frame[frame.length - 1] = (frame[frame.length - 1] ?? 0) ^ 1;
    expect(await b.open(frame)).toBeNull();
    expect(await b.open(new Uint8Array(5))).toBeNull();
    expect(await b.open(new Uint8Array(70_000))).toBeNull();
  });

  it("drops replays and out-of-order frames per sender", async () => {
    const a = new Channel(await key(1));
    const b = new Channel(await key(1));
    const f1 = await a.seal(next);
    const f2 = await a.seal(next);
    const f3 = await a.seal(next);
    expect((await b.open(f2))?.seq).toBe(2);
    expect(await b.open(f1)).toBeNull(); // older than the last seen
    expect(await b.open(f2)).toBeNull(); // replay
    expect((await b.open(f3))?.seq).toBe(3);
  });

  it("tracks each sender separately and ignores its own echo", async () => {
    const a = new Channel(await key(1));
    const c = new Channel(await key(1));
    const b = new Channel(await key(1));
    await a.seal(next);
    const fromA = await a.seal(next); // seq 2
    const fromC = await c.seal(next); // seq 1, different sender
    expect((await b.open(fromA))?.seq).toBe(2);
    expect((await b.open(fromC))?.seq).toBe(1);
    expect(await a.open(fromA)).toBeNull();
  });

  it("makes 64-bit session ids", () => {
    expect(randomSid()).toMatch(/^[0-9a-f]{16}$/);
    expect(randomSid()).not.toBe(randomSid());
  });

  it("rejects well-encrypted but malformed envelopes", async () => {
    const k = await key(1);
    const b = new Channel(k);
    const sealRaw = async (obj: unknown): Promise<Uint8Array> => {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, k, new TextEncoder().encode(JSON.stringify(obj))));
      const out = new Uint8Array(12 + ct.length);
      out.set(iv);
      out.set(ct, 12);
      return out;
    };
    const sid = "00112233445566ff";
    expect(await b.open(await sealRaw({ sid, seq: 1, type: "command", body: { name: "next" } }))).not.toBeNull();
    expect(await b.open(await sealRaw({ sid: "short", seq: 2, type: "command", body: { name: "next" } }))).toBeNull();
    expect(await b.open(await sealRaw({ sid, seq: 0, type: "command", body: { name: "next" } }))).toBeNull();
    expect(await b.open(await sealRaw({ sid, seq: 2.5, type: "command", body: { name: "next" } }))).toBeNull();
    expect(await b.open(await sealRaw({ sid, seq: 3, type: "command", body: { name: "selfDestruct" } }))).toBeNull();
    expect(await b.open(await sealRaw({ sid, seq: 4, type: "mystery", body: {} }))).toBeNull();
    expect(await b.open(await sealRaw([1, 2, 3]))).toBeNull();
    // A rejected message must not advance the sequence: seq 3 was refused above, so it is still acceptable.
    expect(await b.open(await sealRaw({ sid, seq: 3, type: "end", body: {} }))).not.toBeNull();
  });
});

describe("message validation", () => {
  it("accepts every command the phone sends", () => {
    for (const name of ["next", "previous", "nextFrame", "previousFrame", "back", "forward", "timerStart", "timerPause", "timerToggle", "timerReset"]) {
      expect(parseCommand({ name })).toEqual({ name });
    }
    expect(parseCommand({ name: "goToPage", page: 12 })).toEqual({ name: "goToPage", page: 12 });
    expect(parseCommand({ name: "goToFrameLabel", label: "7" })).toEqual({ name: "goToFrameLabel", label: "7" });
    expect(parseCommand({ name: "followLink", page: 3, index: 1 })).toEqual({ name: "followLink", page: 3, index: 1 });
    expect(parseCommand({ name: "setAudienceMode", mode: { kind: "frozen", page: 4 } })).toEqual({
      name: "setAudienceMode",
      mode: { kind: "frozen", page: 4 },
    });
  });

  it("rejects malformed commands and strips unknown fields", () => {
    expect(parseCommand({ name: "goToPage", page: -1 })).toBeNull();
    expect(parseCommand({ name: "goToPage", page: 1.5 })).toBeNull();
    expect(parseCommand({ name: "goToPage", page: "3" })).toBeNull();
    expect(parseCommand({ name: "goToPage" })).toBeNull();
    expect(parseCommand({ name: "followLink", page: 1 })).toBeNull();
    expect(parseCommand({ name: "setAudienceMode", mode: { kind: "purple" } })).toBeNull();
    expect(parseCommand({ name: "setAudienceMode", mode: { kind: "frozen" } })).toBeNull();
    expect(parseCommand({ name: "goToFrameLabel", label: "x".repeat(100) })).toBeNull();
    expect(parseCommand("next")).toBeNull();
    expect(parseCommand(null)).toBeNull();
    expect(parseCommand({ name: "next", extra: "ignored", __proto__: { evil: true } })).toEqual({ name: "next" });
  });

  it("clamps pointer coordinates and validates the rest", () => {
    expect(parseMessage("pointer", { x: 1.7, y: -0.2, visible: true })).toEqual({ type: "pointer", body: { x: 1, y: 0, visible: true } });
    expect(parseMessage("pointer", { x: Number.NaN, y: 0, visible: true })).toBeNull();
    expect(parseMessage("pointer", { x: 0.5, y: 0.5 })).toBeNull();
    expect(parseMessage("ping", { t: 12.5 })).toEqual({ type: "ping", body: { t: 12.5 } });
    expect(parseMessage("ping", { t: "now" })).toBeNull();
    expect(parseMessage("hello", { role: "admin" })).toBeNull();
    expect(parseMessage("hello", { role: "remote", device: "x".repeat(500) })?.type).toBe("hello");
    expect(parseMessage("end", {})).toEqual({ type: "end", body: {} });
    expect(parseMessage("state", { page: 1 })).toBeNull();
  });

  it("round-trips the room PC's state", () => {
    const frames = new FrameIndex(labelsFor([1, 3, 4]));
    const state: SessionState = {
      ...initialState,
      committedPage: 5,
      audienceMode: { kind: "frozen", page: 2 },
      history: [0, 3],
      timer: { accumulatedMs: 60_000, runningSince: 1_000_000, targetMs: 1_800_000 },
    };
    const room = { relay: "connected", devices: ["iPhone", "Mac"], draw: { count: 3, medianMs: 1.5, lastMs: 0.4, maxMs: 9 }, cacheMisses: 1 };
    const body = stateBody(state, frames, 1_030_000, {
      deckPublished: "2026-11-26T00:00:00.000Z",
      session: "0011223344556677",
      split: "right",
      room,
      ack: { sid: "aabbccddeeff0011", seq: 9 },
    });
    expect(body).toMatchObject({
      page: 5,
      frameLabel: "3",
      build: 1,
      builds: 4,
      pageCount: 8,
      audienceMode: { kind: "frozen", page: 2 },
      history: [0, 3],
      timer: { running: true, elapsedMs: 90_000, targetMs: 1_800_000 },
      ack: { sid: "aabbccddeeff0011", seq: 9 },
      session: "0011223344556677",
      split: "right",
      room,
    });
    expect(parseMessage("state", JSON.parse(JSON.stringify(body)))).toEqual({ type: "state", body });
  });
});

describe("talk clock", () => {
  const deck: DeckContext = { frames: new FrameIndex(labelsFor([1, 1])), linksFor: () => undefined };
  const run = (commands: [string, number][], from = initialState): SessionState =>
    commands.reduce((s, [name, now]) => apply(s, { name } as Parameters<typeof apply>[1], deck, now), from);

  it("starts, pauses and resumes, keeping the elapsed time", () => {
    let s = run([["timerStart", 1000]]);
    expect(elapsedMs(s.timer, 6000)).toBe(5000);
    s = run([["timerPause", 6000]], s);
    expect(s.timer.runningSince).toBeNull();
    expect(elapsedMs(s.timer, 99_000)).toBe(5000);
    s = run([["timerToggle", 10_000]], s);
    expect(elapsedMs(s.timer, 12_000)).toBe(7000);
    s = run([["timerToggle", 12_000]], s);
    expect(elapsedMs(s.timer, 50_000)).toBe(7000);
  });

  it("starting twice or pausing twice changes nothing", () => {
    const started = run([["timerStart", 1000]]);
    expect(run([["timerStart", 5000]], started)).toBe(started);
    expect(run([["timerPause", 5000]])).toBe(initialState);
  });

  it("reset returns to zero and keeps running, and keeps the target", () => {
    const withTarget: SessionState = { ...initialState, timer: { accumulatedMs: 0, runningSince: null, targetMs: 600_000 } };
    const s = run([["timerStart", 0], ["timerReset", 90_000]], withTarget);
    expect(elapsedMs(s.timer, 91_000)).toBe(1000);
    expect(s.timer.targetMs).toBe(600_000);
  });

  it("a countdown can be set and removed mid-talk, and starts a paused clock", () => {
    const running = run([["timerStart", 1000]]);
    const down = apply(running, { name: "timerSetTarget", targetMs: 1_200_000 }, deck, 5000);
    expect(down.timer).toEqual({ accumulatedMs: 0, runningSince: 1000, targetMs: 1_200_000 }); // elapsed time is kept
    expect(apply(down, { name: "timerSetTarget", targetMs: 1_200_000 }, deck, 6000)).toBe(down);
    const up = apply(down, { name: "timerSetTarget", targetMs: null }, deck, 7000);
    expect(up.timer.targetMs).toBeNull();
    expect(up.timer.runningSince).toBe(1000);

    const paused = run([["timerStart", 0], ["timerPause", 4000]]);
    const started = apply(paused, { name: "timerSetTarget", targetMs: 60_000 }, deck, 9000);
    expect(started.timer).toEqual({ accumulatedMs: 4000, runningSince: 9000, targetMs: 60_000 });
    // Counting up again does not start a paused clock.
    const stillPaused = apply({ ...paused, timer: { ...paused.timer, targetMs: 60_000 } }, { name: "timerSetTarget", targetMs: null }, deck, 9000);
    expect(stillPaused.timer.runningSince).toBeNull();
  });

  it("validates a countdown from the network", () => {
    expect(parseCommand({ name: "timerSetTarget", targetMs: null })).toEqual({ name: "timerSetTarget", targetMs: null });
    expect(parseCommand({ name: "timerSetTarget", targetMs: 1_200_000.4 })).toEqual({ name: "timerSetTarget", targetMs: 1_200_000 });
    for (const targetMs of [0, -5, Infinity, NaN, "1200000", undefined, 25 * 3600_000]) {
      expect(parseCommand({ name: "timerSetTarget", targetMs })).toBeNull();
    }
  });

  it("navigation does not disturb the clock", () => {
    const s = run([["timerStart", 1000], ["next", 2000]]);
    expect(s.committedPage).toBe(1);
    expect(s.timer.runningSince).toBe(1000);
  });
});
