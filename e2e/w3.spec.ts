import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import type { Browser, Page } from "@playwright/test";
import { buildDeck } from "../tools/lib/build.ts";
import type { BuiltDeck } from "../tools/lib/build.ts";

// A room PC page and presenter views on other "devices" (pages at phone, tablet and laptop
// sizes), joined by code through the local relay (wrangler dev) with real encryption.
const CODE = "e2e-remote-code";
const DECKS = path.resolve(".e2e/d");
const SRC = path.resolve(".e2e/w3src");

interface RoomHook {
  state(): { committedPage: number; audienceMode: { kind: string }; timer: { runningSince: number | null; targetMs: number | null } };
  session(): string;
  role(): string;
  shownPage(): number | null | undefined;
  pointerVisible(): boolean;
  inkShown(): number;
  tool(): string;
}
interface ViewHook {
  taps(): number[];
  rtts(): number[];
  drop(): void;
  layout(): string;
  kind(): string;
  hosting(): boolean;
  shownPage(): number | null;
  ink(): { page: number; board: number };
  hits(): { page: number }[];
  dot(): boolean;
}
const roomHook = <T>(page: Page, pick: (h: RoomHook) => T): Promise<T> =>
  page.evaluate((src) => (0, eval)(`(${src})`)((window as unknown as { __lectern: RoomHook }).__lectern) as T, pick.toString());
const viewHook = <T>(page: Page, pick: (h: ViewHook) => T): Promise<T> =>
  page.evaluate((src) => (0, eval)(`(${src})`)((window as unknown as { __console: ViewHook }).__console) as T, pick.toString());
const roomPage = (page: Page) => page.evaluate(() => (window as unknown as { __lectern?: RoomHook }).__lectern?.shownPage());
const roomMode = (page: Page) => roomHook(page, (h) => h.state().audienceMode.kind);

function place(deck: BuiltDeck): void {
  const dir = path.join(DECKS, deck.deckId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, deck.fileName), deck.bin);
  writeFileSync(path.join(dir, "current.json"), deck.currentJson);
}

let deck: BuiltDeck;
test.beforeAll(async () => {
  // pdfpc-notes.pdf: 10 pages, 7 frames (frame 3 has 3 builds, frame 4 has 2), embedded notes,
  // and a .pdfpc file with more notes and a 30-minute duration.
  rmSync(SRC, { recursive: true, force: true });
  mkdirSync(SRC, { recursive: true });
  copyFileSync("fixtures/pdfpc-notes.pdf", path.join(SRC, "talk.pdf"));
  copyFileSync("fixtures/pdfpc-notes.pdfpc", path.join(SRC, "talk.pdfpc"));
  deck = await buildDeck(path.join(SRC, "talk.pdf"), CODE);
  place(deck);
});
test.afterAll(() => rmSync(path.resolve(".e2e"), { recursive: true, force: true }));

async function openRoom(browser: Browser, start = false): Promise<Page> {
  const room = await browser.newPage();
  await room.goto("./");
  await room.locator("#code").fill(CODE);
  await room.locator("#code").press("Enter");
  await expect(room.locator("#ready")).toBeVisible();
  if (start) {
    await room.locator("#start").click();
    await expect.poll(() => roomPage(room)).toBe(0);
  }
  return room;
}

const PHONE = { width: 390, height: 844 };
const LAPTOP = { width: 1280, height: 800 };

/** A presenter view on another device, joined by code. */
async function openView(browser: Browser, viewport = PHONE, remember = false): Promise<Page> {
  const context = await browser.newContext({ viewport, deviceScaleFactor: viewport.width < 700 ? 2 : 1 });
  const view = await context.newPage();
  await view.goto("./");
  await view.locator("#code").fill(CODE);
  if (remember) await view.locator("#remember").check();
  await view.locator("#open").click();
  await view.locator("#presenter").click();
  await expect(view.locator("#console")).toBeVisible();
  return view;
}

async function drag(page: Page, selector: string, from: [number, number], to: [number, number], holdMs = 0): Promise<void> {
  const box = (await page.locator(selector).boundingBox())!;
  await page.mouse.move(box.x + box.width * from[0], box.y + box.height * from[1]);
  await page.mouse.down();
  if (holdMs > 0) await page.waitForTimeout(holdMs);
  await page.mouse.move(box.x + box.width * to[0], box.y + box.height * to[1], { steps: 12 });
  await page.mouse.up();
}

test("a phone drives the room PC: steps, notes, clock, slide grid, back, black, white, end", async ({ browser }) => {
  const room = await openRoom(browser);
  await expect(room.locator("#phone-status")).toContainText("Other devices join with this code");

  const phone = await openView(browser, PHONE, true);
  const errors: string[] = [];
  phone.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  expect(await viewHook(phone, (h) => h.layout())).toBe("compact");
  // The room's computer has the talk open but is still choosing: no screen shows the slides yet.
  await expect(phone.locator("#link")).toHaveAttribute("aria-label", "No slides screen yet · 2 devices");

  await room.locator("#start").click();
  await expect.poll(() => roomPage(room)).toBe(0);
  await expect(phone.locator("#link")).toContainText("Slides showing");
  await expect(phone.locator("#frame-line")).toHaveText("Frame 1 / 7");
  // The .pdfpc file sets a 30-minute talk. The clock waits for the first slide change, then
  // shows the time left, in green.
  await expect(phone.locator("#timer")).toHaveText("30:00 ↓");
  await expect(phone.locator("#timer")).toHaveClass(/paused/);

  await phone.locator("#next").click();
  await expect.poll(() => roomPage(room)).toBe(1);
  await expect(phone.locator("#timer")).toHaveText(/^29:5\d ↓$/);
  await expect(phone.locator("#timer")).toHaveClass(/good/);
  await expect(phone.locator("#frame-line")).toHaveText("Frame 2 / 7");
  // Page 2 has an embedded note, overridden by the .pdfpc file's.
  await expect(phone.locator("#notes")).toContainText("Sidecar note for frame 2");
  await phone.locator("#next").click();
  await expect(phone.locator("#build-line")).toHaveText("Build 1/3");
  await expect(phone.locator("#notes")).not.toContainText("No notes for this slide");

  // The room keyboard and the phone stay in step: the room PC reports every change.
  await room.keyboard.press("ArrowRight");
  await expect(phone.locator("#build-line")).toHaveText("Build 2/3");
  await room.keyboard.press("ArrowRight");
  await expect(phone.locator("#notes")).toContainText("Sidecar note for build 3 of frame 3 only");
  await expect(phone.locator("#notes strong")).toHaveText("markdown");

  // Swipe left on the slide = next.
  await drag(phone, "#current", [0.8, 0.5], [0.3, 0.5]);
  await expect.poll(() => roomPage(room)).toBe(5);

  // Slides: picking one jumps at once (one behaviour everywhere); the grid stays open; Back undoes it.
  await phone.locator("#t-slides").click();
  await expect(phone.locator("#grid .thumb")).toHaveCount(7);
  await expect(phone.locator("#grid .thumb.current .cap span").first()).toHaveText("4");
  await phone.locator("#grid .thumb").nth(6).click();
  await expect.poll(() => roomPage(room)).toBe(9);
  await expect(phone.locator("#grid")).toBeVisible();
  await expect(phone.locator("#grid .thumb.current .cap span").first()).toHaveText("7");
  await phone.locator("#overview-close").click();
  await expect(phone.locator("#grid")).toBeHidden();
  await expect(phone.locator("#frame-line")).toHaveText("Frame 7 / 7");
  await expect(phone.locator("#t-back")).toBeEnabled();
  await phone.locator("#t-back").click();
  await expect.poll(() => roomPage(room)).toBe(5);

  // Black and white: the presenter's own slide goes black or white too, as the audience sees it.
  await phone.locator("#t-black").click();
  await expect.poll(() => roomMode(room)).toBe("black");
  await expect(phone.locator("#pill")).toHaveCount(0); // no pill: the lit button and the black slide say it
  await expect(phone.locator("#t-black")).toHaveClass(/on/);
  await phone.locator("#t-black").click();
  await expect.poll(() => roomMode(room)).toBe("live");
  await expect(phone.locator("#t-black")).not.toHaveClass(/on/);
  const centre = () =>
    phone.locator("#current canvas").evaluate((c: HTMLCanvasElement) => [...c.getContext("2d")!.getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data].slice(0, 3));
  await phone.locator("#t-white").click();
  await expect.poll(() => roomMode(room)).toBe("white");
  await expect(phone.locator("#t-white")).toHaveClass(/on/);
  await expect.poll(centre).toEqual([255, 255, 255]);
  await phone.locator("#t-black").click(); // straight from white to black
  await expect.poll(() => roomMode(room)).toBe("black");
  await expect.poll(centre).toEqual([0, 0, 0]);
  await phone.locator("#t-black").click();
  await expect.poll(() => roomMode(room)).toBe("live");
  await expect(phone.locator("#t-freeze")).toHaveCount(0); // freeze is gone
  await expect(phone.locator("#t-laser")).toBeVisible(); // and a phone has the laser button
  await phone.locator("#next").click();
  await expect(phone.locator("#build-line")).toHaveText("Build 2/2");
  await expect.poll(() => roomPage(room)).toBe(6);

  // Pointer: press and hold, then drag. It disappears from the room screen when the finger lifts.
  expect(await roomHook(room, (h) => h.pointerVisible())).toBe(false);
  const slide = (await phone.locator("#current").boundingBox())!;
  await phone.mouse.move(slide.x + slide.width / 2, slide.y + slide.height / 2);
  await phone.mouse.down();
  await phone.waitForTimeout(500);
  await phone.mouse.move(slide.x + slide.width * 0.6, slide.y + slide.height * 0.4, { steps: 5 });
  await expect.poll(() => roomHook(room, (h) => h.pointerVisible())).toBe(true);
  expect(await roomPage(room)).toBe(6); // a press-and-drag is not a swipe
  await phone.mouse.up();
  await expect.poll(() => roomHook(room, (h) => h.pointerVisible()), { timeout: 3000 }).toBe(false);

  // Clock: pause from the phone. A tap on the clock opens its own small pop-up, not all of More.
  await phone.locator("#timer").click();
  await expect(phone.locator("#clock-pop")).toBeVisible();
  await expect(phone.locator("#sheet-more")).toBeHidden();
  await phone.locator("#clock-toggle").click();
  await expect(phone.locator("#clock-toggle")).toHaveText("Resume");
  await expect(phone.locator("#timer")).toHaveClass(/paused/);
  expect(await roomHook(room, (h) => h.state().timer.runningSince)).toBeNull();
  // The clock's value sits beside its controls.
  await expect(phone.locator("#clock-now")).toHaveText(/^(30:00|29:\d\d) left$/);
  await expect(phone.locator("#clock-sub")).toHaveText(/^0:\d\d elapsed · paused$/);
  await phone.locator("#clock-toggle").click();

  // Count up, or down from a typed time (Native §6.2), applied as it is typed.
  await expect(phone.locator("#count-down")).toHaveClass(/on/);
  await expect(phone.locator("#count-from")).toHaveValue("30:00");
  await phone.locator("#count-up").click();
  await expect(phone.locator("#timer")).toHaveText(/^0:\d\d ↑$/);
  await expect(phone.locator("#clock-now")).toHaveText(/^0:\d\d$/);
  expect(await roomHook(room, (h) => h.state().timer.targetMs)).toBeNull();
  await phone.locator("#count-from").fill("nonsense");
  await phone.locator("#count-down").click();
  await expect(phone.locator("#count-hint")).toBeVisible();
  expect(await roomHook(room, (h) => h.state().timer.targetMs)).toBeNull();
  const before = await roomPage(room);
  await phone.locator("#count-from").fill("");
  await phone.locator("#count-from").pressSequentially("1h30"); // digits here are a time, not a frame number
  await expect(phone.locator("#count-hint")).toBeHidden();
  // Typing is only a draft: the clock is untouched until Set or Enter.
  await expect(phone.locator("#count-set")).toBeEnabled();
  await phone.waitForTimeout(300);
  expect(await roomHook(room, (h) => h.state().timer.targetMs)).toBeNull();
  await phone.locator("#count-set").click();
  await expect.poll(() => roomHook(room, (h) => h.state().timer.targetMs)).toBe(90 * 60_000);
  await phone.locator("#count-from").press("Enter");
  await expect(phone.locator("#clock-pop")).toBeHidden();
  await expect(phone.locator("#timer")).toHaveText(/^1:29:\d\d ↓$/);
  await expect(phone.locator("#timer")).toHaveClass(/good/);
  expect(await roomPage(room)).toBe(before);
  // Already past the end: red, and counting up.
  await phone.locator("#timer").click();
  await phone.locator("#count-from").fill("1s");
  await phone.locator("#count-set").click();
  await expect(phone.locator("#timer")).toHaveText(/^−0:\d\d ↓$/, { timeout: 8000 });
  await expect(phone.locator("#timer")).toHaveClass(/over/);
  await expect(phone.locator("#clock-now")).toHaveText(/^0:\d\d over$/);

  // A tap on the status line opens the talk's sheet: devices, joining, leaving, ending. The clock
  // is not in it. The measured numbers Ben reads off for the acceptance test are.
  await phone.keyboard.press("Escape");
  await expect(phone.locator("#clock-pop")).toBeHidden();
  await expect(phone.locator("#t-more")).toHaveCount(0);
  await phone.locator("#link").click();
  await expect(phone.locator("#sheet-more")).toBeVisible();
  await expect(phone.locator("#sheet-more #clock-toggle")).toHaveCount(0);
  await expect(phone.locator("#sheet-more")).not.toContainText("Whiteboard");
  await expect(phone.locator("#diag")).toHaveText(/ping \d+ ms · tap → slide \d+ ms \(median of \d+\)/);
  const numbers = await viewHook(phone, (h) => ({ taps: h.taps().map(Math.round), rtts: h.rtts().map(Math.round) }));
  console.log("local relay: command round trips ms", JSON.stringify(numbers.taps), "ping ms", JSON.stringify(numbers.rtts));

  // Remembered on the phone because the box was ticked; nothing is ever stored on the room PC.
  expect(await phone.evaluate(() => localStorage.getItem("lectern.savedTalks"))).toContain(CODE);
  expect(await room.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);

  // The sheet is about the connection only: the code, where to join, the numbers.
  await expect(phone.locator("#sheet-more")).toContainText("Connection settings");
  await expect(phone.locator("#sheet-code")).toHaveText(CODE);
  await expect(phone.locator("#join-text")).toHaveText("localhost:5173/talks");
  // Who is in the talk, each with a dot.
  await expect(phone.locator("#devices .device")).toHaveCount(2);
  await expect(phone.locator("#devices .device").first()).toHaveText(/: showing the slides · runs the talk$/);
  await expect(phone.locator("#devices .device").first()).toHaveClass(/ok/);
  await expect(phone.locator("#devices .device").nth(1)).toHaveText(/: presenter view/);
  for (const id of ["end-talk", "leave", "change-view", "keys-show"]) await expect(phone.locator(`#${id}`)).toHaveCount(0);
  await phone.locator("#more-close").click();

  // Exit goes back to the page where a view is chosen; leaving and ending are there. End talk
  // asks first, in the middle of the screen, and Enter never confirms it.
  await phone.locator("#exit").click();
  await expect(phone.locator("#ready")).toBeVisible();
  await expect(room.locator("#audience")).toBeVisible(); // the talk goes on
  await phone.locator("#end-all").click();
  await expect(phone.locator("#end-confirm")).toBeVisible();
  await phone.keyboard.press("Enter");
  await expect(room.locator("#audience")).toBeVisible();
  await phone.locator("#end-all").click();
  await phone.locator("#end-yes").click();
  await expect(room.locator("#code")).toBeVisible();
  await expect(room.locator("#audience")).toBeHidden();
  await expect(phone.locator("#code")).toBeVisible(); // End talk ends it on every device

  expect(errors).toEqual([]);
  await phone.context().close();
  await room.close();
});

test("a laptop joined by code gets the full presenter view and drives the room PC", async ({ browser }) => {
  const room = await openRoom(browser, true);
  const laptop = await openView(browser, LAPTOP);
  const errors: string[] = [];
  laptop.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await expect(laptop.locator("#link")).toContainText("Slides showing");

  // Wide layout: slide, next slide and notes side by side; no big buttons with a mouse.
  expect(await viewHook(laptop, (h) => h.layout())).toBe("wide");
  await expect(laptop.locator("#bar-where")).toHaveText("Frame 1 / 7");
  await expect(laptop.locator("#steps")).toBeHidden();
  await expect(laptop.locator("#next-slide")).toBeVisible();
  const current = (await laptop.locator("#current").boundingBox())!;
  const nextSlide = (await laptop.locator("#next-slide").boundingBox())!;
  expect(nextSlide.x).toBeGreaterThan(current.x + current.width); // beside it, not below
  expect(current.width).toBeGreaterThan(600);

  // Keys, as on the room PC.
  await laptop.keyboard.press("ArrowRight");
  await expect.poll(() => roomPage(room)).toBe(1);
  await laptop.keyboard.press("PageDown");
  await expect(laptop.locator("#bar-where")).toHaveText("Frame 3 / 7 Build 1/3");
  await expect(laptop.locator("#notes")).toContainText("every build");
  // A click on the current slide advances; so does a click on the next slide.
  await laptop.locator("#current").click({ position: { x: 300, y: 100 } });
  await expect.poll(() => roomPage(room)).toBe(3);
  await laptop.locator("#next-slide").click();
  await expect.poll(() => roomPage(room)).toBe(4);

  // The native app's arrangement: the status bar along the bottom with the clock in the middle,
  // "Current" over the slide, the tools directly under it and exactly as wide.
  const slideBox = (await laptop.locator("#current").boundingBox())!;
  const toolsBox = (await laptop.locator("#tools").boundingBox())!;
  const barBox = (await laptop.locator(".bar").boundingBox())!;
  const clockBox = (await laptop.locator("#timer").boundingBox())!;
  const nextHead = (await laptop.locator(".nexthead").boundingBox())!;
  const currentHead = (await laptop.locator(".current-head").boundingBox())!;
  expect(barBox.y).toBeGreaterThan(toolsBox.y + toolsBox.height - 1);
  expect(barBox.y + barBox.height).toBeGreaterThan(800 - 20);
  expect(Math.abs(toolsBox.y - (slideBox.y + slideBox.height))).toBeLessThan(12);
  expect(Math.abs(toolsBox.width - slideBox.width)).toBeLessThan(2);
  expect(Math.abs(slideBox.width / slideBox.height - 16 / 9)).toBeLessThan(0.03); // fitted: no black bars
  expect(Math.abs(currentHead.y - nextHead.y)).toBeLessThan(2);
  const middle = clockBox.x + clockBox.width / 2;
  expect(middle).toBeGreaterThan(1280 * 0.4);
  expect(middle).toBeLessThan(1280 * 0.6);
  await expect(laptop.locator("#bar-frame")).toHaveText("Frame 3 / 7");
  await expect(laptop.locator("#t-back")).toBeHidden(); // nowhere to go back to yet
  await expect(laptop.locator("#t-laser kbd")).toHaveText("L");
  // Both dividers drag, and are easy to catch: the grab area reaches well past the line.
  const pageBeforeDrag = await roomPage(room);
  const gripV = (await laptop.locator("#divider").boundingBox())!;
  await laptop.mouse.move(gripV.x - 6, gripV.y + gripV.height / 2); // just left of the line, over the slide pane's edge
  await laptop.mouse.down();
  await laptop.mouse.move(gripV.x - 206, gripV.y + gripV.height / 2, { steps: 5 });
  await laptop.mouse.up();
  await expect.poll(async () => (await laptop.locator(".main").boundingBox())!.width).toBeLessThan(slideBox.width - 150);
  expect(await roomPage(room)).toBe(pageBeforeDrag); // and the grab did not click the slide
  const gripH = (await laptop.locator("#hdivider").boundingBox())!;
  const notesBefore = (await laptop.locator("#notes").boundingBox())!.height;
  await laptop.mouse.move(gripH.x + gripH.width / 2, gripH.y + gripH.height / 2);
  await laptop.mouse.down();
  await laptop.mouse.move(gripH.x + gripH.width / 2, gripH.y - 80, { steps: 5 });
  await laptop.mouse.up();
  await expect.poll(async () => (await laptop.locator("#notes").boundingBox())!.height).toBeGreaterThan(notesBefore + 60);
  // The page itself can't scroll.
  expect(await laptop.evaluate(() => [document.documentElement.scrollHeight - window.innerHeight, getComputedStyle(document.body).overflow])).toEqual([0, "hidden"]);
  // ? shows the shortcuts.
  await laptop.keyboard.press("?");
  await expect(laptop.locator("#info-title")).toHaveText("Keyboard shortcuts");
  await laptop.keyboard.press("Escape");
  await expect(laptop.locator("#info")).toBeHidden();

  // Jump by number; Back and Forward appear after a jump and name where they go.
  await laptop.keyboard.type("6");
  await expect(laptop.locator("#digits")).toContainText("Go to frame 6");
  await laptop.keyboard.press("Enter");
  await expect.poll(() => roomPage(room)).toBe(8);
  await expect(laptop.locator("#t-back")).toHaveText("←3.3"); // an arrow, then frame.build
  await expect(laptop.locator("#t-back")).toHaveAttribute("aria-label", "Back to Frame 3");
  if (process.env["LECTERN_SHOTS"]) await laptop.screenshot({ path: `${process.env["LECTERN_SHOTS"]}/back.png` });
  await expect(laptop.locator("#t-back")).toHaveAttribute("title", /Back to Frame 3/);
  await laptop.locator("#t-back").click();
  await expect.poll(() => roomPage(room)).toBe(4);
  await expect(laptop.locator("#t-forward")).toHaveAttribute("title", /Forward to Frame 6/);

  // Overview: its button sits above the next slide, top right, where the grid appears; Tab does
  // the same. The grid swaps in for the right column; a click jumps at once and the overview stays.
  await expect(laptop.locator("#t-slides")).toBeHidden();
  await laptop.locator("#side-slides").click();
  await expect(laptop.locator("#grid .thumb")).toHaveCount(7);
  await laptop.locator("#overview-close").click();
  await expect(laptop.locator("#next-slide")).toBeVisible();
  await laptop.keyboard.press("Tab");
  await expect(laptop.locator("#grid .thumb")).toHaveCount(7);
  await expect(laptop.locator("#next-slide")).toBeHidden();
  // The frame the talk is in lists its builds, the one on screen lit, and its thumbnail follows
  // it; every other frame shows fully built, with a count.
  const here = laptop.locator("#grid .thumb.current");
  await expect(here.locator(".label")).toHaveText("3");
  await expect(here.locator(".buildlist button")).toHaveCount(3);
  await expect(here.locator(".buildlist button.lit")).toHaveText("3");
  await expect(here).toHaveAttribute("data-page", "4");
  await here.locator(".buildlist button").first().click();
  await expect.poll(() => roomPage(room)).toBe(2);
  await expect(here.locator(".buildlist button.lit")).toHaveText("1");
  await expect(here).toHaveAttribute("data-page", "2");
  await expect(here).toHaveAttribute("data-drawn", "2");
  await expect(laptop.locator("#grid .thumb").nth(3).locator(".builds")).toHaveText("2 builds");
  await expect(laptop.locator("#grid .thumb").nth(3)).toHaveAttribute("data-page", "6");
  // Builds: every page is its own thumbnail.
  await laptop.locator("#ov-builds").click();
  await expect(laptop.locator("#grid .thumb")).toHaveCount(10);
  await expect(laptop.locator("#grid .thumb.current .builds")).toHaveText("1/3");
  await laptop.locator("#grid .thumb").nth(4).click();
  await expect.poll(() => roomPage(room)).toBe(4);
  await expect(laptop.locator("#grid .thumb.current .builds")).toHaveText("3/3");
  await laptop.locator("#ov-frames").click();
  await expect(laptop.locator("#grid .thumb")).toHaveCount(7);
  await expect(laptop.locator("#grid .thumb.current .buildlist button.lit")).toHaveText("3");
  await laptop.locator("#grid .thumb").nth(4).click();
  await expect.poll(() => roomPage(room)).toBe(7);
  await expect(laptop.locator("#grid .thumb.current .cap span").first()).toHaveText("5");
  await laptop.keyboard.press("ArrowLeft"); // keys keep their presenting meaning with the overview open
  await expect.poll(() => roomPage(room)).toBe(6);

  // F no longer freezes anything.
  await laptop.keyboard.press("f");
  await laptop.keyboard.press("ArrowRight");
  await expect.poll(() => roomPage(room)).toBe(7);
  await expect(laptop.locator("#grid .thumb.current .cap span").first()).toHaveText("5");

  // Search: results grouped by frame; Enter jumps; typing does not drive the slides.
  const before = await roomPage(room);
  await laptop.keyboard.press("Control+f"); // the overview's search, not the browser's
  await expect(laptop.locator("#search")).toBeFocused();
  await laptop.locator("#search").fill("enduserslide");
  await expect(laptop.locator("#results .hit")).toHaveCount(1);
  await expect(laptop.locator("#search-count")).toHaveText("1 match");
  await expect(laptop.locator("#results .hit .frame")).toHaveText("Frame 5");
  expect(await roomPage(room)).toBe(before);
  await laptop.locator("#search").fill("NOTES");
  await expect.poll(() => laptop.locator("#results .hit").count()).toBeGreaterThan(1);
  const target = await viewHook(laptop, (h) => h.hits()[1]!.page);
  await laptop.locator("#search").press("ArrowDown");
  await laptop.locator("#search").press("Enter");
  await expect.poll(() => roomPage(room)).toBe(target);
  // Esc clears the search, then closes the overview; neither counts towards ending the talk.
  await laptop.locator("#search").press("Escape");
  await expect(laptop.locator("#grid")).toBeVisible();
  await laptop.locator("#search").press("Escape");
  await expect(laptop.locator("#next-slide")).toBeVisible();
  await expect(room.locator("#audience")).toBeVisible();

  // Laser: L, then the mouse over the current slide puts the pointer on the room screen.
  await laptop.keyboard.press("l");
  await expect(laptop.locator("#t-laser")).toHaveClass(/on/);
  const box = (await laptop.locator("#current").boundingBox())!;
  await laptop.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await laptop.mouse.move(box.x + box.width / 2 + 30, box.y + box.height / 2 + 10, { steps: 4 });
  await expect.poll(() => roomHook(room, (h) => h.pointerVisible())).toBe(true);
  await laptop.keyboard.press("Escape"); // turns the laser off, does not start ending the talk
  await expect(laptop.locator("#t-laser")).not.toHaveClass(/on/);
  await expect.poll(() => roomHook(room, (h) => h.pointerVisible()), { timeout: 3000 }).toBe(false);

  // The timings panel shows the room PC's numbers, here on another device.
  await laptop.keyboard.press("Control+Shift+D");
  await expect(laptop.locator("#debug")).toContainText("input → audience draw");
  await expect(laptop.locator("#debug")).toContainText(/median \d/);
  await expect(laptop.locator("#debug")).toContainText("follows, wide");
  await laptop.locator("#debug-close").click();
  await expect(laptop.locator("#debug")).toBeHidden();

  // The outline takes the notes' place: the part the talk is in is lit, and a click jumps there.
  await expect(laptop.locator("#outline")).toBeHidden();
  await laptop.locator("#tab-outline").click();
  await expect(laptop.locator("#notes")).toBeHidden();
  await expect(laptop.locator("#outline .entry-row")).toHaveCount(3);
  await expect(laptop.locator("#outline .entry-row.current")).toHaveCount(1);
  const beforeJump = await roomPage(room);
  await laptop.locator("#outline .entry-row").first().click();
  await expect(laptop.locator("#outline .entry-row.current .title")).toHaveText("Main");
  await expect.poll(() => roomPage(room)).not.toBe(beforeJump); // the jump has reached the slides
  const sectionStart = await roomPage(room);
  await laptop.locator("#tab-notes").click();
  await expect(laptop.locator("#notes")).toBeVisible();
  // Where notes come from, in a pop-up; Enter or Esc closes it without touching the talk.
  await laptop.locator("#info-notes").click();
  await expect(laptop.locator("#info-body")).toContainText("\\pdfpcnote");
  await laptop.keyboard.press("Enter");
  await expect(laptop.locator("#info")).toBeHidden();
  expect(await roomPage(room)).toBe(sectionStart);

  // More: Close is the blue button and Enter presses it. The notes size and the old
  // "Slides for the audience" line are gone from it.
  await laptop.locator("#link").click();
  await expect(laptop.locator("#more-close")).toHaveClass(/primary/);
  await expect(laptop.locator("#sheet-more")).not.toContainText("Notes size");
  await expect(laptop.locator("#sheet-more")).not.toContainText("Slides for the audience");
  await laptop.keyboard.press("Enter");
  await expect(laptop.locator("#sheet-more")).toBeHidden();
  expect(await roomPage(room)).toBe(sectionStart);
  // Exit sits by the status line, at the bottom right.
  const exitBox = (await laptop.locator("#exit").boundingBox())!;
  expect(exitBox.x).toBeGreaterThan(1280 * 0.7);
  expect(exitBox.y).toBeGreaterThan(800 - 90);

  // The presenter view went full screen with the click that chose it. Out of full screen, a
  // button at the top offers the way back.
  expect(await laptop.evaluate(() => document.fullscreenElement?.id)).toBe("console");
  await expect(laptop.locator("#fs")).toBeHidden();
  await laptop.evaluate(() => document.exitFullscreen());
  await expect(laptop.locator("#fs")).toBeVisible();
  await laptop.locator("#fs").click();
  await expect.poll(() => laptop.evaluate(() => document.fullscreenElement?.id)).toBe("console");

  // Esc twice here goes back to the choice of views, as on the slides. The talk goes on.
  await laptop.keyboard.press("Escape");
  await laptop.keyboard.press("Escape");
  await expect(laptop.locator("#ready")).toBeVisible();
  await expect(laptop.locator("#console")).toBeHidden();
  await expect.poll(() => laptop.evaluate(() => document.fullscreenElement === null)).toBe(true);
  await expect(room.locator("#audience")).toBeVisible();
  expect(await roomPage(room)).toBe(sectionStart);
  await laptop.locator("#presenter").click();
  await expect(laptop.locator("#link")).toContainText("Slides showing");
  expect(errors).toEqual([]);
  await laptop.context().close();
  await room.close();
});

test("several presenter views at once: each drives, all stay in step, and ink reaches every one", async ({ browser }) => {
  const room = await openRoom(browser, true);
  const laptop = await openView(browser, LAPTOP);
  const phone = await openView(browser, PHONE);
  await expect(laptop.locator("#link")).toContainText("Slides showing");
  await expect(phone.locator("#link")).toContainText("Slides showing");

  await phone.locator("#next").click();
  await expect(laptop.locator("#bar-where")).toHaveText("Frame 2 / 7");
  await laptop.keyboard.press("ArrowRight");
  await expect(phone.locator("#build-line")).toHaveText("Build 1/3");
  await expect.poll(() => roomPage(room)).toBe(2);

  // Both are listed, on either device.
  await laptop.keyboard.press("Control+Shift+D");
  await expect(laptop.locator("#debug")).toContainText(/devices \(host first\)\s+.+, .+/);
  await laptop.keyboard.press("Control+Shift+D");

  // Draw on the laptop with the mouse (D): the room screen shows it, and so does the phone.
  const ink = (page: Page) => viewHook(page, (h) => h.ink());
  await laptop.keyboard.press("d");
  await expect(laptop.locator("#drawbar")).toBeVisible();
  await drag(laptop, "#current", [0.3, 0.3], [0.7, 0.6]);
  await expect.poll(() => roomHook(room, (h) => h.inkShown())).toBe(1);
  await expect.poll(() => ink(phone)).toEqual({ page: 1, board: 0 });
  expect(await ink(laptop)).toEqual({ page: 1, board: 0 }); // not doubled by its own echo
  expect(await roomPage(room)).toBe(2); // drawing never advances the slide

  // Draw on the phone too; the laptop gets that stroke. Undo from the laptop removes the newest.
  await phone.locator("#t-draw").click();
  await phone.locator('.ink-color[data-color="1"]').click();
  await drag(phone, "#current", [0.2, 0.7], [0.8, 0.7]);
  await expect.poll(() => roomHook(room, (h) => h.inkShown())).toBe(2);
  await expect.poll(() => ink(laptop)).toEqual({ page: 2, board: 0 });
  await laptop.locator("#ink-undo").click();
  await expect.poll(() => roomHook(room, (h) => h.inkShown())).toBe(1);
  await expect.poll(() => ink(phone)).toEqual({ page: 1, board: 0 });

  // A view that joins late gets a full copy of the ink on screen.
  const tablet = await openView(browser, { width: 820, height: 1180 });
  expect(await viewHook(tablet, (h) => h.layout())).toBe("stacked");
  await expect(tablet.locator("#link")).toContainText("Slides showing");
  await expect.poll(() => ink(tablet)).toEqual({ page: 1, board: 0 });

  // The whiteboard, from the phone: every view shows it; its ink is kept apart from the slide's.
  await phone.locator("#t-white").click();
  await expect.poll(() => roomMode(room)).toBe("white");
  await expect(laptop.locator("#t-white")).toHaveClass(/on/);
  await drag(phone, "#current", [0.3, 0.3], [0.6, 0.3]);
  await expect.poll(() => ink(laptop)).toEqual({ page: 1, board: 1 });
  await expect.poll(() => ink(tablet)).toEqual({ page: 1, board: 1 });
  await phone.locator("#t-white").click();
  await expect.poll(() => roomHook(room, (h) => h.inkShown())).toBe(1);

  // C on the room keyboard clears the slide's ink everywhere; leaving the page would too.
  await room.keyboard.press("c");
  await expect.poll(() => roomHook(room, (h) => h.inkShown())).toBe(0);
  await expect.poll(() => ink(phone)).toEqual({ page: 0, board: 1 });
  await expect.poll(() => ink(laptop)).toEqual({ page: 0, board: 1 });
  await drag(phone, "#current", [0.2, 0.2], [0.4, 0.4]);
  await expect.poll(() => ink(tablet)).toEqual({ page: 1, board: 1 });
  await laptop.keyboard.press("Escape"); // leaves Draw on the laptop
  await laptop.keyboard.press("ArrowRight");
  await expect.poll(() => ink(tablet)).toEqual({ page: 0, board: 1 });
  await expect.poll(() => ink(phone)).toEqual({ page: 0, board: 1 });

  // Draw off on the phone restores swiping.
  await phone.locator("#t-draw").click();
  await expect(phone.locator("#drawbar")).toBeHidden();
  const before = (await roomPage(room)) ?? 0;
  await drag(phone, "#current", [0.8, 0.5], [0.3, 0.5]);
  await expect.poll(() => roomPage(room)).toBe(before + 1);

  for (const view of [laptop, phone, tablet]) await view.context().close();
  await room.close();
});

test("ink on the room screen: colours, undo, the whiteboard", async ({ browser }) => {
  const room = await openRoom(browser, true);
  const phone = await openView(browser);
  await expect(phone.locator("#link")).toContainText("Slides showing");
  /** Count of painted pixels on the audience's ink layer, by colour. */
  const inkPixels = () =>
    room.evaluate(() => {
      const c = document.querySelector<HTMLCanvasElement>("#audience canvas.ink-layer");
      if (!c) return { red: 0, blue: 0, any: 0 };
      const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
      let red = 0, blue = 0, any = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3]! < 128) continue;
        any++;
        if (d[i]! > 180 && d[i + 2]! < 80) red++;
        if (d[i + 2]! > 180 && d[i]! < 80) blue++;
      }
      return { red, blue, any };
    });

  await phone.locator("#t-draw").click();
  await drag(phone, "#current", [0.2, 0.3], [0.8, 0.6]);
  await expect.poll(async () => (await inkPixels()).red).toBeGreaterThan(200);
  await phone.locator('.ink-color[data-color="1"]').click();
  await drag(phone, "#current", [0.2, 0.7], [0.8, 0.7]);
  await expect.poll(async () => (await inkPixels()).blue).toBeGreaterThan(100);
  await phone.locator("#ink-undo").click();
  await expect.poll(async () => (await inkPixels()).blue).toBe(0);
  // Leaving the page clears its ink.
  await phone.locator("#next").click();
  await expect.poll(async () => (await inkPixels()).any).toBe(0);
  // The board keeps its ink across a return to the slides.
  await phone.locator("#t-white").click();
  await drag(phone, "#current", [0.3, 0.3], [0.7, 0.3]);
  await expect.poll(async () => (await inkPixels()).blue).toBeGreaterThan(100);
  await phone.locator("#t-white").click();
  await expect.poll(async () => (await inkPixels()).any).toBe(0);
  await phone.locator("#next").click();
  await phone.locator("#t-white").click();
  await expect.poll(async () => (await inkPixels()).blue).toBeGreaterThan(100);
  await phone.locator("#ink-clear").click();
  await expect.poll(async () => (await inkPixels()).any).toBe(0);
  await phone.context().close();
  await room.close();
});

test("on a touch screen the Laser button makes a finger on the slide point, and never step", async ({ browser }) => {
  const room = await openRoom(browser, true);
  const context = await browser.newContext({ viewport: { width: 1180, height: 820 }, hasTouch: true });
  const pad = await context.newPage();
  await pad.goto("./");
  await pad.locator("#code").fill(CODE);
  await pad.locator("#open").click();
  await pad.locator("#presenter").click();
  await expect(pad.locator("#link")).toContainText("Slides showing");
  await pad.locator("#next").click();
  await expect.poll(() => roomPage(room)).toBe(1);

  const box = (await pad.locator("#current").boundingBox())!;
  const touch = await context.newCDPSession(pad);
  const at = (dx: number) => [{ x: Math.round(box.x + box.width / 2 + dx), y: Math.round(box.y + box.height / 2) }];
  // A tap on the current slide advances, as a click does.
  await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: at(0) });
  await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect.poll(() => roomPage(room)).toBe(2);

  await pad.locator("#t-laser").click();
  await expect(pad.locator("#t-laser")).toHaveClass(/on/);
  await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: at(0) });
  await expect.poll(() => roomHook(room, (h) => h.pointerVisible())).toBe(true); // at once, no press-and-hold
  // A long sideways drag would be a swipe to the next slide; with Laser on it only moves the dot.
  for (const dx of [-40, -90, -140, -190]) await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: at(dx) });
  await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect.poll(() => roomHook(room, (h) => h.pointerVisible()), { timeout: 3000 }).toBe(false);
  expect(await roomPage(room)).toBe(2);
  // The buttons still step while Laser is on.
  await pad.locator("#next").click();
  await expect.poll(() => roomPage(room)).toBe(3);
  // A paused clock shows plain bars, not the pause emoji; the empty-notes line follows A+.
  await pad.locator("#timer").click();
  await pad.locator("#clock-toggle").click();
  await expect(pad.locator("#timer .pause-mark")).toBeVisible();
  await expect(pad.locator("#timer")).not.toContainText("⏸");
  await context.close();
  await room.close();
});

test("slides shown on a touch screen are run by touch: tap, swipe either way, links, and a long press to leave", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1180, height: 820 }, hasTouch: true });
  const pad = await context.newPage();
  await pad.goto("./");
  await pad.locator("#file").setInputFiles("fixtures/links-appendix.pdf");
  await pad.locator("#start").click();
  await expect.poll(() => roomPage(pad)).toBe(0);
  const touch = await context.newCDPSession(pad);
  const at = (x: number, y: number) => [{ x: Math.round(x), y: Math.round(y) }];
  const tap = async (x: number, y: number) => {
    await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: at(x, y) });
    await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  };
  const swipe = async (from: number, to: number) => {
    await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: at(from, 400) });
    for (let i = 1; i <= 4; i++) await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: at(from + ((to - from) * i) / 4, 400) });
    await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  };
  await tap(900, 700); // a tap advances, once
  await expect.poll(() => roomPage(pad)).toBe(1);
  await pad.waitForTimeout(400);
  expect(await roomPage(pad)).toBe(1);
  await swipe(700, 400); // swipe left: forward
  await expect.poll(() => roomPage(pad)).toBe(2);
  await swipe(400, 700); // swipe right: back
  await expect.poll(() => roomPage(pad)).toBe(1);
  // A tap on a link follows it rather than stepping. Page 2 of this deck has internal links.
  const link = await pad.evaluate(() => {
    type Link = { rect: { x: number; y: number; width: number; height: number }; action: { kind: string; page?: number } };
    const hook = (window as unknown as { __lectern: { links(page: number): Link[] | undefined } }).__lectern;
    // Beamer's navigation bar sits in the bottom strip; take a link from the slide body.
    const found = (hook.links(1) ?? []).find((l) => l.action.kind === "goToPage" && (l.action.page ?? 0) > 2 && l.rect.y < 0.85);
    // The slide is 4:3, letterboxed in the window.
    const box = document.querySelector("#audience canvas")!.getBoundingClientRect();
    const w = Math.min(box.width, (box.height * 4) / 3);
    const h = Math.min(box.height, (box.width * 3) / 4);
    const left = box.left + (box.width - w) / 2;
    const top = box.top + (box.height - h) / 2;
    return found ? { x: left + (found.rect.x + found.rect.width / 2) * w, y: top + (found.rect.y + found.rect.height / 2) * h, to: found.action.page } : null;
  });
  if (link) {
    await tap(link.x, link.y);
    await expect.poll(() => roomPage(pad)).toBe(link.to);
  }
  expect(link).not.toBeNull();
  // A finger held still does nothing. Two quick taps bring up a bar like the presenter view's,
  // without stepping; a tap elsewhere puts it away, also without stepping.
  const here = await roomPage(pad);
  await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: at(600, 300) });
  await pad.waitForTimeout(1800);
  await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect(pad.locator("#audience")).toBeVisible();
  await expect(pad.locator(".aud-bar")).toBeHidden();
  await tap(600, 300);
  await tap(600, 300);
  await expect(pad.locator(".aud-bar")).toBeVisible();
  await expect(pad.locator(".aud-where")).toHaveText(/^Frame \d+ \/ 8/);
  await expect(pad.locator(".aud-clock")).toHaveText(/^\d+:\d\d/);
  await expect(pad.locator(".aud-link")).toContainText("Slides showing");
  await tap(600, 300);
  await expect(pad.locator(".aud-bar")).toBeHidden();
  await pad.waitForTimeout(400);
  expect(await roomPage(pad)).toBe(here);
  // Laser, from the bar: a finger that drags points, but a quick tap still advances and two
  // still bring the bar back, so the laser never traps the screen.
  await tap(600, 300);
  await tap(600, 300);
  await pad.locator(".aud-laser").tap();
  expect(await roomHook(pad, (h) => h.tool())).toBe("laser");
  await expect(pad.locator(".aud-bar")).toBeHidden({ timeout: 4000 });
  await tap(900, 700);
  await expect.poll(() => roomPage(pad)).toBe((here ?? 0) + 1);
  await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: at(500, 400) });
  for (const x of [540, 600, 680, 760]) await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: at(x, 400) });
  await expect.poll(() => roomHook(pad, (h) => h.pointerVisible())).toBe(true);
  await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await pad.waitForTimeout(400);
  expect(await roomPage(pad)).toBe((here ?? 0) + 1); // the drag was not a swipe
  await tap(600, 300);
  await tap(600, 300);
  await expect(pad.locator(".aud-bar")).toBeVisible();
  await pad.locator(".aud-exit").tap();
  await expect(pad.locator("#ready")).toBeVisible();
  await expect(pad.locator("#end-all")).toBeVisible();
  await context.close();
});

test("one device, one screen: the slides are run from the slides, with the presenter view's keys and tools", async ({ browser }) => {
  const page = await browser.newPage({ viewport: LAPTOP });
  await page.goto("./");
  await page.locator("#file").setInputFiles("fixtures/pdfpc-notes.pdf");
  await page.locator("#start").click();
  await expect.poll(() => roomPage(page)).toBe(0);
  const shots = process.env["LECTERN_SHOTS"];
  // Nothing is on the slides until asked for.
  await expect(page.locator(".aud-bar")).toBeHidden();
  await expect(page.locator(".aud-overlay")).toHaveCount(0);

  // A click on the slide advances; one on the black above it does not. Shift+arrows step by frame.
  await page.mouse.click(640, 300);
  await expect.poll(() => roomPage(page)).toBe(1);
  await page.mouse.click(640, 15);
  await page.waitForTimeout(200);
  expect(await roomPage(page)).toBe(1);
  await page.keyboard.press("Shift+ArrowRight");
  await expect.poll(() => roomPage(page)).toBe(2);

  // A number being typed is shown, then jumps; Backspace goes back, Ctrl+] forward again.
  await page.keyboard.type("6");
  await expect(page.locator(".aud-digits")).toHaveText("Go to frame 6 ⏎");
  await page.keyboard.press("Enter");
  await expect(page.locator(".aud-digits")).toBeHidden();
  await expect.poll(() => roomPage(page)).toBe(8);
  await page.keyboard.press("Backspace");
  await expect.poll(() => roomPage(page)).toBe(2);
  await page.keyboard.press("Control+]");
  await expect.poll(() => roomPage(page)).toBe(8);
  await page.keyboard.press("Backspace");
  await expect.poll(() => roomPage(page)).toBe(2);

  // ? shows the keys; any key puts them away.
  await page.keyboard.press("?");
  await expect(page.locator(".aud-help")).toContainText("Go to a frame");
  if (shots) await page.screenshot({ path: `${shots}/stage-help.png` });
  await page.keyboard.press("Escape");
  await expect(page.locator(".aud-help")).toHaveCount(0);

  // L: the mouse is a laser. A click still advances. Esc puts the laser down and does not count towards leaving.
  await page.keyboard.press("l");
  await page.mouse.move(500, 300);
  await page.mouse.move(520, 320);
  await expect.poll(() => roomHook(page, (h) => h.pointerVisible())).toBe(true);
  await page.keyboard.press("Escape");
  expect(await roomHook(page, (h) => h.tool())).toBe("none");
  await expect.poll(() => roomHook(page, (h) => h.pointerVisible()), { timeout: 3000 }).toBe(false);
  await page.waitForTimeout(1100); // past the Esc-twice window

  // D: the mouse draws, and a click no longer steps. C clears.
  await page.keyboard.press("d");
  await page.mouse.move(400, 300);
  await page.mouse.down();
  await page.mouse.move(500, 340, { steps: 5 });
  await page.mouse.move(600, 300, { steps: 5 });
  await page.mouse.up();
  await expect.poll(() => roomHook(page, (h) => h.inkShown())).toBe(1);
  expect(await roomPage(page)).toBe(2);
  // While the mouse moves, a small Menu button shows at the bottom left; it brings up the bar:
  // tools lit as in the presenter view, Forward after the jump.
  await page.mouse.move(640, 500);
  await expect(page.locator(".aud-menu")).toBeVisible();
  await page.locator(".aud-menu").click();
  await expect(page.locator(".aud-bar")).toBeVisible();
  await expect(page.locator(".aud-menu")).toBeHidden();
  await expect(page.locator(".aud-draw")).toHaveClass(/on/);
  await expect(page.locator(".aud-drawbar")).toBeVisible();
  await expect(page.locator(".aud-forward")).toHaveText("6 →");
  if (shots) await page.screenshot({ path: `${shots}/stage-bar.png` });
  await page.locator(".aud-drawbar .aud-tool", { hasText: "Undo" }).click();
  await expect.poll(() => roomHook(page, (h) => h.inkShown())).toBe(0);
  await page.locator(".aud-draw").click();
  expect(await roomHook(page, (h) => h.tool())).toBe("none");
  await page.locator(".aud-white").click();
  expect(await roomMode(page)).toBe("white");
  await page.keyboard.press("w");
  expect(await roomMode(page)).toBe("live");
  // Away from the bar, it goes by itself.
  await page.mouse.move(640, 300);
  await expect(page.locator(".aud-bar")).toBeHidden({ timeout: 4000 });

  // Tab: the overview over the slides, with the bar. A click on a frame goes there and closes it.
  await page.keyboard.press("Tab");
  await expect(page.locator(".aud-overview .thumb")).toHaveCount(7);
  await expect(page.locator(".aud-bar")).toBeVisible();
  await expect(page.locator(".aud-overview .thumb.current")).toHaveAttribute("data-frame", "2");
  if (shots) {
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${shots}/stage-overview.png` });
  }
  await page.locator('.aud-overview .thumb[data-frame="4"]').click();
  await expect(page.locator(".aud-overview")).toHaveCount(0);
  await expect.poll(() => roomPage(page)).toBe(7); // the fifth frame's first page
  // Tab again, and Esc closes it without leaving.
  await page.keyboard.press("Tab");
  await expect(page.locator(".aud-overview")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".aud-overview")).toHaveCount(0);
  await expect(page.locator("#audience")).toBeVisible();

  // Esc twice (a clicker's stop button, pressed twice) leaves the slides; F5 (its start button)
  // on the page where a view is chosen shows them again, on the same slide, without a reload.
  await page.waitForTimeout(1600);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(page.locator("#ready")).toBeVisible();
  await page.keyboard.press("F5");
  await expect(page.locator("#audience")).toBeVisible();
  await expect.poll(() => roomPage(page)).toBe(7);
  await page.close();
});

test("a laser moved on one device shows on every presenter view's current slide", async ({ browser }) => {
  const room = await openRoom(browser, true);
  const phone = await openView(browser);
  const laptop = await openView(browser, LAPTOP);
  await expect(laptop.locator("#link")).toContainText("Slides showing");
  // From the slides screen itself (L, then the mouse): both presenter views show the dot.
  await room.keyboard.press("l");
  await room.mouse.move(500, 300);
  await room.mouse.move(540, 330);
  await expect.poll(() => viewHook(phone, (h) => h.dot())).toBe(true);
  await expect.poll(() => viewHook(laptop, (h) => h.dot())).toBe(true);
  await room.keyboard.press("l");
  await expect.poll(() => viewHook(phone, (h) => h.dot())).toBe(false);
  await expect.poll(() => viewHook(laptop, (h) => h.dot())).toBe(false);
  // From one presenter view: the slides and the other presenter view show it.
  await laptop.keyboard.press("l");
  const box = (await laptop.locator("#current").boundingBox())!;
  await laptop.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await laptop.mouse.move(box.x + box.width / 2 + 20, box.y + box.height / 2 + 10);
  await expect.poll(() => roomHook(room, (h) => h.pointerVisible())).toBe(true);
  await expect.poll(() => viewHook(phone, (h) => h.dot())).toBe(true);
  await laptop.keyboard.press("l");
  await expect.poll(() => viewHook(phone, (h) => h.dot())).toBe(false);
  await phone.context().close();
  await laptop.context().close();
  await room.close();
});

test("a phone held sideways shows two very large buttons that still drive the talk", async ({ browser }) => {
  const room = await openRoom(browser, true);
  const phone = await openView(browser);
  await expect(phone.locator("#link")).toContainText("Slides showing");

  await phone.evaluate(() => document.exitFullscreen()); // the test browser can't resize a full-screen window
  await phone.setViewportSize({ width: 844, height: 390 });
  await expect.poll(() => viewHook(phone, (h) => h.layout())).toBe("buttons");
  await expect(phone.locator("#current")).toBeHidden();
  await expect(phone.locator("#notes")).toBeHidden();
  await expect(phone.locator("#bar-where")).toHaveText("Frame 1 / 7");
  const next = (await phone.locator("#next").boundingBox())!;
  const prev = (await phone.locator("#prev").boundingBox())!;
  expect(next.height).toBeGreaterThan(200);
  expect(next.width).toBeGreaterThan(450);
  expect(prev.height).toBeGreaterThan(200);
  expect(prev.width).toBeGreaterThan(200);
  // Nothing spills off the screen.
  expect(next.y + next.height).toBeLessThanOrEqual(390);
  expect(next.x + next.width).toBeLessThanOrEqual(844);

  await phone.locator("#next").click();
  await phone.locator("#next").click();
  await expect.poll(() => roomPage(room)).toBe(2);
  await expect(phone.locator("#bar-where")).toHaveText("Frame 3 / 7 Build 1/3");
  await phone.locator("#prev").click();
  await expect.poll(() => roomPage(room)).toBe(1);
  if (process.env["LECTERN_SHOTS"]) await phone.screenshot({ path: `${process.env["LECTERN_SHOTS"]}/view-buttons.png` });

  // Turned upright again, the slide and notes come back on the right page.
  await phone.setViewportSize(PHONE);
  await expect(phone.locator("#current")).toBeVisible();
  await expect(phone.locator("#frame-line")).toHaveText("Frame 2 / 7");
  await expect.poll(() => viewHook(phone, (h) => h.shownPage())).toBe(1);
  await phone.context().close();
  await room.close();
});

test("the layout follows the window: phone, tablet upright, tablet on its side, laptop", async ({ browser }) => {
  const room = await openRoom(browser, true);
  const view = await openView(browser, PHONE);
  await expect(view.locator("#link")).toContainText("Slides showing");
  await view.evaluate(() => document.exitFullscreen()); // the test browser can't resize a full-screen window
  const shots = process.env["LECTERN_SHOTS"];
  for (const [width, height, layout] of [
    [390, 844, "compact"],
    [820, 1180, "stacked"],
    [1180, 820, "wide"],
    [1440, 900, "wide"],
    [844, 390, "buttons"],
  ] as const) {
    await view.setViewportSize({ width, height });
    await expect.poll(() => viewHook(view, (h) => h.layout())).toBe(layout);
    // Everything stays on screen: no pane hangs off the right or bottom edge.
    const overflow = await view.evaluate(() => ({ x: document.documentElement.scrollWidth - window.innerWidth, y: document.documentElement.scrollHeight - window.innerHeight }));
    expect(overflow).toEqual({ x: 0, y: 0 });
    // The Slides button is wherever the grid will open, and nowhere when there are no slides to show.
    await expect(view.locator("#t-slides")).toBeVisible({ visible: layout === "compact" || layout === "stacked" });
    await expect(view.locator("#side-slides")).toBeVisible({ visible: layout === "wide" });
    if (layout !== "buttons") {
      await expect(view.locator("#current")).toBeVisible();
      await expect(view.locator("#notes")).toBeVisible();
      const box = (await view.locator("#current").boundingBox())!;
      expect(box.width).toBeGreaterThan(width * 0.3);
      expect(box.height).toBeGreaterThan(120);
      await expect.poll(() => viewHook(view, (h) => h.shownPage())).toBe(0);
    }
    if (shots) {
      await view.waitForTimeout(300);
      await view.screenshot({ path: `${shots}/view-${layout}-${width}.png` });
    }
    // The clock's pop-up fits on every screen: where it is taller than the screen, it scrolls.
    await view.locator("#timer").click();
    const pop = (await view.locator("#clock-pop .pop-panel").boundingBox())!;
    expect(pop.y).toBeGreaterThanOrEqual(0);
    expect(pop.x).toBeGreaterThanOrEqual(0);
    expect(pop.y + pop.height).toBeLessThanOrEqual(height);
    expect(pop.x + pop.width).toBeLessThanOrEqual(width);
    if (shots) await view.screenshot({ path: `${shots}/clock-${layout}-${width}.png` });
    await view.keyboard.press("Escape");
    await expect(view.locator("#clock-pop")).toBeHidden();
  }
  await view.context().close();
  await room.close();
});

test("a talk nobody shows slides for is a rehearsal: devices join it, and a slides screen picks it up where it stands", async ({ browser }) => {
  // A laptop opens the talk first and takes the presenter view: the talk runs there.
  const laptop = await openView(browser, LAPTOP);
  await expect(laptop.locator("#link")).toHaveText("No slides screen yet");
  expect(await viewHook(laptop, (h) => h.hosting())).toBe(true);
  // The clock waits for the first slide change.
  await expect(laptop.locator("#timer")).toHaveText("30:00 ↓"); // the .pdfpc file's 30 minutes
  await laptop.locator("#timer").click();
  await expect(laptop.locator("#clock-sub")).toHaveText("0:00 elapsed · starts with the first slide change");
  await laptop.keyboard.press("Enter"); // closes the clock's pop-up
  await expect(laptop.locator("#clock-pop")).toBeHidden();
  await laptop.locator("#link").click();
  await expect(laptop.locator("#diag")).toHaveText("this device runs the talk");
  await laptop.locator("#more-close").click();
  await laptop.keyboard.press("ArrowRight");
  await laptop.keyboard.press("ArrowRight");
  await expect(laptop.locator("#bar-where")).toHaveText("Frame 3 / 7 Build 1/3");
  await expect(laptop.locator("#notes")).toContainText("every build");
  await expect(laptop.locator("#timer")).toHaveText(/^29:5\d ↓$/);
  // Ink, jumps and Back all work as they will in front of an audience.
  await laptop.keyboard.press("d");
  await drag(laptop, "#current", [0.3, 0.3], [0.6, 0.6]);
  await expect.poll(() => viewHook(laptop, (h) => h.ink())).toEqual({ page: 1, board: 0 });
  await laptop.keyboard.press("Escape");
  await laptop.keyboard.type("6");
  await laptop.keyboard.press("Enter");
  await expect(laptop.locator("#bar-where")).toHaveText("Frame 6 / 7");
  await laptop.locator("#t-back").click();
  await expect(laptop.locator("#bar-where")).toHaveText("Frame 3 / 7 Build 1/3");

  // A phone joins the rehearsal like any other talk, and drives it.
  const phone = await openView(browser);
  await expect(phone.locator("#link")).toHaveAttribute("aria-label", "No slides screen yet · 2 devices");
  await expect(phone.locator("#frame-line")).toHaveText("Frame 3 / 7");
  expect(await viewHook(phone, (h) => h.hosting())).toBe(false);
  await phone.locator("#next").click();
  await expect(laptop.locator("#bar-where")).toHaveText("Frame 3 / 7 Build 2/3");

  // The room's computer opens the talk: it is told one is going, and Show slides picks it up
  // exactly where it stands. From then on the slides screen runs the talk.
  const room = await openRoom(browser);
  await expect(room.locator("#talk-status")).toContainText("open on 2 other devices, at frame 3. No screen is showing the slides yet.");
  await room.locator("#start").click();
  await expect.poll(() => roomPage(room)).toBe(3);
  await expect.poll(() => roomHook(room, (h) => h.role())).toBe("host");
  expect(await roomHook(room, (h) => h.state().timer.runningSince)).not.toBeNull(); // the clock came along
  expect(await roomHook(room, (h) => h.state().timer.targetMs)).toBe(30 * 60_000);
  await expect(laptop.locator("#link")).toHaveText("Slides showing · 3 devices");
  await expect.poll(() => viewHook(laptop, (h) => h.hosting())).toBe(false);
  await phone.locator("#next").click();
  await expect.poll(() => roomPage(room)).toBe(4);
  await expect(laptop.locator("#bar-where")).toHaveText("Frame 3 / 7 Build 3/3");

  // Esc twice on the slides screen: back to its choice of views, still in the talk. The others
  // see that no screen is showing slides. One click and they are back.
  await room.keyboard.press("Escape");
  await room.keyboard.press("Escape");
  await expect(room.locator("#ready")).toBeVisible();
  await expect(laptop.locator("#link")).toHaveText("No slides screen yet · 3 devices");
  await room.locator("#start").click();
  await expect.poll(() => roomPage(room)).toBe(4);
  await expect(laptop.locator("#link")).toHaveText("Slides showing · 3 devices");

  // It leaves the talk: it is wiped, and the talk carries on without it.
  await room.keyboard.press("Escape");
  await room.keyboard.press("Escape");
  await room.locator("#another").click();
  await expect(room.locator("#code")).toBeVisible();
  await expect(laptop.locator("#link")).toHaveText("No slides screen yet · 2 devices", { timeout: 10_000 });
  await expect(laptop.locator("#bar-where")).toHaveText("Frame 3 / 7 Build 3/3");
  await laptop.keyboard.press("ArrowRight");
  await expect(phone.locator("#frame-line")).toHaveText("Frame 4 / 7");
  await laptop.context().close();
  await phone.context().close();
  await room.close();

});

test("a PDF opened on one device gets a code; a device that joins with it is sent the slides and can show them", async ({ browser }) => {
  // On the phone: a PDF that was never published.
  const context = await browser.newContext({ viewport: PHONE });
  const phone = await context.newPage();
  await phone.goto("./");
  await phone.locator("#file").setInputFiles("fixtures/overlays.pdf");
  await expect(phone.locator("#phone-status")).toContainText("Other devices join with this code");
  await expect(phone.locator("#code-line")).toContainText("Talk code:");
  await expect(phone.locator("#reveal-code")).toBeHidden(); // made here, so shown outright
  await expect(phone.locator("#preview canvas")).toHaveCount(1); // the first slide, so it is plain which deck this is
  const code = (await phone.locator("#join-code").textContent()) ?? "";
  expect(code).toMatch(/^[a-z]{3,}$/);
  await phone.locator("#presenter").click();
  await expect(phone.locator("#link")).toHaveAttribute("aria-label", `No slides screen yet · join with code ${code}`);
  await phone.locator("#next").click();
  await phone.locator("#next").click();
  await expect.poll(() => viewHook(phone, (h) => h.shownPage())).toBe(2);
  const frame = /Frame (\d+) \/ 9/.exec((await phone.locator("#frame-line").textContent()) ?? "")?.[1];
  await phone.locator("#link").click();
  await expect(phone.locator("#sheet-code")).toHaveText(code);
  await expect(phone.locator("#join-text")).toHaveText("localhost:5173/talks");
  await phone.locator("#more-close").click();

  // On the room's computer: the code, and nothing else. The slides arrive through the relay.
  const room = await browser.newPage();
  const frames: (string | Buffer)[] = [];
  room.on("websocket", (ws) => {
    if (ws.url().includes(":8787")) ws.on("framereceived", (f) => frames.push(f.payload));
  });
  await room.goto("./");
  await room.locator("#code").fill(code);
  await room.locator("#code").press("Enter");
  await expect(room.locator("#ready")).toBeVisible({ timeout: 15_000 });
  await expect(room.locator("#deck-title")).toHaveText(/.+/);
  await expect(room.locator("#deck-summary")).toHaveText("9 frames, 23 pages");
  await expect(room.locator("#talk-status")).toContainText(`open on 1 other device, at frame ${frame}`);
  // Not shown where it was typed, as that screen may be the projector: dots, until asked for.
  await expect(room.locator("#join-code")).toHaveCount(0);
  await expect(room.locator("#code-line")).toContainText("Talk code: ••••••");
  await room.locator("#reveal-code").click();
  await expect(room.locator("#join-code")).toHaveText(code);
  await room.locator("#reveal-code").click();
  await expect(room.locator("#join-code")).toHaveCount(0);
  // Only ciphertext crossed: no PDF header, in the clear or in base64.
  const wire = Buffer.concat(frames.map((f) => (typeof f === "string" ? Buffer.from(f) : f))).toString("latin1");
  expect(frames.length).toBeGreaterThan(1);
  expect(wire).not.toContain("%PDF");
  expect(wire).not.toContain("JVBERi");

  await room.locator("#start").click();
  await expect.poll(() => roomPage(room)).toBe(2);
  await expect(phone.locator("#link")).toHaveAttribute("aria-label", "Slides showing · 2 devices");
  await phone.locator("#next").click();
  await expect.poll(() => roomPage(room)).toBe(3);
  expect(await room.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);

  // A third device joins while the slides screen runs the talk: that one sends the slides.
  const laptop = await (await browser.newContext({ viewport: LAPTOP })).newPage();
  await laptop.goto("./");
  await laptop.locator("#code").fill(code);
  await laptop.locator("#code").press("Enter");
  await laptop.locator("#presenter").click();
  await expect(laptop.locator("#link")).toHaveText("Slides showing · 3 devices");
  await expect.poll(() => viewHook(laptop, (h) => h.shownPage())).toBe(3);

  // A code nobody is using says so, after a moment of looking.
  const stray = await browser.newPage();
  await stray.goto("./");
  await stray.locator("#code").fill("nobody-has-this");
  await stray.locator("#code").press("Enter");
  await expect(stray.locator("#status")).toHaveText("Looking for the talk on another device…");
  await expect(stray.locator("#status")).toHaveText("No talk found for that code.", { timeout: 10_000 });

  expect(await phone.evaluate(() => localStorage.getItem("lectern.savedTalks"))).toBeNull();
  await stray.close();
  await laptop.context().close();
  await room.close();
  await context.close();
});

test("each device chooses what it shows, and can change its mind without leaving the talk", async ({ browser }) => {
  const room = await openRoom(browser, true);
  const context = await browser.newContext({ viewport: LAPTOP });
  const page = await context.newPage();
  await page.goto("./");
  await page.locator("#code").fill(CODE);
  await page.locator("#code").press("Enter");
  await expect(page.locator("#talk-status")).toContainText("open on 1 other device, at frame 1. A screen is showing the slides.");
  await page.locator("#presenter").click();
  await expect(page.locator("#console")).toBeVisible();
  await expect(page.locator("#link")).toHaveText("Slides showing · 2 devices");
  expect(await page.evaluate(() => localStorage.length)).toBe(0); // not remembered unless asked
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => roomPage(room)).toBe(1);

  // Exit: back to the choice, still in the talk. This device then shows the slides too, as a
  // second screen following the first.
  await page.locator("#exit").click();
  await expect(page.locator("#ready")).toBeVisible();
  await expect(page.locator("#console")).toBeHidden();
  await page.locator("#start").click();
  await expect.poll(() => roomPage(page)).toBe(1);
  expect(await roomHook(page, (h) => h.role())).toBe("follower");
  await room.keyboard.press("ArrowRight");
  await expect.poll(() => roomPage(page)).toBe(2);
  await page.keyboard.press("ArrowRight"); // its keys drive the talk through the first screen
  await expect.poll(() => roomPage(room)).toBe(3);

  // A deck opened from a file is given a code of its own.
  const other = await context.newPage();
  await other.goto("./");
  await other.locator("#file").setInputFiles("fixtures/overlays.pdf");
  await expect(other.locator("#ready")).toBeVisible();
  await expect(other.locator("#join-code")).toBeVisible(); // a code made for this talk
  await context.close();
  await room.close();
});

test("the old /remote and /present addresses lead to the one page, and keep a code link", async ({ page }) => {
  await page.goto("remote/");
  await expect(page).toHaveURL(/\/talks\/$/);
  await expect(page.locator("#code")).toBeVisible();
  await page.goto("present/");
  await expect(page).toHaveURL(/\/talks\/$/);
  await expect(page.locator("#code")).toBeVisible();
  await page.goto(`present/#c=${CODE}`);
  await expect(page.locator("#ready")).toBeVisible();
  expect(page.url()).toBe("http://localhost:5173/talks/"); // the code is taken out of the address bar
});

test("relay refuses other origins, bad room ids and non-WebSocket requests", async ({ request }) => {
  const id = "0123456789abcdef0123456789abcdef";
  const upgrade = { Upgrade: "websocket", Connection: "Upgrade", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==" };
  const relay = "http://localhost:8787";

  expect(await (await request.get(`${relay}/health`)).text()).toBe("ok");
  expect((await request.get(`${relay}/room/${id}`)).status()).toBe(426);
  expect((await request.get(`${relay}/room/not-a-room`, { headers: upgrade })).status()).toBe(404);
  expect((await request.get(`${relay}/room/${id}`, { headers: { ...upgrade, Origin: "https://evil.example" } })).status()).toBe(403);
  expect((await request.get(`${relay}/room/${id}`, { headers: upgrade })).status()).toBe(403); // no Origin
});

test("only ciphertext crosses the relay", async ({ browser }) => {
  const room = await openRoom(browser);
  const context = await browser.newContext({ viewport: PHONE });
  const phone = await context.newPage();
  const frames: (string | Buffer)[] = [];
  phone.on("websocket", (ws) => {
    if (!ws.url().includes(":8787")) return; // not the dev server's own hot-reload socket
    ws.on("framesent", (f) => frames.push(f.payload));
    ws.on("framereceived", (f) => frames.push(f.payload));
  });
  await phone.goto("./");
  await phone.locator("#code").fill(CODE);
  await phone.locator("#open").click();
  await phone.locator("#presenter").click();
  await room.locator("#start").click();
  await expect(phone.locator("#link")).toContainText("Slides showing");
  await phone.locator("#next").click();
  await expect(phone.locator("#frame-line")).toHaveText("Frame 2 / 7");

  expect(frames.length).toBeGreaterThanOrEqual(4);
  const session = await roomHook(room, (h) => h.session());
  for (const frame of frames) {
    expect(typeof frame).not.toBe("string"); // binary frames only
    const text = (frame as Buffer).toString("latin1");
    for (const word of ["command", "state", "hello", "frameLabel", "deckPublished", session, CODE]) expect(text).not.toContain(word);
  }
  await context.close();
  await room.close();
});

test("a presenter view recovers by itself when the connection drops, and resyncs", async ({ browser }) => {
  const room = await openRoom(browser, true);
  const phone = await openView(browser);
  await expect(phone.locator("#link")).toContainText("Slides showing");
  await phone.locator("#next").click();
  await expect(phone.locator("#frame-line")).toHaveText("Frame 2 / 7");

  await viewHook(phone, (h) => h.drop());
  await expect(phone.locator("#link")).toHaveAttribute("aria-label", "Reconnecting…");
  // While the phone is away the room PC carries on from its keyboard.
  await room.keyboard.press("ArrowRight");
  await room.keyboard.press("ArrowRight");
  await expect.poll(() => roomPage(room)).toBe(3);

  // No one touches the phone: it reconnects (backoff starts at 0.5 s) and picks up the current state.
  await expect(phone.locator("#link")).toContainText("Slides showing", { timeout: 10_000 });
  await expect(phone.locator("#build-line")).toHaveText("Build 2/3");
  await phone.locator("#next").click();
  await expect.poll(() => roomPage(room)).toBe(4);

  await phone.context().close();
  await room.close();
});

test("when the slides screen leaves, the talk carries on; when it returns it picks the talk up, and old commands mean nothing", async ({ browser }) => {
  const room = await openRoom(browser, true);
  const phone = await openView(browser);
  await expect(phone.locator("#link")).toContainText("Slides showing");
  await phone.locator("#next").click();
  await expect.poll(() => roomPage(room)).toBe(1);
  const first = await roomHook(room, (h) => h.session());

  // The slides screen leaves the talk. The phone carries it on from where it was.
  await room.keyboard.press("Escape");
  await room.keyboard.press("Escape");
  await room.locator("#another").click();
  await expect(room.locator("#code")).toBeVisible();
  await expect(phone.locator("#link")).toHaveAttribute("aria-label", "No slides screen yet", { timeout: 10_000 });
  await expect(phone.locator("#frame-line")).toHaveText("Frame 2 / 7");
  await phone.locator("#next").click();
  await expect(phone.locator("#frame-line")).toHaveText("Frame 3 / 7");

  // It comes back: the talk is where the phone left it, under a new session id.
  await room.locator("#code").fill(CODE);
  await room.locator("#code").press("Enter");
  await room.locator("#start").click();
  await expect.poll(() => roomPage(room)).toBe(2);
  await expect.poll(() => roomHook(room, (h) => h.role())).toBe("host");
  const second = await roomHook(room, (h) => h.session());
  expect(second).not.toBe(first);
  await expect(phone.locator("#link")).toHaveAttribute("aria-label", "Slides showing · 2 devices");
  await phone.locator("#next").click();
  await expect.poll(() => roomPage(room)).toBe(3);
  await phone.context().close();
  await room.close();
});

test("the room PC keeps presenting when the relay is unreachable", async ({ browser }) => {
  const context = await browser.newContext();
  // No relay at all for this room PC.
  await context.routeWebSocket(/localhost:8787/, (ws) => ws.close());
  const room = await context.newPage();
  await room.goto("./");
  await room.locator("#code").fill(CODE);
  await room.locator("#code").press("Enter");
  await expect(room.locator("#ready")).toBeVisible();
  await expect(room.locator("#phone-status")).toHaveText("Not connected: other devices can't join right now.");
  await room.locator("#start").click();
  await expect.poll(() => roomPage(room)).toBe(0);
  await room.keyboard.press("PageDown");
  await expect.poll(() => roomPage(room)).toBe(1);
  await context.close();
});

test("a link opens the presenter view; a newer publish on the room PC offers a reload", async ({ browser }) => {
  const context = await browser.newContext({ viewport: PHONE });
  const phone = await context.newPage();
  await phone.goto(`./#c=${CODE}`);
  await phone.locator("#presenter").click();
  await expect(phone.locator("#console")).toBeVisible();
  expect(phone.url()).toBe("http://localhost:5173/talks/"); // the code is taken out of the address bar
  expect(await phone.evaluate(() => localStorage.length)).toBe(0); // not remembered unless asked

  // Ben republishes; the room PC opens the new copy while the phone still has the old one.
  const newer = await buildDeck(path.join(SRC, "talk.pdf"), CODE, new Date(Date.now() + 60_000));
  place(newer);
  try {
    const room = await openRoom(browser, true);
    await expect(phone.locator("#banner")).toBeVisible();
    await expect(phone.locator("#banner-text")).toHaveText("Slides updated — reload?");
    await phone.locator("#banner-action").click();
    await expect(phone.locator("#link")).toContainText("Slides showing");
    await expect(phone.locator("#banner")).toBeHidden();
    await room.close();
  } finally {
    place(deck);
  }
  await context.close();
});

test("a wrong code is refused, and a saved talk can be reopened and forgotten", async ({ browser }) => {
  const context = await browser.newContext({ viewport: PHONE });
  const phone = await context.newPage();
  await phone.goto("./");
  await phone.locator("#code").fill("definitely-wrong");
  await phone.locator("#open").click();
  await expect(phone.locator("#status")).toHaveText("No talk found for that code.");

  await phone.locator("#code").fill(CODE);
  await phone.locator("#remember").check();
  await phone.locator("#open").click();
  await phone.locator("#presenter").click();
  await expect(phone.locator("#console")).toBeVisible();
  await phone.locator("#exit").click();
  await phone.locator("#another").click();
  await expect(phone.locator("#saved .talk")).toHaveCount(1);
  await phone.locator("#saved .talk").click(); // one tap reopens it
  await phone.locator("#presenter").click();
  await expect(phone.locator("#console")).toBeVisible();
  await expect(phone.locator("#sheet-more")).toBeHidden(); // a fresh view, not the last one's leftovers
  await phone.locator("#exit").click();
  await phone.locator("#another").click();
  await phone.getByRole("button", { name: "Forget" }).click();
  await expect(phone.locator("#saved")).toBeHidden();
  expect(await phone.evaluate(() => localStorage.getItem("lectern.savedTalks"))).toBeNull();
  await context.close();
});
