import { expect, test } from "@playwright/test";

test("room page renders the deck, logs keys and violates no CSP", async ({ page }) => {
  const problems: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(m.text());
  });
  page.on("pageerror", (e) => problems.push(String(e)));
  const offsite: string[] = [];
  page.on("request", (r) => {
    const host = new URL(r.url()).host;
    if (host !== "localhost:5173" && host !== "localhost:8787") offsite.push(r.url());
  });

  await page.goto("w0/");
  await expect(page.locator("#pdf-status")).toContainText("Loaded: 23 pages, 9 frames");
  await expect(page.locator("#start")).toBeEnabled();

  // The slide canvas has real pixels, not a blank sheet.
  const painted = await page.locator("#slide").evaluate((c: HTMLCanvasElement) => {
    const data = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    let dark = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i]! + data[i + 1]! + data[i + 2]! < 600) dark++;
    return { width: c.width, dark };
  });
  expect(painted.width).toBeGreaterThan(300);
  expect(painted.dark).toBeGreaterThan(100);

  await page.keyboard.press("PageDown");
  await expect(page.locator("#report")).toContainText("key → draw: n=1");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("F5"); // a clicker's "start slideshow": must not reload the page
  await expect(page.locator("#keylog")).toContainText('key="PageDown" code=PageDown keyCode=34');
  await expect(page.locator("#keylog")).toContainText('key="F5"');
  await expect(page.locator("#r-keys")).toHaveText("3 key presses");
  await expect(page.locator("#report")).toContainText("key → draw: n=2");

  expect(problems).toEqual([]);
  expect(offsite).toEqual([]);
});

test("phone pairs through the relay, measures round trips, drives slides and receives the report", async ({
  browser,
}) => {
  const room = await browser.newPage();
  await room.goto("w0/");
  await expect(room.locator("#pdf-status")).toContainText("Loaded");
  await expect(room.locator("#r-relay")).toHaveText("connected");
  const pairing = (await room.locator("#pairing").textContent()) ?? "";
  expect(pairing).toMatch(/^\d{6}$/);

  const phone = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const phoneErrors: string[] = [];
  phone.on("console", (m) => {
    if (m.type() === "error") phoneErrors.push(m.text());
  });
  await phone.goto("w0/phone/");
  await phone.locator("#digits").fill(pairing);
  await phone.locator("#connect").click();

  await expect(phone.locator("#p-relay")).toHaveText("connected");
  await expect(phone.locator("#p-room")).toHaveText("connected");
  await expect(phone.locator("#p-rtt")).toContainText("median", { timeout: 10_000 });
  await expect(room.locator("#r-phone")).toContainText("pings answered");

  await expect(phone.locator("#p-slide")).toHaveText("1 of 23");
  await phone.locator("#next").click();
  await phone.locator("#next").click();
  await phone.locator("#prev").click();
  await expect(phone.locator("#p-slide")).toHaveText("2 of 23");

  await room.locator("#send-report").click();
  await expect(phone.locator("#p-report")).toContainText("Lectern W0 report");
  await expect(phone.locator("#p-report")).toContainText("phone: connected");
  expect(phoneErrors).toEqual([]);
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
