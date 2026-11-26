// Entry screen (SPEC §5.1): type the talk code, the deck is fetched and decrypted in memory,
// then Start. A PDF from this computer can be opened instead (Ben, 2026-11-26).
// Codes are never read from the URL on this screen.
import { registerServiceWorker } from "../shared/register-sw";
import { DeckError, openDeck } from "../shared/deck";
import type { Deck } from "../shared/deck";
import { NetworkError, NoTalkError, fetchDeck } from "../shared/fetch-deck";
import { parsePdfpc, targetDurationMs } from "../core/notes";
import { strFromU8 } from "fflate";
import { RenderCache } from "../shared/render-cache";
import { Presentation } from "./presentation";
import { chooseSplit } from "../core/split";
import type { NotesSplit } from "../core/split";
import type { PresenterDeck } from "./presenter-channel";
import { PresenterHost } from "./presenter-host";
import { RoomLink } from "./room-link";

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
let link: RoomLink | null = null;
let deckPublished = "";
let targetMs: number | null = null;
let starting = false;
let loading = false;
/** What the presenter window will need in Mode B. Held in memory only, and dropped at Start in Mode A. */
let presenterDeck: PresenterDeck | null = null;
/** The split the deck's own settings and shape suggest; the user can turn it off on this screen. */
let suggestedSplit: NotesSplit | null = null;
let screens: ScreenDetails | null = null;

/** What a deck source hands over besides the PDF. */
interface DeckExtras {
  storedSplit?: string;
  pdfpcText: string | null;
  noteOverrides: PresenterDeck["noteOverrides"];
  pptxNotes: PresenterDeck["pptxNotes"];
}
const NO_EXTRAS: DeckExtras = { pdfpcText: null, noteOverrides: [], pptxNotes: [] };

// ---------------------------------------------------------------- Mode B: two screens (SPEC §5.2)

const modeB = $<HTMLInputElement>("mode-b");
const twoScreensPossible = (): boolean => typeof window.getScreenDetails === "function" && window.screen.isExtended === true;

function showModes(): void {
  const possible = twoScreensPossible();
  $("modes").hidden = !possible;
  // Mirrored displays look like a single screen to the browser, so only Mode A can be offered.
  $("mirror-note").hidden = possible || typeof window.getScreenDetails !== "function";
  if (!possible) {
    modeB.checked = false;
    $<HTMLInputElement>("mode-a").checked = true;
  }
  $("mode-b-panel").hidden = !modeB.checked;
}

function listScreens(): void {
  const box = $("screens");
  box.replaceChildren();
  if (!screens) return;
  // Slides go to the external screen by default; the presenter view stays where this window is.
  const preferred =
    screens.screens.find((s) => s !== screens?.currentScreen && !s.isInternal) ??
    screens.screens.find((s) => s !== screens?.currentScreen) ??
    screens.screens[0];
  screens.screens.forEach((s, i) => {
    const label = document.createElement("label");
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "audience-screen";
    radio.value = String(i);
    radio.checked = s === preferred;
    label.append(radio, ` Slides on “${s.label || `Screen ${i + 1}`}” (${s.width}×${s.height}${s === screens?.currentScreen ? ", this screen" : ""})`);
    box.append(label);
  });
}

async function detectScreens(): Promise<boolean> {
  if (!window.getScreenDetails) return false;
  try {
    screens = await window.getScreenDetails();
  } catch {
    screens = null;
    $("screens-status").textContent = "The browser did not allow window management, so two-screen mode is unavailable. Use “This screen only”.";
    return false;
  }
  if (screens.screens.length < 2) {
    $("screens-status").textContent = "Only one screen was found. If a projector is attached, it is mirroring this screen.";
    screens = null;
    return false;
  }
  $("screens-status").textContent = "The notes and controls will open on the other screen.";
  listScreens();
  return true;
}

function chosenScreens(): { audience: ScreenDetailed; presenter: ScreenDetailed | null } | null {
  if (!screens) return null;
  const picked = document.querySelector<HTMLInputElement>('input[name="audience-screen"]:checked');
  const audienceScreen = screens.screens[Number(picked?.value ?? 0)];
  if (!audienceScreen) return null;
  const presenter =
    (audienceScreen !== screens.currentScreen ? screens.currentScreen : screens.screens.find((s) => s !== audienceScreen)) ?? null;
  return { audience: audienceScreen, presenter };
}

// ---------------------------------------------------------------- Beamer notes split

function showSplit(): void {
  const line = $("split-line");
  line.hidden = suggestedSplit === null;
  if (!deck || suggestedSplit === null) return;
  const on = deck.split !== null;
  $("split-text").textContent = on
    ? `Beamer notes found on the ${suggestedSplit} of each page: the audience will see only the slide part.`
    : "Showing whole pages, notes panel included.";
  $("split-toggle").textContent = on ? "Show the whole page instead" : "Hide the notes panel";
}

function applySplit(split: NotesSplit | null): void {
  if (!deck || !cache) return;
  deck.setSplit(split);
  if (presenterDeck) presenterDeck.split = split;
  cache.invalidate();
  cache.want([0, 1, 2].filter((p) => p < (deck?.pageCount ?? 0)));
  showSummary();
  showSplit();
}

function showSummary(): void {
  if (!deck) return;
  const { frameCount } = deck.frames;
  $("deck-summary").textContent =
    frameCount === deck.pageCount
      ? `${deck.pageCount} ${deck.pageCount === 1 ? "page" : "pages"}`
      : `${frameCount} frames, ${deck.pageCount} pages`;
}

const phoneStatus = $("phone-status");
function showPhoneStatus(): void {
  const ok = link?.status === "connected";
  phoneStatus.textContent = ok
    ? `Phone can connect: ${window.location.host}${import.meta.env.BASE_URL}remote`
    : "Phone unavailable: keyboard and clicker only";
  phoneStatus.classList.toggle("ok", ok);
  phoneStatus.classList.toggle("off", !ok);
}

function setStatus(text: string, error = false): void {
  status.textContent = text;
  status.classList.toggle("error", error);
}

async function dropDeck(): Promise<void> {
  link?.close();
  link = null;
  deckPublished = "";
  targetMs = null;
  presenterDeck = null;
  suggestedSplit = null;
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

/** `source` yields the PDF bytes, a title and any sidecar data; it may set the status line while it works. */
async function load(source: () => Promise<{ pdf: ArrayBuffer; title: string | null; extras?: DeckExtras }>): Promise<void> {
  if (loading) return;
  loading = true;
  choose.hidden = true;
  ready.hidden = true;
  fsProblem.hidden = true;
  await dropDeck();
  try {
    const { pdf, title, extras = NO_EXTRAS } = await source();
    setStatus("Opening slides…");
    // PDF.js takes the bytes it is given, so the copy for a presenter window is made first.
    const pdfForPresenter = pdf.slice(0);
    const opened = await openDeck(pdf);
    deck = opened;
    const pdfpcHint = extras.pdfpcText ? (parsePdfpc(extras.pdfpcText)?.notePosition ?? null) : null;
    suggestedSplit = chooseSplit(extras.storedSplit, pdfpcHint, opened.pageSize.width, opened.pageSize.height);
    opened.setSplit(suggestedSplit);
    presenterDeck = {
      pdf: pdfForPresenter,
      title: title ?? opened.title ?? "Untitled",
      split: suggestedSplit,
      noteOverrides: extras.noteOverrides,
      pdfpcText: extras.pdfpcText,
      pptxNotes: extras.pptxNotes,
    };
    // Render the opening pages now, at the size full screen will have, so Start shows a slide at once.
    const dpr = window.devicePixelRatio || 1;
    cache = new RenderCache(opened);
    cache.setSurface(window.screen.width * dpr, window.screen.height * dpr);
    cache.want([0, 1, 2].filter((p) => p < opened.pageCount));

    $("deck-title").textContent = title ?? opened.title ?? "Untitled";
    showSummary();
    showSplit();
    showModes();
    setStatus("");
    codeInput.value = "";
    showPhoneStatus();
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
    const { payload, keys } = await fetchDeck(code, import.meta.env.BASE_URL, (step) =>
      setStatus(step === "unlocking" ? "Unlocking…" : "Loading slides…"),
    );
    // The room PC never waits on the relay: this connects in the background (SPEC §8.4).
    link = new RoomLink(keys);
    link.onStatus = showPhoneStatus;
    deckPublished = payload.meta.published;
    const pdfpcText = payload.pdfpc ? strFromU8(payload.pdfpc) : null;
    targetMs = targetDurationMs(pdfpcText ? parsePdfpc(pdfpcText) : null, payload.meta.settings.targetDuration);
    // Copy the PDF out of the payload so the rest of it can be collected; PDF.js takes the copy.
    const pdf = payload.pdf.slice().buffer;
    const extras: DeckExtras = {
      pdfpcText,
      noteOverrides: payload.meta.noteOverrides,
      pptxNotes: payload.notes?.pages ?? [],
      ...(payload.meta.settings.notesSplit !== undefined ? { storedSplit: payload.meta.settings.notesSplit } : {}),
    };
    return { pdf, title: payload.meta.title || null, extras };
  });
}

// Called straight from the click handlers: full screen needs the user gesture.
function start(fullscreen: boolean): void {
  if (!deck || !cache || starting) return;
  const twoScreens = fullscreen && modeB.checked && twoScreensPossible();
  if (twoScreens && !screens) {
    // The permission prompt uses up the click, so choosing screens and starting are two clicks.
    void detectScreens().then((ok) => setStatus(ok ? "Screens found. Check the choice above, then click Start." : ""));
    return;
  }
  const placement = twoScreens ? chosenScreens() : null;
  const forPresenter = placement ? presenterDeck : null;
  starting = true;
  const starter = Presentation.start(deck, cache, audience, {
    fullscreen,
    ...(placement ? { screen: placement.audience } : {}),
    // Reloading the entry screen guarantees nothing of the talk survives in this tab.
    onEnded: () => window.location.replace(import.meta.env.BASE_URL),
    link,
    deckPublished,
    targetMs,
  });
  void starter.then((presentation) => {
    starting = false;
    if (presentation) {
      // Mode B: the presenter window opens from the same click, right after full screen is granted.
      // If the browser blocks it, the talk is simply in Mode A.
      if (placement && forPresenter) new PresenterHost(presentation, forPresenter).open(placement.presenter, placement.audience);
      presenterDeck = null;
      entry.hidden = true;
      // The presentation now owns the deck and cache, and wipes them when it ends.
      deck = null;
      cache = null;
      link = null;
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
$("mode-a").addEventListener("change", showModes);
modeB.addEventListener("change", showModes);
$("detect-screens").addEventListener("click", () => void detectScreens());
$("split-toggle").addEventListener("click", () => applySplit(deck?.split ? null : suggestedSplit));
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

registerServiceWorker();
$("boot").remove();
if (typeof crypto === "undefined" || !crypto.subtle || typeof ResizeObserver === "undefined") {
  setStatus("This browser is too old to open talks. Use a current Chrome, Edge, Firefox or Safari.", true);
} else {
  showChooser();
}
