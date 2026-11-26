# Progress

## W0. Lectern-PC smoke test

### Plan (2026-11-26)

Goal: learn what a locked-down classroom PC's browser actually allows, before building anything real. Everything under `w0/` and `src/w0/` is throwaway. The relay, the workflow and the build setup are kept.

1. **Scaffold.**
   - Vite + TypeScript (strict), base `/talks/`, multi-page build: `/talks/` (placeholder), `/talks/w0/` (room PC test), `/talks/w0/phone/` (phone test).
   - PDF.js self-hosted: the worker is bundled, and cMaps, standard fonts and wasm decoders are copied from `node_modules` into `public/pdfjs/` at build time.
   - CSP `<meta>` on every page: scripts and workers from self only, connections to self plus the relay origin only.
   - Vitest for unit tests, Playwright (Chromium) for e2e.
2. **Relay (`relay/`), built to SPEC §8.3 now** since it is not throwaway: `/room/:id` → Durable Object (SQLite-backed, hibernating WebSockets), origin allow-list, 8 sockets per room, 64 KB binary frames only, 120 frames/s per socket, 2 h idle close, `/health`.
3. **Pages workflow** (`.github/workflows/deploy.yml`): build, copy `d/` from the `decks` branch if it exists, deploy.
4. **Room PC test page (`/talks/w0/`).** One page, numbered tests, each showing its own result:
   - PDF.js renders a bundled Beamer deck (`fixtures/overlays.pdf`); reports render times.
   - Start → fullscreen.
   - Keyboard lock for Esc; Esc twice within 1 s exits.
   - Wake lock.
   - Window Management: screen detection, fullscreen on a chosen screen, companion window on the other screen.
   - Key log: every keydown with `key`, `code`, `keyCode`, for clicker codes.
   - Relay: pairs with the phone by a 6-digit number, answers pings.
   - A plain-text report that can be sent to the phone through the relay, so Ben doesn't have to copy anything off the classroom PC by hand.
5. **Phone test page (`/talks/w0/phone/`).** Enter the 6-digit number; shows relay status, RTT (last, median, max), Next/Prev buttons that drive the room page, wake lock, and the received report with Copy/Share.
6. **Cache test (SPEC §4.5).** `tools/w0-cachetest.mjs` force-pushes a fresh `current.json` to the orphan `decks` branch, triggers the workflow, and times how long the new file takes to appear with and without the `?t=` query. Fable runs this after the first deploy and records the result in `docs/decisions.md`.
7. **Deploy** Pages and the relay once Ben confirms Cloudflare and Pages are set up.
8. **Ben checklist** for the classroom PC, below.

W0 relay messages are unencrypted JSON in binary frames. No deck, code or secret crosses the relay in W0. End-to-end encryption arrives with W3.

### Done (2026-11-26)

- Scaffold: Vite 8 + TypeScript 7 (strict), base `/talks/`, three pages (`/talks/`, `/talks/w0/`, `/talks/w0/phone/`), PDF.js 6 self-hosted, CSP `<meta>` on every page.
- Relay (`relay/`): built to SPEC §8.3, not a throwaway. Runs locally under `wrangler dev`.
- Pages workflow: build, unit tests, add `d/` from the `decks` branch when it exists, deploy.
- W0 room page and phone page, as planned above.
- `tools/w0-cachetest.mjs` for the §4.5 check.
- Tests: 14 unit tests (relay rules), 3 e2e tests (deck renders with no CSP violation and no off-site request; phone pairs through the local relay, measures round trips, drives slides, receives the report; relay refuses bad origins and room ids). The production build was also checked under its CSP in headless Chromium: full screen, keyboard lock and double-Esc exit all work there.

### Not done yet (waiting on Ben)

- Relay deploy and Pages deploy: waiting for Ben to confirm Cloudflare and Pages are set up.
- §4.5 cache test: needs the deployed site. Fable runs it right after the first deploy.

### Known issues and notes

- Wake lock is refused in headless Chromium (no permission), so it is untested until a real browser runs it.
- The two-screen tests (Window Management, second window placement) can't be automated; they are the main thing the classroom test is for.
- `@types/node` is not on the allowed dependency list, so `vite.config.ts`, `playwright.config.ts` and `tools/*.mjs` are not typechecked. Worth allowing at W2 when `tools/` grows.
- PDF.js 6 has an optional worker-rendering mode (rendering off the main thread). Not used in W0; worth evaluating in W1 for SPEC §6.4.
- W0 relay messages are unencrypted, and the 6-digit pairing number is the only thing separating rooms. Nothing sensitive crosses it. Remove the W0 pages after W3.

### Ben checklist: W0 on a classroom PC

Bring: phone, USB clicker. About 10 minutes. Record results in `docs/spikes/W0.md` (one copy of the template per machine). Repeat on at least one other machine.

The page builds a text report as you go, and step 9 sends it to your phone, so you don't need to write much down in the room.

1. **Open the page.** On the classroom PC open Chrome or Edge (note which), in a private/InPrivate window, and go to `benlockwood.com/talks/w0/`.
   - Expect: a slide titled "Overlays" and, under "1. Slides", green text "Loaded: 23 pages, 9 frames".
   - If the page is blank or says "PDF.js failed", note the message and stop: that is the result.
2. **Connect the phone.** On your phone (campus Wi-Fi first) open `benlockwood.com/talks/w0/phone` and type the 6-digit number shown under "5. Phone" on the PC. Tap Connect.
   - Expect on the phone: Relay "connected", Room PC "connected", and a Round trip line that updates every second.
   - Tap Next a few times: the slide on the PC should change with no visible delay.
3. **Keys, windowed.** On the PC, click once on the slide, then press each clicker button once (forward, back, blank-screen, start/stop if it has them). Then on the room keyboard press: → ← Page Down, Page Up, Space, B, F5, Esc.
   - Expect: each press adds a line under "4. Keys and clicker". F5 must not reload the page.
4. **Full screen.** Click **Start (full screen)**.
   - Expect: slides fill the projector, with a small grey status box at top left.
   - Note whether the browser shows a "press Esc to exit" or "hold Esc" banner, and what it says.
5. **Esc and the clicker in full screen.**
   - Press Esc **once**. Expect: you stay in full screen (the status box shows `key="Escape"`). If you drop out, note it and click Start again.
   - Press every clicker button again. Note any button that leaves full screen or does nothing.
   - Advance through about ten slides with the clicker, then a few from the phone.
6. **Leave full screen.** Press Esc twice quickly. Expect: back to the page; "Exits from full screen" says "double Esc (handled by page)". Then click Start again and try **holding** Esc for two seconds; note whether that exits.
7. **Two screens.** Only if the PC has its own monitor showing something different from the projector. If the projector mirrors the monitor, click **Detect screens** anyway and note what it says, then skip to step 8.
   - Click **Detect screens**. The browser asks "…wants to manage windows on all your displays": click **Allow**. If no prompt appears, or the PC blocks it, note that.
   - Expect: a line listing two screens, and a row of buttons for each.
   - On the **projector's** row click **Full screen here**. Expect: slides fill the projector, wherever the browser window was. Esc twice to leave.
   - On the projector's row click **Full screen here + second window on the other screen**. Expect: slides on the projector and a dark "Presenter window" on the PC's own monitor. Esc twice to leave.
8. **Cellular.** On the phone, turn Wi-Fi off. Within about ten seconds Relay should return to "connected" on its own. Tap **Reset round-trip numbers**, wait 30 seconds, and note the median. Tap Next a few times. Turn Wi-Fi back on.
9. **Send the report.** On the PC click **Send report to phone**. On the phone, the report appears at the bottom: tap **Share…** (or Copy) and send it to yourself. Paste it into `docs/spikes/W0.md`.
10. **Lock test (optional, 1 minute).** Lock the phone for 20 seconds and unlock it. Note whether Relay comes back to "connected" by itself.
11. **Clean up.** Close the private window on the PC.

Things to write down by hand, since the report can't see them:
- Room and PC (e.g. building/room, Windows or Mac, Chrome or Edge).
- Clicker model.
- What the full-screen banner said (step 4), and whether a single Esc left full screen (step 5).
- Whether the projector mirrors the PC monitor or extends it.
- Round trip medians on Wi-Fi and on cellular, read from the phone.
- Anything that looked wrong on the projector: blurry text, wrong size, visible cursor, flicker on slide change.
