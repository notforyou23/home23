/**
 * ACPBridge — durable coding-job orchestrator (Step 29, rebuilt in place).
 *
 * Jobs are spawned DETACHED with stdout redirected straight into the job's
 * events.jsonl: the file is simultaneously the durability layer and the
 * streaming source. The bridge tails it for live BridgeEvents; after a harness
 * restart, recover() replays the same file to reconstruct what happened while
 * Home23 was down. A restart therefore never kills a running coding job — the
 * child keeps writing, and the new bridge process re-attaches.
 *
 * Isolation policy: new jobs inside the Home23 checkout run in a disposable
 * git worktree; jobs in any other git repo get a stash-create checkpoint;
 * resumed jobs run wherever the caller says (the original job's cwd).
 */

import { spawn, exec, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import path from 'node:path';
import { buildChildEnv, getBackend, listBackendIds } from './backends.js';
import { CodingJobStore } from './job-store.js';
import {
  createCheckpoint,
  createJobWorktree,
  detectGitRepo,
  diffStat,
  sanitizeSlug,
} from './worktrees.js';
import { unprivilegedChildEnv } from '../security/child-process-env.js';
import {
  TERMINAL_JOB_STATUSES,
  type BridgeConfig,
  type BridgeEvent,
  type BridgeLifecycleListener,
  type CheckpointInfo,
  type CodingBackend,
  type CodingBackendOptions,
  type CodingIsolation,
  type CodingJobReceipt,
  type CodingJobRecord,
  type CodingJobStatus,
  type WorktreeInfo,
} from './types.js';

const PROMPT_MAX = 20_000;
const RESULT_TAIL_MAX = 4000;
const ERROR_MAX = 500;
const TAIL_POLL_MS = 400;
const WAIT_POLL_MS = 500;
const KILL_ESCALATION_MS = 5000;
const HOOK_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_CONCURRENT = 3;
const DEFAULT_JOB_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const TAIL_CHUNK_BYTES = 1 << 20;

export interface ACPBridgeOptions {
  config: BridgeConfig;              // already-normalized
  jobsDir: string;
  projectRoot: string;
  log?: (msg: string) => void;
}

export interface StartJobOptions {
  prompt: string;
  backend?: string;
  cwd?: string;
  label?: string;
  model?: string;
  effort?: string;
  isolation?: CodingIsolation;
  resumeSessionId?: string;
  resumedFromJobId?: string;
  appendSystemPrompt?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  addDirs?: string[];
  maxBudgetUsd?: number;
  requestedBy?: string;
}

/**
 * Config normalization for the coding bridge.
 *
 * Fail-closed when the `acp:` block is ENTIRELY ABSENT: an agent whose config
 * predates Step 29 has no acp section, and it must not silently gain
 * bypass-authority coding jobs on the next restart ("no backend magic"). New
 * agents are opted in explicitly by the CLI scaffolder (agent-config-builder
 * writes `acp: { enabled: true, ... }`), so the CLIs are still first-class out
 * of the box — existing agents just flip one flag to turn them on.
 *
 * When the block IS present, it is tolerant: partial input becomes full
 * defaults and an explicit enabled:false is respected. Builder-era configs
 * used permissionMode 'ask' — there is no interactive approver in a headless
 * bridge job, so 'ask' maps to 'allowlist' behavior (no bypass flag; honor
 * allowed/disallowed tool lists), NOT to bypassPermissions: a config that
 * asked for gating must never silently receive full bypass.
 */
export function normalizeBridgeConfig(raw: unknown): BridgeConfig {
  const present = raw !== undefined && raw !== null && typeof raw === 'object';
  const src = (present ? raw : {}) as Record<string, unknown>;
  let permissionMode = typeof src.permissionMode === 'string' && src.permissionMode
    ? src.permissionMode
    : 'bypassPermissions';
  if (permissionMode === 'ask') permissionMode = 'allowlist';
  const num = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
  return {
    // Absent block → disabled (opt-in). Present block → enabled unless explicit false.
    enabled: present && src.enabled !== false,
    defaultAgent: typeof src.defaultAgent === 'string' && src.defaultAgent ? src.defaultAgent : 'grok-build',
    allowedAgents: Array.isArray(src.allowedAgents) ? src.allowedAgents.map(String) : ['grok-build', 'claude-code', 'codex'],
    permissionMode,
    maxConcurrentJobs: num(src.maxConcurrentJobs, DEFAULT_MAX_CONCURRENT),
    jobTimeoutMs: num(src.jobTimeoutMs, DEFAULT_JOB_TIMEOUT_MS),
    backends: (src.backends && typeof src.backends === 'object')
      ? src.backends as BridgeConfig['backends']
      : {},
    envPassthrough: Array.isArray(src.envPassthrough) ? src.envPassthrough.map(String) : [],
    hooks: (src.hooks && typeof src.hooks === 'object') ? src.hooks as BridgeConfig['hooks'] : {},
  };
}

interface JobRuntime {
  jobId: string;
  backend: CodingBackend;
  pid?: number;
  pgid?: number;
  child?: ChildProcess;
  tailTimer?: NodeJS.Timeout;
  timeoutTimer?: NodeJS.Timeout;
  killTimer?: NodeJS.Timeout;
  offset: number;
  carry: Buffer;
  eventsCount: number;
  toolUseCount: number;
  lastText: string;
  /** True once a stream-reported session id has been persisted to job.json. */
  sessionFromStream: boolean;
  resultEvent?: Extract<BridgeEvent, { kind: 'result' }>;
  cancelRequested: boolean;
  errorMessage?: string;
  exitCode?: number | null;
  exited: boolean;
  finalized: boolean;
  /** True while recover() replays historical lines — suppresses re-emission. */
  silent: boolean;
}

function bounded(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isTerminal(status: CodingJobStatus): boolean {
  return TERMINAL_JOB_STATUSES.includes(status);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class ACPBridge {
  private readonly config: BridgeConfig;
  private readonly store: CodingJobStore;
  private readonly projectRoot: string;
  private readonly log: (msg: string) => void;
  private readonly listeners: BridgeLifecycleListener[] = [];
  private readonly runtimes = new Map<string, JobRuntime>();

  constructor(opts: ACPBridgeOptions) {
    this.config = opts.config;
    this.store = new CodingJobStore(opts.jobsDir);
    this.projectRoot = opts.projectRoot;
    this.log = opts.log ?? ((msg: string) => console.log(`[acp] ${msg}`));
  }

  addListener(listener: BridgeLifecycleListener): void {
    this.listeners.push(listener);
  }

  getJob(id: string): CodingJobRecord | undefined {
    return this.store.getJob(id);
  }

  listJobs(filter?: { status?: CodingJobStatus; limit?: number }): CodingJobRecord[] {
    return this.store.listJobs(filter);
  }

  getReceipt(id: string): CodingJobReceipt | undefined {
    return this.store.getReceipt(id);
  }

  listBackends(): Array<{ id: string; available: boolean; bin: string | null; defaultModel?: string }> {
    return listBackendIds().map(id => {
      const backend = getBackend(id)!;
      const backendCfg = this.config.backends?.[id] ?? {};
      const bin = backend.resolveBin(backendCfg.bin);
      return { id, available: bin !== null, bin, defaultModel: backendCfg.model };
    });
  }

  readEventsTail(id: string, maxEvents = 50): BridgeEvent[] {
    const job = this.store.getJob(id);
    if (!job) return [];
    const backend = getBackend(job.backend);
    if (!backend) return [];
    const lines = this.store.readRawEventsTail(id, maxEvents);
    const events: BridgeEvent[] = [];
    for (const line of lines) {
      events.push(...this.parseLine(backend, line));
    }
    return events.slice(-maxEvents);
  }

  async startJob(opts: StartJobOptions): Promise<CodingJobRecord> {
    if (!this.config.enabled) {
      throw new Error('Coding bridge is disabled (acp.enabled: false); enable it in config to run coding jobs');
    }
    const prompt = bounded(String(opts.prompt ?? '').trim(), PROMPT_MAX);
    if (!prompt) throw new Error('Coding job prompt is empty');

    const backendId = opts.backend || this.config.defaultAgent;
    const backend = getBackend(backendId);
    if (!backend) {
      throw new Error(`Unknown coding backend "${backendId}". Known backends: ${listBackendIds().join(', ')}`);
    }
    // Empty allowedAgents = all built-ins allowed.
    if (this.config.allowedAgents.length > 0 && !this.config.allowedAgents.includes(backendId)) {
      throw new Error(`Backend "${backendId}" is not in allowedAgents: [${this.config.allowedAgents.join(', ')}]`);
    }
    const backendCfg = this.config.backends?.[backendId] ?? {};
    const bin = backend.resolveBin(backendCfg.bin);
    if (!bin) {
      if (backendId === 'codex') {
        throw new Error('codex CLI not found; install with `npm i -g @openai/codex` or set acp.backends.codex.bin');
      }
      throw new Error(`${backendId} CLI not found; set acp.backends['${backendId}'].bin to its path`);
    }
    if (opts.resumeSessionId && !backend.supportsResume) {
      throw new Error(`Backend "${backendId}" does not support session resume`);
    }

    const active = this.store.listJobs().filter(job => !isTerminal(job.status)).length;
    const maxConcurrent = this.config.maxConcurrentJobs ?? DEFAULT_MAX_CONCURRENT;
    if (active >= maxConcurrent) {
      throw new Error(`Concurrent coding-job limit reached (${active}/${maxConcurrent}); wait for or cancel a running job`);
    }

    const requestedCwd = opts.cwd ? path.resolve(opts.cwd) : this.projectRoot;
    const jobId = this.store.newJobId();
    const isolation = this.resolveIsolation(opts, requestedCwd);

    let cwd = requestedCwd;
    let worktree: WorktreeInfo | undefined;
    let checkpoint: CheckpointInfo | undefined;
    let effectiveIsolation: CodingIsolation = isolation;
    if (isolation === 'worktree') {
      const repo = detectGitRepo(requestedCwd);
      if (repo) {
        worktree = createJobWorktree({
          repoRoot: repo.repoRoot,
          slug: opts.label ? sanitizeSlug(opts.label) : jobId.replace(/_/g, '-'),
        });
        cwd = worktree.path;
      } else {
        effectiveIsolation = 'none';
      }
    } else if (isolation === 'checkpoint') {
      const repo = detectGitRepo(requestedCwd);
      if (repo) checkpoint = createCheckpoint(repo.repoRoot);
      else effectiveIsolation = 'none';
    }

    const newSessionId = (backendId === 'claude-code' || backendId === 'grok-build') && !opts.resumeSessionId ? randomUUID() : undefined;
    const backendOpts: CodingBackendOptions = {
      prompt,
      cwd,
      model: opts.model ?? backendCfg.model,
      effort: opts.effort,
      resumeSessionId: opts.resumeSessionId,
      newSessionId,
      permissionMode: this.config.permissionMode,
      allowedTools: opts.allowedTools,
      disallowedTools: opts.disallowedTools,
      appendSystemPrompt: opts.appendSystemPrompt,
      addDirs: opts.addDirs,
      maxBudgetUsd: opts.maxBudgetUsd,
      sandbox: backendCfg.sandbox,
      extraArgs: backendCfg.extraArgs,
    };
    const args = backend.buildArgs(backendOpts);

    const record: CodingJobRecord = {
      schema: 'home23.coding-job.v1',
      id: jobId,
      backend: backendId,
      status: 'starting',
      prompt,
      label: opts.label,
      cwd,
      requestedCwd,
      model: backendOpts.model,
      effort: opts.effort,
      sessionId: newSessionId ?? opts.resumeSessionId,
      resumedFromJobId: opts.resumedFromJobId,
      startedAt: new Date().toISOString(),
      isolation: effectiveIsolation,
      worktree,
      checkpoint,
      requestedBy: opts.requestedBy,
      argv: [bin, ...args.slice(0, -1), '<prompt>'],
    };
    this.store.createJob(record);

    const runtime: JobRuntime = {
      jobId,
      backend,
      offset: 0,
      carry: Buffer.alloc(0),
      eventsCount: 0,
      toolUseCount: 0,
      lastText: '',
      sessionFromStream: false,
      cancelRequested: false,
      exited: false,
      finalized: false,
      silent: false,
    };
    this.runtimes.set(jobId, runtime);

    const eventsFd = openSync(this.store.eventsPath(jobId), 'a');
    const stderrFd = openSync(this.store.stderrPath(jobId), 'a');
    let child: ChildProcess;
    try {
      child = spawn(bin, args, {
        cwd,
        env: unprivilegedChildEnv(buildChildEnv(this.config)),
        detached: true,
        stdio: ['ignore', eventsFd, stderrFd],
      });
    } catch (err) {
      closeSync(eventsFd);
      closeSync(stderrFd);
      runtime.errorMessage = bounded(`spawn failed: ${(err as Error).message}`, ERROR_MAX);
      this.finalize(jobId, runtime);
      return this.store.getJob(jobId)!;
    }
    closeSync(eventsFd);
    closeSync(stderrFd);
    child.unref();

    runtime.child = child;
    runtime.pid = child.pid;
    runtime.pgid = child.pid; // detached: true → new process group led by the child

    child.once('error', (err: Error) => {
      runtime.errorMessage = bounded(`spawn failed: ${err.message}`, ERROR_MAX);
      this.finalize(jobId, runtime);
    });
    child.once('exit', (code) => {
      runtime.exited = true;
      runtime.exitCode = code;
      // Grace read: give the fd flush a beat, then drain remaining lines.
      setTimeout(() => this.pollJob(jobId), 150);
    });

    if (child.pid === undefined) {
      // spawn error event will finalize; return the current record.
      await sleep(50);
      return this.store.getJob(jobId)!;
    }

    const updated = this.store.updateJob(jobId, { status: 'running', pid: child.pid, pgid: child.pid });
    runtime.tailTimer = setInterval(() => this.pollJob(jobId), TAIL_POLL_MS);
    runtime.tailTimer.unref?.();
    const timeoutMs = this.config.jobTimeoutMs ?? DEFAULT_JOB_TIMEOUT_MS;
    runtime.timeoutTimer = setTimeout(() => this.handleTimeout(jobId), timeoutMs);
    runtime.timeoutTimer.unref?.();

    this.log(`job ${jobId} started (${backendId}, pid ${child.pid}, isolation ${effectiveIsolation})`);
    this.emit({ type: 'job_started', job: updated });
    return updated;
  }

  async cancelJob(id: string): Promise<CodingJobRecord> {
    const job = this.store.getJob(id);
    if (!job) throw new Error(`Unknown coding job: ${id}`);
    if (isTerminal(job.status)) return job;

    let runtime = this.runtimes.get(id);
    if (!runtime) {
      // Not attached (e.g. cancel before recover). Build a minimal runtime,
      // replay history silently so counters/session are correct, and arm a
      // tailer below — without one, nothing would ever notice the process die
      // and the job would stay non-terminal until the next restart.
      runtime = this.attachRuntime(job);
      runtime.silent = true;
      this.drainNewData(id, runtime);
      runtime.silent = false;
    }
    runtime.cancelRequested = true;

    const pgid = job.pgid ?? job.pid;
    if (pgid) {
      try { process.kill(-pgid, 'SIGTERM'); } catch { /* already gone */ }
      runtime.killTimer = setTimeout(() => {
        try { process.kill(-pgid, 'SIGKILL'); } catch { /* already gone */ }
      }, KILL_ESCALATION_MS);
      runtime.killTimer.unref?.();
      if (!runtime.tailTimer) {
        runtime.tailTimer = setInterval(() => this.pollJob(id), TAIL_POLL_MS);
        runtime.tailTimer.unref?.();
      }
    } else {
      this.finalize(id, runtime);
    }
    return this.store.getJob(id)!;
  }

  async waitForJob(id: string, timeoutMs: number): Promise<CodingJobRecord> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const job = this.store.getJob(id);
      if (!job) throw new Error(`Unknown coding job: ${id}`);
      if (isTerminal(job.status) || Date.now() >= deadline) return job;
      await sleep(Math.min(WAIT_POLL_MS, Math.max(deadline - Date.now(), 25)));
    }
  }

  /**
   * Re-attach or finalize non-terminal jobs after a harness restart. Replays
   * each job's events.jsonl silently (no re-emission of historical events) to
   * recover counters, session id, and any terminal result.
   */
  async recover(): Promise<{ resumed: string[]; finalized: string[] }> {
    const resumed: string[] = [];
    const finalized: string[] = [];
    for (const job of this.store.listJobs()) {
      if (isTerminal(job.status) || this.runtimes.has(job.id)) continue;
      const backend = getBackend(job.backend);
      if (!backend) {
        const runtime = this.attachRuntime(job);
        runtime.errorMessage = `unknown backend: ${job.backend}`;
        this.finalize(job.id, runtime);
        finalized.push(job.id);
        continue;
      }
      const runtime = this.attachRuntime(job);
      runtime.silent = true;
      this.drainNewData(job.id, runtime);
      runtime.silent = false;

      const alive = job.pid !== undefined && pidAlive(job.pid);
      if (alive && !runtime.resultEvent) {
        // Leave any partial trailing line in runtime.carry — the live child
        // will finish writing it and the re-attached tailer will read it whole.
        runtime.tailTimer = setInterval(() => this.pollJob(job.id), TAIL_POLL_MS);
        runtime.tailTimer.unref?.();
        const timeoutMs = this.config.jobTimeoutMs ?? DEFAULT_JOB_TIMEOUT_MS;
        const elapsed = Date.now() - Date.parse(job.startedAt);
        runtime.timeoutTimer = setTimeout(
          () => this.handleTimeout(job.id),
          Math.max(timeoutMs - elapsed, 5000),
        );
        runtime.timeoutTimer.unref?.();
        resumed.push(job.id);
        this.log(`job ${job.id} re-attached (pid ${job.pid} alive)`);
      } else {
        // Dead job: a child killed mid-write (host reboot) can leave the
        // terminal result line without its trailing newline. Flush it before
        // finalizing so a finished job is not mislabeled 'interrupted'.
        this.flushCarry(runtime);
        this.finalize(job.id, runtime);
        finalized.push(job.id);
        this.log(`job ${job.id} finalized on recovery (${this.store.getJob(job.id)?.status})`);
      }
    }
    return { resumed, finalized };
  }

  /** Detach timers only — detached jobs keep running and recover() re-attaches. */
  dispose(): void {
    for (const runtime of this.runtimes.values()) {
      if (runtime.tailTimer) clearInterval(runtime.tailTimer);
      if (runtime.timeoutTimer) clearTimeout(runtime.timeoutTimer);
      if (runtime.killTimer) clearTimeout(runtime.killTimer);
    }
    this.runtimes.clear();
  }

  // ─── internals ─────────────────────────────────────────────

  private resolveIsolation(opts: StartJobOptions, requestedCwd: string): CodingIsolation {
    if (opts.isolation) return opts.isolation;
    // Resumed sessions continue in the caller-provided cwd (the original
    // job's cwd — often an existing worktree); re-isolating would strand the
    // conversation away from its own edits.
    if (opts.resumeSessionId) return 'none';
    const repo = detectGitRepo(requestedCwd);
    if (!repo) return 'none';
    const homeRepo = detectGitRepo(this.projectRoot);
    return homeRepo && repo.repoRoot === homeRepo.repoRoot ? 'worktree' : 'checkpoint';
  }

  private attachRuntime(job: CodingJobRecord): JobRuntime {
    const runtime: JobRuntime = {
      jobId: job.id,
      backend: getBackend(job.backend) ?? getBackend('claude-code')!,
      pid: job.pid,
      pgid: job.pgid ?? job.pid,
      offset: 0,
      carry: Buffer.alloc(0),
      eventsCount: 0,
      toolUseCount: 0,
      lastText: '',
      sessionFromStream: false,
      cancelRequested: false,
      exited: false,
      finalized: false,
      silent: false,
    };
    this.runtimes.set(job.id, runtime);
    return runtime;
  }

  private parseLine(backend: CodingBackend, line: string): BridgeEvent[] {
    if (backend.parseEvents) return backend.parseEvents(line);
    const event = backend.parseEvent(line);
    return event ? [event] : [];
  }

  private handleLine(runtime: JobRuntime, line: string): void {
    if (!line.trim()) return;
    for (const event of this.parseLine(runtime.backend, line)) {
      runtime.eventsCount++;
      if (event.kind === 'tool_use') runtime.toolUseCount++;
      if (event.kind === 'text' && event.text) runtime.lastText = event.text;
      if (event.kind === 'result') runtime.resultEvent = event;
      if (event.kind === 'session' && event.sessionId && !runtime.sessionFromStream) {
        // Persist the stream-reported session id the moment it appears — it is
        // the resume handle and must survive a harness death mid-job. It wins
        // over pre-generated bookkeeping: a resumed claude session forks under
        // a NEW id, and only the stream knows it.
        runtime.sessionFromStream = true;
        try {
          this.store.updateJob(runtime.jobId, { sessionId: event.sessionId });
        } catch { /* job.json missing — finalize will surface it */ }
      }
      if (!runtime.silent) {
        this.emit({ type: 'job_event', jobId: runtime.jobId, event });
      }
    }
  }

  /** Read all new bytes from events.jsonl; returns bytes consumed. */
  private drainNewData(jobId: string, runtime: JobRuntime): number {
    let consumed = 0;
    for (;;) {
      let size = 0;
      try {
        size = statSync(this.store.eventsPath(jobId)).size;
      } catch {
        return consumed;
      }
      if (size <= runtime.offset) return consumed;
      const fd = openSync(this.store.eventsPath(jobId), 'r');
      try {
        const len = Math.min(size - runtime.offset, TAIL_CHUNK_BYTES);
        const buf = Buffer.alloc(len);
        const read = readSync(fd, buf, 0, len, runtime.offset);
        if (read <= 0) return consumed;
        runtime.offset += read;
        consumed += read;
        const combined = Buffer.concat([runtime.carry, buf.subarray(0, read)]);
        let start = 0;
        for (let i = 0; i < combined.length; i++) {
          if (combined[i] === 0x0a) {
            this.handleLine(runtime, combined.toString('utf8', start, i));
            start = i + 1;
          }
        }
        runtime.carry = Buffer.from(combined.subarray(start));
      } finally {
        closeSync(fd);
      }
    }
  }

  private pollJob(jobId: string): void {
    const runtime = this.runtimes.get(jobId);
    if (!runtime || runtime.finalized) return;
    const consumed = this.drainNewData(jobId, runtime);

    if (runtime.resultEvent) {
      this.flushCarry(runtime);
      this.finalize(jobId, runtime);
      return;
    }

    const dead = runtime.exited || (runtime.pid !== undefined && !pidAlive(runtime.pid));
    if (dead && consumed === 0) {
      this.flushCarry(runtime);
      this.finalize(jobId, runtime);
    }
  }

  private flushCarry(runtime: JobRuntime): void {
    if (runtime.carry.length > 0) {
      const line = runtime.carry.toString('utf8');
      runtime.carry = Buffer.alloc(0);
      this.handleLine(runtime, line);
    }
  }

  private handleTimeout(jobId: string): void {
    const runtime = this.runtimes.get(jobId);
    if (!runtime || runtime.finalized) return;
    runtime.errorMessage = 'timeout';
    void this.cancelJob(jobId).catch(() => { /* already terminal */ });
  }

  private finalize(jobId: string, runtime: JobRuntime): void {
    if (runtime.finalized) return;
    runtime.finalized = true;
    if (runtime.tailTimer) clearInterval(runtime.tailTimer);
    if (runtime.timeoutTimer) clearTimeout(runtime.timeoutTimer);
    if (runtime.killTimer) clearTimeout(runtime.killTimer);

    const job = this.store.getJob(jobId);
    if (!job) {
      this.runtimes.delete(jobId);
      return;
    }

    const result = runtime.resultEvent;
    let status: CodingJobStatus;
    if (result) status = result.ok ? 'completed' : 'failed';
    else if (runtime.cancelRequested) status = 'cancelled';
    else if (runtime.errorMessage) status = 'failed';
    else status = 'interrupted';

    const finishedAt = new Date().toISOString();
    // Codex emits result text '' (stateless parser) — fall back to the last
    // agent_message text seen while tailing.
    const resultText = result?.text || runtime.lastText;

    let stat: string | undefined;
    if (job.worktree) stat = diffStat(job.worktree.path, job.worktree.baseCommit);
    else if (job.checkpoint) stat = diffStat(job.cwd, job.checkpoint.headCommit);

    const receipt: CodingJobReceipt = {
      schema: 'home23.coding-receipt.v1',
      jobId,
      backend: job.backend,
      status,
      label: job.label,
      model: job.model,
      sessionId: job.sessionId,
      exitCode: runtime.exitCode ?? null,
      startedAt: job.startedAt,
      finishedAt,
      durationMs: Math.max(Date.parse(finishedAt) - Date.parse(job.startedAt), 0),
      numTurns: result?.numTurns,
      costUsd: result?.costUsd,
      resultTail: bounded(resultText, RESULT_TAIL_MAX),
      diffStat: stat,
      worktree: job.worktree,
      checkpoint: job.checkpoint,
      eventsCount: runtime.eventsCount,
      toolUseCount: runtime.toolUseCount,
    };
    this.store.writeReceipt(receipt);
    const updated = this.store.updateJob(jobId, {
      status,
      finishedAt,
      exitCode: runtime.exitCode ?? null,
      error: runtime.errorMessage ? bounded(runtime.errorMessage, ERROR_MAX) : job.error,
    });
    this.runtimes.delete(jobId);
    this.log(`job ${jobId} finished: ${status} (${receipt.eventsCount} events, ${receipt.toolUseCount} tool uses)`);
    this.emit({ type: 'job_finished', job: updated, receipt });
    this.runHooks(updated, receipt);
  }

  private runHooks(job: CodingJobRecord, receipt: CodingJobReceipt): void {
    const hook = receipt.status === 'completed' ? this.config.hooks?.onComplete : this.config.hooks?.onFail;
    if (!hook) return;
    const env = {
      ...unprivilegedChildEnv(),
      HOME23_JOB_ID: job.id,
      HOME23_JOB_STATUS: receipt.status,
      HOME23_JOB_LABEL: job.label ?? '',
      HOME23_JOB_DIR: this.store.jobDir(job.id),
      HOME23_JOB_BACKEND: job.backend,
    };
    try {
      exec(hook, { env, timeout: HOOK_TIMEOUT_MS }, (err) => {
        if (err) this.log(`hook for job ${job.id} failed: ${bounded(err.message, 200)}`);
      });
    } catch (err) {
      this.log(`hook for job ${job.id} failed to start: ${bounded((err as Error).message, 200)}`);
    }
  }

  private emit(event: Parameters<BridgeLifecycleListener>[0]): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        this.log(`lifecycle listener error: ${bounded((err as Error).message, 200)}`);
      }
    }
  }
}
