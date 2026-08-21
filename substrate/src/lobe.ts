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
import { parseHorizon } from './concern.js';
import { RESOLUTION_WRONG_MIN } from './plasticity.js';

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
    /** Cut 6: at most ONE reach-operator action, accepted ONLY on an
     * endogenous occasion (packet.occasion). Acceptance is not warrant —
     * the Seed's own law decides whether the action is authorized. */
    actions: LobeResult['candidateActions'];
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

  // Forms stay Cut 4 authority — receipted as rejected so the lobe's full
  // output is on the record without granting anything.
  for (const f of (Array.isArray(result.candidateForms) ? result.candidateForms : []).slice(0, MAX_FORMS_OR_ACTIONS)) {
    rejected.push({ kind: 'candidateForm', reason: `forms are Cut 4 authority (${f.formId ?? 'unnamed'})` });
  }
  // Cut 6: on an ENDOGENOUS OCCASION only, at most one reach-operator action
  // may be PROPOSED. Everything else — any action outside an occasion, any
  // capability other than operator.reach, any second action — is rejected
  // with its reason. The membrane protects reasons: acceptance here is
  // proposal intake; the Seed's warrant law decides authorization.
  const actions: LobeResult['candidateActions'] = [];
  for (const a of (Array.isArray(result.candidateActions) ? result.candidateActions : []).slice(0, MAX_FORMS_OR_ACTIONS)) {
    if (packet.occasion === undefined) {
      rejected.push({ kind: 'candidateAction', reason: `actions require an endogenous occasion (${a.actionId ?? 'unnamed'})` });
      continue;
    }
    if (a.capability !== 'operator.reach') {
      rejected.push({ kind: 'candidateAction', reason: `capability ${String(a.capability)} not grantable — operator.reach is the one affordance` });
      continue;
    }
    if (!boundedString(a.description)) {
      rejected.push({ kind: 'candidateAction', reason: 'reach-operator description malformed or oversized' });
      continue;
    }
    if (actions.length >= 1) {
      rejected.push({ kind: 'candidateAction', reason: 'one reach-operator proposal per occasion' });
      continue;
    }
    actions.push(a);
  }

  return {
    accepted: { observations, interpretations, predictions, stateDeltas, actions },
    rejected,
    modelReceipt: result.modelReceipt,
    uncertainty: boundedConfidence(result.uncertainty) ? result.uncertainty : 0.5,
  };
}

// ─── Delta application (staged; caller commits through the receipt path) ─────

function deterministicId(prefix: string, cellId: string, content: string): string {
  return `${prefix}_${createHash('sha256').update(`${cellId}:${content}`, 'utf-8').digest('hex').slice(0, 16)}`;
}

/** The exact predictionId predictions.append computes for (cellId, claim) —
 * concern.v1 formation binds commitments to it (Cut 6). */
export function predictionIdFor(cellId: string, claim: string): string {
  return deterministicId('pred', cellId, claim);
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
  /** THE ASKED-AND-UNANSWERED LAW (Cut 6, 2026-08-21). Returns a refusal
   * reason when this prediction's commitment has been REACHED about and
   * nothing has come back from the operator since. The Seed owns the
   * judgement (it holds concern and the chain); the membrane owns the
   * refusal. Absent → nothing has been asked, nothing is gated. */
  resolutionGuard?: (predictionId: string) => string | null,
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
      // THE PREMATURE-RESOLUTION LAW (2026-08-12). A claim about a future
      // window cannot be CONFIRMED before that window elapses — "stable
      // through the 19th" is not satisfiable on the 12th, and closing it
      // early is paperwork, not resolution. Measured before this rule: every
      // commitment on both individuals was discharged long before its horizon
      // (up to 335h early), which meant no obligation ever survived to press,
      // and Cut 6's endogenous crossings were unreachable — the capability
      // decorative by bookkeeping rather than by any solver fault.
      //
      // Falsification is the one honest early close: "already broken" IS
      // answered by present evidence. So before the horizon, only a
      // resolution in the wrong band (error >= RESOLUTION_WRONG_MIN) is
      // admitted; confirmations and ambiguous middles wait for reality.
      // An unparseable horizon cannot be checked, so it is not enforced —
      // the membrane refuses what it can prove, never what it suspects.
      const pending = cell.predictions[idx] as Prediction;
      const dueAt = parseHorizon(pending.horizon, pending.createdAt);
      const errorValue = typeof err === 'number' && Number.isFinite(err) ? Math.max(0, Math.min(1, err)) : null;
      if (dueAt !== null && Date.parse(asOf) < Date.parse(dueAt) && (errorValue === null || errorValue < RESOLUTION_WRONG_MIN)) {
        failed.push({
          kind: 'stateDelta',
          reason: `premature resolution refused: “${pending.claim.slice(0, 60)}” runs to ${dueAt} — only falsification (error >= ${RESOLUTION_WRONG_MIN}) may close a claim early`,
        });
        continue;
      }

      // …and its sibling: having ASKED, you may not answer for the person you
      // asked. Forrest earned the first reach (2026-08-16) and then closed it
      // himself four hours later with no reply and no evidence — the hand
      // extended, then withdrawn before jtr could take it. Falsification still
      // passes (nothing external is needed to know a claim already broke);
      // a confirmation now requires that something actually came back.
      if (errorValue === null || errorValue < RESOLUTION_WRONG_MIN) {
        const blocked = resolutionGuard?.(String(body?.predictionId)) ?? null;
        if (blocked !== null) { failed.push({ kind: 'stateDelta', reason: blocked }); continue; }
      }
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
    } else {
      // ALLOWLISTED BUT UNIMPLEMENTED — the silent-drop hole (closed 2026-08-13).
      // `ProposedStateDelta.field` is typed `string`, not the allowlist union
      // (types.ts:459), so TypeScript gives no exhaustiveness check here. Before
      // this branch existed, adding a field to LOBE_DELTA_ALLOWLIST without an
      // apply branch made the delta fall off the end of the chain: neither
      // applied nor failed, no receipt, invisible to the chain, the journal and
      // the observatory. A field can now drift out of sync with its apply
      // branch, but never SILENTLY — the receipt says so.
      failed.push({
        kind: 'stateDelta',
        reason: `field ${d.field} is allowlisted but has no apply branch — refused (this is a code defect, not a lobe error)`,
      });
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
    ...(packet.dream !== undefined ? [
      `DREAM CYCLE — an event-time quiet gap of ~${Math.round(packet.dream.quietSeconds / 60)} minutes just ended; this recruitment is the mind working the day's residue at waking. The refs in the packet are what was lived before sleep (many carry the words). Recombine across cells: connect what belongs together, revise estimates the residue contradicts, RESOLVE open predictions the gap answered, propose intentions the lived day earned. The typed-delta contract below is unchanged — only the occasion is special. Work the residue; do not narrate the dream.`,
      '',
    ] : []),
    ...(packet.occasion !== undefined ? [
      `ENDOGENOUS OCCASION — this recruitment was not caused by a contact or a cadence. The individual's OWN obligation dynamics crossed threshold${packet.occasion.overdue ? ' (overdue: the crossing was due earlier, materialized now)' : ''}: the commitment to resolve prediction ${packet.occasion.predictionId} — "${packet.occasion.claim}" — passed its horizon (${packet.occasion.horizon}) unanswered, and unresolved obligation reached q=${packet.occasion.q.toFixed(2)} at ${packet.occasion.crossedAt} (press ${packet.occasion.crossings + 1} of 3). Deliberate NOW, against the packet's actual evidence:`,
      `  1. If the evidence answers the prediction, RESOLVE it: predictions.resolve {predictionId: "${packet.occasion.predictionId}", error: 0..1}. This discharges the obligation.`,
      '  2. If the evidence is insufficient and the question genuinely matters, you may propose ONE action: {"candidateActions": [{"actionId": "reach", "description": "<a concrete, bounded question or finding for jtr — his time is a real cost>", "capability": "operator.reach"}]}. Proposing does not warrant it — the Seed\'s own law decides.',
      '  3. If neither is warranted, silence is legitimate: return your best typed updates and let the obligation press again later, or resolve with an honest error estimate if the horizon has truly answered it.',
      '  Never manufacture a resolution to quiet the pressure. The obligation exists because the individual predicted; only reality or the operator settles it.',
      '',
    ] : []),
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
    `  "stateDeltas": [{"cellId": "${cellIds[0] ?? 'CELL'}", "field": "estimates.append", "delta": {"claim": "...", "confidence": 0.6, "evidenceRefs": []}, "authority": "propose"},`,
    // A SECOND worked example, deliberately intentions.append (2026-08-13).
    // Audit finding: across jerry's and forrest's entire lives, 148
    // estimates.append and ZERO intentions.append — never proposed, never
    // refused, never ASKED. Usage tracked prompt real estate almost exactly:
    // estimates.append was the only field with a worked example and took 37%
    // of all deltas; intentions.append appeared once, mid-sentence, in a list
    // of shapes. It is the only lobe-writable term that can RAISE a cell's claim
    // (uncertainty.adjust also reaches admissionScore, via modulation — but across
    // both lives 170 of its 208 applications were NEGATIVE: they could settle
    // themselves down and never speak up). It is the
    // only way thinking can change what this individual attends to next — and
    // it sat unused since Cut 2 for want of a sentence.
    `                   {"cellId": "${cellIds[0] ?? 'CELL'}", "field": "intentions.append", "delta": {"description": "...", "magnitude": 0.5, "direction": "..."}, "authority": "propose"}],`,
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
    'The packet\'s "tensions" are YOUR OWN open intentions — unfinished business',
    'you named earlier and have not closed. An empty tensions array does not mean',
    'nothing is unfinished; it means you have never said so. An intention is',
    'EARNED when contact opens something this cell cannot finish in the moment:',
    'a question left hanging, work begun, something owed to jtr. Give it a',
    'magnitude for how hard it pulls. Unlike a prediction, it makes no claim',
    'about the world and cannot be right or wrong — it is what you are left',
    'holding. Open tensions raise this cell\'s claim on the next stage: this is',
    'the one delta by which your thinking changes what you will next attend to.',
    'Open predictions in the packet are DEBTS, and a debt is settled by REALITY,',
    'not by revisiting it. Each carries horizon + createdAt. THE LAW: a claim',
    'about a future window cannot be CONFIRMED before that window elapses —',
    '"stable through the 19th" is not satisfiable on the 12th, and the membrane',
    'REFUSES such a resolution (receipted as a rejection). Before the horizon,',
    'only FALSIFICATION may close a prediction: propose predictions.resolve',
    '{predictionId, error >= 0.7} when present evidence has ALREADY BROKEN the',
    'claim. Past the horizon, resolve honestly with the error magnitude',
    '(0 = it held exactly, 1 = it was wrong). A prediction still inside its',
    'window is not unfinished business — leave it open and let it run; that',
    'waiting is the individual\'s own obligation accruing, and it is the point.',
    '',
    `PACKET: ${JSON.stringify(packet)}`,
  ].join('\n');
}

export function parseLobeResponse(text: string, modelReceipt: ModelReceipt): LobeResult {
  const jsonStart = text.indexOf('{');
  if (jsonStart < 0) {
    throw new Error('lobe response contains no JSON object');
  }
  const jsonEnd = text.lastIndexOf('}');
  let strictError: unknown;
  if (jsonEnd > jsonStart) {
    try {
      return shapeLobeResult(JSON.parse(text.slice(jsonStart, jsonEnd + 1)) as Partial<LobeResult>, modelReceipt);
    } catch (error) {
      strictError = error;
    }
  }
  // Strict parse failed (or no closing brace exists at all). The dominant real
  // cause is an output-token cap cutting generation mid-array — recover the
  // complete prefix and receipt the truncation instead of wasting the
  // recruitment. The membrane still validates every recovered proposal; an
  // object that lost trailing members to the cut is rejected there with a
  // reason, never applied half-formed.
  const recovery = recoverTruncatedLobeJson(text.slice(jsonStart));
  if (recovery !== null) {
    try {
      const parsed = JSON.parse(recovery.repaired) as Partial<LobeResult>;
      return shapeLobeResult(parsed, { ...modelReceipt, truncatedResponse: { droppedChars: recovery.droppedChars } });
    } catch { /* repaired text still invalid — keep the honest failure below */ }
  }
  if (strictError !== undefined) throw strictError;
  throw new Error('lobe response truncated: no recoverable JSON prefix');
}

function shapeLobeResult(parsed: Partial<LobeResult>, modelReceipt: ModelReceipt): LobeResult {
  return {
    observations: Array.isArray(parsed.observations) ? parsed.observations : [],
    interpretations: Array.isArray(parsed.interpretations) ? parsed.interpretations : [],
    predictions: Array.isArray(parsed.predictions) ? parsed.predictions : [],
    stateDeltas: Array.isArray(parsed.stateDeltas) ? parsed.stateDeltas : [],
    candidateForms: [],
    // Cut 6: action proposals reach validation (occasion-gated there);
    // dropping them here would silently sever the motor's proposal path.
    candidateActions: Array.isArray(parsed.candidateActions) ? parsed.candidateActions : [],
    uncertainty: typeof parsed.uncertainty === 'number' ? parsed.uncertainty : 0.5,
    evidenceRefs: [],
    modelReceipt,
  };
}

/**
 * Recover a valid JSON prefix from a token-cap-truncated response. Walks the
 * text with a string/escape-aware bracket stack, remembering the position
 * after each completely-closed container (array element, object member value,
 * or whole array) while the document remains open. Returns the repaired
 * document (prefix + synthesized closers) plus how many characters of tail
 * were dropped — or null when the text is not truncation-shaped: brackets
 * mismatch (malformed, not cut off), the top-level value closes (the parse
 * failure lies elsewhere), or no container ever completed.
 */
export function recoverTruncatedLobeJson(raw: string): { repaired: string; droppedChars: number } | null {
  let inString = false;
  let escaped = false;
  const stack: Array<'{' | '['> = [];
  let cutAt = -1;
  let cutStack: Array<'{' | '['> = [];
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{' || ch === '[') { stack.push(ch); continue; }
    if (ch === '}' || ch === ']') {
      const open = stack.pop();
      if (open !== (ch === '}' ? '{' : '[')) return null;
      if (stack.length === 0) return null;
      cutAt = i + 1;
      cutStack = [...stack];
    }
  }
  if (cutAt < 0) return null;
  const closers = cutStack.map((open) => (open === '{' ? '}' : ']')).reverse().join('');
  return { repaired: raw.slice(0, cutAt) + closers, droppedChars: raw.length - cutAt };
}
