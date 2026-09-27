// Decides which pixels of the person belong in front of a worn garment.

import type { Vec } from '../mls';
import { SEGMENT, type SegmentMask } from '../tracking/segmenter';

/** How far below the shoulder line, in shoulder spans, the collar still covers skin and jewellery. */
const COLLAR_DEPTH = 0.3;

export function pointInQuad(p: Vec, quad: readonly Vec[]): boolean {
  let inside = false;
  for (let i = 0, j = quad.length - 1; i < quad.length; j = i++) {
    const a = quad[i];
    const b = quad[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Fills `target` with the silhouette the garment is allowed to occupy: the person, minus whatever
 * passes in front of it. Hair and face always pass in front, and so do accessories and bare skin
 * that cross the torso, which is how a hand raised to the chest covers the shirt. Two exceptions:
 * skin outside the torso stays available, so sleeves keep wrapping the arms they are drawn on, and
 * the neck and upper chest stay under the collar, so a neckline or a necklace in the camera does
 * not punch a hole in the garment.
 *
 * Keeping the garment inside the body outline is what stops it spilling onto the room behind, and
 * it is the difference between a garment that looks worn and one that looks pasted on.
 *
 * The segmentation arrives at camera resolution, which is far more detail than this edge needs, so
 * `target` is usually much smaller and the mask is sampled into it.
 */
export function buildGarmentMask(
  mask: SegmentMask,
  torso: readonly Vec[],
  frame: { width: number; height: number },
  target: ImageData,
): void {
  const pixels = target.data;
  const stepX = mask.width / target.width;
  const stepY = mask.height / target.height;
  const frameX = frame.width / target.width;
  const frameY = frame.height / target.height;

  // Depth below the shoulder line, in shoulder spans, measured toward the hips.
  const [shoulderL, shoulderR, , hipL] = torso;
  const ax = shoulderR.x - shoulderL.x;
  const ay = shoulderR.y - shoulderL.y;
  const span = ax * ax + ay * ay || 1;
  const hipSide = Math.sign(ax * (hipL.y - shoulderL.y) - ay * (hipL.x - shoulderL.x)) || 1;
  const depth = (p: Vec) => (hipSide * (ax * (p.y - shoulderL.y) - ay * (p.x - shoulderL.x))) / span;
  const underCollar = (p: Vec) => pointInQuad(p, torso) && depth(p) < COLLAR_DEPTH;

  for (let y = 0; y < target.height; y++) {
    const maskY = Math.min(mask.height - 1, Math.floor(y * stepY));
    const row = maskY * mask.width;
    for (let x = 0; x < target.width; x++) {
      const maskX = Math.min(mask.width - 1, Math.floor(x * stepX));
      const category = mask.data[row + maskX];
      let keep = category !== SEGMENT.BACKGROUND;
      if (category === SEGMENT.HAIR || category === SEGMENT.FACE_SKIN) {
        keep = false;
      } else if (category === SEGMENT.ACCESSORIES) {
        keep = underCollar({ x: (x + 0.5) * frameX, y: (y + 0.5) * frameY });
      } else if (category === SEGMENT.BODY_SKIN) {
        const p = { x: (x + 0.5) * frameX, y: (y + 0.5) * frameY };
        keep = !pointInQuad(p, torso) || underCollar(p);
      }
      pixels[(y * target.width + x) * 4 + 3] = keep ? 255 : 0;
    }
  }
}

/** Marks every background pixel opaque, so a backdrop drawn through it covers the room and not the person. */
export function buildBackgroundMask(mask: SegmentMask, target: ImageData): void {
  const pixels = target.data;
  for (let i = 0; i < mask.data.length; i++) {
    pixels[i * 4 + 3] = mask.data[i] === SEGMENT.BACKGROUND ? 255 : 0;
  }
}
