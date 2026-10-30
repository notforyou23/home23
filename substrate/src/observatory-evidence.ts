/** Bounded read models of already committed evidence. No Seed is constructed,
 * no admission rule is rerun, and these readers never mutate resident state. */
import { constants, openSync, closeSync, fstatSync, readSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { computeStateHash } from './checkpoint.js';
import { objectOf, readJsonlWindow, type ObservedRow, type JsonlWindow } from './observatory-state.js';
import { normalizeLearningDecision, readSeedLearningSync, type LearningSnapshot, type LearningDecision } from '../../shared/seed-learning.cjs';
import type { SerializedCell, SeedDispositions } from './types.js';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml') as { load(value: string): unknown };
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const str = (value: unknown, max = 500): string => typeof value === 'string' ? value.slice(0, max) : '';
export interface DocumentView { available: boolean; value?: ObservedRow; text?: string; bytes: number; at: string | null; error?: string }
const documents = new Map<string, { signature: string; view: DocumentView }>();
let documentBytes = 0;
const MAX_CACHE_BYTES = 32 * 1024 * 1024;

function signature(file: string): string {
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try { const s = fstatSync(fd); if (!s.isFile()) throw new Error('not a regular file'); return `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`; }
  finally { closeSync(fd); }
}
export function readDocument(file: string, maxBytes = 8 * 1024 * 1024, format: 'json' | 'yaml' | 'text' = 'json'): DocumentView {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 16 * 1024 * 1024) throw new Error('Invalid observatory document budget');
  const key = `${format}:${maxBytes}:${file}`;
  let fd: number | undefined;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > maxBytes) throw new Error('document is not a bounded regular file');
    const stamp = `${before.dev}:${before.ino}:${before.size}:${before.mtimeMs}:${before.ctimeMs}`;
    const cached = documents.get(key); if (cached?.signature === stamp) return cached.view;
    const bytes = Buffer.alloc(before.size); let read = 0;
    while (read < bytes.length) { const n = readSync(fd, bytes, read, bytes.length-read, read); if (!n) break; read += n; }
    const after = fstatSync(fd);
    if (read !== bytes.length || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error('document changed during read');
    const text = bytes.toString('utf8');
    const value: unknown = format === 'json' ? JSON.parse(text) : format === 'yaml' ? yaml.load(text) : undefined;
    if (format !== 'text' && (value === null || typeof value !== 'object' || Array.isArray(value))) throw new Error('document is not an object');
    const view: DocumentView = { available: true, ...(format === 'text' ? { text } : { value: value as ObservedRow }), bytes: read, at: new Date(before.mtimeMs).toISOString() };
    if (cached) documentBytes -= cached.view.bytes;
    documents.delete(key); documents.set(key, { signature: stamp, view }); documentBytes += read;
    while (documentBytes > MAX_CACHE_BYTES || documents.size > 48) {
      const first = documents.keys().next().value as string | undefined; if (!first) break;
      documentBytes -= documents.get(first)!.view.bytes; documents.delete(first);
    }
    return view;
  } catch (error) { return { available: false, bytes: 0, at: null, error: error instanceof Error ? error.message.slice(0, 160) : 'unavailable' }; }
  finally { if (fd !== undefined) closeSync(fd); }
}

export interface CheckpointView { available: boolean; document?: ObservedRow; error?: string; bytes: number; at: string | null }
export function readCheckpointView(stateDir: string): CheckpointView {
  const directory = join(stateDir, 'checkpoints');
  const index = readDocument(join(directory, 'CHECKPOINT_INDEX.json'), 8 * 1024 * 1024);
  let name: string | undefined, expected: ObservedRow | undefined;
  if (index.available && Array.isArray(index.value?.checkpoints)) {
    expected = objectOf(index.value.checkpoints.at(-1));
    if (typeof expected.checkpointId === 'string' && /^ckpt_[a-z0-9]+_[a-z0-9]+$/i.test(expected.checkpointId)) name = expected.checkpointId;
    if (!name) return { available: false, error: 'checkpoint index has no valid current entry', bytes: 0, at: null };
  } else {
    try { name = readdirSync(directory).filter(n => /^ckpt_[a-z0-9]+_[a-z0-9]+\.json$/i.test(n)).sort().at(-1)?.slice(0, -5); }
    catch { return { available: false, error: 'checkpoint storage unavailable', bytes: 0, at: null }; }
  }
  if (!name) return { available: false, error: 'no checkpoint observed', bytes: 0, at: null };
  const read = readDocument(join(directory, name+'.json'));
  const cp = read.value;
  try {
    if (!read.available || !cp || cp.schema !== 'home23.seed.checkpoint.v1' || cp.checkpointId !== name || !Array.isArray(cp.cells)
      || cp.cells.length > 512 || !Number.isSafeInteger(cp.ledgerSeq) || typeof cp.ledgerCursor !== 'string'
      || ![1, 2, 3].includes(Number(cp.version)) || typeof cp.stateHash !== 'string') throw new Error(read.error ?? 'invalid checkpoint identity');
    const stateHash = computeStateHash({ cells: cp.cells as SerializedCell[], dispositions: cp.dispositions as SeedDispositions,
      ...(Number(cp.version) >= 2 ? { development: objectOf(cp.development) } : {}), ...(Number(cp.version) >= 3 ? { concern: objectOf(cp.concern) } : {}) });
    if (stateHash !== cp.stateHash || (expected && (expected.stateHash !== cp.stateHash || expected.ledgerSeq !== cp.ledgerSeq))) throw new Error('checkpoint state hash or index binding mismatch');
    return { available: true, document: cp, bytes: read.bytes, at: typeof cp.createdAt === 'string' ? cp.createdAt : read.at };
  } catch (error) { return { available: false, error: error instanceof Error ? error.message : 'invalid checkpoint', bytes: read.bytes, at: read.at }; }
}

/** Interpret the fields of accepted concern receipts, not the concern law.
 * Missing coverage means a snapshot only; it must not label a request current. */
export function projectConcernView(checkpoint: ObservedRow, window: JsonlWindow): { current: boolean; throughSeq: number; concern: Record<string, ObservedRow> } {
  const seq = Number(checkpoint.ledgerSeq), concern: Record<string, ObservedRow> = {};
  for (const [id, value] of Object.entries(objectOf(checkpoint.concern))) concern[id] = { ...objectOf(value) };
  const fallback = { current: false, throughSeq: seq, concern };
  if (!window.available || !Number.isSafeInteger(seq)) return fallback;
  const anchor = window.records.find(row => row.seq === seq);
  const anchorHash = window.recordHashes?.[String(seq)] ?? (anchor ? hash(JSON.stringify(anchor)) : null);
  if (seq > 0 && (!anchor || anchorHash !== checkpoint.ledgerCursor || (checkpoint.stateHash && anchor.stateHashAfter !== checkpoint.stateHash))) return fallback;
  let cursor = str(checkpoint.ledgerCursor, 100), throughSeq = seq;
  for (const row of window.records.filter(row => Number(row.seq) > seq)) {
    if (row.seq !== throughSeq + 1 || row.prevHash !== cursor) return fallback;
    throughSeq = Number(row.seq); cursor = window.recordHashes?.[String(row.seq)] ?? hash(JSON.stringify(row));
  }
  for (const row of window.records.filter(row => Number(row.seq) > seq)) {
    const p = objectOf(row.payload), at = str(p.asOf ?? p.effectiveAt ?? row.issuedAt, 100);
    if (row.category === 'concern') {
      for (const formed of Array.isArray(p.formed) ? p.formed : []) {
        const f = objectOf(formed), id = str(f.commitmentId);
        if (id && typeof f.dueAt === 'string') concern[id] = { ...f, commitmentId: id, status: 'open', authority: 'concern.v1', kind: 'resolve-prediction', formedAt: at, formedAtSeq: row.seq, anchorAt: at, qAnchor: 0, crossings: 0 };
      }
      for (const discharged of Array.isArray(p.discharged) ? p.discharged : []) {
        const d = objectOf(discharged), c = concern[str(d.commitmentId)];
        if (c && typeof d.status === 'string') Object.assign(c, { status: d.status, dischargedAt: at, dischargeReason: d.reason });
      }
      const c = concern[str(p.commitmentId)];
      if (c && p.crossing === true) Object.assign(c, { crossings: p.crossings, lastCrossingAt: p.effectiveAt, anchorAt: p.effectiveAt, qAnchor: p.q });
      if (c && typeof p.status === 'string' && p.status !== 'open') Object.assign(c, { status: p.status, dischargedAt: at, dischargeReason: p.reason });
    } else if (row.category === 'act' && row.sourceRef === 'concern.motor' && p.authorized === true) {
      const c = concern[str(p.commitmentId)]; if (c) c.reachedAt = p.reachedAt ?? p.asOf;
    }
  }
  return { current: true, throughSeq, concern };
}

export interface ChoiceView { decisionId: string; scope: string; surface: string; at: string; evidenceStatus: 'verified' | 'unavailable'; choice?: string; adjustment?: number; lessonIds: string[]; deliveryStatus: 'observed' | 'unavailable'; deliveredChars?: number; reason?: string }
const core = (d: LearningDecision) => ({ schema: d.schema, decisionId: d.decisionId, scope: d.scope, tags: d.tags, sourceRefs: d.sourceRefs, criterion: d.criterion });
export function learningChoices(snapshot: LearningSnapshot, records: readonly ObservedRow[]): ChoiceView[] {
  if (snapshot.available !== true) return [];
  const choices: ChoiceView[] = [];
  for (const witness of snapshot.decisions.slice().reverse().slice(0, 12)) {
    const candidates = records.filter(row => row.event_id === witness.decisionId || (row.event_type === 'LearningDecisionObserved' && objectOf(row.payload).decisionId === witness.decisionId));
    if (!candidates.length) continue;
    const row = candidates[0]!, p = objectOf(row.payload), normalized = normalizeLearningDecision(p);
    const view: ChoiceView = { decisionId: witness.decisionId, scope: witness.scope, surface: str(objectOf(p.behavior).surface, 100), at: str(row.timestamp, 100), evidenceStatus: 'unavailable', lessonIds: [], deliveryStatus: 'unavailable' };
    const session = str(row.session_id), at = Date.parse(str(row.timestamp));
    const behavior = objectOf(p.behavior);
    const surfaceComponents: Record<string, { component: string; tag: string }> = {
      AGENCY_STATUS: { component: 'routine-operational-status', tag: 'agency_status' }, AGENCY: { component: 'pursuit-context', tag: 'agency_pursuits' }, WORKERS: { component: 'worker-context', tag: 'workers' },
    };
    const expected = surfaceComponents[view.surface];
    if (candidates.length !== 1 || row.event_type !== 'LearningDecisionObserved' || row.actor !== 'assembly' || row.event_id !== witness.decisionId
      || !session || !Number.isFinite(at) || !normalized || JSON.stringify(core(normalized)) !== JSON.stringify(core(witness))
      || (witness.observedAt !== undefined && witness.observedAt !== row.timestamp) || !['admit', 'omit'].includes(String(p.choice))
      || typeof p.relevant !== 'boolean' || typeof p.explicit !== 'boolean' || (p.choice === 'admit' && p.relevant !== true)
      || behavior.kind !== 'context-selection' || !expected || behavior.component !== expected.component || !str(behavior.description, 600)
      || !witness.tags.includes('operational') || !witness.tags.includes(expected.tag) || !witness.sourceRefs.includes(`surface:${view.surface}`)
      || !witness.tags.includes(p.explicit ? 'requested' : 'automatic') || witness.tags.includes(p.explicit ? 'automatic' : 'requested')) {
      view.reason = 'retained witness or runtime identity mismatch'; choices.push(view); continue;
    }
    view.evidenceStatus = 'verified'; view.choice = str(p.choice);
    const learning = objectOf(p.learning);
    if (learning.available === true && typeof learning.adjustment === 'number' && Number.isFinite(learning.adjustment)) {
      view.adjustment = learning.adjustment;
      view.lessonIds = Array.isArray(learning.lessonIds) ? learning.lessonIds.filter((id): id is string => typeof id === 'string').slice(0, 16) : [];
    }
    const joins = records.filter(r => r.event_type === 'RetrievalExecuted' && Array.isArray(objectOf(r.payload).learningDecisionIds)
      && (objectOf(r.payload).learningDecisionIds as unknown[]).includes(witness.decisionId));
    const stringArray = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 64 && value.every(x => typeof x === 'string' && x.length > 0 && x.length <= 512 && !/[\x00-\x1f\x7f]/.test(x)) && new Set(value).size === value.length;
    const joined = joins[0];
    const delivery = objectOf(joined?.payload);
    if (joins.length === 1 && joined?.actor === 'assembly' && str(joined.event_id) && joined.session_id === session && Number.isFinite(Date.parse(str(joined.timestamp))) && Date.parse(str(joined.timestamp)) >= at
      && stringArray(delivery.learningDecisionIds) && stringArray(delivery.surfaces_selected) && stringArray(delivery.surfaces_loaded) && Array.isArray(delivery.surface_delivery)) {
      const selected = delivery.surfaces_selected.includes(view.surface), loaded = delivery.surfaces_loaded.includes(view.surface);
      const rows = delivery.surface_delivery.map(objectOf).filter(r => r.surface === view.surface);
      if (p.choice === 'omit' && !selected && !loaded && rows.length === 0) { view.deliveryStatus = 'observed'; view.deliveredChars = 0; }
      else if (p.choice === 'admit' && selected && loaded && rows.length === 1 && rows[0]!.source === `surface:${view.surface}`
        && Number.isSafeInteger(rows[0]!.delivered_chars) && Number(rows[0]!.delivered_chars) > 0
        && rows[0]!.pointer_only === false && typeof rows[0]!.complete === 'boolean') {
        view.deliveryStatus = 'observed'; view.deliveredChars = Number(rows[0]!.delivered_chars);
      }
    }
    choices.push(view);
  }
  return choices.slice(0, 6);
}

const learningCache = new Map<string, { signature: string; snapshot: LearningSnapshot }>();
export function readLearningView(stateDir: string, checkpoint: CheckpointView): LearningSnapshot {
  const unavailable: LearningSnapshot = { version: 1, available: false, seq: null, decisions: [], lessons: [] };
  if (!checkpoint.available) return unavailable;
  try {
    // The shared reader selects the lexical latest checkpoint. Validate that
    // exact input too, so its otherwise unbounded JSON read stays within budget.
    const latest = readdirSync(join(stateDir, 'checkpoints')).filter(n => /^ckpt_.*\.json$/.test(n)).sort().at(-1);
    if (!latest || latest !== `${String(checkpoint.document?.checkpointId)}.json` || !readDocument(join(stateDir, 'checkpoints', latest)).available) return unavailable;
    const stamp = signature(join(stateDir, 'checkpoints', latest)) + ':' + signature(join(stateDir, 'seed-ledger.jsonl'));
    const cached = learningCache.get(stateDir); if (cached?.signature === stamp) return cached.snapshot;
    const snapshot = readSeedLearningSync(stateDir);
    if (stamp !== signature(join(stateDir, 'checkpoints', latest)) + ':' + signature(join(stateDir, 'seed-ledger.jsonl'))) return unavailable;
    learningCache.set(stateDir, { signature: stamp, snapshot });
    if (learningCache.size > 16) learningCache.delete(learningCache.keys().next().value!);
    return snapshot;
  } catch { return unavailable; }
}

/** Only known local resident layout, never a guessed sibling or another home. */
export function residentRoot(stateDir: string): string | null {
  const parent = dirname(stateDir);
  if (parent.endsWith('/substrate')) return dirname(parent);
  if (stateDir.endsWith('-mirror')) return null;
  return null;
}
