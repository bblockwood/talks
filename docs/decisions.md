# Decisions

Newest last. Each entry: date, decision, why.

- **2026-11-26. `docs/native-spec.md` is a copy of `~/Repos/Lectern/SPEC.md`** at Lectern commit `304d946`. The file was missing from this repo, and SPEC.md says it is copied here. Re-copy if the native spec changes in a way that matters to the web version.
- **2026-11-26. Site URL is `https://benlockwood.com/talks/`.** The user site `bblockwood.github.io` has the custom domain `benlockwood.com` with HTTPS enforced, and has no `/talks` path of its own.
- **2026-11-26. UI layer is plain TypeScript for now** (no Preact). Revisit at W3 if the phone UI gets unwieldy.
- **2026-11-26. Relay URL and CSP origin come from `VITE_RELAY_URL`** in `.env.production` / `.env.development` (committed; not secret). The CSP `<meta>` is filled in from it at build time.
- **2026-11-26. PDF.js 6 needs Node ≥ 22.13** when run under Node. The browser build is unaffected. CLAUDE.md says tools need Node ≥ 20; if the publish tool ends up importing PDF.js (e.g. for the page count), that floor rises to 22.13. To settle in W2.
