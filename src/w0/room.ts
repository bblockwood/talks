// W0 throwaway: room PC smoke test (SPEC §10 W0). Nothing here is reused by the real app.
import { GlobalWorkerOptions, getDocument, AnnotationMode } from "pdfjs-dist";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import deckUrl from "../../fixtures/overlays.pdf?url";
import { connectRelay, randomPairing, roomIdFromPairing, RELAY_URL } from "./relay";
import type { RelayHandle } from "./relay";

GlobalWorkerOptions.workerSrc = workerUrl;

const BASE = import.meta.env.BASE_URL;
const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

const stage = $("stage");
const canvas = $<HTMLCanvasElement>("slide");
const hud = $("hud");
const startButton = $<HTMLButtonElement>("start");

// ---------------------------------------------------------------- results

const results: Record<string, string> = {};
function setResult(id: string, text: string, state: "ok" | "bad" | "" = ""): void {
  results[id] = text;
  const el = $(id);
  el.textContent = text;
  el.classList.toggle("ok", state === "ok");
  el.classList.toggle("bad", state === "bad");
  updateReport();
}
const errText = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

// ---------------------------------------------------------------- slides

let pdf: PDFDocumentProxy | null = null;
let labels: string[] | null = null;
let page = 1;
let renderTask: RenderTask | null = null;
let renderGeneration = 0;
const renderMs: number[] = [];
const keyToDrawMs: number[] = [];

const median = (xs: number[]): number => {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? NaN;
};
const stats = (xs: number[]): string =>
  xs.length === 0 ? "none" : `n=${xs.length}, median ${median(xs).toFixed(0)} ms, max ${Math.max(...xs).toFixed(0)} ms`;

async function loadDeck(): Promise<void> {
  const t0 = performance.now();
  try {
    pdf = await getDocument({
      url: deckUrl,
      cMapUrl: `${BASE}pdfjs/cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${BASE}pdfjs/standard_fonts/`,
      wasmUrl: `${BASE}pdfjs/wasm/`,
      iccUrl: `${BASE}pdfjs/iccs/`,
    }).promise;
    labels = await pdf.getPageLabels();
    const frames = labels ? new Set(labels).size : pdf.numPages;
    setResult(
      "pdf-status",
      `Loaded: ${pdf.numPages} pages, ${frames} frames, in ${(performance.now() - t0).toFixed(0)} ms.`,
      "ok",
    );
    startButton.disabled = false;
    await render();
  } catch (e) {
    setResult("pdf-status", `PDF.js failed: ${errText(e)}`, "bad");
  }
}

/** Renders the current page off screen at the stage's pixel size, then swaps it in with one draw. */
async function render(keyTime?: number): Promise<void> {
  if (!pdf) return;
  const generation = ++renderGeneration;
  renderTask?.cancel();
  const t0 = performance.now();
  try {
    const p = await pdf.getPage(page);
    const box = stage.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const unit = p.getViewport({ scale: 1 });
    const cssScale = Math.min(box.width / unit.width, box.height / unit.height);
    const viewport = p.getViewport({ scale: cssScale * dpr });

    const off = document.createElement("canvas");
    off.width = Math.round(viewport.width);
    off.height = Math.round(viewport.height);
    const task = p.render({ canvas: off, viewport, annotationMode: AnnotationMode.DISABLE });
    renderTask = task;
    await task.promise;
    if (generation !== renderGeneration) return;

    canvas.width = off.width;
    canvas.height = off.height;
    canvas.style.width = `${off.width / dpr}px`;
    canvas.style.height = `${off.height / dpr}px`;
    canvas.getContext("2d")?.drawImage(off, 0, 0);

    const now = performance.now();
    renderMs.push(now - t0);
    if (keyTime !== undefined) keyToDrawMs.push(now - keyTime);
    relay?.send({ type: "state", page, pageCount: pdf.numPages });
    updateHud();
    updateReport();
  } catch (e) {
    if (e instanceof Error && e.name === "RenderingCancelledException") return;
    setResult("pdf-status", `Render failed on page ${page}: ${errText(e)}`, "bad");
  }
}

function go(delta: number, keyTime?: number): void {
  if (!pdf) return;
  const next = Math.min(pdf.numPages, Math.max(1, page + delta));
  if (next === page) return;
  page = next;
  void render(keyTime);
}

new ResizeObserver(() => void render()).observe(stage);

// ---------------------------------------------------------------- full screen, keyboard lock, wake lock

let exitRequestedByPage = false;
let lastEscape = -Infinity;
const exits: string[] = [];
let wakeLock: WakeLockSentinel | null = null;
let wantWakeLock = false;
let companion: Window | null = null;

async function requestWakeLock(): Promise<void> {
  if (!("wakeLock" in navigator)) {
    setResult("r-wakelock", "not supported in this browser", "bad");
    return;
  }
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    setResult("r-wakelock", "held", "ok");
    wakeLock.addEventListener("release", () => setResult("r-wakelock", "released"));
  } catch (e) {
    setResult("r-wakelock", `refused: ${errText(e)}`, "bad");
  }
}

document.addEventListener("visibilitychange", () => {
  if (wantWakeLock && document.visibilityState === "visible") void requestWakeLock();
});

async function lockKeyboard(): Promise<void> {
  const lock = navigator.keyboard?.lock;
  if (!lock) {
    setResult("r-kblock", "not supported in this browser (one Esc will leave full screen)", "bad");
    return;
  }
  try {
    await lock.call(navigator.keyboard, ["Escape"]);
    setResult("r-kblock", "locked: now press Esc once and check you stay in full screen", "ok");
  } catch (e) {
    setResult("r-kblock", `refused: ${errText(e)}`, "bad");
  }
}

async function enterFullscreen(screen?: ScreenDetailed): Promise<boolean> {
  const where = screen ? "r-placed" : "r-fullscreen";
  if (!document.fullscreenEnabled) {
    setResult(where, "blocked: this browser or PC does not allow full screen (try F11)", "bad");
    return false;
  }
  try {
    await stage.requestFullscreen(screen ? { navigationUI: "hide", screen } : { navigationUI: "hide" });
  } catch (e) {
    setResult(where, `refused: ${errText(e)}`, "bad");
    return false;
  }
  setResult(where, screen ? `entered on “${screen.label || "unnamed screen"}”` : "entered", "ok");
  wantWakeLock = true;
  // Deliberately not awaited: both report their own results, and a companion window
  // (step 3) must open while the click still counts as a user gesture.
  void lockKeyboard();
  void requestWakeLock();
  stage.focus();
  return true;
}

document.addEventListener("fullscreenchange", () => {
  const on = document.fullscreenElement === stage;
  hud.hidden = !on;
  logLine(on ? "— entered full screen —" : "— left full screen —");
  if (!on) {
    exits.push(exitRequestedByPage ? "double Esc (handled by page)" : "browser exited (single or held Esc, or something else)");
    exitRequestedByPage = false;
    setResult("r-exits", exits.map((e, i) => `${i + 1}. ${e}`).join("; "));
    navigator.keyboard?.unlock?.();
    wantWakeLock = false;
    void wakeLock?.release();
    companion?.close();
    companion = null;
  }
  updateHud();
});

startButton.addEventListener("click", () => void enterFullscreen());

// ---------------------------------------------------------------- two screens

let screenDetails: ScreenDetails | null = null;

const describeScreen = (s: ScreenDetailed): string =>
  `“${s.label || "unnamed"}” ${s.width}×${s.height} at (${s.left},${s.top}), dpr ${s.devicePixelRatio}` +
  `${s.isPrimary ? ", primary" : ""}${s.isInternal ? ", internal" : ""}`;

$("detect").addEventListener("click", async () => {
  const list = $("screen-list");
  list.replaceChildren();
  if (!window.getScreenDetails) {
    setResult(
      "r-screens",
      `Window Management not supported in this browser. screen.isExtended = ${String(window.screen.isExtended)}`,
      "bad",
    );
    return;
  }
  try {
    screenDetails = await window.getScreenDetails();
  } catch (e) {
    setResult("r-screens", `refused: ${errText(e)}`, "bad");
    return;
  }
  const { screens, currentScreen } = screenDetails;
  setResult(
    "r-screens",
    `${screens.length} screen(s): ${screens.map(describeScreen).join(" | ")}. Browser is on “${currentScreen.label || "unnamed"}”.` +
      (screens.length < 2 ? " One screen only (or the displays are mirrored)." : ""),
    screens.length >= 2 ? "ok" : "",
  );

  for (const s of screens) {
    const row = document.createElement("div");
    row.className = "screen-row";
    const name = document.createElement("span");
    name.textContent = describeScreen(s);
    const here = document.createElement("button");
    here.textContent = "Full screen here";
    here.addEventListener("click", () => void enterFullscreen(s));
    row.append(name, here);

    const other = screens.find((o) => o !== s);
    if (other) {
      const both = document.createElement("button");
      both.textContent = "Full screen here + second window on the other screen";
      both.addEventListener("click", () => void fullscreenWithCompanion(s, other));
      row.append(both);
    }
    list.append(row);
  }
});

/** Mode B rehearsal: slides full screen on one screen, a plain window on the other, from one click. */
async function fullscreenWithCompanion(audience: ScreenDetailed, presenter: ScreenDetailed): Promise<void> {
  if (!(await enterFullscreen(audience))) return;
  const want = {
    left: presenter.availLeft + 40,
    top: presenter.availTop + 40,
    width: Math.min(900, presenter.availWidth - 80),
    height: Math.min(600, presenter.availHeight - 80),
  };
  const w = window.open(
    "",
    "lectern-w0-presenter",
    `popup,left=${want.left},top=${want.top},width=${want.width},height=${want.height}`,
  );
  if (!w) {
    setResult("r-companion", "blocked: the browser did not open the second window (pop-up blocker)", "bad");
    return;
  }
  companion = w;
  w.document.title = "Lectern W0: presenter window";
  w.document.body.style.cssText = "font: 2rem system-ui; padding: 2rem; background: #111; color: #eee";
  w.document.body.textContent = "Presenter window. It should be on the screen WITHOUT the slides.";
  window.setTimeout(() => {
    if (w.closed) return;
    const onPresenter =
      w.screenX >= presenter.left &&
      w.screenX < presenter.left + presenter.width &&
      w.screenY >= presenter.top &&
      w.screenY < presenter.top + presenter.height;
    setResult(
      "r-companion",
      `opened at (${w.screenX},${w.screenY}), asked for (${want.left},${want.top}): ` +
        (onPresenter ? "on the other screen" : "NOT on the other screen"),
      onPresenter ? "ok" : "bad",
    );
  }, 800);
}

// ---------------------------------------------------------------- keys

const keyLines: string[] = [];
let keyCount = 0;
const t0 = performance.now();

function logLine(line: string): void {
  keyLines.push(line);
  $("keylog").textContent = keyLines.slice(-40).join("\n");
  $("keylog").scrollTop = $("keylog").scrollHeight;
  updateHud();
  updateReport();
}

const NEXT_KEYS = new Set(["ArrowRight", "ArrowDown", " ", "PageDown", "Enter", "n", "N"]);
const PREV_KEYS = new Set(["ArrowLeft", "ArrowUp", "PageUp", "p", "P"]);
// Keys a clicker may send whose browser default would hurt: F5 reloads, Tab moves focus, etc.
const SWALLOW = new Set(["F5", "Escape", "Tab", "b", "B", ".", "Home", "End"]);

window.addEventListener(
  "keydown",
  (ev: KeyboardEvent) => {
    keyCount += 1;
    const mods = [ev.ctrlKey && "Ctrl", ev.altKey && "Alt", ev.shiftKey && "Shift", ev.metaKey && "Meta"]
      .filter(Boolean)
      .join("+");
    const secs = ((ev.timeStamp - t0) / 1000).toFixed(2).padStart(7);
    const where = document.fullscreenElement ? "FS" : "  ";
    logLine(
      `${secs}s ${where} key=${JSON.stringify(ev.key)} code=${ev.code || "?"} keyCode=${ev.keyCode}` +
        `${mods ? ` mods=${mods}` : ""}${ev.repeat ? " (repeat)" : ""}`,
    );
    setResult("r-keys", `${keyCount} key presses`);

    if (ev.ctrlKey || ev.metaKey || ev.altKey) return; // leave browser shortcuts alone

    if (NEXT_KEYS.has(ev.key) || PREV_KEYS.has(ev.key) || SWALLOW.has(ev.key)) ev.preventDefault();
    if (ev.repeat) return;
    if (NEXT_KEYS.has(ev.key)) go(1, ev.timeStamp);
    else if (PREV_KEYS.has(ev.key)) go(-1, ev.timeStamp);
    else if (ev.key === "Escape" && document.fullscreenElement) {
      // Only reachable in full screen when keyboard lock is on. Esc twice within 1 s ends (Native §6.5).
      if (ev.timeStamp - lastEscape < 1000) {
        exitRequestedByPage = true;
        void document.exitFullscreen();
      }
      lastEscape = ev.timeStamp;
    }
  },
  { capture: true },
);

function updateHud(): void {
  if (hud.hidden || !pdf) return;
  hud.textContent = [
    `page ${page}/${pdf.numPages}  frame ${labels?.[page - 1] ?? "?"}  last render ${(renderMs.at(-1) ?? NaN).toFixed(0)} ms`,
    `keyboard lock: ${results["r-kblock"] ?? "?"}`,
    `phone: ${results["r-phone"] ?? "not seen yet"}`,
    "Esc twice quickly (or hold Esc) to leave",
    "",
    ...keyLines.slice(-8),
  ].join("\n");
}

// ---------------------------------------------------------------- relay

let relay: RelayHandle | null = null;
let pingsAnswered = 0;
let commandsReceived = 0;
const pairing = randomPairing();
$("pairing").textContent = pairing;
$("phone-url").textContent = `${location.host}${BASE}w0/phone`;

async function startRelay(): Promise<void> {
  const roomId = await roomIdFromPairing(pairing);
  const handle = connectRelay(
    roomId,
    (msg) => {
      if (msg.type === "hello" && msg.from === "phone") {
        handle.send({ type: "hello", from: "room" });
        if (pdf) handle.send({ type: "state", page, pageCount: pdf.numPages });
      } else if (msg.type === "ping") {
        handle.send({ type: "pong", t: msg.t });
        pingsAnswered += 1;
      } else if (msg.type === "command") {
        commandsReceived += 1;
        go(msg.name === "next" ? 1 : -1);
      } else {
        return;
      }
      setResult("r-phone", `connected: ${pingsAnswered} pings answered, ${commandsReceived} commands received`, "ok");
    },
    (status, detail) => {
      setResult(
        "r-relay",
        `${status}${detail ? ` (${detail})` : ""}`,
        status === "connected" ? "ok" : status === "connecting" ? "" : "bad",
      );
      if (status === "connected") handle.send({ type: "hello", from: "room" });
    },
  );
  relay = handle;
}

// ---------------------------------------------------------------- report

function buildReport(): string {
  const nav = navigator as Navigator & { userAgentData?: { brands?: { brand: string; version: string }[]; platform?: string } };
  const brands = nav.userAgentData?.brands?.map((b) => `${b.brand} ${b.version}`).join(", ");
  const has = (ok: boolean): string => (ok ? "yes" : "NO");
  const lines = [
    "Lectern W0 report",
    `time: ${new Date().toISOString()}`,
    `url: ${location.origin}${location.pathname}`,
    `user agent: ${navigator.userAgent}`,
    ...(brands ? [`brands: ${brands} on ${nav.userAgentData?.platform ?? "?"}`] : []),
    `secure context: ${has(window.isSecureContext)}`,
    `window: ${window.innerWidth}×${window.innerHeight}, screen: ${window.screen.width}×${window.screen.height}, dpr ${window.devicePixelRatio}`,
    `screen.isExtended: ${String(window.screen.isExtended)}`,
    "",
    "Support",
    `  fullscreen allowed: ${has(document.fullscreenEnabled)}`,
    `  keyboard lock: ${has(typeof navigator.keyboard?.lock === "function")}`,
    `  wake lock: ${has("wakeLock" in navigator)}`,
    `  window management: ${has(typeof window.getScreenDetails === "function")}`,
    `  OffscreenCanvas: ${has(typeof OffscreenCanvas === "function")}`,
    `  createImageBitmap: ${has(typeof createImageBitmap === "function")}`,
    `  BroadcastChannel: ${has(typeof BroadcastChannel === "function")}`,
    `  service worker: ${has("serviceWorker" in navigator)}`,
    "",
    "Results",
    `  1 slides: ${results["pdf-status"] ?? "loading"}`,
    `    renders: ${stats(renderMs)}`,
    `    key → draw: ${stats(keyToDrawMs)}`,
    `  2 full screen: ${results["r-fullscreen"] ?? "not tried"}`,
    `    keyboard lock: ${results["r-kblock"] ?? "not tried"}`,
    `    wake lock: ${results["r-wakelock"] ?? "not tried"}`,
    `    exits: ${results["r-exits"] ?? "none yet"}`,
    `  3 screens: ${results["r-screens"] ?? "not tried"}`,
    `    placed full screen: ${results["r-placed"] ?? "not tried"}`,
    `    second window: ${results["r-companion"] ?? "not tried"}`,
    `  5 relay: ${RELAY_URL ? results["r-relay"] ?? "starting" : "not configured in this build"}`,
    `    phone: ${results["r-phone"] ?? "not seen yet"}`,
    "",
    `Keys (${keyCount} presses; last ${Math.min(keyLines.length, 300)} log lines)`,
    ...keyLines.slice(-300).map((l) => `  ${l}`),
  ];
  return lines.join("\n");
}

let reportQueued = false;
function updateReport(): void {
  if (reportQueued) return;
  reportQueued = true;
  queueMicrotask(() => {
    reportQueued = false;
    $("report").textContent = buildReport();
  });
}

$("send-report").addEventListener("click", () => {
  const sent = relay?.send({ type: "report", text: buildReport() }) ?? false;
  $("r-report").textContent = sent
    ? `sent at ${new Date().toLocaleTimeString()}: check the phone`
    : "not sent: the relay is not connected";
});

$("copy-report").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(buildReport());
    $("r-report").textContent = "copied";
  } catch (e) {
    $("r-report").textContent = `copy failed: ${errText(e)}`;
  }
});

// Buttons keep focus after a click, and Space/Enter would then press them again.
document.addEventListener("click", (ev) => {
  if (ev.target instanceof HTMLButtonElement) ev.target.blur();
});

updateReport();
void loadDeck();
void startRelay();
