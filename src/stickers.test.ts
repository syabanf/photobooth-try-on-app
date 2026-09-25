import { describe, expect, it } from 'vitest';
import { STICKERS, resizeSticker } from './stickers';

describe('resizeSticker', () => {
  it('scales within bounds', () => {
    expect(resizeSticker(0.1, 1.2)).toBeCloseTo(0.12);
  });

  it('never shrinks past the smallest readable size or grows past the frame', () => {
    expect(resizeSticker(0.03, 0.1)).toBe(0.025);
    expect(resizeSticker(0.25, 10)).toBe(0.3);
  });
});

describe('STICKERS', () => {
  it('has unique ids', () => {
    expect(new Set(STICKERS.map((s) => s.id)).size).toBe(STICKERS.length);
  });
});
