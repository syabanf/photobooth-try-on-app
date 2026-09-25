import { describe, expect, it } from 'vitest';
import {
  FACE,
  glassesAnchor,
  hatAnchor,
  itemRect,
  lineAnchor,
  smoothAnchor,
  type LandmarkLike,
} from './anchors';

function landmarks(points: Record<number, LandmarkLike>, size = 478): LandmarkLike[] {
  const out: LandmarkLike[] = Array.from({ length: size }, () => ({ x: 0, y: 0 }));
  for (const [i, p] of Object.entries(points)) out[Number(i)] = p;
  return out;
}

describe('lineAnchor', () => {
  it('is level for horizontal points', () => {
    const a = lineAnchor({ x: 0, y: 10 }, { x: 100, y: 10 });
    expect(a.cx).toBe(50);
    expect(a.cy).toBe(10);
    expect(a.angle).toBeCloseTo(0);
    expect(a.width).toBe(100);
  });

  it('reports a 30 degree tilt', () => {
    const a = lineAnchor({ x: 0, y: 0 }, { x: Math.cos(Math.PI / 6), y: Math.sin(Math.PI / 6) });
    expect(a.angle).toBeCloseTo(Math.PI / 6);
    expect(a.width).toBeCloseTo(1);
  });
});

describe('glassesAnchor', () => {
  it('scales width with landmark distance', () => {
    const near = glassesAnchor(landmarks({ [FACE.EYE_L]: { x: 0.4, y: 0.5 }, [FACE.EYE_R]: { x: 0.6, y: 0.5 } }), 1000, 1000);
    const far = glassesAnchor(landmarks({ [FACE.EYE_L]: { x: 0.45, y: 0.5 }, [FACE.EYE_R]: { x: 0.55, y: 0.5 } }), 1000, 1000);
    expect(near.width).toBeCloseTo(far.width * 2);
  });
});

describe('hatAnchor', () => {
  it('centers on the forehead and takes width from the head sides', () => {
    const a = hatAnchor(
      landmarks({
        [FACE.EYE_L]: { x: 0.4, y: 0.5 },
        [FACE.EYE_R]: { x: 0.6, y: 0.5 },
        [FACE.FOREHEAD_TOP]: { x: 0.5, y: 0.3 },
        [FACE.SIDE_L]: { x: 0.3, y: 0.5 },
        [FACE.SIDE_R]: { x: 0.7, y: 0.5 },
      }),
      100,
      200,
    );
    expect(a.cx).toBeCloseTo(50);
    expect(a.cy).toBeCloseTo(60);
    expect(a.width).toBeCloseTo(40);
    expect(a.angle).toBeCloseTo(0);
  });
});

describe('smoothAnchor', () => {
  const target = { cx: 10, cy: 20, angle: 0.5, width: 30 };

  it('returns the sample when there is no history', () => {
    expect(smoothAnchor(null, target, 0.35)).toEqual(target);
  });

  it('converges to a constant input', () => {
    let s = smoothAnchor(null, { cx: 0, cy: 0, angle: 0, width: 0 }, 0.35);
    for (let i = 0; i < 60; i++) s = smoothAnchor(s, target, 0.35);
    expect(s.cx).toBeCloseTo(10, 3);
    expect(s.angle).toBeCloseTo(0.5, 3);
  });

  it('crosses the +/- pi boundary the short way', () => {
    const prev = { cx: 0, cy: 0, angle: Math.PI - 0.1, width: 1 };
    const next = { ...prev, angle: -Math.PI + 0.1 };
    const s = smoothAnchor(prev, next, 0.5);
    expect(s.angle).toBeCloseTo(Math.PI);
  });
});

describe('itemRect', () => {
  const anchor = { cx: 0, cy: 0, angle: 0, width: 100 };
  const img = { width: 200, height: 100 };

  it('centers on the anchor with pivotY 0.5', () => {
    const r = itemRect(anchor, { scale: 1.5, offsetX: 0, offsetY: 0, pivotY: 0.5 }, img);
    expect(r).toEqual({ x: -75, y: -37.5, w: 150, h: 75 });
  });

  it('hangs the bottom edge on the anchor with pivotY 1', () => {
    const r = itemRect(anchor, { scale: 1, offsetX: 0, offsetY: 0, pivotY: 1 }, img);
    expect(r.y).toBe(-r.h);
  });

  it('applies offsets in anchor-width units', () => {
    const r = itemRect(anchor, { scale: 1, offsetX: 0.1, offsetY: -0.05, pivotY: 0 }, img);
    expect(r.x).toBe(-50 + 10);
    expect(r.y).toBe(-5);
  });
});
