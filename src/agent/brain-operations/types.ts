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
  sequence: number;
  state: BrainOperationState;
  phase: string | null;
  updatedAt: string;
  lastProviderActivityAt: string | null;
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
}

export interface BrainOperationEventGap {
  type: 'event_gap';
  operationId: string;
  oldestSequence: number;
  latestSequence: number;
  currentStatus: BrainOperationRecord;
}

export type BrainOperationEvent = BrainOperationRecord | BrainOperationEventGap;

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
  pgsConfig?: { sweepFraction?: number };
  pgsSweep?: { provider: string; model: string };
  pgsSynth?: { provider: string; model: string };
  enableSynthesis?: boolean;
  includeOutputs?: boolean;
  includeThoughts?: boolean;
  includeCoordinatorInsights?: boolean;
  allowActions?: boolean;
  pgsMode?: 'full';
  priorContext?: { query: string; answer: string } | null;
}
