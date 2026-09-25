// Pure geometry: landmarks in, draw rectangles out. No DOM, no MediaPipe imports.

import type { Vec } from './mls';

/** Placement of an item in pixel space. `angle` is in radians, `width` is the reference span. */
export interface Anchor {
  cx: number;
  cy: number;
  angle: number;
  width: number;
}

export interface LandmarkLike {
  x: number;
  y: number;
  visibility?: number;
}

export interface Placement {
  scale: number;
  offsetX: number;
  offsetY: number;
  pivotY: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Indices are image-space left/right in the raw, un-mirrored camera frame.
export const FACE = {
  EYE_L: 33,
  EYE_R: 263,
  FOREHEAD_TOP: 10,
  SIDE_L: 234,
  SIDE_R: 454,
} as const;

function toPx(lm: LandmarkLike, w: number, h: number): Vec {
  return { x: lm.x * w, y: lm.y * h };
}

/** Anchor centered between two points, rotated along the line from a to b. */
export function lineAnchor(a: Vec, b: Vec): Anchor {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return {
    cx: (a.x + b.x) / 2,
    cy: (a.y + b.y) / 2,
    angle: Math.atan2(dy, dx),
    width: Math.hypot(dx, dy),
  };
}

export function glassesAnchor(lm: readonly LandmarkLike[], w: number, h: number): Anchor {
  return lineAnchor(toPx(lm[FACE.EYE_L], w, h), toPx(lm[FACE.EYE_R], w, h));
}

export function hatAnchor(lm: readonly LandmarkLike[], w: number, h: number): Anchor {
  const eyes = lineAnchor(toPx(lm[FACE.EYE_L], w, h), toPx(lm[FACE.EYE_R], w, h));
  const sideL = toPx(lm[FACE.SIDE_L], w, h);
  const sideR = toPx(lm[FACE.SIDE_R], w, h);
  const top = toPx(lm[FACE.FOREHEAD_TOP], w, h);
  return {
    cx: top.x,
    cy: top.y,
    angle: eyes.angle,
    width: Math.hypot(sideR.x - sideL.x, sideR.y - sideL.y),
  };
}

/** Exponential moving average. Angle blends along the shortest arc. */
export function smoothAnchor(prev: Anchor | null, next: Anchor, alpha: number): Anchor {
  if (!prev) return next;
  const d = next.angle - prev.angle;
  const shortest = Math.atan2(Math.sin(d), Math.cos(d));
  return {
    cx: prev.cx + alpha * (next.cx - prev.cx),
    cy: prev.cy + alpha * (next.cy - prev.cy),
    width: prev.width + alpha * (next.width - prev.width),
    angle: prev.angle + alpha * shortest,
  };
}

/**
 * Rectangle to draw in a frame already translated to (cx, cy) and rotated by `angle`.
 * Offsets are in units of anchor width so they follow the subject's distance from the camera.
 */
export function itemRect(a: Anchor, p: Placement, img: { width: number; height: number }): Rect {
  const w = a.width * p.scale;
  const h = w * (img.height / img.width);
  return {
    x: -w / 2 + p.offsetX * a.width,
    y: -h * p.pivotY + p.offsetY * a.width,
    w,
    h,
  };
}
