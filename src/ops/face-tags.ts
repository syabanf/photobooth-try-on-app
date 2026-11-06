// Names on captured faces: who each person is, so staff find a regular or a party by name and the
// booth shows names under the faces. Every function leaves its input alone.

import type { FaceRecord, Ticket } from './model';

export type FaceFilter = 'all' | 'tagged' | 'untagged';

export const NAME_LIMIT = 40;

/** One line, single spaces, at most 40 characters. An empty result removes the name. */
export function cleanName(name: string): string {
  return name.replace(/\s+/g, ' ').trim().slice(0, NAME_LIMIT).trim();
}

/** Faces matching a name or ticket number, newest first. */
export function searchFaces(faces: readonly FaceRecord[], tickets: readonly Ticket[], query: string, filter: FaceFilter): FaceRecord[] {
  const numbers = new Map(tickets.map((ticket) => [ticket.id, ticket.number.toLowerCase()]));
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return faces
    .filter((face) => (filter === 'all' ? true : filter === 'tagged' ? !!face.name : !face.name))
    .filter((face) => {
      const haystack = `${face.name ?? ''} ${numbers.get(face.ticketId ?? '') ?? ''}`.toLowerCase();
      return words.every((word) => haystack.includes(word));
    })
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** Names to offer while tagging: the ticket's own name first, then names used before, newest first. */
export function knownNames(faces: readonly FaceRecord[], ticket: Ticket | null, limit = 20): string[] {
  const names = [ticket?.name ?? '', ...[...faces].sort((a, b) => b.createdAt - a.createdAt).map((face) => face.name ?? '')];
  return [...new Set(names.map(cleanName).filter(Boolean))].slice(0, limit);
}
