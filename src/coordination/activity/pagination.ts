import { assertCoordinationId } from "../ids/index.js";

import type {
  ActivityBoundary,
  ActivityEntry,
  ActivityPage,
  ActivityScope,
} from "./types.js";

export const DEFAULT_ACTIVITY_PAGE_LIMIT = 50;
export const MAXIMUM_ACTIVITY_PAGE_LIMIT = 100;

export function normalizeActivityPageLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_ACTIVITY_PAGE_LIMIT;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAXIMUM_ACTIVITY_PAGE_LIMIT) {
    throw new TypeError("activity page limit must be an integer from 1 through 100");
  }
  return value;
}

function compareBoundary(left: ActivityBoundary, right: ActivityBoundary): number {
  return left.eventSequence - right.eventSequence ||
    (left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
}

function assertScope(scope: ActivityScope): void {
  try {
    if (scope.kind === "channel") assertCoordinationId("channel", scope.channelId);
    else if (scope.kind !== "all") throw new Error("unknown scope");
  } catch {
    throw new TypeError("activity page scope is invalid");
  }
}

function boundaryFor(entry: ActivityEntry): ActivityBoundary {
  return Object.freeze({ eventSequence: entry.eventSequence, key: entry.key });
}

function assertBoundary(boundary: ActivityBoundary): void {
  if (!Number.isSafeInteger(boundary.eventSequence) || boundary.eventSequence < 1 ||
    typeof boundary.key !== "string" || !/^[A-Za-z0-9:_-]{1,256}$/.test(boundary.key)) {
    throw new TypeError("activity page boundary is invalid");
  }
}

export function pageActivity(
  entries: readonly ActivityEntry[],
  input: { after: ActivityBoundary | null; limit: number; scope: ActivityScope },
): ActivityPage {
  const limit = normalizeActivityPageLimit(input.limit);
  assertScope(input.scope);
  if (input.after !== null) assertBoundary(input.after);
  const scope = input.scope;
  const scoped = scope.kind === "all"
    ? entries
    : entries.filter((entry) => entry.channelId === scope.channelId);
  const ordered = [...scoped].sort((left, right) =>
    compareBoundary(boundaryFor(left), boundaryFor(right))
  );
  const eligible = input.after === null
    ? ordered
    : ordered.filter((entry) => compareBoundary(boundaryFor(entry), input.after!) > 0);
  const page = eligible.slice(0, limit);
  const nextBoundary = eligible.length > page.length && page.at(-1)
    ? boundaryFor(page.at(-1)!)
    : null;
  return Object.freeze({
    entries: Object.freeze(page),
    nextBoundary,
  });
}
