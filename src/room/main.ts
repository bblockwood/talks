// Entry screen (SPEC §5.1). W1 interim version: there are no talk codes until W2, so the deck
// comes from a bundled test deck or a PDF picked from this computer, read into memory only.
import basicUrl from "../../fixtures/basic-169.pdf?url";
import linksUrl from "../../fixtures/links-appendix.pdf?url";
import overlaysUrl from "../../fixtures/overlays.pdf?url";
import tikzUrl from "../../fixtures/tikz-heavy.pdf?url";
import { DeckError, openDeck } from "../shared/deck";
import type { Deck } from "../shared/deck";
import { RenderCache } from "../shared/render-cache";
import { Presentation } from "./presentation";

const FIXTURES: readonly { name: string; url: string }[] = [
  { name: "Basic 16:9", url: basicUrl },
  { name: "Overlays (builds)", url: overlaysUrl },
  { name: "Links and appendix", url: linksUrl },
  { name: "TikZ heavy", url: tikzUrl },
];

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
const fileInput = $<HTMLInputElement>("file");
const startButton = $<HTMLButtonElement>("start");
const fsProblem = $("fs-problem");

let deck: Deck | null = null;
let cache: RenderCache | null = null;
let starting = false;

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

async function load(name: string, bytes: () => Promise<ArrayBuffer>): Promise<void> {
  choose.hidden = true;
  ready.hidden = true;
  fsProblem.hidden = true;
  setStatus("Opening…");
  await dropDeck();
  try {
    const opened = await openDeck(await bytes());
    deck = opened;
    // Render the opening pages now, at the size full screen will have, so Start shows a slide at once.
    const dpr = window.devicePixelRatio || 1;
    cache = new RenderCache(opened);
    cache.setSurface(window.screen.width * dpr, window.screen.height * dpr);
    cache.want([0, 1, 2].filter((p) => p < opened.pageCount));

    const { frameCount } = opened.frames;
    $("deck-title").textContent = opened.title ?? name;
    $("deck-summary").textContent =
      frameCount === opened.pageCount
        ? `${opened.pageCount} ${opened.pageCount === 1 ? "page" : "pages"}`
        : `${frameCount} frames, ${opened.pageCount} pages`;
    setStatus("");
    ready.hidden = false;
    startButton.focus();
  } catch (e) {
    await dropDeck();
    choose.hidden = false;
    setStatus(
      e instanceof DeckError ? e.message : "Could not load that deck. Check the network connection and try again.",
      true,
    );
  }
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

for (const fixture of FIXTURES) {
  const button = document.createElement("button");
  button.textContent = fixture.name;
  button.addEventListener("click", () => {
    void load(fixture.name, async () => {
      const response = await fetch(fixture.url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.arrayBuffer();
    });
  });
  $("fixtures").append(button);
}

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  fileInput.value = "";
  if (file) void load(file.name.replace(/\.pdf$/i, ""), () => file.arrayBuffer());
});

startButton.addEventListener("click", () => start(document.fullscreenEnabled));
$("start-windowed").addEventListener("click", () => start(false));
$("another").addEventListener("click", () => {
  void dropDeck();
  ready.hidden = true;
  choose.hidden = false;
  setStatus("");
});

$("boot").remove();
choose.hidden = false;
