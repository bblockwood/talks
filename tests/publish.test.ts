import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, copyFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decryptDeck, deriveKeys } from "../src/core/crypto";
import { unpackPayload } from "../src/core/payload";
import { filesToPrune, updateDecksBranch } from "../tools/lib/branch.ts";
import { buildDeck, readSidecar } from "../tools/lib/build.ts";
import { codeOwner, deckKey, findDeck, loadStore, saveStore, storePath } from "../tools/lib/store.ts";

const tmp = mkdtempSync(path.join(os.tmpdir(), "lectern-test-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("code store", () => {
  beforeAll(() => {
    process.env["LECTERN_CONFIG_DIR"] = path.join(tmp, "config");
  });
  afterAll(() => {
    delete process.env["LECTERN_CONFIG_DIR"];
  });

  it("starts empty, saves with mode 0600 in a 0700 directory, and reloads", () => {
    expect(loadStore()).toEqual({ version: 1, decks: {} });
    const store = loadStore();
    store.decks["/talks/a.pdf"] = { code: "alpha", source: "/talks/a.pdf", published: "2026-11-26T00:00:00.000Z" };
    store.decks["keynote"] = { code: "beta", source: "/talks/b.pdf", published: "2026-11-27T00:00:00.000Z" };
    saveStore(store);
    expect(statSync(storePath()).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(storePath())).mode & 0o777).toBe(0o700);
    expect(loadStore()).toEqual(store);
  });

  it("finds decks by name, by key and by source path", () => {
    const store = loadStore();
    expect(findDeck(store, "keynote")).toBe("keynote");
    expect(findDeck(store, "/talks/a.pdf")).toBe("/talks/a.pdf");
    expect(findDeck(store, "/talks/b.pdf")).toBe("keynote");
    expect(findDeck(store, "nope")).toBeNull();
    expect(deckKey("x.pdf", "name")).toBe("name");
    expect(deckKey("x.pdf", undefined)).toBe(path.resolve("x.pdf"));
  });

  it("detects a code already used by another deck", () => {
    const store = loadStore();
    expect(codeOwner(store, "alpha", "keynote")).toBe("/talks/a.pdf");
    expect(codeOwner(store, "alpha", "/talks/a.pdf")).toBeNull();
    expect(codeOwner(store, "gamma", "keynote")).toBeNull();
  });

  it("refuses a store it does not understand", () => {
    writeFileSync(storePath(), '{"version":99}');
    expect(() => loadStore()).toThrow(/not a Lectern code store/);
  });
});

describe("buildDeck", () => {
  it("encrypts a PDF with its sidecars so that only the code opens it", async () => {
    const dir = path.join(tmp, "deck");
    mkdirSync(dir);
    copyFileSync("fixtures/pdfpc-notes.pdf", path.join(dir, "My Talk.pdf"));
    copyFileSync("fixtures/pdfpc-notes.pdfpc", path.join(dir, "My Talk.pdfpc"));
    writeFileSync(
      path.join(dir, "My Talk.lectern.json"),
      JSON.stringify({ version: 1, settings: { targetDuration: 1800 }, notes: [{ frameLabel: "2", pageIndex: 1, text: "hi" }], ink: [] }),
    );

    const now = new Date("2026-11-26T15:00:00.000Z");
    const built = await buildDeck(path.join(dir, "My Talk.pdf"), "example-word", now);
    const keys = await deriveKeys("example-word");

    expect(built.deckId).toBe(keys.deckId);
    expect(built.fileName).toMatch(/^[0-9a-f]{16}\.bin$/);
    // current.json carries nothing that identifies the talk (SPEC §4.1).
    expect(JSON.parse(built.currentJson)).toEqual({ v: 1, file: built.fileName, bytes: built.bin.length, published: now.toISOString() });
    expect(built.messages.join("\n")).not.toContain("example-word");

    const payload = unpackPayload(await decryptDeck(keys.deckKey, built.bin));
    expect(payload.pdf).toEqual(new Uint8Array(readFileSync("fixtures/pdfpc-notes.pdf")));
    expect(payload.pdfpc).toEqual(new Uint8Array(readFileSync("fixtures/pdfpc-notes.pdfpc")));
    expect(payload.meta).toMatchObject({
      v: 1,
      source: "My Talk.pdf",
      pageCount: 10,
      published: now.toISOString(),
      settings: { targetDuration: 1800 },
      noteOverrides: [{ frameLabel: "2", pageIndex: 1, text: "hi" }],
    });
    expect(payload.meta.title).not.toBe("");

    const other = await deriveKeys("another-word");
    await expect(decryptDeck(other.deckKey, built.bin)).rejects.toThrow();
  });

  it("fails clearly on a file that is not a PDF", async () => {
    await expect(buildDeck("fixtures/malformed.pdf", "example-word")).rejects.toThrow(/could not be read as a PDF/);
  });

  it("skips a broken sidecar", () => {
    expect(readSidecar("{not json")).toBeNull();
    expect(readSidecar("[]")).toBeNull();
    expect(readSidecar("{}")).toEqual({ settings: {}, noteOverrides: [] });
  });
});

describe("decks branch", () => {
  it("prunes all but the new file and the one before it", () => {
    expect(filesToPrune(["current.json", "a.bin", "b.bin", "c.bin"], "b.bin", "d.bin")).toEqual(["a.bin", "c.bin"]);
    expect(filesToPrune([], null, "a.bin")).toEqual([]);
    expect(filesToPrune(["current.json", "a.bin"], "a.bin", "a.bin")).toEqual([]);
  });

  it("rewrites the branch as a single commit: publish, republish, rollback copy, second deck, revoke", () => {
    const remote = path.join(tmp, "remote.git");
    const repo = path.join(tmp, "repo");
    const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
    execFileSync("git", ["init", "--quiet", "--bare", remote]);
    execFileSync("git", ["init", "--quiet", repo]);
    git(repo, "config", "user.email", "test@example.invalid");
    git(repo, "config", "user.name", "Test");
    git(repo, "remote", "add", "origin", remote);

    const A = "a".repeat(32);
    const B = "b".repeat(32);
    const put = (deckId: string, n: number) => ({
      deckId,
      fileName: `${String(n).repeat(16)}.bin`,
      bin: new Uint8Array([n, n, n]),
      currentJson: JSON.stringify({ v: 1, file: `${String(n).repeat(16)}.bin` }),
    });
    const files = () => git(remote, "ls-tree", "-r", "--name-only", "refs/heads/decks").split("\n").filter(Boolean);
    const commits = () => Number(git(remote, "rev-list", "--count", "refs/heads/decks"));

    updateDecksBranch({ put: put(A, 1) }, repo);
    expect(files()).toEqual([`d/${A}/${"1".repeat(16)}.bin`, `d/${A}/current.json`]);

    updateDecksBranch({ put: put(A, 2) }, repo);
    updateDecksBranch({ put: put(A, 3) }, repo);
    // The current file and the one before it stay; the oldest is gone. Still one commit.
    expect(files()).toEqual([`d/${A}/${"2".repeat(16)}.bin`, `d/${A}/${"3".repeat(16)}.bin`, `d/${A}/current.json`]);
    expect(commits()).toBe(1);
    expect(git(remote, "show", `refs/heads/decks:d/${A}/current.json`)).toContain("3".repeat(16));
    expect(git(remote, "log", "-1", "--format=%s", "refs/heads/decks")).toBe("Decks");

    // A second deck leaves the first alone. Rotating a code removes the old id in the same commit.
    updateDecksBranch({ put: put(B, 4) }, repo);
    expect(files()).toHaveLength(5);
    const C = "c".repeat(32);
    updateDecksBranch({ remove: [B], put: put(C, 5) }, repo);
    expect(files().filter((f) => f.startsWith(`d/${B}/`))).toEqual([]);
    expect(files().filter((f) => f.startsWith(`d/${C}/`))).toHaveLength(2);

    updateDecksBranch({ remove: [A, C] }, repo);
    expect(files()).toEqual([]);
    expect(commits()).toBe(1);

    // The working repo itself was never touched: no commits, no index, no decks branch checked out.
    expect(git(repo, "status", "--porcelain")).toBe("");
    expect(() => git(repo, "rev-parse", "--verify", "--quiet", "HEAD")).toThrow();
  });
});
