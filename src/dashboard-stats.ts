// The dashboard's numbers, computed from captures and master data. Pure, so it is tested alone.

import type { Location, Point, Sites } from './account/model';
import type { ShotKind } from './gallery';

export interface CaptureRecord {
  kind: ShotKind;
  createdAt: number;
  pointId?: string | null;
}

export interface DayCount {
  /** Local midnight that starts the day. */
  day: number;
  count: number;
}

export interface Ranked<T> {
  item: T;
  count: number;
}

export interface Summary {
  total: number;
  /** Captures in the period of the same length just before this one. */
  previous: number;
  snapshots: number;
  sheets: number;
  days: DayCount[];
  points: Ranked<Point>[];
  locations: Ranked<Location>[];
  /** Active points with no capture in the period. */
  idlePoints: Point[];
}

function startOfDay(time: number): number {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** One entry per local day, oldest first, ending today. Follows the calendar across DST changes. */
export function dayStarts(days: number, now: number): number[] {
  const today = new Date(startOfDay(now));
  return Array.from({ length: days }, (_, i) => {
    const date = new Date(today);
    date.setDate(today.getDate() - (days - 1 - i));
    return date.getTime();
  });
}

function rank<T extends { id: string }>(items: T[], countOf: (item: T) => number): Ranked<T>[] {
  return items.map((item) => ({ item, count: countOf(item) })).sort((a, b) => b.count - a.count);
}

export function summarize(captures: readonly CaptureRecord[], sites: Sites, days: number, now: number): Summary {
  const starts = dayStarts(days, now);
  const from = starts[0];
  const previousFrom = dayStarts(days * 2, now)[0];
  const inPeriod = captures.filter((capture) => capture.createdAt >= from && capture.createdAt <= now);

  const perDay = new Map(starts.map((start) => [start, 0]));
  const perPoint = new Map<string, number>();
  for (const capture of inPeriod) {
    const day = startOfDay(capture.createdAt);
    perDay.set(day, (perDay.get(day) ?? 0) + 1);
    if (capture.pointId) perPoint.set(capture.pointId, (perPoint.get(capture.pointId) ?? 0) + 1);
  }
  const pointCount = (point: Point) => perPoint.get(point.id) ?? 0;

  return {
    total: inPeriod.length,
    previous: captures.filter((capture) => capture.createdAt >= previousFrom && capture.createdAt < from).length,
    snapshots: inPeriod.filter((capture) => capture.kind === 'snapshot').length,
    sheets: inPeriod.filter((capture) => capture.kind === 'photobooth').length,
    days: starts.map((day) => ({ day, count: perDay.get(day)! })),
    points: rank(sites.points, pointCount),
    locations: rank(sites.locations, (location) =>
      sites.points.filter((point) => point.locationId === location.id).reduce((sum, point) => sum + pointCount(point), 0),
    ),
    idlePoints: sites.points.filter((point) => point.active && pointCount(point) === 0),
  };
}

/** Signed whole percent against the previous period, or null when there is nothing to compare with. */
export function percentChange(current: number, previous: number): number | null {
  return previous === 0 ? null : Math.round(((current - previous) / previous) * 100);
}
