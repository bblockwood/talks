import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { buildDeck } from "../tools/lib/build.ts";
import type { BuiltDeck } from "../tools/lib/build.ts";

// A test-only code. The dev server serves .e2e/d/ where the deployed site serves the decks branch.
const CODE = "e2e-talk-code";
const ROOT = path.resolve(".e2e/d");

function place(deck: BuiltDeck, bin: Uint8Array = deck.bin): void {
  const dir = path.join(ROOT, deck.deckId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, deck.fileName), bin);
  writeFileSync(path.join(dir, "current.json"), deck.currentJson);
}

let deck: BuiltDeck;
test.beforeAll(async () => {
  rmSync(ROOT, { recursive: true, force: true });
  deck = await buildDeck("fixtures/links-appendix.pdf", CODE);
  place(deck);
});
test.afterAll(() => rmSync(path.resolve(".e2e"), { recursive: true, force: true }));

async function enter(page: Page, code: string): Promise<void> {
  await page.locator("#code").fill(code);
  await page.locator("#code").press("Enter");
}

test("a published deck opens with its code and presents", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (r) => requests.push(r.url()));
  const problems: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(m.text());
  });

  await page.goto("./");
  const input = page.locator("#code");
  await expect(input).toBeFocused();
  await expect(input).toHaveAttribute("autocomplete", "off");
  await expect(input).toHaveAttribute("spellcheck", "false");

  // Typed sloppily: case, spaces and doubled hyphens are normalised.
  await enter(page, "  E2E  talk--CODE ");
  await expect(page.locator("#ready")).toBeVisible();
  await expect(page.locator("#deck-title")).toHaveText(deck.meta.title);
  await expect(page.locator("#deck-summary")).toContainText(`${deck.meta.pageCount} pages`);
  await expect(input).toHaveValue(""); // the code does not linger in the field

  // current.json is fetched with a cache-buster; the code never appears in any URL.
  const current = requests.find((u) => u.includes("/current.json"));
  expect(current).toMatch(new RegExp(`/talks/d/${deck.deckId}/current\\.json\\?t=\\d+$`));
  expect(requests.some((u) => u.endsWith(`/talks/d/${deck.deckId}/${deck.fileName}`))).toBe(true);
  expect(requests.filter((u) => u.toLowerCase().includes("e2e"))).toEqual([]);
  expect(page.url()).toBe("http://localhost:5173/talks/");

  await page.locator("#start").click();
  await expect(page.locator("#audience canvas")).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__lectern?.shownPage())).toBe(0);
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => page.evaluate(() => window.__lectern?.shownPage())).toBe(1);

  // Nothing decrypted, and no code, is written to any storage on the room PC.
  const stored = await page.evaluate(async () => ({
    local: localStorage.length,
    session: sessionStorage.length,
    cookies: document.cookie,
    databases: (await indexedDB.databases()).length,
    caches: (await caches.keys()).length,
  }));
  expect(stored).toEqual({ local: 0, session: 0, cookies: "", databases: 0, caches: 0 });

  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(page.locator("#code")).toBeVisible();
  await expect(page.locator("#code")).toHaveValue("");
  expect(problems).toEqual([]);
});

test("a wrong code says so in plain language and lets you try again", async ({ page }) => {
  await page.goto("./");
  await enter(page, "not-a-real-code");
  await expect(page.locator("#status")).toHaveText("No talk found for that code.");
  await expect(page.locator("#ready")).toBeHidden();
  await expect(page.locator("#code")).toBeFocused();

  await enter(page, CODE);
  await expect(page.locator("#ready")).toBeVisible();
  await expect(page.locator("#status")).toHaveText("");
});

test("a network failure is reported as one, not as a wrong code", async ({ page }) => {
  await page.route("**/talks/d/**", (route) => route.abort("internetdisconnected"));
  await page.goto("./");
  await enter(page, CODE);
  await expect(page.locator("#status")).toHaveText("Could not reach the server. Check the connection and try again.");
  await page.unroute("**/talks/d/**");
  await page.route("**/talks/d/**", (route) => route.fulfill({ status: 503, body: "busy" }));
  await enter(page, CODE);
  await expect(page.locator("#status")).toContainText("Could not reach the server.");
});

test("a damaged deck file is refused", async ({ page }) => {
  const tampered = deck.bin.slice();
  tampered[tampered.length - 5] = (tampered[tampered.length - 5] ?? 0) ^ 0xff;
  place(deck, tampered);
  try {
    await page.goto("./");
    await enter(page, CODE);
    await expect(page.locator("#status")).toHaveText("No talk found for that code.");
  } finally {
    place(deck);
  }
});

test("a republished deck is picked up straight away under the same code", async ({ page }) => {
  await page.goto("./");
  await enter(page, CODE);
  await expect(page.locator("#deck-summary")).toContainText(`${deck.meta.pageCount} pages`);

  const updated = await buildDeck("fixtures/basic-169.pdf", CODE);
  expect(updated.deckId).toBe(deck.deckId);
  place(updated);
  try {
    await page.locator("#another").click();
    await enter(page, CODE);
    await expect(page.locator("#deck-summary")).toHaveText("20 pages");
  } finally {
    place(deck);
  }
});

test("the file picker still opens a PDF from this computer", async ({ page }) => {
  await page.goto("./");
  await page.locator("#file").setInputFiles("fixtures/overlays.pdf");
  await expect(page.locator("#ready")).toBeVisible();
  await expect(page.locator("#deck-summary")).toHaveText("9 frames, 23 pages");
});

test("the browser's crypto matches the shared test vectors", async ({ page }) => {
  await page.goto("./");
  const vectors = JSON.parse(readFileSync("fixtures/crypto-vectors.json", "utf8")) as {
    derivations: { code: string; deckId: string; deckKey: string; roomId: string; channelKey: string }[];
    file: { code: string; iv: string; plaintext: string; bin: string };
    sample: { code: string; pdfSha256: string };
  };
  const sampleBin = readFileSync("fixtures/encrypted-sample.bin").toString("hex");

  const result = await page.evaluate(
    async ({ vectors, sampleBin }) => {
      // The very modules the entry screen uses, loaded from the dev server.
      const base = "/talks/src/core/";
      const crypto_ = (await import(/* @vite-ignore */ `${base}crypto.ts`)) as typeof import("../src/core/crypto.ts");
      const payload_ = (await import(/* @vite-ignore */ `${base}payload.ts`)) as typeof import("../src/core/payload.ts");
      const { toHex, fromHex } = crypto_;

      const derivations = [];
      for (const v of vectors.derivations) {
        const raw = await crypto_.deriveRawKeys(v.code);
        derivations.push({
          code: v.code,
          deckId: toHex(raw.deckId),
          deckKey: toHex(raw.deckKey),
          roomId: toHex(raw.roomId),
          channelKey: toHex(raw.channelKey),
        });
      }
      const keys = await crypto_.deriveKeys(vectors.file.code);
      const bin = toHex(await crypto_.encryptDeck(keys.deckKey, fromHex(vectors.file.plaintext), fromHex(vectors.file.iv)));
      const plaintext = toHex(await crypto_.decryptDeck(keys.deckKey, fromHex(vectors.file.bin)));

      const sampleKeys = await crypto_.deriveKeys(vectors.sample.code);
      const sample = payload_.unpackPayload(await crypto_.decryptDeck(sampleKeys.deckKey, fromHex(sampleBin)));
      const pdfSha256 = toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(sample.pdf))));
      return { derivations, bin, plaintext, pdfSha256, sampleTitle: sample.meta.title };
    },
    { vectors, sampleBin },
  );

  expect(result.derivations).toEqual(vectors.derivations);
  expect(result.bin).toBe(vectors.file.bin);
  expect(result.plaintext).toBe(vectors.file.plaintext);
  expect(result.pdfSha256).toBe(vectors.sample.pdfSha256);
  expect(result.sampleTitle).toBe("Basic 16:9");
});
