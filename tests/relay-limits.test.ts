import { describe, expect, it } from "vitest";
import {
  MAX_FRAMES_PER_SECOND,
  RateLimiter,
  SUSTAINED_SECONDS,
  isOriginAllowed,
  parseAllowedOrigins,
  roomIdFromPath,
} from "../relay/src/limits";

describe("roomIdFromPath", () => {
  const id = "0123456789abcdef0123456789abcdef";
  it("accepts 32 lowercase hex characters", () => {
    expect(roomIdFromPath(`/room/${id}`)).toBe(id);
  });
  it.each([
    "/room/",
    `/room/${id.toUpperCase()}`,
    `/room/${id.slice(1)}`,
    `/room/${id}0`,
    `/room/${id}/x`,
    `/rooms/${id}`,
    "/room/zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz",
  ])("rejects %s", (path) => {
    expect(roomIdFromPath(path)).toBeNull();
  });
});

describe("origins", () => {
  const allowed = parseAllowedOrigins(" https://benlockwood.com , http://localhost:5173,");
  it("parses a comma-separated list", () => {
    expect(allowed).toEqual(["https://benlockwood.com", "http://localhost:5173"]);
    expect(parseAllowedOrigins(undefined)).toEqual([]);
  });
  it("matches exactly", () => {
    expect(isOriginAllowed("https://benlockwood.com", allowed)).toBe(true);
    expect(isOriginAllowed("https://benlockwood.com.evil.example", allowed)).toBe(false);
    expect(isOriginAllowed("http://benlockwood.com", allowed)).toBe(false);
    expect(isOriginAllowed(null, allowed)).toBe(false);
  });
});

describe("RateLimiter", () => {
  const burst = (rl: RateLimiter, at: number, n: number) => Array.from({ length: n }, () => rl.check(at));

  it("forwards up to the limit and drops the excess", () => {
    const rl = new RateLimiter();
    const verdicts = burst(rl, 10_000, MAX_FRAMES_PER_SECOND + 5);
    expect(verdicts.filter((v) => v === "forward")).toHaveLength(MAX_FRAMES_PER_SECOND);
    expect(verdicts.slice(MAX_FRAMES_PER_SECOND).every((v) => v === "drop")).toBe(true);
  });

  it("recovers in the next second", () => {
    const rl = new RateLimiter();
    burst(rl, 10_000, MAX_FRAMES_PER_SECOND + 5);
    expect(rl.check(11_000)).toBe("forward");
  });

  it("closes after sustained flooding", () => {
    const rl = new RateLimiter();
    let last: string[] = [];
    for (let s = 0; s < SUSTAINED_SECONDS; s++) last = burst(rl, 10_000 + s * 1000, MAX_FRAMES_PER_SECOND + 1);
    expect(last.at(-1)).toBe("close");
  });

  it("does not close when over-limit seconds are not consecutive", () => {
    const rl = new RateLimiter();
    const seen = new Set<string>();
    for (let s = 0; s < SUSTAINED_SECONDS * 2; s++) {
      for (const v of burst(rl, 10_000 + s * 5000, MAX_FRAMES_PER_SECOND + 1)) seen.add(v);
    }
    expect(seen.has("close")).toBe(false);
  });
});
