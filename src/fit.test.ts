import { describe, expect, it } from 'vitest';
import { containRect, coverCrop } from './fit';

const CELL_ASPECT = 3 / 4;

describe('containRect', () => {
  it('pillarboxes a narrow video in a wide box', () => {
    expect(containRect(1600, 900, 720, 900)).toEqual({ x: 440, y: 0, w: 720, h: 900 });
  });

  it('letterboxes a wide video in a tall box', () => {
    const box = containRect(300, 400, 1280, 720);
    expect(box.w).toBe(300);
    expect(box.h).toBeCloseTo(168.75);
    expect(box.y).toBeCloseTo((400 - 168.75) / 2);
  });

  it('fills the box before the video reports its size', () => {
    expect(containRect(200, 100, 0, 0)).toEqual({ x: 0, y: 0, w: 200, h: 100 });
  });
});

describe('coverCrop', () => {
  it('trims the sides of a wide frame', () => {
    const crop = coverCrop(1600, 900, CELL_ASPECT);
    expect(crop.h).toBe(900);
    expect(crop.w).toBeCloseTo(1200);
    expect(crop.x).toBeCloseTo(200);
  });

  it('trims the top and bottom of a tall frame', () => {
    const crop = coverCrop(800, 1200, CELL_ASPECT);
    expect(crop.w).toBe(800);
    expect(crop.h).toBeCloseTo(600);
    expect(crop.y).toBeCloseTo(300);
  });
});
