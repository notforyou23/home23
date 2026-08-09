/**
 * Home23 Substrate OS — Cut 1 Body
 * Full contract surface for all five cuts. Cut 1 implements Body; later cuts
 * fill Metabolism, Development, Expression, and Growth-Pressure.
 *
 * Do not add synthetic fields. State is typed structure and continuous bytes,
 * never prose autobiography.
 */

// ─── Event & Source ──────────────────────────────────────────────────────────

export type EventCategory =
  | 'observation'
  | 'interpretation'
  | 'proposal'
  | 'act'
  | 'consequence'
  | 'correction'
  | 'transition'
  | 'checkpoint'
  | 'genesis'
  | 'stop'
  // Cut 2 receipt categories: workspace admission, explicit silence, lobe results.
  | 'workspace'
  | 'silence'
  | 'lobe'
  // Cut 3: receipted developmental deltas (plasticity, consolidation, ablation).
  | 'development';

export type SourceAuthority =
  | 'home23.engine'
  | 'home23.agent.loop'
  | 'home23.channel.bus'
  | 'home23.event-ledger'
  | 'seed.internal'
  | 'seed.adapter'
  | 'external.inert';

export type VerificationFlag = 'COLLECTED' | 'UNCERTIFIED' | 'ZERO_CONTEXT' | 'UNKNOWN';

/** Immutable reference into an external reality event. Never the Seed's rewrite. */
export interface RealityRef {
  refId: string;
  sourceAuthority: SourceAuthority;
  sourceRef: string;
  observedAt: string;
  confidence: number;
  flag: VerificationFlag;
  /** Bounded head of the referenced reality's own words, when the source
   * line carried language (a conversation turn, a correction's text).
   * Lifted at intake from the event payload — recruited lobes finally READ
   * the life they are reasoning about instead of inferring rhythm from
   * reference metadata. Optional: telemetry refs stay wordless. */
  head?: string;
}

export interface Estimate {
  estimateId: string;
  claim: string;
  confidence: number;                // 0..1
  evidenceRefs: string[];
  createdAt: string;
  expiresAt?: string;
}

export interface IntentionTension {
  tensionId: string;
  description: string;
  magnitude: number;                 // 0..1
  direction: string;
  createdAt: string;
  consequenceRefs: string[];
  open: boolean;
}

export interface Prediction {
  predictionId: string;
  claim: string;
  confidence: number;                // 0..1
  horizon: string;                   // ISO timestamp or relative label
  createdAt: string;
  resolvedAt?: string;
  error?: number;                    // prediction error on resolution
}

export interface CellDispositions {
  wakeThreshold: number;             // 0..1
  salienceWeight: number;            // 0..1
  inhibitionLevel: number;           // 0..1
  decayRate: number;                 // fraction per transition (0..1)
  modelAffinities: Record<string, number>;
}

export interface AssociationRef {
  targetCellId: string;
  strength: number;                  // 0..1
  type: 'resonance' | 'contrast' | 'dependency';
}

export interface CellEnergy {
  current: number;                   // 0..1
  peak: number;
  lastSpikeAt?: string;
}

export interface DeltaRef {
  deltaId: string;
  description: string;
  appliedAt: string;
  rolledBackAt?: string;
  consequenceRef?: string;
  authority: 'provisional' | 'consolidated';
}

// ─── Situation Cell ───────────────────────────────────────────────────────────

export type CellStatus = 'forming' | 'living' | 'quiet' | 'dormant' | 'dissolving';

/**
 * Live in-memory form. continuousState is a real Float32Array — not reconstructed
 * from prose. Serialized to/from base64 bytes in checkpoints.
 */
export interface SituationCell {
  id: string;
  generation: number;
  status: CellStatus;
  realityRefs: RealityRef[];
  estimates: Estimate[];
  intentions: IntentionTension[];
  predictions: Prediction[];
  continuousState: Float32Array;     // CONTINUOUS_STATE_DIM floats
  dispositions: CellDispositions;
  associations: AssociationRef[];
  lobeAffinities: Record<string, number>;
  workspacePressure: number;         // 0..1
  interruptionPressure: number;      // 0..1
  uncertainty: number;               // 0..1
  energy: CellEnergy;
  developmentalLineage: DeltaRef[];
  lastTransitionAt: string;
}

/** Serialized cell: Float32Array stored as base64 for JSON/checkpoint. */
export interface SerializedCell extends Omit<SituationCell, 'continuousState'> {
  continuousState: string;           // base64 of Float32Array raw bytes
  continuousStateDimension: number;
}

/** Dimension of the continuous state vector per cell. Fixed for Cut 1. */
export const CONTINUOUS_STATE_DIM = 64;

/** Anatomy as a birth parameter: each cell claims a routing role — which
 * event category it is the static target for. Exactly one cell should carry
 * 'periphery' (the default target for unclaimed categories). Recorded in the
 * ledger genesis at birth; identity includes anatomy. */
export interface AnatomyCellSpec {
  id: string;
  role: 'correction' | 'observation' | 'consequence' | 'interpretation' | 'periphery';
}

/** The default anatomy (the first individual's shape). Births may pass their
 * own — a birth is a deliberate act, and cells should name the individual's
 * OWN situations. */
export const DEFAULT_ANATOMY: readonly AnatomyCellSpec[] = [
  { id: 'contact.jtr-jerry', role: 'correction' },
  { id: 'frontier.substrate-os', role: 'interpretation' },
  { id: 'project.shakedown', role: 'consequence' },
  { id: 'world.home23', role: 'observation' },
  { id: 'periphery.open-field', role: 'periphery' },
] as const;

/** The five canonical initial cell IDs (default anatomy). */
export const INITIAL_CELL_IDS = [
  'contact.jtr-jerry',
  'frontier.substrate-os',
  'project.shakedown',
  'world.home23',
  'periphery.open-field',
] as const;

export type InitialCellId = (typeof INITIAL_CELL_IDS)[number];

// ─── Seed Dispositions ────────────────────────────────────────────────────────

export interface SeedDispositions {
  globalWakeThreshold: number;       // 0..1
  silencePolicy: 'default' | 'strict';
  modelRecruitmentPolicy: 'none' | 'on-demand';
  quietTimeEnabled: boolean;
}

// ─── Ledger ───────────────────────────────────────────────────────────────────

/**
 * One record in the trusted Seed ledger. Records are hash-chained and never
 * rewritten. The Seed may dispute an observation; it cannot alter the source event.
 */
export interface LedgerRecord {
  schema: 'home23.seed.ledger.v1';
  seq: number;                       // monotonic across restarts
  prevHash: string;                  // sha256hex of prev JSON line, or 'GENESIS'
  recordId: string;
  category: EventCategory;
  sourceAuthority: SourceAuthority;
  sourceRef: string;
  payload: Record<string, unknown>;
  stateHashBefore?: string;
  stateHashAfter?: string;
  issuedAt: string;
  branchId?: string;                 // for replay/fork tracking
  replayFromSeq?: number;
}

export interface LedgerVerifyResult {
  ok: boolean;
  totalRecords: number;
  errors: Array<{
    seq: number;
    type: 'invalid_json' | 'prev_hash_mismatch' | 'seq_break' | 'schema_invalid';
    detail: string;
  }>;
}

// ─── Checkpoint ───────────────────────────────────────────────────────────────

export interface ResourceSnapshot {
  stateBytesPerCell: Record<string, number>;
  ledgerBytes: number;
  eventCount: number;
  transitionCount: number;
  checkpointCount: number;
}

export interface CheckpointManifest {
  schema: 'home23.seed.checkpoint.v1';
  version: number;
  checkpointId: string;
  stateHash: string;
  ledgerSeq: number;
  ledgerCursor: string;              // sha256hex of last ledger record's JSON line
  createdAt: string;
  resourceSnapshot: ResourceSnapshot;
  cells: SerializedCell[];
  dispositions: SeedDispositions;
  /** Cut 3 (manifest version >= 2): the seed-level developmental state — the
   * ablation target. Shape owned by plasticity.ts; stored verbatim, inside
   * the state hash for v2 manifests. */
  development?: Record<string, unknown>;
  /** Seed-level event-time of the last transition — restores the quiet-gap
   * clock so consolidation triggers replay exactly. Outside the state hash
   * (same trust tier as ledgerSeq/cursor); older manifests fall back to
   * createdAt. */
  seedLastTransitionAt?: string;
}

export interface CheckpointIndex {
  schema: 'home23.seed.checkpoint-index.v1';
  checkpoints: Array<{
    checkpointId: string;
    stateHash: string;
    ledgerSeq: number;
    createdAt: string;
    path: string;
  }>;
}

// ─── Capability Membrane ─────────────────────────────────────────────────────

export type Capability =
  // Cut 1 allowed
  | 'local.ledger.append'
  | 'local.state.read'
  | 'local.state.write'
  | 'local.checkpoint.write'
  | 'local.checkpoint.read'
  | 'local.source.ingest'
  | 'local.resource.account'
  // Cut 2 allowed: recruit an approved model lobe through injected transport
  | 'lobe.recruit.model'
  // Forbidden — developmental authority not granted in Cut 1
  | 'home23.engine.modify'
  | 'home23.config.modify'
  | 'home23.memory.write'
  | 'home23.identity.modify'
  | 'home23.relationship.modify'
  | 'home23.agency.modify'
  | 'home23.cron.modify'
  | 'home23.project.modify'
  | 'net.publish'
  | 'net.message.external'
  | 'device.control'
  | 'script.execute'
  | 'secret.read'
  | 'membrane.modify'
  | 'ledger.trusted.modify'
  | 'seed.replicate'
  | 'seed.authority.expand';

export class CapabilityDeniedError extends Error {
  constructor(
    public readonly capability: string,
    public readonly reason: string,
  ) {
    super(`Capability denied: ${capability} — ${reason}`);
    this.name = 'CapabilityDeniedError';
  }
}

// ─── Resource Budget ─────────────────────────────────────────────────────────

export interface ResourceBudget {
  maxStateBytesPerCell: number;
  maxLedgerBytes: number;
  maxEventCount: number;
  maxTransitionCount: number;
  maxCheckpointCount: number;
}

export class ResourceBudgetExceededError extends Error {
  constructor(
    public readonly resource: string,
    public readonly current: number,
    public readonly limit: number,
  ) {
    super(`Resource budget exceeded: ${resource} — ${current} > ${limit}`);
    this.name = 'ResourceBudgetExceededError';
  }
}

export const DEFAULT_RESOURCE_BUDGET: ResourceBudget = {
  maxStateBytesPerCell: 256 * 1024,   // 256KB per cell
  maxLedgerBytes: 50 * 1024 * 1024,   // 50MB
  maxEventCount: 100_000,
  maxTransitionCount: 50_000,
  maxCheckpointCount: 100,
};

// ─── Source Events & Transitions ─────────────────────────────────────────────

/** An inert typed source event entering through a source adapter. */
export interface SourceEvent {
  eventId: string;
  category: EventCategory;
  sourceAuthority: SourceAuthority;
  sourceRef: string;
  targetCellId?: string;             // hint; membrane and routing may override
  payload: Record<string, unknown>;
  producedAt: string;
  /** Meaning, perceived ONCE at contact (encoder stage 1): a small projected
   * embedding produced by the writer's machine and carried on the event
   * record forever. Replay never re-perceives — the record is what was seen.
   * Absent → the event encodes by identity hash exactly as before. */
  semanticVector?: number[];
}

export interface TransitionResult {
  seq: number;
  stateHashBefore: string;
  stateHashAfter: string;
  ledgerCursor: string;              // sha256hex of the ledger record just written
  cellId: string;
  elapsedMs: number;
}

// ─── Seed State ───────────────────────────────────────────────────────────────

export interface SeedState {
  seedId: string;
  schema: 'home23.seed.state.v1';
  cellIds: string[];                 // ordered list; Map is in SeedProcess
  dispositions: SeedDispositions;
  stateHash: string;
  ledgerSeq: number;
  ledgerCursor: string;
  createdAt: string;
  lastTransitionAt: string;
  transitionCount: number;
  eventCount: number;
  /** Total learned mass (Cut 3) — 0 on a fresh or ablated seed. */
  developmentMagnitude: number;
}

// ─── Cut 2+ interfaces (preserved architecture) ──────────────────────────────

export interface TensionProjection {
  tensionId: string;
  cellId: string;
  magnitude: number;
  direction: string;
}

export interface PredictionProjection {
  predictionId: string;
  cellId: string;
  claim: string;
  confidence: number;
  /** The lobe needs deadline context to judge whether evidence has answered
   * an open prediction — without these it can only restate, never resolve. */
  horizon: string;
  createdAt: string;
}

export type AuthorityLevel = 'observe' | 'propose' | 'propose-and-checkpoint';

export interface LobeOutputContract {
  allowedOutputKinds: string[];
  maxTokenBudget: number;
}

/** Scarce global workspace packet (Cut 2). */
export interface WorkspacePacket {
  activeCellIds: string[];
  eventRefs: RealityRef[];
  tensions: TensionProjection[];
  predictions: PredictionProjection[];
  uncertainty: number;
  requestedCapability: string;
  authorityCeiling: AuthorityLevel;
  tokenBudget: number;
  outputContract: LobeOutputContract;
}

export interface ProposedObservation { cellId: string; claim: string; confidence: number; evidenceRef: string; }
export interface ProposedInterpretation { cellId: string; interpretation: string; confidence: number; }
export interface ProposedPrediction { cellId: string; claim: string; confidence: number; horizon: string; }
export interface ProposedStateDelta { cellId: string; field: string; delta: unknown; authority: string; }
export interface ProposedForm { formId: string; title: string; authority: 'private-readonly' | 'private-sandbox'; }
export interface ProposedAction { actionId: string; description: string; capability: Capability; }

export interface ModelReceipt {
  modelId: string;
  provider: string;
  invokedAt: string;
  durationMs: number;
  tokensIn: number;
  tokensOut: number;
  requestId?: string;
  /** Present when the response text was cut off (output-token cap) and a
   * valid JSON prefix was recovered; droppedChars counts the discarded tail.
   * Absence means the response parsed whole. */
  truncatedResponse?: { droppedChars: number };
}

/** Lobe result (Cut 2). Models return typed proposals; never direct state writes. */
export interface LobeResult {
  observations: ProposedObservation[];
  interpretations: ProposedInterpretation[];
  predictions: ProposedPrediction[];
  stateDeltas: ProposedStateDelta[];
  candidateForms: ProposedForm[];
  candidateActions: ProposedAction[];
  uncertainty: number;
  evidenceRefs: RealityRef[];
  modelReceipt: ModelReceipt;
}

/** Private form manifest (Cut 4). */
export interface FormManifest {
  formId: string;
  originatingCellIds: string[];
  intentionRefs: string[];
  realityRefs: RealityRef[];
  generatedAt: string;
  generatorReceipt: ModelReceipt;
  authority: 'private-readonly' | 'private-sandbox';
  expiryOrReview: string;
  consequenceRefs: RealityRef[];
}

/** Source adapter interface — append-only intake, no direct mutable-internal imports. */
export interface SourceAdapter {
  readonly id: string;
  readonly authority: SourceAuthority;
  pull(): Promise<SourceEvent[]>;
}

// ─── Workspace outcomes (Cut 2) ──────────────────────────────────────────────

export interface CellAdmissionScore {
  cellId: string;
  score: number;
  admitted: boolean;
}

/** Silence is a transition outcome, not a missing response. Receipted. */
export interface SilenceOutcome {
  kind: 'silence';
  reason: 'below-threshold' | 'no-active-cells';
  topScore: number;
  threshold: number;
  scores: CellAdmissionScore[];
}

export interface WorkspaceAdmission {
  kind: 'workspace';
  packet: WorkspacePacket;
  scores: CellAdmissionScore[];
}

export type WorkspaceOutcome = WorkspaceAdmission | SilenceOutcome;
