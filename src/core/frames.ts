// Frames and builds (Native §4.1). A frame is a maximal run of consecutive pages with identical
// page labels; the build index is a page's position within its frame. Pages are 0-based.

export interface Frame {
  /** 0-based position of the frame in the deck. */
  readonly index: number;
  /** The label shared by the frame's pages. For unlabelled pages, the 1-based page number. */
  readonly label: string;
  readonly firstPage: number;
  readonly lastPage: number;
}

export const buildCount = (frame: Frame): number => frame.lastPage - frame.firstPage + 1;

export class FrameIndex {
  readonly frames: readonly Frame[];
  private readonly frameOfPage: readonly number[];

  /** `labels[i]` is page i's label, or null when the PDF defines none for it. */
  constructor(labels: readonly (string | null)[]) {
    const frames: Frame[] = [];
    const frameOfPage: number[] = [];
    let start = 0;
    while (start < labels.length) {
      const label = labels[start] ?? null;
      let end = start + 1;
      // A null label never joins a run, so an unlabelled PDF yields one frame per page.
      if (label !== null) while (end < labels.length && labels[end] === label) end += 1;
      const frame: Frame = {
        index: frames.length,
        label: label ?? String(start + 1),
        firstPage: start,
        lastPage: end - 1,
      };
      frames.push(frame);
      for (let p = start; p < end; p++) frameOfPage.push(frame.index);
      start = end;
    }
    this.frames = frames;
    this.frameOfPage = frameOfPage;
  }

  /** For a PDF with no page labels at all. */
  static unlabelled(pageCount: number): FrameIndex {
    return new FrameIndex(new Array<string | null>(pageCount).fill(null));
  }

  get pageCount(): number {
    return this.frameOfPage.length;
  }

  get frameCount(): number {
    return this.frames.length;
  }

  clamp(page: number): number {
    return Math.min(Math.max(Math.trunc(page), 0), Math.max(this.pageCount - 1, 0));
  }

  /** The frame containing `page`, or undefined for an empty deck. */
  frameContaining(page: number): Frame | undefined {
    const f = this.frameOfPage[this.clamp(page)];
    return f === undefined ? undefined : this.frames[f];
  }

  /** 0-based position of the page within its frame. */
  buildIndex(page: number): number {
    const frame = this.frameContaining(page);
    return frame ? this.clamp(page) - frame.firstPage : 0;
  }

  frameWithLabel(label: string): Frame | undefined {
    return this.frames.find((f) => f.label === label);
  }

  /** First page of the frame after the one containing `page`, or null in the last frame. */
  nextFrameFirstPage(page: number): number | null {
    const frame = this.frameContaining(page);
    const next = frame ? this.frames[frame.index + 1] : undefined;
    return next ? next.firstPage : null;
  }

  /** Last page of the frame before the one containing `page`, so it arrives fully built (pdfpc behaviour). */
  previousFrameLastPage(page: number): number | null {
    const frame = this.frameContaining(page);
    const previous = frame && frame.index > 0 ? this.frames[frame.index - 1] : undefined;
    return previous ? previous.lastPage : null;
  }
}
