import { describe, expect, it } from 'vitest';
import { SEGMENT, type SegmentMask } from '../tracking/segmenter';
import { buildBackgroundMask, buildGarmentMask, pointInQuad } from './occlusion';

const quad = [
  { x: 10, y: 10 },
  { x: 30, y: 10 },
  { x: 30, y: 30 },
  { x: 10, y: 30 },
];

describe('pointInQuad', () => {
  it('accepts a point inside', () => {
    expect(pointInQuad({ x: 20, y: 20 }, quad)).toBe(true);
  });

  it('rejects points outside on every side', () => {
    for (const p of [{ x: 5, y: 20 }, { x: 35, y: 20 }, { x: 20, y: 5 }, { x: 20, y: 35 }]) {
      expect(pointInQuad(p, quad)).toBe(false);
    }
  });

  it('handles a leaning quad', () => {
    const leaning = [{ x: 0, y: 0 }, { x: 20, y: 10 }, { x: 15, y: 30 }, { x: -5, y: 20 }];
    expect(pointInQuad({ x: 8, y: 15 }, leaning)).toBe(true);
    expect(pointInQuad({ x: 25, y: 5 }, leaning)).toBe(false);
  });
});

describe('buildGarmentMask', () => {
  const frame = { width: 40, height: 40 };
  const alphaAt = (target: { data: Uint8ClampedArray }, x: number, y: number, width: number) =>
    target.data[(y * width + x) * 4 + 3];

  function run(categories: number[], width = 4, height = 4) {
    const mask: SegmentMask = { data: Uint8Array.from(categories), width, height };
    const target = { data: new Uint8ClampedArray(width * height * 4), width, height };
    buildGarmentMask(mask, quad, frame, target as ImageData);
    return target;
  }

  it('keeps the garment on the person and off the background', () => {
    const flat = new Array(16).fill(SEGMENT.BACKGROUND);
    flat[5] = SEGMENT.CLOTHES;
    const target = run(flat);
    expect(alphaAt(target, 1, 1, 4)).toBe(255);
    expect(alphaAt(target, 0, 0, 4)).toBe(0);
  });

  it('drops hair and face so they pass in front', () => {
    for (const category of [SEGMENT.HAIR, SEGMENT.FACE_SKIN]) {
      expect(run(new Array(16).fill(category)).data.some((v, i) => i % 4 === 3 && v > 0)).toBe(false);
    }
  });

  it('drops skin that crosses the torso but keeps skin outside it for the sleeves', () => {
    const target = run(new Array(16).fill(SEGMENT.BODY_SKIN));
    // Mask cell (2,2) maps to frame (25,25), inside the quad; cell (0,0) maps to (5,5), outside.
    expect(alphaAt(target, 2, 2, 4)).toBe(0);
    expect(alphaAt(target, 0, 0, 4)).toBe(255);
  });

  it('keeps the collar over skin and jewellery just below the shoulder line', () => {
    // Cell (2,1) maps to (25,15): inside the quad, a quarter of a shoulder span below the shoulders.
    for (const category of [SEGMENT.BODY_SKIN, SEGMENT.ACCESSORIES]) {
      const target = run(new Array(16).fill(category));
      expect(alphaAt(target, 2, 1, 4)).toBe(255);
      expect(alphaAt(target, 2, 2, 4)).toBe(0);
    }
  });
});

describe('buildBackgroundMask', () => {
  it('keeps only background pixels, so the person stays uncovered', () => {
    const mask: SegmentMask = {
      data: Uint8Array.from([SEGMENT.BACKGROUND, SEGMENT.HAIR, SEGMENT.CLOTHES, SEGMENT.BACKGROUND]),
      width: 2,
      height: 2,
    };
    const target = { data: new Uint8ClampedArray(16), width: 2, height: 2 } as ImageData;
    buildBackgroundMask(mask, target);
    expect([3, 7, 11, 15].map((i) => target.data[i])).toEqual([255, 0, 0, 255]);
  });
});
