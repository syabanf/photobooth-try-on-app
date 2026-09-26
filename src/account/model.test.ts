import { describe, expect, it } from 'vitest';
import { initials, suggestPointCode, trialDaysLeft, trialEnd, trialExpired, type Account } from './model';

const DAY = 86_400_000;
const start = Date.UTC(2026, 8, 25, 9);
const account: Account = { id: 'a', business: 'Rupa', createdAt: start, trialEndsAt: trialEnd(start) };

describe('trial clock', () => {
  it('counts the last partial day as a day left', () => {
    expect(trialDaysLeft(account, start + 13.5 * DAY)).toBe(1);
    expect(trialExpired(account, start + 13.5 * DAY)).toBe(false);
  });

  it('ends exactly 14 days after sign-up', () => {
    expect(trialDaysLeft(account, start + 14 * DAY)).toBe(0);
    expect(trialExpired(account, start + 14 * DAY)).toBe(true);
    expect(trialDaysLeft(account, start + 30 * DAY)).toBe(0);
  });
});

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
