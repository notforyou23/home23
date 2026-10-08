import type { JobPayload, JobResult } from './cron.js';
import { verifyOwnBrainDerivedStateFreshness } from './derived-state-verification.js';

/** Verify the explicit artifact objective only after a successful terminal turn. */
export async function verifyScheduledArtifactResult(
  ownBrainDir: string,
  payload: JobPayload,
  result: JobResult,
): Promise<JobResult> {
  if (payload.kind !== 'agentTurn' || payload.artifactContract === undefined
    || result.canonicalRunPending || result.status !== 'ok' || result.semanticStatus === 'failed') return result;
  const verified = await verifyOwnBrainDerivedStateFreshness(ownBrainDir, payload.artifactContract);
  return {
    ...result,
    ...verified,
    artifacts: verified.artifacts,
    outcomeLayers: { ...result.outcomeLayers, ...verified.outcomeLayers },
  };
}
