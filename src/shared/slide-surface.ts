// A slide shown in a box: the phone's current and next slide, thumbnails, and later the
// presenter view. Like the audience view it only ever draws finished pages.
import { release, RenderCache } from "./render-cache";
import type { Deck } from "./deck";
import { fitPage } from "../core/prefetch";
import type { Stroke } from "../core/ink";
import { drawStrokes } from "./ink-draw";

export class SlideSurface {
  readonly canvas: HTMLCanvasElement;
  private readonly cache: RenderCache;
  private readonly observer: ResizeObserver;
  private page: number | null = null;
  private ahead: number[] = [];
  private width = 0;
  private height = 0;
  private drawn: { page: number; x: number; y: number; width: number; height: number } | null = null;
  private dot: { x: number; y: number } | null = null;
  private ink: readonly Stroke[] = [];
  private blank = false;
  private readonly deckRef: Deck;

  constructor(
    private readonly host: HTMLElement,
    deck: Deck,
    capacity = 8,
    part: "slide" | "notes" = "slide",
  ) {
    this.deckRef = deck;
    this.canvas = document.createElement("canvas");
    host.replaceChildren(this.canvas);
    this.cache = new RenderCache(deck, capacity, part);
    this.cache.onReady = () => this.paint();
    this.observer = new ResizeObserver(() => this.measure());
    this.observer.observe(host);
    this.measure();
  }

  /** Shows `page` (null leaves the box as it is) and renders `ahead` in the background. */
  show(page: number | null, ahead: readonly number[] = []): void {
    this.page = page;
    this.ahead = [...ahead];
    this.request();
    this.paint();
  }

  /** Re-renders everything, e.g. after the deck's notes split changed. */
  refresh(): void {
    this.drawn = null;
    this.cache.invalidate();
    this.request();
  }

  /** The page currently drawn, which lags `show` until its render is ready. */
  get shownPage(): number | null {
    return this.drawn?.page ?? null;
  }

  /** A red dot at a normalised slide position (the phone's own view of its pointer), or null to remove it. */
  setDot(dot: { x: number; y: number } | null): void {
    this.dot = dot;
    this.drawn = null; // force a repaint
    this.paint();
  }

  /** Ink to draw over the slide. Pass the same array again and nothing is redrawn. */
  setInk(strokes: readonly Stroke[]): void {
    if (strokes === this.ink) return;
    this.ink = strokes;
    this.drawn = null;
    this.paint();
  }

  /** Shows a blank white board in place of the slide (the whiteboard). */
  setBlank(blank: boolean): void {
    if (blank === this.blank) return;
    this.blank = blank;
    this.drawn = null;
    this.paint();
  }

  /** Normalised position within the slide of a pointer event, or null outside it. */
  pointAt(clientX: number, clientY: number, clamp = false): { x: number; y: number } | null {
    const drawn = this.drawn;
    const box = this.canvas.getBoundingClientRect();
    if (!drawn || box.width === 0 || box.height === 0 || drawn.width === 0) return null;
    let x = (((clientX - box.left) / box.width) * this.canvas.width - drawn.x) / drawn.width;
    let y = (((clientY - box.top) / box.height) * this.canvas.height - drawn.y) / drawn.height;
    if (clamp) {
      x = Math.min(1, Math.max(0, x));
      y = Math.min(1, Math.max(0, y));
    } else if (x < 0 || x > 1 || y < 0 || y > 1) {
      return null;
    }
    return { x, y };
  }

  destroy(): void {
    this.observer.disconnect();
    this.cache.wipe();
    release(this.canvas);
    this.host.replaceChildren();
  }

  private request(): void {
    const pages = this.page === null ? this.ahead : [this.page, ...this.ahead.filter((p) => p !== this.page)];
    this.cache.want(pages);
  }

  private measure(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const width = Math.round(this.host.clientWidth * dpr);
    const height = Math.round(this.host.clientHeight * dpr);
    if (width === 0 || height === 0 || (width === this.width && height === this.height)) return;
    this.width = width;
    this.height = height;
    this.cache.setSurface(width, height);
    this.request();
  }

  private paint(): void {
    if (this.page === null || this.width === 0) return;
    if (this.blank) {
      this.paintBoard();
      return;
    }
    const rendered = this.cache.get(this.page);
    if (!rendered) return;
    const source = rendered.canvas;
    const x = Math.floor((this.width - source.width) / 2);
    const y = Math.floor((this.height - source.height) / 2);
    const d = this.drawn;
    if (d && d.page === this.page && d.width === source.width && this.canvas.width === this.width && this.canvas.height === this.height) {
      return;
    }
    if (this.canvas.width !== this.width || this.canvas.height !== this.height) {
      this.canvas.width = this.width;
      this.canvas.height = this.height;
    }
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, this.width, this.height);
    ctx.drawImage(source, x, y);
    drawStrokes(ctx, this.ink, { x, y, width: source.width, height: source.height });
    if (this.dot) {
      const r = Math.max(4, source.height * 0.015);
      ctx.beginPath();
      ctx.arc(x + this.dot.x * source.width, y + this.dot.y * source.height, r, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(230, 25, 25, 0.9)";
      ctx.fill();
    }
    this.drawn = { page: this.page, x, y, width: source.width, height: source.height };
  }

  /** The whiteboard: a white rectangle where the slide would be, with the board's ink. */
  private paintBoard(): void {
    if (this.page === null) return;
    const size = this.deckRef.pageSize;
    const crop = this.deckRef.slideCrop;
    const fit = fitPage(size.width * crop.width, size.height * crop.height, this.width, this.height);
    if (this.canvas.width !== this.width || this.canvas.height !== this.height) {
      this.canvas.width = this.width;
      this.canvas.height = this.height;
    }
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, this.width, this.height);
    ctx.fillStyle = "#fff";
    ctx.fillRect(fit.x, fit.y, fit.width, fit.height);
    drawStrokes(ctx, this.ink, fit);
    this.drawn = { page: this.page, x: fit.x, y: fit.y, width: fit.width, height: fit.height };
  }
}
