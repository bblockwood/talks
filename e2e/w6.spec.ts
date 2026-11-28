import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "@playwright/test";
import { packPage } from "../src/core/pack.ts";

// The packed copy: one HTML file with the app and a PDF inside it, opened straight from disk
// (file://), as from a thumb drive on a computer with no connection.
const DIR = path.resolve(".e2e/packed");
const TEMPLATE = path.join(DIR, "standalone.html");
const PACKED = path.join(DIR, "My talk.lectern.html");

test.beforeAll(() => {
  mkdirSync(DIR, { recursive: true });
  execSync(`npx vite build -c vite.standalone.config.ts && node tools/make-standalone.mjs "${TEMPLATE}"`, { stdio: "pipe" });
  const parts = packPage(readFileSync(TEMPLATE, "utf8"), readFileSync("fixtures/overlays.pdf").toString("base64"), "My talk.pdf");
  if (!parts) throw new Error("the standalone page has no marker");
  writeFileSync(PACKED, parts.join(""));
});

test("a packed copy opened from disk shows its slides and runs the talk, with nothing fetched", async ({ browser }) => {
  // No network at all: anything the page tried to fetch would fail and be counted.
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, offline: true });
  const page = await context.newPage();
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(e.message));
  const warnings: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(m.text());
    if (m.type() === "warning") warnings.push(m.text());
  });
  await page.goto(pathToFileURL(PACKED).href);
  await expect(page.locator("#ready")).toBeVisible({ timeout: 15_000 });
  await expect(page).toHaveTitle("My talk.pdf · Lectern");
  await expect(page.locator("#deck-summary")).toHaveText("9 frames, 23 pages");
  await expect(page.locator("#phone-status")).toContainText("packed copy");
  await expect(page.locator("#both")).toBeDisabled();
  await expect(page.locator("#leave-row")).toBeHidden();
  await expect(page.locator("#pack-row")).toBeHidden();
  await expect(page.locator("#code-line")).toBeHidden();

  // The slides, from the slides: keys, the overview with rendered thumbnails, the bar.
  await page.locator("#start").click();
  await expect(page.locator("#audience .aud-menu")).toBeAttached(); // the slides are up and taking keys
  await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("Tab");
  await expect(page.locator(".aud-where")).toHaveText(/^Frame 2 \/ 9/);
  await expect(page.locator(".aud-overview .thumb")).toHaveCount(9);
  await expect(page.locator(".aud-link")).toHaveText("This device only");
  // The slide itself was drawn by the PDF reader running inside the file: not a black canvas.
  await page.keyboard.press("Tab");
  const lit = await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>("#audience canvas")!;
    const data = canvas.getContext("2d")!.getImageData(canvas.width / 2 - 50, canvas.height / 2 - 50, 100, 100).data;
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) sum += data[i]! + data[i + 1]! + data[i + 2]!;
    return sum / (data.length / 4) / 3;
  });
  expect(lit).toBeGreaterThan(100);

  // And the presenter view, in the same window.
  await page.waitForTimeout(1600);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(page.locator("#ready")).toBeVisible();
  await page.locator("#presenter").click();
  await expect(page.locator("#frame-line")).toHaveText("Frame 2 / 9");
  await page.keyboard.press("Shift+ArrowRight");
  await expect(page.locator("#frame-line")).toHaveText("Frame 3 / 9");
  // The PDF reader runs in a worker of its own, not on the page's thread.
  expect(warnings.filter((w) => /fake worker/i.test(w))).toEqual([]);
  expect(problems.filter((p) => !/cmap|standard_fonts|font/i.test(p))).toEqual([]);
  await context.close();
});
