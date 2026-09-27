// Pure geometry: face landmarks in, a frame to draw an item in out. No DOM, no MediaPipe imports.

import type { Vec } from './mls';

export interface LandmarkLike {
  x: number;
  y: number;
  /** Depth on the same scale as x, closer to the camera is smaller. Zero when unknown. */
  z?: number;
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

/**
 * Where an item sits on the head. `origin` is in pixels; `right` and `down` are the head's own
 * axes projected onto the image, so they shorten as the head turns or nods and an item drawn along
 * them foreshortens like something worn rather than a flat sticker. `width` is the reference span
 * measured in 3D, which holds steady while the head turns.
 */
export interface HeadFrame {
  origin: Vec;
  right: Vec;
  down: Vec;
  width: number;
}

// Indices are image-space left/right in the raw, un-mirrored camera frame.
export const FACE = {
  EYE_L: 33,
  EYE_R: 263,
  FOREHEAD_TOP: 10,
  CHIN: 152,
  SIDE_L: 234,
  SIDE_R: 454,
} as const;

/** The face outline, in polygon order, for clipping a shadow to the face. */
export const FACE_OVAL = [
  10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136,
  172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109,
] as const;

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const length = (a: Vec3) => Math.hypot(a.x, a.y, a.z);
function unit(a: Vec3): Vec3 {
  const d = length(a) || 1;
  return { x: a.x / d, y: a.y / d, z: a.z / d };
}

/** Landmark to pixels. Depth shares the x scale, so it is scaled by the width too. */
function toPx3(lm: LandmarkLike, w: number, h: number): Vec3 {
  return { x: lm.x * w, y: lm.y * h, z: (lm.z ?? 0) * w };
}

function headFrame(lm: readonly LandmarkLike[], w: number, h: number, origin: Vec3, width: number): HeadFrame {
  const right = unit(sub(toPx3(lm[FACE.EYE_R], w, h), toPx3(lm[FACE.EYE_L], w, h)));
  const rise = sub(toPx3(lm[FACE.FOREHEAD_TOP], w, h), toPx3(lm[FACE.CHIN], w, h));
  const lean = dot(rise, right);
  const up = unit({ x: rise.x - lean * right.x, y: rise.y - lean * right.y, z: rise.z - lean * right.z });
  return {
    origin: { x: origin.x, y: origin.y },
    right: { x: right.x, y: right.y },
    down: { x: -up.x, y: -up.y },
    width,
  };
}

/** Centred between the outer eye corners, as wide as they are apart. */
export function glassesFrame(lm: readonly LandmarkLike[], w: number, h: number): HeadFrame {
  const a = toPx3(lm[FACE.EYE_L], w, h);
  const b = toPx3(lm[FACE.EYE_R], w, h);
  return headFrame(lm, w, h, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 }, length(sub(b, a)));
}

/** On the top of the forehead, as wide as the head is at the sides. */
export function hatFrame(lm: readonly LandmarkLike[], w: number, h: number): HeadFrame {
  const width = length(sub(toPx3(lm[FACE.SIDE_R], w, h), toPx3(lm[FACE.SIDE_L], w, h)));
  return headFrame(lm, w, h, toPx3(lm[FACE.FOREHEAD_TOP], w, h), width);
}

export function faceOutline(lm: readonly LandmarkLike[], w: number, h: number): Vec[] {
  return FACE_OVAL.map((i) => ({ x: lm[i].x * w, y: lm[i].y * h }));
}

/** The frame as a flat list, so a filter can smooth every part of it at once. */
export function packFrame(frame: HeadFrame): number[] {
  return [frame.origin.x, frame.origin.y, frame.right.x, frame.right.y, frame.down.x, frame.down.y, frame.width];
}

export function unpackFrame(values: readonly number[]): HeadFrame {
  const [ox, oy, rx, ry, dx, dy, width] = values;
  return { origin: { x: ox, y: oy }, right: { x: rx, y: ry }, down: { x: dx, y: dy }, width };
}

/**
 * Rectangle to draw in the frame's own coordinates, where x runs along `right` and y along `down`.
 * Offsets are in units of frame width so they follow the subject's distance from the camera.
 */
export function itemRect(frame: { width: number }, p: Placement, img: { width: number; height: number }): Rect {
  const w = frame.width * p.scale;
  const h = w * (img.height / img.width);
  return {
    x: -w / 2 + p.offsetX * frame.width,
    y: -h * p.pivotY + p.offsetY * frame.width,
    w,
    h,
  };
}
