import { assertCoordinationId } from "../ids/index.js";

export const WORK_RESULT_IDEMPOTENCY_KEY_PREFIX = "work-result:" as const;

export const RESIDENT_PRESENCE_RESIDENTS = Object.freeze(["jerry", "forrest"] as const);

export const RESIDENT_PRESENCE_PROJECTIONS = Object.freeze([
  "conversation",
  "activity",
  "forensics",
] as const);

/** Authoritative idempotency key for one terminal Work result Message. */
export function workResultIdempotencyKey(workId: string): string {
  assertCoordinationId("work", workId);
  return `${WORK_RESULT_IDEMPOTENCY_KEY_PREFIX}${workId}`;
}
