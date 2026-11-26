// Audience view (SPEC §5.3, §6.4). One canvas, one draw per change, letterboxed on black.
// It never shows status, errors or toasts, and hides the cursor after 2 s without movement.
import { hitTest } from "../core/links";
import { fitPage } from "../core/prefetch";
import { audiencePage, inkLayer } from "../core/session";
import type { Stroke } from "../core/ink";
import { drawStrokes } from "../shared/ink-draw";
import type { SessionState } from "../core/session";
import type { Deck } from "../shared/deck";
import { release } from "../shared/render-cache";
import type { RenderCache } from "../shared/render-cache";

const CURSOR_IDLE_MS = 2000;
const POINTER_IDLE_MS = 2000;
const POINTER_TRAIL_MS = 300;

interface Shown {
  /** Page on screen, or null for black/white. */
  page: number | null;
  /** Where the slide sits on the canvas, in device pixels. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export class AudienceView {
  /** A click landed on a navigational link of the page on screen. */
  onLink: ((page: number, index: number) => void) | null = null;

  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly resizeObserver: ResizeObserver;
  private state: SessionState | null = null;
  private shown: Shown | null = null;
  private surfaceWidth = 0;
  private surfaceHeight = 0;
  /** `performance.now()`-based time of the input that caused the pending change, if any. */
  private pendingInputTime: number | null = null;
  private cursorTimer: number | undefined;
  private inkCanvas: HTMLCanvasElement | null = null;
  private inkDrawn: readonly Stroke[] | null = null;
  private pointerLayer: HTMLCanvasElement | null = null;
  private pointerFrame = 0;
  private pointerUntil = 0;
  private trail: { x: number; y: number; t: number }[] = [];
  private lastPointer: { x: number; y: number } | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly cache: RenderCache,
    private readonly deck: Deck,
  ) {
    this.canvas = document.createElement("canvas");
    const context = this.canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("2D canvas unavailable");
    this.context = context;
    root.replaceChildren(this.canvas);

    this.cache.onReady = () => this.paint();
    this.resizeObserver = new ResizeObserver(() => this.measure());
    this.resizeObserver.observe(root);
    this.measure();

    root.addEventListener("mousemove", this.onMouseMove);
    root.addEventListener("click", this.onClick);
    root.classList.add("cursor-hidden");
  }

  /** Renders from the state. `inputTime` is when the causing key or command arrived. */
  show(state: SessionState, inputTime?: number): void {
    this.state = state;
    if (inputTime !== undefined) this.pendingInputTime = inputTime;
    this.paint();
  }

  /**
   * The presenter's pointer, in normalised slide coordinates (SPEC §8.2, Native §6.4): a red dot
   * about 1.2% of the slide height with a soft glow and a short fading trail. It hides by itself
   * after two seconds without movement.
   */
  setPointer(x: number, y: number, visible: boolean): void {
    const now = performance.now();
    if (!visible) {
      this.pointerUntil = 0;
    } else {
      this.trail.push({ x, y, t: now });
      this.pointerUntil = now + POINTER_IDLE_MS;
    }
    if (this.pointerFrame === 0) this.pointerFrame = requestAnimationFrame(this.drawPointer);
  }

  /** True while the pointer is being drawn (development and tests only). */
  get pointerVisible(): boolean {
    return this.pointerFrame !== 0;
  }

  private readonly drawPointer = (): void => {
    this.pointerFrame = 0;
    const shown = this.shown;
    const now = performance.now();
    this.trail = this.trail.filter((p) => now - p.t <= POINTER_TRAIL_MS).slice(-64);
    const last = this.trail.at(-1) ?? this.lastPointer;
    const live = now < this.pointerUntil && shown !== null && shown.page !== null && shown.width > 0;

    let layer = this.pointerLayer;
    if (!layer) {
      if (!live) return;
      layer = document.createElement("canvas");
      layer.className = "pointer-layer";
      this.root.append(layer);
      this.pointerLayer = layer;
    }
    if (layer.width !== this.surfaceWidth || layer.height !== this.surfaceHeight) {
      layer.width = this.surfaceWidth;
      layer.height = this.surfaceHeight;
    }
    const ctx = layer.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, layer.width, layer.height);
    if (!live || !shown || !last) {
      this.trail = [];
      this.lastPointer = null;
      return; // cleared; stop animating until the pointer moves again
    }
    this.lastPointer = last;
    const radius = Math.max(3, shown.height * 0.006);
    const at = (p: { x: number; y: number }): [number, number] => [shown.x + p.x * shown.width, shown.y + p.y * shown.height];
    for (const p of this.trail) {
      const age = (now - p.t) / POINTER_TRAIL_MS;
      const [px, py] = at(p);
      ctx.beginPath();
      ctx.arc(px, py, radius * (1 - age * 0.5), 0, Math.PI * 2);
      ctx.fillStyle = `rgba(230, 25, 25, ${(0.35 * (1 - age)).toFixed(3)})`;
      ctx.fill();
    }
    const [cx, cy] = at(last);
    ctx.save();
    ctx.shadowColor = "rgba(230, 25, 25, 0.9)";
    ctx.shadowBlur = radius * 2.5;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fillStyle = "rgb(230, 25, 25)";
    ctx.fill();
    ctx.restore();
    this.pointerFrame = requestAnimationFrame(this.drawPointer);
  };

  /** What is on screen right now (development and tests only). */
  get shownPage(): number | null | undefined {
    return this.shown ? this.shown.page : undefined;
  }

  /** Clears the screen and detaches everything (End, SPEC §5.3). */
  wipe(): void {
    this.resizeObserver.disconnect();
    this.root.removeEventListener("mousemove", this.onMouseMove);
    this.root.removeEventListener("click", this.onClick);
    window.clearTimeout(this.cursorTimer);
    cancelAnimationFrame(this.pointerFrame);
    this.pointerFrame = 0;
    if (this.pointerLayer) release(this.pointerLayer);
    this.pointerLayer = null;
    if (this.inkCanvas) release(this.inkCanvas);
    this.inkCanvas = null;
    this.inkDrawn = null;
    this.cache.onReady = null;
    this.onLink = null;
    this.state = null;
    this.shown = null;
    release(this.canvas);
    this.root.replaceChildren();
    this.root.classList.remove("cursor-hidden", "cursor-link");
  }

  private measure(): void {
    const dpr = window.devicePixelRatio || 1;
    const width = Math.round(this.root.clientWidth * dpr);
    const height = Math.round(this.root.clientHeight * dpr);
    if (width === 0 || height === 0) return;
    if (width === this.surfaceWidth && height === this.surfaceHeight) return;
    this.surfaceWidth = width;
    this.surfaceHeight = height;
    // The canvas keeps its old picture (scaled by CSS) until the first page at the new size is ready.
    this.cache.setSurface(width, height);
    this.paint();
  }

  private paint(): void {
    const state = this.state;
    if (!state || this.surfaceWidth === 0) return;
    const page = audiencePage(state);

    if (page === null) {
      const white = state.audienceMode.kind === "white";
      this.fill(white ? "#ffffff" : "#000000");
      // The white screen is the whiteboard. Ink on it is placed as if a slide were there, so
      // what is drawn on the phone lands in the same place on the projector.
      const size = this.deck.pageSize;
      const crop = this.deck.slideCrop;
      const board = fitPage(size.width * crop.width, size.height * crop.height, this.surfaceWidth, this.surfaceHeight);
      this.shown = white
        ? { page: null, x: board.x, y: board.y, width: board.width, height: board.height }
        : { page: null, x: 0, y: 0, width: 0, height: 0 };
      this.paintInk();
      this.finish();
      return;
    }

    const rendered = this.cache.get(page);
    if (!rendered) return; // keep the old image; the cache calls back when the page is ready

    const { canvas: source } = rendered;
    const x = Math.floor((this.surfaceWidth - source.width) / 2);
    const y = Math.floor((this.surfaceHeight - source.height) / 2);
    const already = this.shown;
    if (
      already &&
      already.page === page &&
      already.width === source.width &&
      already.height === source.height &&
      this.canvas.width === this.surfaceWidth &&
      this.canvas.height === this.surfaceHeight
    ) {
      this.paintInk();
      this.finish();
      return;
    }
    // Everything below happens in one task, so the browser presents it as a single frame.
    this.fill("#000000");
    this.context.drawImage(source, x, y);
    this.shown = { page, x, y, width: source.width, height: source.height };
    this.paintInk(true);
    this.finish();
  }

  /**
   * Ink sits on its own layer above the slide, redrawn as vectors whenever the strokes or the
   * slide's place on screen change. While a new page is still rendering, the old slide stays up
   * and so the layer is cleared rather than showing the new page's (empty) ink over it.
   */
  private paintInk(force = false): void {
    const state = this.state;
    const shown = this.shown;
    if (!state || !shown) return;
    const mode = state.audienceMode.kind;
    const visible = (mode === "live" && shown.page === state.committedPage) || mode === "white";
    const strokes = visible ? state.ink[inkLayer(state)] : [];
    if (!this.inkCanvas && strokes.length === 0) return;
    let layer = this.inkCanvas;
    if (!layer) {
      layer = document.createElement("canvas");
      layer.className = "ink-layer";
      this.canvas.after(layer);
      this.inkCanvas = layer;
    }
    const resized = layer.width !== this.surfaceWidth || layer.height !== this.surfaceHeight;
    if (!force && !resized && strokes === this.inkDrawn) return;
    if (resized) {
      layer.width = this.surfaceWidth;
      layer.height = this.surfaceHeight;
    }
    const ctx = layer.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, layer.width, layer.height);
    drawStrokes(ctx, strokes, shown);
    this.inkDrawn = strokes;
  }

  /** Strokes currently drawn for the audience (development and tests only). */
  get inkShown(): number {
    return this.inkDrawn?.length ?? 0;
  }

  private fill(color: string): void {
    if (this.canvas.width !== this.surfaceWidth || this.canvas.height !== this.surfaceHeight) {
      this.canvas.width = this.surfaceWidth;
      this.canvas.height = this.surfaceHeight;
    }
    this.context.fillStyle = color;
    this.context.fillRect(0, 0, this.surfaceWidth, this.surfaceHeight);
  }

  private finish(): void {
    if (this.pendingInputTime === null) return;
    // Input → audience draw, for the debug overlay and the W3 latency target (SPEC §6.4).
    try {
      performance.measure("lectern:input-to-draw", { start: this.pendingInputTime, end: performance.now() });
    } catch {
      // Timing is best-effort.
    }
    this.pendingInputTime = null;
  }

  /** The link under a mouse event, if the audience is looking at a live page. */
  private linkAt(ev: MouseEvent): { page: number; index: number } | null {
    const shown = this.shown;
    if (!shown || shown.page === null || shown.width === 0 || this.state?.audienceMode.kind !== "live") return null;
    const box = this.canvas.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return null;
    const px = ((ev.clientX - box.left) / box.width) * this.canvas.width;
    const py = ((ev.clientY - box.top) / box.height) * this.canvas.height;
    const links = this.deck.linksNow(shown.page);
    if (!links) return null;
    const index = hitTest(links, (px - shown.x) / shown.width, (py - shown.y) / shown.height);
    return index < 0 ? null : { page: shown.page, index };
  }

  private readonly onMouseMove = (ev: MouseEvent): void => {
    this.root.classList.remove("cursor-hidden");
    this.root.classList.toggle("cursor-link", this.linkAt(ev) !== null);
    window.clearTimeout(this.cursorTimer);
    this.cursorTimer = window.setTimeout(() => this.root.classList.add("cursor-hidden"), CURSOR_IDLE_MS);
  };

  private readonly onClick = (ev: MouseEvent): void => {
    // Clicks on link areas follow links; clicks elsewhere do nothing (SPEC §5.3).
    const hit = this.linkAt(ev);
    if (hit) this.onLink?.(hit.page, hit.index);
  };
}
