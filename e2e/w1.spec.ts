import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

interface Hook {
  state(): { committedPage: number; audienceMode: { kind: string; page?: number }; history: number[] };
  shownPage(): number | null | undefined;
  links(page: number): { rect: { x: number; y: number; width: number; height: number }; action: { kind: string; page?: number; action?: string } }[] | undefined;
}
declare global {
  interface Window {
    __lectern?: Hook;
  }
}

const committed = (page: Page) => page.evaluate(() => window.__lectern?.state().committedPage);
const shown = (page: Page) => page.evaluate(() => window.__lectern?.shownPage());

/** Average colour of the audience canvas's central region and of its left edge. */
const sample = (page: Page) =>
  page.locator("#audience canvas").evaluate((c: HTMLCanvasElement) => {
    const ctx = c.getContext("2d")!;
    const avg = (x: number, y: number, w: number, h: number) => {
      const d = ctx.getImageData(x, y, w, h).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) sum += d[i]! + d[i + 1]! + d[i + 2]!;
      return sum / (d.length / 4) / 3;
    };
    return {
      width: c.width,
      height: c.height,
      centre: avg(Math.floor(c.width * 0.3), Math.floor(c.height * 0.3), Math.floor(c.width * 0.4), Math.floor(c.height * 0.4)),
      leftEdge: avg(0, 0, 4, c.height),
    };
  });

async function open(page: Page, deck: string): Promise<void> {
  await page.goto("./");
  await page.getByRole("button", { name: deck }).click();
  await expect(page.locator("#ready")).toBeVisible();
}

async function start(page: Page): Promise<void> {
  await page.locator("#start").click();
  await expect(page.locator("#audience")).toBeVisible();
  await expect.poll(() => shown(page)).toBe(0);
}

test("presents a deck: builds, frames, jump by number, back", async ({ page }) => {
  const problems: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(m.text());
  });
  page.on("pageerror", (e) => problems.push(String(e)));
  const offsite: string[] = [];
  page.on("request", (r) => {
    const host = new URL(r.url()).host;
    if (host !== "localhost:5173") offsite.push(r.url());
  });

  await open(page, "Overlays (builds)");
  await expect(page.locator("#deck-summary")).toHaveText("9 frames, 23 pages");
  await start(page);

  // Full screen, entry screen gone, nothing to see but the canvas in the audience view.
  expect(await page.evaluate(() => document.fullscreenElement?.id)).toBe("audience");
  await expect(page.locator("#entry")).toBeHidden();
  expect(await page.locator("#audience > canvas").count()).toBe(1);
  await page.mouse.move(300, 300);
  await expect(page.locator("#audience .fs-button")).toBeHidden(); // only offered out of full screen

  // A 4:3 deck on a 16:9 screen: white slide in the middle, black pillarbox at the edge.
  const first = await sample(page);
  expect(first.centre).toBeGreaterThan(200);
  expect(first.leftEdge).toBeLessThan(5);

  await page.keyboard.press("PageDown");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Space");
  await expect.poll(() => shown(page)).toBe(3);
  await page.keyboard.press("PageUp");
  await expect.poll(() => shown(page)).toBe(2);

  // Frame 2 is pages 1–3. Shift+→ goes to the first build of frame 3; Shift+← back to the last build of frame 2.
  await page.keyboard.press("Shift+ArrowRight");
  await expect.poll(() => shown(page)).toBe(4);
  await page.keyboard.press("Shift+ArrowLeft");
  await expect.poll(() => shown(page)).toBe(3);

  // Jump to frame 8 (first page 17), show two builds, then Delete returns to where the jump started.
  await page.keyboard.type("8");
  await page.keyboard.press("Enter");
  await expect.poll(() => shown(page)).toBe(17);
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Delete");
  await expect.poll(() => shown(page)).toBe(3);

  // F5 (a clicker's "start slideshow") must not reload and lose the talk.
  await page.keyboard.press("F5");
  await page.waitForTimeout(300);
  expect(await committed(page)).toBe(3);

  expect(problems).toEqual([]);
  expect(offsite).toEqual([]);
});

test("black, white and freeze", async ({ page }) => {
  await open(page, "Basic 16:9");
  await start(page);

  await page.keyboard.press("b");
  await expect.poll(async () => (await sample(page)).centre).toBeLessThan(1);
  await page.keyboard.press("w");
  await expect.poll(async () => (await sample(page)).leftEdge).toBeGreaterThan(254);
  await page.keyboard.press("w");
  await expect.poll(() => shown(page)).toBe(0);

  // "." is what clickers send for blank; it toggles like B.
  await page.keyboard.press(".");
  await expect.poll(() => shown(page)).toBe(null);
  await page.keyboard.press(".");
  await expect.poll(() => shown(page)).toBe(0);

  // Frozen: the presenter moves on, the audience stays.
  await page.keyboard.press("f");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(300);
  expect(await committed(page)).toBe(2);
  expect(await shown(page)).toBe(0);
  await page.keyboard.press("f");
  await expect.poll(() => shown(page)).toBe(2);
});

test("clicking a link follows it, Delete goes back, clicks elsewhere do nothing", async ({ page }) => {
  await open(page, "Links and appendix");
  await start(page);

  // Find a page with a GoTo link that leads somewhere else.
  const found = await page.evaluate(async () => {
    const hook = window.__lectern!;
    for (let attempt = 0; attempt < 50; attempt++) {
      const p = hook.state().committedPage;
      const links = hook.links(p);
      if (links) {
        // Beamer's navigation bar sits in the bottom strip; take a link from the slide body.
        const index = links.findIndex((l) => l.action.kind === "goToPage" && l.action.page !== p && l.rect.y < 0.85);
        if (index >= 0) return { page: p, target: links[index]!.action.page!, rect: links[index]!.rect };
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return null;
  });
  expect(found).not.toBeNull();
  const { page: from, target, rect } = found!;
  await expect.poll(() => shown(page)).toBe(from);

  const box = (await page.locator("#audience canvas").boundingBox())!;
  // The slide may be letterboxed inside the canvas; these fixtures are 4:3 on a 16:9 viewport.
  const slide = await page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>("#audience canvas")!;
    return { cw: c.width, ch: c.height };
  });
  const slideWidth = Math.min(box.width, (box.height * 4) / 3);
  const slideHeight = Math.min(box.height, (box.width * 3) / 4);
  const left = box.x + (box.width - slideWidth) / 2;
  const top = box.y + (box.height - slideHeight) / 2;
  expect(slide.cw).toBeGreaterThan(0);

  // A click on plain slide area does nothing.
  await page.mouse.click(left + slideWidth * 0.5, top + slideHeight * 0.02);
  await page.waitForTimeout(200);
  expect(await committed(page)).toBe(from);

  await page.mouse.click(left + slideWidth * (rect.x + rect.width / 2), top + slideHeight * (rect.y + rect.height / 2));
  await expect.poll(() => shown(page)).toBe(target);
  expect((await page.evaluate(() => window.__lectern!.state().history)).at(-1)).toBe(from);

  await page.keyboard.press("Delete");
  await expect.poll(() => shown(page)).toBe(from);
});

test("the cursor hides after two seconds without movement", async ({ page }) => {
  await open(page, "Basic 16:9");
  await start(page);
  await page.mouse.move(200, 200);
  await page.mouse.move(220, 220);
  await expect(page.locator("#audience")).not.toHaveClass(/cursor-hidden/);
  await expect(page.locator("#audience")).toHaveClass(/cursor-hidden/, { timeout: 4000 });
});

test("Esc twice comes back to the choice of views, one click from the slides again; Leave wipes", async ({ page }) => {
  await open(page, "Basic 16:9");
  await start(page);
  await page.keyboard.press("ArrowRight");

  // One Esc alone does not end.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(1300);
  await expect(page.locator("#audience")).toBeVisible();
  expect(await committed(page)).toBe(1);

  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(page.locator("#ready")).toBeVisible();
  await expect(page.locator("#audience")).toBeHidden();
  expect(await page.evaluate(() => document.fullscreenElement)).toBeNull();
  expect(await page.evaluate(() => window.__lectern)).toBeUndefined();
  expect(await page.locator("#audience canvas").count()).toBe(0);
  await expect(page.locator("#preview canvas")).toHaveCount(1); // the slide the talk is on

  // One click and the slides are back where they were.
  await page.locator("#start").click();
  await expect.poll(() => committed(page)).toBe(1);
  expect(await page.evaluate(() => document.fullscreenElement?.id)).toBe("audience");
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => committed(page)).toBe(2);

  // Leave this talk: everything is dropped and the page starts over.
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.locator("#another").click();
  await expect(page.locator("#choose")).toBeVisible();
  await expect(page.locator("#ready")).toBeHidden();
  expect(await page.locator("#preview canvas").count()).toBe(0);
});

test("a PDF from this computer opens; a malformed one fails politely", async ({ page }) => {
  await page.goto("./");
  await page.locator("#file").setInputFiles("fixtures/malformed.pdf");
  await expect(page.locator("#status")).toHaveText("This file could not be read as a PDF.");
  await expect(page.locator("#choose")).toBeVisible();
  await expect(page.locator("#ready")).toBeHidden();

  await page.locator("#file").setInputFiles("fixtures/tikz-heavy.pdf");
  await expect(page.locator("#ready")).toBeVisible();
  await expect(page.locator("#deck-summary")).toHaveText("7 pages");
  await start(page);
  for (let i = 1; i <= 6; i++) {
    await page.keyboard.press("ArrowRight");
    await expect.poll(() => shown(page), { timeout: 15_000 }).toBe(i);
  }
});

test("when full screen is refused, offers to present in the window; resizing keeps the picture", async ({ page }) => {
  await page.addInitScript(() => {
    Element.prototype.requestFullscreen = () => Promise.reject(new TypeError("blocked by policy"));
  });
  await open(page, "Basic 16:9");
  await expect(page.locator("#fs-problem")).toBeHidden();
  await page.locator("#start").click();
  await expect(page.locator("#fs-problem")).toBeVisible();
  await expect(page.locator("#audience")).toBeHidden();

  await page.locator("#start-windowed").click();
  await expect(page.locator("#audience")).toBeVisible();
  await expect.poll(() => shown(page)).toBe(0);

  await page.setViewportSize({ width: 900, height: 700 });
  await expect.poll(async () => (await sample(page)).width).toBe(900);
  await expect.poll(async () => (await sample(page)).centre).toBeGreaterThan(150); // a slide, not a blank
  expect(await shown(page)).toBe(0);

  // In the window, keys only drive the slides: none of them asks for full screen again. The way
  // back is a button that shows while the mouse moves and goes when it stops, like the cursor.
  await page.evaluate(() => {
    (window as unknown as { __asked: number }).__asked = 0;
    Element.prototype.requestFullscreen = () => {
      (window as unknown as { __asked: number }).__asked += 1;
      return Promise.reject(new TypeError("blocked by policy"));
    };
  });
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => shown(page)).toBe(1);
  await page.keyboard.press("Space");
  await expect.poll(() => shown(page)).toBe(2);
  expect(await page.evaluate(() => (window as unknown as { __asked: number }).__asked)).toBe(0);
  await page.mouse.move(200, 200);
  await page.mouse.move(260, 240);
  await expect(page.locator("#audience .fs-button")).toBeVisible();
  await page.locator("#audience .fs-button").click();
  expect(await page.evaluate(() => (window as unknown as { __asked: number }).__asked)).toBe(1);
  expect(await shown(page)).toBe(2); // the click did not also step
  await expect(page.locator("#audience .fs-button")).toBeHidden({ timeout: 4000 });
});
