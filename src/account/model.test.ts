import { describe, expect, it } from 'vitest';
import { initials, suggestPointCode } from './model';

describe('suggestPointCode', () => {
  it('takes the next free number for the location prefix', () => {
    expect(suggestPointCode('Grand Indonesia', [])).toBe('GRA-01');
    expect(suggestPointCode('Grand Indonesia', ['gra-01', 'GRA-03'])).toBe('GRA-02');
  });

  it('falls back to PT when the name has no letters or digits', () => {
    expect(suggestPointCode('   ', [])).toBe('PT-01');
  });
});

describe('initials', () => {
  it('uses the first and last word', () => {
    expect(initials('Muhammad Fahmi Syaban')).toBe('MS');
    expect(initials('rizky')).toBe('RI');
  });
});
