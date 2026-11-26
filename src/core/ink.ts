// Ink (Native §8, SPEC §7): strokes in normalised coordinates of the slide, with width relative
// to the slide height, so they look identical on every display. Ephemeral only on the web: the
// room PC stores nothing. This file has no imports.

/** Colours a stroke can have, by index. The index travels on the wire, not a colour string. */
export const INK_COLORS: readonly string[] = ["#e61919", "#1d4ed8", "#111111"];

export const DEFAULT_INK_WIDTH = 0.006;
const MIN_WIDTH = 0.002;
const MAX_WIDTH = 0.03;
export const MAX_STROKES = 400;
export const MAX_POINTS_PER_STROKE = 4000;

export interface Stroke {
  /** Unique per sender and stroke, so several devices can draw at once. */
  readonly id: string;
  /** Index into INK_COLORS. */
  readonly color: number;
  /** Line width as a fraction of the slide height. */
  readonly width: number;
  /** x0, y0, x1, y1, … each 0–1 within the slide. */
  readonly points: readonly number[];
}

export interface InkState {
  /** Ink on the committed page. Cleared when the page changes. */
  readonly page: readonly Stroke[];
  /** Ink on the whiteboard (the white screen). Kept for the whole talk. */
  readonly board: readonly Stroke[];
}

export const NO_INK: InkState = { page: [], board: [] };

export type InkLayer = "page" | "board";

const unit = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

export function beginStroke(ink: InkState, layer: InkLayer, id: string, x: number, y: number, color: number, width: number): InkState {
  if (ink.page.some((s) => s.id === id) || ink.board.some((s) => s.id === id)) return ink;
  const stroke: Stroke = {
    id,
    color: Number.isInteger(color) && color >= 0 && color < INK_COLORS.length ? color : 0,
    width: Number.isFinite(width) ? Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, width)) : DEFAULT_INK_WIDTH,
    points: [unit(x), unit(y)],
  };
  // Past the cap the oldest strokes go, so a very long session can't grow without bound.
  const strokes = [...ink[layer], stroke].slice(-MAX_STROKES);
  return { ...ink, [layer]: strokes };
}

export function appendToStroke(ink: InkState, id: string, points: readonly number[]): InkState {
  if (points.length < 2) return ink;
  const extend = (strokes: readonly Stroke[]): readonly Stroke[] | null => {
    const index = strokes.findIndex((s) => s.id === id);
    const stroke = strokes[index];
    if (!stroke) return null;
    const room = MAX_POINTS_PER_STROKE * 2 - stroke.points.length;
    if (room <= 0) return strokes;
    const even = Math.min(points.length - (points.length % 2), room);
    const next = [...strokes];
    next[index] = { ...stroke, points: [...stroke.points, ...points.slice(0, even).map(unit)] };
    return next;
  };
  const page = extend(ink.page);
  if (page) return page === ink.page ? ink : { ...ink, page };
  const board = extend(ink.board);
  if (board) return board === ink.board ? ink : { ...ink, board };
  return ink;
}

/** Removes the most recent stroke on a layer. */
export function undoStroke(ink: InkState, layer: InkLayer): InkState {
  return ink[layer].length === 0 ? ink : { ...ink, [layer]: ink[layer].slice(0, -1) };
}

export function clearLayer(ink: InkState, layer: InkLayer): InkState {
  return ink[layer].length === 0 ? ink : { ...ink, [layer]: [] };
}
