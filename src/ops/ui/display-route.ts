// Which display screen a link opens, and the channel the till uses to talk to the customer screen.
// Kept apart from the screens themselves, so the entry and the staff app load neither screen.

import type { Ops } from '../ops';

export type DisplayRoute = { kind: 'customer' | 'queue' } | { kind: 'kiosk'; boothId: string | null } | { kind: 'gallery' | 'event' | 'checkin'; id: string };

export function displayRoute(hash: string): DisplayRoute | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const display = params.get('display');
  if (display === 'customer' || display === 'queue') return { kind: display };
  if (display === 'kiosk') return { kind: 'kiosk', boothId: params.get('booth') };
  for (const [key, kind] of [['g', 'gallery'], ['event', 'event'], ['checkin', 'checkin']] as const) {
    const id = params.get(key);
    if (id) return { kind, id };
  }
  return null;
}

export function displayChannel(ops: Ops): BroadcastChannel | null {
  try {
    return new BroadcastChannel(`${ops.store.key}:display`);
  } catch {
    return null;
  }
}
