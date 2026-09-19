export type ConsoleState = 'queued' | 'starting' | 'running' | 'blocked' | 'stopping'
  | 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'unknown';
export type ConsoleFormat = 'codex-jsonl' | 'cursor-jsonl' | 'home23-turn' | 'text';

/** Explicit storage inventory. Reading a root must never instantiate a runtime/store. */
export interface ConsoleRoot {
  id: string;
  actor: { id: string; name: string };
  jobsDir: string;
  workDir: string;
  historyDir: string;
  historyNamespace: string;
  executionOutputDir?: string;
  runtimeKind?: 'resident' | 'helper';
}

export interface ConsoleAction {
  operation: 'cancel' | 'steer';
  available: boolean;
  reason: string | null;
  scope: 'source' | 'work';
  targetId: string | null;
  url?: string | null;
}

export interface ConsoleSource {
  id: string;
  kind: 'coding' | 'subagent';
  label: string;
  actor: { id: string; name: string };
  backend: string | null;
  parentSourceId: string | null;
  workId: string | null;
  harnessWorkId: string | null;
  executionId: string | null;
  conversationId: string | null;
  state: ConsoleState;
  startedAt: string | null;
  finishedAt: string | null;
  lastOutputAt: string | null;
  lastOutputAtBasis: 'source_timestamp' | 'observed_append' | 'file_modified' | 'unknown';
  checkedAt: string;
  output: {
    availability: 'pending' | 'available' | 'unavailable';
    reason: string | null;
    format: ConsoleFormat;
    shellOutputTiming: 'at_completion' | 'incremental' | 'mixed' | 'unknown';
    historyCompleteness: 'complete' | 'partial' | 'unknown';
  };
  actions: ConsoleAction[];
}

export interface ConsoleFileStream {
  id: string;
  path: string;
  /** All resolved filenames must remain within this configured storage directory. */
  allowedRoot: string;
  format: ConsoleFormat;
  turnId?: string;
  writerClosed: boolean;
  /** Terminal producer reported capture failure; complete bytes remain readable, closure is unproven. */
  captureIncomplete?: boolean;
  /** A terminal registry survived without a writer-finalization receipt. */
  closureUnknown?: boolean;
}

export interface ConsoleTarget {
  runtimeId: string;
  kind: 'coding' | 'subagent';
  jobId?: string;
  chatId?: string;
  turnId?: string;
  harnessWorkId?: string;
}

/** Internal only: never serialize paths or control transport metadata to the client. */
export interface ResolvedConsoleSource {
  source: ConsoleSource;
  root: ConsoleRoot;
  streams: ConsoleFileStream[];
  target: ConsoleTarget;
  channelId: string | null;
  /** Proven aw_ child identities from the same runtime, for forwarded activity records only. */
  forwardedSources?: Readonly<Record<string, string>>;
}

export interface ConsoleRecord {
  id: string;
  sourceId: string;
  stream: string;
  format: ConsoleFormat;
  kind: string;
  occurredAt: string | null;
  observedAt: string;
  raw: string | null;
  rawUrl: string | null;
  rawEncoding: 'utf8' | 'binary';
  byteLength: number;
  partial: boolean;
  sequence: number | null;
  forwardedFromSourceId: string | null;
}

export interface ConsoleGap {
  sourceId: string;
  stream: string | null;
  reason: string;
}

export const CONSOLE_TERMINAL_STATES: ReadonlySet<string> = new Set([
  'completed', 'failed', 'cancelled', 'interrupted',
]);

export class ConsoleReadError extends Error {
  constructor(public readonly code: string, public readonly status = 400) {
    super(code);
    this.name = 'ConsoleReadError';
  }
}
