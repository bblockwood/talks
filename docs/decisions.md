# Decisions

Newest last. Each entry: date, decision, why.

- **2026-11-26. `docs/native-spec.md` is a copy of `~/Repos/Lectern/SPEC.md`** at Lectern commit `304d946`. The file was missing from this repo, and SPEC.md says it is copied here. Re-copy if the native spec changes in a way that matters to the web version.
- **2026-11-26. Site URL is `https://benlockwood.com/talks/`.** The user site `bblockwood.github.io` has the custom domain `benlockwood.com` with HTTPS enforced, and has no `/talks` path of its own.
- **2026-11-26. UI layer is plain TypeScript for now** (no Preact). Revisit at W3 if the phone UI gets unwieldy.
- **2026-11-26. Relay URL and CSP origin come from `VITE_RELAY_URL`** in `.env.production` / `.env.development` (committed; not secret). The CSP `<meta>` is filled in from it at build time.
- **2026-11-26. PDF.js 6 needs Node ≥ 22.13** when run under Node. The browser build is unaffected. CLAUDE.md says tools need Node ≥ 20; if the publish tool ends up importing PDF.js (e.g. for the page count), that floor rises to 22.13. To settle in W2.
- **2026-11-26. Relay is at `wss://lectern-relay.bblockwood.workers.dev`**, with `ALLOWED_ORIGINS = https://benlockwood.com`. `npm --prefix relay run deploy` passes `--env=""` so it always targets the production (top-level) environment.
- **2026-11-26. SPEC §4.5 holds: `current.json` stays on Pages.** No need to move lookups to the Worker. `tools/w0-cachetest.mjs` replaced an already-cached `current.json` via the `decks` branch and `gh workflow run`; the new content was served 31 s and 36 s after the push in two runs, which is the workflow's run time. Pages sends `cache-control: max-age=600` but purges its CDN on each deploy, so even the URL without `?t=` returned the new file at the same moment. Keep `cache: "no-store"` plus `?t=` anyway: they are what gets past the *browser's* own 10-minute cache, which this Node test doesn't have. Caveat: measured from one location (Ben's Mac), so `--wait` in the publish tool remains the real safeguard.
