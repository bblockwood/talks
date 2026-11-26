// Draws ink strokes as vectors (Native §8): the same strokes look the same on the projector,
// the presenter view and the phone, because positions and widths are relative to the slide.
import { INK_COLORS } from "../core/ink";
import type { Stroke } from "../core/ink";

export interface SlideRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export function drawStrokes(ctx: CanvasRenderingContext2D, strokes: readonly Stroke[], rect: SlideRect): void {
  if (rect.width <= 0 || rect.height <= 0) return;
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const stroke of strokes) {
    const p = stroke.points;
    if (p.length < 2) continue;
    const color = INK_COLORS[stroke.color] ?? INK_COLORS[0] ?? "#e61919";
    const width = Math.max(1, stroke.width * rect.height);
    const px = (i: number): number => rect.x + (p[i] ?? 0) * rect.width;
    const py = (i: number): number => rect.y + (p[i + 1] ?? 0) * rect.height;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = width;
    if (p.length === 2) {
      // A tap: a dot.
      ctx.beginPath();
      ctx.arc(px(0), py(0), width / 2, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    // Smooth through the midpoints of successive samples.
    ctx.beginPath();
    ctx.moveTo(px(0), py(0));
    for (let i = 2; i < p.length - 2; i += 2) {
      ctx.quadraticCurveTo(px(i), py(i), (px(i) + px(i + 2)) / 2, (py(i) + py(i + 2)) / 2);
    }
    ctx.lineTo(px(p.length - 2), py(p.length - 2));
    ctx.stroke();
  }
  ctx.restore();
}
