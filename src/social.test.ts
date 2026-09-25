import { describe, expect, it } from 'vitest';
import { FRAMES, exportType, placeInFrame } from './social';

describe('FRAMES', () => {
  it('uses the Instagram sizes', () => {
    expect([FRAMES.post.width, FRAMES.post.height]).toEqual([1080, 1350]);
    expect([FRAMES.square.width, FRAMES.square.height]).toEqual([1080, 1080]);
    expect([FRAMES.story.width, FRAMES.story.height]).toEqual([1080, 1920]);
  });
});

describe('placeInFrame', () => {
  it('keeps a tall strip inside the story safe zone, centred across', () => {
    const at = placeInFrame(FRAMES.story, 664, 2052);
    expect(at.y).toBeGreaterThanOrEqual(250);
    expect(at.y + at.h).toBeLessThanOrEqual(1920 - 280 + 0.001);
    expect(at.x + at.w / 2).toBeCloseTo(540);
    expect(at.w / at.h).toBeCloseTo(664 / 2052);
  });

  it('fills the width of a post with a wide snapshot', () => {
    const at = placeInFrame(FRAMES.post, 1280, 720);
    expect(at.x).toBeCloseTo(64);
    expect(at.w).toBeCloseTo(1080 - 128);
    expect(at.y + at.h / 2).toBeCloseTo(1350 / 2);
  });

  it('never stretches the picture', () => {
    for (const spec of Object.values(FRAMES)) {
      const at = placeInFrame(spec, 1040, 948);
      expect(at.w / at.h).toBeCloseTo(1040 / 948);
    }
  });
});

describe('exportType', () => {
  it('saves social sizes as JPEG and the original as PNG', () => {
    expect(exportType('story').type).toBe('image/jpeg');
    expect(exportType('original')).toEqual({ type: 'image/png', extension: 'png' });
  });
});
