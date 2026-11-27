// The one page (Ben, 2026-11-27). Open a talk by its code, from a talk remembered on this device,
// or from a PDF on it; then choose what this device shows: the slides, full screen, for the
// audience, or the presenter view. Every device that opens the same code is in the same talk.
// The same page, opened by two-screen mode with `#ch=<channel>`, is the presenter view in the
// second window. A URL hash is never sent to any server.
import { strFromU8 } from "fflate";
import { normalizeCode } from "../core/code";
import { parsePdfpc, targetDurationMs } from "../core/notes";
import { chooseSplit } from "../core/split";
import type { NotesSplit } from "../core/split";
import { LocalClient, TalkClient } from "../console/client";
import { PresenterConsole, layoutFor } from "../console/console";
import { forget, loadNotesSize, loadSaved, remember, saveNotesSize } from "../console/saved";
import { DeckError, openDeck } from "../shared/deck";
import { makeJoinCode, receiveDeck } from "../shared/deck-share";
import { NetworkError, NoTalkError, fetchDeck } from "../shared/fetch-deck";
import { SWAP_MESSAGE, channelNameFromHash } from "../shared/local-channel";
import type { PresenterDeck } from "../shared/local-channel";
import { registerServiceWorker } from "../shared/register-sw";
import { RenderCache } from "../shared/render-cache";
import { SlideSurface } from "../shared/slide-surface";
import { Talk } from "../shared/talk";
import type { TalkSource } from "../shared/talk";
import { LocalHub } from "./local-hub";
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
const consoleEl = $("console");
const codeInput = $<HTMLInputElement>("code");
const rememberBox = $<HTMLInputElement>("remember");
const fileInput = $<HTMLInputElement>("file");
const startButton = $<HTMLButtonElement>("start");
const presenterButton = $<HTMLButtonElement>("presenter");
const fsProblem = $("fs-problem");

/** The open talk, and what this device is showing of it. */
let talk: Talk | null = null;
let cache: RenderCache | null = null;
let presentation: Presentation | null = null;
let active: PresenterConsole | null = null;
/** The slide shown on the page where a view is chosen. */
let preview: SlideSurface | null = null;
/** The code of the open talk, in memory only, so a republished deck can be fetched again. */
let currentCode = "";
/** True on the presenter's own device (the talk is remembered here): only then are preferences stored. */
let ownDevice = false;
/** The split the deck's own settings and shape suggest; the user can turn it off before the talk starts. */
let suggestedSplit: NotesSplit | null = null;
let screens: ScreenDetails | null = null;
let starting = false;
let loading = false;

function setStatus(text: string, error = false): void {
  status.textContent = text;
  status.classList.toggle("error", error);
}

// ---------------------------------------------------------------- two screens (SPEC §5.2)

const twoScreensPossible = (): boolean => typeof window.getScreenDetails === "function" && window.screen.isExtended === true;

/** True when the browser can't place windows on screens itself (Safari, Firefox), or was not allowed to. */
let placeByHand = false;
const canPlaceByHand = (): boolean =>
  layoutFor(window.innerWidth, window.innerHeight) === "wide" && window.matchMedia("(pointer: fine)").matches && typeof window.open === "function";

/**
 * "Both views". Where the browser can place windows (Chrome, Edge) it needs two screens it can
 * tell apart; mirrored displays look like one. Elsewhere, on a computer, the two windows are
 * opened and the user drags them to their screens.
 */
function showBoth(): void {
  const managed = typeof window.getScreenDetails === "function";
  const possible = twoScreensPossible();
  const byHand = (!managed || placeByHand) && canPlaceByHand();
  $<HTMLButtonElement>("both").disabled = !possible && !byHand;
  $("mirror-note").hidden = possible || byHand || !managed || layoutFor(window.innerWidth, window.innerHeight) !== "wide";
  $("manual-note").hidden = !byHand;
  $("both-panel").hidden = !possible || !screens || byHand;
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
    // Not allowed to place windows: fall back to opening them for the user to drag.
    placeByHand = true;
    showBoth();
    setStatus("The browser did not allow window management. Click Both views again to open the two windows and place them yourself.");
    return false;
  }
  if (screens.screens.length < 2) {
    setStatus("Only one screen was found. If a projector is attached, it is mirroring this screen.", true);
    screens = null;
    return false;
  }
  $("screens-status").textContent = "The presenter view goes on the screen the slides are not on. Swap displays, in the presenter view, exchanges them.";
  listScreens();
  showBoth();
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

// ---------------------------------------------------------------- the choice of views

function showSplit(): void {
  const line = $("split-line");
  const deck = talk?.deck;
  // Whoever runs the talk decides the crop, so the choice is only offered before the talk exists.
  line.hidden = suggestedSplit === null || !deck || talk?.peer.heard != null || talk?.peer.hosting === true;
  if (!deck || suggestedSplit === null) return;
  const on = deck.split !== null;
  $("split-text").textContent = on
    ? `Beamer notes found on the ${suggestedSplit} of each page: the audience will see only the slide part.`
    : "Showing whole pages, notes panel included.";
  $("split-toggle").textContent = on ? "Show the whole page instead" : "Hide the notes panel";
}

function applySplit(split: NotesSplit | null): void {
  if (!talk || !cache) return;
  talk.deck.setSplit(split);
  document.documentElement.style.setProperty("--slide-aspect", String(talk.deck.aspect));
  preview?.refresh();
  cache.invalidate();
  cache.want([0, 1, 2].filter((p) => p < (talk?.deck.pageCount ?? 0)));
  showSummary();
  showSplit();
}

function showSummary(): void {
  const deck = talk?.deck;
  if (!deck) return;
  const { frameCount } = deck.frames;
  $("deck-summary").textContent =
    frameCount === deck.pageCount ? `${deck.pageCount} ${deck.pageCount === 1 ? "page" : "pages"}` : `${frameCount} frames, ${deck.pageCount} pages`;
}

/** Whether a talk is already going on other devices, and whether others can join this one. */
function showTalkStatus(): void {
  if (!talk || ready.hidden) return;
  const heard = talk.peer.heard;
  const hosting = talk.peer.hosting;
  const line = $("talk-status");
  if (heard) {
    const others = Math.max(1, (heard.room?.devices.length ?? 2) - 1);
    const where = heard.frameLabel ? `at frame ${heard.frameLabel}` : `at page ${heard.page + 1}`;
    const slides = (heard.room?.audiences ?? 0) > 0 ? "A screen is showing the slides." : "No screen is showing the slides yet.";
    line.textContent = `This talk is open on ${others} other ${others === 1 ? "device" : "devices"}, ${where}. ${slides}`;
  } else if (hosting) {
    line.textContent = "This talk is running on this device.";
  } else {
    line.textContent = "";
  }
  // The slide the talk is on, or the first one.
  const page = heard?.page ?? talk.peer.viewState()?.committedPage ?? 0;
  preview?.show(Math.min(page, talk.deck.pageCount - 1));

  const phone = $("phone-status");
  const canJoin = talk.relayStatus === "connected";
  const joinCode = talk.source.joinCode;
  phone.replaceChildren();
  if (talk.relayStatus === "none") phone.textContent = "Other devices can't join: this build has no relay.";
  else if (!canJoin) phone.textContent = "Not connected: other devices can't join right now.";
  else if (joinCode && talk.source.originator) {
    // A talk started from a PDF on this device: its code was made here and is shown, so another
    // device can join. A device that joined with it does not show it: its screen may be the projector.
    const code = document.createElement("strong");
    code.id = "join-code";
    code.textContent = joinCode;
    phone.append("Other devices join with the code ", code, ` at ${window.location.host}${import.meta.env.BASE_URL.replace(/\/$/, "")}`);
  } else phone.textContent = `Other devices join with the same code at ${window.location.host}${import.meta.env.BASE_URL.replace(/\/$/, "")}`;
  phone.classList.toggle("ok", canJoin);
  phone.classList.toggle("off", !canJoin);
  showSplit();
}

function showReady(): void {
  if (!talk) return;
  consoleEl.hidden = true;
  entry.hidden = false;
  choose.hidden = true;
  fsProblem.hidden = true;
  $("deck-title").textContent = talk.source.title;
  showSummary();
  showBoth();
  setStatus("");
  // On a phone the presenter view is the likely choice; on a computer, either.
  const small = layoutFor(window.innerWidth, window.innerHeight) !== "wide";
  presenterButton.classList.toggle("primary", small);
  startButton.classList.toggle("primary", !small);
  ready.hidden = false;
  document.documentElement.style.setProperty("--slide-aspect", String(talk.deck.aspect));
  preview ??= new SlideSurface($("preview"), talk.deck, 2);
  showTalkStatus();
  (small ? presenterButton : startButton).focus();
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
  for (const saved of talks) {
    const row = document.createElement("div");
    row.className = "saved-row";
    const open = document.createElement("button");
    open.className = "talk";
    // The title only: the code is not put on a screen that may be mirrored to the room.
    const title = document.createElement("span");
    title.textContent = saved.title;
    open.append(title);
    open.addEventListener("click", () => openByCode(saved.code, true));
    const drop = document.createElement("button");
    drop.textContent = "Forget";
    drop.addEventListener("click", () => {
      forget(saved.code);
      showSaved();
    });
    row.append(open, drop);
    box.append(row);
  }
}

function showChooser(message = "", error = false): void {
  consoleEl.hidden = true;
  entry.hidden = false;
  ready.hidden = true;
  choose.hidden = false;
  showSaved();
  setStatus(message, error);
  if (window.matchMedia("(pointer: fine)").matches) codeInput.focus(); // on a phone this would pop the keyboard up
}

// ---------------------------------------------------------------- opening and leaving a talk

function closePreview(): void {
  preview?.destroy();
  preview = null;
}

/** Leaves the talk on this device and drops everything decrypted. The talk goes on for the others. */
async function dropTalk(): Promise<void> {
  active?.destroy();
  active = null;
  closePreview();
  const old = talk;
  talk = null;
  currentCode = "";
  ownDevice = false;
  suggestedSplit = null;
  cache?.wipe();
  cache = null;
  if (old) {
    await old.close();
    await old.deck.destroy();
  }
}

/** Leaving reloads the page, which guarantees that nothing of the talk survives in this tab. */
function leave(): void {
  if (presentation) void presentation.end();
  else void dropTalk().then(() => window.location.replace(import.meta.env.BASE_URL));
}

interface Loaded {
  pdf: ArrayBuffer;
  title: string | null;
  storedSplit?: string;
  notes: TalkSource["notes"];
  targetMs: number | null;
  published: string;
  keys: TalkSource["keys"];
  joinCode: string | null;
  originator: boolean;
}

/** `source` yields the PDF and what came with it; it may set the status line while it works. */
async function load(source: () => Promise<Loaded>): Promise<boolean> {
  if (loading) return false;
  loading = true;
  choose.hidden = true;
  ready.hidden = true;
  await dropTalk();
  try {
    const loaded = await source();
    setStatus("Opening slides…");
    // PDF.js takes the bytes it is given, so the copy for a second window is made first.
    const copy = loaded.pdf.slice(0);
    const deck = await openDeck(loaded.pdf);
    const pdfpcHint = loaded.notes.pdfpcText ? (parsePdfpc(loaded.notes.pdfpcText)?.notePosition ?? null) : null;
    suggestedSplit = chooseSplit(loaded.storedSplit, pdfpcHint, deck.pageSize.width, deck.pageSize.height);
    deck.setSplit(suggestedSplit);
    // Render the opening pages now, at the size full screen will have, so the slides appear at once.
    const dpr = window.devicePixelRatio || 1;
    cache = new RenderCache(deck);
    cache.setSurface(window.screen.width * dpr, window.screen.height * dpr);
    cache.want([0, 1, 2].filter((p) => p < deck.pageCount));

    talk = new Talk({
      deck,
      pdf: copy,
      // A PDF's own title comes first; one opened from this device is otherwise known by its file name.
      title: loaded.originator ? deck.title || loaded.title || "Untitled" : (loaded.title ?? deck.title ?? "Untitled"),
      notes: loaded.notes,
      targetMs: loaded.targetMs,
      published: loaded.published,
      keys: loaded.keys,
      joinCode: loaded.joinCode,
      originator: loaded.originator,
    });
    talk.onNews = showTalkStatus;
    talk.onEnd = leave; // someone ended the talk for every device
    codeInput.value = "";
    showReady();
    return true;
  } catch (e) {
    await dropTalk();
    if (e instanceof NoTalkError) showChooser("No talk found for that code.", true);
    else if (e instanceof NetworkError) showChooser("Could not reach the server. Check the connection and try again.", true);
    else if (e instanceof DeckError) showChooser(e.message, true);
    else showChooser("Something went wrong opening that talk. Try again.", true);
    return false;
  } finally {
    loading = false;
  }
}

const NO_NOTES: TalkSource["notes"] = { noteOverrides: [], pdfpcText: null, pptxNotes: [] };

/** `own` is true when the talk is, or is to be, remembered on this device. */
function openByCode(rawCode: string, own: boolean, then?: () => void): void {
  const code = normalizeCode(rawCode);
  if (code === "") return;
  let published = true;
  void load(async () => {
    try {
      const { payload, keys } = await fetchDeck(code, import.meta.env.BASE_URL, (step) => setStatus(step === "unlocking" ? "Unlocking…" : "Loading slides…"));
      const pdfpcText = payload.pdfpc ? strFromU8(payload.pdfpc) : null;
      if (own) remember(code, payload.meta.title || code);
      return {
        // Copy the PDF out of the payload so the rest of it can be collected; PDF.js takes the copy.
        pdf: payload.pdf.slice().buffer,
        title: payload.meta.title || null,
        notes: { noteOverrides: payload.meta.noteOverrides, pdfpcText, pptxNotes: payload.notes?.pages ?? [] },
        targetMs: targetDurationMs(pdfpcText ? parsePdfpc(pdfpcText) : null, payload.meta.settings.targetDuration),
        published: payload.meta.published,
        keys,
        joinCode: null,
        originator: false,
        ...(payload.meta.settings.notesSplit !== undefined ? { storedSplit: payload.meta.settings.notesSplit } : {}),
      };
    } catch (e) {
      // Nothing is published under this code. It may be a talk another device started from a
      // PDF: ask the devices in it for the slides.
      if (!(e instanceof NoTalkError) || !e.keys) throw e;
      published = false;
      setStatus("Looking for the talk on another device…");
      const got = await receiveDeck(e.keys, (fraction) => setStatus(`Receiving slides… ${Math.round(fraction * 100)}%`));
      return { pdf: got.pdf, title: got.title || null, notes: NO_NOTES, targetMs: null, published: "", keys: e.keys, joinCode: code, originator: false };
    }
  }).then((ok) => {
    if (!ok) return;
    // A code made for one talk is not worth remembering or reloading by.
    currentCode = published ? code : "";
    ownDevice = own && published;
    then?.();
  });
}

function openPdf(pdf: () => Promise<ArrayBuffer>, name: string): void {
  void load(async () => {
    setStatus("Opening…");
    const bytes = await pdf();
    // A code for this talk, so another device can join it and be sent the slides.
    const { code, keys } = await makeJoinCode();
    return { pdf: bytes, title: name, notes: NO_NOTES, targetMs: null, published: "", keys, joinCode: code, originator: true };
  });
}

// ---------------------------------------------------------------- the presenter view

function showPresenter(): void {
  const current = talk;
  if (!current || active || presentation) return;
  entry.hidden = true;
  consoleEl.hidden = false;
  closePreview();
  const code = currentCode;
  const own = ownDevice;
  active = new PresenterConsole(
    {
      deck: current.deck,
      notes: current.source.notes,
      published: current.source.published,
      remember: own,
      ownsDeck: false,
      loadNotesSize: () => (own ? loadNotesSize() : null),
      saveNotesSize,
      ...(current.source.joinCode && current.source.originator ? { joinHint: `code ${current.source.joinCode}` } : {}),
      onLeave: leave,
      onChangeView: () => {
        active?.destroy();
        active = null;
        showReady();
      },
      // The host has a newer publish: fetch it again and come straight back to this view.
      ...(code !== "" ? { onReload: () => openByCode(code, own, showPresenter) } : {}),
      dropForTest: () => current.dropForTest(),
    },
    new TalkClient(current, {
      onMessage: (envelope) => active?.onMessage(envelope),
      onStatus: (s) => active?.onStatus(s),
    }),
  );
  current.peer.setView("presenter");
}

// ---------------------------------------------------------------- the slides

// Called straight from the click handlers: full screen and new windows need the user gesture.
function start(fullscreen: boolean, both = false): void {
  const current = talk;
  const pages = cache;
  if (!current || !pages || starting || active || presentation) return;
  const byHand = both && (typeof window.getScreenDetails !== "function" || placeByHand) && canPlaceByHand();
  const twoScreens = fullscreen && both && !byHand && twoScreensPossible();
  if (twoScreens && !screens) {
    // The permission prompt uses up the click, so choosing screens and starting are two clicks.
    setStatus("Your browser asks to manage windows: click Allow.");
    void detectScreens().then((ok) => {
      if (ok) setStatus("Screens found. Check the choice above, then click Both views again.");
    });
    return;
  }
  const placement = twoScreens ? chosenScreens() : null;
  const forWindow = (): PresenterDeck => ({ pdf: current.source.pdf.slice(0), title: current.source.title, split: current.deck.split, ...current.source.notes });

  // By hand: the presenter view opens in a second window at once (a new window must come straight
  // from the click), and the slides start in this window, to be dragged to the projector.
  let hub: LocalHub | null = null;
  if (byHand) {
    hub = new LocalHub(current, forWindow());
    hub.setHint("Drag the slides window to the projector, then click Full screen on it.");
    if (!hub.open(null)) hub = null; // blocked: this device simply shows the slides
  }

  starting = true;
  const starter = Presentation.start(current, pages, audience, {
    fullscreen: fullscreen && !byHand,
    ...(placement ? { screen: placement.audience } : {}),
    ...(byHand ? { setup: true } : {}),
    onStopped: () => {
      presentation = null;
      showReady();
    },
    onEnded: () => window.location.replace(import.meta.env.BASE_URL),
  });
  void starter.then((started) => {
    starting = false;
    if (!started) {
      hub?.close();
      fsProblem.hidden = false;
      return;
    }
    presentation = started;
    entry.hidden = true;
    closePreview();
    if (placement) {
      // The presenter view opens on the other screen from the same click, right after full screen
      // is granted. If the browser blocks it, this device simply shows the slides.
      hub = new LocalHub(current, forWindow());
      if (!hub.open(placement.presenter, placement.audience)) hub = null;
    }
    hub?.attach(started);
  });
}

// ---------------------------------------------------------------- the second window of two-screen mode

/** This window was opened by the slides window on the same computer, which hands over the deck. */
function joinLocal(channelName: string): void {
  entry.hidden = true;
  const waiting = document.createElement("p");
  waiting.className = "status";
  waiting.style.padding = "3rem";
  waiting.textContent = "Waiting for the slides… This window is opened by Lectern when slides are shown on two screens.";
  document.body.append(waiting);

  let opening = false;
  const client = new LocalClient(channelName, {
    onMessage: (envelope) => active?.onMessage(envelope),
    onStatus: (s) => active?.onStatus(s),
    onNotice: (text) => active?.showNotice(text),
    onEnd: () => {
      // The slides are gone: drop everything decrypted and go.
      active?.destroy();
      active = null;
      window.close();
      consoleEl.hidden = true;
      waiting.hidden = false;
      waiting.textContent = "The slides have closed. You can close this window.";
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
            remember: false, // possibly a shared computer: nothing is stored
            ownsDeck: true,
            loadNotesSize: () => null,
            saveNotesSize: () => {},
            onLeave: () => window.close(),
            // The click or key press happened here, but it is the slides window that must change
            // its full screen, so the gesture is handed over with `delegate: "fullscreen"`. Only
            // where the browser placed the windows: otherwise they are dragged by hand.
            ...(handed.canSwap
              ? {
                  onSwap: () => {
                    const opener = window.opener as Window | null;
                    if (!opener) return;
                    try {
                      opener.postMessage(SWAP_MESSAGE, { targetOrigin: window.location.origin, delegate: "fullscreen" } as WindowPostMessageOptions);
                    } catch {
                      opener.postMessage(SWAP_MESSAGE, window.location.origin); // a browser without capability delegation
                    }
                  },
                }
              : {}),
          },
          client,
        );
        active.onStatus("connected");
      });
    },
  });
  // Ask for the deck until it arrives (the slides window may still be settling into full screen).
  const asking = window.setInterval(() => {
    if (active || opening) window.clearInterval(asking);
    else client.requestDeck();
  }, 300);
  client.requestDeck();
  window.addEventListener("pagehide", () => client.close());
}

// ---------------------------------------------------------------- wiring

$<HTMLFormElement>("code-form").addEventListener("submit", (ev) => {
  ev.preventDefault();
  if (codeInput.value.trim() === "") codeInput.focus();
  else openByCode(codeInput.value, rememberBox.checked);
});
fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  fileInput.value = "";
  if (file) openPdf(() => file.arrayBuffer(), file.name.replace(/\.pdf$/i, ""));
});
startButton.addEventListener("click", () => start(document.fullscreenEnabled));
presenterButton.addEventListener("click", showPresenter);
$("start-windowed").addEventListener("click", () => start(false));
$("both").addEventListener("click", () => start(document.fullscreenEnabled, true));
$("split-toggle").addEventListener("click", () => applySplit(talk?.deck.split ? null : suggestedSplit));
$("another").addEventListener("click", leave);
// Closing the tab: tell the others, so one of them carries the talk on at once.
window.addEventListener("pagehide", () => {
  if (presentation) void presentation.end(false);
  else void talk?.close();
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
      button.addEventListener("click", () =>
        openPdf(async () => {
          const response = await fetch(fixture.url);
          if (!response.ok) throw new NetworkError(`HTTP ${response.status}`);
          return response.arrayBuffer();
        }, fixture.name),
      );
      box.append(button);
    }
  });
}

// The code is hidden as it is typed (Ben, 2026-11-27): the screen may already be on the projector,
// and anyone who reads the code can drive the talk. Not a password field, which browsers offer to
// save; where the browser can't mask a text field, a password field that asks not to be saved.
const maskable = typeof CSS !== "undefined" && CSS.supports("-webkit-text-security", "disc");
function maskCode(hidden: boolean): void {
  if (maskable) codeInput.classList.toggle("masked", hidden);
  else {
    codeInput.type = hidden ? "password" : "text";
    codeInput.autocomplete = "off";
  }
}
const showCode = $<HTMLInputElement>("show-code");
showCode.addEventListener("change", () => maskCode(!showCode.checked));
maskCode(true);

$("boot").remove();
const channelName = channelNameFromHash(window.location.hash);
if (typeof crypto === "undefined" || !crypto.subtle || typeof ResizeObserver === "undefined") {
  setStatus("This browser is too old to open talks. Use a current Chrome, Edge, Firefox or Safari.", true);
} else if (channelName) {
  joinLocal(channelName);
} else {
  registerServiceWorker();
  showChooser();
  // A link with the code after #: …/talks#c=<code>. Taken out of the address bar at once so it
  // isn't left on screen.
  const linked = /^#c=(.+)$/.exec(window.location.hash)?.[1];
  if (linked) {
    history.replaceState(null, "", window.location.pathname);
    openByCode(decodeURIComponent(linked), false);
  }
}
