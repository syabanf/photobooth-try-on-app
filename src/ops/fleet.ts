// Photo retention: which sessions' files are past the window and due for deletion.

import type { BoothSession } from './model';

export const DAY_MS = 86_400_000;

/** Sessions whose files are past the retention window and not purged yet. */
export function sessionsToPurge(sessions: readonly BoothSession[], retentionDays: number, now: number): BoothSession[] {
  if (retentionDays <= 0) return [];
  const cutoff = now - retentionDays * DAY_MS;
  return sessions.filter((session) => !session.purgedAt && (session.endedAt ?? session.startedAt) < cutoff);
}
