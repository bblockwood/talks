import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import type { Browser, Page } from "@playwright/test";
import { buildDeck } from "../tools/lib/build.ts";
import type { BuiltDeck } from "../tools/lib/build.ts";

// Room PC page and phone page, talking through the local relay (wrangler dev) with real encryption.
const CODE = "e2e-remote-code";
const DECKS = path.resolve(".e2e/d");
const SRC = path.resolve(".e2e/w3src");

interface RoomHook {
  state(): { committedPage: number; audienceMode: { kind: string }; timer: { runningSince: number | null } };
  shownPage(): number | null | undefined;
  pointerVisible(): boolean;
}
interface RemoteHook {
  taps(): number[];
  rtts(): number[];
  dropConnection(): void;
}

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

const roomPage = (page: Page) => page.evaluate(() => (window as unknown as { __lectern?: RoomHook }).__lectern?.shownPage());
const roomMode = (page: Page) => page.evaluate(() => (window as unknown as { __lectern?: RoomHook }).__lectern?.state().audienceMode.kind);
const pointerOn = (page: Page) => page.evaluate(() => (window as unknown as { __lectern?: RoomHook }).__lectern?.pointerVisible());

async function openRoom(browser: Browser): Promise<Page> {
  const room = await browser.newPage();
  await room.goto("./");
  await room.locator("#code").fill(CODE);
  await room.locator("#code").press("Enter");
  await expect(room.locator("#ready")).toBeVisible();
  return room;
}

async function openPhone(browser: Browser, remember = false): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const phone = await context.newPage();
  await phone.goto("remote/");
  await phone.locator("#code").fill(CODE);
  if (remember) await phone.locator("#remember").check();
  await phone.locator("#open").click();
  await expect(phone.locator("#console")).toBeVisible();
  return phone;
}

test("the phone drives the room PC: steps, notes, clock, preview, back, black, pointer, end", async ({ browser }) => {
  const room = await openRoom(browser);
  await expect(room.locator("#phone-status")).toContainText("Phone can connect");

  const phone = await openPhone(browser, true);
  const phoneErrors: string[] = [];
  phone.on("console", (m) => {
    if (m.type() === "error") phoneErrors.push(m.text());
  });
  // The room PC has the deck open but has not started: the phone says so.
  await expect(phone.locator("#link")).toHaveText("Room PC is ready: click Start there");
  await expect(phone.locator("#next")).toBeDisabled();

  await room.locator("#start").click();
  await expect.poll(() => roomPage(room)).toBe(0);
  await expect(phone.locator("#link")).toContainText("Connected to room PC");
  await expect(phone.locator("#frame-line")).toHaveText("Frame 1 of 7");
  // The .pdfpc file sets a 30-minute talk: the clock shows the time left, in green.
  await expect(phone.locator("#timer")).toHaveText(/^0:0\d · (30:00|29:5\d)$/);
  await expect(phone.locator("#timer")).toHaveClass(/good/);

  // Next from the phone.
  await phone.locator("#next").click();
  await expect.poll(() => roomPage(room)).toBe(1);
  await expect(phone.locator("#frame-line")).toHaveText("Frame 2 of 7");
  // Page 2 has an embedded note, overridden by the .pdfpc file's.
  await expect(phone.locator("#notes")).toContainText("Sidecar note for frame 2");
  await phone.locator("#next").click();
  await expect(phone.locator("#build-line")).toHaveText("Build 1 of 3");
  await expect(phone.locator("#notes")).not.toContainText("Sidecar note for frame 2");
  await expect(phone.locator("#notes")).not.toContainText("No notes for this slide");

  // The room keyboard and the phone stay in step: the room PC reports every change.
  await room.keyboard.press("ArrowRight");
  await expect(phone.locator("#build-line")).toHaveText("Build 2 of 3");
  await room.keyboard.press("ArrowRight");
  await expect(phone.locator("#build-line")).toHaveText("Build 3 of 3");
  await expect(phone.locator("#notes")).toContainText("Sidecar note for build 3 of frame 3 only");
  await expect(phone.locator("#notes strong")).toHaveText("markdown");

  // Swipe left on the slide = next.
  const slide = (await phone.locator("#current").boundingBox())!;
  await phone.mouse.move(slide.x + slide.width * 0.8, slide.y + slide.height / 2);
  await phone.mouse.down();
  await phone.mouse.move(slide.x + slide.width * 0.3, slide.y + slide.height / 2, { steps: 4 });
  await phone.mouse.up();
  await expect.poll(() => roomPage(room)).toBe(5);

  // Private browse: a thumbnail tap previews on the phone only; Show commits it.
  await phone.locator("#t-slides").click();
  await expect(phone.locator("#grid .thumb")).toHaveCount(7);
  await expect(phone.locator("#grid .thumb.current .cap span").first()).toHaveText("4");
  await phone.locator("#grid .thumb").nth(6).click();
  await expect(phone.locator("#preview-badge")).toBeVisible();
  await expect(phone.locator("#frame-line")).toHaveText("Frame 7 of 7");
  await phone.waitForTimeout(400);
  expect(await roomPage(room)).toBe(5); // nothing happened on the room screen
  await phone.locator("#preview-show").click();
  await expect.poll(() => roomPage(room)).toBe(9);
  await expect(phone.locator("#preview-badge")).toBeHidden();

  // Back returns to where the jump started.
  await expect(phone.locator("#t-back")).toBeEnabled();
  await phone.locator("#t-back").click();
  await expect.poll(() => roomPage(room)).toBe(5);

  // Black and freeze.
  await phone.locator("#t-black").click();
  await expect.poll(() => roomMode(room)).toBe("black");
  await expect(phone.locator("#mode-badge")).toHaveText("ROOM SCREEN BLACK");
  await expect(phone.locator("#t-black")).toHaveClass(/on/);
  await phone.locator("#t-black").click();
  await expect.poll(() => roomMode(room)).toBe("live");
  await phone.locator("#t-freeze").click();
  await expect.poll(() => roomMode(room)).toBe("frozen");
  await expect(phone.locator("#mode-badge")).toHaveText("ROOM SCREEN FROZEN");
  await phone.locator("#next").click();
  await expect(phone.locator("#build-line")).toHaveText("Build 2 of 2"); // the presenter moved on
  expect(await roomPage(room)).toBe(5); // the audience still sees the frozen page
  await phone.locator("#t-freeze").click();
  await expect.poll(() => roomPage(room)).toBe(6);

  // Pointer: long-press, then drag. It disappears from the room screen when the finger lifts.
  expect(await pointerOn(room)).toBe(false);
  await phone.mouse.move(slide.x + slide.width / 2, slide.y + slide.height / 2);
  await phone.mouse.down();
  await phone.waitForTimeout(500);
  await phone.mouse.move(slide.x + slide.width * 0.6, slide.y + slide.height * 0.4, { steps: 5 });
  await expect.poll(() => pointerOn(room)).toBe(true);
  expect(await roomPage(room)).toBe(6); // a press-and-drag is not a swipe
  await phone.mouse.up();
  await expect.poll(() => pointerOn(room), { timeout: 3000 }).toBe(false);

  if (process.env["LECTERN_SHOTS"]) await phone.screenshot({ path: `${process.env["LECTERN_SHOTS"]}/phone.png` });

  // Clock: pause from the phone.
  await phone.locator("#timer").click();
  await phone.locator("#clock-toggle").click();
  await expect(phone.locator("#clock-toggle")).toHaveText("Resume");
  await expect(phone.locator("#timer")).toHaveClass(/paused/);
  expect(await room.evaluate(() => (window as unknown as { __lectern: RoomHook }).__lectern.state().timer.runningSince)).toBeNull();
  await phone.locator("#clock-toggle").click();

  // The measured numbers Ben reads off for the acceptance test.
  await expect(phone.locator("#diag")).toHaveText(/ping \d+ ms · tap → slide \d+ ms \(median of \d+\)/);
  const numbers = await phone.evaluate(() => {
    const h = (window as unknown as { __remote: RemoteHook }).__remote;
    return { taps: h.taps().map(Math.round), rtts: h.rtts().map(Math.round) };
  });
  console.log("local relay: command round trips ms", JSON.stringify(numbers.taps), "ping ms", JSON.stringify(numbers.rtts));

  // Remembered on the phone because the box was ticked; nothing is ever stored on the room PC.
  expect(await phone.evaluate(() => localStorage.getItem("lectern.savedTalks"))).toContain(CODE);
  expect(await room.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);

  // End talk, with a confirm.
  await phone.locator("#end-talk").click();
  await expect(phone.locator("#end-confirm")).toBeVisible();
  await phone.locator("#end-yes").click();
  await expect(room.locator("#code")).toBeVisible();
  await expect(room.locator("#audience")).toBeHidden();
  await expect(phone.locator("#link")).toHaveText("Waiting for the room PC", { timeout: 15_000 });

  expect(phoneErrors).toEqual([]);
  await phone.context().close();
  await room.close();
});

test("a phone held sideways shows two very large buttons that still drive the talk", async ({ browser }) => {
  const room = await openRoom(browser);
  await room.locator("#start").click();
  const phone = await openPhone(browser);
  await expect(phone.locator("#link")).toContainText("Connected to room PC");

  await phone.setViewportSize({ width: 844, height: 390 });
  await expect(phone.locator("#current")).toBeHidden();
  await expect(phone.locator("#notes")).toBeHidden();
  await expect(phone.locator("#bar-where")).toHaveText("Frame 1/7");
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
  await expect(phone.locator("#bar-where")).toHaveText("Frame 3/7 · 1/3");
  await phone.locator("#prev").click();
  await expect.poll(() => roomPage(room)).toBe(1);
  if (process.env["LECTERN_SHOTS"]) await phone.screenshot({ path: `${process.env["LECTERN_SHOTS"]}/phone-landscape.png` });

  // Turned upright again, the slide and notes come back on the right page.
  await phone.setViewportSize({ width: 390, height: 844 });
  await expect(phone.locator("#current")).toBeVisible();
  await expect(phone.locator("#frame-line")).toHaveText("Frame 2 of 7");
  await expect.poll(() => phone.evaluate(() => (window as unknown as { __remote: { shownPage(): number | null } }).__remote.shownPage())).toBe(1);
  await phone.context().close();
  await room.close();
});

test("drawing on the phone appears on the room screen; the white screen is a whiteboard", async ({ browser }) => {
  const room = await openRoom(browser);
  await room.locator("#start").click();
  const phone = await openPhone(browser);
  await expect(phone.locator("#link")).toContainText("Connected to room PC");

  const inkShown = () => room.evaluate(() => (window as unknown as { __lectern: { inkShown(): number } }).__lectern.inkShown());
  const local = () => phone.evaluate(() => (window as unknown as { __remote: { localInk(): { page: number; board: number } } }).__remote.localInk());
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
  const slide = (await phone.locator("#current").boundingBox())!;
  const draw = async (from: [number, number], to: [number, number]) => {
    await phone.mouse.move(slide.x + slide.width * from[0], slide.y + slide.height * from[1]);
    await phone.mouse.down();
    await phone.mouse.move(slide.x + slide.width * to[0], slide.y + slide.height * to[1], { steps: 12 });
    await phone.mouse.up();
  };

  await expect(phone.locator("#drawbar")).toBeHidden();
  await phone.locator("#t-draw").click();
  await expect(phone.locator("#drawbar")).toBeVisible();

  // A stroke in red: it is on the room screen, and it did not swipe to the next slide.
  await draw([0.2, 0.3], [0.8, 0.6]);
  await expect.poll(inkShown).toBe(1);
  expect((await inkPixels()).red).toBeGreaterThan(200);
  expect(await roomPage(room)).toBe(0);

  // A second stroke in blue, then Undo removes it.
  await phone.locator('.ink-color[data-color="1"]').click();
  await draw([0.2, 0.7], [0.8, 0.7]);
  await expect.poll(inkShown).toBe(2);
  expect((await inkPixels()).blue).toBeGreaterThan(100);
  await phone.locator("#ink-undo").click();
  await expect.poll(inkShown).toBe(1);
  expect((await inkPixels()).blue).toBe(0);
  expect(await local()).toEqual({ page: 1, board: 0 });

  // Leaving the page clears its ink, on the room screen and on the phone.
  await phone.locator("#next").click();
  await expect.poll(() => roomPage(room)).toBe(1);
  await expect.poll(inkShown).toBe(0);
  expect((await inkPixels()).any).toBe(0);
  await expect.poll(local).toEqual({ page: 0, board: 0 });

  // Board: the room screen goes white and takes ink.
  await phone.locator("#ink-board").click();
  await expect.poll(() => roomMode(room)).toBe("white");
  await expect(phone.locator("#mode-badge")).toHaveText("WHITEBOARD");
  await draw([0.3, 0.3], [0.7, 0.3]);
  await draw([0.3, 0.5], [0.7, 0.5]);
  await expect.poll(inkShown).toBe(2);
  expect((await inkPixels()).blue).toBeGreaterThan(200);

  // Back to the slides (no ink there), step on, and return: the board is as it was left.
  await phone.locator("#ink-board").click();
  await expect.poll(() => roomMode(room)).toBe("live");
  await expect.poll(inkShown).toBe(0);
  await phone.locator("#next").click();
  await phone.locator("#ink-board").click();
  await expect.poll(inkShown).toBe(2);
  expect(await local()).toEqual({ page: 0, board: 2 });

  // C on the room keyboard clears the board; the phone's copy follows.
  await room.keyboard.press("c");
  await expect.poll(inkShown).toBe(0);
  await expect.poll(local).toEqual({ page: 0, board: 0 });

  // Clear from the phone, and Draw off restores the normal gestures.
  await phone.locator("#ink-board").click();
  await draw([0.2, 0.2], [0.4, 0.4]);
  await expect.poll(inkShown).toBe(1);
  await phone.locator("#ink-clear").click();
  await expect.poll(inkShown).toBe(0);
  await phone.locator("#t-draw").click();
  await expect(phone.locator("#drawbar")).toBeHidden();
  const before = await roomPage(room);
  await draw([0.8, 0.5], [0.3, 0.5]); // now a swipe again
  await expect.poll(() => roomPage(room)).toBe((before ?? 0) + 1);

  await phone.context().close();
  await room.close();
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
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const phone = await context.newPage();
  const frames: (string | Buffer)[] = [];
  phone.on("websocket", (ws) => {
    if (!ws.url().includes(":8787")) return; // not the dev server's own hot-reload socket
    ws.on("framesent", (f) => frames.push(f.payload));
    ws.on("framereceived", (f) => frames.push(f.payload));
  });
  await phone.goto("remote/");
  await phone.locator("#code").fill(CODE);
  await phone.locator("#open").click();
  await room.locator("#start").click();
  await expect(phone.locator("#link")).toContainText("Connected to room PC");
  await phone.locator("#next").click();
  await expect(phone.locator("#frame-line")).toHaveText("Frame 2 of 7");

  expect(frames.length).toBeGreaterThanOrEqual(4);
  for (const frame of frames) {
    expect(typeof frame).not.toBe("string"); // binary frames only
    const text = (frame as Buffer).toString("latin1");
    for (const word of ["command", "state", "hello", "frameLabel", "deckPublished", CODE]) expect(text).not.toContain(word);
  }
  await context.close();
  await room.close();
});

test("the phone recovers by itself when the connection drops, and resyncs", async ({ browser }) => {
  const room = await openRoom(browser);
  await room.locator("#start").click();
  const phone = await openPhone(browser);
  await expect(phone.locator("#link")).toContainText("Connected to room PC");
  await phone.locator("#next").click();
  await expect(phone.locator("#frame-line")).toHaveText("Frame 2 of 7");

  await phone.evaluate(() => (window as unknown as { __remote: RemoteHook }).__remote.dropConnection());
  await expect(phone.locator("#link")).toHaveText("Reconnecting…");
  // While the phone is away the room PC carries on from its keyboard.
  await room.keyboard.press("ArrowRight");
  await room.keyboard.press("ArrowRight");
  await expect.poll(() => roomPage(room)).toBe(3);

  // No one touches the phone: it reconnects (backoff starts at 0.5 s) and picks up the current state.
  await expect(phone.locator("#link")).toContainText("Connected to room PC", { timeout: 10_000 });
  await expect(phone.locator("#build-line")).toHaveText("Build 2 of 3");
  await phone.locator("#next").click();
  await expect.poll(() => roomPage(room)).toBe(4);

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
  await expect(room.locator("#phone-status")).toHaveText("Phone unavailable: keyboard and clicker only");
  await room.locator("#start").click();
  await expect.poll(() => roomPage(room)).toBe(0);
  await room.keyboard.press("PageDown");
  await expect.poll(() => roomPage(room)).toBe(1);
  await context.close();
});

test("a link opens the remote; a newer publish on the room PC offers a reload", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const phone = await context.newPage();
  await phone.goto(`remote/#c=${CODE}`);
  await expect(phone.locator("#console")).toBeVisible();
  expect(phone.url()).toBe("http://localhost:5173/talks/remote/"); // the code is taken out of the address bar
  expect(await phone.evaluate(() => localStorage.length)).toBe(0); // not remembered unless asked

  // Ben republishes; the room PC opens the new copy while the phone still has the old one.
  const newer = await buildDeck(path.join(SRC, "talk.pdf"), CODE, new Date(Date.now() + 60_000));
  place(newer);
  try {
    const room = await openRoom(browser);
    await room.locator("#start").click();
    await expect(phone.locator("#banner")).toBeVisible();
    await expect(phone.locator("#banner-text")).toHaveText("Slides updated — reload?");
    await phone.locator("#banner-action").click();
    await expect(phone.locator("#link")).toContainText("Connected to room PC");
    await expect(phone.locator("#banner")).toBeHidden();
    await room.close();
  } finally {
    place(deck);
  }
  await context.close();
});

test("the phone refuses a wrong code and forgets a saved talk on request", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const phone = await context.newPage();
  await phone.goto("remote/");
  await phone.locator("#code").fill("definitely-wrong");
  await phone.locator("#open").click();
  await expect(phone.locator("#status")).toHaveText("No talk found for that code.");

  await phone.locator("#code").fill(CODE);
  await phone.locator("#remember").check();
  await phone.locator("#open").click();
  await expect(phone.locator("#console")).toBeVisible();
  await phone.locator("#t-more").click();
  await phone.locator("#leave").click();
  await expect(phone.locator("#saved .talk")).toHaveCount(1);
  await phone.locator("#saved .talk").click(); // one tap reopens it
  await expect(phone.locator("#console")).toBeVisible();
  await phone.locator("#t-more").click();
  await phone.locator("#leave").click();
  await phone.getByRole("button", { name: "Forget" }).click();
  await expect(phone.locator("#saved")).toBeHidden();
  expect(await phone.evaluate(() => localStorage.getItem("lectern.savedTalks"))).toBeNull();
  await context.close();
});
