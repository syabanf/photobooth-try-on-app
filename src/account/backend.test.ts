import { describe, expect, it } from 'vitest';
import { createLocalBackend, memoryStore } from './backend';
import { TRIAL_LIMITS, trialDaysLeft, type TrialInput } from './model';

const TRIAL: TrialInput = { name: 'Rizky Pratama', business: 'Studio Rupa', email: ' Rizky@Example.com ', password: 'hunter2hunter2' };
const DAY = 86_400_000;

function setup(start = Date.UTC(2026, 8, 25)) {
  const clock = { now: start };
  const store = memoryStore();
  const backend = createLocalBackend(store, () => clock.now);
  return { backend, store, clock };
}

describe('trial accounts', () => {
  it('starts a 14 day trial, signed in, with a normalised email', async () => {
    const { backend, clock } = setup();
    const account = await backend.startTrial(TRIAL);
    expect(account.email).toBe('rizky@example.com');
    expect(trialDaysLeft(account, clock.now)).toBe(14);
    expect(await backend.current()).toEqual(account);
  });

  it('never stores the password itself', async () => {
    const { backend, store } = setup();
    await backend.startTrial(TRIAL);
    expect(store.getItem('vto:accounts')).not.toContain(TRIAL.password);
  });

  it('refuses a second trial on the same email', async () => {
    const { backend } = setup();
    await backend.startTrial(TRIAL);
    await expect(backend.startTrial({ ...TRIAL, email: 'rizky@example.com' })).rejects.toMatchObject({ field: 'email' });
  });

  it('rejects short passwords and bad emails before creating anything', async () => {
    const { backend } = setup();
    await expect(backend.startTrial({ ...TRIAL, password: 'short' })).rejects.toMatchObject({ field: 'password' });
    await expect(backend.startTrial({ ...TRIAL, email: 'not-an-email' })).rejects.toMatchObject({ field: 'email' });
    expect(await backend.current()).toBeNull();
  });

  it('signs in with the right password only', async () => {
    const { backend } = setup();
    await backend.startTrial(TRIAL);
    await backend.signOut();
    expect(await backend.current()).toBeNull();
    await expect(backend.signIn('rizky@example.com', 'wrong-password')).rejects.toThrow('Email or password is wrong.');
    await expect(backend.signIn('RIZKY@example.com', TRIAL.password)).resolves.toMatchObject({ name: 'Rizky Pratama' });
  });
});

describe('locations and points', () => {
  it('keeps several points in several locations', async () => {
    const { backend } = setup();
    await backend.startTrial(TRIAL);
    const mall = await backend.saveLocation({ name: 'Grand Indonesia', city: 'Jakarta', address: '' });
    const venue = await backend.saveLocation({ name: 'Pakuwon Mall', city: 'Surabaya', address: '' });
    await backend.savePoint({ locationId: mall.id, name: 'Kiosk 1', code: 'gra-01', active: true });
    await backend.savePoint({ locationId: mall.id, name: 'Mirror', code: 'GRA-02', active: false });
    await backend.savePoint({ locationId: venue.id, name: 'Booth', code: 'PAK-01', active: true });

    const sites = await backend.sites();
    expect(sites.locations).toHaveLength(2);
    expect(sites.points.filter((point) => point.locationId === mall.id).map((point) => point.code)).toEqual(['GRA-01', 'GRA-02']);
  });

  it('refuses a duplicate point code', async () => {
    const { backend } = setup();
    await backend.startTrial(TRIAL);
    const mall = await backend.saveLocation({ name: 'Grand Indonesia', city: 'Jakarta', address: '' });
    await backend.savePoint({ locationId: mall.id, name: 'Kiosk 1', code: 'GRA-01', active: true });
    await expect(
      backend.savePoint({ locationId: mall.id, name: 'Kiosk 2', code: 'GRA-01', active: true }),
    ).rejects.toMatchObject({ field: 'code' });
  });

  it('edits in place and deletes a location with its points', async () => {
    const { backend } = setup();
    await backend.startTrial(TRIAL);
    const mall = await backend.saveLocation({ name: 'Grand Indo', city: 'Jakarta', address: '' });
    await backend.saveLocation({ id: mall.id, name: 'Grand Indonesia', city: 'Jakarta', address: 'Jl. MH Thamrin 1' });
    await backend.savePoint({ locationId: mall.id, name: 'Kiosk 1', code: 'GRA-01', active: true });
    expect((await backend.sites()).locations[0].name).toBe('Grand Indonesia');

    await backend.deleteLocation(mall.id);
    expect(await backend.sites()).toEqual({ locations: [], points: [] });
  });

  it('holds the trial to its location and point limits', async () => {
    const { backend } = setup();
    await backend.startTrial(TRIAL);
    const ids = [];
    for (let i = 0; i < TRIAL_LIMITS.locations; i++) {
      ids.push((await backend.saveLocation({ name: `Store ${i}`, city: 'Bandung', address: '' })).id);
    }
    await expect(backend.saveLocation({ name: 'One more', city: 'Bandung', address: '' })).rejects.toThrow('up to 3 locations');
    for (let i = 0; i < TRIAL_LIMITS.points; i++) {
      await backend.savePoint({ locationId: ids[i % ids.length], name: `Kiosk ${i}`, code: `K-${i}`, active: true });
    }
    await expect(backend.savePoint({ locationId: ids[0], name: 'Extra', code: 'K-99', active: true })).rejects.toThrow('up to 10 points');
  });

  it('locks changes once the trial ends but still reads them', async () => {
    const { backend, clock } = setup();
    await backend.startTrial(TRIAL);
    await backend.saveLocation({ name: 'Grand Indonesia', city: 'Jakarta', address: '' });
    clock.now += 15 * DAY;
    await expect(backend.saveLocation({ name: 'Later', city: 'Jakarta', address: '' })).rejects.toThrow('trial has ended');
    expect((await backend.sites()).locations).toHaveLength(1);
  });

  it('keeps each account to its own data', async () => {
    const { backend } = setup();
    await backend.startTrial(TRIAL);
    await backend.saveLocation({ name: 'Grand Indonesia', city: 'Jakarta', address: '' });
    await backend.signOut();
    await backend.startTrial({ ...TRIAL, email: 'other@example.com' });
    expect((await backend.sites()).locations).toEqual([]);
  });
});
