import { describe, expect, it } from 'vitest';
import { uuid } from '../uuid';
import { pbkdf2Sha256 } from './pbkdf2';

const hex = (bytes: Uint8Array) => [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
const text = (value: string) => new TextEncoder().encode(value);

async function webCrypto(password: Uint8Array, salt: Uint8Array, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', password as BufferSource, 'PBKDF2', false, ['deriveBits']);
  return hex(new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations }, key, 256)));
}

describe('pbkdf2Sha256', () => {
  it('matches the RFC 7914 test vector', () => {
    expect(hex(pbkdf2Sha256(text('passwd'), text('salt'), 1))).toBe('55ac046e56e3089fec1691c22544b605f94185216dde0465e68b9d57c20dacbc');
  });

  it('gives the same bytes as WebCrypto, so hashes from either side check out', async () => {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    for (const password of ['kiosktest123', 'Bambu-2026 rahasia', 'x'.repeat(80), '']) {
      expect(hex(pbkdf2Sha256(text(password), salt, 1000))).toBe(await webCrypto(text(password), salt, 1000));
    }
  });
});

describe('uuid', () => {
  it('is a v4 UUID without crypto.randomUUID', () => {
    const original = crypto.randomUUID;
    Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true });
    try {
      expect(uuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    } finally {
      Object.defineProperty(crypto, 'randomUUID', { value: original, configurable: true });
    }
  });
});
