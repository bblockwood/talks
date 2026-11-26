# Lectern Web: Spec (v0.1)

*A browser version of Lectern for presenting on someone else's in-room computer.*

- **Owner:** Ben. **Builder:** Fable via Claude Code.
- **Repo:** `talks`. The repo name becomes the URL path.
- **Hosting:** GitHub Pages at `https://<ben's domain>/talks/`, plus a Cloudflare Worker relay.
- **Native spec:** this document builds on the native app's spec, copied into this repo at `docs/native-spec.md`. Sections cited as "Native §x" refer to it. Where this spec is silent, Native wins.

---

## 1. Goal and the one-sentence flow

Ben walks up to an unfamiliar lectern PC that has only a browser, and:
1. Opens `<domain>/talks`.
2. Types a short talk code.
3. Clicks **Start**.

The slides go full screen on the room's display. His phone becomes the presenter console, connected through the relay, showing notes, timer, the next slide, thumbnails and a pointer. A plugged-in clicker or the room keyboard also works.

### 1.1 Principles

These are Native §1.1, adapted for the browser:

1. **Never fail on stage.** If the relay or network dies, the room PC keeps presenting with keyboard or clicker control.
2. **The audience sees only what the presenter commits.** Pairing status, errors and toasts never appear on the audience view.
3. **Instant advance.** Render ahead; never show a partially rendered page on the audience view.
4. **Leave no trace on the room PC.** Decrypted slides live only in memory. Nothing decrypted is written to storage, and "End" wipes the session.
5. **Zero server trust.** GitHub Pages serves only encrypted decks. The relay forwards only ciphertext it cannot read.

### 1.2 Non-goals (v1)

- Apple Watch control. Later it can come via the native iPhone app joining the relay (§12).
- Editing notes on the room PC.
- Any browser older than about two years.

---

## 2. Stack

- TypeScript (strict) with Vite for the build.
- `pdfjs-dist` for PDF rendering and annotations.
- `fflate` for the deck payload zip.
- A small UI layer: plain TypeScript, or Preact if Fable prefers. No other runtime dependencies without asking Ben.
- **Relay:** a Cloudflare Worker with a Durable Object, in TypeScript, under `relay/`.
- **Tests:** Vitest for unit tests, Playwright (Chromium) for end-to-end tests.
- Self-host every asset, including PDF.js and its worker and fonts. **No CDNs at runtime and no analytics.**
- Add a `<meta http-equiv="Content-Security-Policy">` (Pages can't set headers) restricting:
  - `connect-src` to self plus the relay origin;
  - `script-src` and `worker-src` to self.

---

## 3. Cryptography and identifiers

Everything derives from the **talk code**.

**Code format.** One talk-relevant word chosen by Ben at publish time, e.g. `bunching` (Ben, 2026-11-26: expediency over security; see `docs/decisions.md`). `--random` generates four words from the EFF short wordlist instead, hyphen-separated, e.g. `otter-maple-quiz-lunar`, and `--long` six.

**Normalization.** Lowercase, trim, and treat any run of spaces or hyphens as one hyphen.

**Base key.** `base = PBKDF2-SHA256(normCode, salt = "lectern-web-v1", iterations = 600000, 256 bits)`. This is the only expensive step, run once per device per session.

**Derived values.** Use HKDF-SHA256 from `base` with these `info` strings:

| info | Output | Use |
|---|---|---|
| `deck-id` | 16 bytes → hex | Public path `d/<deckId>/` |
| `deck-key` | AES-256-GCM key | Decrypts the deck payload |
| `room-id` | 16 bytes → hex | Relay room name |
| `channel-key` | AES-256-GCM key | Encrypts relay messages end to end |

Rationale: ids are derived through the expensive KDF, so a public `deckId` can't be cheaply brute-forced back to a code.

Threat model: this stops casual discovery and a curious relay operator. It is not a defense against a determined offline attacker with GPUs. Say so in the README, and offer a `--long` option for six-word codes.

Use WebCrypto in both the browser and the publish tool (Node ≥ 20 provides `crypto.subtle`), so there is one implementation and one shared test vector suite.

---

## 4. Deck storage and publishing

### 4.1 Public layout (served by Pages)

```
/talks/                       app shell (index.html, assets, service worker)
/talks/d/<deckId>/current.json  {"v":1,"file":"<sha256-16>.bin","bytes":N,"published":"ISO8601"}
/talks/d/<deckId>/<sha256-16>.bin  encrypted payload
```

- `current.json` must contain no title or other identifying metadata.
- Keep the current `.bin` plus the one before it, for rollback. Delete older ones.

### 4.2 Encrypted file format (`.bin`)

```
magic   "LCTW"            4 bytes
version 0x01              1 byte
iv                        12 bytes (random per publish)
ciphertext                AES-256-GCM(deck-key, iv, payload), tag appended
```

The payload is a ZIP (stored, no compression) containing:
- `deck.pdf` (required).
- `meta.json`: title, published time, source filename, page count, and settings such as target duration and end-of-talk page.
- `notes.json` (optional): `{ "pages": [ { "index": 0, "text": "markdown" } ] }`. This is extracted from a sibling `.pptx` at publish time, using Native §5.1(5) rules.
- `deck.pdfpc` (optional): a sibling pdfpc file copied verbatim.

### 4.3 Repo branches and deploy

- **`main`** holds the app source, `relay/`, `tools/` and the Pages workflow.
- **`decks`** is an orphan branch containing only `d/`. Each publish rewrites it as a single commit and force-pushes. This keeps encrypted PDFs out of history, so the repo doesn't bloat with every last-minute fix.
- **Workflow** `.github/workflows/deploy.yml`, triggered on push to `main` and on `workflow_dispatch`:
  1. Build the app.
  2. Check out `decks` into `dist/d/`.
  3. Upload the Pages artifact and deploy with `actions/deploy-pages`.
- A push to the orphan `decks` branch can't trigger the workflow, because the workflow file isn't on that branch. The publish tool therefore calls `gh workflow run deploy.yml --ref main` after pushing.
- Set Vite's `base` to `/talks/`.

### 4.4 Publish CLI (`npm run publish -- <file.pdf> [options]`)

- **Sidecars.** Pick up same-basename `.pptx` (extract its notes to `notes.json`), `.pdfpc`, and `.lectern.json` (settings and notes overrides, Native §3.4).
- **Codes.**
  - The first publish of a deck generates a code. Store `{absolute source path or deck name → code}` in `~/.config/lectern/codes.json`, outside the repo, mode 0600.
  - Republishing keeps the same code.
  - `--rotate-code` makes a new code and deletes the old deck.
  - `--name <slug>` keys the code by name instead of path.
- **Steps.** Build the payload, encrypt it, write it under `d/<deckId>/`, prune old versions, commit to `decks`, force-push, and trigger the deploy.
- **Output.** Print the code, the URL, and the room-PC instructions in one line, e.g. `Code: otter-maple-quiz-lunar → https://<domain>/talks`.
- `--wait` polls `current.json` (cache-busted, §4.5) until the new file is live, then reports how long it took.
- **Other commands.**
  - `npm run codes` lists decks and their codes.
  - `npm run revoke -- <name|file>` removes a deck.
- **Never** print, log or commit codes anywhere except stdout and `codes.json`.

### 4.5 Caching

- GitHub Pages caches files for about 10 minutes, and this is expected.
- `.bin` names are content-hashed, so they never go stale.
- Fetch `current.json` with `cache: "no-store"` and a `?t=<now>` query string.
- **Verify in milestone W0** that this returns a freshly published file within a minute. If Pages' CDN ignores the query string, move `current.json` lookups to the Worker, using Workers KV or Durable Object storage. Record the result in `docs/decisions.md`.

---

## 5. Room PC experience

### 5.1 Entry screen (`/talks/`)

- One large code field with `autocomplete="off"` and `spellcheck="false"`. Codes are never accepted in the URL on this screen.
- After the code is entered:
  - Derive the keys (show "Unlocking…", about 1 s).
  - Fetch `current.json`, then the `.bin`.
  - Decrypt and unzip in memory, and parse with PDF.js.
- Show the deck title (from `meta.json`), page count, and a mode choice (§5.2).
- Show a big **Start** button. It is the user gesture that fullscreen requires.
- **Errors**, in plain language:
  - Wrong code (decryption fails or no deck at that path): "No talk found for that code".
  - Network failure.
  - Unsupported browser.
- Show a small privacy hint suggesting a private/InPrivate window, plus the relay status ("Phone can connect" or "Phone unavailable: keyboard and clicker only").

### 5.2 Modes

**A. Audience-only (default).**
- Start makes the audience view full-screen on the current display.
- Controls come from the phone, keyboard or clicker. There is no presenter view on the room PC.

**B. Dual-screen.**
- Offered only when the Window Management API reports two or more screens.
- Start opens the audience view full-screen on the chosen screen, using `window.getScreenDetails()` and `element.requestFullscreen({ screen })`. The presenter view (Native §6.2 layout) goes on the other screen.
- Explain the permission prompt before it appears: "Your browser will ask to manage windows — click Allow".
- If displays are mirrored, the API reports one screen, so offer Mode A only, with a one-line note.
- The two windows are same-origin and communicate via `BroadcastChannel`. Each window renders independently at its own resolution.

**Non-Chromium browsers.** Use Mode A with the standard Fullscreen API. If fullscreen fails, show "press F11".

### 5.3 While presenting

- **Keyboard lock.** Engage `navigator.keyboard.lock(["Escape"])` in fullscreen where supported, so a stray Esc (some clickers send one) doesn't exit. Ending requires holding Esc, or pressing Esc twice within 1 s (Native §6.5).
- **Key map.** Same as Native §6.5. Clickers' Page Up/Down, B or `.`, and F5 must work.
- **Mouse.**
  - Hide the cursor on the audience view after 2 s idle.
  - Clicks on link areas follow links (§6.3). Clicks elsewhere do nothing in the audience view.
  - In Mode B, a pointer mode toggles with L (Native §6.4).
- **Wake lock.** Request a screen wake lock (`navigator.wakeLock`) and re-request it on visibility change.
- **End.**
  - Exit fullscreen.
  - Close the relay socket.
  - Drop every reference to decrypted data and clear canvases.
  - Navigate to the entry screen.
  
  Do the same on `pagehide`.

---

## 6. Document behavior

Shared with Native. Implement in `src/core/` with no DOM dependencies, so it is unit-testable.

### 6.1 Frames and builds

Frames are runs of identical page labels from `pdf.getPageLabels()`, per Native §4.1. Implement `previousFrame` → last build and `nextFrame` → first build exactly as Native §3.2.

### 6.2 Notes

Merge order:
1. `meta.json` / `.lectern.json` overrides.
2. `.pdfpc` (verify its format against pdfpc's docs and source).
3. PDF text annotations from `page.getAnnotations()`, matching the shapes produced by the pdfpc LaTeX package and by pdfcomment.
4. Beamer second-screen split (Native §5.1(4)).
5. `notes.json`.

Notes annotations are never drawn: render pages with PDF.js annotation rendering disabled, and use custom hit-testing for links.

### 6.3 Links

From `getAnnotations()`, link annotations give a rect plus one of: `dest` (resolve named destinations via `getDestination`), a named action, or a URL.
- Lay invisible hit regions over the slide in both the audience and presenter views, and over the phone's slide image.
- GoTo and named actions map to Commands and push history (Native §4.3).
- URLs are ignored by default. Optionally show "Open link?" on the presenter or phone only — never on the audience view.

### 6.4 Rendering

- PDF.js parses in its worker. Render ahead into offscreen canvases or ImageBitmaps at the exact target pixel size (devicePixelRatio-aware).
- Prefetch the current page ±2, the first page of the next frame, and the back target (Native §3.3).
- Swap the finished bitmap onto the visible canvas in one draw. On a cache miss, keep the old image until the new one is ready.
- Fill white behind every page. Letterbox on black.
- Instrument with `performance.mark`/`measure` from key or remote command to audience draw. Show an on-demand debug overlay (Ctrl+Shift+D, presenter view only).

### 6.5 Other

- Black, white and freeze screen, the overview with search and jump-by-number, and the timer and pace indicator all work as in Native.
- The phone is the primary place for the overview in Mode A.

---

## 7. Phone remote (`/talks/remote`)

- **Access.** Ben opens it on his phone and enters the same code. An optional "Remember on this device" stores it in localStorage on his own phone only, so he can tap a saved talk next time. A deep link `…/remote#c=<code>` is allowed here, since the hash is never sent to servers.
- **Deck.** The phone downloads and decrypts the same `.bin` itself, so it renders slides and thumbnails locally. Only small messages cross the relay.
- **Connection.** It connects to the relay room. When the room PC is connected, the status shows "Connected to room PC", with round-trip time.
- **UI (portrait)**, designed for one-handed use, with no accidental-tap traps near the edges:
  - Current slide with build indicator.
  - Next slide.
  - Notes (Markdown, adjustable size).
  - Timer, with elapsed, remaining and pace colors.
  - Huge Next/Prev targets.
- **Gestures:**
  - Swipe left or right for next/previous.
  - Long-press or drag on the current slide to move the pointer.
  - Tap a link region on the slide to follow it.
- **Sheets:**
  - Thumbnails grid. Tapping a frame **previews on the phone only**; a second "Show" button commits it (private browse, Native §6.3).
  - Back (history).
  - Black/freeze toggles.
  - Draw mode (W5): finger or Pencil ink streamed to the audience.
- **Background behavior.** Keep the screen awake with the Wake Lock API where supported (iOS Safari supports it). On returning from background, reconnect automatically and resync state from the room PC.
- **Lifecycle.** "End talk" sends `end` to the room PC, which exits per §5.3, after a confirm on the phone.

---

## 8. Relay protocol

### 8.1 Transport

- Endpoint: `wss://<relay-host>/room/<roomId>`, where `roomId` is 32 hex characters.
- The relay forwards each **binary** frame from one socket to every other socket in the room, verbatim. It never parses payloads.
- **Frame format:** `iv (12 bytes) || AES-256-GCM(channel-key, iv, JSON)`, with a fresh random iv per frame.

### 8.2 Message JSON

Every message carries `{ "sid": <sender session id, random 64-bit>, "seq": <uint, increments per sender>, "type": …, "body": … }`. Receivers drop a message if its `seq` is not greater than the last seen for that `sid`.

| type | from → to | body |
|---|---|---|
| `hello` | any → all | `{role: "room"\|"presenter"\|"remote", device, appVersion}` |
| `state` | room → all | `{page, frameLabel, build, builds, pageCount, audienceMode, history, timer, deckPublished}` |
| `command` | remote/presenter → room | Native Command, e.g. `{name:"next"}`, `{name:"goToPage", page:12}` |
| `pointer` | remote/presenter → room | `{x, y, visible}`, normalized 0–1, throttled to ≤ 60 Hz |
| `ink` | remote → room | stroke begin/append/end with normalized points (W5) |
| `ping` / `pong` | any | `{t}`, for RTT display |
| `end` | remote → room | `{}` |

- The room PC is authoritative. It applies commands and broadcasts `state` after every change, plus once every 5 s as a heartbeat.
- The room PC sends `state` whenever it receives `hello`, so late joiners sync.
- **Deck mismatch.** If `deckPublished` differs from the phone's copy (Ben republished), the phone shows "Slides updated — reload?".
- **Authorization.** Anyone who can decrypt is authorized, since knowing the code is the credential. The room PC accepts commands from any valid sender. Show connected remotes only on the presenter view and the phone.

### 8.3 Relay behavior (`relay/`)

- **Routing.** A Worker routes `/room/:id` to a Durable Object via `idFromName(id)`. Validate that `id` matches `^[0-9a-f]{32}$`.
- **Origins.** Accept the WebSocket upgrade only if `Origin` is in `ALLOWED_ORIGINS` (a wrangler var). Include `http://localhost:5173` for development only, via a separate dev environment.
- **Hibernation.** Use the WebSocket Hibernation API (`ctx.acceptWebSocket`, `webSocketMessage`, `webSocketClose`) so idle rooms cost nothing.
- **Limits per room:**
  - At most 8 sockets.
  - Frames of at most 64 KB; drop binary frames above that, and all text frames.
  - Per socket, at most 120 frames/s; over that, drop frames and, if sustained, close with code 1008.
  - Close sockets idle for 2 h.
- **No storage.** No payload logging. Log only counts and errors.
- **Free tier.** The Durable Object class must be SQLite-backed (`new_sqlite_classes` in the migration) so it runs on the Workers Free plan. Verify against current Cloudflare docs.
- **Health check.** `GET /health` returns `ok`.

### 8.4 Client resilience

- Reconnect with exponential backoff and jitter, from 0.5 s up to 10 s.
- Show status on the phone and presenter only.
- The room PC never blocks on the relay: keyboard and clicker always work.

---

## 9. Offline and storage

- A service worker caches the app shell and PDF.js so a reload works on flaky Wi-Fi. It may cache **encrypted** `.bin` files; it must never store decrypted data.
- localStorage is used only on the phone (saved codes, notes font size), and only when the user opts in. On the room PC, nothing beyond the service worker cache.

---

## 10. Milestones

### W0. Lectern-PC smoke test

Throwaway; deploy to `/talks/w0/`. A minimal page that:
- Loads a bundled, unencrypted test PDF with PDF.js.
- Offers a Start button for fullscreen.
- Tests Window Management two-screen placement and keyboard lock.
- Logs every key event (to check clicker codes).
- Includes a relay echo test with a phone page showing RTT.

Also verify the §4.5 cache-busting behavior.

Ben runs it on a Wharton classroom PC and at least one other machine, and records results in `docs/spikes/W0.md`. Fable writes the exact checklist for him.

### W1. Core viewer

- Mode A presenting from an unencrypted local test deck.
- Render cache, frames and builds, links and back stack, black/white/freeze.
- Keyboard and clicker controls, wake lock, End/wipe.
- Unit tests for core.

### W2. Publishing and encryption

- §3–4 end to end: the publish CLI, the orphan `decks` branch, the workflow, code entry and errors.
- Crypto test vectors shared between Node and the browser.
- Accept: from a clean machine, `npm run publish -- fixture.pdf --wait` makes the deck openable at the URL with its code.

### W3. Relay and phone remote

- The Worker, end-to-end encrypted messaging, the §7 UI, thumbnails with private browse, pointer, timer and notes.
- Accept: median phone-tap → audience-draw under 150 ms on campus Wi-Fi, measured, and automatic recovery from relay loss.

### W4. Dual-screen mode and notes

- Mode B, the presenter view, all notes sources, and the overview and search on the presenter view.

### W5. Ink and polish

- Phone and iPad ink and whiteboard, the service worker, the browser-support matrix, and a README.

**→ Ben uses it for a real talk at another institution before anything further.**

### Later

- The native iPhone/iPad app joins as a relay client using the §8 protocol, which enables Watch control via the iPhone.
- Optional Tauri packaging for installed use.

---

## 11. Test fixtures

Reuse Native §12 fixtures 1–9 and 11, adding:
- **12. `encrypted-sample.bin`**, with known test vectors for a fixed code and fixed iv. Test-only, never deployed.

---

## 12. Open decisions (Ben)

- Repo/path name (`talks`).
- ~~Code length default: four words, or six?~~ Decided 2026-11-26: one chosen word.
- Should the phone remote also allow ink in W3, or wait for W5?
