import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

// The sample deck on the opening page, and the Overview button's size (Ben, 2026-11-27).

async function openSample(page: Page): Promise<void> {
  await page.goto("./");
  // The deck's LaTeX source is offered beside it.
  const source = await page.request.get(await page.locator("#sample-tour-tex").evaluate((a: HTMLAnchorElement) => a.href));
  expect(await source.text()).toContain("\\title{A tour of Lectern}");
  await page.locator("#sample-tour").click();
  await expect(page.locator("#local-line")).toHaveText(/^Slides loaded locally/);
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
  for (const section of ["How to use it", "How it works", "Designing slides", "Useful features", "Backup slides"])
    await expect(page.locator("#outline")).toContainText(section);
  await page.locator("#tab-notes").click();
  const goTo = async (frame: number) => {
    await page.keyboard.type(String(frame));
    await page.keyboard.press("Enter");
  };

  // Frame 13 has builds, each with its own note.
  await goTo(13);
  await expect(page.locator("#notes")).toContainText("five builds appear");
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("#notes")).toContainText("the build about the arrow keys");

  // Frame 15's note is written in Markdown.
  await goTo(15);
  await expect(page.locator("#notes em")).toHaveText("emphasis");
  await expect(page.locator("#notes code")).toHaveText("code");
  await expect(page.locator("#notes p.li")).toHaveCount(3);

  // Frame 14's button leads to a backup slide in the appendix.
  await goTo(14);
  await expect(page.locator("#notes")).toContainText("The Outline tab beside Notes");
  await page.waitForTimeout(500); // the slide is drawn and its links read
  const slide = (await page.locator("#current canvas").first().boundingBox())!;
  await page.mouse.click(slide.x + slide.width * 0.171, slide.y + slide.height * 0.706);
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

test("opened from the Home Screen, every full-screen surface keeps the same clear strip at the top", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 800 }, deviceScaleFactor: 2, hasTouch: true });
  const page = await context.newPage();
  await openSample(page);
  // The browser under test cannot pretend to be a Home Screen app; what that mode sets is one variable.
  await page.evaluate(() => document.documentElement.style.setProperty("--status-clear", "2.2rem"));
  const top = (selector: string) => page.locator(selector).evaluate((el) => getComputedStyle(el).paddingTop);
  const clear = await top("#console");
  expect(parseFloat(clear)).toBeGreaterThan(30);
  await page.locator("#t-slides").click();
  await expect(page.locator("#overview")).toBeVisible();
  expect(await top("#overview")).toBe(clear);
  await page.locator("#overview-close").click();
  await page.locator("#link").click();
  await expect(page.locator(".sheet-panel:visible")).toBeVisible();
  expect(await top(".sheet-panel:visible")).toBe(clear);
  await context.close();
});

test("on a phone the connection button is a few words on one line", async ({ browser }) => {
  for (const width of [320, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 700 }, deviceScaleFactor: 2, hasTouch: true });
    const page = await context.newPage();
    await openSample(page);
    const link = page.locator("#link");
    await expect(link).toHaveText(/^(No slides screen|This device only|Offline)$/);
    await expect(link).toHaveAttribute("aria-label", /No slides screen yet/);
    // One line: nothing cut off, and no taller than a line of text with the button's padding.
    await expect
      .poll(() => link.evaluate((el) => el.scrollWidth <= el.clientWidth && el.getBoundingClientRect().height < 34))
      .toBe(true);
    await context.close();
  }
});
