/**
 * WorkRegistry — lifecycle authority for async work records.
 *
 * Records are created at the tool boundary (coding_run/coding_continue/
 * spawn_agent) where origin context is real. Terminal transitions happen
 * exactly once. Delivery is NOT this module's job — home.ts wires terminal
 * records into the completion pipeline and marks deliveredAt there.
 */
import {
  TERMINAL_WORK_STATUSES,
  newWorkId,
  resolveRootChatId,
  type AsyncWorkKind,
  type AsyncWorkRecord,
  type AsyncWorkStatus,
  type CoordinationWorkDestination,
  type WorkResultHandle,
} from './types.js';
import type { WorkStore } from './work-store.js';
import { workBus } from './work-bus.js';

const PROGRESS_THROTTLE_MS = 15_000;

export interface CreateWorkInput {
  kind: AsyncWorkKind;
  /** May be a `subagent:` chat — resolved to root here. */
  originChatId: string;
  originTurnId?: string;
  parentWorkId?: string;
  coordinationDestination?: CoordinationWorkDestination;
  deliveryMode?: 'detached' | 'inline';
  label: string;
  resultHandle: WorkResultHandle;
}

/** Minimal view of a coding job for boot reconciliation (avoids acp type import cycle). */
export interface ReconcileJobView {
  id: string;
  status: string; // starting | running | completed | failed | cancelled | interrupted
  requestedBy?: string;
  label?: string;
  startedAt: string;
}

export interface ReconcileResult {
  /** Terminal records whose receipt never reached the origin (deliver now). */
  needsDelivery: AsyncWorkRecord[];
  interrupted: AsyncWorkRecord[];
  backfilled: AsyncWorkRecord[];
}

const CODING_TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted']);

export class WorkRegistry {
  private readonly store: WorkStore;
  private readonly agent: string;
  private readonly cancelRequested = new Set<string>();
  private readonly lastProgressAt = new Map<string, number>();

  constructor(deps: { store: WorkStore; agent: string }) {
    this.store = deps.store;
    this.agent = deps.agent;
  }

  create(input: CreateWorkInput): AsyncWorkRecord {
    const now = new Date().toISOString();
    const record: AsyncWorkRecord = {
      schema: 'home23.async-work.v1',
      workId: newWorkId(),
      kind: input.kind,
      agent: this.agent,
      originChatId: resolveRootChatId(input.originChatId),
      originTurnId: input.originTurnId,
      parentWorkId: input.parentWorkId,
      coordinationDestination: input.coordinationDestination,
      deliveryMode: input.deliveryMode ?? 'detached',
      label: input.label,
      status: 'running',
      startedAt: now,
      updatedAt: now,
      resultHandle: input.resultHandle,
      verification: 'none',
    };
    this.store.write(record);
    this.notify(record, 'created');
    return record;
  }

  get(workId: string): AsyncWorkRecord | undefined {
    return this.store.read(workId);
  }

  list(filter: { originChatId?: string; active?: boolean; limit?: number } = {}): AsyncWorkRecord[] {
    let records = this.store.list();
    if (filter.originChatId) records = records.filter(r => r.originChatId === filter.originChatId);
    if (filter.active) records = records.filter(r => !TERMINAL_WORK_STATUSES.has(r.status));
    if (filter.limit && filter.limit > 0) records = records.slice(0, filter.limit);
    return records;
  }

  findByJobId(jobId: string): AsyncWorkRecord | undefined {
    return this.store.list().find(r => r.resultHandle.type === 'coding_job' && r.resultHandle.jobId === jobId);
  }

  update(workId: string, patch: Partial<AsyncWorkRecord>): AsyncWorkRecord | undefined {
    const next = this.store.update(workId, patch);
    if (next) this.notify(next, 'updated');
    return next;
  }

  /** Record operator cancel intent so a kill that lands as 'failed' reports 'cancelled'. */
  requestCancel(workId: string): void {
    this.cancelRequested.add(workId);
  }

  /**
   * Terminal transition, exactly once. A second call returns the record
   * unchanged — recovery and live listeners can race safely.
   */
  complete(workId: string, status: AsyncWorkStatus, error?: string): AsyncWorkRecord {
    return this.completeTerminal(workId, status, error, false);
  }

  /**
   * Terminalize foreground work and mark its result delivered in one durable
   * store write. Boot reconciliation must never replay this result through the
   * detached completion pipeline.
   */
  completeInline(workId: string, status: AsyncWorkStatus, error?: string): AsyncWorkRecord {
    return this.completeTerminal(workId, status, error, true);
  }

  private completeTerminal(
    workId: string,
    status: AsyncWorkStatus,
    error: string | undefined,
    deliveredInline: boolean,
  ): AsyncWorkRecord {
    const current = this.store.read(workId);
    if (!current) throw new Error(`unknown work id: ${workId}`);
    if (TERMINAL_WORK_STATUSES.has(current.status)) return current;
    const mapped: AsyncWorkStatus =
      status === 'failed' && this.cancelRequested.has(workId) ? 'cancelled' : status;
    this.cancelRequested.delete(workId);
    const finishedAt = new Date().toISOString();
    const done = this.store.update(workId, {
      status: mapped,
      finishedAt,
      ...(deliveredInline ? { deliveredAt: finishedAt } : {}),
      ...(error ? { error } : {}),
    })!;
    this.notify(done, 'terminal');
    return done;
  }

  /** Throttled progress note (disk write at most every 15s per work item). */
  noteProgress(workId: string, summary: string): void {
    const now = Date.now();
    const last = this.lastProgressAt.get(workId) ?? 0;
    if (now - last < PROGRESS_THROTTLE_MS) return;
    const current = this.store.read(workId);
    if (!current || TERMINAL_WORK_STATUSES.has(current.status)) return;
    this.lastProgressAt.set(workId, now);
    const next = this.store.update(workId, { progressSummary: summary });
    if (next) this.notify(next, 'progress');
  }

  private notify(record: AsyncWorkRecord, reason: string): void {
    workBus.emit(record, reason);
  }

  /**
   * Boot reconciliation, run after bridge.recover():
   * - non-terminal subagent work → interrupted (the in-process promise is gone)
   * - non-terminal coding work → sync with the job store (finished while the
   *   harness was down → terminal now; still running → leave running)
   * - terminal work never delivered → surface for delivery
   * - running jobs with no work record → backfill (root-resolved origin)
   */
  reconcileOnBoot(input: { jobs: ReconcileJobView[] }): ReconcileResult {
    const jobsById = new Map(input.jobs.map(j => [j.id, j]));
    const interrupted: AsyncWorkRecord[] = [];
    const backfilled: AsyncWorkRecord[] = [];

    for (const rec of this.store.list()) {
      if (TERMINAL_WORK_STATUSES.has(rec.status)) continue;
      if (rec.kind === 'subagent') {
        interrupted.push(rec.deliveryMode === 'inline'
          ? this.completeInline(rec.workId, 'interrupted', 'harness restarted while sub-agent was running')
          : this.complete(rec.workId, 'interrupted', 'harness restarted while sub-agent was running'));
        continue;
      }
      if (rec.kind === 'cron') {
        interrupted.push(this.complete(rec.workId, 'interrupted', 'harness restarted while cron agent-turn was running'));
        continue;
      }
      const jobId = rec.resultHandle.type === 'coding_job' ? rec.resultHandle.jobId : null;
      const job = jobId ? jobsById.get(jobId) : undefined;
      if (!job) {
        interrupted.push(this.complete(rec.workId, 'interrupted', 'coding job record missing after restart'));
        continue;
      }
      if (CODING_TERMINAL.has(job.status)) {
        this.complete(rec.workId, job.status as AsyncWorkStatus);
      }
      // else: still running (bridge resumed its tailer) — leave as-is
    }

    for (const job of input.jobs) {
      if (CODING_TERMINAL.has(job.status)) continue;
      if (this.findByJobId(job.id)) continue;
      backfilled.push(this.create({
        kind: 'coding',
        originChatId: job.requestedBy ?? 'unknown',
        label: job.label ?? job.id,
        resultHandle: { type: 'coding_job', jobId: job.id },
      }));
    }

    const needsDelivery = this.store.list().filter(
      r => TERMINAL_WORK_STATUSES.has(r.status) && r.deliveryMode !== 'inline' && !r.deliveredAt,
    );
    return { needsDelivery, interrupted, backfilled };
  }
}
