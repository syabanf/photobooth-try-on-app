// Secrets kept as PBKDF2 hashes: account passwords and staff PINs. Neither is ever stored or
// compared as typed.

import { pbkdf2Sha256 } from './pbkdf2';

const ITERATIONS = 120_000;

const toHex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (hex: string) => new Uint8Array((hex.match(/../g) ?? []).map((pair) => parseInt(pair, 16)));

async function derive(secret: string, salt: Uint8Array): Promise<string> {
  // Plain HTTP on the booth network has no crypto.subtle; the fallback gives the same hash.
  if (!crypto.subtle) return toHex(pbkdf2Sha256(new TextEncoder().encode(secret), salt, ITERATIONS));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations: ITERATIONS }, key, 256);
  return toHex(new Uint8Array(bits));
}

export async function hashSecret(secret: string): Promise<{ hash: string; salt: string }> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { hash: await derive(secret, salt), salt: toHex(salt) };
}

export async function checkSecret(secret: string, hash: string, salt: string): Promise<boolean> {
  if (!hash) return false;
  return (await derive(secret, fromHex(salt))) === hash;
}

export const PASSWORD_RULES = [
  { label: 'At least 8 characters', test: (password: string) => password.length >= 8 },
  { label: 'A letter and a number', test: (password: string) => /[a-z]/i.test(password) && /\d/.test(password) },
] as const;

/** The first rule the password breaks, or null when it passes. */
export function passwordProblem(password: string): string | null {
  return PASSWORD_RULES.find((rule) => !rule.test(password))?.label ?? null;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export const validEmail = (email: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
