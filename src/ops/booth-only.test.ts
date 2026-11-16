import { describe, expect, it } from 'vitest';
// @ts-expect-error: a plain Node module shared with scripts/serve.mjs, with no type declarations.
import { fromBoothComputer } from '../../scripts/booth-only.mjs';

const request = (remoteAddress: string, realIp?: string) => ({ socket: { remoteAddress }, headers: realIp === undefined ? {} : { 'x-real-ip': realIp } });

describe('fromBoothComputer', () => {
  it('accepts the booth computer, directly or through nginx', () => {
    expect(fromBoothComputer(request('127.0.0.1'))).toBe(true);
    expect(fromBoothComputer(request('::ffff:127.0.0.1'))).toBe(true);
    expect(fromBoothComputer(request('127.0.0.1', '127.0.0.1'))).toBe(true);
    expect(fromBoothComputer(request('::1', '::1'))).toBe(true);
  });

  it('refuses another device, directly or through nginx', () => {
    expect(fromBoothComputer(request('192.168.1.20'))).toBe(false);
    expect(fromBoothComputer(request('127.0.0.1', '192.168.1.20'))).toBe(false);
    // A caller who reaches Node directly cannot vouch for itself with the header.
    expect(fromBoothComputer(request('192.168.1.20', '127.0.0.1'))).toBe(false);
  });
});
