import { describe, expect, it } from 'vitest';
import { FACE, FACE_OVAL, faceOutline, glassesFrame, hatFrame, itemRect, packFrame, unpackFrame, type LandmarkLike } from './anchors';

function landmarks(points: Record<number, LandmarkLike>, size = 478): LandmarkLike[] {
  const out: LandmarkLike[] = Array.from({ length: size }, () => ({ x: 0, y: 0 }));
  for (const [i, p] of Object.entries(points)) out[Number(i)] = p;
  return out;
}

/** A head facing the camera: eyes level, chin under the forehead. */
const frontal = {
  [FACE.EYE_L]: { x: 0.4, y: 0.5 },
  [FACE.EYE_R]: { x: 0.6, y: 0.5 },
  [FACE.FOREHEAD_TOP]: { x: 0.5, y: 0.3 },
  [FACE.CHIN]: { x: 0.5, y: 0.8 },
  [FACE.SIDE_L]: { x: 0.3, y: 0.55 },
  [FACE.SIDE_R]: { x: 0.7, y: 0.55 },
};

describe('glassesFrame', () => {
  it('sits between the eyes with unit axes when the head faces the camera', () => {
    const f = glassesFrame(landmarks(frontal), 1000, 1000);
    expect(f.origin).toEqual({ x: 500, y: 500 });
    expect(f.right.x).toBeCloseTo(1);
    expect(f.right.y).toBeCloseTo(0);
    expect(f.down.x).toBeCloseTo(0);
    expect(f.down.y).toBeCloseTo(1);
    expect(f.width).toBeCloseTo(200);
  });

  it('shortens the right axis but not the width when the head turns', () => {
    // One eye corner sits further from the camera: the eye line now has depth.
    const turned = landmarks({ ...frontal, [FACE.EYE_R]: { x: 0.56, y: 0.5, z: 0.12 } });
    const f = glassesFrame(turned, 1000, 1000);
    expect(f.right.x).toBeCloseTo(0.8);
    expect(f.down.y).toBeCloseTo(1);
    expect(f.width).toBeCloseTo(200);
  });

  it('rotates both axes with a tilted head', () => {
    const angle = Math.PI / 6;
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const tilted = landmarks({
      ...frontal,
      [FACE.EYE_L]: { x: 0.5 - 0.1 * c, y: 0.5 - 0.1 * s },
      [FACE.EYE_R]: { x: 0.5 + 0.1 * c, y: 0.5 + 0.1 * s },
      [FACE.FOREHEAD_TOP]: { x: 0.5 + 0.2 * s, y: 0.5 - 0.2 * c },
      [FACE.CHIN]: { x: 0.5 - 0.3 * s, y: 0.5 + 0.3 * c },
    });
    const f = glassesFrame(tilted, 1000, 1000);
    expect(f.right.x).toBeCloseTo(c);
    expect(f.right.y).toBeCloseTo(s);
    expect(f.down.x).toBeCloseTo(-s);
    expect(f.down.y).toBeCloseTo(c);
  });

  it('keeps down square to right when the chin is off centre', () => {
    const f = glassesFrame(landmarks({ ...frontal, [FACE.CHIN]: { x: 0.6, y: 0.8 } }), 1000, 1000);
    expect(f.right.x * f.down.x + f.right.y * f.down.y).toBeCloseTo(0);
  });
});

describe('hatFrame', () => {
  it('starts on the forehead and measures the head at the sides', () => {
    const f = hatFrame(landmarks(frontal), 100, 200);
    expect(f.origin).toEqual({ x: 50, y: 60 });
    expect(f.width).toBeCloseTo(40);
    expect(f.right.x).toBeCloseTo(1);
  });
});

describe('faceOutline', () => {
  it('follows the oval landmarks in order', () => {
    const lm = landmarks({ [FACE_OVAL[0]]: { x: 0.5, y: 0.1 }, [FACE_OVAL[18]]: { x: 0.5, y: 0.9 } });
    const outline = faceOutline(lm, 100, 100);
    expect(outline).toHaveLength(FACE_OVAL.length);
    expect(outline[0]).toEqual({ x: 50, y: 10 });
    expect(outline[18]).toEqual({ x: 50, y: 90 });
  });
});

describe('packFrame', () => {
  it('round trips through a flat list', () => {
    const f = glassesFrame(landmarks(frontal), 640, 480);
    expect(unpackFrame(packFrame(f))).toEqual(f);
  });
});

describe('itemRect', () => {
  const frame = { width: 100 };
  const img = { width: 200, height: 100 };

  it('centers on the origin with pivotY 0.5', () => {
    const r = itemRect(frame, { scale: 1.5, offsetX: 0, offsetY: 0, pivotY: 0.5 }, img);
    expect(r).toEqual({ x: -75, y: -37.5, w: 150, h: 75 });
  });

  it('hangs the bottom edge on the origin with pivotY 1', () => {
    const r = itemRect(frame, { scale: 1, offsetX: 0, offsetY: 0, pivotY: 1 }, img);
    expect(r.y).toBe(-r.h);
  });

  it('applies offsets in frame-width units', () => {
    const r = itemRect(frame, { scale: 1, offsetX: 0.1, offsetY: -0.05, pivotY: 0 }, img);
    expect(r.x).toBe(-50 + 10);
    expect(r.y).toBe(-5);
  });
});
