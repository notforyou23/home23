'use strict';

// HOME23 188 (H23-013) — An accepted durable operation that no worker admits
// must not stay 'queued' until its hours-long execution deadline while
// coordinator heartbeats keep its updatedAt moving. The coordinator fails it
// as admission_stalled at acceptedAt + this budget; the resident renders the
// same deadline from this module, so both sides name one instant.
const MINUTE_MS = 60 * 1000;

// Remote COSMO types are admitted in seconds when the worker is present
// (measured query queued->running max 31 s), so their budget bounds only a
// missing or unreachable worker. Interactive brain_query gets 10 minutes.
// Local source types can legitimately wait on the 15 min source-lock budget
// twice (pin, then open), so theirs is only a backstop above that.
const DEFAULT_ADMISSION_DEADLINES_MS = Object.freeze({
  query: 10 * MINUTE_MS,
  pgs: 20 * MINUTE_MS,
  research_compile: 10 * MINUTE_MS,
  research_intelligence: 10 * MINUTE_MS,
  research_launch: 10 * MINUTE_MS,
  research_continue: 10 * MINUTE_MS,
  research_stop: 10 * MINUTE_MS,
  research_watch: 10 * MINUTE_MS,
  search: 35 * MINUTE_MS,
  graph: 35 * MINUTE_MS,
  status: 35 * MINUTE_MS,
  graph_export: 35 * MINUTE_MS,
  synthesis: 35 * MINUTE_MS,
  ad_hoc_export: 35 * MINUTE_MS,
});

// Returns epoch milliseconds, or null when the record carries no usable
// acceptance time or its type has no admission budget.
function admissionDeadlineAt(record, deadlineMs = DEFAULT_ADMISSION_DEADLINES_MS[record?.operationType]) {
  const acceptedAt = typeof record?.acceptedAt === 'string' ? Date.parse(record.acceptedAt) : NaN;
  if (!Number.isFinite(acceptedAt) || !Number.isFinite(deadlineMs) || deadlineMs <= 0) return null;
  return acceptedAt + deadlineMs;
}

module.exports = {
  DEFAULT_ADMISSION_DEADLINES_MS,
  admissionDeadlineAt,
};
