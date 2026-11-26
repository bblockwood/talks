// Pure relay rules (SPEC §8.3). No Workers APIs here, so the app's unit tests cover this file.

export const MAX_SOCKETS_PER_ROOM = 8;
export const MAX_FRAME_BYTES = 64 * 1024;
export const MAX_FRAMES_PER_SECOND = 120;
/** Consecutive over-limit seconds before the socket is closed with 1008. */
export const SUSTAINED_SECONDS = 3;
export const IDLE_CLOSE_MS = 2 * 60 * 60 * 1000;

const ROOM_ID = /^[0-9a-f]{32}$/;

export function isValidRoomId(id: string): boolean {
  return ROOM_ID.test(id);
}

/** Returns the room id for `/room/<id>`, or null for any other path or a malformed id. */
export function roomIdFromPath(pathname: string): string | null {
  const m = /^\/room\/([^/]+)$/.exec(pathname);
  const id = m?.[1];
  return id !== undefined && isValidRoomId(id) ? id : null;
}

export function parseAllowedOrigins(list: string | undefined): string[] {
  return (list ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function isOriginAllowed(origin: string | null, allowed: readonly string[]): boolean {
  return origin !== null && allowed.includes(origin);
}

export type RateVerdict = "forward" | "drop" | "close";

/** Per-socket frame counter over one-second windows. */
export class RateLimiter {
  private windowStart = 0;
  private count = 0;
  private overLimitStreak = 0;

  check(nowMs: number): RateVerdict {
    if (nowMs - this.windowStart >= 1000) {
      const gap = nowMs - this.windowStart;
      const wasOver = this.count > MAX_FRAMES_PER_SECOND;
      // The streak survives only if the previous window was over the limit and adjacent to this one.
      this.overLimitStreak = wasOver && gap < 2000 ? this.overLimitStreak : 0;
      this.windowStart = nowMs;
      this.count = 0;
    }
    this.count += 1;
    if (this.count <= MAX_FRAMES_PER_SECOND) return "forward";
    if (this.count === MAX_FRAMES_PER_SECOND + 1) this.overLimitStreak += 1;
    return this.overLimitStreak >= SUSTAINED_SECONDS ? "close" : "drop";
  }
}
