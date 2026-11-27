import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import type { BrowserContext, Page } from "@playwright/test";
import { buildDeck } from "../tools/lib/build.ts";

// Mode B cannot be tested on real hardware here, so the Window Management API is faked: two
// screens are reported, and full screen ignores which screen was asked for. What is tested is
// everything else: the second window, the channel between the windows, and the presenter view.
const CODE = "e2e-presenter-code";
const DECKS = path.resolve(".e2e/d");
const SRC = path.resolve(".e2e/w4src");

interface RoomHook {
  state(): { committedPage: number; audienceMode: { kind: string } };
  shownPage(): number | null | undefined;
  pointerVisible(): boolean;
}
const room = <T>(page: Page, pick: (h: RoomHook) => T): Promise<T> =>
  page.evaluate((src) => (0, eval)(`(${src})`)((window as unknown as { __lectern: RoomHook }).__lectern) as T, pick.toString());
const roomPage = (page: Page) => page.evaluate(() => (window as unknown as { __lectern?: RoomHook }).__lectern?.shownPage());

test.beforeAll(async () => {
  rmSync(SRC, { recursive: true, force: true });
  mkdirSync(SRC, { recursive: true });
  copyFileSync("fixtures/pdfpc-notes.pdf", path.join(SRC, "talk.pdf"));
  copyFileSync("fixtures/pdfpc-notes.pdfpc", path.join(SRC, "talk.pdfpc"));
  const deck = await buildDeck(path.join(SRC, "talk.pdf"), CODE);
  const dir = path.join(DECKS, deck.deckId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, deck.fileName), deck.bin);
  writeFileSync(path.join(dir, "current.json"), deck.currentJson);
});
test.afterAll(() => rmSync(path.resolve(".e2e"), { recursive: true, force: true }));

async function fakeTwoScreens(context: BrowserContext, extended = true): Promise<void> {
  await context.addInitScript((extended) => {
    const make = (label: string, left: number, isInternal: boolean) => ({
      label, left, top: 0, width: 1280, height: 720, availLeft: left, availTop: 0, availWidth: 1280, availHeight: 720,
      isPrimary: isInternal, isInternal, devicePixelRatio: 1,
    });
    const laptop = make("Built-in Display", 0, true);
    const projector = make("Projector", 1280, false);
    Object.defineProperty(window.screen, "isExtended", { get: () => extended, configurable: true });
    (window as unknown as { getScreenDetails: unknown }).getScreenDetails = () =>
      Promise.resolve({ screens: extended ? [laptop, projector] : [laptop], currentScreen: laptop });
    const real = Element.prototype.requestFullscreen;
    Element.prototype.requestFullscreen = function (options?: FullscreenOptions) {
      (window as unknown as { __askedScreen?: string }).__askedScreen = (options as { screen?: { label: string } } | undefined)?.screen?.label;
      // Already full screen: this is a move to another screen, which the fake screens can't perform.
      if (document.fullscreenElement === this) return Promise.resolve();
      return real.call(this, { navigationUI: "hide" });
    };
    const moves: number[][] = ((window as unknown as { __moves: number[][] }).__moves = []);
    window.moveTo = (x: number, y: number) => void moves.push([x, y]);
  }, extended);
}

async function startTwoScreens(context: BrowserContext, open: (page: Page) => Promise<void>): Promise<{ main: Page; presenter: Page }> {
  const main = await context.newPage();
  await main.goto("./");
  await open(main);
  await expect(main.locator("#ready")).toBeVisible();
  await expect(main.locator("#both")).toBeEnabled();

  // First click asks for the screens (the permission prompt uses up the click); second click starts.
  await main.locator("#both").click();
  await expect(main.locator("#status")).toHaveText("Screens found. Check the choice above, then click Both views again.");
  await expect(main.locator("#screens label")).toHaveCount(2);
  await expect(main.locator('#screens input[value="1"]')).toBeChecked(); // the projector is the default for slides
  const [presenter] = await Promise.all([context.waitForEvent("page"), main.locator("#both").click()]);
  await expect(presenter.locator("#console")).toBeVisible({ timeout: 15_000 });
  return { main, presenter };
}

const byCode = async (page: Page): Promise<void> => {
  await page.locator("#code").fill(CODE);
  await page.locator("#code").press("Enter");
};

test("two screens: the presenter view in a second window drives the audience window", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await fakeTwoScreens(context);
  const { main, presenter } = await startTwoScreens(context, byCode);
  const problems: string[] = [];
  presenter.on("console", (m) => {
    if (m.type() === "error") problems.push(m.text());
  });
  const view = <T>(pick: (h: { layout(): string; kind(): string; shownPage(): number | null; hits(): { page: number }[] }) => T): Promise<T> =>
    presenter.evaluate((src) => (0, eval)(`(${src})`)((window as unknown as { __console: unknown }).__console) as T, pick.toString());

  expect(await main.evaluate(() => (window as unknown as { __askedScreen?: string }).__askedScreen)).toBe("Projector");
  expect(presenter.url()).toMatch(/\/talks\/#ch=[0-9a-f]{32}$/);
  await expect.poll(() => roomPage(main)).toBe(0);
  // The audience window still shows nothing but slides.
  await expect(main.locator("#audience > :not(canvas)")).toBeHidden();

  // The same presenter view as on any other device, here joined without a code or the relay.
  expect(await view((h) => h.kind())).toBe("local");
  expect(await view((h) => h.layout())).toBe("wide");
  await expect(presenter.locator("#bar-where")).toHaveText("Frame 1/7");
  await expect(presenter.locator("#timer")).toHaveText(/^(30:00|29:\d\d) ↓$/);
  await expect(presenter.locator("#link")).toHaveText("Slides on the other screen");
  await expect(presenter.locator("#entry")).toBeHidden();

  // Keys in the presenter window move the audience.
  await presenter.keyboard.press("ArrowRight");
  await expect.poll(() => roomPage(main)).toBe(1);
  await expect(presenter.locator("#bar-where")).toHaveText("Frame 2/7");
  await expect(presenter.locator("#notes")).toContainText("Sidecar note for frame 2");
  await presenter.keyboard.press("PageDown");
  await expect(presenter.locator("#bar-where")).toHaveText("Frame 3/7 · 1/3");
  await expect.poll(() => view((h) => h.shownPage())).toBe(2);
  if (process.env["LECTERN_SHOTS"]) await presenter.screenshot({ path: `${process.env["LECTERN_SHOTS"]}/presenter.png` });

  // Clicking the current slide advances; so does clicking the next-slide preview.
  await presenter.locator("#current").click({ position: { x: 300, y: 80 } });
  await expect.poll(() => roomPage(main)).toBe(3);
  await presenter.locator("#next-slide").click();
  await expect.poll(() => roomPage(main)).toBe(4);

  // Overview and search work as on any device (covered in depth in w3.spec.ts).
  await presenter.keyboard.press("Tab");
  await expect(presenter.locator("#grid .thumb")).toHaveCount(7);
  await presenter.locator("#grid .thumb").nth(4).click();
  await expect.poll(() => roomPage(main)).toBe(7);
  await presenter.locator("#search").fill("enduserslide");
  await expect(presenter.locator("#results .hit")).toHaveCount(1);
  await presenter.locator("#search").press("Escape");
  await presenter.locator("#search").press("Escape");
  await expect(presenter.locator("#next-slide")).toBeVisible();

  // Laser and Draw with the mouse.
  const box = (await presenter.locator("#current").boundingBox())!;
  await presenter.keyboard.press("l");
  await presenter.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await presenter.mouse.move(box.x + box.width / 2 + 30, box.y + box.height / 2 + 10, { steps: 4 });
  await expect.poll(() => room(main, (h) => h.pointerVisible())).toBe(true);
  await presenter.keyboard.press("d"); // Draw takes over from the laser
  await expect(presenter.locator("#t-laser")).not.toHaveClass(/on/);
  await expect(presenter.locator("#drawbar")).toBeVisible();
  const inkShown = () => main.evaluate(() => (window as unknown as { __lectern: { inkShown(): number } }).__lectern.inkShown());
  const before = await roomPage(main);
  await presenter.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.35);
  await presenter.mouse.down();
  await presenter.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.55, { steps: 10 });
  await presenter.mouse.up();
  await expect.poll(inkShown).toBe(1);
  expect(await roomPage(main)).toBe(before); // drawing never advances the slide
  await presenter.locator("#ink-board").click();
  await expect(presenter.locator("#pill")).toHaveText("WHITEBOARD");
  expect(await room(main, (h) => h.state().audienceMode.kind)).toBe("white");
  await presenter.locator("#ink-board").click();
  await presenter.keyboard.press("c");
  await expect.poll(inkShown).toBe(0);
  await presenter.keyboard.press("Escape"); // leaves Draw, does not start ending the talk
  await expect(presenter.locator("#drawbar")).toBeHidden();
  await expect(main.locator("#audience")).toBeVisible();

  // The timings panel lives here, never on the audience view.
  await presenter.keyboard.press("Control+Shift+D");
  await expect(presenter.locator("#debug")).toContainText("input → audience draw");
  await expect(presenter.locator("#debug")).toContainText("follows, wide");
  await presenter.keyboard.press("Control+Shift+D");

  // Swap displays: the button hands its click to the audience window, which moves its full screen
  // to the other screen; the presenter window moves the opposite way. Ctrl+D does the same.
  const asked = () => main.evaluate(() => (window as unknown as { __askedScreen?: string }).__askedScreen);
  await presenter.locator("#t-more").click();
  await expect(presenter.locator("#row-join")).toBeHidden(); // this window is not a device of its own
  await presenter.locator("#more-close").click();
  // Swap displays is always in view, at the bottom right, not under More.
  const swap = (await presenter.locator("#swap").boundingBox())!;
  expect(swap.x + swap.width).toBeGreaterThan(1280 - 40);
  expect(swap.y).toBeGreaterThan(720 - 80);
  await presenter.locator("#swap").click();
  await expect.poll(asked).toBe("Built-in Display");
  await expect.poll(() => presenter.evaluate(() => (window as unknown as { __moves: number[][] }).__moves.at(-1))).toEqual([1280, 0]);
  await presenter.keyboard.press("Control+d");
  await expect.poll(asked).toBe("Projector");
  await expect.poll(() => presenter.evaluate(() => (window as unknown as { __moves: number[][] }).__moves.at(-1))).toEqual([0, 0]);
  await expect(main.locator("#audience")).toBeVisible();

  // Keys in the audience window still work, and the presenter view follows.
  const where = await presenter.locator("#bar-where").textContent();
  await main.bringToFront();
  await main.keyboard.press("ArrowRight");
  await expect(presenter.locator("#bar-where")).not.toHaveText(where ?? "");

  // Nothing is stored on the room PC, by either window.
  expect(await presenter.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);

  // A window the browser placed stays a window, so Swap displays can move it: no Full screen button.
  await expect(presenter.locator("#fs")).toBeHidden();

  // Esc twice in the presenter window: it closes, and the first window is back at the choice of
  // views, still in the talk.
  await presenter.bringToFront();
  const closed = presenter.waitForEvent("close");
  await presenter.keyboard.press("Escape");
  await presenter.keyboard.press("Escape");
  await closed;
  await expect(main.locator("#ready")).toBeVisible();
  await expect(main.locator("#audience")).toBeHidden();
  // This screen has shown the slides, so the code is dots here now.
  await expect(main.locator("#join-code")).toHaveCount(0);
  expect(problems).toEqual([]);
  await context.close();
});

test("two screens plus a phone: three views of one talk; closing the second window does not stop it", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await fakeTwoScreens(context);
  const { main, presenter } = await startTwoScreens(context, byCode);

  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const phone = await phoneContext.newPage();
  await phone.goto(`./#c=${CODE}`);
  await phone.locator("#presenter").click();
  await expect(phone.locator("#link")).toContainText("Slides showing");
  await expect(presenter.locator("#link")).toHaveText("Slides on the other screen · 1 more device");
  await phone.locator("#next").click();
  await expect(presenter.locator("#bar-where")).toHaveText("Frame 2/7");
  // Ink drawn on the phone reaches the second window on the room PC too.
  await phone.locator("#t-draw").click();
  const slide = (await phone.locator("#current").boundingBox())!;
  await phone.mouse.move(slide.x + slide.width * 0.2, slide.y + slide.height * 0.4);
  await phone.mouse.down();
  await phone.mouse.move(slide.x + slide.width * 0.8, slide.y + slide.height * 0.6, { steps: 8 });
  await phone.mouse.up();
  await expect.poll(() => presenter.evaluate(() => (window as unknown as { __console: { ink(): { page: number } } }).__console.ink().page)).toBe(1);
  await phone.locator("#t-draw").click();

  await presenter.close();
  await main.bringToFront();
  await main.keyboard.press("ArrowRight");
  await expect.poll(() => roomPage(main)).toBe(2);
  await expect(main.locator("#audience")).toBeVisible();
  await phone.locator("#next").click();
  await expect.poll(() => roomPage(main)).toBe(3);

  await phoneContext.close();
  await context.close();
});

test("a Beamer notes-split deck: the audience gets the slide half, the presenter the notes half", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await fakeTwoScreens(context);
  const { main, presenter } = await startTwoScreens(context, async (page) => {
    await page.locator("#file").setInputFiles("fixtures/notes-right.pdf");
    await expect(page.locator("#split-text")).toHaveText("Beamer notes found on the right of each page: the audience will see only the slide part.");
    // Beamer's labels are not frame numbers in such decks, so each page is its own frame.
    await expect(page.locator("#deck-summary")).toHaveText("6 pages");
  });
  await expect.poll(() => roomPage(main)).toBe(0);

  // notes-right.pdf pages are 907×255: the 16:9 slide half exactly fills a 16:9 screen, with no bars.
  const audience = await main.locator("#audience canvas").first().evaluate((c: HTMLCanvasElement) => {
    const ctx = c.getContext("2d")!;
    const avg = (x: number, y: number, w: number, h: number) => {
      const d = ctx.getImageData(x, y, w, h).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) sum += d[i]! + d[i + 1]! + d[i + 2]!;
      return sum / (d.length / 4) / 3;
    };
    return { top: avg(0, 0, c.width, 6), bottom: avg(0, c.height - 6, c.width, 6) };
  });
  expect(audience.top).toBeGreaterThan(200);

  // The presenter's notes pane shows the notes half as an image, since this deck has no text notes.
  await expect(presenter.locator("#notes-image")).toBeVisible();
  await expect(presenter.locator("#notes")).toBeHidden();
  await expect(presenter.locator("#notes-image canvas")).toHaveCount(1);
  await expect(presenter.locator("#bar-where")).toHaveText("Frame 1/6");
  await context.close();
});

test("the notes split can be turned off before starting", async ({ page }) => {
  await page.goto("./");
  await page.locator("#file").setInputFiles("fixtures/notes-right.pdf");
  await expect(page.locator("#split-line")).toBeVisible();
  await page.locator("#split-toggle").click();
  await expect(page.locator("#split-text")).toHaveText("Showing whole pages, notes panel included.");
  await page.locator("#start").click();
  await expect.poll(() => roomPage(page)).toBe(0);
  // The whole 907×255 page on a 16:9 screen: wide black bars above and below.
  const top = await page.locator("#audience canvas").first().evaluate((c: HTMLCanvasElement) => {
    const d = c.getContext("2d")!.getImageData(0, 0, c.width, 6).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += d[i]! + d[i + 1]! + d[i + 2]!;
    return sum / (d.length / 4) / 3;
  });
  expect(top).toBeLessThan(5);
});

test("an ordinary deck shows no split line; mirrored displays get a one-line note and no two-screen mode", async ({ browser }) => {
  const context = await browser.newContext();
  await fakeTwoScreens(context, false);
  const page = await context.newPage();
  await page.goto("./");
  await page.locator("#file").setInputFiles("fixtures/overlays.pdf");
  await expect(page.locator("#ready")).toBeVisible();
  await expect(page.locator("#split-line")).toBeHidden();
  await expect(page.locator("#modes")).toBeHidden();
  await expect(page.locator("#both")).toBeDisabled();
  await expect(page.locator("#both-note")).toContainText("unavailable: it needs a second screen that extends this one");
  await context.close();
});

test("a browser that cannot place windows (Safari, Firefox): Both views opens two windows to place by hand", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await context.addInitScript(() => {
    delete (window as unknown as { getScreenDetails?: unknown }).getScreenDetails;
  });
  const main = await context.newPage();
  await main.goto("./");
  await byCode(main);
  await expect(main.locator("#ready")).toBeVisible();
  await expect(main.locator("#both")).toBeEnabled();
  await expect(main.locator("#both-note")).toContainText("in two windows");

  // One click: the presenter view opens in a second window, the slides start in this one.
  const [presenter] = await Promise.all([context.waitForEvent("page"), main.locator("#both").click()]);
  await expect(presenter.locator("#console")).toBeVisible({ timeout: 15_000 });
  await expect(main.locator("#audience")).toBeVisible();
  expect(await main.evaluate(() => document.fullscreenElement)).toBeNull(); // in its window, to be dragged across
  await expect(main.locator("#audience .fs-button")).toBeVisible(); // and it stays until used
  await main.waitForTimeout(2500);
  await expect(main.locator("#audience .fs-button")).toBeVisible();
  await expect(presenter.locator("#link")).toHaveText("Drag the slides window to the projector, then click Full screen on it.");
  await expect(presenter.locator("#swap")).toBeHidden(); // nothing to swap: the windows are placed by hand
  await expect(presenter.locator("#fs")).toBeVisible(); // this window can fill its screen, on a click

  await presenter.keyboard.press("ArrowRight");
  await expect.poll(() => roomPage(main)).toBe(1);
  await main.locator("#audience .fs-button").click();
  await expect.poll(() => main.evaluate(() => document.fullscreenElement?.id)).toBe("audience");
  await main.mouse.move(400, 300);
  await expect(main.locator("#audience .fs-button")).toBeHidden();

  // Esc twice on the slides: back to the choice, and the second window goes with them.
  const closed = presenter.waitForEvent("close");
  await main.keyboard.press("Escape");
  await main.keyboard.press("Escape");
  await expect(main.locator("#ready")).toBeVisible();
  await closed;
  await context.close();
});
