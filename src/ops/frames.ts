// Smart Frame: finds the photo slots in an uploaded frame PNG, the transparent windows the shots
// show through.

import type { Rect } from './model';

export interface SlotOptions {
  /** Pixels below this alpha count as see-through. */
  alphaBelow?: number;
  /** Ignore windows smaller than this share of the frame (specks, rounded corners). */
  minShare?: number;
  /** Sample every n-th pixel, which keeps a 4K frame fast. */
  step?: number;
}

/**
 * Connected transparent regions, as bounding boxes in frame pixels, in reading order: rows of
 * slots top to bottom, left to right within a row.
 */
export function detectSlots(rgba: Uint8ClampedArray, width: number, height: number, options: SlotOptions = {}): Rect[] {
  const { alphaBelow = 32, minShare = 0.01, step = Math.max(1, Math.round(Math.max(width, height) / 400)) } = options;
  const cols = Math.ceil(width / step);
  const rows = Math.ceil(height / step);
  const clear = new Uint8Array(cols * rows);
  for (let gy = 0; gy < rows; gy++) {
    for (let gx = 0; gx < cols; gx++) {
      const x = Math.min(width - 1, gx * step);
      const y = Math.min(height - 1, gy * step);
      clear[gy * cols + gx] = rgba[(y * width + x) * 4 + 3] < alphaBelow ? 1 : 0;
    }
  }

  const seen = new Uint8Array(cols * rows);
  const boxes: Rect[] = [];
  const stack: number[] = [];
  for (let start = 0; start < clear.length; start++) {
    if (!clear[start] || seen[start]) continue;
    let minX = cols, minY = rows, maxX = 0, maxY = 0, count = 0;
    stack.push(start);
    seen[start] = 1;
    while (stack.length) {
      const cell = stack.pop()!;
      const cx = cell % cols;
      const cy = (cell - cx) / cols;
      count += 1;
      minX = Math.min(minX, cx);
      maxX = Math.max(maxX, cx);
      minY = Math.min(minY, cy);
      maxY = Math.max(maxY, cy);
      for (const [nx, ny] of [[cx - 1, cy], [cx + 1, cy], [cx, cy - 1], [cx, cy + 1]]) {
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
        const n = ny * cols + nx;
        if (clear[n] && !seen[n]) {
          seen[n] = 1;
          stack.push(n);
        }
      }
    }
    if (count / clear.length < minShare) continue;
    boxes.push({
      x: minX * step,
      y: minY * step,
      width: Math.min(width, (maxX + 1) * step) - minX * step,
      height: Math.min(height, (maxY + 1) * step) - minY * step,
    });
  }

  // Slots whose tops sit within a quarter of a slot height share a row.
  return boxes.sort((a, b) => {
    const sameRow = Math.abs(a.y - b.y) < Math.min(a.height, b.height) / 4;
    return sameRow ? a.x - b.x : a.y - b.y;
  });
}

/** Fills each slot with a shot, cropped to cover it, then lays the frame over the top. */
export function composeFrame(frame: CanvasImageSource, width: number, height: number, slots: readonly Rect[], shots: readonly CanvasImageSource[]): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  slots.forEach((slot, index) => {
    const shot = shots[index % Math.max(1, shots.length)] as HTMLCanvasElement;
    if (!shot) return;
    const sw = shot.width;
    const sh = shot.height;
    const scale = Math.max(slot.width / sw, slot.height / sh);
    const cw = slot.width / scale;
    const ch = slot.height / scale;
    ctx.drawImage(shot, (sw - cw) / 2, (sh - ch) / 2, cw, ch, slot.x, slot.y, slot.width, slot.height);
  });
  ctx.drawImage(frame, 0, 0, width, height);
  return canvas;
}
