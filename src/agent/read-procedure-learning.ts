/** Prospective learning for audited, already-authorized filesystem reads.
 * This consumes committed Seed lessons; source metadata is only a scope key.
 * The original intent/outcome remains in the existing retryable action ledger.
 */
import { createHash, randomUUID } from 'node:crypto';
import { statSync, openSync, readSync, closeSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import type { ToolContext, ToolResult } from './types.js';
import type { ToolRegistry } from './tools/index.js';
const require = createRequire(import.meta.url);
const { appendSeedProjectionOnce } = require('../../shared/seed-source-projection.cjs');
const { flushActionFeedback } = require('../../engine/src/cognition/action-feedback.js');
const { readSeedLearning, evaluateLearnedDecision, normalizeLearningDecision, executionTargetTag } = require('../../shared/seed-learning.cjs');

export interface ReadProcedureDescriptor {
  kind: 'read_file' | 'list_files';
  /** Validate and apply existing authority before returning a canonical path.
   * Null excludes the call from learning without changing its execution. */
  authorize(input: Record<string, unknown>, context: ToolContext): { path: string; selector?: string } | null;
}
export interface ReadProcedureTrace {
  schema: 'home23.read-procedure.v1'; executionId: string; decisionId: string;
  resourceHash: string; sourceEpoch: string;
  admission: 'attempt' | 'deferred' | 'owner_retry' | 'critical_recovery' | 'planned_method';
  lessonIds: string[]; counterfactual: { adjustment: number; suppress: boolean };
  projection: 'ready' | 'pending'; outcome?: string;
  learningEligibility: 'eligible' | 'capacity' | 'snapshot_unavailable' | 'capacity_pending';
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const safeCode = (value: unknown) => typeof value === 'string' && /^[a-zA-Z0-9_:-]{1,80}$/.test(value) ? value : 'read_io_error';

// Active lessons plus unconsumed prospective reservations share a 16-target
// budget. Caches are derived from existing receipts, never a second store.
const capacityCursors = new Map<string, { identity: string; offset: number;
  pending: Map<string, { open: number; teaching: number }> }>();

/** A source watermark is committed Seed feedback progress, not merely a
 * projection cursor. Recycle terminal reservations only when both writers are
 * caught up through the latest v2 source outcome. Missing coverage is safe:
 * execute new reads without new teaching until the source catches up. */
function sourceOutcomesConsumed(brain: string, snapshot: any, actionSize: number): boolean {
  let fd: number | undefined;
  try {
    const cursor = JSON.parse(readFileSync(join(brain, 'action-feedback-cursor.json'), 'utf8'));
    if (cursor.offset !== actionSize || cursor.pendingDecisionEventId) return false;
    const source = join(brain, 'event-ledger.jsonl'); const size = statSync(source).size;
    if (size === 0) return actionSize === 0;
    const start = Math.max(0, size - 256 * 1024), buffer = Buffer.alloc(size - start);
    fd = openSync(source, 'r'); const count = readSync(fd, buffer, 0, buffer.length, start);
    if (count !== buffer.length || buffer[count - 1] !== 10) return false;
    let offset = start > 0 ? buffer.indexOf(10) + 1 : 0, latest = 0;
    if (start > 0 && offset === 0) return false;
    while (offset < count) {
      const end = buffer.indexOf(10, offset); if (end < 0) return false;
      const line = buffer.subarray(offset, end).toString('utf8'); offset = end + 1;
      if (!line.trim()) continue;
      const row = JSON.parse(line);
      if (row.event_type === 'ExecutionOutcomeObserved' && row.payload?.learningVersion === 2
        && ['completed', 'failed', 'blocked', 'rejected'].includes(row.payload?.status)
        && row.payload?.executionAttempted !== false) latest = start + offset;
    }
    const stream = `tail_${createHash('sha256').update(source, 'utf8').digest('hex').slice(0, 8)}`;
    return latest > 0 && Number.isSafeInteger(snapshot.watermarks?.[stream]) && snapshot.watermarks[stream] >= latest;
  } catch { return false; }
  finally { if (fd !== undefined) closeSync(fd); }
}

function capacityEligibility(brain: string, snapshot: any, targetTag: string): ReadProcedureTrace['learningEligibility'] {
  if (!snapshot.available) return 'snapshot_unavailable';
  const active = new Set<string>((snapshot.lessons ?? []).filter((l: any) => l.active !== false && /^execution:(?:read_file|list_files)$/.test(l.scope))
    .flatMap((l: any) => (l.tags ?? []).filter((tag: string) => tag.startsWith('target:'))));
  let fd: number | undefined;
  let cursor = capacityCursors.get(brain);
  try {
    const path = join(brain, 'actions.jsonl'); const s = statSync(path); const identity = `${s.dev}:${s.ino}`;
    if (!cursor || cursor.identity !== identity || cursor.offset > s.size) {
      cursor = { identity, offset: 0, pending: new Map() }; capacityCursors.set(brain, cursor);
      if (capacityCursors.size > 32) capacityCursors.delete(capacityCursors.keys().next().value!);
    }
    let checked = false;
    const recycle = () => {
      if (checked || cursor!.pending.size === 0 || active.size >= 16) return;
      checked = true;
      if (sourceOutcomesConsumed(brain, snapshot, s.size)) {
        for (const [tag, reservation] of cursor!.pending) if (reservation.open === 0) cursor!.pending.delete(tag);
      }
    };
    if (cursor.offset < s.size) {
      const buffer = Buffer.alloc(Math.min(s.size - cursor.offset, 8 * 1024 * 1024));
      fd = openSync(path, 'r'); const count = readSync(fd, buffer, 0, buffer.length, cursor.offset);
      let start = 0;
      for (;;) {
        const end = buffer.indexOf(10, start); if (end < 0 || end >= count) break;
        const line = buffer.subarray(start, end).toString('utf8');
        const row = line.trim() ? JSON.parse(line) : null;
        const tag = row?.executionContext?.targetTag;
        if (row?.learningVersion === 2 && row.readProcedure?.learningEligibility === 'eligible' && typeof tag === 'string') {
          if (row.phase === 'intent') {
            if (!cursor.pending.has(tag) && cursor.pending.size >= 16) recycle();
            if (!cursor.pending.has(tag) && cursor.pending.size >= 16) return active.has(targetTag) || cursor.pending.has(targetTag) ? 'eligible' : 'capacity_pending';
            const entry = cursor.pending.get(tag) ?? { open: 0, teaching: 0 }; entry.open++; cursor.pending.set(tag, entry);
          } else if (row.phase === 'outcome') {
            const entry = cursor.pending.get(tag);
            if (entry) {
              entry.open = Math.max(0, entry.open - 1);
              if (['success', 'failed', 'blocked', 'rejected'].includes(row.status) && row.executionAttempted !== false) entry.teaching++;
              // A prospective v2 neutral outcome can never receive empirical
              // credit. Its immutable terminal receipt needs no future slot.
              if (entry.open === 0 && entry.teaching === 0) cursor.pending.delete(tag);
            }
          }
        }
        cursor.offset += end + 1 - start; start = end + 1;
      }
      if (cursor.offset < s.size) return active.has(targetTag) || cursor.pending.has(targetTag) ? 'eligible' : 'capacity_pending';
    }
    recycle();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return active.has(targetTag) ? 'eligible' : 'capacity_pending';
    cursor = { identity: '', offset: 0, pending: new Map() }; capacityCursors.set(brain, cursor);
  } finally { if (fd !== undefined) closeSync(fd); }
  const targets = new Set([...active, ...(cursor?.pending.keys() ?? [])]);
  return targets.has(targetTag) || targets.size < 16 ? 'eligible' : 'capacity';
}

/** No content reads. Absence is tied to the nearest existing ancestor identity,
 * not its mtime (an unrelated sibling write must not erase an unavailable path). */
function sourceEpoch(path: string): string | null {
  try {
    const s = statSync(path);
    return hash(['present', s.dev, s.ino, s.mode, s.uid, s.gid, s.size, s.mtimeMs, s.ctimeMs]);
  } catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return null;
    let parent = dirname(path);
    for (let depth = 0; depth < 128; depth++) {
      try { const s = statSync(parent); return hash(['absent', s.dev, s.ino, s.mode, s.uid, s.gid, hash(path.slice(parent.length))]); }
      catch (e) { if (!['ENOENT', 'ENOTDIR'].includes((e as NodeJS.ErrnoException).code ?? '')) return null; }
      const next = dirname(parent); if (next === parent) return null; parent = next;
    }
    return null;
  }
}

function explicitOwnerRetry(context: ToolContext, kind: string, input: Record<string, unknown>): boolean {
  const contact = context.authenticatedUserMessage;
  const path = kind === 'read_file' ? input.path : input.cwd;
  if (!contact?.messageRef || typeof path !== 'string' || !path || path.length > 2000) return false;
  const text = contact.text;
  const pathPattern = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const exactPath = new RegExp(`(?:^|[\\s\"'\x60])${pathPattern}(?=$|[\\s\"'\x60,;!?]|\\.(?:$|\\s))`);
  const method = kind === 'read_file' ? /\b(?:read_file|read|reading)\b/i : /\b(?:list_files|list|listing)\b/i;
  return (/\bretry\b/i.test(text) || /\b(?:again|once more)\b/i.test(text))
    && !/\b(?:do not|don't|never|no need to)\s+(?:ever\s+)?(?:(?:try|attempt)\s+(?:to\s+)?)?(?:retry|read_file|read|reading|list_files|list|listing)\b/i.test(text)
    && method.test(text) && exactPath.test(text);
}

export async function executeReadProcedure(input: {
  registry: ToolRegistry; name: string; toolCallId: string; input: Record<string, unknown>;
  context: ToolContext; execute: () => Promise<ToolResult>;
}): Promise<ToolResult> {
  const { context } = input;
  // Restricted hands have their own budget/authority wrappers. Do not unwrap
  // them, or make pre-execution filesystem probes on their behalf.
  if (/^(?:inspection|proposer|worker):/.test(context.chatId ?? '') || !context.instanceDir
    || !context.seedStateDir || !context.turnRuntime?.turnId) return input.execute();
  const descriptor = input.registry.get?.(input.name)?.readProcedure;
  if (!descriptor) return input.execute();
  let source: ReturnType<ReadProcedureDescriptor['authorize']>;
  try { source = descriptor.authorize(input.input, context); } catch { return input.execute(); }
  if (!source) return input.execute();
  const epoch = sourceEpoch(source.path); if (!epoch) return input.execute();
  const resourceHash = hash([descriptor.kind, resolve(source.path), source.selector ?? null]);
  const target = `readonly-v1:${descriptor.kind}:${resourceHash}:${epoch}`;
  const targetTag = executionTargetTag(target), executionId = randomUUID(), ts = new Date().toISOString();
  const decisionId = `action:${executionId}`;
  const decision = normalizeLearningDecision({ schema: 'home23.learning-decision.v1', decisionId,
    scope: `execution:${descriptor.kind}`, tags: ['execution', 'action', targetTag], criterion: 'execution',
    sourceRefs: [`action:${executionId}`], observedAt: ts });
  if (!decision) return input.execute();
  const brain = join(context.instanceDir, 'brain');
  const snapshot = readSeedLearning(context.seedStateDir);
  const candidate = { scope: decision.scope, tags: decision.tags, requiredTags: [targetTag] };
  const learning = evaluateLearnedDecision(snapshot, candidate);
  const learningEligibility = capacityEligibility(brain, snapshot, targetTag);
  const omitted = new Set(learning.lessonIds);
  const counterfactual = evaluateLearnedDecision({ ...snapshot, lessons: (snapshot.lessons ?? []).filter((l: { lessonId: string }) => !omitted.has(l.lessonId)) }, candidate);
  const admission = context.readProcedureControl?.criticalRecovery === true ? 'critical_recovery'
    : context.readProcedureControl?.plannedMethod === true ? 'planned_method'
    : explicitOwnerRetry(context, descriptor.kind, input.input) ? 'owner_retry'
    : learning.suppress && learning.lessonIds.length > 0 ? 'deferred' : 'attempt';
  const trace: ReadProcedureTrace = { schema: 'home23.read-procedure.v1', executionId, decisionId, resourceHash,
    sourceEpoch: epoch, admission, lessonIds: learning.lessonIds,
    counterfactual: { adjustment: counterfactual.adjustment, suppress: counterfactual.suppress }, projection: 'pending', learningEligibility };
  const receipt = { event_id: `read-procedure-intent:${executionId}`, event_type: 'ReadProcedureIntent', payload: {},
    stage: 'execute', phase: learningEligibility === 'eligible' ? 'intent' : 'observation_intent', executionId, action: descriptor.kind, target,
    ...(learningEligibility === 'eligible' ? { learningVersion: 2 } : {}),
    outcomeCriterion: 'execution', outcomeTrialId: `action:${executionId}`, executionAttempted: false,
    executionContext: { targetTag, origin: 'audited-read-procedure' },
    readProcedure: { ...trace,
      turnRef: hash(context.turnRuntime.turnId), callRef: hash(input.toolCallId) },
    learningDecisionEvent: { event_id: randomUUID(), event_type: 'LearningDecisionObserved',
      session_id: decisionId, object_id: executionId, actor: 'agent-read-procedure-runtime', timestamp: ts, ts,
      payload: { ...decision, learningVersion: 2 } }, ts, timestamp: ts };
  let projection: ReadProcedureTrace['projection'] = 'ready';
  try { appendSeedProjectionOnce(join(brain, 'actions.jsonl'), receipt, { newUnique: true }); }
  catch { return input.execute(); } // No original witness means no empirical credit.
  const project = () => { try { if (flushActionFeedback(brain).pendingBytes > 0) projection = 'pending'; }
    catch { projection = 'pending'; } };
  project();
  const finish = (status: string, attempted: boolean, code: string) => {
    trace.outcome = code;
    try { appendSeedProjectionOnce(join(brain, 'actions.jsonl'), { ...receipt,
      event_id: `read-procedure-outcome:${executionId}`, event_type: 'ReadProcedureOutcome', phase: learningEligibility === 'eligible' ? 'outcome' : 'observation_outcome',
      status, executionAttempted: attempted, detail: code, readProcedure: { ...receipt.readProcedure, ...trace },
      ts: new Date().toISOString(), timestamp: new Date().toISOString() }, { newUnique: true }); project(); }
    catch { projection = 'pending'; }
    trace.projection = projection;
  };
  if (admission === 'deferred') {
    finish('not_attempted', false, 'learned_read_method_deferred');
    return { content: JSON.stringify({ code: 'learned_read_method_deferred', method: descriptor.kind,
      message: 'Prior actual execution failed with this same source state. This method was not invoked. Continue the owner’s work with another authorized source or approach; report missing evidence honestly. An explicit owner retry or changed source permits another attempt.' }), readProcedure: trace };
  }
  let result: ToolResult;
  try { result = await input.execute(); }
  catch (error) { finish('unknown', true, 'read_exception_unattributable'); throw error; }
  let sameEpoch = false;
  try { const current = descriptor.authorize(input.input, context); sameEpoch = !!current && current.path === source.path
    && current.selector === source.selector && sourceEpoch(current.path) === epoch; } catch { /* no attribution */ }
  const outcome = result.readProcedureOutcome;
  if (sameEpoch && outcome && outcome.status !== 'ineligible') {
    finish(outcome.status === 'success' ? 'success' : 'failed', true, safeCode(outcome.code));
  } else if (sameEpoch && outcome?.status === 'ineligible') finish('unknown', true, 'read_result_ineligible');
  else finish('unknown', true, sameEpoch ? 'read_result_unattributable' : 'read_source_changed_during_call');
  return { ...result, readProcedure: trace };
}
