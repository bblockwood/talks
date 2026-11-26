// Presenter view entry. Three ways in (SPEC §5.2, §7):
// - a second window opened by the room PC in two-screen mode (`#ch=<channel>`): no code needed,
//   the deck is handed over in memory;
// - any other device, by talk code (typed, remembered on this device, or `#c=<code>`);
// - a PDF picked on this device, to rehearse with no room screen.
// A URL hash is never sent to any server.
import { strFromU8 } from "fflate";
import { normalizeCode } from "../core/code";
import type { TalkKeys } from "../core/crypto";
import { parsePdfpc, targetDurationMs } from "../core/notes";
import { chooseSplit } from "../core/split";
import { DeckError, openDeck } from "../shared/deck";
import type { Deck } from "../shared/deck";
import { NetworkError, NoTalkError, fetchDeck } from "../shared/fetch-deck";
import { SWAP_MESSAGE, channelNameFromHash } from "../shared/local-channel";
import { registerServiceWorker } from "../shared/register-sw";
import { RelayClient } from "../shared/relay-client";
import { LocalClient, SoloClient } from "./client";
import type { ConsoleClient } from "./client";
import { PresenterConsole } from "./console";
import type { NoteSources } from "./console";
import { forget, loadNotesSize, loadSaved, remember, saveNotesSize } from "./saved";

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

const entry = $("entry");
const chooser = $("chooser");
const consoleEl = $("console");
const status = $("status");
const codeInput = $<HTMLInputElement>("code");
const rememberBox = $<HTMLInputElement>("remember");

let active: PresenterConsole | null = null;
let busy = false;

function setStatus(text: string, error = false): void {
  status.textContent = text;
  status.classList.toggle("error", error);
}

function showSaved(): void {
  const box = $("saved");
  const talks = loadSaved();
  box.replaceChildren();
  box.hidden = talks.length === 0;
  if (talks.length === 0) return;
  const heading = document.createElement("h2");
  heading.textContent = "Saved on this device";
  box.append(heading);
  for (const talk of talks) {
    const row = document.createElement("div");
    row.className = "saved-row";
    const open = document.createElement("button");
    open.className = "talk";
    const title = document.createElement("span");
    title.textContent = talk.title;
    const code = document.createElement("small");
    code.textContent = talk.code;
    open.append(title, code);
    open.addEventListener("click", () => void openTalk(talk.code, true));
    const drop = document.createElement("button");
    drop.textContent = "Forget";
    drop.addEventListener("click", () => {
      forget(talk.code);
      showSaved();
    });
    row.append(open, drop);
    box.append(row);
  }
}

function showEntry(message = "", error = false): void {
  active?.destroy();
  active = null;
  consoleEl.hidden = true;
  entry.hidden = false;
  chooser.hidden = false;
  showSaved();
  setStatus(message, error);
}

function showConsole(): void {
  setStatus("");
  codeInput.value = "";
  entry.hidden = true;
  consoleEl.hidden = false;
}

const handlersFor = () => ({
  onMessage: (envelope: Parameters<PresenterConsole["onMessage"]>[0]) => active?.onMessage(envelope),
  onStatus: (s: Parameters<PresenterConsole["onStatus"]>[0]) => active?.onStatus(s),
});

function reportOpenError(e: unknown): void {
  if (e instanceof NoTalkError) showEntry("No talk found for that code.", true);
  else if (e instanceof NetworkError) showEntry("Could not reach the server. Check the connection and try again.", true);
  else if (e instanceof DeckError) showEntry(e.message, true);
  else showEntry("Something went wrong opening that talk. Try again.", true);
}

/** Joins a published talk by its code. With no room PC there yet, the view can rehearse by itself. */
async function openTalk(rawCode: string, keep: boolean): Promise<void> {
  const code = normalizeCode(rawCode);
  if (busy || code === "") return;
  busy = true;
  chooser.hidden = true;
  try {
    const { payload, keys } = await fetchDeck(code, import.meta.env.BASE_URL, (step) =>
      setStatus(step === "unlocking" ? "Unlocking…" : "Loading slides…"),
    );
    setStatus("Opening slides…");
    const deck = await openDeck(payload.pdf.slice().buffer);
    const pdfpcText = payload.pdfpc ? strFromU8(payload.pdfpc) : null;
    const pdfpc = pdfpcText ? parsePdfpc(pdfpcText) : null;
    // The same guess the room PC makes; once connected, this view follows what the room PC reports.
    deck.setSplit(chooseSplit(payload.meta.settings.notesSplit, pdfpc?.notePosition ?? null, deck.pageSize.width, deck.pageSize.height));
    if (keep) remember(code, payload.meta.title || code);

    const notes: NoteSources = { noteOverrides: payload.meta.noteOverrides, pdfpcText, pptxNotes: payload.notes?.pages ?? [] };
    const targetMs = targetDurationMs(pdfpc, payload.meta.settings.targetDuration);
    const relay = (talkKeys: TalkKeys): ConsoleClient =>
      new RelayClient({ roomId: talkKeys.roomId, channelKey: talkKeys.channelKey, role: "presenter", ...handlersFor() });

    active?.destroy();
    showConsole();
    active = new PresenterConsole(
      {
        deck,
        notes,
        published: payload.meta.published,
        remember: true,
        loadNotesSize,
        saveNotesSize,
        onLeave: () => showEntry(),
        // The code stays in this closure, in memory, only so a republished deck can be fetched again.
        onReload: () => {
          showEntry();
          void openTalk(code, false);
        },
        onRehearse: (on) =>
          active?.setClient(on ? new SoloClient(deck, targetMs, { ...handlersFor(), onEnd: () => active?.setClient(relay(keys)) }) : relay(keys)),
      },
      relay(keys),
    );
  } catch (e) {
    reportOpenError(e);
  } finally {
    busy = false;
  }
}

/** Rehearses from a PDF on this device: no code, no room screen, nothing leaves the device. */
async function rehearseFile(file: File): Promise<void> {
  if (busy) return;
  busy = true;
  chooser.hidden = true;
  setStatus("Opening…");
  try {
    const deck = await openDeck(await file.arrayBuffer());
    deck.setSplit(chooseSplit(undefined, null, deck.pageSize.width, deck.pageSize.height));
    active?.destroy();
    showConsole();
    const start = (d: Deck): ConsoleClient => new SoloClient(d, null, { ...handlersFor(), onEnd: () => showEntry() });
    active = new PresenterConsole(
      {
        deck,
        notes: { noteOverrides: [], pdfpcText: null, pptxNotes: [] },
        published: "",
        remember: true,
        loadNotesSize,
        saveNotesSize,
        onLeave: () => showEntry(),
      },
      start(deck),
    );
  } catch (e) {
    reportOpenError(e);
  } finally {
    busy = false;
  }
}

/** Two-screen mode: this window was opened by the room PC's audience window, which hands over the deck. */
function joinLocal(channelName: string): void {
  entry.hidden = true;
  const waiting = document.createElement("p");
  waiting.className = "status";
  waiting.style.padding = "3rem";
  waiting.textContent = "Waiting for the slides… This window is opened by Lectern when a talk starts in two-screen mode.";
  document.body.append(waiting);

  let opening = false;
  const client = new LocalClient(channelName, {
    ...handlersFor(),
    onNotice: (text) => active?.showNotice(text),
    onEnd: () => {
      // The talk is over: drop everything decrypted and go.
      active?.destroy();
      active = null;
      window.close();
      consoleEl.hidden = true;
      waiting.hidden = false;
      waiting.textContent = "The talk has ended. You can close this window.";
    },
    onDeck: (handed) => {
      if (active || opening) return; // a repeated answer
      opening = true;
      void openDeck(handed.pdf).then((deck) => {
        deck.setSplit(handed.split);
        document.title = `${handed.title} — Lectern presenter view`;
        waiting.hidden = true;
        consoleEl.hidden = false;
        active = new PresenterConsole(
          {
            deck,
            notes: handed,
            published: "",
            remember: false, // this is the room PC: nothing is stored
            loadNotesSize: () => null,
            saveNotesSize: () => {},
            onLeave: () => window.close(),
            // The click or key press happened here, but it is the audience window that must change
            // its full screen, so the gesture is handed over with `delegate: "fullscreen"`.
            onSwap: () => {
              const opener = window.opener as Window | null;
              if (!opener) return;
              try {
                opener.postMessage(SWAP_MESSAGE, { targetOrigin: window.location.origin, delegate: "fullscreen" } as WindowPostMessageOptions);
              } catch {
                opener.postMessage(SWAP_MESSAGE, window.location.origin); // a browser without capability delegation
              }
            },
          },
          client,
        );
        active.onStatus("connected");
      });
    },
  });
  // Ask for the deck until it arrives (the audience window may still be settling into full screen).
  const asking = window.setInterval(() => {
    if (active || opening) window.clearInterval(asking);
    else client.requestDeck();
  }, 300);
  client.requestDeck();
  window.addEventListener("pagehide", () => client.close());
}

$<HTMLFormElement>("code-form").addEventListener("submit", (ev) => {
  ev.preventDefault();
  if (codeInput.value.trim() === "") codeInput.focus();
  else void openTalk(codeInput.value, rememberBox.checked);
});
$<HTMLInputElement>("file").addEventListener("change", (ev) => {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (file) void rehearseFile(file);
});

$("boot").remove();
const channelName = channelNameFromHash(window.location.hash);
if (typeof crypto === "undefined" || !crypto.subtle || typeof ResizeObserver === "undefined") {
  setStatus("This browser is too old for the presenter view. Update it, or use another device.", true);
} else if (channelName) {
  joinLocal(channelName);
} else {
  registerServiceWorker();
  showEntry();
  // Deep link: …/present#c=<code>. Taken out of the address bar at once so it isn't left on screen.
  const linked = /^#c=(.+)$/.exec(window.location.hash)?.[1];
  if (linked) {
    history.replaceState(null, "", window.location.pathname);
    void openTalk(decodeURIComponent(linked), false);
  }
}
