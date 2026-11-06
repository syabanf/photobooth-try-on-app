import { describe, expect, it } from 'vitest';
import type { FaceRecord, Ticket } from './model';
import { cleanName, knownNames, searchFaces } from './face-tags';

const face = (id: string, name: string, ticketId: string | null, createdAt: number): FaceRecord => ({ id, image: id, boothId: null, ticketId, name, createdAt });
const ticket = { id: 't1', number: 'A007', name: 'Keluarga Dina' } as Ticket;

const faces = [face('a', 'Dina', 't1', 1), face('b', '', 't1', 2), face('c', 'Raka Putra', null, 3)];

describe('face tags', () => {
  it('cleans a name to one short line', () => {
    expect(cleanName('  Dina \n  Ayu  ')).toBe('Dina Ayu');
    expect(cleanName('x'.repeat(60))).toHaveLength(40);
    expect(cleanName('   ')).toBe('');
  });

  it('finds faces by name or ticket number, newest first', () => {
    expect(searchFaces(faces, [ticket], 'a007', 'all').map((f) => f.id)).toEqual(['b', 'a']);
    expect(searchFaces(faces, [ticket], 'raka', 'all').map((f) => f.id)).toEqual(['c']);
    expect(searchFaces(faces, [ticket], 'dina a007', 'all').map((f) => f.id)).toEqual(['a']);
  });

  it('filters tagged and untagged faces', () => {
    expect(searchFaces(faces, [ticket], '', 'untagged').map((f) => f.id)).toEqual(['b']);
    expect(searchFaces(faces, [ticket], '', 'tagged').map((f) => f.id)).toEqual(['c', 'a']);
  });

  it('suggests the ticket name first, then earlier names without repeats', () => {
    expect(knownNames([...faces, face('d', 'dina', null, 0)], ticket)).toEqual(['Keluarga Dina', 'Raka Putra', 'Dina', 'dina']);
    expect(knownNames(faces, null)).toEqual(['Raka Putra', 'Dina']);
  });
});
