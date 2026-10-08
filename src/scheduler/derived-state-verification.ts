import { createRequire } from 'node:module';
import { lstat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import type { JobResult } from './cron.js';

const require = createRequire(import.meta.url);
const { readCommittedSynthesisState } = require('../../engine/src/synthesis/synthesis-agent.js');

export type DerivedStateFreshnessContract = {
  kind: 'own_brain_derived_state_freshness';
  maxAgeSeconds: number;
};
type Verification = Pick<JobResult, 'semanticStatus' | 'outcomeLayers' | 'artifacts'>;

function outcome(status: 'failed' | 'unknown', reason: string, evidence: Record<string, unknown> = {}): Verification {
  const layerStatus = status === 'failed' ? 'failed' : 'unknown';
  return { semanticStatus: status, artifacts: [], outcomeLayers: {
    artifact: { status: layerStatus, reason, evidence },
    intent: { status: layerStatus, reason, evidence },
  } };
}
function contractBound(value: unknown): number | null {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const fields = Object.getOwnPropertyDescriptors(value);
    const valid = Object.keys(fields).length === 2
      && fields.kind?.value === 'own_brain_derived_state_freshness'
      && typeof fields.maxAgeSeconds?.value === 'number'
      && Number.isFinite(fields.maxAgeSeconds.value) && fields.maxAgeSeconds.value > 0;
    return valid ? fields.maxAgeSeconds!.value as number : null;
  } catch { return null; }
}

/** The caller supplies the runtime-resolved own brain, never a contract path.
 * Only the confined, hash-verified committed artifact can satisfy freshness. */
export async function verifyOwnBrainDerivedStateFreshness(
  brainDir: string, contract: DerivedStateFreshnessContract, nowMs = Date.now(),
): Promise<Verification> {
  const maxAgeSeconds = contractBound(contract);
  if (maxAgeSeconds === null) return outcome('failed', 'Invalid derived-state freshness contract; maxAgeSeconds must be positive and finite.', { condition: 'invalid_contract' });
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs) || !Number.isFinite(new Date(nowMs).getTime())) {
    return outcome('failed', 'Invalid clock bound for derived-state freshness verification.', { condition: 'invalid_clock' });
  }
  if (typeof brainDir !== 'string' || !isAbsolute(brainDir) || brainDir.includes('\0') || resolve(brainDir) === '/') {
    return outcome('unknown', 'The own-brain directory is not runtime-bound.', { condition: 'unbound_brain' });
  }
  const root = resolve(brainDir), path = join(root, 'brain-state.json');
  const targetEvidence = { path, maxAgeSeconds };
  try {
    const stat = await lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return outcome('unknown', 'The own-brain directory is not a bound canonical directory.', { ...targetEvidence, condition: 'unbound_brain' });
  } catch (error) {
    return outcome('unknown', 'The runtime-bound own brain could not be inspected.', { ...targetEvidence, condition: 'brain_unavailable', errorCode: (error as NodeJS.ErrnoException)?.code });
  }

  let state;
  try { state = await readCommittedSynthesisState({ brainDir: root }); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (['synthesis_state_invalid', 'invalid_memory_source', 'result_too_large'].includes(code || '')) {
      return outcome('failed', 'The canonical derived-state artifact is corrupt or unsafe and could not be verified.', { ...targetEvidence, condition: 'invalid_artifact', errorCode: code });
    }
    return outcome('unknown', 'The canonical derived-state artifact could not be read or bound to stable evidence.', { ...targetEvidence, condition: 'artifact_unavailable', errorCode: code });
  }
  if (!state) return outcome('failed', 'The canonical derived-state artifact is missing.', { ...targetEvidence, condition: 'missing_artifact' });

  const ageSeconds = (nowMs - Date.parse(state.generatedAt)) / 1000;
  const evidence: Record<string, unknown> = { ...targetEvidence,
    generatedAt: state.generatedAt, sourceRevision: state.sourceRevision,
    brainStateSha256: state.brainStateSha256, ageSeconds, operationId: state.operationId,
    ...(state.sourceGeneration !== undefined ? { sourceGeneration: state.sourceGeneration } : {}),
  };
  if (ageSeconds < 0) return outcome('failed', 'The verified derived-state timestamp is in the future.', { ...evidence, condition: 'future_timestamp' });
  if (ageSeconds >= maxAgeSeconds) return outcome('failed', 'The verified derived-state artifact is stale: age is at or above the required freshness bound.', { ...evidence, condition: 'stale_artifact' });
  return { semanticStatus: 'satisfied', artifacts: [path], outcomeLayers: {
    artifact: { status: 'success', reason: 'Canonical derived-state artifact passed confinement, hash and freshness verification.', evidence },
    intent: { status: 'success', reason: 'Verified own-brain derived state is below the required age bound.', evidence },
  } };
}
