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
