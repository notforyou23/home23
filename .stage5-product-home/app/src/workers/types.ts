export type WorkerRunStatus =
  | 'queued'
  | 'running'
  | 'fixed'
  | 'no_change'
  | 'blocked'
  | 'failed'
  | 'cancelled';

export type WorkerVerifierStatus = 'pass' | 'fail' | 'unknown' | 'not_run';

export interface WorkerTemplateSummary {
  name: string;
  displayName: string;
  class: string;
  ownerAgent: string;
  purpose: string;
}

export interface WorkerConfig {
  kind: 'worker';
  name: string;
  displayName: string;
  ownerAgent: string;
  class: string;
  purpose: string;
  provider?: string;
  model?: string;
  tools?: Record<string, boolean>;
  safetyPolicy?: Record<string, unknown>;
  feedsBrains?: string[];
  visibleTo?: string[];
  limits?: {
    maxRuntimeMinutes?: number;
    maxToolCalls?: number;
    maxTokens?: number;
  };
  rootPath: string;
  configPath: string;
}

export interface WorkerRunRequest {
  worker: string;
  prompt: string;
  ownerAgent?: string;
  requestedBy: 'human' | 'house-agent' | 'live-problems' | 'good-life' | 'cron' | 'cli' | 'api';
  requester?: string;
  collaborationHandoff?: Partial<WorkerCollaborationHandoff>;
  source?: {
    type: string;
    id?: string;
    url?: string;
  };
  metadata?: Record<string, unknown>;
}

export interface WorkerCollaborationHandoff {
  schema: 'home23.worker-collaboration-handoff.v1';
  sourceIssues: number[];
  whyThisMatters: string;
  constraints: string[];
  reviewLens: string[];
  handoffTaxMitigation: string;
}

export interface WorkerReceiptAction {
  type: string;
  path?: string;
  target?: string;
  detail?: string;
}

export interface WorkerReceiptEvidence {
  type: string;
  detail: string;
  status?: WorkerVerifierStatus;
}

export interface WorkerMemoryCandidate {
  text: string;
  confidence: number;
  appliesTo?: string[];
}

export interface WorkerRunReceipt {
  schema: 'home23.worker-run.v1';
  runId: string;
  worker: string;
  ownerAgent: string;
  requestedBy: WorkerRunRequest['requestedBy'];
  requester?: string;
  startedAt: string;
  finishedAt: string;
  status: WorkerRunStatus;
  verifierStatus: WorkerVerifierStatus;
  summary: string;
  rootCause?: string;
  actions: WorkerReceiptAction[];
  evidence: WorkerReceiptEvidence[];
  artifacts: string[];
  memoryCandidates: WorkerMemoryCandidate[];
  collaborationHandoff?: WorkerCollaborationHandoff;
  source?: WorkerRunRequest['source'];
}

export interface WorkerRunRecord {
  runId: string;
  worker: string;
  ownerAgent: string;
  requestedBy: WorkerRunRequest['requestedBy'];
  startedAt: string;
  finishedAt?: string;
  status: WorkerRunStatus;
  runPath: string;
  receiptPath?: string;
  summary?: string;
}

export type WorkerConnectorEvent =
  | { type: 'worker_run_started'; runId: string; worker: string; ownerAgent: string }
  | { type: 'worker_run_progress'; runId: string; message: string }
  | { type: 'worker_run_receipt'; runId: string; status: WorkerRunStatus; verifierStatus: WorkerVerifierStatus }
  | { type: 'worker_run_failed'; runId: string; status: WorkerRunStatus; summary: string }
  | { type: 'worker_brain_feed'; runId: string; brain: string; status: 'written' | 'skipped' };
