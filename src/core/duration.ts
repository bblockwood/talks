// What someone types into the countdown field (Native §6.2): "45" is minutes; "45:30" and "1:05:00"
// are minutes:seconds and hours:minutes:seconds; "90m", "1h", "1h30", "1h 30m", "1.5h" and "30s"
// use units. A port of the native app's DurationParser.

export const MAX_COUNTDOWN_MS = 24 * 60 * 60 * 1000;

/** The typed time in milliseconds, or null if it is not a time above zero (and at most a day). */
export function parseDuration(text: string): number | null {
  const seconds = parseSeconds(text.trim().toLowerCase());
  if (seconds === null || !(seconds > 0)) return null;
  const ms = Math.round(seconds * 1000);
  return ms > 0 && ms <= MAX_COUNTDOWN_MS ? ms : null;
}

function parseSeconds(text: string): number | null {
  if (text === "") return null;
  if (text.includes(":")) {
    const parts = text.split(":").map((p) => p.trim());
    if (parts.length < 2 || parts.length > 3 || !parts.every((p) => /^\d+$/.test(p))) return null;
    const [a = 0, b = 0, c = 0] = parts.map(Number);
    return parts.length === 2 ? a * 60 + b : a * 3600 + b * 60 + c;
  }
  if (/^\d+(\.\d+)?$/.test(text)) return Number(text) * 60;

  // Unit form. A bare number after a unit takes the next smaller unit: "1h30" is 1 h 30 min.
  let total = 0;
  let lastUnit: string | null = null;
  let rest = text;
  while (rest !== "") {
    const m = /^(\d+(?:\.\d+)?)\s*([a-z]?)\s*/.exec(rest);
    if (!m) return null;
    const value = Number(m[1]);
    const unit = m[2] ?? "";
    rest = rest.slice(m[0].length);
    if (unit === "h") total += value * 3600;
    else if (unit === "m") total += value * 60;
    else if (unit === "s") total += value;
    else if (unit !== "") return null;
    else if (lastUnit === "h") total += value * 60;
    else if (lastUnit === "m") total += value;
    else return null;
    lastUnit = unit === "" ? null : unit;
  }
  return total;
}
