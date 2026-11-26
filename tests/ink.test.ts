import { describe, expect, it } from "vitest";
import { FrameIndex } from "../src/core/frames";
import { MAX_POINTS_PER_STROKE, MAX_STROKES, NO_INK, appendToStroke, beginStroke, clearLayer, undoStroke } from "../src/core/ink";
import { KeyInterpreter } from "../src/core/keys";
import { inkCommand, parseCommand, parseMessage, stateBody } from "../src/core/protocol";
import { apply, initialState, inkLayer } from "../src/core/session";
import type { Command, DeckContext, SessionState } from "../src/core/session";
import { labelsFor } from "./frames.test";

const deck: DeckContext = { frames: new FrameIndex(labelsFor([1, 2, 1])), linksFor: () => undefined };
const run = (commands: Command[], from: SessionState = initialState): SessionState => commands.reduce((s, c) => apply(s, c, deck), from);
const begin = (id: string, x = 0.5, y = 0.5): Command => ({ name: "inkBegin", id, x, y, color: 0, width: 0.006 });
const white: Command = { name: "setAudienceMode", mode: { kind: "white" } };
const live: Command = { name: "setAudienceMode", mode: { kind: "live" } };

describe("strokes", () => {
  it("begin and append build a stroke; values are clamped", () => {
    let ink = beginStroke(NO_INK, "page", "a:1", 0.25, 1.7, 1, 0.5);
    expect(ink.page).toEqual([{ id: "a:1", color: 1, width: 0.03, points: [0.25, 1] }]);
    ink = appendToStroke(ink, "a:1", [0.3, 0.4, -2, Number.NaN, 0.9]); // a stray odd value is dropped
    expect(ink.page[0]?.points).toEqual([0.25, 1, 0.3, 0.4, 0, 0]);
    expect(beginStroke(NO_INK, "page", "x", 0, 0, 99, Number.NaN).page[0]).toMatchObject({ color: 0, width: 0.006 });
  });

  it("ignores a repeated begin and an append to an unknown stroke", () => {
    const ink = beginStroke(NO_INK, "page", "a:1", 0, 0, 0, 0.006);
    expect(beginStroke(ink, "board", "a:1", 0.5, 0.5, 0, 0.006)).toBe(ink);
    expect(appendToStroke(ink, "nope", [0.1, 0.1])).toBe(ink);
    expect(appendToStroke(ink, "a:1", [0.1])).toBe(ink);
  });

  it("caps points per stroke and strokes per layer", () => {
    let ink = beginStroke(NO_INK, "page", "big", 0, 0, 0, 0.006);
    for (let i = 0; i < 40; i++) ink = appendToStroke(ink, "big", new Array<number>(512).fill(0.5));
    expect(ink.page[0]?.points.length).toBe(MAX_POINTS_PER_STROKE * 2);
    let many = NO_INK;
    for (let i = 0; i < MAX_STROKES + 5; i++) many = beginStroke(many, "board", `s${i}`, 0, 0, 0, 0.006);
    expect(many.board).toHaveLength(MAX_STROKES);
    expect(many.board[0]?.id).toBe("s5");
  });

  it("undo removes the latest stroke; clear empties one layer only", () => {
    let ink = beginStroke(beginStroke(NO_INK, "page", "1", 0, 0, 0, 0.006), "page", "2", 0, 0, 0, 0.006);
    ink = beginStroke(ink, "board", "b", 0, 0, 0, 0.006);
    expect(undoStroke(ink, "page").page.map((s) => s.id)).toEqual(["1"]);
    expect(clearLayer(ink, "page")).toMatchObject({ page: [], board: [{ id: "b" }] });
    expect(undoStroke(NO_INK, "page")).toBe(NO_INK);
    expect(clearLayer(NO_INK, "board")).toBe(NO_INK);
  });
});

describe("ink in the session", () => {
  it("is drawn on the page and cleared by leaving the page", () => {
    let s = run([begin("p:1"), { name: "inkAppend", id: "p:1", points: [0.6, 0.6] }]);
    expect(s.ink.page[0]?.points).toEqual([0.5, 0.5, 0.6, 0.6]);
    s = run([{ name: "next" }], s);
    expect(s.ink.page).toEqual([]);
  });

  it("survives commands that do not change the page", () => {
    const s = run([{ name: "next" }, { name: "next" }, begin("p:1"), { name: "timerToggle" }, { name: "next" }, { name: "next" }]);
    // Page 2 is the last page: the final two `next`s did nothing, so the ink is still there.
    expect(s.committedPage).toBe(3);
    expect(run([begin("p:2")], s).ink.page).toHaveLength(1);
    const atEnd = run([{ name: "next" }], run([begin("p:3")], s));
    expect(atEnd.ink.page).toHaveLength(1);
  });

  it("goes on the whiteboard while the screen is white, and the board outlives slide changes", () => {
    let s = run([white, begin("b:1"), { name: "inkAppend", id: "b:1", points: [0.1, 0.1] }]);
    expect(inkLayer(s)).toBe("board");
    expect(s.ink).toMatchObject({ page: [], board: [{ id: "b:1" }] });
    s = run([live, begin("p:1"), { name: "next" }, white], s);
    expect(s.ink.page).toEqual([]);
    expect(s.ink.board).toHaveLength(1);
    expect(run([{ name: "inkClear" }], s).ink.board).toEqual([]);
  });

  it("undo and clear act on the layer the audience sees", () => {
    const s = run([begin("p:1"), begin("p:2"), white, begin("b:1"), live, { name: "inkUndo" }]);
    expect(s.ink.page.map((x) => x.id)).toEqual(["p:1"]);
    expect(s.ink.board).toHaveLength(1);
    expect(run([{ name: "inkClear" }], s).ink).toMatchObject({ page: [], board: [{ id: "b:1" }] });
  });

  it("refuses new strokes on a black or frozen screen", () => {
    const black = run([{ name: "setAudienceMode", mode: { kind: "black" } }]);
    expect(apply(black, begin("x"), deck)).toBe(black);
    const frozen = run([{ name: "setAudienceMode", mode: { kind: "frozen", page: 0 } }]);
    expect(apply(frozen, begin("x"), deck)).toBe(frozen);
  });

  it("C clears the ink from the keyboard", () => {
    expect(new KeyInterpreter().interpret({ key: "c", shift: false, ctrl: false, alt: false, meta: false, repeat: false, time: 0 }, initialState)).toEqual({
      handled: true,
      command: { name: "inkClear" },
    });
  });
});

describe("ink on the wire", () => {
  it("validates ink messages", () => {
    expect(parseMessage("ink", { op: "begin", id: 3, x: 0.1, y: 0.2, color: 1, width: 0.006 })).toEqual({
      type: "ink",
      body: { op: "begin", id: 3, x: 0.1, y: 0.2, color: 1, width: 0.006 },
    });
    expect(parseMessage("ink", { op: "append", id: 3, points: [0.1, 0.2, 0.3, 0.4] })?.type).toBe("ink");
    expect(parseMessage("ink", { op: "end", id: 3 })).toEqual({ type: "ink", body: { op: "end", id: 3 } });
    expect(parseMessage("ink", { op: "undo" })).toEqual({ type: "ink", body: { op: "undo" } });
    expect(parseMessage("ink", { op: "clear", junk: 1 })).toEqual({ type: "ink", body: { op: "clear" } });

    expect(parseMessage("ink", { op: "begin", id: -1, x: 0, y: 0, color: 0, width: 0.006 })).toBeNull();
    expect(parseMessage("ink", { op: "begin", id: 1, x: "0", y: 0, color: 0, width: 0.006 })).toBeNull();
    expect(parseMessage("ink", { op: "append", id: 1, points: [0.1] })).toBeNull();
    expect(parseMessage("ink", { op: "append", id: 1, points: new Array(600).fill(0.5) })).toBeNull();
    expect(parseMessage("ink", { op: "append", id: 1, points: [0.1, "x"] })).toBeNull();
    expect(parseMessage("ink", { op: "scribble" })).toBeNull();
  });

  it("prefixes stroke ids with the sender, so two devices cannot collide", () => {
    expect(inkCommand("aaaa", { op: "begin", id: 1, x: 0, y: 0, color: 0, width: 0.006 })).toMatchObject({ name: "inkBegin", id: "aaaa:1" });
    expect(inkCommand("bbbb", { op: "append", id: 1, points: [0, 0] })).toMatchObject({ name: "inkAppend", id: "bbbb:1" });
    expect(inkCommand("aaaa", { op: "end", id: 1 })).toBeNull();
    expect(inkCommand("aaaa", { op: "undo" })).toEqual({ name: "inkUndo" });
    expect(inkCommand("aaaa", { op: "clear" })).toEqual({ name: "inkClear" });
  });

  it("does not accept stroke commands disguised as ordinary commands", () => {
    // Strokes only arrive as `ink` messages, where the sender id is attached by the room PC.
    expect(parseCommand({ name: "inkBegin", id: "x", x: 0, y: 0, color: 0, width: 0.006 })).toBeNull();
    expect(parseCommand({ name: "inkAppend", id: "x", points: [0, 0] })).toBeNull();
    expect(parseCommand({ name: "inkClear" })).toEqual({ name: "inkClear" });
  });

  it("state reports how many strokes the audience sees", () => {
    const s = run([begin("p:1"), begin("p:2"), white, begin("b:1")]);
    expect(stateBody(s, deck.frames, 0).ink).toBe(1);
    expect(stateBody(run([live], s), deck.frames, 0).ink).toBe(2);
  });
});
