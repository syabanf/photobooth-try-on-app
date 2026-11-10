import { describe, expect, it } from 'vitest';
import { createLocalBackend, deviceLabel, INVITE_MS, LOCK_MS, MAX_TRIES, memoryStore } from './backend';
import { TRIAL_LIMITS, trialDaysLeft } from './model';

const DAY = 86_400_000;

function setup(start = Date.UTC(2026, 8, 25)) {
  const clock = { now: start };
  const store = memoryStore();
  const backend = createLocalBackend(store, () => clock.now);
  return { backend, store, clock };
}

const owner = (email = 'rizky@example.com') => ({ name: 'Rizky', email, password: 'bambu2026' });

async function register(backend: ReturnType<typeof createLocalBackend>, business = 'Dusun Bambu', email?: string) {
  return backend.register({ business, ...owner(email ?? `${business.toLowerCase().replace(/\W/g, '')}@example.com`) }, crypto.randomUUID());
}

describe('register and sign in', () => {
  it('opens a 14 day workspace with its owner signed in', async () => {
    const { backend, clock } = setup();
    const { account, member } = await backend.register({ business: '  Dusun Bambu ', ...owner(' Rizky@Example.com ') }, 'k1');
    expect(account.business).toBe('Dusun Bambu');
    expect(trialDaysLeft(account, clock.now)).toBe(14);
    expect(member).toMatchObject({ userId: `owner-${account.id}`, email: 'rizky@example.com', status: 'active' });
    expect((await backend.session())?.account).toEqual(account);
  });

  it('refuses a weak password, a bad email and an email already in use', async () => {
    const { backend } = setup();
    await expect(backend.register({ business: 'A', ...owner(), password: 'short1' }, 'a')).rejects.toThrow('at least 8 characters');
    await expect(backend.register({ business: 'A', ...owner(), password: 'onlyletters' }, 'b')).rejects.toThrow('a letter and a number');
    await expect(backend.register({ business: 'A', ...owner('nope') }, 'c')).rejects.toThrow('name@example.com');
    await register(backend, 'Dusun Bambu', 'rizky@example.com');
    await expect(backend.register({ business: 'B', ...owner('RIZKY@example.com') }, 'd')).rejects.toThrow('already has an account');
  });

  it('creates one workspace for a double submit or a retry with the same key', async () => {
    const { backend } = setup();
    const input = { business: 'Dusun Bambu', ...owner() };
    const [first, second] = await Promise.all([backend.register(input, 'same'), backend.register(input, 'same')]);
    expect(second.account.id).toBe(first.account.id);
    expect((await backend.register(input, 'same')).account.id).toBe(first.account.id);
    expect(await backend.workspaces()).toHaveLength(1);
  });

  it('signs in by email and password, and out again', async () => {
    const { backend } = setup();
    const { account } = await register(backend);
    await backend.signOut();
    expect(await backend.session()).toBeNull();
    await expect(backend.signIn('nobody@example.com', 'bambu2026')).rejects.toThrow('Email or password is wrong.');
    const session = await backend.signIn(' DUSUNBAMBU@example.com', 'bambu2026');
    expect(session.account.id).toBe(account.id);
    expect(session.member.lastSignInAt).not.toBeNull();
  });

  it('locks sign-in after five wrong passwords, then opens again', async () => {
    const { backend, clock } = setup();
    await register(backend);
    await backend.signOut();
    for (let i = 1; i < MAX_TRIES; i++) await expect(backend.signIn('dusunbambu@example.com', 'wrong1234')).rejects.toThrow(`${MAX_TRIES - i} ${MAX_TRIES - i === 1 ? 'try' : 'tries'} left`);
    await expect(backend.signIn('dusunbambu@example.com', 'wrong1234')).rejects.toThrow('locked for 15 minutes');
    await expect(backend.signIn('dusunbambu@example.com', 'bambu2026')).rejects.toThrow('Try again in 15 minutes');
    clock.now += LOCK_MS;
    await expect(backend.signIn('dusunbambu@example.com', 'bambu2026')).resolves.toBeTruthy();
  });

  it('says no account exists at this address when the browser holds none', async () => {
    const { backend } = setup();
    await expect(backend.signIn('rizky@example.com', 'bambu2026')).rejects.toThrow('No account exists at');
  });

  it('confirms a team member for a locked screen without changing the session', async () => {
    const { backend } = setup();
    const { account } = await register(backend);
    await register(backend, 'Other Venue');
    await backend.signOut();
    await backend.signIn('dusunbambu@example.com', 'bambu2026');
    const member = await backend.confirmMember(account.id, 'dusunbambu@example.com', 'bambu2026');
    expect(member.userId).toBe(`owner-${account.id}`);
    expect((await backend.session())?.account.id).toBe(account.id);
    // Another workspace's owner cannot unlock this one's screens.
    await expect(backend.confirmMember(account.id, 'othervenue@example.com', 'bambu2026')).rejects.toThrow('not on this workspace');
    // Wrong passwords count toward the same lock as sign-in.
    for (let i = 1; i < MAX_TRIES; i++) await expect(backend.confirmMember(account.id, 'dusunbambu@example.com', 'wrong1234')).rejects.toThrow('left');
    await expect(backend.confirmMember(account.id, 'dusunbambu@example.com', 'wrong1234')).rejects.toThrow('locked for 15 minutes');
    await expect(backend.signIn('dusunbambu@example.com', 'bambu2026')).rejects.toThrow('Try again');
    expect((await backend.signInLog()).map((event) => event.kind)).toContain('screen');
  });

  it('changes the password and keeps the old one out', async () => {
    const { backend } = setup();
    await register(backend);
    await expect(backend.changePassword('wrong', 'bambu2027')).rejects.toThrow('current password is wrong');
    await backend.changePassword('bambu2026', 'bambu2027');
    await backend.signOut();
    await expect(backend.signIn('dusunbambu@example.com', 'bambu2026')).rejects.toThrow('wrong');
    await expect(backend.signIn('dusunbambu@example.com', 'bambu2027')).resolves.toBeTruthy();
  });
});

describe('team access', () => {
  it('invites a person once, and they set a password with the code', async () => {
    const { backend } = setup();
    await register(backend);
    const person = { userId: 'staff-1', name: 'Sari', email: 'Sari@example.com' };
    const invite = await backend.invite(person, 'i1');
    expect(invite.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    // Pressing Invite again, with a new key, hands out the same waiting code.
    expect((await backend.invite(person, 'i2')).code).toBe(invite.code);
    expect((await backend.members()).map((m) => [m.name, m.status])).toEqual([['Rizky', 'active'], ['Sari', 'invited']]);
    await expect(backend.signIn('sari@example.com', 'whatever1')).rejects.toThrow('invite waiting');

    await backend.signOut();
    expect((await backend.inviteFor(invite.code.toLowerCase().replace('-', ' '))).member.name).toBe('Sari');
    const session = await backend.acceptInvite(invite.code, 'kopi2026', 'a1');
    expect(session.member).toMatchObject({ userId: 'staff-1', status: 'active' });
    expect((await backend.acceptInvite(invite.code, 'kopi2026', 'a1')).member.userId).toBe('staff-1');
    await expect(backend.acceptInvite(invite.code, 'kopi2026', 'a2')).rejects.toThrow('not valid');
  });

  it('expires codes, refuses an email someone else uses, and resets a password with a new code', async () => {
    const { backend, clock } = setup();
    await register(backend);
    const old = await backend.invite({ userId: 'staff-1', name: 'Sari', email: 'sari@example.com' }, 'i1');
    await expect(backend.invite({ userId: 'staff-2', name: 'Dewi', email: 'sari@example.com' }, 'i2')).rejects.toThrow('already signs in as Sari');
    clock.now += INVITE_MS;
    await expect(backend.inviteFor(old.code)).rejects.toThrow('expired');
    const fresh = await backend.invite({ userId: 'staff-1', name: 'Sari', email: 'sari@example.com' }, 'i3');
    expect(fresh.code).not.toBe(old.code);
    const owner = await backend.session();
    await backend.acceptInvite(fresh.code, 'kopi2026', 'a1');
    await backend.signIn(owner!.member.email, 'bambu2026');

    const reset = await backend.resetAccess('staff-1');
    expect(reset.code).not.toBe(fresh.code);
    await backend.signOut();
    await expect(backend.signIn('sari@example.com', 'kopi2026')).rejects.toThrow('invite waiting');
  });

  it('turns sign-in off and on, but never for yourself', async () => {
    const { backend } = setup();
    const { member } = await register(backend);
    const invite = await backend.invite({ userId: 'staff-1', name: 'Sari', email: 'sari@example.com' }, 'i1');
    await expect(backend.setAccess(member.userId, false)).rejects.toThrow('your own sign-in');
    await expect(backend.setAccess('staff-1', true)).resolves.toMatchObject({ status: 'invited' });
    await backend.signOut();
    await backend.acceptInvite(invite.code, 'kopi2026', 'a1');
    await backend.signOut();
    await backend.signIn(member.email, 'bambu2026');
    expect((await backend.setAccess('staff-1', false)).status).toBe('disabled');
    await backend.signOut();
    await expect(backend.signIn('sari@example.com', 'kopi2026')).rejects.toThrow('turned off');
  });

  it('gives a workspace from the quick access build its owner, once', async () => {
    const { backend, store } = setup();
    const account = { id: 'old', business: 'Studio Rupa', createdAt: 0, trialEndsAt: Date.UTC(2026, 9, 25) };
    store.setItem('vto:accounts', JSON.stringify({ old: { account } }));
    store.setItem('vto:session', 'old');
    expect(await backend.session()).toBeNull();
    expect(await backend.unclaimed()).toEqual([account]);
    const session = await backend.claim('old', owner(), 'c1');
    expect(session.account).toEqual(account);
    expect(await backend.unclaimed()).toEqual([]);
    await expect(backend.claim('old', owner('other@example.com'), 'c2')).rejects.toThrow('already has an owner');
  });
});

describe('locations and points', () => {
  it('keeps several points in several locations', async () => {
    const { backend } = setup();
    await register(backend, 'Studio Rupa');
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
    await register(backend, 'Studio Rupa');
    const mall = await backend.saveLocation({ name: 'Grand Indonesia', city: 'Jakarta', address: '' });
    await backend.savePoint({ locationId: mall.id, name: 'Kiosk 1', code: 'GRA-01', active: true });
    await expect(
      backend.savePoint({ locationId: mall.id, name: 'Kiosk 2', code: 'GRA-01', active: true }),
    ).rejects.toMatchObject({ field: 'code' });
  });

  it('edits in place and deletes a location with its points', async () => {
    const { backend } = setup();
    await register(backend, 'Studio Rupa');
    const mall = await backend.saveLocation({ name: 'Grand Indo', city: 'Jakarta', address: '' });
    await backend.saveLocation({ id: mall.id, name: 'Grand Indonesia', city: 'Jakarta', address: 'Jl. MH Thamrin 1' });
    await backend.savePoint({ locationId: mall.id, name: 'Kiosk 1', code: 'GRA-01', active: true });
    expect((await backend.sites()).locations[0].name).toBe('Grand Indonesia');

    await backend.deleteLocation(mall.id);
    expect(await backend.sites()).toEqual({ locations: [], points: [] });
  });

  it('holds the trial to its location and point limits', async () => {
    const { backend } = setup();
    await register(backend, 'Studio Rupa');
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
    await register(backend, 'Studio Rupa');
    await backend.saveLocation({ name: 'Grand Indonesia', city: 'Jakarta', address: '' });
    clock.now += 15 * DAY;
    await expect(backend.saveLocation({ name: 'Later', city: 'Jakarta', address: '' })).rejects.toThrow('trial has ended');
    expect((await backend.sites()).locations).toHaveLength(1);
  });

  it('keeps each account to its own data', async () => {
    const { backend } = setup();
    await register(backend, 'Studio Rupa');
    await backend.saveLocation({ name: 'Grand Indonesia', city: 'Jakarta', address: '' });
    await backend.signOut();
    await register(backend, 'Toko Batik');
    expect((await backend.sites()).locations).toEqual([]);
  });
});

describe('sign-in log', () => {
  it('records sign-ins, failures, locks, codes and access changes for the workspace only', async () => {
    const { backend, clock } = setup();
    await register(backend);
    const invite = await backend.invite({ userId: 'staff-1', name: 'Sari', email: 'sari@example.com' }, 'i1');
    await backend.invite({ userId: 'staff-1', name: 'Sari', email: 'sari@example.com' }, 'i2');
    await backend.signOut();
    await backend.acceptInvite(invite.code, 'kopi2026', 'a1');
    await backend.signOut();
    for (let i = 0; i < MAX_TRIES; i++) await backend.signIn('sari@example.com', 'wrong1234').catch(() => {});
    clock.now += LOCK_MS;
    await backend.signIn('dusunbambu@example.com', 'bambu2026');
    await backend.setAccess('staff-1', false);

    const log = await backend.signInLog();
    expect(log.map((event) => `${event.name}:${event.kind}${event.byName ? ` by ${event.byName}` : ''}`).reverse()).toEqual([
      'Rizky:register',
      'Sari:invite by Rizky',
      'Rizky:signout',
      'Sari:accepted',
      'Sari:signout',
      'Sari:failed',
      'Sari:failed',
      'Sari:failed',
      'Sari:failed',
      'Sari:locked',
      'Rizky:signin',
      'Sari:disabled by Rizky',
    ]);

    await backend.signOut();
    await register(backend, 'Toko Batik');
    expect((await backend.signInLog()).map((event) => event.kind)).toEqual(['register']);
  });

  it('names the browser and system of the device', () => {
    expect(deviceLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36')).toBe('Chrome on macOS');
    expect(deviceLabel('Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1')).toBe('Safari on iOS');
    expect(deviceLabel('')).toBe('Unknown device');
  });
});

