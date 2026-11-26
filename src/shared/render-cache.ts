// Render-ahead cache (SPEC §6.4). Pages are rendered off screen at the exact pixel size of the
// surface they will be shown on. A page is only ever handed out complete, so the audience never
// sees a partial render: on a miss the view keeps its old image until `onReady` fires.
import { AnnotationMode } from "pdfjs-dist";
import type { RenderTask } from "pdfjs-dist";
import { evictions, fitPage } from "../core/prefetch";
import type { Deck } from "./deck";

/** A finished page: `canvas` is exactly the size the page occupies on the surface, in device pixels. */
export interface RenderedPage {
  readonly page: number;
  readonly canvas: HTMLCanvasElement;
}

export class RenderCache {
  /** Called when a wanted page finishes rendering. */
  onReady: ((page: number) => void) | null = null;
  /** Cache misses on the page the view asked for, for the debug overlay (W4). */
  misses = 0;

  private readonly entries = new Map<number, RenderedPage>(); // insertion order = oldest first
  private wanted: number[] = [];
  private surfaceWidth = 0;
  private surfaceHeight = 0;
  private generation = 0;
  private inFlight: { page: number; task: RenderTask | null } | null = null;
  private wiped = false;

  constructor(
    private deck: Deck | null,
    private readonly capacity = 12,
  ) {}

  /** Surface size in device pixels. Changing it discards every cached page. */
  setSurface(width: number, height: number): void {
    const w = Math.max(0, Math.round(width));
    const h = Math.max(0, Math.round(height));
    if (w === this.surfaceWidth && h === this.surfaceHeight) return;
    this.surfaceWidth = w;
    this.surfaceHeight = h;
    this.generation += 1;
    this.discardAll();
    this.inFlight?.task?.cancel();
    this.pump();
  }

  get(page: number): RenderedPage | undefined {
    return this.entries.get(page);
  }

  /** Pages to have ready, most urgent first. Replaces the previous list. */
  want(pages: readonly number[]): void {
    this.wanted = [...pages];
    const first = this.wanted[0];
    if (first !== undefined && !this.entries.has(first)) this.misses += 1;
    if (this.inFlight && !this.wanted.includes(this.inFlight.page)) this.inFlight.task?.cancel();
    this.pump();
  }

  /** Clears every pixel this cache holds and stops rendering (End, SPEC §5.3). */
  wipe(): void {
    this.wiped = true;
    this.wanted = [];
    this.onReady = null;
    this.inFlight?.task?.cancel();
    this.discardAll();
    this.deck = null;
  }

  private discardAll(): void {
    for (const entry of this.entries.values()) release(entry.canvas);
    this.entries.clear();
  }

  private pump(): void {
    if (this.wiped || this.inFlight || !this.deck) return;
    if (this.surfaceWidth === 0 || this.surfaceHeight === 0) return;
    const page = this.wanted.find((p) => !this.entries.has(p));
    if (page === undefined) return;

    const flight: { page: number; task: RenderTask | null } = { page, task: null };
    this.inFlight = flight;
    const generation = this.generation;
    void this.render(page, flight)
      .then((canvas) => {
        if (!canvas) return;
        if (this.wiped || generation !== this.generation) {
          release(canvas);
          return;
        }
        this.entries.delete(page);
        this.entries.set(page, { page, canvas });
        for (const old of evictions([...this.entries.keys()], this.wanted, this.capacity)) {
          const entry = this.entries.get(old);
          if (entry) release(entry.canvas);
          this.entries.delete(old);
        }
        this.onReady?.(page);
      })
      .catch(() => {
        // Cancelled, or the page failed to render. A failed page is dropped from the wanted list
        // so one bad page can't stall the queue; the view keeps its previous image.
        if (generation === this.generation && !this.wiped && flight.task && !isCancelled(flight)) {
          this.wanted = this.wanted.filter((p) => p !== page);
        }
      })
      .finally(() => {
        if (this.inFlight === flight) this.inFlight = null;
        this.pump();
      });
  }

  private async render(page: number, flight: { task: RenderTask | null }): Promise<HTMLCanvasElement | null> {
    const deck = this.deck;
    if (!deck) return null;
    const proxy = await deck.getPage(page);
    const unit = proxy.getViewport({ scale: 1 });
    const fit = fitPage(unit.width, unit.height, this.surfaceWidth, this.surfaceHeight);
    if (fit.width === 0 || fit.height === 0) return null;

    const canvas = document.createElement("canvas");
    canvas.width = fit.width;
    canvas.height = fit.height;
    // PDF.js fills white behind the page by default. Note annotations must never be drawn, and
    // links get our own hit-testing, so annotation rendering is off (SPEC §6.2).
    const task = proxy.render({
      canvas,
      viewport: proxy.getViewport({ scale: fit.scale }),
      annotationMode: AnnotationMode.DISABLE,
      background: "#ffffff",
    });
    flight.task = task;
    try {
      await task.promise;
    } catch (e) {
      release(canvas);
      if (e instanceof Error && e.name === "RenderingCancelledException") cancelled.add(flight);
      throw e;
    }
    return canvas;
  }
}

const cancelled = new WeakSet<object>();
const isCancelled = (flight: object): boolean => cancelled.has(flight);

/** Frees a canvas's backing store immediately rather than waiting for garbage collection. */
export function release(canvas: HTMLCanvasElement): void {
  canvas.width = 0;
  canvas.height = 0;
}
