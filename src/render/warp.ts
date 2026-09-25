// Draws an image as a deformed triangle mesh, so a flat garment photo can follow a moving body.

import type { Vec } from '../mls';

/** Outward nudge per vertex, in pixels, to hide the hairline seams between clipped triangles. */
const SEAM_BLEED = 0.7;
/** Texture pixels of overlap kept around each patch so filtering has neighbours to sample. */
const PATCH_BLEED = 1;

function expand(a: Vec, b: Vec, c: Vec): [Vec, Vec, Vec] {
  const cx = (a.x + b.x + c.x) / 3;
  const cy = (a.y + b.y + c.y) / 3;
  const push = (p: Vec): Vec => {
    const dx = p.x - cx;
    const dy = p.y - cy;
    const d = Math.hypot(dx, dy) || 1;
    return { x: p.x + (dx / d) * SEAM_BLEED, y: p.y + (dy / d) * SEAM_BLEED };
  };
  return [push(a), push(b), push(c)];
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function drawTriangle(
  ctx: CanvasRenderingContext2D,
  image: CanvasImageSource,
  src: [Vec, Vec, Vec],
  dst: [Vec, Vec, Vec],
  patch: Rect,
): void {
  const [s0, s1, s2] = src;
  const den = s0.x * (s2.y - s1.y) + s1.x * (s0.y - s2.y) + s2.x * (s1.y - s0.y);
  if (den === 0) return;
  const [d0, d1, d2] = expand(dst[0], dst[1], dst[2]);

  const a = (d0.x * (s2.y - s1.y) + d1.x * (s0.y - s2.y) + d2.x * (s1.y - s0.y)) / den;
  const b = (d0.y * (s2.y - s1.y) + d1.y * (s0.y - s2.y) + d2.y * (s1.y - s0.y)) / den;
  const c = (d0.x * (s1.x - s2.x) + d1.x * (s2.x - s0.x) + d2.x * (s0.x - s1.x)) / den;
  const d = (d0.y * (s1.x - s2.x) + d1.y * (s2.x - s0.x) + d2.y * (s0.x - s1.x)) / den;
  const e = (d0.x * (s2.x * s1.y - s1.x * s2.y) + d1.x * (s0.x * s2.y - s2.x * s0.y) + d2.x * (s1.x * s0.y - s0.x * s1.y)) / den;
  const f = (d0.y * (s2.x * s1.y - s1.x * s2.y) + d1.y * (s0.x * s2.y - s2.x * s0.y) + d2.y * (s1.x * s0.y - s0.x * s1.y)) / den;

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(d0.x, d0.y);
  ctx.lineTo(d1.x, d1.y);
  ctx.lineTo(d2.x, d2.y);
  ctx.closePath();
  ctx.clip();
  ctx.transform(a, b, c, d, e, f);
  // Only the patch this triangle covers is rasterized; drawing the whole photo per triangle is far slower.
  ctx.drawImage(image, patch.x, patch.y, patch.w, patch.h, patch.x, patch.y, patch.w, patch.h);
  ctx.restore();
}

/**
 * Splits the image into a grid, moves every vertex through `deform`, and redraws it triangle by
 * triangle. `deform` takes texture pixels and returns canvas pixels. Texture pixels keep both axes
 * on the same scale, so a similarity deformation stays a similarity on screen.
 */
export function drawWarpedImage(
  ctx: CanvasRenderingContext2D,
  image: CanvasImageSource & { width: number; height: number },
  deform: (p: Vec) => Vec,
  columns: number,
  rows: number,
): void {
  const texture = (c: number, r: number): Vec => ({
    x: (c / columns) * image.width,
    y: (r / rows) * image.height,
  });

  const grid: Vec[][] = [];
  for (let r = 0; r <= rows; r++) {
    const line: Vec[] = [];
    for (let c = 0; c <= columns; c++) {
      line.push(deform(texture(c, r)));
    }
    grid.push(line);
  }

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) {
      const s00 = texture(c, r);
      const s10 = texture(c + 1, r);
      const s11 = texture(c + 1, r + 1);
      const s01 = texture(c, r + 1);
      const patch = {
        x: s00.x - PATCH_BLEED,
        y: s00.y - PATCH_BLEED,
        w: s11.x - s00.x + PATCH_BLEED * 2,
        h: s11.y - s00.y + PATCH_BLEED * 2,
      };
      drawTriangle(ctx, image, [s00, s10, s11], [grid[r][c], grid[r][c + 1], grid[r + 1][c + 1]], patch);
      drawTriangle(ctx, image, [s00, s11, s01], [grid[r][c], grid[r + 1][c + 1], grid[r + 1][c]], patch);
    }
  }
}
