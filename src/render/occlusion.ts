// Decides which pixels of the person belong in front of a worn garment.

import type { Vec } from '../mls';
import { SEGMENT, type SegmentMask } from '../tracking/segmenter';

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
 * passes in front of it. Hair, face and accessories always pass in front, and so does bare skin
 * that crosses the torso, which is how a hand raised to the chest covers the shirt. Skin outside
 * the torso stays available, so sleeves keep wrapping the arms they are drawn on.
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

  for (let y = 0; y < target.height; y++) {
    const maskY = Math.min(mask.height - 1, Math.floor(y * stepY));
    const row = maskY * mask.width;
    for (let x = 0; x < target.width; x++) {
      const maskX = Math.min(mask.width - 1, Math.floor(x * stepX));
      const category = mask.data[row + maskX];
      let keep = category !== SEGMENT.BACKGROUND;
      if (keep && (category === SEGMENT.HAIR || category === SEGMENT.FACE_SKIN || category === SEGMENT.ACCESSORIES)) {
        keep = false;
      } else if (keep && category === SEGMENT.BODY_SKIN) {
        keep = !pointInQuad({ x: (x + 0.5) * frameX, y: (y + 0.5) * frameY }, torso);
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
