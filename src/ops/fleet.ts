// Staged OTA rollout and photo retention: two jobs the cloud runs across the whole fleet.

import type { BoothSession, Release } from './model';

/** A stable 0–99 bucket per booth and release, so raising the percentage only ever adds booths. */
export function bucket(boothId: string, releaseId: string): number {
  // FNV-1a, 32-bit.
  let hash = 0x811c9dc5;
  for (const char of `${releaseId}:${boothId}`) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % 100;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff) return Math.sign(diff);
  }
  return 0;
}

/**
 * The version a booth should run: the newest release that is not rolled back and whose rollout
 * reaches the booth's bucket. Rolling a release back sends its booths to the next one down.
 */
export function targetVersion(releases: readonly Release[], boothId: string, baseVersion: string): string {
  const live = releases
    .filter((release) => release.status !== 'rolled-back')
    .sort((a, b) => compareVersions(b.version, a.version));
  for (const release of live) {
    if (bucket(boothId, release.id) < release.percent) return release.version;
  }
  return baseVersion;
}

export const DAY_MS = 86_400_000;

/** Sessions whose files are past the retention window and not purged yet. */
export function sessionsToPurge(sessions: readonly BoothSession[], retentionDays: number, now: number): BoothSession[] {
  if (retentionDays <= 0) return [];
  const cutoff = now - retentionDays * DAY_MS;
  return sessions.filter((session) => !session.purgedAt && (session.endedAt ?? session.startedAt) < cutoff);
}
