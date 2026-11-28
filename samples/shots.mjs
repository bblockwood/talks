// Takes the screenshots in img/ that tour.tex includes, from the app showing this very deck.
// Needs the dev server: `npm run dev` in the repository root, then `node samples/shots.mjs`,
// then `make -C samples`. (The pictures show the deck, so after a large change run both twice.)
import { chromium } from "@playwright/test";
import { fileURLToPath } from "node:url";

const out = (name) => fileURLToPath(new URL(`img/${name}.png`, import.meta.url));
const URL_ = "http://localhost:5173/talks/";
const browser = await chromium.launch();

async function open(viewport) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 2 });
  await page.goto(URL_);
  await page.click("#sample-tour");
  await page.waitForSelector("#ready:not([hidden])");
  return page;
}
const goTo = async (page, frame, builds) => {
  await page.keyboard.type(String(frame));
  await page.keyboard.press("Enter");
  for (let i = 0; i < builds; i++) await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(700);
};

// The audience view with its bar up.
{
  const page = await open({ width: 1280, height: 720 });
  await page.click("#start");
  await page.waitForSelector("#audience .aud-menu", { state: "attached" });
  await goTo(page, 11, 2);
  await page.mouse.move(600, 300);
  await page.mouse.move(620, 320);
  await page.click(".aud-menu");
  await page.mouse.move(640, 300);
  await page.waitForTimeout(400);
  await page.screenshot({ path: out("audience") });
  await page.close();
}

// The presenter view, on a build with a note of its own.
{
  const page = await open({ width: 1280, height: 760 });
  await page.click("#presenter");
  await page.waitForSelector("#console:not([hidden])");
  await goTo(page, 13, 2);
  // The status line names the talk code; a picture must not.
  await page.evaluate(() => {
    const link = document.getElementById("link");
    link.textContent = "Slides showing · 2 devices";
    link.className = "linkstate ok";
  });
  await page.screenshot({ path: out("presenter") });
  await page.close();
}

// The page where a view is chosen, at the packed copy's button.
{
  const page = await open({ width: 760, height: 1400 });
  await page.waitForTimeout(500);
  const top = await page.locator("#pack-row").boundingBox();
  await page.screenshot({ path: out("pack"), clip: { x: top.x - 16, y: top.y - 250, width: top.width + 32, height: 250 + top.height + 16 } });
  await page.close();
}
await browser.close();
