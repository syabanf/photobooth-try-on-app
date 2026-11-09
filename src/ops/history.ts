// The activity history: every change the workspace logged, sorted into areas, filtered by date,
// person, area, branch and words, and grouped by day for reading.

import type { ActivityEntry } from './model';
import { zonedTime } from './time';

export type Area = 'sales' | 'payments' | 'shifts' | 'queue' | 'booths' | 'faces' | 'access' | 'devices' | 'content' | 'settings' | 'fleet' | 'other';

export const AREA_LABELS: Record<Area, string> = {
  sales: 'Sales',
  payments: 'Payments',
  shifts: 'Shifts',
  queue: 'Queue and gate',
  booths: 'Booth sessions',
  faces: 'Faces',
  access: 'Team and sign-in',
  devices: 'Devices and alerts',
  content: 'Frames, branding and ads',
  settings: 'Prices and settings',
  fleet: 'Fleet',
  other: 'Other',
};

/** The first part of an entry's kind ("order" in "order.refund") names its area. */
const PREFIXES: Record<string, Area> = {
  order: 'sales',
  voucher: 'sales',
  receipt: 'sales',
  product: 'sales',
  payment: 'payments',
  payments: 'payments',
  shift: 'shifts',
  queue: 'queue',
  session: 'booths',
  print: 'booths',
  face: 'faces',
  retention: 'faces',
  auth: 'access',
  staff: 'access',
  role: 'access',
  booth: 'devices',
  camera: 'devices',
  printer: 'devices',
  alert: 'devices',
  rule: 'devices',
  frame: 'content',
  branding: 'content',
  ad: 'content',
  ads: 'content',
  preset: 'content',
  event: 'content',
  settings: 'settings',
  category: 'settings',
  fleet: 'fleet',
  release: 'fleet',
  support: 'fleet',
};

export function areaOf(kind: string): Area {
  // "preset.price" is a price; the other preset kinds edit AI templates.
  if (kind === 'preset.price') return 'settings';
  return PREFIXES[kind.split('.')[0]] ?? 'other';
}

export interface HistoryFilter {
  /** "YYYY-MM-DD", inclusive, in `timeZone`. Empty means open. */
  from: string;
  to: string;
  /** A staff id, "system" for entries nobody made, or empty for everyone. */
  staffId: string;
  area: Area | '';
  branchId: string;
  query: string;
  timeZone: string;
}

export function filterHistory(entries: readonly ActivityEntry[], filter: HistoryFilter): ActivityEntry[] {
  const words = filter.query.toLowerCase().split(/\s+/).filter(Boolean);
  return entries.filter((entry) => {
    const date = zonedTime(entry.at, filter.timeZone).date;
    if (filter.from && date < filter.from) return false;
    if (filter.to && date > filter.to) return false;
    if (filter.staffId && (filter.staffId === 'system' ? entry.staffId !== null : entry.staffId !== filter.staffId)) return false;
    if (filter.area && areaOf(entry.kind) !== filter.area) return false;
    if (filter.branchId && entry.branchId !== filter.branchId) return false;
    const text = entry.message.toLowerCase();
    return words.every((word) => text.includes(word));
  });
}

/** Entries by local day, newest day first, keeping the order inside each day. */
export function byDay(entries: readonly ActivityEntry[], timeZone: string): { date: string; entries: ActivityEntry[] }[] {
  const days = new Map<string, ActivityEntry[]>();
  for (const entry of [...entries].sort((a, b) => b.at - a.at)) {
    const date = zonedTime(entry.at, timeZone).date;
    days.set(date, [...(days.get(date) ?? []), entry]);
  }
  return [...days].map(([date, list]) => ({ date, entries: list }));
}

/** How many entries each area has, for the counts on the area pills. */
export function countByArea(entries: readonly ActivityEntry[]): Partial<Record<Area, number>> {
  const counts: Partial<Record<Area, number>> = {};
  for (const entry of entries) {
    const area = areaOf(entry.kind);
    counts[area] = (counts[area] ?? 0) + 1;
  }
  return counts;
}
