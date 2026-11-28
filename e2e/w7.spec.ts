import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

// The sample deck on the opening page, and the Overview button's size (Ben, 2026-11-27).

async function openSample(page: Page): Promise<void> {
  await page.goto("./");
  await page.locator("#sample-tour").click();
  await page.locator("#presenter").click();
  await expect(page.locator("#console")).toBeVisible();
}

test("the sample deck opens with notes, an outline, builds and a working link", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1400, height: 850 } });
  const page = await context.newPage();
  await openSample(page);
  await expect(page.locator("#notes")).toContainText("These are speaker notes");

  // The outline lists the deck's sections.
  await page.locator("#tab-outline").click();
  await expect(page.locator("#outline")).toContainText("Moving around");
  await expect(page.locator("#outline")).toContainText("Pictures that move");
  await expect(page.locator("#outline")).toContainText("Backup slides");
  await page.locator("#tab-notes").click();

  // Frame 2 has builds, each with its own note.
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("#notes")).toContainText("five builds");
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("#notes")).toContainText("the build about the arrow keys");

  // Frame 3's first button leads to the proof in the appendix.
  await page.keyboard.press("Shift+ArrowRight");
  await expect(page.locator("#notes")).toContainText("Both buttons jump");
  await page.waitForTimeout(500); // the slide is drawn and its links read
  const slide = (await page.locator("#current canvas").first().boundingBox())!;
  await page.mouse.click(slide.x + slide.width * 0.2, slide.y + slide.height * 0.43);
  await expect(page.locator("#notes")).toContainText("A backup slide with two builds");
  await context.close();
});

test("the Overview button keeps its size and place when lit", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1400, height: 850 } });
  const page = await context.newPage();
  await openSample(page);
  const box = async (id: string) => {
    const b = await page.locator(id).boundingBox();
    const font = await page.locator(id).evaluate((el) => getComputedStyle(el).fontSize);
    return { ...b, font };
  };
  const unlit = await box("#side-slides");
  await page.keyboard.press("Tab");
  await expect(page.locator("#overview")).toBeVisible();
  expect(await box("#overview-close")).toEqual(unlit);
  await context.close();
});
