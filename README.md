# Lectern Web

Present a PDF slide deck from someone else's lectern computer, using only its browser.

1. On your own computer, publish the deck: `npm run publish -- talk.pdf --code bunching --wait`.
2. On the room's computer, open `https://benlockwood.com/talks`, type the code, click **Audience view**.
3. On your phone, tablet or laptop, open the same address, type the same code, and choose **Presenter view**: your notes, the next slide, a clock, and the controls. Open it on as many devices as you like.

Every device that opens the same code is in the same talk, in any order. Open it on your laptop first and you are rehearsing; when the room's computer joins and shows the slides, it picks the talk up where it stands.

A USB clicker or the room's keyboard works too, and keeps working if the network drops.

The slides are encrypted before they leave your computer. The web host and the relay only ever hold ciphertext; the room computer decrypts in memory and stores nothing that is decrypted.

This is the browser companion to the native [Lectern](https://github.com/bblockwood/Lectern) app. The design is in [`docs/SPEC.md`](docs/SPEC.md); decisions made along the way are in [`docs/decisions.md`](docs/decisions.md). One-time account setup is in [`docs/SETUP.md`](docs/SETUP.md).

## Publishing

```
npm run publish -- talk.pdf [--code word] [--name slug] [--rotate-code] [--random] [--long]
                            [--notes-split left|right|top|bottom|none] [--wait]
npm run codes                    # list published decks and their codes
npm run revoke -- talk.pdf       # take a deck down
```

- **Code.** `--code` sets it. Without it, the first publish uses the PDF's file name. Republishing the same PDF keeps its code. `--random` generates four random words instead, and `--long` six.
- **Sidecars** with the same base name are picked up: `talk.pdfpc` (pdfpc notes and duration), `talk.lectern.json` (the native app's notes and settings), `talk.pptx` (PowerPoint speaker notes).
- **Codes are stored only** in `~/.config/lectern/codes.json` on your computer. A code is remembered by the PDF's full path, so use `--name` for a deck whose file moves around.
- **`--wait`** reports when the new deck is live, usually about half a minute.

## Showing the slides

- Type the code, or use **open a PDF from this device** for a deck that isn't published. That talk is given a one-word code, shown on the page; a device that enters it is sent the slides, encrypted, through the relay.
- Then choose **Audience view**, **Presenter view**, or **Both views** (two screens).
- **Keys:** → Space Page Down next; ← Page Up previous; Shift+→/← next/previous frame; a number then Enter jumps to that frame; Delete goes back after a jump; B or `.` black; W white (the whiteboard); F freeze; T pause the clock; C clear ink; Esc twice leaves the talk on this computer.
- **Both views** (Chrome or Edge, displays set to extend): click it, allow window management, check the screens, click it again. Slides go full screen on the projector and the presenter view opens in a second window on the other screen, with **Swap displays** (Ctrl+D or Cmd+D) at its bottom right.
- If the slides drop out of full screen they stay in the window and keys still drive them; move the mouse for a **Full screen** button.
- Leaving wipes the slides from this computer's memory and returns to the code screen; the talk goes on for your other devices. **More → End talk** in the presenter view ends it on every device. Use a private window on a shared computer.
- The computer showing the slides runs the talk, so its keyboard and clicker keep working if the network drops.

## The presenter view

One view for you, on whatever you have: your laptop or tablet on the lectern, your phone in your hand, or a second window on the computer showing the slides. Several can be open at once, and they all stay in step.

- **It fits the screen.** A laptop or a tablet on its side gets the slide, the next slide and notes side by side; a tablet upright stacks them; a phone gets a compact column; a phone held sideways shows just two very large buttons.
- **Stepping:** arrow keys, Space, Page Up/Down or a clicker; click the slide with a mouse; swipe, or tap Next/Prev, on a touch screen.
- **Slides** (Tab) shows every frame, with search. Picking one jumps there at once; **Back** returns.
- **Pointer:** press and hold on the slide, then drag. With a mouse, **Laser** (L) points wherever the mouse goes.
- **Draw** (D) writes on the slide in three colours, or on a whiteboard (**Board**). A pen always draws, without turning Draw on. Everyone's ink shows on every presenter view.
- **More** has the clock, the whiteboard, notes size, connection numbers, and **End talk**.
- **Rehearse** by opening the talk in the presenter view with no screen showing slides; other devices can join. The top line says "No slides screen yet". The clock starts with the first slide change.
- **More → Show slides…** returns to the choice of views without leaving the talk, to put the slides on this device's screen or its second screen.
- Tick **Remember on this device** to reopen a talk with one tap. Do that only on your own devices.

## Security: what this does and does not protect

Everything is derived from the talk code: the deck's address, the key that decrypts it, the relay room, and the key for messages between phone and room computer (PBKDF2-SHA256 with 600,000 iterations, then HKDF; AES-256-GCM).

- **It stops casual discovery and a curious host or relay operator.** A published deck sits at an unguessable-looking address and is unreadable without the code. Relay messages are encrypted end to end.
- **It does not stop a determined attacker**, and with a short code it does not stop a casual one who guesses the word. The default here is one word chosen for the talk, for convenience: treat such a deck as roughly public, and revoke it when it is no longer needed. Anyone who knows the code can also drive or end the talk from the remote page.
- **For a deck that matters**, publish with `--random` (four words from the EFF short list, about 41 bits) or `--random --long` (six words, about 62 bits). Even those are not a defence against a well-resourced offline attack with GPUs; do not publish confidential material this way.
- Each talk session has a random id that every command must quote, so commands recorded in an earlier session cannot be replayed into a later one.
- The room computer keeps only the encrypted deck file in the browser's cache (so a reload works offline). A private window discards even that when it closes.

## Browser support

Checked at run time; missing features degrade rather than fail. "Tested" means actually tried; the rest follows from which APIs each browser has, and has not been tried.

| | Chrome / Edge (desktop) | Firefox | Safari (macOS) | Safari (iPhone, iPad) |
|---|---|---|---|---|
| Present by code or from a file | Tested (Chrome, macOS) | Expected | Expected | n/a |
| Full screen from Start | Tested | Expected | Expected | n/a |
| A stray Esc cannot leave full screen (keyboard lock) | Tested | No: one Esc leaves full screen; the talk continues and the next key press re-enters | No: same | n/a |
| Screen stays awake (wake lock) | Tested | Expected | Expected | Tested on the remote |
| Two-screen mode, Swap displays, drawing from the presenter window | Tested on a Mac with a second display | No (no Window Management API): one screen only | No: one screen only | n/a |
| Presenter view on another device | Tested at phone, tablet and laptop sizes | Expected | Expected | Earlier version tested on Ben's phone |
| Draw from phone or tablet | Tested with a mouse | Expected | Expected | Tested with a finger on Ben's phone; not yet with a Pencil |
| Works offline after first use | Tested | Expected | Expected | Expected |

Not yet tried anywhere: a Windows classroom PC, a hardware clicker, and Firefox or Safari as the room browser.

## Development

```
npm ci && npm --prefix relay ci
npm run dev                      # http://localhost:5173/talks/
npm --prefix relay run dev       # local relay on :8787
npm test                         # unit tests (Vitest)
npm run e2e                      # end-to-end tests (Playwright, Chromium)
npm run build
npm --prefix relay run deploy    # needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID
```

Node 22.18 or newer. The tools are TypeScript run directly by Node and share the crypto code with the browser; `fixtures/crypto-vectors.json` pins the scheme and is checked in both.

```
src/core/      logic with no DOM: frames, session, links, keys, crypto, protocol, notes, ink, search
src/room/      entry screen and audience view (the room's computer)
src/console/   the presenter view, on any device
src/shared/    PDF.js adapter, render cache, relay client
src/sw/        service worker
relay/         Cloudflare Worker and Durable Object
tools/         publish, codes, revoke
fixtures/      test decks
docs/          specs, decisions, progress, test results
```

Pushing to `main` deploys the site with GitHub Actions. Published decks live on the orphan `decks` branch, rewritten as a single commit on each publish.

## License

Lectern Web is released under the MIT License; see `LICENSE`. The Lectern name is not part of that grant, so please give a fork its own name. The test decks under `fixtures/` come from the native Lectern app's corpus. PDF.js (Apache-2.0) and fflate (MIT) are bundled under their own licenses.
