export type BrainTargetSelector = { agent?: string; brainId?: string };
export type OwnedRunTargetSelector = { runId: string };

export type BrainOperationState =
  | 'queued' | 'running' | 'complete' | 'partial'
  | 'failed' | 'cancelled' | 'interrupted';

export type AttachmentState = 'attached' | 'detached' | 'closed';

export interface BrainCatalogEntry {
  id: string;
  displayName: string;
  ownerAgent: string | null;
  kind: 'resident' | 'research';
  lifecycle: 'resident' | 'active' | 'completed' | 'unavailable';
  canonicalRoot: string;
  sourceType: string;
  nodeCount: number | null;
  modifiedAt: string;
  route: string;
  mutationBoundaries: Array<{
    kind: 'brain' | 'run' | 'pgs' | 'session' | 'cache' | 'export' | 'agency';
    path: string;
  }>;
}

export interface BrainCatalog {
  catalogRevision: string;
  brains: BrainCatalogEntry[];
}

export interface QueryModelCatalogEntry {
  id: string;
  name?: string | null;
  provider: string;
  providerLabel?: string | null;
  kind?: string | null;
  source?: string | null;
}

export interface QueryCapabilityCatalog {
  available: boolean;
  reason?: string | null;
  models: QueryModelCatalogEntry[];
  defaults: Record<string, unknown>;
  streaming?: boolean;
  limits?: Record<string, unknown>;
}

export interface ResearchRunSummary {
  runId: string;
  ownerAgent: string;
  operationId: string;
  state: string;
  topic: string;
  createdAt: string | null;
  startedAt: string | null;
  updatedAt: string;
  completedAt: string | null;
  stoppedAt: string | null;
  continuable: boolean;
  stoppable: boolean;
  error: Record<string, unknown> | null;
}

export interface ResearchRunList {
  state: 'recent' | 'active';
  runs: ResearchRunSummary[];
  count: number;
}

export interface ActiveResearchRun {
  active: boolean;
  runName?: string;
  topic?: string;
  startedAt?: string;
  processCount?: number | null;
  state?: string;
  operationId?: string;
}

export interface ResolvedBrainTarget extends BrainCatalogEntry {
  accessMode: 'own' | 'read-only';
  catalogRevision: string;
}

export interface CanonicalBrainOperationTarget {
  domain: 'brain';
  brainId: string;
  ownerAgent: string | null;
  displayName: string;
  kind: 'resident' | 'research';
  lifecycle: 'resident' | 'active' | 'completed' | 'unavailable';
  catalogRevision: string;
  route: string;
  canonicalRoot: string;
  accessMode: 'own' | 'read-only';
  mutationBoundaries: BrainCatalogEntry['mutationBoundaries'];
}

export interface OperationActivity {
  source: 'brain_operation';
  operationId: string;
  type: BrainOperationNotification['type'];
  eventSequence: number;
  /** @deprecated Use eventSequence in durable receipts. */
  sequence: number;
  state: BrainOperationState;
  phase: string | null;
  updatedAt: string;
  lastProviderActivityAt: string | null;
  lastProgressAt: string | null;
  provider?: string;
  model?: string;
  providerCallId?: string;
  outcome?: 'complete' | 'partial' | 'failed' | 'cancelled' | 'aborted';
  workUnitId?: string;
  partitionId?: string;
}

export interface BrainOperationRecord {
  operationId: string;
  requestId: string;
  operationType: string;
  requestParameters: Record<string, unknown>;
  parameters: Record<string, unknown>;
  canonicalEvidence: boolean;
  recordVersion: number;
  eventSequence: number;
  requesterAgent: string;
  target:
    | CanonicalBrainOperationTarget
    | { domain: 'owned-run'; runId: string; canonicalRoot: string;
        ownerAgent: string; runState: string; catalogRevision: string; route: string;
        mutationBoundaries: BrainCatalogEntry['mutationBoundaries'] }
    | { domain: 'requester'; requesterAgent: string };
  state: BrainOperationState;
  phase: string | null;
  startedAt: string | null;
  updatedAt: string;
  completedAt: string | null;
  lastProviderActivityAt: string | null;
  lastProgressAt: string | null;
  result: Record<string, unknown> | null;
  resultHandle: string | null;
  resultArtifact: { mediaType: string; contentEncoding: 'identity'; bytes: number; sha256: string } | null;
  error: { code: string; message: string; retryable: boolean } | null;
  sourceEvidence: Record<string, unknown> | null;
  sourcePinDescriptor: Record<string, unknown> | null;
  sourcePinDigest: string | null;
  sourcePinReleasedAt: string | null;
  resultExpiresAt: string | null;
  resultExpiredAt: string | null;
  metadataExpiresAt: string | null;
  pgsSession?: Record<string, unknown> | null;
}

export type BrainNonterminalOperation = Pick<BrainOperationRecord,
  | 'operationId' | 'requestId' | 'operationType' | 'requesterAgent' | 'target'
  | 'phase' | 'recordVersion' | 'eventSequence' | 'startedAt' | 'updatedAt'
  | 'lastProviderActivityAt' | 'lastProgressAt'> & {
    state: 'queued' | 'running';
  };

export interface BrainOperationSummary {
  operationId: string;
  requestId: string;
  operationType: string;
  requesterAgent: string;
  target: BrainOperationRecord['target'];
  state: BrainOperationState;
  phase: string | null;
  startedAt: string | null;
  updatedAt: string;
  completedAt: string | null;
  lastProviderActivityAt: string | null;
  lastProgressAt: string | null;
  error: BrainOperationRecord['error'];
  resultHandle: string | null;
  pgsSession: Record<string, unknown> | null;
}

export interface BrainOperationEventGap {
  type: 'event_gap';
  operationId: string;
  oldestSequence: number;
  latestSequence: number;
  eventSequence?: number;
  currentStatus?: BrainOperationRecord;
}

export type BrainOperationNotificationType =
  | 'heartbeat'
  | 'phase'
  | 'progress'
  | 'progress_update'
  | 'provider_activity'
  | 'provider_call_terminal'
  | 'provider_selected'
  | 'result_ready'
  | 'source_pin_attached'
  | 'state'
  | 'terminal'
  | 'token'
  | 'token_estimate'
  | 'worker_assigned';

interface BrainOperationNotificationBase {
  type: BrainOperationNotificationType;
  operationId: string;
  eventSequence: number;
  sequence?: number;
  at?: string;
  state?: BrainOperationState;
  phase?: string | null;
  updatedAt?: string;
  lastProviderActivityAt?: string | null;
  lastProgressAt?: string | null;
}

export interface BrainOperationProgressNotification extends BrainOperationNotificationBase {
  type: 'progress' | 'progress_update' | 'token' | 'token_estimate';
  completed?: number;
  total?: number;
}

export interface BrainOperationPhaseNotification extends BrainOperationNotificationBase {
  type: 'phase';
  phase: string;
}

export interface BrainOperationTerminalNotification extends BrainOperationNotificationBase {
  type: 'terminal';
  state: Extract<BrainOperationState, 'complete' | 'partial' | 'failed' | 'cancelled' | 'interrupted'>;
}

export interface BrainOperationStateNotification extends BrainOperationNotificationBase {
  type: 'state';
  state: BrainOperationState;
}

export interface BrainOperationHeartbeatNotification extends BrainOperationNotificationBase {
  type: 'heartbeat';
  state: BrainOperationState;
  phase: string | null;
  updatedAt: string;
  lastProviderActivityAt: string | null;
  lastProgressAt: string | null;
}

export interface BrainOperationProviderNotification extends BrainOperationNotificationBase {
  type: 'provider_selected' | 'provider_activity' | 'provider_call_terminal';
  provider?: string;
  model?: string;
  providerCallId?: string;
  outcome?: 'complete' | 'partial' | 'failed' | 'cancelled' | 'aborted';
  workUnitId?: string;
  partitionId?: string;
}

export interface BrainOperationLifecycleNotification extends BrainOperationNotificationBase {
  type: 'result_ready' | 'source_pin_attached' | 'worker_assigned';
}

export type BrainOperationNotification =
  | BrainOperationProgressNotification
  | BrainOperationPhaseNotification
  | BrainOperationTerminalNotification
  | BrainOperationStateNotification
  | BrainOperationHeartbeatNotification
  | BrainOperationProviderNotification
  | BrainOperationLifecycleNotification;

export type BrainOperationEvent = BrainOperationNotification | BrainOperationEventGap;

export interface BrainOperationResultEnvelope {
  operationId: string;
  state: BrainOperationState;
  result: Record<string, unknown> | null;
  resultHandle: string | null;
  resultArtifact: { mediaType: string; contentEncoding: 'identity'; bytes: number; sha256: string } | null;
  error: { code: string; message: string; retryable: boolean } | null;
  sourceEvidence: Record<string, unknown> | null;
}

export interface BrainOperationResult extends BrainOperationRecord {
  attachmentState: AttachmentState;
}

export interface SynthesisStateResponse {
  ready: boolean;
  requestedGenerationMarker: string | null;
  currentGenerationMarker: string | null;
  markerStatus: 'unrequested' | 'matched' | 'changed' | 'absent';
  latestOperation: BrainOperationRecord | null;
  activeOperation: BrainOperationRecord | null;
}

export interface BrainQueryRequest {
  requestId?: string;
  target?: BrainTargetSelector;
  query: string;
  mode?: 'quick' | 'full' | 'expert' | 'dive';
  modelSelection?: { provider: string; model: string };
  enablePGS?: boolean;
  pgsSweep?: { provider: string; model: string };
  pgsSynth?: { provider: string; model: string };
  enableSynthesis?: boolean;
  includeOutputs?: boolean;
  includeThoughts?: boolean;
  includeCoordinatorInsights?: boolean;
  allowActions?: boolean;
  pgsMode?: 'fresh' | 'continue' | 'targeted';
  pgsLevel?: 'skim' | 'sample' | 'deep' | 'full';
  continueFromOperationId?: string;
  targetPartitionIds?: string[];
  priorContext?: { query: string; answer: string } | null;
}
