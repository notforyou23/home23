import { createRequire } from 'node:module';
import { constants, promises as fs } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { LearningDecision } from '../../shared/seed-learning.cjs';
import { normalizeLearningDecision } from '../../shared/seed-learning.cjs';

const { readRecentJsonlTail } = createRequire(import.meta.url)('../../shared/bounded-jsonl-tail.cjs') as {
  readRecentJsonlTail: (file: string, options: {
    limit: number; maxEntries: number; maxBytes: number; maxLineBytes: number; signal?: AbortSignal;
  }) => Promise<unknown[]>;
};

const MAX_RECORDS = 512;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_LINE_BYTES = 256 * 1024;
const SURFACE_COMPONENTS = {
  AGENCY_STATUS: { component: 'routine-operational-status', tag: 'agency_status' },
  AGENCY: { component: 'pursuit-context', tag: 'agency_pursuits' },
  WORKERS: { component: 'worker-context', tag: 'workers' },
} as const;

type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue | null => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? value as RecordValue : null;
const boundedText = (value: unknown, max: number): value is string => typeof value === 'string'
  && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
const stringArray = (value: unknown, max = 64): value is string[] => Array.isArray(value) && value.length <= max
  && value.every(item => boundedText(item, 512)) && new Set(value).size === value.length;
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const timestamp = (value: unknown): number | null => typeof value === 'string' && value.length <= 100
  && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;

export interface LearningDecisionBehavior {
  kind: 'context-selection';
  surface: string;
  component: 'routine-operational-status' | 'pursuit-context' | 'worker-context';
  description: string;
}

export interface LearningDecisionDelivery {
  status: 'observed' | 'unavailable';
  reason?: string;
  sourceEventId?: string;
  timestamp?: string;
  selected?: boolean;
  loaded?: boolean;
  deliveredChars?: number;
  pointerOnly?: boolean;
  complete?: boolean;
}

export type LearningDecisionEvidence = {
  status: 'unavailable'; reason: string;
} | {
  status: 'verified';
  sourceEventId: string;
  timestamp: string;
  sessionRef: string;
  behavior: LearningDecisionBehavior;
  choice: 'admit' | 'omit';
  relevant: boolean;
  explicit: boolean;
  delivery: LearningDecisionDelivery;
};

export type ReadLearningDecisionEvidence = (
  decisions: readonly LearningDecision[],
) => Promise<Record<string, LearningDecisionEvidence>>;

function coreWitness(decision: LearningDecision) {
  return { schema: decision.schema, decisionId: decision.decisionId, scope: decision.scope,
    tags: decision.tags, sourceRefs: decision.sourceRefs, criterion: decision.criterion };
}

function behaviorOf(value: unknown, witness: LearningDecision): LearningDecisionBehavior | null {
  const behavior = object(value);
  const expected = behavior && boundedText(behavior.surface, 64) && Object.hasOwn(SURFACE_COMPONENTS, behavior.surface)
    ? SURFACE_COMPONENTS[behavior.surface as keyof typeof SURFACE_COMPONENTS] : undefined;
  if (!behavior || behavior.kind !== 'context-selection' || !boundedText(behavior.surface, 64)
    || !expected || behavior.component !== expected.component || !witness.tags.includes('operational')
    || !witness.tags.includes(expected.tag) || !boundedText(behavior.description, 600)
    || !witness.sourceRefs.includes(`surface:${behavior.surface}`)) return null;
  return { kind: 'context-selection', surface: behavior.surface,
    component: behavior.component as LearningDecisionBehavior['component'], description: behavior.description };
}

async function completeTailIdentity(file: string) {
  let handle;
  try { handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('Runtime ledger is not a regular file');
    if (stat.size) {
      const finalByte = Buffer.alloc(1);
      const read = await handle.read(finalByte, 0, 1, stat.size - 1);
      if (read.bytesRead !== 1 || finalByte[0] !== 10) throw new Error('Runtime ledger has an incomplete final record');
    }
    return { device: stat.dev, inode: stat.ino, size: stat.size };
  } finally { await handle.close(); }
}

function deliveryOf(rows: RecordValue[], decision: RecordValue, behavior: LearningDecisionBehavior): LearningDecisionDelivery {
  const matches = rows.filter(row => row.event_type === 'RetrievalExecuted'
    && Array.isArray(object(row.payload)?.learningDecisionIds)
    && (object(row.payload)!.learningDecisionIds as unknown[]).includes(decision.event_id));
  if (!matches.length) return { status: 'unavailable', reason: 'explicit_delivery_reference_not_observed' };
  if (matches.length !== 1) return { status: 'unavailable', reason: 'conflicting_delivery_references' };
  const receipt = matches[0]!;
  const payload = object(receipt.payload)!;
  const decisionTime = timestamp(decision.timestamp);
  const receiptTime = timestamp(receipt.timestamp);
  if (receipt.actor !== 'assembly' || !boundedText(receipt.event_id, 512) || receipt.session_id !== decision.session_id
    || decisionTime === null || receiptTime === null || receiptTime < decisionTime
    || !stringArray(payload.learningDecisionIds) || !stringArray(payload.surfaces_selected)
    || !stringArray(payload.surfaces_loaded) || !Array.isArray(payload.surface_delivery)) {
    return { status: 'unavailable', reason: 'delivery_provenance_mismatch' };
  }
  const selected = payload.surfaces_selected.includes(behavior.surface);
  const loaded = payload.surfaces_loaded.includes(behavior.surface);
  const entries = payload.surface_delivery.map(object).filter(entry => entry?.surface === behavior.surface);
  const choice = object(decision.payload)?.choice;
  if ((choice === 'omit' && (selected || loaded || entries.length > 0))
    || (!selected && (loaded || entries.length > 0)) || entries.length > 1 || (loaded && entries.length !== 1)) {
    return { status: 'unavailable', reason: 'delivery_selection_conflict' };
  }
  const entry = entries[0];
  if (entry && (entry.source !== `surface:${behavior.surface}`
    || !Number.isSafeInteger(entry.delivered_chars) || (entry.delivered_chars as number) < 0
    || typeof entry.pointer_only !== 'boolean' || typeof entry.complete !== 'boolean'
    || loaded !== ((entry.delivered_chars as number) > 0)
    || entry.pointer_only !== (entry.delivered_chars === 0))) {
    return { status: 'unavailable', reason: 'delivery_details_invalid' };
  }
  return { status: 'observed', sourceEventId: receipt.event_id, timestamp: receipt.timestamp as string,
    selected, loaded, deliveredChars: entry ? entry.delivered_chars as number : 0,
    ...(entry ? { pointerOnly: entry.pointer_only as boolean, complete: entry.complete as boolean } : {}) };
}

/** Read descriptions from the resident's runtime ledger, never from tool arguments.
 * These details explain an existing Seed witness; they do not grant teaching authority.
 */
export function createLearningDecisionEvidenceReader(
  ledgerPath: string,
  { signal }: { signal?: AbortSignal } = {},
): ReadLearningDecisionEvidence {
  if (!isAbsolute(ledgerPath)) throw new Error('Learning evidence needs an absolute runtime-owned ledger path');
  return async decisions => {
    const result: Record<string, LearningDecisionEvidence> = Object.create(null);
    const unavailable = (reason: string) => {
      for (const decision of decisions) result[decision.decisionId] = { status: 'unavailable', reason };
      return result;
    };
    if (!decisions.length) return result;
    if (decisions.length > 20) return unavailable('witness_request_exceeds_limit');
    if (signal?.aborted) return unavailable('bounded_runtime_ledger_unavailable');
    let rows: RecordValue[];
    try {
      const before = await completeTailIdentity(ledgerPath);
      const recent = await readRecentJsonlTail(ledgerPath, {
        limit: MAX_RECORDS, maxEntries: MAX_RECORDS, maxBytes: MAX_BYTES, maxLineBytes: MAX_LINE_BYTES, signal,
      });
      const after = await completeTailIdentity(ledgerPath);
      if ((before === null) !== (after === null) || (before && after
        && (before.device !== after.device || before.inode !== after.inode || after.size < before.size))) {
        throw new Error('Runtime ledger changed identity while reading');
      }
      if (recent.some(row => object(row) === null)) throw new Error('Runtime ledger contains a malformed event');
      rows = recent as RecordValue[];
    } catch {
      // A torn tail, cancellation, unsafe link or oversized record cannot become evidence.
      return unavailable('bounded_runtime_ledger_unavailable');
    }
    for (const witness of decisions) {
      const candidates = rows.filter(row => row.event_id === witness.decisionId
        || (row.event_type === 'LearningDecisionObserved' && object(row.payload)?.decisionId === witness.decisionId));
      if (!candidates.length) { result[witness.decisionId] = { status: 'unavailable', reason: 'decision_outside_recent_window' }; continue; }
      if (candidates.length !== 1) { result[witness.decisionId] = { status: 'unavailable', reason: 'conflicting_decision_identity' }; continue; }
      const event = candidates[0]!;
      const payload = object(event.payload);
      const normalized = normalizeLearningDecision(payload);
      if (event.event_type !== 'LearningDecisionObserved' || event.actor !== 'assembly'
        || event.event_id !== witness.decisionId || payload?.decisionId !== witness.decisionId
        || !normalized || !same(coreWitness(normalized), coreWitness(witness))
        || !boundedText(event.session_id, 512) || timestamp(event.timestamp) === null
        || (witness.observedAt !== undefined && event.timestamp !== witness.observedAt)) {
        result[witness.decisionId] = { status: 'unavailable', reason: 'retained_witness_mismatch' }; continue;
      }
      const behavior = behaviorOf(payload.behavior, witness);
      if (!behavior || !['admit', 'omit'].includes(String(payload.choice))
        || typeof payload.relevant !== 'boolean' || typeof payload.explicit !== 'boolean'
        || (payload.choice === 'admit' && !payload.relevant)
        || !witness.tags.includes(payload.explicit ? 'requested' : 'automatic')
        || witness.tags.includes(payload.explicit ? 'automatic' : 'requested')) {
        result[witness.decisionId] = { status: 'unavailable', reason: 'runtime_behavior_details_unavailable' }; continue;
      }
      result[witness.decisionId] = { status: 'verified', sourceEventId: event.event_id as string,
        timestamp: event.timestamp as string, sessionRef: event.session_id,
        behavior, choice: payload.choice as 'admit' | 'omit', relevant: payload.relevant, explicit: payload.explicit,
        delivery: deliveryOf(rows, event, behavior) };
    }
    return result;
  };
}
