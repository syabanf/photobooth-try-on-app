import { describe, expect, it } from 'vitest';
import { alphaBounds, clearBackdrop } from './image-bounds';

function frame(width: number, height: number, opaque: Array<[number, number]>): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);
  for (const [x, y] of opaque) data[(y * width + x) * 4 + 3] = 255;
  return data;
}

describe('alphaBounds', () => {
  it('tightens to the opaque pixels', () => {
    const data = frame(10, 10, [[2, 3], [6, 3], [4, 8]]);
    expect(alphaBounds(data, 10, 10)).toEqual({ x: 2, y: 3, w: 5, h: 6 });
  });

  it('returns the full frame when everything is transparent', () => {
    expect(alphaBounds(frame(4, 3, []), 4, 3)).toEqual({ x: 0, y: 0, w: 4, h: 3 });
  });

  it('ignores faint alpha', () => {
    const data = frame(5, 5, [[2, 2]]);
    data[(0 * 5 + 0) * 4 + 3] = 8;
    expect(alphaBounds(data, 5, 5)).toEqual({ x: 2, y: 2, w: 1, h: 1 });
  });
});

type Rgb = [number, number, number];

/** An opaque photo filled with `backdrop`, with `paint` deciding the colour of any other pixel. */
function photo(width: number, height: number, backdrop: Rgb, paint: (x: number, y: number) => Rgb | null): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      data.set([...(paint(x, y) ?? backdrop), 255], i);
    }
  }
  return data;
}

const alphaAt = (data: Uint8ClampedArray, width: number, x: number, y: number) => data[(y * width + x) * 4 + 3];
const WHITE: Rgb = [250, 250, 250];
const HAT: Rgb = [40, 30, 20];
const inBox = (x: number, y: number, x0: number, y0: number, x1: number, y1: number) => x >= x0 && x <= x1 && y >= y0 && y <= y1;

describe('clearBackdrop', () => {
  it('clears a plain backdrop and keeps the product opaque', () => {
    const data = photo(12, 10, WHITE, (x, y) => (inBox(x, y, 3, 3, 8, 6) ? HAT : null));
    expect(clearBackdrop(data, 12, 10)).toBe(true);
    expect(alphaAt(data, 12, 0, 0)).toBe(0);
    expect(alphaAt(data, 12, 5, 4)).toBe(255);
    expect(alphaBounds(data, 12, 10)).toEqual({ x: 3, y: 3, w: 6, h: 4 });
  });

  it('follows a soft shadow but stops at the product edge', () => {
    // A shadow under the product darkens in small steps, well past the border match.
    const shade = (y: number): Rgb => [250 - (y - 6) * 8, 250 - (y - 6) * 8, 250 - (y - 6) * 8];
    const data = photo(12, 12, WHITE, (x, y) => (inBox(x, y, 3, 2, 8, 5) ? HAT : y >= 6 && y <= 11 && x >= 2 && x <= 9 ? shade(y) : null));
    clearBackdrop(data, 12, 12);
    expect(alphaAt(data, 12, 5, 10)).toBe(0);
    expect(alphaBounds(data, 12, 12)).toEqual({ x: 3, y: 2, w: 6, h: 4 });
  });

  it('drops a separate label and keeps the largest shape', () => {
    const data = photo(16, 10, WHITE, (x, y) => (inBox(x, y, 2, 2, 8, 7) || inBox(x, y, 12, 7, 13, 8) ? HAT : null));
    clearBackdrop(data, 16, 10);
    expect(alphaAt(data, 16, 12, 7)).toBe(0);
    expect(alphaBounds(data, 16, 10)).toEqual({ x: 2, y: 2, w: 7, h: 6 });
  });

  it('leaves cutouts and busy borders alone', () => {
    const cutout = frame(4, 4, [[1, 1]]);
    expect(clearBackdrop(cutout, 4, 4)).toBe(false);
    const busy = photo(6, 6, WHITE, (x, y) => ((x + y) % 2 ? HAT : null));
    expect(clearBackdrop(busy, 6, 6)).toBe(false);
    expect(alphaAt(busy, 6, 0, 0)).toBe(255);
  });
});
