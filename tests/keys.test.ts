import { describe, expect, it } from "vitest";
import { KeyInterpreter } from "../src/core/keys";
import type { KeyInput } from "../src/core/keys";
import { initialState } from "../src/core/session";
import type { SessionState } from "../src/core/session";

const key = (k: string, extra: Partial<KeyInput> = {}): KeyInput => ({
  key: k,
  shift: false,
  ctrl: false,
  alt: false,
  meta: false,
  repeat: false,
  time: 0,
  ...extra,
});
const press = (k: string, extra: Partial<KeyInput> = {}, state: SessionState = initialState) =>
  new KeyInterpreter().interpret(key(k, extra), state);

describe("navigation keys", () => {
  it.each(["ArrowRight", "ArrowDown", " ", "PageDown", "Enter", "n", "N"])("%j is next", (k) => {
    expect(press(k)).toEqual({ handled: true, command: { name: "next" } });
  });
  it.each(["ArrowLeft", "ArrowUp", "PageUp", "p", "P"])("%j is previous", (k) => {
    expect(press(k)).toEqual({ handled: true, command: { name: "previous" } });
  });
  it("Shift+arrows move by frame", () => {
    expect(press("ArrowRight", { shift: true }).command).toEqual({ name: "nextFrame" });
    expect(press("ArrowLeft", { shift: true }).command).toEqual({ name: "previousFrame" });
  });
  it("Delete, Backspace and Cmd+[ go back; Cmd+] goes forward", () => {
    expect(press("Delete").command).toEqual({ name: "back" });
    expect(press("Backspace").command).toEqual({ name: "back" });
    expect(press("[", { meta: true }).command).toEqual({ name: "back" });
    expect(press("]", { meta: true }).command).toEqual({ name: "forward" });
    // Windows and Linux: Ctrl in place of Cmd.
    expect(press("[", { ctrl: true }).command).toEqual({ name: "back" });
    expect(press("]", { ctrl: true }).command).toEqual({ name: "forward" });
    expect(press("[", { ctrl: true, meta: true })).toEqual({ handled: false });
  });
  it("held step keys repeat, held back does not", () => {
    expect(press("PageDown", { repeat: true }).command).toEqual({ name: "next" });
    expect(press("Delete", { repeat: true })).toEqual({ handled: true });
  });
});

describe("audience mode keys", () => {
  it("B and . toggle black", () => {
    expect(press("b").command).toEqual({ name: "setAudienceMode", mode: { kind: "black" } });
    expect(press(".").command).toEqual({ name: "setAudienceMode", mode: { kind: "black" } });
    const black: SessionState = { ...initialState, audienceMode: { kind: "black" } };
    expect(press("B", {}, black).command).toEqual({ name: "setAudienceMode", mode: { kind: "live" } });
  });
  it("W toggles white, and switches straight from black", () => {
    const black: SessionState = { ...initialState, audienceMode: { kind: "black" } };
    expect(press("w", {}, black).command).toEqual({ name: "setAudienceMode", mode: { kind: "white" } });
  });
  it("F does nothing: freeze was dropped", () => {
    const at7: SessionState = { ...initialState, committedPage: 7 };
    expect(press("f", {}, at7).command).toBeUndefined();
  });
  it("toggles ignore auto-repeat", () => {
    expect(press("b", { repeat: true })).toEqual({ handled: true });
  });
});

describe("jump by number", () => {
  it("digits then Enter jump to that frame label", () => {
    const keys = new KeyInterpreter();
    expect(keys.interpret(key("1"), initialState)).toEqual({ handled: true });
    expect(keys.interpret(key("2"), initialState)).toEqual({ handled: true });
    expect(keys.typedDigits).toBe("12");
    expect(keys.interpret(key("Enter"), initialState).command).toEqual({ name: "goToFrameLabel", label: "12" });
    expect(keys.interpret(key("Enter"), initialState).command).toEqual({ name: "next" });
  });
  it("any other key abandons the number", () => {
    const keys = new KeyInterpreter();
    keys.interpret(key("4"), initialState);
    keys.interpret(key("ArrowRight"), initialState);
    expect(keys.interpret(key("Enter"), initialState).command).toEqual({ name: "next" });
  });
  it("Esc clears the digits without counting towards ending", () => {
    const keys = new KeyInterpreter();
    keys.interpret(key("4"), initialState);
    expect(keys.interpret(key("Escape", { time: 100 }), initialState)).toEqual({ handled: true });
    expect(keys.typedDigits).toBe("");
    expect(keys.interpret(key("Escape", { time: 200 }), initialState)).toEqual({ handled: true });
    expect(keys.interpret(key("Escape", { time: 300 }), initialState).end).toBe(true);
  });
});

describe("ending", () => {
  it("Esc twice within a second ends", () => {
    const keys = new KeyInterpreter();
    expect(keys.interpret(key("Escape", { time: 5000 }), initialState)).toEqual({ handled: true });
    expect(keys.interpret(key("Escape", { time: 5900 }), initialState)).toEqual({ handled: true, end: true });
  });
  it("two slow Escs do not end, but a third quick one does", () => {
    const keys = new KeyInterpreter();
    keys.interpret(key("Escape", { time: 0 }), initialState);
    expect(keys.interpret(key("Escape", { time: 1500 }), initialState).end).toBeUndefined();
    expect(keys.interpret(key("Escape", { time: 2000 }), initialState).end).toBe(true);
  });
  it("a held Esc does not count as two presses", () => {
    const keys = new KeyInterpreter();
    keys.interpret(key("Escape", { time: 0 }), initialState);
    expect(keys.interpret(key("Escape", { time: 500, repeat: true }), initialState).end).toBeUndefined();
  });
});

describe("keys left alone or swallowed", () => {
  it("F5 and Tab are swallowed so the browser doesn't reload or move focus", () => {
    expect(press("F5")).toEqual({ handled: true });
    expect(press("Tab")).toEqual({ handled: true });
  });
  it("browser and OS shortcuts are not handled", () => {
    expect(press("r", { ctrl: true })).toEqual({ handled: false });
    expect(press("ArrowLeft", { alt: true })).toEqual({ handled: false });
    expect(press("w", { meta: true })).toEqual({ handled: false });
    expect(press("F12")).toEqual({ handled: false });
    expect(press("Shift", { shift: true })).toEqual({ handled: false });
  });
  it("a modifier press does not abandon typed digits", () => {
    const keys = new KeyInterpreter();
    keys.interpret(key("3"), initialState);
    keys.interpret(key("Shift", { shift: true }), initialState);
    expect(keys.typedDigits).toBe("3");
  });
});
