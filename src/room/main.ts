// Entry screen (SPEC §5.1): type the talk code, the deck is fetched and decrypted in memory,
// then Start. A PDF from this computer can be opened instead (Ben, 2026-11-26).
// Codes are never read from the URL on this screen.
import { DeckError, openDeck } from "../shared/deck";
import type { Deck } from "../shared/deck";
import { NetworkError, NoTalkError, fetchDeck } from "../shared/fetch-deck";
import { RenderCache } from "../shared/render-cache";
import { Presentation } from "./presentation";

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

const entry = $("entry");
const choose = $("choose");
const ready = $("ready");
const status = $("status");
const audience = $("audience");
const codeInput = $<HTMLInputElement>("code");
const fileInput = $<HTMLInputElement>("file");
const startButton = $<HTMLButtonElement>("start");
const fsProblem = $("fs-problem");

let deck: Deck | null = null;
let cache: RenderCache | null = null;
let starting = false;
let loading = false;

function setStatus(text: string, error = false): void {
  status.textContent = text;
  status.classList.toggle("error", error);
}

async function dropDeck(): Promise<void> {
  cache?.wipe();
  cache = null;
  const old = deck;
  deck = null;
  await old?.destroy();
}

function showChooser(message = "", error = false): void {
  ready.hidden = true;
  choose.hidden = false;
  setStatus(message, error);
  codeInput.focus();
}

/** `source` yields the PDF bytes and a title; it may set the status line while it works. */
async function load(source: () => Promise<{ pdf: ArrayBuffer; title: string | null }>): Promise<void> {
  if (loading) return;
  loading = true;
  choose.hidden = true;
  ready.hidden = true;
  fsProblem.hidden = true;
  await dropDeck();
  try {
    const { pdf, title } = await source();
    setStatus("Opening slides…");
    const opened = await openDeck(pdf);
    deck = opened;
    // Render the opening pages now, at the size full screen will have, so Start shows a slide at once.
    const dpr = window.devicePixelRatio || 1;
    cache = new RenderCache(opened);
    cache.setSurface(window.screen.width * dpr, window.screen.height * dpr);
    cache.want([0, 1, 2].filter((p) => p < opened.pageCount));

    const { frameCount } = opened.frames;
    $("deck-title").textContent = title ?? opened.title ?? "Untitled";
    $("deck-summary").textContent =
      frameCount === opened.pageCount
        ? `${opened.pageCount} ${opened.pageCount === 1 ? "page" : "pages"}`
        : `${frameCount} frames, ${opened.pageCount} pages`;
    setStatus("");
    codeInput.value = "";
    ready.hidden = false;
    startButton.focus();
  } catch (e) {
    await dropDeck();
    if (e instanceof NoTalkError) showChooser("No talk found for that code.", true);
    else if (e instanceof NetworkError) showChooser("Could not reach the server. Check the network connection and try again.", true);
    else if (e instanceof DeckError) showChooser(e.message, true);
    else showChooser("Something went wrong opening that talk. Try again.", true);
  } finally {
    loading = false;
  }
}

function openByCode(code: string): void {
  void load(async () => {
    const { payload } = await fetchDeck(code, import.meta.env.BASE_URL, (step) =>
      setStatus(step === "unlocking" ? "Unlocking…" : "Loading slides…"),
    );
    // Copy the PDF out of the payload so the rest of it can be collected; PDF.js takes the copy.
    const pdf = payload.pdf.slice().buffer;
    return { pdf, title: payload.meta.title || null };
  });
}

// Called straight from the click handlers: full screen needs the user gesture.
function start(fullscreen: boolean): void {
  if (!deck || !cache || starting) return;
  starting = true;
  const starter = Presentation.start(deck, cache, audience, {
    fullscreen,
    // Reloading the entry screen guarantees nothing of the talk survives in this tab.
    onEnded: () => window.location.replace(import.meta.env.BASE_URL),
  });
  void starter.then((presentation) => {
    starting = false;
    if (presentation) {
      entry.hidden = true;
      // The presentation now owns the deck and cache, and wipes them when it ends.
      deck = null;
      cache = null;
    } else {
      fsProblem.hidden = false;
    }
  });
}

$<HTMLFormElement>("code-form").addEventListener("submit", (ev) => {
  ev.preventDefault();
  if (codeInput.value.trim() === "") codeInput.focus();
  else openByCode(codeInput.value);
});

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  fileInput.value = "";
  if (!file) return;
  void load(async () => {
    setStatus("Opening…");
    return { pdf: await file.arrayBuffer(), title: null };
  }).then(() => {
    // A PDF with no title of its own is shown by its file name.
    if (deck && !deck.title) $("deck-title").textContent = file.name.replace(/\.pdf$/i, "");
  });
});

startButton.addEventListener("click", () => start(document.fullscreenEnabled));
$("start-windowed").addEventListener("click", () => start(false));
$("another").addEventListener("click", () => {
  void dropDeck();
  showChooser();
});

if (import.meta.env.DEV) {
  // Development and e2e only: the bundled test decks. Not part of the production build.
  void import("./dev-fixtures").then(({ FIXTURES }) => {
    const box = $("fixtures");
    box.hidden = false;
    for (const fixture of FIXTURES) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = fixture.name;
      button.addEventListener("click", () => {
        void load(async () => {
          setStatus("Opening…");
          const response = await fetch(fixture.url);
          if (!response.ok) throw new NetworkError(`HTTP ${response.status}`);
          return { pdf: await response.arrayBuffer(), title: null };
        }).then(() => {
          if (deck && !deck.title) $("deck-title").textContent = fixture.name;
        });
      });
      box.append(button);
    }
  });
}

$("boot").remove();
if (typeof crypto === "undefined" || !crypto.subtle || typeof ResizeObserver === "undefined") {
  setStatus("This browser is too old to open talks. Use a current Chrome, Edge, Firefox or Safari.", true);
} else {
  showChooser();
}
