import { describe, expect, it } from 'vitest';
// @ts-expect-error: a plain Node module shared with scripts/serve.mjs, with no type declarations.
import { clientAddress, fromBoothComputer, sameSite } from '../../scripts/booth-only.mjs';

const request = (remoteAddress: string, headers: Record<string, string> = {}) => ({ socket: { remoteAddress }, headers: { host: '127.0.0.1:4173', ...headers } });

describe('fromBoothComputer', () => {
  it('accepts the booth computer, directly or through nginx', () => {
    expect(fromBoothComputer(request('127.0.0.1'))).toBe(true);
    expect(fromBoothComputer(request('::ffff:127.0.0.1', { host: 'localhost:5173' }))).toBe(true);
    expect(fromBoothComputer(request('127.0.0.1', { 'x-real-ip': '127.0.0.1' }))).toBe(true);
    expect(fromBoothComputer(request('::1', { 'x-real-ip': '::1', host: '[::1]' }))).toBe(true);
  });

  it('refuses another device, directly or through nginx', () => {
    expect(fromBoothComputer(request('192.168.1.20'))).toBe(false);
    expect(fromBoothComputer(request('127.0.0.1', { 'x-real-ip': '192.168.1.20' }))).toBe(false);
    // A caller who reaches Node directly cannot vouch for itself with the header.
    expect(fromBoothComputer(request('192.168.1.20', { 'x-real-ip': '127.0.0.1' }))).toBe(false);
  });

  it('refuses other sites open in the booth computer\'s browser', () => {
    // A hostile domain pointed at 127.0.0.1 (DNS rebinding) arrives with its own name as Host.
    expect(fromBoothComputer(request('127.0.0.1', { host: 'evil.example:4173', 'sec-fetch-site': 'same-origin' }))).toBe(false);
    expect(fromBoothComputer(request('127.0.0.1', { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' }))).toBe(false);
    expect(fromBoothComputer(request('127.0.0.1', { 'sec-fetch-site': 'same-origin', origin: 'http://127.0.0.1:4173' }))).toBe(true);
  });
});

describe('clientAddress', () => {
  it('trusts X-Real-IP only from nginx on this computer', () => {
    expect(clientAddress(request('127.0.0.1', { 'x-real-ip': '192.168.1.20' }))).toBe('192.168.1.20');
    expect(clientAddress(request('192.168.1.20', { 'x-real-ip': '192.168.1.99' }))).toBe('192.168.1.20');
    expect(clientAddress(request('192.168.1.20'))).toBe('192.168.1.20');
  });
});

describe('sameSite', () => {
  it('passes the app\'s own pages and apps without a browser', () => {
    expect(sameSite(request('192.168.1.20', { host: '192.168.1.5:4173', 'sec-fetch-site': 'same-origin', origin: 'http://192.168.1.5:4173' }))).toBe(true);
    expect(sameSite(request('192.168.1.40'))).toBe(true);
  });

  it('refuses another site\'s page', () => {
    expect(sameSite(request('192.168.1.20', { 'sec-fetch-site': 'cross-site' }))).toBe(false);
    expect(sameSite(request('192.168.1.20', { 'sec-fetch-site': 'same-site' }))).toBe(false);
    // An older browser without Sec-Fetch headers still sends Origin on a POST.
    expect(sameSite(request('192.168.1.20', { origin: 'http://evil.example' }))).toBe(false);
  });
});
