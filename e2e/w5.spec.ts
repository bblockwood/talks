import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { buildDeck } from "../tools/lib/build.ts";
import type { BuiltDeck } from "../tools/lib/build.ts";

// These run against a production build served by `vite preview` (port 4173), because the
// service worker exists only there.
const SITE = "http://localhost:4173/talks/";
const CODE = "e2e-offline-code";
const DECKS = path.resolve(".e2e/d");

function place(deck: BuiltDeck): void {
  const dir = path.join(DECKS, deck.deckId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, deck.fileName), deck.bin);
  writeFileSync(path.join(dir, "current.json"), deck.currentJson);
}

let deck: BuiltDeck;
test.beforeAll(async () => {
  deck = await buildDeck("fixtures/overlays.pdf", CODE);
  place(deck);
});
test.afterAll(() => rmSync(path.resolve(".e2e"), { recursive: true, force: true }));

/** Waits until the service worker has installed and taken control of the page. */
async function controlled(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise<void>((resolve) => navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true }));
    }
  });
}

async function openByCode(page: Page): Promise<void> {
  await page.locator("#code").fill(CODE);
  await page.locator("#code").press("Enter");
  await expect(page.locator("#ready")).toBeVisible();
}

test("offline: the page reloads, and a deck opened before opens again and presents", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(String(e)));

  await page.goto(SITE);
  await controlled(page);
  await openByCode(page);
  await expect(page.locator("#deck-summary")).toHaveText("9 frames, 23 pages");

  await context.setOffline(true);
  await page.reload();
  await expect(page.locator("#code")).toBeVisible();
  await openByCode(page);
  await expect(page.locator("#deck-summary")).toHaveText("9 frames, 23 pages");
  await expect(page.locator("#phone-status")).toHaveText("Not connected: other devices can't join right now.");
  await page.locator("#start").click();
  await expect(page.locator("#audience canvas").first()).toBeVisible();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  // The slide really rendered: PDF.js and its worker came from the cache.
  await expect
    .poll(() =>
      page.locator("#audience canvas").first().evaluate((c: HTMLCanvasElement) => {
        const d = c.getContext("2d")!.getImageData(Math.floor(c.width / 2) - 50, Math.floor(c.height / 2) - 50, 100, 100).data;
        let sum = 0;
        for (let i = 0; i < d.length; i += 4) sum += d[i]!;
        return sum / (d.length / 4);
      }),
    )
    .toBeGreaterThan(200);

  // A code never opened on this device is not found offline, and says it is the network.
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.locator("#another").click();
  await expect(page.locator("#code")).toBeVisible();
  await page.locator("#code").fill("never-opened-here");
  await page.locator("#code").press("Enter");
  await expect(page.locator("#status")).toContainText("Could not reach the server");

  expect(problems).toEqual([]);
  await context.close();
});

test("the caches hold the app and ciphertext only: never a PDF, never a code", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(SITE);
  await controlled(page);
  await openByCode(page);
  await page.locator("#start").click();
  await expect(page.locator("#audience canvas").first()).toBeVisible();
  await page.keyboard.press("ArrowRight");

  const audit = await page.evaluate(async (code) => {
    const names = await caches.keys();
    const entries: { cache: string; url: string; head: string }[] = [];
    let mentionsCode = false;
    for (const name of names) {
      const cache = await caches.open(name);
      for (const request of await cache.keys()) {
        const body = new Uint8Array(await (await cache.match(request))!.arrayBuffer());
        const head = String.fromCharCode(...body.subarray(0, 5));
        if (request.url.toLowerCase().includes(code)) mentionsCode = true;
        entries.push({ cache: name, url: new URL(request.url).pathname, head });
      }
    }
    return {
      names,
      entries,
      mentionsCode,
      storage: localStorage.length + sessionStorage.length,
      databases: (await indexedDB.databases()).length,
    };
  }, CODE);

  expect(audit.names).toHaveLength(2);
  expect(audit.names).toContain("lectern-decks-v1");
  expect(audit.names.find((n) => n !== "lectern-decks-v1")).toMatch(/^lectern-shell-[0-9a-f]{12}$/);
  const deckEntries = audit.entries.filter((e) => e.cache === "lectern-decks-v1");
  expect(deckEntries.map((e) => e.url).sort()).toEqual([`/talks/d/${deck.deckId}/${deck.fileName}`, `/talks/d/${deck.deckId}/current.json`].sort());
  // The cached deck file is the encrypted one, byte for byte the "LCTW" container.
  expect(deckEntries.find((e) => e.url.endsWith(".bin"))?.head.startsWith("LCTW")).toBe(true);
  // No cache entry anywhere is a PDF.
  expect(audit.entries.filter((e) => e.head.startsWith("%PDF"))).toEqual([]);
  expect(audit.mentionsCode).toBe(false);
  expect(audit.storage).toBe(0);
  expect(audit.databases).toBe(0);
  await context.close();
});

test("a republished deck replaces the cached one; a revoked deck is forgotten", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(SITE);
  await controlled(page);
  await openByCode(page);

  const cachedBins = () =>
    page.evaluate(async () => (await (await caches.open("lectern-decks-v1")).keys()).map((r) => r.url.split("/").pop()).filter((n) => n?.endsWith(".bin")));
  expect(await cachedBins()).toEqual([deck.fileName]);

  const newer = await buildDeck("fixtures/basic-169.pdf", CODE);
  place(newer);
  try {
    await page.locator("#another").click();
    await openByCode(page);
    await expect(page.locator("#deck-summary")).toHaveText("20 pages");
    await expect.poll(cachedBins).toEqual([newer.fileName]);

    // Revoked: the server answers 404, and the device's copy goes too, so it can't be opened offline later.
    rmSync(path.join(DECKS, deck.deckId), { recursive: true, force: true });
    await page.locator("#another").click();
    await page.locator("#code").fill(CODE);
    await page.locator("#code").press("Enter");
    await expect(page.locator("#status")).toHaveText("No talk found for that code.");
    await expect.poll(cachedBins).toEqual([]);
    await context.setOffline(true);
    await page.locator("#code").fill(CODE);
    await page.locator("#code").press("Enter");
    await expect(page.locator("#status")).toContainText("Could not reach the server");
  } finally {
    place(deck);
  }
  await context.close();
});

test("the presenter view reloads offline and reopens a remembered talk", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const phone = await context.newPage();
  await phone.goto(SITE);
  await controlled(phone);
  await phone.locator("#code").fill(CODE);
  await phone.locator("#remember").check();
  await phone.locator("#open").click();
  await phone.locator("#presenter").click();
  await expect(phone.locator("#console")).toBeVisible();

  await context.setOffline(true);
  await phone.reload();
  await expect(phone.locator("#saved .talk")).toHaveCount(1);
  await phone.locator("#saved .talk").click();
  await phone.locator("#presenter").click();
  await expect(phone.locator("#console")).toBeVisible();
  await expect(phone.locator("#frame-line")).toHaveText("Frame 1 / 9");
  // With no connection the talk simply runs on this device.
  await expect(phone.locator("#link")).toHaveText("No slides screen yet · offline", { timeout: 10_000 });
  await phone.locator("#next").click();
  await expect(phone.locator("#frame-line")).toHaveText("Frame 2 / 9");
  await context.close();
});
