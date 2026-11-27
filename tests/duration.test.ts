import { describe, expect, it } from "vitest";
import { parseDuration } from "../src/core/duration";

const min = 60_000;

describe("parseDuration", () => {
  it("reads a bare number as minutes", () => {
    expect(parseDuration("45")).toBe(45 * min);
    expect(parseDuration(" 1.5 ")).toBe(90_000);
  });

  it("reads m:ss and h:mm:ss", () => {
    expect(parseDuration("45:30")).toBe(45 * min + 30_000);
    expect(parseDuration("1:05:00")).toBe(65 * min);
    expect(parseDuration("20:00")).toBe(20 * min);
  });

  it("reads units, with a bare number after a unit taking the next smaller one", () => {
    expect(parseDuration("90m")).toBe(90 * min);
    expect(parseDuration("1h")).toBe(60 * min);
    expect(parseDuration("1h30")).toBe(90 * min);
    expect(parseDuration("1H 30m")).toBe(90 * min);
    expect(parseDuration("1.5h")).toBe(90 * min);
    expect(parseDuration("30s")).toBe(30_000);
    expect(parseDuration("2m30")).toBe(150_000);
  });

  it("rejects anything that is not a time above zero", () => {
    for (const text of ["", " ", "0", "0:00", "20:", ":30", "1:2:3:4", "abc", "5x", "30s5", "-5", "1e3", "25h"]) {
      expect(parseDuration(text), text).toBeNull();
    }
  });
});
