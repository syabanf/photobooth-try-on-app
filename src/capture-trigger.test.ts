import { describe, expect, it } from 'vitest';
import { CaptureTrigger } from './capture-trigger';

const options = { gestures: ['Victory'], holdFrames: 3, countdownMs: 3000, cooldownMs: 2000 };

describe('CaptureTrigger', () => {
  it('ignores gestures outside the trigger set', () => {
    const t = new CaptureTrigger(options);
    for (let i = 0; i < 10; i++) expect(t.update('Thumb_Up', i * 33).secondsLeft).toBeNull();
  });

  it('starts the countdown after the gesture is held long enough', () => {
    const t = new CaptureTrigger(options);
    expect(t.update('Victory', 0).secondsLeft).toBeNull();
    expect(t.update('Victory', 33).secondsLeft).toBeNull();
    expect(t.update('Victory', 66).secondsLeft).toBe(3);
  });

  it('resets the hold when the gesture drops', () => {
    const t = new CaptureTrigger(options);
    t.update('Victory', 0);
    t.update('Victory', 33);
    t.update(null, 66);
    expect(t.update('Victory', 99).secondsLeft).toBeNull();
  });

  it('counts down without requiring the gesture, then captures once', () => {
    const t = new CaptureTrigger(options);
    for (let i = 0; i < 3; i++) t.update('Victory', i * 33);
    expect(t.update(null, 66 + 1500).secondsLeft).toBe(2);
    const fired = t.update(null, 66 + 3000);
    expect(fired).toEqual({ secondsLeft: null, capture: true });
    expect(t.update(null, 66 + 3033).capture).toBe(false);
  });

  it('ignores gestures during the cooldown', () => {
    const t = new CaptureTrigger(options);
    for (let i = 0; i < 3; i++) t.update('Victory', i * 33);
    t.update(null, 66 + 3000);
    for (let i = 0; i < 5; i++) expect(t.update('Victory', 3100 + i * 33).secondsLeft).toBeNull();
    for (let i = 0; i < 3; i++) t.update('Victory', 6000 + i * 33);
    expect(t.update('Victory', 6100).secondsLeft).toBe(3);
  });
});
