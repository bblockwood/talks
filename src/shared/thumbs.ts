// A grid of frame thumbnails (the phone's Slides sheet, the presenter view's overview). Each
// shows its frame fully built (Native §4.1). Rendering is lazy and one at a time.
import { AnnotationMode } from "pdfjs-dist";
import type { Frame } from "../core/frames";
import type { Deck } from "./deck";

export interface ThumbOptions {
  onPick(frame: Frame): void;
  /** Frames that have notes get a small mark (presenter overview). */
  hasNotes?(frame: Frame): boolean;
}

export class ThumbGrid {
  private readonly observer: IntersectionObserver;
  private queue: Promise<void> = Promise.resolve();
  private destroyed = false;

  constructor(
    private readonly host: HTMLElement,
    private readonly deck: Deck,
    options: ThumbOptions,
  ) {
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          this.observer.unobserve(entry.target);
          const canvas = entry.target.querySelector("canvas");
          const page = Number((entry.target as HTMLElement).dataset["page"]);
          if (canvas) this.queue = this.queue.then(() => this.render(canvas, page));
        }
      },
      { root: host, rootMargin: "300px" },
    );
    for (const frame of deck.frames.frames) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "thumb";
      button.dataset["frame"] = String(frame.index);
      button.dataset["page"] = String(frame.lastPage);
      const canvas = document.createElement("canvas");
      const cap = document.createElement("div");
      cap.className = "cap";
      const label = document.createElement("span");
      label.textContent = frame.label;
      const extra = document.createElement("span");
      const builds = frame.lastPage - frame.firstPage + 1;
      extra.textContent = [builds > 1 ? `${builds} builds` : "", options.hasNotes?.(frame) ? "notes" : ""].filter(Boolean).join(" · ");
      cap.append(label, extra);
      button.append(canvas, cap);
      button.addEventListener("click", () => options.onPick(frame));
      host.append(button);
      this.observer.observe(button);
    }
  }

  /** Rings the frame the presenter is on and, if different, the one the audience sees (frozen). */
  mark(currentFrame: number | null, audienceFrame: number | null = null, scroll = false): void {
    for (const el of this.host.children) {
      const index = Number((el as HTMLElement).dataset["frame"]);
      const isCurrent = index === currentFrame;
      el.classList.toggle("current", isCurrent);
      el.classList.toggle("audience", audienceFrame !== null && index === audienceFrame && !isCurrent);
      if (isCurrent && scroll) el.scrollIntoView({ block: "center" });
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.observer.disconnect();
    for (const canvas of this.host.querySelectorAll("canvas")) {
      canvas.width = 0;
      canvas.height = 0;
    }
    this.host.replaceChildren();
  }

  private async render(canvas: HTMLCanvasElement, page: number): Promise<void> {
    if (this.destroyed) return;
    try {
      const proxy = await this.deck.getPage(page);
      const unit = proxy.getViewport({ scale: 1 });
      const crop = this.deck.slideCrop;
      const width = Math.max(1, Math.round(canvas.clientWidth * Math.min(window.devicePixelRatio || 1, 2)));
      const scale = width / (unit.width * crop.width);
      canvas.width = width;
      canvas.height = Math.round(unit.height * crop.height * scale);
      await proxy.render({
        canvas,
        viewport: proxy.getViewport({ scale, offsetX: -crop.x * unit.width * scale, offsetY: -crop.y * unit.height * scale }),
        annotationMode: AnnotationMode.DISABLE,
      }).promise;
    } catch {
      // A thumbnail that fails to render stays black.
    }
  }
}
