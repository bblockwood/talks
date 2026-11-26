import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { codeFromFileName, codeProblem, normalizeCode, randomCode } from "../src/core/code";
import {
  DeckDecryptError,
  contentHash16,
  decryptDeck,
  deriveKeys,
  deriveRawKeys,
  encryptDeck,
  fromHex,
  toHex,
} from "../src/core/crypto";
import { unpackPayload } from "../src/core/payload";

interface Vectors {
  derivations: { code: string; deckId: string; deckKey: string; roomId: string; channelKey: string }[];
  file: { code: string; iv: string; plaintext: string; bin: string };
  sample: { file: string; code: string; sha256: string; pdfSha256: string; published: string };
}
const vectors = JSON.parse(readFileSync("fixtures/crypto-vectors.json", "utf8")) as Vectors;

describe("codes", () => {
  it("normalises case, whitespace and hyphen runs", () => {
    expect(normalizeCode("  Bunching ")).toBe("bunching");
    expect(normalizeCode("Otter  maple--QUIZ - lunar")).toBe("otter-maple-quiz-lunar");
    expect(normalizeCode("-a-\t-b-")).toBe("a-b");
    expect(normalizeCode("   ")).toBe("");
  });
  it("validates codes for publishing", () => {
    expect(codeProblem("bunching")).toBeNull();
    expect(codeProblem("otter-maple-quiz-lunar")).toBeNull();
    expect(codeProblem("talk2026")).toBeNull();
    expect(codeProblem("ab")).toMatch(/at least 3/);
    expect(codeProblem("caf\u00e9")).toMatch(/only letters/);
    expect(codeProblem("a b")).toMatch(/only letters/);
    expect(codeProblem("x".repeat(65))).toMatch(/at most/);
  });
  it("makes a code from a file name", () => {
    expect(codeFromFileName("/Users/ben/talks/Bunching.pdf")).toBe("bunching");
    expect(codeFromFileName("Optimal Soda Tax (v2).PDF")).toBe("optimal-soda-tax-v2");
    expect(codeFromFileName("C:\\decks\\caf\u00e9_talk.pdf")).toBe("cafe-talk");
  });
  it("draws random words", () => {
    let i = 0;
    expect(randomCode(["a", "b", "c"], 4, (n) => i++ % n)).toBe("a-b-c-a");
    expect(() => randomCode([], 4, () => 0)).toThrow();
  });
});

describe("key derivation matches the reference vectors", () => {
  it.each(vectors.derivations)("$code", async (v) => {
    const raw = await deriveRawKeys(v.code);
    expect(toHex(raw.deckId)).toBe(v.deckId);
    expect(toHex(raw.deckKey)).toBe(v.deckKey);
    expect(toHex(raw.roomId)).toBe(v.roomId);
    expect(toHex(raw.channelKey)).toBe(v.channelKey);
    const keys = await deriveKeys(v.code);
    expect(keys.deckId).toBe(v.deckId);
    expect(keys.roomId).toBe(v.roomId);
    expect(keys.deckKey.extractable).toBe(false);
  });

  it("different codes share nothing", () => {
    const ids = new Set(vectors.derivations.flatMap((v) => [v.deckId, v.roomId, v.deckKey, v.channelKey]));
    expect(ids.size).toBe(vectors.derivations.length * 4);
  });
});

describe("deck file format", () => {
  const { file } = vectors;

  it("encrypts to exactly the reference bytes with the reference iv", async () => {
    const keys = await deriveKeys(file.code);
    const bin = await encryptDeck(keys.deckKey, fromHex(file.plaintext), fromHex(file.iv));
    expect(toHex(bin)).toBe(file.bin);
    expect(new TextDecoder().decode(bin.subarray(0, 4))).toBe("LCTW");
    expect(bin[4]).toBe(1);
  });

  it("decrypts the reference bytes", async () => {
    const keys = await deriveKeys(file.code);
    expect(toHex(await decryptDeck(keys.deckKey, fromHex(file.bin)))).toBe(file.plaintext);
  });

  it("uses a fresh random iv per publish", async () => {
    const keys = await deriveKeys(file.code);
    const a = await encryptDeck(keys.deckKey, fromHex(file.plaintext));
    const b = await encryptDeck(keys.deckKey, fromHex(file.plaintext));
    expect(toHex(a)).not.toBe(toHex(b));
    expect(toHex(await decryptDeck(keys.deckKey, a))).toBe(file.plaintext);
  });

  it("rejects the wrong code, a flipped bit, a bad header and a short file", async () => {
    const right = await deriveKeys(file.code);
    const wrong = await deriveKeys("some-other-code");
    const bin = fromHex(file.bin);
    await expect(decryptDeck(wrong.deckKey, bin)).rejects.toBeInstanceOf(DeckDecryptError);

    const flipped = bin.slice();
    flipped[flipped.length - 1] = (flipped[flipped.length - 1] ?? 0) ^ 1;
    await expect(decryptDeck(right.deckKey, flipped)).rejects.toBeInstanceOf(DeckDecryptError);

    const badMagic = bin.slice();
    badMagic[0] = 0x58;
    await expect(decryptDeck(right.deckKey, badMagic)).rejects.toThrow("not a Lectern deck");

    const badVersion = bin.slice();
    badVersion[4] = 2;
    await expect(decryptDeck(right.deckKey, badVersion)).rejects.toThrow("unsupported deck version");

    await expect(decryptDeck(right.deckKey, bin.subarray(0, 20))).rejects.toThrow("file too short");
  });

  it("names files by content hash", async () => {
    expect(await contentHash16(new TextEncoder().encode("abc"))).toBe("ba7816bf8f01cfea");
  });
});

it("fixture 12 (encrypted-sample.bin) opens with its code and holds the original PDF", async () => {
  const { sample } = vectors;
  const bin = new Uint8Array(readFileSync(`fixtures/${sample.file}`));
  const sha = async (b: Uint8Array) => toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(b))));
  expect(await sha(bin)).toBe(sample.sha256);
  const keys = await deriveKeys(sample.code);
  const payload = unpackPayload(await decryptDeck(keys.deckKey, bin));
  expect(payload.meta).toMatchObject({ v: 1, title: "Basic 16:9", pageCount: 20, published: sample.published });
  expect(await sha(payload.pdf)).toBe(sample.pdfSha256);
});
