import { describe, expect, it } from 'vitest';
import { alphaBounds } from './image-bounds';

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
