import type { ActivityEntry } from "./types.js";

export const ACTIVITY_PROGRESS_RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

function exactTimestamp(value: string): number {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new TypeError("activity compaction time must be UTC ISO-8601 with milliseconds");
  }
  return parsed.valueOf();
}

function compareEntries(left: ActivityEntry, right: ActivityEntry): number {
  return left.eventSequence - right.eventSequence ||
    (left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
}

function progressGroupKey(entry: ActivityEntry): string {
  return `${entry.channelId ?? "none"}\0${entry.workId ?? "none"}\0` +
    `${entry.actor.principalId}\0${entry.source.kind}\0` +
    `${entry.source.authoritySystem ?? "none"}\0${entry.source.authorityId ?? "none"}`;
}

function chronologicalBounds(entries: readonly ActivityEntry[]): {
  startedAt: string;
  endedAt: string;
} {
  const timestamps = entries.flatMap((entry) => [
    entry.interval.startedAt,
    entry.interval.endedAt,
  ]).sort();
  return { startedAt: timestamps[0]!, endedAt: timestamps.at(-1)! };
}

function compactProgressGroup(group: readonly ActivityEntry[]): ActivityEntry {
  const ordered = [...group].sort(compareEntries);
  const first = ordered[0]!;
  const latest = ordered.at(-1)!;
  const collapsedCount = ordered.reduce((count, entry) => count + entry.collapsedCount, 0);
  const bounds = chronologicalBounds(ordered);
  return Object.freeze({
    ...latest,
    key: `compacted:${latest.workId ?? "none"}:${first.interval.firstEventSequence}:${latest.interval.lastEventSequence}`,
    label: `${collapsedCount} progress update${collapsedCount === 1 ? "" : "s"}`,
    collapsedCount,
    compacted: true,
    actor: Object.freeze({ ...latest.actor }),
    source: Object.freeze({ ...latest.source }),
    interval: Object.freeze({
      firstEventSequence: first.interval.firstEventSequence,
      lastEventSequence: latest.interval.lastEventSequence,
      ...bounds,
    }),
  });
}

/**
 * Rebuilds a compact view without deleting or rewriting source events/observations.
 * Only progress older than the exact 30-day boundary is summarized; transitions,
 * artifacts, and terminal explanations remain byte-for-byte present.
 */
export function compactActivity(
  entries: readonly ActivityEntry[],
  asOf: string,
): readonly ActivityEntry[] {
  const cutoff = exactTimestamp(asOf) - ACTIVITY_PROGRESS_RETENTION_DAYS * DAY_MS;
  const retained: ActivityEntry[] = [];
  const oldProgress = new Map<string, ActivityEntry[]>();
  for (const entry of entries) {
    if (entry.category === "progress" && exactTimestamp(entry.interval.endedAt) < cutoff) {
      const key = progressGroupKey(entry);
      const group = oldProgress.get(key) ?? [];
      group.push(entry);
      oldProgress.set(key, group);
    } else {
      retained.push(entry);
    }
  }
  for (const group of oldProgress.values()) retained.push(compactProgressGroup(group));
  return Object.freeze(retained.sort(compareEntries));
}
