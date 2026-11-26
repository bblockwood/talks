// Talk codes (SPEC §3). A code is whatever Ben chose at publish time, usually one word.
// This file has no imports so the tools can load it directly under Node.

/** Lowercase, trim, and treat any run of spaces or hyphens as one hyphen. */
export function normalizeCode(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[\s-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export const MIN_CODE_LENGTH = 3;
export const MAX_CODE_LENGTH = 64;

/**
 * Why a code can't be used for publishing, or null if it is fine. Codes are limited to letters
 * a–z, digits and hyphens so they can be typed on any keyboard layout.
 */
export function codeProblem(normalized: string): string | null {
  if (normalized.length < MIN_CODE_LENGTH) return `a code needs at least ${MIN_CODE_LENGTH} characters`;
  if (normalized.length > MAX_CODE_LENGTH) return `a code can have at most ${MAX_CODE_LENGTH} characters`;
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(normalized)) return "a code may contain only letters a–z, digits and hyphens";
  return null;
}

/** A code made from a file name: `Bunching Talk (v2).pdf` → `bunching-talk-v2`. */
export function codeFromFileName(fileName: string): string {
  const base = fileName.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "");
  return normalizeCode(
    base
      .normalize("NFKD")
      .replace(/[^\x20-\x7e]/g, "")
      .replace(/[^A-Za-z0-9]+/g, " "),
  );
}

/** `count` words drawn uniformly from `words`. `randomInt(n)` must return an unbiased integer in [0, n). */
export function randomCode(words: readonly string[], count: number, randomInt: (n: number) => number): string {
  const picked: string[] = [];
  for (let i = 0; i < count; i++) {
    const word = words[randomInt(words.length)];
    if (word === undefined) throw new Error("empty word list");
    picked.push(word);
  }
  return picked.join("-");
}
