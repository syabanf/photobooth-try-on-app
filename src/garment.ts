// Turns a garment photo's outline and a pose skeleton into control pairs for the mesh warp.

import type { LandmarkLike } from './anchors';
import type { RowEdges } from './image-bounds';
import type { ControlPair, Vec } from './mls';

export interface GarmentShape {
  /** Height fraction of the shoulder seam. */
  shoulderY: number;
  /** Half the shoulder width, as a fraction of the garment width. */
  shoulderHalf: number;
  /** Horizontal center of the shoulder line, as a fraction of the garment width. */
  center: number;
  /** Height fraction used as the hip line, and the garment's half width there. */
  hipY: number;
  hipHalf: number;
  /** Cuff positions in normalized garment space, absent when the sleeves are not spread out. */
  sleeves: { left: Vec; right: Vec } | null;
}

/** Stand-in outline for a photo whose pixels cannot be read, such as a cross-origin image. */
export const NOMINAL_SHAPE: GarmentShape = {
  shoulderY: 0.12,
  shoulderHalf: 0.4,
  center: 0.5,
  hipY: 0.9,
  hipHalf: 0.42,
  sleeves: null,
};

/** Shoulder widths between the shoulder seam and the hip joints on an average build. */
const TORSO_RATIO = 1.5;
/** A cuff must reach this far past the shoulder edge to count as a spread sleeve. */
const SLEEVE_REACH = 1.1;
/** A spread sleeve also stands out this much wider than the body below it. */
const SLEEVE_FLARE = 1.25;
/** Below this height fraction a wide point belongs to a hem or a hanging sleeve. */
const SLEEVE_MAX_Y = 0.6;
/**
 * Where the top of the collar lands above the shoulder line, in garment shoulder widths.
 * A photo lays the collar and the shoulder slope out flat, which makes that band taller than it
 * looks once worn, so pinning it to the neck keeps the garment off the chin.
 */
const NECK_RISE = 0.12;

function smoothWidths(rows: readonly (RowEdges | null)[], window: number): number[] {
  const raw = rows.map((r) => (r ? r.right - r.left : 0));
  return raw.map((_, i) => {
    let sum = 0;
    let count = 0;
    for (let j = Math.max(0, i - window); j <= Math.min(raw.length - 1, i + window); j++) {
      sum += raw[j];
      count += 1;
    }
    return sum / count;
  });
}

/**
 * Locates the shoulder seam, hip line and cuffs of a garment laid out facing the camera.
 * The shoulder seam is where the outline stops flaring out below the collar.
 */
export function measureGarment(rows: readonly (RowEdges | null)[], aspect: number): GarmentShape | null {
  const height = rows.length;
  if (height < 8) return null;

  const widths = smoothWidths(rows, Math.max(1, Math.round(height * 0.05)));
  const searchTo = Math.round(height * 0.45);

  let steepest = 0;
  let steepestRow = 0;
  for (let i = 1; i < searchTo; i++) {
    const slope = widths[i] - widths[i - 1];
    if (slope > steepest) {
      steepest = slope;
      steepestRow = i;
    }
  }

  let shoulderRow = steepestRow;
  for (let i = steepestRow; i < searchTo; i++) {
    if (widths[i] - widths[i - 1] < steepest * 0.25) {
      shoulderRow = i;
      break;
    }
  }

  const shoulderEdges = rows[shoulderRow];
  if (!shoulderEdges) return null;
  const shoulderHalf = widths[shoulderRow] / 2;
  if (shoulderHalf <= 0) return null;
  const center = (shoulderEdges.left + shoulderEdges.right) / 2;
  const shoulderY = shoulderRow / height;

  // The hip line sits a fixed number of shoulder widths below the seam on an average build.
  // It may fall past the hem of a short garment, which is fine: it only anchors the torso axis.
  const hipY = shoulderY + (TORSO_RATIO * shoulderHalf * 2) / aspect;
  const hipRow = Math.min(height - 1, Math.round(hipY * height));
  const hipHalf = widths[hipRow] / 2 || shoulderHalf;

  const body = widths.slice(Math.round(height * 0.45), Math.round(height * 0.9)).filter((w) => w > 0).sort((a, b) => a - b);
  const bodyHalf = body.length ? body[Math.floor(body.length / 2)] / 2 : shoulderHalf;

  return { shoulderY, shoulderHalf, center, hipY, hipHalf, sleeves: findSleeves(rows, center, shoulderHalf, bodyHalf) };
}

function findSleeves(
  rows: readonly (RowEdges | null)[],
  center: number,
  shoulderHalf: number,
  bodyHalf: number,
): { left: Vec; right: Vec } | null {
  const height = rows.length;
  const limit = Math.round(height * SLEEVE_MAX_Y);
  let left: Vec | null = null;
  let right: Vec | null = null;
  for (let i = 0; i < limit; i++) {
    const edges = rows[i];
    if (!edges) continue;
    if (!left || edges.left < left.x) left = { x: edges.left, y: i / height };
    if (!right || edges.right > right.x) right = { x: edges.right, y: i / height };
  }
  if (!left || !right) return null;
  // A sleeve reaches past the shoulder seam and flares wider than the body hanging below it.
  const spread = (x: number) => {
    const reach = Math.abs(x - center);
    return reach >= shoulderHalf * SLEEVE_REACH && reach >= bodyHalf * SLEEVE_FLARE;
  };
  return spread(left.x) && spread(right.x) ? { left, right } : null;
}

export interface Body {
  /** Shoulder joints, named by the side of the raw camera frame they appear on. */
  shoulderLeft: Vec;
  shoulderRight: Vec;
  hipLeft: Vec;
  hipRight: Vec;
  /** Shoulder to elbow to wrist, or null when the arm is not reliably visible. */
  armLeft: Vec[] | null;
  armRight: Vec[] | null;
}

export const POSE = {
  SHOULDER_RIGHT: 11,
  SHOULDER_LEFT: 12,
  ELBOW_RIGHT: 13,
  ELBOW_LEFT: 14,
  WRIST_RIGHT: 15,
  WRIST_LEFT: 16,
  HIP_RIGHT: 23,
  HIP_LEFT: 24,
} as const;

const MIN_VISIBILITY = 0.5;
const ARM_VISIBILITY = 0.7;

/** Reads the torso and arms in pixel space, falling back to a proportional torso when hips are hidden. */
export function readBody(lm: readonly LandmarkLike[], width: number, height: number): Body | null {
  const px = (i: number): Vec => ({ x: lm[i].x * width, y: lm[i].y * height });
  const seen = (i: number, min = MIN_VISIBILITY) => (lm[i]?.visibility ?? 1) >= min;
  if (!seen(POSE.SHOULDER_LEFT) || !seen(POSE.SHOULDER_RIGHT)) return null;

  const shoulderLeft = px(POSE.SHOULDER_LEFT);
  const shoulderRight = px(POSE.SHOULDER_RIGHT);
  const hips = seen(POSE.HIP_LEFT, ARM_VISIBILITY) && seen(POSE.HIP_RIGHT, ARM_VISIBILITY)
    ? { hipLeft: px(POSE.HIP_LEFT), hipRight: px(POSE.HIP_RIGHT) }
    : proportionalHips(shoulderLeft, shoulderRight);

  const arm = (shoulder: Vec, elbow: number, wrist: number): Vec[] | null => {
    if (!seen(elbow, ARM_VISIBILITY)) return null;
    const points = [shoulder, px(elbow)];
    if (seen(wrist, ARM_VISIBILITY)) points.push(px(wrist));
    return points;
  };

  return {
    shoulderLeft,
    shoulderRight,
    ...hips,
    armLeft: arm(shoulderLeft, POSE.ELBOW_LEFT, POSE.WRIST_LEFT),
    armRight: arm(shoulderRight, POSE.ELBOW_RIGHT, POSE.WRIST_RIGHT),
  };
}

/** Hips placed straight down the torso axis, for when the camera only frames the upper body. */
function proportionalHips(left: Vec, right: Vec): { hipLeft: Vec; hipRight: Vec } {
  const dx = right.x - left.x;
  const dy = right.y - left.y;
  const span = Math.hypot(dx, dy) || 1;
  const downX = -dy / span;
  const downY = dx / span;
  const drop = span * TORSO_RATIO;
  const inset = 0.08;
  return {
    hipLeft: { x: left.x + downX * drop + dx * inset, y: left.y + downY * drop + dy * inset },
    hipRight: { x: right.x + downX * drop - dx * inset, y: right.y + downY * drop - dy * inset },
  };
}

/** Point reached by walking `distance` pixels along a polyline, clamped to its end. */
export function walkPolyline(points: readonly Vec[], distance: number): Vec {
  let remaining = distance;
  for (let i = 1; i < points.length; i++) {
    const dx = points[i].x - points[i - 1].x;
    const dy = points[i].y - points[i - 1].y;
    const segment = Math.hypot(dx, dy);
    if (segment === 0) continue;
    if (remaining <= segment) {
      const t = remaining / segment;
      return { x: points[i - 1].x + dx * t, y: points[i - 1].y + dy * t };
    }
    remaining -= segment;
  }
  return points[points.length - 1];
}

/** Where each torso control sits in the list that `garmentControls` returns. */
export const CONTROL = {
  NECK: 0,
  SHOULDER_LEFT: 1,
  SHOULDER_RIGHT: 2,
  HIP_LEFT: 3,
  HIP_RIGHT: 4,
} as const;

/** The garment's torso corners in polygon order, used to tell which body parts cross in front. */
export function torsoQuad(controls: readonly ControlPair[]): Vec[] {
  return [
    controls[CONTROL.SHOULDER_LEFT].to,
    controls[CONTROL.SHOULDER_RIGHT].to,
    controls[CONTROL.HIP_RIGHT].to,
    controls[CONTROL.HIP_LEFT].to,
  ];
}

/**
 * Pairs garment landmarks with body landmarks. Sources are texture pixels, targets are canvas
 * pixels. `fit` sets how far the garment's shoulder seam reaches past the shoulder joints.
 *
 * The torso mapping stays a plain rotation plus uniform scale: the body supplies the lean and the
 * shoulder width, while the garment keeps its own proportions. A short torso therefore wears the
 * same garment lower rather than squashing it. Only the cuffs bend the mesh, following the arms.
 */
export function garmentControls(
  shape: GarmentShape,
  body: Body,
  fit: number,
  image: { width: number; height: number },
): ControlPair[] {
  const source = (x: number, y: number): Vec => ({ x: x * image.width, y: y * image.height });

  const dx = body.shoulderRight.x - body.shoulderLeft.x;
  const dy = body.shoulderRight.y - body.shoulderLeft.y;
  const span = Math.hypot(dx, dy) || 1;
  const across = { x: dx / span, y: dy / span };
  const shoulderMid = midpoint(body.shoulderLeft, body.shoulderRight);

  const worn = span * fit;
  const shoulderLeft = offset(shoulderMid, across, -worn / 2);
  const shoulderRight = offset(shoulderMid, across, worn / 2);

  // Texture pixels to canvas pixels, fixed by the shoulder seam alone.
  const scale = worn / (2 * shape.shoulderHalf * image.width);
  const down = direction(shoulderMid, midpoint(body.hipLeft, body.hipRight));
  const hipMid = offset(shoulderMid, down, (shape.hipY - shape.shoulderY) * image.height * scale);
  const hipReach = shape.hipHalf * image.width * scale;

  // Order matters: CONTROL names these positions and torsoQuad reads them back.
  const controls: ControlPair[] = [
    { from: source(shape.center, 0), to: offset(shoulderMid, down, -worn * NECK_RISE) },
    { from: source(shape.center - shape.shoulderHalf, shape.shoulderY), to: shoulderLeft },
    { from: source(shape.center + shape.shoulderHalf, shape.shoulderY), to: shoulderRight },
    { from: source(shape.center - shape.hipHalf, shape.hipY), to: offset(hipMid, across, -hipReach) },
    { from: source(shape.center + shape.hipHalf, shape.hipY), to: offset(hipMid, across, hipReach) },
  ];

  if (!shape.sleeves) return controls;

  // A cuff travels down the arm by its own length, measured against the garment's shoulder width.
  const cuff = (tip: Vec, shoulder: Vec, arm: Vec[] | null, edgeX: number) => {
    if (!arm) return;
    const reach = distance(source(tip.x, tip.y), source(edgeX, shape.shoulderY)) * scale;
    controls.push({ from: source(tip.x, tip.y), to: walkPolyline([shoulder, ...arm.slice(1)], reach) });
  };
  cuff(shape.sleeves.left, shoulderLeft, body.armLeft, shape.center - shape.shoulderHalf);
  cuff(shape.sleeves.right, shoulderRight, body.armRight, shape.center + shape.shoulderHalf);
  return controls;
}

function midpoint(a: Vec, b: Vec): Vec {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function offset(from: Vec, unit: Vec, distance: number): Vec {
  return { x: from.x + unit.x * distance, y: from.y + unit.y * distance };
}

function distance(a: Vec, b: Vec): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function direction(from: Vec, to: Vec): Vec {
  const d = distance(from, to) || 1;
  return { x: (to.x - from.x) / d, y: (to.y - from.y) / d };
}
