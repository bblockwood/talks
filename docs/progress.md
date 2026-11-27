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

### Deployed (2026-11-26)

- Relay: `https://lectern-relay.bblockwood.workers.dev` (`/health` returns `ok`; other origins get 403).
- Site: `https://benlockwood.com/talks/w0/` and `https://benlockwood.com/talks/w0/phone`. Checked live with a headless browser: deck renders, phone pairs through the relay, report arrives.
- §4.5 cache test passed: a republished `current.json` was live 31–36 s after the push. Details in `docs/decisions.md` and `docs/spikes/W0.md`.

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


---

## W1. Core viewer

### W0 results that shape W1 (from `docs/spikes/W0.md`)

- One machine so far: Chrome 158 on a Mac with a mirrored display, not a classroom PC. Everything W1 depends on worked: PDF.js, full screen, keyboard lock (a single Esc stayed in full screen; Esc twice left), wake lock, key codes for arrows and Page Up/Down. Key → draw was 20 ms median with no render-ahead at all.
- Still unknown: a Windows classroom PC, a real clicker, and two extended screens. None block W1 (Mode A only). The two-screen result is needed before W4.

### Plan (2026-11-26)

1. **Core (`src/core/`, DOM-free, unit-tested), ported from the native PresenterCore so the two apps agree:**
   - `frames.ts`: frames and builds from page labels (Native §4.1).
   - `session.ts`: `SessionState`, `Command`, and the reducer (Native §3.2): steps, frame steps, jumps, back/forward history, audience mode.
   - `links.ts`: link actions, named-action mapping, normalised hit-testing (Native §4.3).
   - `keys.ts`: the Native §6.5 key map as a pure interpreter, including digits + Return and Esc-twice-to-end.
   - `prefetch.ts`: which pages to render ahead (SPEC §6.4).
2. **Shared (`src/shared/`):** PDF.js deck adapter (labels, links with resolved destinations, annotation rendering off), and a render cache that renders ahead at the exact pixel size and never hands out a partial page.
3. **Room (`src/room/`):** audience view (one canvas, one draw per change, letterboxed on black, cursor hidden after 2 s, invisible link regions), the presenting controller (keys, wake lock, keyboard lock, full-screen recovery, End and wipe), and the entry screen.
4. **Interim entry screen.** There are no talk codes until W2, so for W1 the entry screen offers the bundled test decks and "open a PDF from this computer" (read into memory only). W2 replaces this with the code field.
5. **Tests:** unit tests for all of core; e2e for presenting, links and back, black/white/freeze, End, a malformed PDF, and no off-site requests.

Not in W1: notes, presenter view, overview, timer, pointer, phone (W3/W4). Their keys (Tab, L, D, T) are swallowed and do nothing.

### Done (2026-11-26)

- **Core** (`src/core/`, no DOM, no `any`): `frames.ts`, `session.ts`, `links.ts`, `keys.ts`, `prefetch.ts`. The reducer is a port of the native `SessionReducer`, so steps, jumps, back/forward and freeze behave as in the Mac app.
- **Shared:** `deck.ts` (PDF.js adapter: labels → frames, link annotations with resolved destinations) and `render-cache.ts` (renders ahead at the exact pixel size; hands out only finished pages).
- **Room:** `audience.ts`, `presentation.ts`, and the interim entry screen (`index.html`, `main.ts`).
- **Behaviour:**
  - Start goes full screen, locks Esc where the browser allows, and holds a wake lock.
  - Keys per Native §6.5: next/previous, Shift+arrows by frame, number + Enter to jump, Delete (or Cmd+[ / Cmd+]) back/forward, B or `.` black, W white, F freeze. F5 and Tab are swallowed.
  - Clicking a link follows it; clicking elsewhere does nothing. The cursor hides after 2 s.
  - Esc twice within 1 s ends; so does holding Esc when the keyboard lock is on. End wipes the canvases, destroys the PDF and its worker, and reloads the entry screen.
  - If the browser refuses full screen, the entry screen says to press F11 and offers "Present in this window".
- **Tests:** 108 unit tests (94 for core, 14 for the relay rules) and 10 e2e tests. All pass, and the production build was checked under its CSP.
- **Speed:** with render-ahead, key → audience draw is 0–2 ms on `tikz-heavy.pdf` at 1920×1080 in headless Chromium (W0 without render-ahead: 20 ms median on Ben's Mac). Measured as `performance.measure("lectern:input-to-draw")`.

### Known issues and notes

- **Interim entry screen.** Test decks and "open a PDF from this computer" replace the code field until W2. A picked PDF is read into memory only.
- **Not yet tested on real hardware:** a Windows classroom PC, a clicker, Firefox, Safari. The e2e suite is Chromium only.
- **Notes-split decks** (fixture 3) show the whole double-width page; cropping to the slide half comes with notes in W4.
- **Memory.** The cache holds up to 12 full-size pages. At 1080p that is about 100 MB; on a 4K projector about 400 MB. Fine for a lectern PC, but the capacity may need to scale with resolution; to revisit if a 4K room shows trouble.
- **Leaving full screen without ending.** Where keyboard lock isn't available (Firefox, Safari), one Esc leaves full screen. The talk carries on in the window, and the next key press goes back to full screen. See `docs/decisions.md`.
- **Debug overlay** (Ctrl+Shift+D) is presenter-view only per SPEC §6.4, so it waits for W4. The measurements it will show are already recorded.
- The W0 pages are still deployed at `/talks/w0/` for the remaining classroom tests.

### Ben checklist: W1

Part A can be done now on your Mac. Part B is for the next time you are at a classroom PC with a clicker (it also finishes the W0 checklist, which so far has only the Mac result).

**A. On your Mac (5 minutes)**

1. Open `benlockwood.com/talks/` in Chrome. Click **Open a PDF from this computer** and pick a real talk of yours, ideally one with overlays and appendix links.
   - Expect: its title, and "N frames, M pages". Check N matches the frame number on your last slide.
2. Click **Start**. Expect: the first slide, full screen, instantly, and nothing else on screen.
3. Step through ten slides with → and ←. Expect: no flicker, no half-drawn slide, sharp text.
4. Press Shift+→ in the middle of a frame with overlays: it should go to the next frame's first build. Shift+← should land on the previous frame fully built.
5. Type a frame number and press Enter: it should jump there. Press Delete: it should return to where you were.
6. Click a link to an appendix slide, step a couple of builds, press Delete. Expect: back at the slide with the link.
7. Press B (black), B again, W (white), W again. Press F, step forward twice (the screen should not change), press F again (it should catch up).
8. Leave the mouse still: the cursor should vanish after two seconds.
9. Press Esc once: nothing should happen. Press Esc twice quickly: back to the entry screen.
10. Repeat step 1–3 once in Safari and once in Firefox if you have them. There, one Esc leaves full screen; press → and it should go back to full screen by itself.

**B. On a classroom PC, with the clicker (10 minutes)**

1. Do the W0 checklist first at `benlockwood.com/talks/w0/` (steps 3–7 especially: clicker key codes and the two-screen test).
2. Put a real talk on a USB stick, or open one from your email or cloud storage in the browser's download folder. Open `benlockwood.com/talks/` in a private window, click **Open a PDF from this computer**, pick it, click **Start**.
3. Run the talk's first few minutes with the clicker only. Note any button that does nothing or does the wrong thing, especially blank-screen and start/stop.
4. Look at the projector from the back of the room: sharpness, colours, slide size, black bars.
5. Leave it idle for 15 minutes on one slide: the screen should not sleep or lock. (Some PCs enforce a lock by policy; note it if so.)
6. Press Esc twice to end, and delete the downloaded PDF if you downloaded one.

Write results under a "W1" heading in `docs/spikes/W0.md` or a new `docs/spikes/W1.md`.


---

## W2. Publishing and encryption

### W1 results that shape W2

- Part A of the W1 checklist passed on Ben's Mac with a PDF opened from the computer (`docs/spikes/W1.md`). Part B (classroom PC, clicker) is still open and does not block W2.
- Ben's decisions for W2: one chosen word as the talk code; keep the file picker; `@types/node` allowed.

### Plan (2026-11-26)

1. **Core, shared by browser and tools (WebCrypto only):**
   - `code.ts`: code normalisation and validation.
   - `crypto.ts`: PBKDF2 → HKDF key derivation (SPEC §3) and the `.bin` format (SPEC §4.2).
   - `payload.ts`: the stored ZIP with `deck.pdf`, `meta.json`, `notes.json`, `deck.pdfpc`.
   - `pptx.ts`: PowerPoint notes extraction (Native §5.1(5)).
2. **Test vectors.** `fixtures/crypto-vectors.json` and `fixtures/encrypted-sample.bin`, produced by a separate reference implementation (Node's OpenSSL bindings, not WebCrypto), and checked by the same core code in Node (Vitest) and in the browser (Playwright).
3. **Tools:** `npm run publish`, `npm run codes`, `npm run revoke`. Codes live only in `~/.config/lectern/codes.json` (mode 0600). The `decks` branch is rewritten as a single commit with git plumbing and force-pushed; the tool then triggers the deploy and, with `--wait`, polls until the deck is live.
4. **Entry screen (SPEC §5.1):** one large code field; "Unlocking…"; fetch `current.json` (no-store, `?t=`) and the `.bin`; decrypt and unzip in memory; title from `meta.json`; plain-language errors. The file picker stays as a secondary option.
5. **Tests:** unit tests for all of the above; e2e for opening a published deck by code, a wrong code, and the browser side of the vectors.
6. **Acceptance:** publish a fixture to the real site with `--wait`, open it by code in a headless browser, then revoke it.

### Done (2026-11-26)

- **Core:** `code.ts`, `crypto.ts`, `payload.ts`, `pptx.ts`. The browser and the tools run the same files.
- **Test vectors:** `fixtures/crypto-vectors.json` and `fixtures/encrypted-sample.bin` (fixture 12), generated by `tools/make-test-vectors.ts` with Node's OpenSSL bindings as an independent reference. The WebCrypto code reproduces them byte for byte in Node (Vitest) and in Chromium (Playwright).
- **Tools:**
  - `npm run publish -- talk.pdf [--code word] [--name slug] [--rotate-code] [--random] [--long] [--wait]`
  - `npm run codes`
  - `npm run revoke -- <name|file.pdf>`
- **Entry screen:** code field, "Unlocking…", fetch, decrypt and unzip in memory, title from `meta.json`, Start. Errors: "No talk found for that code." and "Could not reach the server…". The file picker stays as a secondary option. The bundled test decks now appear in development only.
- **Tests:** 142 unit and 17 e2e, all passing. They cover the vectors, tamper and wrong-code rejection, the code store's file modes, the decks branch against a real temporary git remote (publish, republish with one rollback copy, second deck, rotation, revoke, always one commit), and in the browser: open by code, wrong code, network failure, damaged file, republish picked up at once, and nothing written to localStorage, sessionStorage, cookies, IndexedDB or Cache Storage.
- **Acceptance, against the real site:** `npm run publish -- "Lectern Acceptance.pdf" --wait` (a copy of `overlays.pdf`, throwaway code store) reported "Live after 34 s". A headless browser at `https://benlockwood.com/talks/` got "No talk found" for a wrong code, then opened the deck with its code in 0.8 s and presented it. A republish kept the code and was live in 31 s, with the previous `.bin` kept and the branch still a single commit. `npm run revoke` removed it; the site then returned 404 for it. The `decks` branch is now empty.
- `tools/w0-cachetest.mjs` is deleted: it replaces the `decks` branch, which is unsafe now that real decks live there.

### Known issues and notes

- **Codes are guessable by design** (Ben's decision): treat a published deck as roughly public. Revoke decks you no longer need.
- **"From a clean machine" was not literally tested.** The acceptance run was on Ben's Mac. CI runs the unit tests, including the git round-trip, on a clean Linux runner.
- **PowerPoint notes are tested only against a synthetic `.pptx`.** Fixture 9 (a real PowerPoint export with notes and a hidden slide) is Ben's to supply.
- **Notes and sidecars travel in the payload but are not shown yet.** That is W4.
- **Each publish redeploys the whole site**, which takes about 30 s. Two publishes in quick succession queue up.
- **A deck's code is remembered by the PDF's absolute path.** If you move or rename the PDF, the next publish treats it as a new deck (new code from the new file name, old deck left online). Use `--name` for a talk whose file moves around.
- `npm run publish` must be run from this repo; it pushes over SSH and uses `gh`, both already set up on Ben's Mac.

### Ben checklist: W2

All on your Mac; about 10 minutes.

1. **Publish a real talk.** From this repo:
   ```
   npm run publish -- ~/path/to/talk.pdf --code bunching --wait
   ```
   Use whatever word suits the talk; without `--code` it uses the file name.
   - Expect: "Published “…”: N pages", then "Live after about 30 s", then a line starting `Code: bunching → https://benlockwood.com/talks`.
2. **Open it.** In a private Chrome window open `benlockwood.com/talks`, type the code, press Enter.
   - Expect: "Unlocking…" for about a second, then the talk's title and frame count. Click **Start** and step through a few slides.
3. **Wrong code.** Press Esc twice, type a wrong word. Expect: "No talk found for that code."
4. **Republish.** Change a slide, recompile, and run the same publish command again, without `--code`. Expect: the same code is printed. Open it again and check the change is there.
5. **Sidecars, if you have a talk with them.** Publish a PDF that has a `.pdfpc` or `.lectern.json` (or a `.pptx`) next to it. Expect: a line like "pdfpc file: …" or "PowerPoint notes: N slides with notes". If you have a PowerPoint export with notes and a hidden slide, please copy the `.pdf` and `.pptx` to `fixtures/ppt-export.*` so it becomes fixture 9.
6. **List and revoke.** `npm run codes` should list the deck. Then `npm run revoke -- ~/path/to/talk.pdf`, wait a minute, and check the code now gives "No talk found".
7. **Check the code store.** `ls -l ~/.config/lectern/codes.json` should show `-rw-------`. Back the file up as SETUP.md §3 suggests.
8. **Phone.** Open `benlockwood.com/talks` on your phone and enter a code: it should open and show slides. (The phone remote itself is W3; this only checks that the phone can decrypt a deck.)

---

## W3. Relay and phone remote

### W2 results that shape W3

- Ben ran W2 checklist steps 1–3 and 6–8: publish with a chosen code, open by code, wrong code, list and revoke, code store permissions, and opening a deck on the phone all worked. Steps 4–5 (republish, sidecars) are deferred, not failed.
- SPEC §12 asks whether the phone should get ink in W3 or W5. Not raised by Ben, so ink stays in W5 as §7 has it.

### Plan (2026-11-26)

1. **Core:**
   - `protocol.ts`: the §8 wire format. Each frame is `iv || AES-256-GCM(channel-key, iv, JSON)`; messages carry `sid` and `seq`, and receivers drop anything not newer than the last `seq` from that sender. Incoming commands are validated before they reach the reducer.
   - `session.ts`: the talk timer joins the session state (Native §6.7), with start, pause, toggle and reset commands.
   - `notes.ts`: the text notes sources and their merge order (SPEC §6.2: sidecar overrides, `.pdfpc`, PDF text annotations, PowerPoint), with the frame fallback of Native §5.2. The Beamer second-screen split is an image, not text, and waits for W4.
   - `markdown.ts`: the small Markdown subset notes use, rendered to escaped HTML.
2. **Shared:** `relay-client.ts` (encrypts, orders, reconnects with backoff 0.5–10 s and jitter, measures round trips) and a slide surface the phone and, later, the presenter view both use.
3. **Room PC:** connects to the relay when a deck is opened by code. Shows "Phone can connect" or "Phone unavailable: keyboard and clicker only" on the entry screen. While presenting it applies commands from the phone, broadcasts `state` after every change and every 5 s, answers pings, draws the phone's pointer, and ends on `end`. It never waits on the relay.
4. **Phone remote (`/talks/remote`):** code entry, optional "Remember on this device", `#c=` deep link. The phone decrypts the deck itself. Portrait console: current slide with frame and build, next slide, notes, timer, large Prev/Next; swipe to step, long-press and drag for the pointer, tap a link to follow it; thumbnail sheet with private preview and Show; Back, Black, Freeze; End talk with a confirm. Reconnects by itself and resyncs.
5. **Measurement.** Each command is acknowledged in the `state` that follows it, so the phone can show a measured tap → slide time alongside the ping round trip.
6. **Tests:** unit tests for protocol, timer, notes and markdown; e2e with a room page and a phone page talking through the local relay, including a dropped connection.

### Done (2026-11-26)

- **Core:** `protocol.ts` (encrypted frames, `sid`/`seq` replay and reorder filtering, strict message validation), the talk clock in `session.ts`, `notes.ts`, `markdown.ts`.
- **Shared:** `relay-client.ts`, `slide-surface.ts`, `deck-notes.ts`.
- **Room PC:** `room-link.ts`; the presentation applies phone commands, broadcasts `state` after every change and every 5 s, answers pings, draws the pointer (red dot with glow and a short trail, gone 2 s after it stops), and ends on `end`. The entry screen shows "Phone can connect: benlockwood.com/talks/remote" or "Phone unavailable: keyboard and clicker only".
- **Phone remote** at `/talks/remote`: everything in the plan above. The "More" sheet also has clock pause/reset, White, Forward, notes size, the measured connection numbers, "Close remote" and "End talk…".
- **Tests:** 189 unit and 23 e2e, all passing. The W3 e2e tests run a room page and a phone page through the local relay with real encryption: stepping from the phone and from the room keyboard, notes from the PDF and the `.pdfpc` file, the 30-minute countdown, swipe, thumbnail preview then Show, Back, Black, Freeze, the pointer, clock pause, End talk; that only ciphertext crosses the relay; that the phone reconnects and resyncs by itself after a dropped connection; that the room PC presents normally with the relay unreachable; the `#c=` link; the "Slides updated — reload?" banner; and remember/forget on the phone.
- A bug found by the tests and fixed: sheets left open when a talk was closed stayed open when the next one was opened.

### Known issues and notes

- **Not yet tried on a real phone.** Everything above ran in desktop Chromium at phone size. Touch behaviour on iOS Safari (long-press, swipe, wake lock, returning from the background) is the main thing Ben's checklist tests.
- **The 150 ms acceptance number needs Ben's phone on campus Wi-Fi.** The phone's More sheet shows "tap → slide" as a running median for exactly this.
- **Replays across sessions.** `seq` filtering stops replays within a session. A hostile relay operator could still replay frames recorded in an earlier session of the same talk code (for example an old "next"). The relay is Ben's own Worker, so this is accepted for now; fixing it needs a per-session nonce in the protocol.
- **Anyone with the code can drive the slides** (SPEC §8.2), and codes are one guessable word. A heckler who guesses the word could advance slides or end the talk. `--random` codes close this.
- **Connected remotes are not listed anywhere yet**; that belongs to the presenter view (W4).
- **Thumbnails** are rendered at up to 2× and kept while the talk is open; a 300-frame deck would hold on to roughly 100 MB on the phone.
- **Opening a deck from a file gives no phone remote**, since there is no code to derive a room from.
- The W0 test pages are still deployed for the outstanding classroom-PC checks.

### Live check (2026-11-26)

Against `https://benlockwood.com/talks/` and the deployed relay, with a throwaway deck (published, then revoked) and headless Chromium for both the room page and a phone-sized page on Ben's Mac:

- Room PC: "Phone can connect: benlockwood.com/talks/remote". Phone: "Room PC is ready: click Start there", then "Connected to room PC" after Start.
- 18 Next/Prev taps from the phone: **ping 64 ms, tap → slide 39 ms (median)**; the room PC drew each within 0–1 ms of receiving the command.
- End talk from the phone returned the room PC to the code entry screen.
- The phone page contacted only `benlockwood.com` and the relay. No console errors on either page.

This is from a home connection with both ends on the same machine, so it shows the path works and is well inside 150 ms; it is not the campus measurement the acceptance asks for.

### Ben checklist: W3

You need a published talk (ideally one with notes and an appendix link), your phone, and any computer as the "room PC". About 15 minutes. Parts A–C work at home; part D needs campus Wi-Fi.

**A. Connect**

1. On the computer, open `benlockwood.com/talks` in a private window, type the talk's code, and wait for the title.
   - Expect under the Start button: a green dot and "Phone can connect: benlockwood.com/talks/remote".
2. On the phone, open `benlockwood.com/talks/remote`. Type the same code, tick **Remember on this device**, tap **Open**.
   - Expect: the first slide, and at the top "Room PC is ready: click Start there".
3. On the computer click **Start**.
   - Expect on the phone within a second: "Connected to room PC · NN ms" with a green dot, and the clock running at top right.

**B. Drive the talk from the phone**

4. Tap **Next** several times, then **Prev**. The room screen should follow with no visible delay, and the phone should show the frame and build ("Frame 4 of 20", "Build 2 of 3"), the next slide, and your notes.
5. Swipe left and right on the phone's slide: same as Next and Prev.
6. Press and hold on the phone's slide until it buzzes (about a third of a second), then drag: a red dot should follow on the room screen, and vanish when you lift your finger. Check that a hold-and-drag never changes the slide.
7. Tap **Slides**. Tap a slide far from the current one.
   - Expect: the phone shows it with a blue "Preview" label; the room screen has not changed. Swipe to look at neighbouring slides. Tap **Show**: now the room screen jumps there.
8. Tap **Back**: the room screen returns to where you were before the jump.
9. If the talk has a link (for example to an appendix slide), tap it on the phone's slide: the room screen should follow it. **Back** returns.
10. Tap **Black**, then **Black** again. Tap **Freeze**, tap Next twice (the room screen should not move, and the phone shows "ROOM SCREEN FROZEN"), then **Freeze** again (the room screen catches up).
11. Tap the clock, then **Pause**, **Resume**, **Reset**. Use **A+** and **A−** to change the notes size.
12. Press → on the computer's keyboard: the phone should follow.

**C. Things that go wrong on stage**

13. Lock the phone for 30 seconds, unlock it. Expect: "Reconnecting…" briefly at most, then "Connected to room PC" by itself, on the right slide. Does the phone screen stay awake on its own while the remote is open?
14. Switch the phone to another app for a minute and come back. Same expectation.
15. Put the phone in airplane mode. On the computer, keep presenting with the arrow keys: it must be completely unaffected. Turn airplane mode off: the phone should reconnect and show the current slide.
16. Turn the phone's Wi-Fi off so it uses cellular: it should reconnect by itself.
17. Close the phone's browser tab completely, then open `benlockwood.com/talks/remote` again: the talk should be listed under "Saved on this phone"; one tap reopens it, on the current slide.
18. Tap **More**, **End talk…**, **End talk**. Expect: the computer leaves full screen and returns to the code entry page.

**D. The acceptance measurement, on campus Wi-Fi** (phone on campus Wi-Fi, room PC on the classroom network)

19. Repeat steps 1–3 in a classroom. Tap Next and Prev about 30 times at a normal pace.
20. Tap **More** and read the **Connection** line, e.g. "ping 64 ms · tap → slide 39 ms (median of 30)". Write both numbers down. The target is tap → slide under 150 ms.
21. Do the same with the phone on cellular.

Please record results in `docs/spikes/W3.md` (a short list is fine). The things most likely to need fixing are the touch gestures in steps 5–6 and the background behaviour in steps 13–14, since those could only be tested with a mouse in a desktop browser.

---

## W4. Dual-screen mode and notes

### W3 results that shape W4

- Ben ran W3 checklist parts A–C on a real phone: connecting, driving the talk, and the failure cases all worked. Part D (the campus Wi-Fi measurement for the 150 ms acceptance) is still open.
- **Still missing: any test on two extended screens.** The W0 two-screen check has never been run on real hardware, and it can't be automated. Mode B below is built to the Chromium documentation and tested with faked screens; it must be tried on a real lectern PC with a projector before it is relied on. If window placement misbehaves there, Mode A is unaffected.

### Plan (2026-11-26)

1. **Core:** `split.ts` (Beamer second-screen notes: detection per Native §5.1(4), crop rectangles, link remapping) and `search.ts` (text search grouped by frame, Native §4.4).
2. **Shared:** crops in the render cache and slide surface, so the audience gets only the slide half and the notes pane the notes half; page text extraction for search.
3. **Mode B (SPEC §5.2).** Offered when the browser reports an extended display. Choosing it explains the permission prompt, asks for window management, and lists the screens. Start then puts the audience view full screen on the chosen screen and opens the presenter view as a second window on the other one, from the same click. The two windows talk over a `BroadcastChannel`; the audience window stays authoritative and hands the presenter window the decrypted deck in memory. If the second window can't open, the talk carries on as Mode A.
4. **Presenter view (Native §6.2):** current slide, next slide, notes (text, or the notes half of a split deck), a status bar with frame and build, clock, wall clock, room-screen state, relay status and connected remotes; Back/Forward buttons after jumps; laser pointer mode (L); click to advance; the debug overlay (Ctrl+Shift+D).
5. **Overview and search (Native §6.3, §4.4):** Tab swaps the right column for a search field and a two-column grid of frames; a click jumps at once and the overview stays open; search results are grouped by frame.
6. **Phone:** follows the room PC's split, and shows the notes half as an image for split decks.
7. **Publish tool:** `--notes-split` to record the layout in the deck.
8. **Tests:** unit tests for split and search; e2e for the presenter window with faked screens.

### Done (2026-11-26)

- **Core:** `split.ts`, `search.ts`.
- **Shared:** crops in `render-cache.ts` and `slide-surface.ts`; `thumbs.ts` (one thumbnail grid for the phone and the overview); page text for search in `deck.ts`.
- **Mode B:** `presenter-host.ts`, `presenter-channel.ts`, and the presenter window (`presenter/index.html`, `presenter.ts`). The entry screen offers "Two screens" when the browser reports an extended display, explains the permission prompt, lists the screens with the external one preselected for slides, and starts both windows from the Start click. On a single or mirrored display it shows a one-line note instead.
- **Presenter view:** current slide (click to advance, links work), next slide, notes with A−/A+, draggable divider, Laser (L), "Back to Frame X" / "Forward to Frame Y", status bar with frame and build, FROZEN/BLACK/WHITE pill, connected phones or relay trouble, clock (click to pause, Reset), wall clock; Tab for the overview with a two-column grid (current frame ringed blue, the audience's frame orange when frozen, build counts, notes marks) and search grouped by frame; Ctrl+Shift+D for the debug overlay (input → audience draw, cache misses, relay, remotes). Esc clears typed digits, then the laser, then the overview, and only then counts towards ending.
- **Notes sources complete:** Beamer second-screen notes are detected (stored setting, pdfpc hint, page shape), the audience and thumbnails get the slide half, and the notes pane (presenter and phone) shows the notes half when the slide has no text note. The entry screen says so and can turn it off. `npm run publish -- … --notes-split left|right|top|bottom|none` records the layout.
- **Tests:** 207 unit and 28 e2e, all passing. The W4 e2e tests fake the Window Management API (two screens; full screen ignores which screen) and then exercise the real second window: keys, clicks, jump by number, Back/Forward, overview, frozen rings, search, laser, black, debug overlay, keys in either window, Esc-twice from the presenter window, a phone appearing in the status bar, closing the presenter window mid-talk, and the notes split on and off.

### Known issues and notes

- **Mode B is untested on real two-screen hardware.** Three things could differ there: whether `requestFullscreen({ screen })` lands on the projector, whether the browser allows the presenter window from the same click, and whether it opens on the right screen at the right size. If the presenter window is blocked, the talk runs as Mode A with nothing shown on the PC's own monitor; allowing pop-ups for the site and starting again fixes it.
- **The presenter window is an ordinary window, not full screen**, so it has a title bar. It fills the screen's available area.
- **Keyboard focus decides which window gets keys.** Both windows handle every key, so a clicker works whichever has focus; keyboard lock for Esc applies only to the full-screen audience window.
- **Left out for now:** see the last W4 entry in `docs/decisions.md` (outline, Frames/Builds toggle, countdown editor, swap displays, appendix badge).
- **Search matches within one page's text**, once per frame; it does not highlight the match on the slide.
- **Opening a deck now keeps a second in-memory copy of the PDF** until Start (for a possible presenter window); in Mode A it is dropped at Start.
- Chromium only: Firefox and Safari have no Window Management API, so they get Mode A, as SPEC §5.2 says.

### Ben checklist: W4

Part A needs only your Mac. Part B needs two screens showing different things: a lectern PC with a projector set to extend, or your Mac with any external monitor or TV (System Settings → Displays → "Use as: Extended display"). Use Chrome or Edge. About 15 minutes.

**A. Notes split, on one screen (only if you have a Beamer deck with `show notes on second screen`)**

1. Open `benlockwood.com/talks`, click **open a PDF from this computer**, and pick such a deck.
   - Expect: "Beamer notes found on the right of each page: the audience will see only the slide part."
2. Click **Start**: only the slide half should be on screen. Esc twice.
3. Open it again, click **Show the whole page instead**, Start: the whole page, notes panel included.

**B. Two screens**

4. With the second screen attached and extended, open `benlockwood.com/talks` on your own screen (not the projector) and open a talk by its code.
   - Expect: a "Screens" box with "This screen only" and "Two screens: slides on the projector, notes and controls here". If you instead see "One screen found…", the displays are mirrored: note that, switch to extend, and reload.
5. Choose **Two screens**. Click **Choose screens** (or Start). The browser asks "…wants to manage windows on all your displays": click **Allow**.
   - Expect: both screens listed, with the external one preselected for slides. If the wrong one is selected, pick the other.
6. Click **Start**.
   - Expect: slides full screen on the projector, and a dark presenter window filling your own screen, with the current slide, the next slide, notes, and a status bar.
   - **If no presenter window appears**, the browser blocked it as a pop-up. Press Esc twice to end, allow pop-ups for the site (Chrome: Settings → Privacy and security → Site settings → Pop-ups and redirects → "Allowed to send pop-ups" → Add → `benlockwood.com`), and start again. Please note that this happened.
   - Note where each window actually landed and whether the presenter window fills its screen.
7. In the presenter window: step with → and ←, and with the clicker. Click the current slide (advances). Type a frame number and Enter, then click **Back to Frame N**.
8. Press **Tab**: the overview. Click a slide (it jumps, the overview stays). Type in the search box, press Enter on a result. Esc clears the search; Esc again closes the overview.
9. Press **L** and move the mouse over the current slide: a red dot should appear on the projector. Esc turns it off.
10. Press **B**, **F**, **T**: the status bar should show BLACK, FROZEN, and a paused clock. Press each again.
11. Press **Ctrl+Shift+D**: a small panel with "input → audience draw" numbers. Note the median. Press it again.
12. Connect your phone as in W3: the status bar should say "Phone: iPhone". Drive from the phone and check the presenter window follows.
13. Click on the projector screen's slides, then press →: it should still advance (keys work in either window).
14. Close the presenter window with its close button: the slides should stay up and → should still work. Esc twice to end.
15. Start again, and this time end with **Esc twice in the presenter window**: both windows should go, and the first window returns to the code screen.

Please record results in `docs/spikes/W4.md`. Steps 5–6 are the ones I could not test at all, so exact wording of anything unexpected there (permission prompt, blocked pop-up, window on the wrong screen) is the most useful thing to write down.

### After W4 (2026-11-26)

- Ben tried two-screen mode on his Mac with a second display: it worked (`docs/spikes/W4.md`). A classroom PC is still untried.
- Added at Ben's request: **Swap displays** (button in the presenter window; Ctrl+D or Cmd+D in either window) and the **landscape phone layout** (controls only, very large Prev/Next).
- The swap is tested only with faked screens, where a move between screens can't really happen. On real hardware the open questions are whether the browser accepts the click handed over from the presenter window, and whether it lets the presenter window be moved to the other screen. Ctrl+D pressed in the audience window needs no hand-over and is the fallback.

---

## W5. Ink and polish

### Plan (2026-11-26)

1. **Ink (SPEC §7, §8.2; Native §8).**
   - Strokes live in the session state on the room PC, in normalised slide coordinates with width relative to slide height, so they look the same on every display. The audience view redraws vectors; no bitmaps are sent.
   - Ephemeral only: ink belongs to the page it was drawn on and is cleared by leaving the page, by Clear, or by C on the keyboard. Persistent ink needs somewhere to store it, and the room PC stores nothing.
   - **Whiteboard:** the white screen becomes a board. Ink drawn while the room screen is white is kept separately for the whole talk, so Ben can go back to the slides and return to the board.
   - Phone and iPad: a Draw tool with three colours, Undo, Clear and Board. Finger or Pencil. Points are batched and streamed as `ink` messages.
   - Mode B: the presenter view shows the ink too.
2. **Service worker (SPEC §9):** caches the app shell and PDF.js so a reload works on bad Wi-Fi, and encrypted `.bin` files so a deck opened once on a device opens again offline. It never sees decrypted data.
3. **README** with the threat model (SPEC §3) and a **browser-support matrix**.
4. **Tests:** unit tests for ink and the service worker's routing; e2e for drawing from the phone, and for reloading and reopening a deck offline against the production build.

### Done (2026-11-26)

- **Ink:** `core/ink.ts`, ink in the session state and key map (C clears), `ink` messages in the protocol, `shared/ink-draw.ts`, an ink layer on the audience view, ink and the whiteboard in the presenter view, and the phone's Draw tool (three colours, Undo, Clear, Board; finger, Pencil or mouse; coalesced pointer samples; points sent in batches about 30 times a second).
- **Whiteboard:** the white screen takes ink that is kept for the whole talk.
- **Service worker:** `src/sw/sw.ts` with its routing rules in `core/sw-routes.ts`, built as `sw.js` at the top of the site with a precache list injected at build time, registered by the entry screen and the phone remote in production builds.
- **README.md** with usage, the threat model, a browser-support matrix and development notes.
- **Tests:** 237 unit and 34 e2e, all passing. New e2e tests draw from a phone page and check the pixels on the audience's ink layer by colour, Undo, clearing on page change, the board surviving a return to the slides, and C on the room keyboard clearing the phone's copy too. The offline tests run against a production build: the page reloads offline, a deck opened earlier opens and presents offline, the caches contain only app files and `LCTW` ciphertext (no PDF, no code), a republished deck replaces the cached file, a revoked deck is forgotten, and the phone remote reopens a remembered talk offline.
- **A bug the offline test found and fixed:** cached scripts were not matched after an offline reload because of the server's `Vary` header, so the page loaded but never started.

### Known issues and notes

- **Drawing has not been tried with a finger or an Apple Pencil**, only with a mouse in a desktop browser. Palm rejection is whatever the browser gives; two fingers at once draw one stroke.
- **A phone that joins or reloads mid-talk does not see ink drawn before it joined** (the audience still does). Its Undo and Clear still act on the room screen.
- **Undo removes the newest stroke on screen**, whoever drew it.
- **PDF.js's optional files** (character maps, JPEG 2000 and JBIG2 decoders, standard fonts) are cached the first time a deck needs them, not ahead of time. A deck that needs one of them for the first time while offline would show that content wrongly. Opening the deck once online on the same device, as SETUP.md's pre-talk dry run does, avoids this.
- **The service worker updates on the next visit:** after a deploy, pages are fetched fresh (network first), so a reload always gets the new version when online.
- **Swap displays is still untried on real hardware** (see the note after W4).
- **The W0 test pages are still deployed** at `/talks/w0/`. They are the tool for the outstanding classroom checks (clicker key codes on a Windows PC); remove them once those are done.
- `npm run e2e` now also builds and serves a production copy (`.e2e-dist/`, port 4173), which adds a few seconds.

### Ben checklist: W5

About 15 minutes. A published talk, your phone, an iPad if you have one, and a computer.

**A. Draw from the phone**

1. Start a talk on the computer by code and connect the phone as usual.
2. Tap **Draw**. A row appears with three colour dots, **Undo**, **Clear** and **Board**, and the slide gets an orange outline.
3. Draw on the phone's slide with a finger. Expect: the line appears on the room screen as you draw, in the same place, with no visible lag. Try each colour.
4. Tap **Undo** (the last line goes) and **Clear** (all go).
5. Draw something, then tap **Next**. Expect: the ink is gone on the new slide, and still gone if you go back.
6. Tap **Board**. Expect: the room screen turns white. Draw on it. Tap **Board** again to return to the slides, step forward a slide, tap **Board** again: your drawing is still on the board.
7. Press **C** on the computer's keyboard while ink is showing: it clears on both.
8. Tap **Draw** again to leave drawing mode, and check that swiping changes slides again.
9. If you have an iPad and Pencil: open `benlockwood.com/talks/remote` on it, connect, and repeat step 3 with the Pencil. Note whether resting your palm draws stray marks.

**B. Offline**

10. On the phone, with a talk remembered: turn on airplane mode, close the browser tab, and open `benlockwood.com/talks/remote` again. Expect: the page loads, the talk is listed, and tapping it shows the slides and notes (with "Reconnecting…" at the top, since there is no network).
11. On the computer: open a talk by code once. Then turn Wi-Fi off, reload the page, and type the code again. Expect: it opens and presents, with "Phone unavailable: keyboard and clicker only".
12. Turn the networks back on.

**C. Swap displays** (with the second display, as in W4)

13. Start in two-screen mode. In the presenter window click **Swap displays**. Expect: the slides move to the screen the presenter window was on, and the presenter window moves to the other. Click it again to swap back.
14. If the button does nothing or the status bar says "Could not swap…", click once on the slides and press Cmd+D there. Note which of the two worked, and where each window ended up.

**D. Still open from earlier**

15. The campus Wi-Fi measurement (W3 part D): phone's **More** → **Connection** line after about 30 taps.
16. A Windows classroom PC with your clicker: `benlockwood.com/talks/w0/` for the key codes, then a real talk at `benlockwood.com/talks`.

Results in `docs/spikes/W5.md`, please.

### Live check (2026-11-26)

Against `https://benlockwood.com/talks/` and the deployed relay, with a throwaway deck (published, then revoked), in headless Chromium:

- `sw.js` is served as JavaScript and takes control of the page; the caches then held 18 app files and the deck's 2 encrypted files.
- A stroke drawn on a phone-sized remote page appeared on the room page's ink layer through the real relay, and was cleared by stepping to the next slide.
- After ending the talk, with the network turned off, the entry page reloaded, the same code opened the deck again, and the page reported "Phone unavailable: keyboard and clicker only".
- No page errors.

### Where things stand

W0–W5 are built. SPEC §10 says the next step is Ben's: use it for a real talk at another institution before anything further. Open hardware checks, in rough order of importance:

1. A Windows classroom PC with a real clicker (W0 key codes, then a real talk).
2. The campus Wi-Fi latency number (W3 part D).
3. Drawing with a finger and an Apple Pencil (W5 part A).
4. Swap displays on real screens (W5 part C).
5. Firefox or Safari as the room browser.

### After W5 (2026-11-26)

- Ben's W5 feedback: all looks good; the one thing missing was drawing from the second-screen presenter view.
- **Added: Draw in the presenter window.** Draw button or D; colours, Undo, Clear, Board beside it. Ink goes through the same validation as ink from a phone. Covered by the two-screen e2e test (stroke pixels on the audience layer, Undo, switching between Draw and Laser, the whiteboard, C, Esc).
- **Ben checklist for this change** (two screens, 2 minutes):
  1. Start in two-screen mode. In the presenter window press **D** (or click **Draw**): the current slide gets an orange outline and colour dots appear.
  2. Drag on the current slide. Expect: the line appears on the projector as you draw, and the slide does not advance.
  3. Try a colour, **Undo**, **Clear**, and **Board** (white screen with its own drawing; **Board** again returns).
  4. Press **Esc** once: Draw turns off and the talk does not end. Click the slide: it advances again.

- **Ben's results (2026-11-26):** drawing from the presenter window, Swap displays on real screens, and finger drawing on the phone all work (`docs/spikes/W5.md`). MIT License added at Ben's request.
- **Remaining hardware checks:** Apple Pencil; the campus Wi-Fi latency number; a Windows classroom PC with a clicker; Firefox or Safari as the room browser.

- **W0 test pages removed (Ben, 2026-11-26):** `/talks/w0/` and `/talks/w0/phone` are gone from the site and the repo, with their source (`w0/`, `src/w0/`) and tests. Earlier sections of this file that point at those addresses are history. The relay's own checks (origins, room ids) moved into `e2e/w3.spec.ts`. To learn a clicker's key codes on a classroom PC, just present a talk with it: every key the spec lists is handled, and anything that does nothing is worth reporting.

---

## W6. One presenter view

### Why (Ben, 2026-11-26)

Until now there were three things: the audience view, the presenter window of two-screen mode, and the phone remote. The last two do the same job with two separate screens whose features had drifted apart. Ben's proposal, adopted: there is the **audience view** and there is the **presenter view**. The presenter view can be a second window on the room PC, or any other device (laptop, iPad, phone) that joins by code, and several can be open at once. It lays itself out for the screen it is on and the input it has.

Ben's decisions:
- One behaviour everywhere for picking a slide from the grid. Fable chose **jump at once** (as the native Mac app does after Ben dropped private browsing there), with Back to undo a mis-tap. The phone's preview-then-Show goes away. Easy to flip if Ben meant the other one.
- Do all of it now, before the first real talk.

### Plan

1. **Core**
   - `host.ts`: the authoritative side of a talk, with no DOM: applies commands from any presenter view, sends `state`, relays ink, tracks who is connected. The audience window uses it; so does rehearsal.
   - Protocol: `state` gains the room PC's status (relay, connected devices, draw timings) so every presenter view can show it; a new `strokes` message carries ink from the room PC to every presenter view, with a full copy for late joiners; and every talk gets a random **session id** that commands must quote, which closes the replay gap noted in W3.
2. **One presenter view** (`src/console/`, page `/talks/present`), replacing `src/remote/` and `src/room/presenter.*`. It talks to the room PC through one small interface with three implementations: the relay (joined by code), a local channel (second window on the room PC), and none at all (rehearsal).
3. **Layouts**, chosen from the window's size: wide (laptop, iPad landscape: slide, next slide and notes side by side), stacked (iPad portrait), compact (phone), and buttons only (phone held sideways). Touch gets swipes and the large buttons; a mouse gets click-to-advance and the hover laser; a pen always draws.
4. **One way in.** After typing the code at `/talks`: "Start" shows the slides on this screen; "Presenter view" opens the presenter view on this device. `/talks/remote` keeps working as an alias.
5. **Rehearse.** A presenter view with no room PC can run the talk by itself.
6. **Tests** rewritten around the one view, then every earlier hand-test repeated by Ben, since this replaces screens he has already checked on real hardware.

### Done (2026-11-26)

- **Core:** `host.ts` (the session host), and in `protocol.ts` the room status in `state`, `strokes` messages, and session ids.
- **Audience window:** `presentation.ts` rewritten around the host, with pluggable connections: the relay (`room-link.ts`) and a second window (`local-hub.ts`, which also places the window and swaps displays).
- **Presenter view:** `src/console/` (`console.ts`, `client.ts`, `main.ts`, `console.css`), page `/talks/present`. Removed: `src/remote/`, `src/room/presenter.ts`, their pages and styles. `/talks/remote` is a redirect.
- **Four layouts** from one page, switched live as the window changes.
- **New capabilities that fall out of the merge:**
  - A laptop or tablet joined by code gets the full view: overview, search, laser, drawing, timings panel.
  - Several presenter views at once, all in step.
  - Ink from any device shows on every presenter view, including ones that join late.
  - The phone gets the overview with search and the notes marks.
  - Rehearsal, by code or from a local PDF.
  - "Presenter view on this device instead" on the talk page after typing a code.
- **Tests:** 260 unit and 39 e2e, all passing. New: the host (sessions, acks, device list, ink relay and full copies, freeze), a laptop by code driving the room PC, three views at once with ink reaching each, the four layouts with nothing off screen, rehearsal both ways, a restarted room PC being followed as a new session.
- **Two bugs found by the new tests and fixed:** freezing a stale page (see decisions), and every device treating any pong as its own, which would have given wrong ping numbers with more than one presenter view.

### Known issues and notes

- **This replaced screens Ben had hand-tested**, so those checks need repeating: phone gestures, two-screen start, Swap displays, drawing by finger. The automated tests use a mouse and faked screens.
- **The phone's layout changed slightly:** room-screen state (BLACK, FROZEN, WHITEBOARD) is now a pill in the top bar rather than a badge on the slide; the slide grid has a search box and stays open after a pick.
- **Rehearsal's ink and position are not carried over** when the view then joins a real room PC; it starts from the room PC's state.
- **A pen always draws**, so on an iPad the Pencil cannot be used to swipe or tap links; a finger does those.
- **Two views drawing at once** each see their own stroke immediately and the other's as it arrives; Undo removes the newest stroke on screen, whoever drew it.
- **Still untried:** Apple Pencil, a Windows classroom PC with a clicker, the campus Wi-Fi number, Firefox or Safari as the room browser.

### Ben checklist: W6

About 20 minutes. A published talk, your laptop, your phone, an iPad if handy, and the second display for part D. Everything is at `benlockwood.com/talks` (slides) and `benlockwood.com/talks/present` (presenter view).

**A. Phone, as before** (the old `/talks/remote` bookmark still works)

1. Start a talk on a computer by code. On the phone open the presenter view with the same code.
2. Next/Prev, swipe, press-hold-drag pointer, tap a link: all as before.
3. **Slides**: tap a slide. Expect: the room screen jumps there at once (no preview step), and the grid stays open. **Close**, then **Back** returns.
4. **Black**, **Freeze**: a coloured pill appears at the top of the phone.
5. **Draw** with a finger, **Board**, **Undo**, **Clear**: as before.
6. Turn the phone sideways: two very large buttons. Lock and unlock: it reconnects.

**B. Laptop as presenter view** (the main new thing)

7. With the talk still running on the first computer, on your laptop open `benlockwood.com/talks/present` and type the code.
   - Expect: the slide large on the left, next slide and notes on the right, like the Mac app.
8. Step with the arrow keys. Click the slide (advances). Tab for the overview; type in the search box; Enter on a result.
9. Press **L** and move the mouse over the slide: the red dot appears on the room screen. Press **D** and draw with the trackpad or mouse.
10. With the phone still connected: tap Next on the phone and watch the laptop follow; draw on the laptop and watch the ink appear on the phone.
11. **More → Timings** (or Ctrl+Shift+D): the room PC's draw timings, and both devices listed.
12. Narrow the laptop's browser window until it is phone-width, then widen it again: the layout should change and nothing should be cut off.

**C. Rehearse**

13. End the talk. On the laptop, open the presenter view with the code again. It says "Waiting for the room PC". **More → Rehearse here**.
    - Expect: "Rehearsing: no room screen", the clock running, slides and notes stepping.
14. On the phone's presenter view first screen, tap **rehearse from a PDF on this device** and pick a PDF: it should run with no network.

**D. Two screens** (second display)

15. Start in two-screen mode as in W4. The second window should now be the same presenter view as in part B. Check keys, the overview, Laser, Draw.
16. **More → Swap displays**, and Cmd+D.
17. Connect the phone as well: the second window's top line should say "Slides on the other screen · 1 more device".
18. Esc twice in the second window: both windows go.

**E. iPad, if you have one**

19. Open the presenter view by code, held upright (stacked panes) and on its side (side by side).
20. With a Pencil: it should draw without tapping Draw first, while a finger still swipes.

Results in `docs/spikes/W6.md`, please. Parts A and D repeat things that worked before the rewrite; anything that used to work and now doesn't is the most important thing to report.

### Live check (2026-11-26)

Against `https://benlockwood.com/talks/` and the deployed relay, with a throwaway deck (published, then revoked), in headless Chromium: a room page, a laptop-sized presenter view at `/talks/present`, and a phone-sized one that arrived through the old `/talks/remote` address.

- Both presenter views connected and stayed in step while each drove the room page in turn.
- A stroke drawn on the laptop view appeared on the room page's ink layer.
- The laptop's timings panel showed the room page's draw timings (median 0.2 ms) and both devices.
- Phone: ping 81 ms, tap → slide 28 ms (median of 8), from a home connection.
- Esc twice on the laptop ended the talk on the room page. The laptop then rehearsed by itself.
- `/talks/presenter/` (the old second-window page) now returns 404, as intended. No page errors.

## W6.1. Changes from Ben's W6 tests (2026-11-27)

Ben's results (given in conversation): mostly works; six notes. What was done for each:

1. **No Swap displays on the laptop presenter view.** Swap exists only in the second window that two-screen mode opens, because only that window can ask the slides window to move. Not reproduced there (the e2e test still finds the button). A view joined by code on a computer with two screens now shows a "Displays" row under More saying how to get the button, instead of nothing. Open question for Ben: which way was the laptop view opened?
2. **Phone sideways:** the Slides button is gone in the buttons-only layout, and Tab does nothing there.
3. **Laptop (wide) layout:** the Slides button moved from the bottom toolbar to the top right, above the next slide, where the grid opens and where its Close button then sits.
4. **Rehearsing a published talk:** when no room screen is showing the talk, a banner says so and offers **Rehearse here** (after 2.5 s on opening; after 20 s if a talk was running, so a network blip does not offer it). The row under More stays.
5. **Clock value beside its controls** under More: the time (or time left), with the elapsed time and "paused" beneath.
6. **Count up / count down**, as in the native app: under More, **Up**, or **Down from** a typed time ("45", "45:00", "1h30"), applied as typed; Enter closes. Counting down, the top-bar clock shows the time left in place of the elapsed time (green, then red and counting up once over), with an arrow for the direction and a pause mark when paused. New command `timerSetTarget`; setting a countdown starts a paused clock.

Verification: build; 266 unit tests (new: duration parser, countdown command and its validation); 39 e2e tests (extended: countdown from the phone, the Slides button per layout, the rehearsal banner).

### Known issues

- Swap displays from a view joined by code is not possible: browsers only let a window hand its click to a window it opened.
- The last countdown typed is remembered only until the presenter view is closed.
- While rehearsing by code, the view does not notice a room screen starting; **More → Stop rehearsing** joins it.

### Ben checklist: W6.1

1. Laptop, presenter view by code, no talk running: within a few seconds a yellow line offers **Rehearse here**. Click it; arrows should step.
2. Click the clock (top right). Click **Down from**, type `1h15` or `20`, press Enter. The clock should show the time left in green with ↓. Open it again and click **Up**: back to elapsed time with ↑.
3. Same on the phone: tap the clock; the Clock line shows the current value; set a countdown.
4. Laptop: **Slides** is now above the next slide, top right. Phone sideways: no Slides button.
5. Two-screen mode on the Mac with the second display: in the second window, **More → Swap displays** should be there. If it is not, note how the window was opened.

## W7. One talk, any device, choose your view (2026-11-27)

Ben's idea after W6.1: stop having a "room PC" that runs the talk and "presenter views" that join it. Instead a talk is one running thing per code; any device joins it and chooses what it shows: **slides** (full screen, for the audience) or the **presenter view**. Rehearsing is then just a talk nobody is showing slides for yet, and a phone can join it like any other.

### Plan

1. **Core (`src/core/`)**
   - `peer.ts`: every device runs the same DOM-free `Peer`. Exactly one peer hosts the talk (runs the existing `SessionHost`); the rest follow it. Rules:
     - the first device in hosts, whatever its view;
     - a device showing slides takes over from a host that is not (so the audience screen's own keys and clicker never depend on the network, as now);
     - if the host goes (says `bye`, or is silent for 8 s), a follower takes over from the last state it heard;
     - two hosts that meet (after a network split) settle it at once: slides beat presenter view, then the longer-connected one, then the lower id. The loser follows.
   - `host.ts`: can start from a state handed over (page, history, mode, clock, ink); counts devices and how many show slides.
   - `session.ts`: the clock starts the first time the slide changes (Ben), not when the talk opens.
   - `protocol.ts`: `hello` says which view a device shows; `state` says the host's view and how long it has been connected; new `bye`.
2. **One page.** `/talks/` is the only page: code (or PDF, or a saved talk) → choose **Presenter view** or **Show slides** (this screen, or two screens). `/talks/present` redirects there. The presenter view's More sheet gets **Show slides…**, which returns to that choice without leaving the talk.
3. **Views attach to the talk.** `src/shared/talk.ts` owns the deck, the relay connection and the peer. The audience view and the presenter view both draw from it. The second window in two-screen mode stays a window of the same device.
4. **Leaving and ending.** Esc twice on the slides screen, or Close in the presenter view, leaves on that device only (and wipes it); the talk goes on for the others. **End talk** ends it for every device.
5. Remove what the new model makes meaningless: "Rehearse here", "Waiting for the room PC", the separate presenter entry screen.
6. Tests: unit tests for the peer rules with a simulated relay and clock; e2e reworked for the single page.

### Deviations from SPEC to record

- SPEC §8.2 says the room PC is authoritative. Now the host is, and the host is the slides screen whenever there is one.
- SPEC §5.1 says codes are never read from the URL on the entry screen; `#c=<code>` deep links (already supported by the presenter view) now land on the one page. The hash is never sent to a server and is removed at once.

### Done (2026-11-27)

- **`src/core/peer.ts`** (new): the rules for which device runs the talk, with no DOM and no timers of its own. `tests/peer.test.ts` runs them against a simulated relay and clock: first device hosts; a slides screen takes over with page, history, clock and ink intact; a second slides screen follows; a follower carries on when the host leaves or vanishes; a slides screen that lost the network keeps going and wins when it returns; of two presenter views that both host after a split, the one that reconnected (or was asleep) gives way; End talk reaches every device; old sessions' messages are ignored.
- **`src/core/host.ts`**: starts from a handed-over state; reports all devices (host first) and how many show slides.
- **`src/core/session.ts`**: the clock starts with the first slide change.
- **`src/shared/talk.ts`** (new): the deck, the relay connection and the peer for one device. The slides view (`src/room/presentation.ts`) and the presenter view (`src/console/`) both attach to it.
- **One page.** `index.html` holds the start page, the slides view and the presenter view; `src/room/main.ts` is the only entry script. `/talks/present` and `/talks/remote` redirect, keeping a `#c=` link.
- **Presenter view:** the top line says whether a screen is showing the slides and how many devices are in the talk; **More → Show slides…**; **Leave the talk**; **End talk** (every device). Rehearse, its banner and "Waiting for the room PC" are gone.
- Removed: `src/console/main.ts`, `src/room/room-link.ts`, the solo and relay presenter clients.

Verification: build; 290 unit tests; 39 e2e tests, of which the scenarios that changed meaning were rewritten (rehearsal joined by a phone and picked up by a slides screen; the slides screen leaving and returning; choosing and changing views; a second slides screen).

Two gaps the tests found and that are fixed: a key pressed in the first second after Show slides was lost (input now starts the talk at once if no host is known); a dropped connection was not shown on a following device until the host timed out.

### Known issues

- When the device running the talk disappears without saying so (crash, battery, network), the others wait about 8 to 10 seconds before one takes over. A deliberate leave hands over in under a second.
- If two devices both ran the talk during a network split and neither shows slides, the one that reconnected gives way and its changes during the split are lost. If one shows slides, it always wins.
- Which notes crop is used (Beamer notes on one side) is decided by whichever device starts the talk; the option is not offered when joining a talk already going.
- A presenter view in a browser window opened separately still cannot swap displays. Use **More → Show slides…** and choose the other screen instead.
- Ink drawn from the second window is carried only while that computer runs the talk (it always does unless it is a second slides screen).
- Not tested on real hardware: everything in this milestone.

### Ben checklist: W7

Everything is at `benlockwood.com/talks` now. About 20 minutes; a laptop, a phone, and a second display.

**A. Rehearse on the laptop, phone joins**

1. Laptop: open `/talks`, type the code, click **Presenter view**. Top line: "No slides screen yet". The clock shows the countdown (or 0:00) and is not running.
2. Press →. The clock starts.
3. Phone: open `/talks`, type the code (tick Remember), tap **Presenter view**. It should be on the same slide; top line "No slides screen yet · 2 devices". Step from the phone and watch the laptop follow.

**B. The slides screen joins**

4. With A still going, on another computer (or another browser window on the second display): open `/talks`, type the code. The page should say the talk is open on 2 other devices and at which frame. Click **Show slides**.
   - Expect: full screen on the slide the rehearsal was on, clock unchanged. Laptop and phone say "Slides showing · 3 devices".
5. Step from the phone, the laptop, and the slides screen's own keyboard.
6. Press Esc twice on the slides screen. It returns to the code page. Within a second the laptop and phone say "No slides screen yet · 2 devices" and still work.

**C. Two screens on one computer**

7. Laptop with the second display, in presenter view from A: **More → Show slides…**. Choose **The other screen**, allow window management, click **Show slides** (twice the first time: once for the permission).
   - Expect: slides full screen on the other display, presenter view in a window on this one, same slide as before.
8. **More → Swap displays**, and Cmd+D.
9. **More → End talk…** and confirm. Every device, phone included, returns to the start page.

**D. Network trouble** (optional, 2 minutes)

10. Slides showing on one computer, phone in presenter view. Turn the phone's Wi-Fi off for 15 seconds and on again: it should say "Reconnecting…", then recover on the current slide.
11. Close the slides screen's browser tab outright. The phone should take over within about 10 seconds.

Results in `docs/spikes/W7.md`, please.
