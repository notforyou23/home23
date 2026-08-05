/**
 * Coding-backend bridge contract (Step 29).
 *
 * Shared types for the rebuilt ACP bridge: durable coding jobs delegated to
 * headless Claude Code / Codex CLIs. Everything here is a plain-data contract
 * between backends.ts, job-store.ts, worktrees.ts, bridge.ts, and the
 * coding_* agent tools.
 */

// ─── Job lifecycle ───────────────────────────────────────────

export type CodingJobStatus =
  | 'starting'     // job dir created, child not yet confirmed spawned
  | 'running'      // child alive (or believed alive) and streaming
  | 'completed'    // terminal event seen, exit 0 semantics
  | 'failed'       // terminal event with error, nonzero exit, or spawn failure
  | 'cancelled'    // cancelJob() was called and the child was stopped
  | 'interrupted'; // child died without a terminal event (e.g. host reboot)

export const TERMINAL_JOB_STATUSES: readonly CodingJobStatus[] =
  ['completed', 'failed', 'cancelled', 'interrupted'];

export type CodingIsolation = 'worktree' | 'checkpoint' | 'none';

/** Persisted as coding-jobs/<jobId>/job.json (atomic tmp+rename). */
export interface CodingJobRecord {
  schema: 'home23.coding-job.v1';
  id: string;                    // "cj_<ISO-compact>_<4hex>"
  backend: string;               // 'claude-code' | 'codex' | future
  status: CodingJobStatus;
  prompt: string;                // original prompt (bounded to 20k chars)
  label?: string;
  cwd: string;                   // where the CLI actually ran (worktree path when isolated)
  requestedCwd: string;          // what the caller asked for
  model?: string;
  effort?: string;
  sessionId?: string;            // backend session id (resume handle)
  resumedFromJobId?: string;     // set by coding_continue
  pid?: number;
  pgid?: number;
  startedAt: string;             // ISO
  finishedAt?: string;           // ISO
  exitCode?: number | null;
  isolation: CodingIsolation;
  worktree?: WorktreeInfo;
  checkpoint?: CheckpointInfo;
  requestedBy?: string;          // chatId or caller tag
  argv?: string[];               // exact CLI invocation, prompt elided
  error?: string;                // spawn/parse failure detail
}

export interface WorktreeInfo {
  repoRoot: string;              // main checkout the worktree was created from
  path: string;                  // worktree directory
  branch: string;                // e.g. home23-agent/<slug>
  baseCommit: string;            // HEAD at creation
}

export interface CheckpointInfo {
  repoRoot: string;
  headCommit: string;            // HEAD at job start
  stashCommit?: string;          // `git stash create` SHA when the tree was dirty
  dirty: boolean;
}

/** Persisted as coding-jobs/<jobId>/receipt.json when the job reaches a terminal status. */
export interface CodingJobReceipt {
  schema: 'home23.coding-receipt.v1';
  jobId: string;
  backend: string;
  status: CodingJobStatus;
  label?: string;
  model?: string;
  sessionId?: string;
  exitCode?: number | null;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  numTurns?: number;
  costUsd?: number;
  /** Bounded tail of the final assistant/result text. */
  resultTail: string;
  /** `git diff --stat` style summary when the job ran in a git repo. */
  diffStat?: string;
  worktree?: WorktreeInfo;
  checkpoint?: CheckpointInfo;
  eventsCount: number;
  toolUseCount: number;
}

// ─── Normalized stream events ────────────────────────────────

export type BridgeEvent =
  | { kind: 'session'; sessionId: string; model?: string }
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool_use'; tool: string; summary: string }
  | { kind: 'result'; ok: boolean; text: string; costUsd?: number; numTurns?: number; durationMs?: number }
  | { kind: 'other'; raw: string };

// ─── Backend definitions ─────────────────────────────────────

export interface CodingBackendOptions {
  prompt: string;
  cwd: string;
  model?: string;
  effort?: string;
  /** Resume an existing backend session (coding_continue). */
  resumeSessionId?: string;
  /** Pre-generated session id for new claude-code jobs so resume works later. */
  newSessionId?: string;
  permissionMode: string;        // 'bypassPermissions' (default) | 'allowlist' | raw claude mode
  allowedTools?: string[];
  disallowedTools?: string[];
  appendSystemPrompt?: string;
  addDirs?: string[];
  maxBudgetUsd?: number;
  /** Codex sandbox override from backend config (`--sandbox <value>`). Additive (Step 29). */
  sandbox?: string;
  /** Backend-specific extra args appended verbatim from config. */
  extraArgs?: string[];
}

export interface CodingBackend {
  id: string;
  /** Candidate binary names/paths, first match wins; config bin overrides. */
  binCandidates: string[];
  /** Resolve the binary or return null when unavailable. */
  resolveBin(configBin?: string): string | null;
  buildArgs(opts: CodingBackendOptions): string[];
  /** Parse one raw stdout line into zero or one normalized event. */
  parseEvent(line: string): BridgeEvent | null;
  /**
   * Parse one raw stdout line into zero or more normalized events (a single
   * claude-code assistant line can carry text AND tool_use blocks). Additive
   * (Step 29); parseEvent stays as a first-event wrapper.
   */
  parseEvents?(line: string): BridgeEvent[];
  /** True when this backend can resume a session by id. */
  supportsResume: boolean;
}

// ─── Config (mirrors ACPConfig in src/types.ts) ──────────────

export interface CodingBackendConfig {
  bin?: string;
  model?: string;
  sandbox?: string;              // codex only
  extraArgs?: string[];
}

export interface BridgeHooksConfig {
  onComplete?: string;           // shell command, run with HOME23_JOB_* env
  onFail?: string;
}

export interface BridgeConfig {
  enabled: boolean;
  defaultAgent: string;
  allowedAgents: string[];
  permissionMode: string;
  maxConcurrentJobs?: number;
  jobTimeoutMs?: number;
  backends?: Record<string, CodingBackendConfig>;
  envPassthrough?: string[];
  hooks?: BridgeHooksConfig;
}

// ─── Bridge hook events (observability, never gating) ────────

export type BridgeLifecycleEvent =
  | { type: 'job_started'; job: CodingJobRecord }
  | { type: 'job_event'; jobId: string; event: BridgeEvent }
  | { type: 'job_finished'; job: CodingJobRecord; receipt: CodingJobReceipt };

export type BridgeLifecycleListener = (event: BridgeLifecycleEvent) => void;
