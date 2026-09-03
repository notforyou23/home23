import { WORK_RESULT_IDEMPOTENCY_PREFIX } from './constants.js';
import type { ContinuityPresentation, ContinuityWorkRecord } from './types.js';

/**
 * Local adapter view of fields that already exist on Lane 3 Work / result
 * contracts. Extra office fields stay here until Lane 3 adds them.
 *
 * Current WorkRecord (src/coordination/work/types.ts): id, channelId,
 * originMessageId, state, currentAttemptId, nextFencingToken, kind.
 * Current result delivery: kind "result", idempotencyKey `work-result:${workId}`.
 * Missing from the shared pack (requested in the lane handoff): officeId,
 * presentation "waiting for headquarters", Attempt.officeId, contextRevision,
 * office epoch writer distinct from capability AuthorityEpoch.
 */
export interface CurrentWorkContractShape {
  id: string;
  channelId: string;
  originMessageId: string;
  state: ContinuityWorkRecord['state'];
  currentAttemptId: string | null;
  nextFencingToken: number;
  kind: ContinuityWorkRecord['kind'];
}

export interface ContinuityContractMapping {
  work: CurrentWorkContractShape;
  presentation: ContinuityPresentation;
  resultIdempotencyKey: string;
  localOnlyFields: {
    officeId: string;
    contextRevision: number | undefined;
  };
}

export function workResultIdempotencyKey(workId: string): string {
  return `${WORK_RESULT_IDEMPOTENCY_PREFIX}${workId}`;
}

export function mapContinuityWorkToCurrentContract(
  work: ContinuityWorkRecord,
): ContinuityContractMapping {
  return Object.freeze({
    work: Object.freeze({
      id: work.workId,
      channelId: work.channelId,
      originMessageId: work.originMessageId,
      state: work.state,
      currentAttemptId: work.attemptId,
      nextFencingToken: work.fencingToken ?? 1,
      kind: work.kind,
    }),
    presentation: work.presentation,
    resultIdempotencyKey: workResultIdempotencyKey(work.workId),
    localOnlyFields: Object.freeze({
      officeId: work.officeId,
      contextRevision: work.contextRevision,
    }),
  });
}
