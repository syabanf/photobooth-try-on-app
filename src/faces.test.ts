import { describe, expect, it } from 'vitest';
import { FACE_OVAL } from './anchors';
import { FACE_ASPECT, faceBox } from './faces';

/** A face outline as a circle of landmarks, in normalised coordinates. */
function face(cx: number, cy: number, r: number) {
  const landmarks = Array.from({ length: 478 }, () => ({ x: cx, y: cy }));
  FACE_OVAL.forEach((index, i) => {
    const angle = (i / FACE_OVAL.length) * Math.PI * 2;
    landmarks[index] = { x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r * (16 / 9) };
  });
  return landmarks;
}

describe('faceBox', () => {
  it('is 4:5, wider than the face, and contains it', () => {
    const box = faceBox(face(0.5, 0.45, 0.08), 1280, 720);
    expect(box.width / box.height).toBeCloseTo(FACE_ASPECT, 5);
    expect(box.width).toBeGreaterThan(0.16 * 1280);
    expect(box.x).toBeLessThan(0.42 * 1280);
    expect(box.x + box.width).toBeGreaterThan(0.58 * 1280);
  });

  it('stays inside the picture for a face at the edge', () => {
    const box = faceBox(face(0.05, 0.1, 0.06), 1280, 720);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(1280);
    expect(box.y + box.height).toBeLessThanOrEqual(720);
  });

  it('shrinks instead of stretching for a face filling the frame', () => {
    const box = faceBox(face(0.5, 0.5, 0.4), 1280, 720);
    expect(box.height).toBeLessThanOrEqual(720);
    expect(box.width / box.height).toBeCloseTo(FACE_ASPECT, 5);
  });
});
