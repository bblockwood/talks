// npm run publish -- <file.pdf> [--code <word>] [--name <slug>] [--rotate-code] [--random] [--long] [--notes-split <side>] [--wait]
// Encrypts a deck and puts it on the site (SPEC §4.4). The talk code is printed here and stored in
// ~/.config/lectern/codes.json, and nowhere else.
import { randomInt } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { codeFromFileName, codeProblem, normalizeCode, randomCode } from "../src/core/code.ts";
import { deriveKeys } from "../src/core/crypto.ts";
import { triggerDeploy, updateDecksBranch } from "./lib/branch.ts";
import { buildDeck } from "./lib/build.ts";
import { SITE_URL } from "./lib/config.ts";
import { codeOwner, deckKey, loadStore, saveStore } from "./lib/store.ts";

const USAGE = `Usage: npm run publish -- <file.pdf> [options]

  --code <word>    Talk code to use, e.g. --code bunching. Kept on later publishes.
                   Without it, a first publish uses the PDF's file name.
  --name <slug>    Remember the code under this name instead of the PDF's path.
  --rotate-code    Replace the code (with --code, or a random one) and delete the old deck.
  --random         Use four random words instead of a chosen word.
  --long           With --random or --rotate-code: six random words.
  --notes-split <side>
                   For Beamer "show notes on second screen": where the notes panel is
                   (left, right, top, bottom), or none to show whole pages. Without it,
                   pages about twice as wide or tall as a slide are split automatically.
  --wait           Wait until the new deck is live, and report how long it took.
`;

function fail(message: string): never {
  console.error(`publish: ${message}`);
  process.exit(1);
}

async function waitUntilLive(deckId: string, fileName: string): Promise<number | null> {
  const start = Date.now();
  const url = `${SITE_URL}/d/${deckId}/current.json`;
  while (Date.now() - start < 15 * 60 * 1000) {
    try {
      // Cache-busting per SPEC §4.5.
      const response = await fetch(`${url}?t=${Date.now()}`, { cache: "no-store" });
      if (response.ok && ((await response.json()) as { file?: unknown }).file === fileName) {
        return Math.round((Date.now() - start) / 1000);
      }
    } catch {
      // Not there yet, or a network blip: keep polling.
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return null;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      code: { type: "string" },
      name: { type: "string" },
      "rotate-code": { type: "boolean", default: false },
      random: { type: "boolean", default: false },
      long: { type: "boolean", default: false },
      wait: { type: "boolean", default: false },
      "notes-split": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help || positionals.length !== 1) {
    console.error(USAGE);
    process.exit(values.help ? 0 : 1);
  }
  const pdfPath = path.resolve(positionals[0] ?? "");
  if (!existsSync(pdfPath)) fail(`no such file: ${pdfPath}`);
  if (!/\.pdf$/i.test(pdfPath)) fail("the file to publish must be a .pdf");

  const store = loadStore();
  const key = deckKey(pdfPath, values.name);
  const stored = store.decks[key];

  const randomWords = (): string => {
    const words = readFileSync(path.join(import.meta.dirname, "lib", "eff-short-wordlist.txt"), "utf8").split("\n").filter(Boolean);
    return randomCode(words, values.long ? 6 : 4, (n) => randomInt(n));
  };

  let code: string;
  if (values.code !== undefined) code = normalizeCode(values.code);
  else if (values.random || values.long || (values["rotate-code"] && stored)) code = randomWords();
  else if (stored) code = stored.code;
  else code = codeFromFileName(pdfPath);

  const problem = codeProblem(code);
  if (problem) fail(`${problem}. Choose one with --code <word>.`);
  if (stored && code !== stored.code && !values["rotate-code"] && values.code === undefined) {
    fail("this deck already has a code. Use --rotate-code to replace it.");
  }
  const owner = codeOwner(store, code, key);
  if (owner) fail(`that code is already used by another deck (${owner}). Choose a different one with --code <word>.`);

  const notesSplit = values["notes-split"]?.toLowerCase();
  if (notesSplit !== undefined && !["left", "right", "top", "bottom", "none"].includes(notesSplit)) {
    fail("--notes-split must be one of: left, right, top, bottom, none");
  }
  const deck = await buildDeck(pdfPath, code, new Date(), notesSplit !== undefined ? { notesSplit } : {});
  for (const message of deck.messages) console.error(message);

  // A changed code means a new deck id: the old deck directory goes away in the same commit.
  const remove: string[] = [];
  if (stored && stored.code !== code) remove.push((await deriveKeys(stored.code)).deckId);

  updateDecksBranch({ remove, put: deck });
  store.decks[key] = { code, source: pdfPath, published: deck.meta.published };
  saveStore(store);
  triggerDeploy();

  console.error(`Published “${deck.meta.title}”: ${deck.meta.pageCount} pages, ${(deck.bin.length / 1e6).toFixed(1)} MB.`);
  if (values.wait) {
    console.error("Waiting for the site to update…");
    const seconds = await waitUntilLive(deck.deckId, deck.fileName);
    if (seconds === null) console.error("Warning: the deck was not live after 15 minutes. Check the deploy with: gh run list");
    else console.error(`Live after ${seconds} s.`);
  } else {
    console.error("The site takes about a minute to update. Use --wait to be told when it is live.");
  }
  // The one line that carries the code (SPEC §4.4): stdout only.
  console.log(`Code: ${code} → ${SITE_URL}  (on the room PC: open that address, type the code, click Start)`);
}

main().catch((e: unknown) => fail(e instanceof Error ? e.message : String(e)));
