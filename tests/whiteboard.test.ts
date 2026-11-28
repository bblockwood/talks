import { describe, expect, it } from "vitest";
import { WhiteboardDraw } from "../src/core/whiteboard";

describe("the white screen as a whiteboard", () => {
  it("turns Draw on with white and off when white ends", () => {
    const board = new WhiteboardDraw();
    expect(board.follow(false, false)).toBeNull();
    expect(board.follow(true, false)).toBe(true);
    expect(board.follow(true, true)).toBeNull(); // nothing new while it stays white
    expect(board.follow(false, true)).toBe(false);
    expect(board.follow(false, false)).toBeNull();
  });

  it("leaves Draw on afterwards if it was on before", () => {
    const board = new WhiteboardDraw();
    expect(board.follow(true, true)).toBeNull();
    expect(board.follow(false, true)).toBeNull();
  });

  it("does not turn Draw off twice: put down by hand on the board, it stays down", () => {
    const board = new WhiteboardDraw();
    expect(board.follow(true, false)).toBe(true);
    expect(board.follow(false, false)).toBeNull();
    // and the next white screen starts afresh
    expect(board.follow(true, false)).toBe(true);
  });
});
