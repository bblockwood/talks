// The presenter window of Mode B (SPEC §5.2, Native §6.2–6.4): current slide, next slide, notes,
// overview and search. It renders its own copy of the deck at its own resolution and sends
// Commands to the audience window, which owns the session. It never touches storage.
import { KeyInterpreter } from "../core/keys";
import { hitTest } from "../core/links";
import { formatClock, renderNotesHtml } from "../core/markdown";
import { NotesTable, assembleNotes, parsePdfpc } from "../core/notes";
import { hitsByFrame, searchPages } from "../core/search";
import type { SearchHit } from "../core/search";
import { audiencePage, backTarget, elapsedMs, forwardTarget } from "../core/session";
import type { Command, SessionState } from "../core/session";
import { openDeck } from "../shared/deck";
import type { Deck } from "../shared/deck";
import { SlideSurface } from "../shared/slide-surface";
import { ThumbGrid } from "../shared/thumbs";
import { SWAP_MESSAGE, channelNameFromHash } from "./presenter-channel";
import type { PresenterDeck, PresenterInfo, ToAudience, ToPresenter } from "./presenter-channel";

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

const channelName = channelNameFromHash(window.location.hash);
const channel = channelName ? new BroadcastChannel(`lectern-${channelName}`) : null;
const post = (message: ToAudience): void => {
  try {
    channel?.postMessage(message);
  } catch {
    // The channel is already closed because the talk has ended.
  }
};

let deck: Deck | null = null;
let notes: NotesTable = NotesTable.empty;
let state: SessionState | null = null;
let info: PresenterInfo | null = null;
let current: SlideSurface | null = null;
let next: SlideSurface | null = null;
let notesImage: SlideSurface | null = null;
let grid: ThumbGrid | null = null;
let pageTexts: string[] | null = null;
let hits: SearchHit[] = [];
let selectedHit = 0;
let laser = false;
let overviewOpen = false;
let notesSize = 22;
let lastPointerSent = 0;
let notice = "";
let noticeUntil = 0;

/**
 * Swap displays. The click or key press happened in this window, but it is the audience window
 * that must change its full screen, so the gesture is handed over with `delegate: "fullscreen"`.
 */
function swapDisplays(): void {
  const opener = window.opener as Window | null;
  if (!opener) return;
  try {
    opener.postMessage(SWAP_MESSAGE, { targetOrigin: window.location.origin, delegate: "fullscreen" } as WindowPostMessageOptions);
  } catch {
    opener.postMessage(SWAP_MESSAGE, window.location.origin); // a browser without capability delegation
  }
}
const keys = new KeyInterpreter();

const send = (command: Command): void => post({ t: "command", command });

// ---------------------------------------------------------------- deck

async function loadDeck(data: PresenterDeck): Promise<void> {
  if (deck) return; // a repeated answer to "ready"
  const opened = await openDeck(data.pdf);
  if (deck) {
    await opened.destroy();
    return;
  }
  opened.setSplit(data.split);
  deck = opened;
  document.title = `${data.title} — Lectern presenter`;
  document.documentElement.style.setProperty("--slide-aspect", String(opened.aspect));

  current = new SlideSurface($("current"), opened, 6);
  next = new SlideSurface($("next"), opened, 4);
  if (opened.notesCrop) notesImage = new SlideSurface($("notes-image"), opened, 4, "notes");

  const pdfpc = data.pdfpcText ? parsePdfpc(data.pdfpcText) : null;
  const build = (embedded: Map<number, string>): NotesTable =>
    assembleNotes({ overrides: data.noteOverrides, pdfpc, embedded, pptx: data.pptxNotes }, opened.frames);
  notes = build(new Map());
  void opened
    .loadEmbeddedNotes()
    .catch(() => new Map<number, string>())
    .then((embedded) => {
      notes = build(embedded);
      render();
    });

  $("waiting").hidden = true;
  $("app").hidden = false;
  render();
}

// ---------------------------------------------------------------- view

function render(): void {
  if (!deck || !state || !current || !next) return;
  const { frames, pageCount } = deck;
  const page = Math.min(state.committedPage, pageCount - 1);

  current.show(page, [page + 1, page - 1].filter((p) => p >= 0 && p < pageCount));
  next.show(page + 1 < pageCount ? page + 1 : page);
  void deck.loadLinks(page);

  const frame = frames.frameContaining(page);
  const builds = frame ? frame.lastPage - frame.firstPage + 1 : 1;
  $("where").textContent =
    `Frame ${frame?.label ?? "–"} / ${frames.frameCount}` + (builds > 1 ? `   Build ${frames.buildIndex(page) + 1}/${builds}` : "");

  // Notes: text if the deck has any for this slide; otherwise, for a Beamer notes-split deck, the notes half.
  const note = notes.noteFor(page, frames);
  const showImage = !note && notesImage !== null;
  $("notes").hidden = showImage;
  $("notes-image").hidden = !showImage;
  if (showImage) notesImage?.show(page);
  else {
    const html = note ? renderNotesHtml(note.text) : `<p class="empty">No notes for this slide.</p>`;
    const el = $("notes");
    if (el.dataset["html"] !== html) {
      el.dataset["html"] = html;
      el.innerHTML = html; // every piece of note text is escaped by renderNotesHtml
      el.scrollTop = 0;
    }
  }

  // FROZEN / BLACK / WHITE appear only in those modes.
  const mode = state.audienceMode.kind;
  const pill = $("pill");
  pill.hidden = mode === "live";
  pill.textContent = mode.toUpperCase();
  pill.className = `pill ${mode}`;

  // After a jump, "Back to Frame X"; after a Back, "Forward to Frame Y" (Native §6.2).
  const backPage = backTarget(state);
  const forwardPage = forwardTarget(state);
  const back = $("back");
  const forward = $("forward");
  back.hidden = backPage === null;
  if (backPage !== null) back.textContent = `Back to Frame ${frames.frameContaining(backPage)?.label ?? ""}`;
  forward.hidden = forwardPage === null;
  if (forwardPage !== null) forward.textContent = `Forward to Frame ${frames.frameContaining(forwardPage)?.label ?? ""}`;

  $("digits").textContent = keys.typedDigits === "" ? "" : `Go to frame ${keys.typedDigits}⏎`;
  $("laser").classList.toggle("on", laser);
  $("current").classList.toggle("laser", laser);

  if (overviewOpen && grid) {
    const shown = audiencePage(state);
    grid.mark(frame?.index ?? null, mode === "frozen" && shown !== null ? (frames.frameContaining(shown)?.index ?? null) : null);
  }
  tick();
}

function tick(): void {
  if (!state) return;
  const t = state.timer;
  const elapsed = elapsedMs(t, Date.now());
  const left = t.targetMs === null ? null : t.targetMs - elapsed;
  const running = t.runningSince !== null;
  const clock = $("clock");
  clock.textContent = `${running ? "" : "⏸ "}${formatClock(elapsed)}${left === null ? "" : ` · ${formatClock(left)}`}`;
  clock.className = `clock${!running ? " paused" : left === null ? "" : left >= 0 ? " good" : " over"}`;
  $("wall").textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  if (info) {
    const relay = performance.now() < noticeUntil ? notice :
      info.relay === "connected"
        ? info.remotes.length === 0
          ? "Phone: none connected"
          : `Phone: ${info.remotes.join(", ")}`
        : info.relay === "unavailable"
          ? "Phone remote unavailable"
          : "Phone remote: reconnecting…";
    $("relay").textContent = relay;
    const ms = (n: number | null): string => (n === null ? "–" : `${n.toFixed(1)} ms`);
    $("debug").textContent = [
      `input → audience draw   n=${info.draw.count}`,
      `  median ${ms(info.draw.medianMs)}   last ${ms(info.draw.lastMs)}   max ${ms(info.draw.maxMs)}`,
      `render-cache misses     ${info.cacheMisses}`,
      `relay                   ${info.relay}`,
      `remotes                 ${info.remotes.length === 0 ? "none" : info.remotes.join(", ")}`,
      `page ${state.committedPage + 1}   mode ${state.audienceMode.kind}   history ${state.history.length}`,
    ].join("\n");
  }
}

// ---------------------------------------------------------------- overview and search

function setOverview(open: boolean): void {
  if (!deck) return;
  overviewOpen = open;
  $("overview").hidden = !open;
  $("normal").hidden = open;
  $("right-title").textContent = open ? "Overview" : "Next";
  $("overview-toggle").classList.toggle("on", open);
  if (open) {
    grid ??= new ThumbGrid($("grid"), deck, {
      // A click jumps at once and pushes history; the overview stays open (Native §6.3).
      onPick: (frame) => send({ name: "goToPage", page: frame.firstPage }),
      hasNotes: (frame) => {
        for (let p = frame.firstPage; p <= frame.lastPage; p++) if (notes.byPage.has(p)) return true;
        return false;
      },
    });
    const frame = state ? deck.frames.frameContaining(state.committedPage) : undefined;
    grid.mark(frame?.index ?? null, null, true);
  } else {
    const search = $<HTMLInputElement>("search");
    search.value = "";
    search.blur();
    showHits("");
  }
  render();
}

async function ensureTexts(): Promise<string[]> {
  if (pageTexts) return pageTexts;
  const d = deck;
  if (!d) return [];
  const texts = await Promise.all(Array.from({ length: d.pageCount }, (_, p) => d.pageText(p)));
  pageTexts = texts;
  return texts;
}

function showHits(query: string): void {
  const results = $("results");
  const searching = query.trim() !== "";
  results.hidden = !searching;
  $("grid").hidden = searching;
  results.replaceChildren();
  if (!searching || !deck) return;
  if (hits.length === 0) {
    const none = document.createElement("p");
    none.className = "none";
    none.textContent = "No slides match.";
    results.append(none);
    return;
  }
  selectedHit = Math.min(selectedHit, hits.length - 1);
  hits.forEach((hit, i) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `hit${i === selectedHit ? " selected" : ""}`;
    const frame = document.createElement("span");
    frame.className = "frame";
    frame.textContent = `Frame ${deck?.frames.frames[hit.frameIndex]?.label ?? ""}`;
    button.append(frame, document.createTextNode(hit.snippet));
    button.addEventListener("click", () => send({ name: "goToPage", page: hit.page }));
    results.append(button);
  });
}

let searchRun = 0;
async function runSearch(): Promise<void> {
  const query = $<HTMLInputElement>("search").value;
  const run = ++searchRun;
  const texts = query.trim() === "" ? [] : await ensureTexts();
  if (run !== searchRun || !deck) return;
  hits = hitsByFrame(searchPages(texts, query, deck.frames));
  selectedHit = 0;
  showHits(query);
}

// ---------------------------------------------------------------- input

function setLaser(on: boolean): void {
  laser = on;
  if (!on) {
    current?.setDot(null);
    post({ t: "pointer", x: 0, y: 0, visible: false });
  }
  render();
}

function onKeyDown(ev: KeyboardEvent): void {
  if (!state) return;
  if (ev.ctrlKey && ev.shiftKey && (ev.key === "D" || ev.key === "d")) {
    ev.preventDefault();
    $("debug").hidden = !$("debug").hidden;
    return;
  }
  if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && !ev.shiftKey && (ev.key === "d" || ev.key === "D")) {
    ev.preventDefault(); // otherwise the browser bookmarks the page
    if (!ev.repeat) swapDisplays();
    return;
  }
  const plain = !ev.ctrlKey && !ev.altKey && !ev.metaKey;
  const inSearch = ev.target === $("search");

  if (inSearch && plain) {
    if (ev.key === "Enter") {
      ev.preventDefault();
      const hit = hits[selectedHit];
      if (hit) send({ name: "goToPage", page: hit.page });
      return;
    }
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      if (hits.length > 0) selectedHit = (selectedHit + (ev.key === "ArrowDown" ? 1 : hits.length - 1)) % hits.length;
      showHits($<HTMLInputElement>("search").value);
      return;
    }
    if (ev.key === "Escape") {
      ev.preventDefault();
      const search = $<HTMLInputElement>("search");
      if (search.value !== "") {
        search.value = "";
        void runSearch();
      } else {
        setOverview(false);
      }
      return;
    }
    // Page Up/Down still drive the talk (a clicker keeps working); everything else is typing.
    if (ev.key !== "Tab" && ev.key !== "PageDown" && ev.key !== "PageUp") return;
  }

  if (plain && ev.key === "Tab") {
    ev.preventDefault();
    setOverview(!overviewOpen);
    return;
  }
  if (plain && !ev.repeat && (ev.key === "l" || ev.key === "L")) {
    ev.preventDefault();
    setLaser(!laser);
    return;
  }
  // A single Esc first clears typed digits, then turns the laser off, then closes the overview;
  // only after that does it count towards ending the talk (Native §6.5).
  if (plain && ev.key === "Escape" && !ev.repeat && keys.typedDigits === "" && (laser || overviewOpen)) {
    ev.preventDefault();
    if (laser) setLaser(false);
    else setOverview(false);
    return;
  }

  const result = keys.interpret(
    { key: ev.key, shift: ev.shiftKey, ctrl: ev.ctrlKey, alt: ev.altKey, meta: ev.metaKey, repeat: ev.repeat, time: ev.timeStamp },
    state,
  );
  if (result.handled) ev.preventDefault();
  if (result.end) post({ t: "end" });
  else if (result.command) send(result.command);
  $("digits").textContent = keys.typedDigits === "" ? "" : `Go to frame ${keys.typedDigits}⏎`;
}

function bind(): void {
  window.addEventListener("keydown", onKeyDown, { capture: true });

  const cur = $("current");
  cur.addEventListener("click", (ev) => {
    if (!deck || !state || !current) return;
    const page = state.committedPage;
    const point = current.pointAt(ev.clientX, ev.clientY);
    const links = deck.linksNow(page);
    const index = point && links && current.shownPage === page ? hitTest(links, point.x, point.y) : -1;
    // A link follows the link; anywhere else advances (Native §6.5).
    send(index >= 0 ? { name: "followLink", page, index } : { name: "next" });
  });
  cur.addEventListener("mousemove", (ev) => {
    if (!laser || !current) return;
    const point = current.pointAt(ev.clientX, ev.clientY);
    if (!point) return;
    current.setDot(point);
    const now = performance.now();
    if (now - lastPointerSent < 16) return; // at most ~60 a second
    lastPointerSent = now;
    post({ t: "pointer", ...point, visible: true });
  });
  cur.addEventListener("mouseleave", () => {
    if (!laser) return;
    current?.setDot(null);
    post({ t: "pointer", x: 0, y: 0, visible: false });
  });

  $("next").addEventListener("click", () => send({ name: "next" }));
  $("laser").addEventListener("click", () => setLaser(!laser));
  $("swap").addEventListener("click", swapDisplays);
  $("back").addEventListener("click", () => send({ name: "back" }));
  $("forward").addEventListener("click", () => send({ name: "forward" }));
  $("overview-toggle").addEventListener("click", () => setOverview(!overviewOpen));
  $("clock").addEventListener("click", () => send({ name: "timerToggle" }));
  $("clock-reset").addEventListener("click", () => send({ name: "timerReset" }));
  $("search").addEventListener("input", () => void runSearch());

  const setNotesSize = (px: number): void => {
    notesSize = Math.min(48, Math.max(12, px));
    document.documentElement.style.setProperty("--notes-size", `${notesSize}px`);
  };
  $("notes-smaller").addEventListener("click", () => setNotesSize(notesSize - 2));
  $("notes-larger").addEventListener("click", () => setNotesSize(notesSize + 2));

  // Buttons keep focus after a click; Space or Enter from a clicker would then press them again.
  document.addEventListener("click", (ev) => {
    if (ev.target instanceof HTMLButtonElement) ev.target.blur();
  });

  // The divider between the panes. The layout is not saved: nothing is stored on the room PC.
  const divider = $("divider");
  divider.addEventListener("pointerdown", (down) => {
    divider.setPointerCapture(down.pointerId);
    const move = (ev: PointerEvent): void => {
      const fraction = Math.min(0.8, Math.max(0.2, ev.clientX / window.innerWidth));
      document.documentElement.style.setProperty("--left", `${(fraction * 100).toFixed(1)}%`);
    };
    const up = (): void => {
      divider.removeEventListener("pointermove", move);
      divider.removeEventListener("pointerup", up);
    };
    divider.addEventListener("pointermove", move);
    divider.addEventListener("pointerup", up);
  });

  window.setInterval(tick, 500);
  window.addEventListener("pagehide", () => post({ t: "closed" }));
}

function wipe(): void {
  current?.destroy();
  next?.destroy();
  notesImage?.destroy();
  grid?.destroy();
  $("notes").replaceChildren();
  const d = deck;
  deck = null;
  state = null;
  void d?.destroy();
}

if (channel) {
  bind();
  channel.onmessage = (ev: MessageEvent) => {
    const message = ev.data as ToPresenter;
    if (message.t === "deck") void loadDeck(message.deck);
    else if (message.t === "state") {
      state = message.state;
      info = message.info;
      render();
    } else if (message.t === "notice") {
      notice = message.text;
      noticeUntil = performance.now() + 8000;
      tick();
    } else if (message.t === "end") {
      // The talk is over: drop everything decrypted and go.
      wipe();
      channel.close();
      window.close();
      $("app").hidden = true;
      $("waiting").hidden = false;
      $("waiting").textContent = "The talk has ended. You can close this window.";
    }
  };
  // Ask for the deck until it arrives (the audience window may still be settling into full screen).
  const asking = window.setInterval(() => {
    if (deck) window.clearInterval(asking);
    else post({ t: "ready" });
  }, 300);
  post({ t: "ready" });

  if (import.meta.env.DEV) {
    (window as unknown as { __presenter?: unknown }).__presenter = {
      shownPage: () => current?.shownPage ?? null,
      hits: () => hits,
      overviewOpen: () => overviewOpen,
      laser: () => laser,
    };
  }
}
