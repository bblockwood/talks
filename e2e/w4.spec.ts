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
  await expect(main.locator("#modes")).toBeVisible();
  await main.locator("#mode-b").check();
  await expect(main.locator("#mode-b-panel")).toContainText("click Allow");

  // First click asks for the screens (the permission prompt uses up the click); second click starts.
  await main.locator("#start").click();
  await expect(main.locator("#status")).toHaveText("Screens found. Check the choice above, then click Start.");
  await expect(main.locator("#screens label")).toHaveCount(2);
  await expect(main.locator('#screens input[value="1"]')).toBeChecked(); // the projector is the default for slides
  const [presenter] = await Promise.all([context.waitForEvent("page"), main.locator("#start").click()]);
  await expect(presenter.locator("#app")).toBeVisible({ timeout: 15_000 });
  return { main, presenter };
}

const byCode = async (page: Page): Promise<void> => {
  await page.locator("#code").fill(CODE);
  await page.locator("#code").press("Enter");
};

test("two screens: the presenter window drives the audience window", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await fakeTwoScreens(context);
  const { main, presenter } = await startTwoScreens(context, byCode);
  const problems: string[] = [];
  presenter.on("console", (m) => {
    if (m.type() === "error") problems.push(m.text());
  });

  expect(await main.evaluate(() => (window as unknown as { __askedScreen?: string }).__askedScreen)).toBe("Projector");
  expect(presenter.url()).toMatch(/\/talks\/presenter\/#ch=[0-9a-f]{32}$/);
  await expect.poll(() => roomPage(main)).toBe(0);
  // The audience window still shows nothing but slides.
  expect(await main.locator("#audience > :not(canvas)").count()).toBe(0);

  // Layout: frame and build, notes, clock with the .pdfpc file's 30 minutes.
  await expect(presenter.locator("#where")).toHaveText("Frame 1 / 7");
  await expect(presenter.locator("#clock")).toHaveText(/^0:\d\d · (30:00|29:\d\d)$/);
  await expect(presenter.locator("#relay")).toHaveText("Phone: none connected");

  // Keys in the presenter window move the audience.
  await presenter.keyboard.press("ArrowRight");
  await expect.poll(() => roomPage(main)).toBe(1);
  await expect(presenter.locator("#where")).toHaveText("Frame 2 / 7");
  await expect(presenter.locator("#notes")).toContainText("Sidecar note for frame 2");
  await presenter.keyboard.press("PageDown");
  await expect(presenter.locator("#where")).toHaveText("Frame 3 / 7   Build 1/3");
  await expect.poll(() => presenter.evaluate(() => (window as unknown as { __presenter: { shownPage(): number | null } }).__presenter.shownPage())).toBe(2);

  if (process.env["LECTERN_SHOTS"]) await presenter.screenshot({ path: `${process.env["LECTERN_SHOTS"]}/presenter.png` });

  // Clicking the current slide advances; so does clicking the next-slide preview.
  await presenter.locator("#current").click({ position: { x: 300, y: 80 } });
  await expect.poll(() => roomPage(main)).toBe(3);
  await presenter.locator("#next").click();
  await expect.poll(() => roomPage(main)).toBe(4);

  // Jump by number, then the Back button names where it returns to.
  await presenter.keyboard.type("6");
  await expect(presenter.locator("#digits")).toContainText("Go to frame 6");
  await presenter.keyboard.press("Enter");
  await expect.poll(() => roomPage(main)).toBe(8);
  await expect(presenter.locator("#back")).toHaveText("Back to Frame 3");
  await presenter.locator("#back").click();
  await expect.poll(() => roomPage(main)).toBe(4);
  await expect(presenter.locator("#forward")).toHaveText("Forward to Frame 6");

  // Overview: Tab swaps the right column for the grid; a click jumps at once and the overview stays.
  await presenter.keyboard.press("Tab");
  await expect(presenter.locator("#grid .thumb")).toHaveCount(7);
  await expect(presenter.locator("#grid .thumb.current .cap span").first()).toHaveText("3");
  await expect(presenter.locator("#next")).toBeHidden();
  await presenter.locator("#grid .thumb").nth(4).click();
  await expect.poll(() => roomPage(main)).toBe(7);
  await expect(presenter.locator("#grid")).toBeVisible();
  await expect(presenter.locator("#grid .thumb.current .cap span").first()).toHaveText("5");
  // Keys keep their presenting meaning with the overview open.
  await presenter.keyboard.press("ArrowLeft");
  await expect.poll(() => roomPage(main)).toBe(6);

  // Frozen: the frame the audience sees is ringed separately from the presenter's.
  await presenter.keyboard.press("f");
  await expect(presenter.locator("#pill")).toHaveText("FROZEN");
  await presenter.keyboard.press("ArrowRight");
  await expect(presenter.locator("#grid .thumb.audience .cap span").first()).toHaveText("4");
  await expect(presenter.locator("#grid .thumb.current .cap span").first()).toHaveText("5");
  await presenter.keyboard.press("f");
  await expect(presenter.locator("#pill")).toBeHidden();

  if (process.env["LECTERN_SHOTS"]) await presenter.screenshot({ path: `${process.env["LECTERN_SHOTS"]}/presenter-overview.png` });

  // Search: results grouped by frame; Enter jumps to the selected one; typing does not drive slides.
  const before = await roomPage(main);
  await presenter.locator("#search").fill("enduserslide");
  await expect(presenter.locator("#results .hit")).toHaveCount(1);
  await expect(presenter.locator("#results .hit .frame")).toHaveText("Frame 5");
  expect(await roomPage(main)).toBe(before);
  await presenter.locator("#search").fill("zzzz");
  await expect(presenter.locator("#results")).toHaveText("No slides match.");
  await presenter.locator("#search").fill("NOTES");
  await expect.poll(() => presenter.locator("#results .hit").count()).toBeGreaterThan(1);
  const target = await presenter.evaluate(() => (window as unknown as { __presenter: { hits(): { page: number }[] } }).__presenter.hits()[1]!.page);
  await presenter.locator("#search").press("ArrowDown");
  await presenter.locator("#search").press("Enter");
  await expect.poll(() => roomPage(main)).toBe(target);
  // Esc clears the search, then closes the overview; neither counts towards ending the talk.
  await presenter.locator("#search").press("Escape");
  await expect(presenter.locator("#grid")).toBeVisible();
  await presenter.locator("#search").press("Escape");
  await expect(presenter.locator("#next")).toBeVisible();
  await expect(main.locator("#audience")).toBeVisible();

  // Laser: L, then the mouse over the current slide puts the pointer on the audience screen.
  expect(await room(main, (h) => h.pointerVisible())).toBe(false);
  await presenter.keyboard.press("l");
  await expect(presenter.locator("#laser")).toHaveClass(/on/);
  const box = (await presenter.locator("#current").boundingBox())!;
  await presenter.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await presenter.mouse.move(box.x + box.width / 2 + 30, box.y + box.height / 2 + 10, { steps: 4 });
  await expect.poll(() => room(main, (h) => h.pointerVisible())).toBe(true);
  await presenter.keyboard.press("Escape"); // turns the laser off, does not start ending the talk
  await expect(presenter.locator("#laser")).not.toHaveClass(/on/);
  await expect.poll(() => room(main, (h) => h.pointerVisible()), { timeout: 3000 }).toBe(false);

  // Black from the presenter keyboard; the pill shows only in that mode.
  await presenter.keyboard.press("b");
  await expect(presenter.locator("#pill")).toHaveText("BLACK");
  expect(await room(main, (h) => h.state().audienceMode.kind)).toBe("black");
  await presenter.keyboard.press("b");

  // The debug overlay lives here, never on the audience view.
  await expect(presenter.locator("#debug")).toBeHidden();
  await presenter.keyboard.press("Control+Shift+D");
  await expect(presenter.locator("#debug")).toContainText("input → audience draw");
  await expect(presenter.locator("#debug")).toContainText(/median \d/);
  await presenter.keyboard.press("Control+Shift+D");

  // Swap displays: the button hands its click to the audience window, which moves its full screen
  // to the other screen; the presenter window moves the opposite way. Ctrl+D does the same.
  const asked = () => main.evaluate(() => (window as unknown as { __askedScreen?: string }).__askedScreen);
  await presenter.locator("#swap").click();
  await expect.poll(asked).toBe("Built-in Display");
  await expect.poll(() => presenter.evaluate(() => (window as unknown as { __moves: number[][] }).__moves.at(-1))).toEqual([1280, 0]);
  await presenter.keyboard.press("Control+d");
  await expect.poll(asked).toBe("Projector");
  await expect.poll(() => presenter.evaluate(() => (window as unknown as { __moves: number[][] }).__moves.at(-1))).toEqual([0, 0]);
  await expect(main.locator("#audience")).toBeVisible();

  // Keys in the audience window still work, and the presenter view follows.
  const where = await presenter.locator("#where").textContent();
  await main.bringToFront();
  await main.keyboard.press("ArrowRight");
  await expect(presenter.locator("#where")).not.toHaveText(where ?? "");

  // Esc twice in the presenter window ends the talk: the window closes and the room PC is wiped.
  await presenter.bringToFront();
  const closed = presenter.waitForEvent("close");
  await presenter.keyboard.press("Escape");
  await presenter.keyboard.press("Escape");
  await closed;
  await expect(main.locator("#code")).toBeVisible();
  expect(problems).toEqual([]);
  await context.close();
});

test("two screens: a phone shows up on the presenter view; closing the presenter window does not stop the talk", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await fakeTwoScreens(context);
  const { main, presenter } = await startTwoScreens(context, byCode);

  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const phone = await phoneContext.newPage();
  await phone.goto(`remote/#c=${CODE}`);
  await expect(phone.locator("#link")).toContainText("Connected to room PC");
  await expect(presenter.locator("#relay")).toHaveText(/^Phone: \S+/);
  await phone.locator("#next").click();
  await expect(presenter.locator("#where")).toHaveText("Frame 2 / 7");

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
  await expect(presenter.locator("#where")).toHaveText("Frame 1 / 6");
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
  await expect(page.locator("#mirror-note")).toContainText("extend");
  await context.close();
});
