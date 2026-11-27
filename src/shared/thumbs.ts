// The overview's grid of thumbnails (Native §6.3). Two ways to show a deck with builds:
// - Frames: one thumbnail per frame, fully built (Native §4.1). The frame the talk is in instead
//   shows the build on screen, and lists its builds, the current one lit; each number jumps.
// - Builds: every page as its own thumbnail.
// Rendering is lazy and one at a time.
import { AnnotationMode } from "pdfjs-dist";
import { buildCount } from "../core/frames";
import type { Frame } from "../core/frames";
import type { Deck } from "./deck";

export type ThumbMode = "frames" | "builds";

export interface ThumbOptions {
  /** A thumbnail or a build number was picked: go to this page. */
  onPick(page: number): void;
  /** Frames that have notes get a small mark. */
  hasNotes?(frame: Frame): boolean;
}

/** Past this many, the current frame's builds are shown as "3/12" rather than one number each. */
const MAX_LISTED_BUILDS = 8;

export class ThumbGrid {
  private readonly observer: IntersectionObserver;
  private queue: Promise<void> = Promise.resolve();
  private destroyed = false;
  private mode: ThumbMode = "frames";
  private currentPage: number | null = null;

  constructor(
    private readonly host: HTMLElement,
    private readonly deck: Deck,
    private readonly options: ThumbOptions,
  ) {
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          this.observer.unobserve(entry.target);
          const cell = entry.target as HTMLElement;
          cell.dataset["seen"] = "1";
          this.draw(cell);
        }
      },
      { root: host, rootMargin: "300px" },
    );
    this.build();
  }

  get shows(): ThumbMode {
    return this.mode;
  }

  setMode(mode: ThumbMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.build();
  }

  private build(): void {
    this.observer.disconnect();
    this.dropCanvases();
    this.host.replaceChildren();
    const frames = this.deck.frames;
    const cells: { frame: Frame; page: number }[] =
      this.mode === "frames"
        ? frames.frames.map((frame) => ({ frame, page: frame.lastPage }))
        : Array.from({ length: frames.pageCount }, (_, page) => ({ frame: frames.frameContaining(page) as Frame, page }));
    for (const { frame, page } of cells) {
      // Not a <button>: the build numbers inside are buttons themselves.
      const cell = document.createElement("div");
      cell.className = "thumb";
      cell.setAttribute("role", "button");
      cell.dataset["frame"] = String(frame.index);
      cell.dataset["page"] = String(page); // the page the thumbnail shows
      cell.dataset["key"] = String(this.mode === "frames" ? frame.index : page);
      const canvas = document.createElement("canvas");
      const cap = document.createElement("div");
      cap.className = "cap";
      cell.append(canvas, cap);
      // A frame opens at its first build; a build is that page.
      cell.addEventListener("click", () => this.options.onPick(this.mode === "frames" ? frame.firstPage : page));
      this.caption(cell, frame, null);
      this.host.append(cell);
      this.observer.observe(cell);
    }
    const page = this.currentPage;
    this.currentPage = null;
    if (page !== null) this.mark(page, null, true);
  }

  /** The line under a thumbnail: frame number, builds, a mark for notes. `build` is set for the current frame. */
  private caption(cell: HTMLElement, frame: Frame, build: number | null): void {
    const cap = cell.querySelector(".cap");
    if (!cap) return;
    const label = document.createElement("span");
    label.className = "label";
    label.textContent = frame.label;
    const parts: HTMLElement[] = [label];
    const count = buildCount(frame);
    if (count > 1) {
      if (this.mode === "builds") {
        parts.push(this.text("builds", `${Number(cell.dataset["page"]) - frame.firstPage + 1}/${count}`));
      } else if (build === null) {
        parts.push(this.text("builds", `${count} builds`));
      } else if (count > MAX_LISTED_BUILDS) {
        parts.push(this.text("builds", `build ${build + 1}/${count}`));
      } else {
        const list = document.createElement("span");
        list.className = "buildlist";
        for (let b = 0; b < count; b++) {
          const pick = document.createElement("button");
          pick.type = "button";
          pick.textContent = String(b + 1);
          pick.classList.toggle("lit", b === build);
          pick.setAttribute("aria-label", `Build ${b + 1}${b === build ? ", on screen" : ""}`);
          pick.addEventListener("click", (ev) => {
            ev.stopPropagation();
            this.options.onPick(frame.firstPage + b);
          });
          list.append(pick);
        }
        parts.push(list);
      }
    }
    const spacer = document.createElement("span");
    spacer.className = "spacer";
    parts.push(spacer);
    if (this.options.hasNotes?.(frame)) parts.push(this.text("has-notes", "notes"));
    cap.replaceChildren(...parts);
  }

  private text(className: string, text: string): HTMLElement {
    const el = document.createElement("span");
    el.className = className;
    el.textContent = text;
    return el;
  }

  /**
   * Rings the thumbnail the talk is on and, if different, the one the audience sees (frozen).
   * In Frames mode the current frame's thumbnail follows the build on screen.
   */
  mark(currentPage: number, audiencePage: number | null = null, scroll = false): void {
    const frames = this.deck.frames;
    const key = (page: number): number => (this.mode === "frames" ? (frames.frameContaining(page)?.index ?? -1) : page);
    const current = key(currentPage);
    const audience = audiencePage === null ? null : key(audiencePage);
    const moved = this.currentPage === null || key(this.currentPage) !== current;
    const pageChanged = this.currentPage !== currentPage;
    this.currentPage = currentPage;
    for (const el of this.host.children) {
      const cell = el as HTMLElement;
      const mine = Number(cell.dataset["key"]);
      const isCurrent = mine === current;
      const was = cell.classList.contains("current");
      cell.classList.toggle("current", isCurrent);
      cell.classList.toggle("audience", audience !== null && mine === audience && !isCurrent);
      if (this.mode === "frames" && (isCurrent || was) && (pageChanged || isCurrent !== was)) {
        const frame = frames.frames[mine];
        if (frame) {
          const show = isCurrent ? currentPage : frame.lastPage;
          this.caption(cell, frame, isCurrent ? currentPage - frame.firstPage : null);
          if (cell.dataset["page"] !== String(show)) {
            cell.dataset["page"] = String(show);
            if (cell.dataset["seen"]) this.draw(cell);
          }
        }
      }
      if (isCurrent && (scroll || moved)) cell.scrollIntoView({ block: scroll ? "center" : "nearest" });
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.observer.disconnect();
    this.dropCanvases();
    this.host.replaceChildren();
  }

  private dropCanvases(): void {
    for (const canvas of this.host.querySelectorAll("canvas")) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }

  private draw(cell: HTMLElement): void {
    this.queue = this.queue.then(() => this.render(cell));
  }

  private async render(cell: HTMLElement): Promise<void> {
    const canvas = cell.querySelector("canvas");
    const page = Number(cell.dataset["page"]);
    // Gone (the mode changed), or already showing what is wanted.
    if (this.destroyed || !canvas || !cell.isConnected || cell.dataset["drawn"] === String(page)) return;
    try {
      const proxy = await this.deck.getPage(page);
      const unit = proxy.getViewport({ scale: 1 });
      const crop = this.deck.slideCrop;
      const width = Math.max(1, Math.round(canvas.clientWidth * Math.min(window.devicePixelRatio || 1, 2)));
      const scale = width / (unit.width * crop.width);
      // Drawn off screen and copied over, so a thumbnail that changes build never flashes blank.
      const scratch = document.createElement("canvas");
      scratch.width = width;
      scratch.height = Math.round(unit.height * crop.height * scale);
      await proxy.render({
        canvas: scratch,
        viewport: proxy.getViewport({ scale, offsetX: -crop.x * unit.width * scale, offsetY: -crop.y * unit.height * scale }),
        annotationMode: AnnotationMode.DISABLE,
      }).promise;
      if (!this.destroyed && cell.isConnected) {
        canvas.width = scratch.width;
        canvas.height = scratch.height;
        canvas.getContext("2d")?.drawImage(scratch, 0, 0);
        cell.dataset["drawn"] = String(page);
      }
      scratch.width = 0;
      scratch.height = 0;
    } catch {
      // A thumbnail that fails to render stays black.
    }
  }
}
