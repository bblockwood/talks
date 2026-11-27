# CLAUDE.md: Lectern Web (`talks` repo)

You are building the browser version of Lectern.

- **docs/SPEC.md is the source of truth.** `docs/native-spec.md` (the native app's spec) fills any gaps.
- Ask Ben before deviating from either, and record decisions in `docs/decisions.md`.

## Owner

Ben is an experienced LaTeX/Beamer user who works mostly in the terminal, often over SSH from an iPad.
- Prefer command-line steps.
- He is not a web developer, so explain any browser or dashboard step you ask him to do.

## Layout

```
src/core/      DOM-free logic: frames, notes merge, links, history, commands, crypto, protocol
src/room/      the one page: open a talk, choose a view; the slides (audience) view
src/console/   the presenter view, on any device or in the second window
src/shared/    rendering, relay client, UI bits
relay/         Cloudflare Worker + Durable Object (own package.json, wrangler.toml)
tools/         publish, codes, revoke CLIs (TypeScript run directly by Node ≥ 22.18)
fixtures/      test decks (see SPEC §11)
docs/          native-spec.md, decisions.md, progress.md, spikes/
```

## Commands

- Setup: `npm ci` and `npm --prefix relay ci`.
- Dev: `npm run dev` (Vite, http://localhost:5173/talks/) and `npm --prefix relay run dev` (`wrangler dev`).
- Tests: `npm test` (Vitest) and `npm run e2e` (Playwright, Chromium).
- Build: `npm run build`.
- Relay deploy: `npm --prefix relay run deploy`. This needs `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in the environment; see SETUP.md.
- Publish: `npm run publish -- <file.pdf> [--wait]`.

## Rules

- **Allowed dependencies:**
  - Runtime: `pdfjs-dist`, `fflate`, and optionally `preact`.
  - Dev: `vite`, `typescript`, `vitest`, `@playwright/test`, `wrangler`, `@types/node`.
  - Ask before adding anything else.
- **No CDNs, analytics, or third-party requests at runtime.** Self-host PDF.js assets.
- **Never** log, print (except the publish tool's stdout), commit, or store talk codes or decrypted deck contents. Only `~/.config/lectern/codes.json` holds codes.
- **Never** write decrypted data to any storage on the room PC.
- **The audience view never shows** status, errors, toasts, or the cursor beyond the idle timeout.
- Crypto uses WebCrypto only, with identical code paths in Node and the browser, and must pass the shared test vectors.
- TypeScript strict mode, no `any` in `src/core/`.

## Working loop

1. **Plan.** At the start of a milestone, write the plan in `docs/progress.md`.
2. **Verify.** Build, then run unit and e2e tests, after every meaningful change. Don't report done otherwise.
3. **Report.** At the end of each milestone, append what was done, known issues, and a **Ben checklist** with exact steps for real-hardware tests:
   - Classroom PC.
   - Projector.
   - Clicker.
   - Phone on campus Wi-Fi and on cellular.

## Ben does these (don't attempt)

- Cloudflare account and API token, and GitHub Pages settings (SETUP.md).
- Tests on real lectern PCs and his phone.
- Choosing whether decks are ever unencrypted (they aren't, by default).

## Gotchas

- **Fullscreen and window placement need a user gesture.** Start them only from the Start click handler.
- **Window Management:** `getScreenDetails()` triggers a permission prompt in Chromium. Mirrored displays look like one screen.
- **Base path is `/talks/`.** Every asset and service worker URL must respect it.
- **Caching:** Pages caches about 10 min, so follow SPEC §4.5 and the W0 findings.
- **Deploy trigger:** the orphan `decks` branch can't trigger the workflow, so the publish tool triggers it via `gh workflow run`.
- **Verify, don't guess.** Check browser API support (keyboard lock, wake lock, window management) at runtime and degrade gracefully. Check current docs rather than assuming API details.
