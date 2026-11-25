import { describe, expect, it } from 'vitest';
import { createLocalBackend, deviceLabel, INVITE_MS, LOCK_MS, MAX_TRIES, memoryStore } from './backend';

const DAY = 86_400_000;

function setup(start = Date.UTC(2026, 8, 25)) {
  const clock = { now: start };
  const store = memoryStore();
  const backend = createLocalBackend(store, () => clock.now);
  return { backend, store, clock };
}

const owner = (email = 'rizky@example.com') => ({ name: 'Rizky', email, password: 'bambu2026' });

async function register(backend: ReturnType<typeof createLocalBackend>, email = 'dusunbambu@example.com') {
  return backend.setupOwner(owner(email), crypto.randomUUID());
}

describe('owner setup and sign in', () => {
  it('sets up Dusun Bambu and its owner on a fresh device, signed in', async () => {
    const { backend } = setup();
    expect(await backend.needsOwner()).toBe(true);
    expect(await backend.business()).toBeNull();
    const { account, member } = await backend.setupOwner(owner(' Rizky@Example.com '), 'k1');
    expect(account.business).toBe('Dusun Bambu');
    expect(member).toMatchObject({ userId: `owner-${account.id}`, email: 'rizky@example.com', status: 'active' });
    expect((await backend.session())?.account).toEqual(account);
    expect(await backend.needsOwner()).toBe(false);
    expect(await backend.business()).toEqual(account);
  });

  it('refuses a weak password, a bad email, and a second owner', async () => {
    const { backend } = setup();
    await expect(backend.setupOwner({ ...owner(), password: 'short1' }, 'a')).rejects.toThrow('minimal 8 karakter');
    await expect(backend.setupOwner({ ...owner(), password: 'onlyletters' }, 'b')).rejects.toThrow('berisi huruf dan angka');
    await expect(backend.setupOwner(owner('nope'), 'c')).rejects.toThrow('nama@contoh.com');
    await register(backend, 'rizky@example.com');
    // Everyone after the owner joins by invite.
    await expect(backend.setupOwner(owner('other@example.com'), 'd')).rejects.toThrow('sudah punya pemilik');
  });

  it('sets up one owner for a double submit or a retry with the same key', async () => {
    const { backend } = setup();
    const [first, second] = await Promise.all([backend.setupOwner(owner(), 'same'), backend.setupOwner(owner(), 'same')]);
    expect(second.account.id).toBe(first.account.id);
    expect((await backend.setupOwner(owner(), 'same')).account.id).toBe(first.account.id);
  });

  it('signs in by email and password, and out again', async () => {
    const { backend } = setup();
    const { account } = await register(backend);
    await backend.signOut();
    expect(await backend.session()).toBeNull();
    await expect(backend.signIn('nobody@example.com', 'bambu2026')).rejects.toThrow('Email atau kata sandi salah.');
    const session = await backend.signIn(' DUSUNBAMBU@example.com', 'bambu2026');
    expect(session.account.id).toBe(account.id);
    expect(session.member.lastSignInAt).not.toBeNull();
  });

  it('locks sign-in after five wrong passwords, then opens again', async () => {
    const { backend, clock } = setup();
    await register(backend);
    await backend.signOut();
    for (let i = 1; i < MAX_TRIES; i++) await expect(backend.signIn('dusunbambu@example.com', 'wrong1234')).rejects.toThrow(`Sisa ${MAX_TRIES - i} kali percobaan`);
    await expect(backend.signIn('dusunbambu@example.com', 'wrong1234')).rejects.toThrow('dikunci selama 15 menit');
    await expect(backend.signIn('dusunbambu@example.com', 'bambu2026')).rejects.toThrow('Coba lagi dalam 15 menit');
    clock.now += LOCK_MS;
    await expect(backend.signIn('dusunbambu@example.com', 'bambu2026')).resolves.toBeTruthy();
  });

  it('says no account exists at this address when the browser holds none', async () => {
    const { backend } = setup();
    await expect(backend.signIn('rizky@example.com', 'bambu2026')).rejects.toThrow('Belum ada akun di');
  });

  it('confirms a team member for a locked screen without changing the session', async () => {
    const { backend } = setup();
    const { account } = await register(backend);
    await backend.signOut();
    await backend.signIn('dusunbambu@example.com', 'bambu2026');
    const member = await backend.confirmMember(account.id, 'dusunbambu@example.com', 'bambu2026');
    expect(member.userId).toBe(`owner-${account.id}`);
    expect((await backend.session())?.account.id).toBe(account.id);
    // Wrong passwords count toward the same lock as sign-in.
    for (let i = 1; i < MAX_TRIES; i++) await expect(backend.confirmMember(account.id, 'dusunbambu@example.com', 'wrong1234')).rejects.toThrow('Sisa');
    await expect(backend.confirmMember(account.id, 'dusunbambu@example.com', 'wrong1234')).rejects.toThrow('dikunci selama 15 menit');
    await expect(backend.signIn('dusunbambu@example.com', 'bambu2026')).rejects.toThrow('Coba lagi');
    expect((await backend.signInLog()).map((event) => event.kind)).toContain('screen');
  });

  it('changes the password and keeps the old one out', async () => {
    const { backend } = setup();
    await register(backend);
    await expect(backend.changePassword('wrong', 'bambu2027')).rejects.toThrow('Kata sandi sekarang salah');
    await backend.changePassword('bambu2026', 'bambu2027');
    await backend.signOut();
    await expect(backend.signIn('dusunbambu@example.com', 'bambu2026')).rejects.toThrow('salah');
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
    await expect(backend.signIn('sari@example.com', 'whatever1')).rejects.toThrow('undangan yang belum dipakai');

    await backend.signOut();
    expect((await backend.inviteFor(invite.code.toLowerCase().replace('-', ' '))).member.name).toBe('Sari');
    const session = await backend.acceptInvite(invite.code, 'kopi2026', 'a1');
    expect(session.member).toMatchObject({ userId: 'staff-1', status: 'active' });
    expect((await backend.acceptInvite(invite.code, 'kopi2026', 'a1')).member.userId).toBe('staff-1');
    await expect(backend.acceptInvite(invite.code, 'kopi2026', 'a2')).rejects.toThrow('tidak valid');
  });

  it('expires codes, refuses an email someone else uses, and resets a password with a new code', async () => {
    const { backend, clock } = setup();
    await register(backend);
    const old = await backend.invite({ userId: 'staff-1', name: 'Sari', email: 'sari@example.com' }, 'i1');
    await expect(backend.invite({ userId: 'staff-2', name: 'Dewi', email: 'sari@example.com' }, 'i2')).rejects.toThrow('sudah dipakai oleh Sari');
    clock.now += INVITE_MS;
    await expect(backend.inviteFor(old.code)).rejects.toThrow('kedaluwarsa');
    const fresh = await backend.invite({ userId: 'staff-1', name: 'Sari', email: 'sari@example.com' }, 'i3');
    expect(fresh.code).not.toBe(old.code);
    const owner = await backend.session();
    await backend.acceptInvite(fresh.code, 'kopi2026', 'a1');
    await backend.signIn(owner!.member.email, 'bambu2026');

    const reset = await backend.resetAccess('staff-1');
    expect(reset.code).not.toBe(fresh.code);
    await backend.signOut();
    await expect(backend.signIn('sari@example.com', 'kopi2026')).rejects.toThrow('undangan yang belum dipakai');
  });

  it('turns sign-in off and on, but never for yourself', async () => {
    const { backend } = setup();
    const { member } = await register(backend);
    const invite = await backend.invite({ userId: 'staff-1', name: 'Sari', email: 'sari@example.com' }, 'i1');
    await expect(backend.setAccess(member.userId, false)).rejects.toThrow('akses masuk Anda sendiri');
    await expect(backend.setAccess('staff-1', true)).resolves.toMatchObject({ status: 'invited' });
    await backend.signOut();
    await backend.acceptInvite(invite.code, 'kopi2026', 'a1');
    await backend.signOut();
    await backend.signIn(member.email, 'bambu2026');
    expect((await backend.setAccess('staff-1', false)).status).toBe('disabled');
    await backend.signOut();
    await expect(backend.signIn('sari@example.com', 'kopi2026')).rejects.toThrow('dimatikan');
  });

  it('gives records kept from before sign-in their owner, keeping them', async () => {
    const { backend, store } = setup();
    const account = { id: 'old', business: 'Dusun Bambu', createdAt: 0 };
    store.setItem('vto:accounts', JSON.stringify({ old: { account } }));
    store.setItem('vto:session', 'old');
    expect(await backend.session()).toBeNull();
    expect(await backend.needsOwner()).toBe(true);
    const session = await backend.setupOwner(owner(), 'c1');
    expect(session.account).toEqual(account);
    expect(await backend.needsOwner()).toBe(false);
  });
});

describe('locations and points', () => {
  it('keeps several points in several locations', async () => {
    const { backend } = setup();
    await register(backend);
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
    await register(backend);
    const mall = await backend.saveLocation({ name: 'Grand Indonesia', city: 'Jakarta', address: '' });
    await backend.savePoint({ locationId: mall.id, name: 'Kiosk 1', code: 'GRA-01', active: true });
    await expect(
      backend.savePoint({ locationId: mall.id, name: 'Kiosk 2', code: 'GRA-01', active: true }),
    ).rejects.toMatchObject({ field: 'code' });
  });

  it('edits in place and deletes a location with its points', async () => {
    const { backend } = setup();
    await register(backend);
    const mall = await backend.saveLocation({ name: 'Grand Indo', city: 'Jakarta', address: '' });
    await backend.saveLocation({ id: mall.id, name: 'Grand Indonesia', city: 'Jakarta', address: 'Jl. MH Thamrin 1' });
    await backend.savePoint({ locationId: mall.id, name: 'Kiosk 1', code: 'GRA-01', active: true });
    expect((await backend.sites()).locations[0].name).toBe('Grand Indonesia');

    await backend.deleteLocation(mall.id);
    expect(await backend.sites()).toEqual({ locations: [], points: [] });
  });

  it('takes as many locations and booths as the venue has, a year on', async () => {
    const { backend, clock } = setup();
    await register(backend);
    clock.now += 365 * DAY;
    const ids = [];
    for (let i = 0; i < 4; i++) ids.push((await backend.saveLocation({ name: `Area ${i}`, city: 'Bandung Barat', address: '' })).id);
    for (let i = 0; i < 12; i++) await backend.savePoint({ locationId: ids[i % ids.length], name: `Booth ${i}`, code: `B-${i}`, active: true });
    const sites = await backend.sites();
    expect(sites.locations).toHaveLength(4);
    expect(sites.points).toHaveLength(12);
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
  });

  it('names the browser and system of the device', () => {
    expect(deviceLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36')).toBe('Chrome di macOS');
    expect(deviceLabel('Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1')).toBe('Safari di iOS');
    expect(deviceLabel('')).toBe('Perangkat tidak dikenal');
  });
});

