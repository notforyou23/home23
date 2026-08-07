/**
 * Replaceable model lobes (Cut 2).
 *
 * Models are recruited cognitive tissue, not the self and not the runtime.
 * A lobe receives a bounded WorkspacePacket projection and returns typed
 * proposals (LobeResult). No lobe writes state: the Seed validates, rejects,
 * or stages proposals, and accepted deltas enter through the ONE receipted
 * commit path. Prose is never accepted as an untyped state mutation.
 *
 * Replay note: the lobe receipt carries the FULL accepted deltas, so a replay
 * re-applies receipts without re-invoking any model. Model calls are the one
 * non-deterministic boundary — receipting their typed output is what keeps
 * the trajectory replayable anyway.
 */

import { createHash } from 'node:crypto';
import type {
  WorkspacePacket,
  LobeResult,
  ProposedStateDelta,
  SituationCell,
  Estimate,
  Prediction,
  IntentionTension,
  ModelReceipt,
} from './types.js';

// ─── Bounds ──────────────────────────────────────────────────────────────────

const MAX_PROPOSALS_PER_KIND = 8;
const MAX_FORMS_OR_ACTIONS = 4;
const MAX_CLAIM_CHARS = 500;
const MAX_UNCERTAINTY_ADJUST = 0.2;
const MAX_ESTIMATES_PER_CELL = 32;
const MAX_PREDICTIONS_PER_CELL = 32;
const MAX_INTENTIONS_PER_CELL = 16;

/** Delta fields a lobe may propose in Cut 2. Everything else is rejected —
 * dispositions, continuous state, reality refs, and lineage are transition
 * and (Cut 3) plasticity territory, never lobe territory. */
export const LOBE_DELTA_ALLOWLIST = [
  'estimates.append',
  'predictions.append',
  'intentions.append',
  'predictions.resolve',
  'uncertainty.adjust',
] as const;

export type LobeDeltaField = (typeof LOBE_DELTA_ALLOWLIST)[number];

// ─── Adapter interface ───────────────────────────────────────────────────────

export interface LobeAdapter {
  readonly id: string;
  readonly modelId: string;
  readonly provider: string;
  invoke(packet: WorkspacePacket): Promise<LobeResult>;
}

// ─── Validation ──────────────────────────────────────────────────────────────

export interface RejectedProposal {
  kind: string;
  reason: string;
}

export interface ValidatedLobeResult {
  accepted: {
    observations: LobeResult['observations'];
    interpretations: LobeResult['interpretations'];
    predictions: LobeResult['predictions'];
    stateDeltas: ProposedStateDelta[];
  };
  rejected: RejectedProposal[];
  modelReceipt: ModelReceipt;
  uncertainty: number;
}

function boundedString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_CLAIM_CHARS;
}

function boundedConfidence(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
}

/**
 * Validate a LobeResult against the packet that recruited it. Anything not
 * explicitly acceptable is rejected with a reason — rejections are receipted,
 * never silently dropped.
 */
export function validateLobeResult(result: LobeResult, packet: WorkspacePacket): ValidatedLobeResult {
  const admitted = new Set(packet.activeCellIds);
  const rejected: RejectedProposal[] = [];
  const allowDeltas = packet.authorityCeiling !== 'observe'
    && packet.outputContract.allowedOutputKinds.includes('stateDeltas');

  // Unambiguous attribution: when exactly ONE cell is admitted, a proposal
  // missing its cellId can only mean that cell — default it rather than
  // rejecting content whose target is not in question. With 2+ admitted
  // cells the ambiguity is real and the rejection stands.
  const soleCell = packet.activeCellIds.length === 1 ? packet.activeCellIds[0] : undefined;
  const attribute = <T extends { cellId?: string }>(p: T): T =>
    (p.cellId === undefined && soleCell !== undefined ? { ...p, cellId: soleCell } : p);
  result = {
    ...result,
    observations: Array.isArray(result.observations) ? result.observations.map(attribute) : result.observations,
    interpretations: Array.isArray(result.interpretations) ? result.interpretations.map(attribute) : result.interpretations,
    predictions: Array.isArray(result.predictions) ? result.predictions.map(attribute) : result.predictions,
    stateDeltas: Array.isArray(result.stateDeltas) ? result.stateDeltas.map(attribute) : result.stateDeltas,
  };

  const observations = (Array.isArray(result.observations) ? result.observations : [])
    .slice(0, MAX_PROPOSALS_PER_KIND)
    .filter((o) => {
      if (!admitted.has(o.cellId)) { rejected.push({ kind: 'observation', reason: `cell ${o.cellId} not admitted` }); return false; }
      if (!boundedString(o.claim) || !boundedConfidence(o.confidence)) { rejected.push({ kind: 'observation', reason: 'malformed or oversized' }); return false; }
      return true;
    });

  const interpretations = (Array.isArray(result.interpretations) ? result.interpretations : [])
    .slice(0, MAX_PROPOSALS_PER_KIND)
    .filter((i) => {
      if (!admitted.has(i.cellId)) { rejected.push({ kind: 'interpretation', reason: `cell ${i.cellId} not admitted` }); return false; }
      if (!boundedString(i.interpretation) || !boundedConfidence(i.confidence)) { rejected.push({ kind: 'interpretation', reason: 'malformed or oversized' }); return false; }
      return true;
    });

  const predictions = (Array.isArray(result.predictions) ? result.predictions : [])
    .slice(0, MAX_PROPOSALS_PER_KIND)
    .filter((p) => {
      if (!admitted.has(p.cellId)) { rejected.push({ kind: 'prediction', reason: `cell ${p.cellId} not admitted` }); return false; }
      if (!boundedString(p.claim) || !boundedConfidence(p.confidence) || !boundedString(p.horizon)) { rejected.push({ kind: 'prediction', reason: 'malformed or oversized' }); return false; }
      return true;
    });

  const stateDeltas: ProposedStateDelta[] = [];
  for (const d of (Array.isArray(result.stateDeltas) ? result.stateDeltas : []).slice(0, MAX_PROPOSALS_PER_KIND)) {
    if (!allowDeltas) { rejected.push({ kind: 'stateDelta', reason: 'authority ceiling is observe — no deltas' }); continue; }
    if (!admitted.has(d.cellId)) { rejected.push({ kind: 'stateDelta', reason: `cell ${d.cellId} not admitted` }); continue; }
    if (!(LOBE_DELTA_ALLOWLIST as readonly string[]).includes(d.field)) {
      rejected.push({ kind: 'stateDelta', reason: `field ${d.field} not in allowlist` });
      continue;
    }
    if (d.field === 'uncertainty.adjust') {
      const v = (d.delta as { value?: unknown })?.value;
      if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > MAX_UNCERTAINTY_ADJUST) {
        rejected.push({ kind: 'stateDelta', reason: `uncertainty.adjust out of bounds (|value| <= ${MAX_UNCERTAINTY_ADJUST})` });
        continue;
      }
    }
    stateDeltas.push(d);
  }

  // Forms and actions are Cut 4 authority — receipted as rejected for now so
  // the lobe's full output is on the record without granting anything.
  for (const f of (Array.isArray(result.candidateForms) ? result.candidateForms : []).slice(0, MAX_FORMS_OR_ACTIONS)) {
    rejected.push({ kind: 'candidateForm', reason: `forms are Cut 4 authority (${f.formId ?? 'unnamed'})` });
  }
  for (const a of (Array.isArray(result.candidateActions) ? result.candidateActions : []).slice(0, MAX_FORMS_OR_ACTIONS)) {
    rejected.push({ kind: 'candidateAction', reason: `actions are Cut 4 authority (${a.actionId ?? 'unnamed'})` });
  }

  return {
    accepted: { observations, interpretations, predictions, stateDeltas },
    rejected,
    modelReceipt: result.modelReceipt,
    uncertainty: boundedConfidence(result.uncertainty) ? result.uncertainty : 0.5,
  };
}

// ─── Delta application (staged; caller commits through the receipt path) ─────

function deterministicId(prefix: string, cellId: string, content: string): string {
  return `${prefix}_${createHash('sha256').update(`${cellId}:${content}`, 'utf-8').digest('hex').slice(0, 16)}`;
}

/**
 * Apply accepted deltas onto STAGED clones. Elements are replaced, never
 * mutated in place (staged arrays are copies; elements may be shared with the
 * committed cell). Returns the staged map for commitReceipted.
 */
export function applyLobeDeltas(
  cells: Map<string, SituationCell>,
  deltas: ProposedStateDelta[],
  asOf: string,
  cloneCell: (cell: SituationCell) => SituationCell,
): { staged: Map<string, SituationCell>; applied: ProposedStateDelta[]; failed: RejectedProposal[] } {
  const staged = new Map<string, SituationCell>();
  const applied: ProposedStateDelta[] = [];
  const failed: RejectedProposal[] = [];

  const stagedCell = (cellId: string): SituationCell | undefined => {
    const existing = staged.get(cellId);
    if (existing !== undefined) return existing;
    const live = cells.get(cellId);
    if (live === undefined) return undefined;
    const clone = cloneCell(live);
    staged.set(cellId, clone);
    return clone;
  };

  for (const d of deltas) {
    const cell = stagedCell(d.cellId);
    if (cell === undefined) { failed.push({ kind: 'stateDelta', reason: `cell ${d.cellId} not found` }); continue; }

    if (d.field === 'estimates.append') {
      const body = d.delta as { claim?: unknown; confidence?: unknown; evidenceRefs?: unknown };
      if (!boundedString(body?.claim) || !boundedConfidence(body?.confidence)) {
        failed.push({ kind: 'stateDelta', reason: 'estimates.append malformed' });
        continue;
      }
      const estimate: Estimate = {
        estimateId: deterministicId('est', d.cellId, body.claim),
        claim: body.claim,
        confidence: body.confidence,
        evidenceRefs: Array.isArray(body.evidenceRefs) ? body.evidenceRefs.filter((r): r is string => typeof r === 'string').slice(0, 8) : [],
        createdAt: asOf,
      };
      cell.estimates = [...cell.estimates.slice(-(MAX_ESTIMATES_PER_CELL - 1)), estimate];
      applied.push(d);
    } else if (d.field === 'predictions.append') {
      const body = d.delta as { claim?: unknown; confidence?: unknown; horizon?: unknown };
      if (!boundedString(body?.claim) || !boundedConfidence(body?.confidence) || !boundedString(body?.horizon)) {
        failed.push({ kind: 'stateDelta', reason: 'predictions.append malformed' });
        continue;
      }
      const prediction: Prediction = {
        predictionId: deterministicId('pred', d.cellId, body.claim),
        claim: body.claim,
        confidence: body.confidence,
        horizon: body.horizon,
        createdAt: asOf,
      };
      cell.predictions = [...cell.predictions.slice(-(MAX_PREDICTIONS_PER_CELL - 1)), prediction];
      applied.push(d);
    } else if (d.field === 'intentions.append') {
      const body = d.delta as { description?: unknown; magnitude?: unknown; direction?: unknown };
      const magnitude = body?.magnitude;
      if (!boundedString(body?.description) || !boundedString(body?.direction)
          || typeof magnitude !== 'number' || !Number.isFinite(magnitude) || magnitude < 0 || magnitude > 1) {
        failed.push({ kind: 'stateDelta', reason: 'intentions.append malformed' });
        continue;
      }
      const tension: IntentionTension = {
        tensionId: deterministicId('tension', d.cellId, body.description),
        description: body.description,
        magnitude,
        direction: body.direction,
        createdAt: asOf,
        consequenceRefs: [],
        open: true,
      };
      cell.intentions = [...cell.intentions.slice(-(MAX_INTENTIONS_PER_CELL - 1)), tension];
      applied.push(d);
    } else if (d.field === 'predictions.resolve') {
      const body = d.delta as { predictionId?: unknown; error?: unknown };
      const idx = cell.predictions.findIndex((p) => p.predictionId === body?.predictionId);
      if (idx < 0) { failed.push({ kind: 'stateDelta', reason: `prediction ${String(body?.predictionId)} not found` }); continue; }
      const err = body?.error;
      const resolved: Prediction = {
        ...(cell.predictions[idx] as Prediction),
        resolvedAt: asOf,
        error: typeof err === 'number' && Number.isFinite(err) ? Math.max(0, Math.min(1, err)) : undefined,
      };
      cell.predictions = cell.predictions.map((p, i) => (i === idx ? resolved : p));
      applied.push(d);
    } else if (d.field === 'uncertainty.adjust') {
      const value = (d.delta as { value?: number }).value ?? 0;
      cell.uncertainty = Math.max(0, Math.min(1, cell.uncertainty + value));
      applied.push(d);
    }
  }

  // Cells that ended up unchanged (all their deltas failed) stay staged —
  // harmless — but drop clones with zero applied deltas for cleanliness.
  const touched = new Set(applied.map((d) => d.cellId));
  for (const id of Array.from(staged.keys())) {
    if (!touched.has(id)) staged.delete(id);
  }

  return { staged, applied, failed };
}

// ─── Deterministic echo lobe (tests + wiring proof) ──────────────────────────

/**
 * A lobe with no model behind it: deterministically proposes an interpretation
 * and an estimate derived from the packet's actual reality refs. Exists to
 * drive the full recruit → validate → stage → receipt path in tests and to
 * prove the protocol before a real model is recruited.
 */
export class EchoLobe implements LobeAdapter {
  readonly id = 'lobe.echo';
  readonly modelId = 'deterministic-echo';
  readonly provider = 'seed.internal';

  invoke(packet: WorkspacePacket): Promise<LobeResult> {
    const primary = packet.activeCellIds[0];
    const refCount = packet.eventRefs.length;
    const refDigest = createHash('sha256')
      .update(packet.eventRefs.map((r) => r.refId).join(','), 'utf-8')
      .digest('hex')
      .slice(0, 12);
    const result: LobeResult = {
      observations: [],
      interpretations: primary === undefined ? [] : [{
        cellId: primary,
        interpretation: `echo: ${refCount} refs (${refDigest})`,
        confidence: 0.5,
      }],
      predictions: [],
      stateDeltas: primary === undefined ? [] : [{
        cellId: primary,
        field: 'estimates.append',
        delta: { claim: `echo estimate over ${refCount} refs (${refDigest})`, confidence: 0.5, evidenceRefs: packet.eventRefs.slice(-3).map((r) => r.refId) },
        authority: 'propose',
      }],
      candidateForms: [],
      candidateActions: [],
      uncertainty: packet.uncertainty,
      evidenceRefs: packet.eventRefs.slice(-3),
      modelReceipt: {
        modelId: this.modelId,
        provider: this.provider,
        invokedAt: '1970-01-01T00:00:00.000Z', // deterministic — no wall clock
        durationMs: 0,
        tokensIn: 0,
        tokensOut: 0,
      },
    };
    return Promise.resolve(result);
  }
}

// ─── Model-backed lobe (transport injected; wired to Home23 providers by the runner) ─

export type LobeTransport = (prompt: string, packet: WorkspacePacket) => Promise<{
  text: string;
  modelReceipt: ModelReceipt;
}>;

/** Recruits a real model through an injected transport. The transport is
 * provided by the resident runner from Home23's existing provider contracts —
 * the substrate package itself holds no credentials and knows no endpoints. */
export class ModelLobe implements LobeAdapter {
  constructor(
    readonly id: string,
    readonly modelId: string,
    readonly provider: string,
    private readonly transport: LobeTransport,
  ) {}

  async invoke(packet: WorkspacePacket): Promise<LobeResult> {
    const prompt = buildLobePrompt(packet);
    const { text, modelReceipt } = await this.transport(prompt, packet);
    return parseLobeResponse(text, modelReceipt);
  }
}

export function buildLobePrompt(packet: WorkspacePacket): string {
  const cellIds = packet.activeCellIds;
  return [
    'You are a recruited cognitive lobe for a substrate Seed. You receive a typed',
    'workspace packet and return ONLY a JSON object — no prose around it.',
    '',
    `ADMITTED CELLS: ${JSON.stringify(cellIds)}`,
    'EVERY proposal object MUST carry a "cellId" field set to one of the admitted',
    'cells — proposals without a valid cellId are rejected unread.',
    '',
    'Exact response shape (arrays max 8 items each; omit empty arrays if you like):',
    '{',
    `  "observations": [{"cellId": "${cellIds[0] ?? 'CELL'}", "claim": "...", "confidence": 0.6, "evidenceRef": "refId"}],`,
    `  "interpretations": [{"cellId": "${cellIds[0] ?? 'CELL'}", "interpretation": "...", "confidence": 0.6}],`,
    `  "predictions": [{"cellId": "${cellIds[0] ?? 'CELL'}", "claim": "...", "confidence": 0.5, "horizon": "24h"}],`,
    `  "stateDeltas": [{"cellId": "${cellIds[0] ?? 'CELL'}", "field": "estimates.append", "delta": {"claim": "...", "confidence": 0.6, "evidenceRefs": []}, "authority": "propose"}],`,
    '  "uncertainty": 0.5',
    '}',
    '',
    `stateDeltas fields allowed: ${LOBE_DELTA_ALLOWLIST.join(', ')}.`,
    'estimates.append delta: {claim, confidence, evidenceRefs}. predictions.append',
    'delta: {claim, confidence, horizon}. intentions.append delta: {description,',
    'magnitude (0..1), direction}. predictions.resolve delta: {predictionId, error}.',
    'uncertainty.adjust delta: {value in [-0.2, 0.2]}.',
    'Claims are bounded at 500 chars. You are proposing typed state changes to a',
    'governed process — you are not writing memory, narrative, or identity.',
    'ONLY stateDeltas integrate into state. The observations/interpretations/',
    'predictions arrays are advisory context recorded in the receipt — anything',
    'you want REMEMBERED must be a stateDelta (a prediction you want held open',
    'must be a predictions.append delta, not just a predictions[] entry).',
    'Open predictions in the packet are DEBTS. When current evidence answers one',
    '(fulfilled, falsified, or past its horizon — each carries horizon+createdAt),',
    'RESOLVE it via predictions.resolve {predictionId, error: 0..1 magnitude of',
    'how wrong it was} instead of restating it. Resolution is how consequence',
    'reaches development; an answered prediction left open teaches nothing.',
    '',
    `PACKET: ${JSON.stringify(packet)}`,
  ].join('\n');
}

export function parseLobeResponse(text: string, modelReceipt: ModelReceipt): LobeResult {
  const jsonStart = text.indexOf('{');
  const jsonEnd = text.lastIndexOf('}');
  if (jsonStart < 0 || jsonEnd <= jsonStart) {
    throw new Error('lobe response contains no JSON object');
  }
  const parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1)) as Partial<LobeResult>;
  return {
    observations: Array.isArray(parsed.observations) ? parsed.observations : [],
    interpretations: Array.isArray(parsed.interpretations) ? parsed.interpretations : [],
    predictions: Array.isArray(parsed.predictions) ? parsed.predictions : [],
    stateDeltas: Array.isArray(parsed.stateDeltas) ? parsed.stateDeltas : [],
    candidateForms: [],
    candidateActions: [],
    uncertainty: typeof parsed.uncertainty === 'number' ? parsed.uncertainty : 0.5,
    evidenceRefs: [],
    modelReceipt,
  };
}
