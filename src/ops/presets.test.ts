import { describe, expect, it } from 'vitest';
import type { Preset } from './model';
import { suggestPreset } from './presets';

const preset = (id: string, layout: Preset['layout'], active = true): Preset => ({ id, name: id, layout, prompt: '', frameId: null, active, builtIn: true });

describe('suggestPreset', () => {
  const presets = [preset('off', 'cover', false), preset('squad', 'squad'), preset('poster', 'poster')];

  it('suggests the group layout for several faces', () => {
    expect(suggestPreset(presets, 3)?.id).toBe('squad');
  });

  it('suggests the first active single-face layout for one face', () => {
    expect(suggestPreset(presets, 1)?.id).toBe('poster');
  });

  it('suggests nothing when every preset is off', () => {
    expect(suggestPreset([preset('a', 'cover', false)], 1)).toBeNull();
  });
});
