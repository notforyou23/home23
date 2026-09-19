/** Exact execution controls. The caller supplies authenticated, resolved identities. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CodingJobRecord } from '../acp/types.js';
import type { WorkRegistry } from '../work/registry.js';
import type { ConversationHistory } from './history.js';
import { STEER_PREFIX, STEER_QUEUE_CAP } from './steer-queue.js';

export type ExecutionControlStatus = 'cancellation_requested' | 'already_terminal' | 'stale_target'
  | 'queued' | 'applied' | 'not_applied' | 'unknown';
export interface ExecutionControlRequest {
  operation: 'cancel' | 'steer';
  jobId?: string;
  chatId?: string;
  turnId?: string;
  expectedJobId?: string;
  expectedTurnId?: string;
  harnessWorkId?: string;
  idempotencyKey: string;
  text?: string;
}
export interface ExecutionControlReceipt {
  operationId: string;
  targetId: string;
  status: ExecutionControlStatus;
  reason?: string;
}
export interface ExactSteerRequest { chatId: string; turnId: string; idempotencyKey: string; text: string }
interface QueuedSteer {
  type: 'execution_control';
  turn_id: string;
  operationId: string;
  fingerprint: string;
  status: 'queued' | 'not_applied';
  text: string;
  ts: string;
}
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
const operationIdFor = (key: string): string => `ec_${digest(key).slice(0, 32)}`;
function validKey(key: string): boolean { return typeof key === 'string' && key.length > 0 && Buffer.byteLength(key) <= 128; }

/** Queue durability lives with the exact turn, never in a successor chat turn. */
export class DurableExecutionSteering {
  private readonly pending = new Map<string, QueuedSteer[]>();
  constructor(private readonly history: Pick<ConversationHistory, 'loadRaw' | 'appendRecord'>,
    private readonly active: (chatId: string, turnId: string) => boolean) {}

  enqueue(request: ExactSteerRequest): ExecutionControlReceipt {
    if (!validKey(request.idempotencyKey)) throw new TypeError('invalid idempotency key');
    const { chatId, turnId } = request;
    const operationId = operationIdFor(request.idempotencyKey);
    const receipt = (status: ExecutionControlStatus, reason?: string): ExecutionControlReceipt => ({ operationId, targetId: turnId, status, ...(reason ? { reason } : {}) });
    const text = request.text.trim();
    if (!text || Buffer.byteLength(text) > 16 * 1024) return receipt('not_applied', 'invalid_text');
    const fingerprint = digest(JSON.stringify({ chatId, turnId, text }));
    const raw = this.history.loadRaw(chatId) as Array<Record<string, unknown>>;
    const prior = raw.find(row => row.type === 'execution_control' && row.operationId === operationId) as unknown as QueuedSteer | undefined;
    if (prior && prior.fingerprint !== fingerprint) return receipt('stale_target', 'idempotency_conflict');
    if (raw.some(row => row.role === 'user' && (row.executionControl as { operationId?: string } | undefined)?.operationId === operationId)) {
      return receipt('applied');
    }
    const last = raw.filter(row => row.type === 'execution_control' && row.operationId === operationId).at(-1);
    if (last?.status === 'not_applied') return receipt('not_applied', 'turn_ended');
    if (!this.active(chatId, turnId)) {
      if (prior) this.history.appendRecord(chatId, { ...prior, status: 'not_applied', ts: new Date().toISOString() });
      return receipt(prior ? 'not_applied' : 'stale_target', 'turn_not_active');
    }
    const key = JSON.stringify([chatId, turnId]);
    const pending = this.pending.get(key) ?? [];
    if (pending.some(note => note.operationId === operationId)) return receipt('queued');
    // A receipt can survive a lost reply. Restore only to the identical still-active turn.
    if (pending.length >= STEER_QUEUE_CAP) return receipt('not_applied', 'queue_full');
    const note: QueuedSteer = prior ?? { type: 'execution_control', turn_id: turnId, operationId, fingerprint, status: 'queued', text, ts: new Date().toISOString() };
    if (!prior) this.history.appendRecord(chatId, note);
    pending.push(note);
    this.pending.set(key, pending);
    return receipt('queued');
  }

  consume(chatId: string, turnId: string, appendToApi: (text: string) => void, onReceipt?: (receipt: ExecutionControlReceipt) => void): void {
    const key = JSON.stringify([chatId, turnId]);
    const notes = this.pending.get(key);
    if (!notes?.length || !this.active(chatId, turnId)) return;
    for (const note of [...notes]) {
      const text = `${STEER_PREFIX} ${note.text}`;
      // One journal write is the durable instruction and the applied receipt. No
      // separate acknowledgement can falsely attest to a missing instruction.
      this.history.appendRecord(chatId, { role: 'user', content: text, ts: new Date().toISOString(),
        executionControl: { operationId: note.operationId, turnId } });
      notes.shift();
      appendToApi(text);
      onReceipt?.({ operationId: note.operationId, targetId: turnId, status: 'applied' });
    }
    this.pending.delete(key);
  }

  finish(chatId: string, turnId: string, onReceipt?: (receipt: ExecutionControlReceipt) => void): void {
    const key = JSON.stringify([chatId, turnId]);
    const notes = this.pending.get(key) ?? [];
    this.pending.delete(key);
    for (const note of notes) {
      try {
        this.history.appendRecord(chatId, { ...note, status: 'not_applied', ts: new Date().toISOString() });
        onReceipt?.({ operationId: note.operationId, targetId: turnId, status: 'not_applied' });
      }
      catch { /* A retained queued receipt without proof of application remains unknown. */ }
    }
  }
}

export interface ExecutionControlPort { execute(request: ExecutionControlRequest): Promise<ExecutionControlReceipt> }
export interface ExecutionControlDependencies {
  instanceDir: string;
  agent: {
    isTurnActive(chatId: string, turnId: string): boolean;
    executionTurnState(chatId: string, turnId: string): 'active' | 'terminal' | 'unknown';
    executionTurnOrigin?(chatId: string, turnId: string): { harnessWorkId: string } | undefined;
    steerExecution(request: ExactSteerRequest): ExecutionControlReceipt;
    stop(chatId: string, turnId: string): { stopped: boolean };
  };
  codingBridge?: { getJob(id: string): CodingJobRecord | undefined; cancelJob(id: string): Promise<unknown> } | null;
  registry?: Pick<WorkRegistry, 'get' | 'requestCancel'> | null;
}

/** Durable request identity plus an exact-target recheck inside the owning process. */
export function createExecutionControlPort(deps: ExecutionControlDependencies): ExecutionControlPort {
  const inFlight = new Map<string, Promise<ExecutionControlReceipt>>();
  async function executeOnce(request: ExecutionControlRequest): Promise<ExecutionControlReceipt> {
    if (!validKey(request.idempotencyKey)) throw new TypeError('invalid idempotency key');
    const operationId = operationIdFor(request.idempotencyKey);
    const targetId = request.jobId ?? request.turnId ?? '';
    const receipt = (status: ExecutionControlStatus, reason?: string): ExecutionControlReceipt => ({ operationId, targetId, status, ...(reason ? { reason } : {}) });
    const coding = !!request.jobId && !request.chatId && !request.turnId;
    const turn = !request.jobId && !!request.chatId && !!request.turnId;
    if ((!coding && !turn) || (coding && request.expectedJobId !== request.jobId)
        || (turn && request.expectedTurnId !== request.turnId)) return receipt('stale_target', 'identity_mismatch');
    if (request.operation !== 'cancel' && request.operation !== 'steer') return receipt('stale_target', 'unsupported_operation');
    const fingerprint = digest(JSON.stringify({ operation: request.operation, jobId: request.jobId,
      chatId: request.chatId, turnId: request.turnId, harnessWorkId: request.harnessWorkId,
      text: request.operation === 'steer' ? request.text?.trim() : undefined }));
    const dir = join(deps.instanceDir, 'execution-controls');
    const path = join(dir, `${operationId}.json`);
    let prior: { fingerprint: string; receipt: ExecutionControlReceipt } | undefined;
    try { prior = JSON.parse(readFileSync(path, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (prior && prior.fingerprint !== fingerprint) return receipt('stale_target', 'idempotency_conflict');
    if (request.harnessWorkId) {
      const work = deps.registry?.get(request.harnessWorkId);
      const handle = work?.resultHandle;
      if (!handle || (coding ? handle.type !== 'coding_job' || handle.jobId !== request.jobId
        : handle.type === 'coding_job' || handle.chatId !== request.chatId
          || (handle.turnId ? handle.turnId !== request.turnId
            : deps.agent.executionTurnOrigin?.(request.chatId!, request.turnId!)?.harnessWorkId !== request.harnessWorkId))) {
        return receipt('stale_target', 'work_binding_mismatch');
      }
    }
    const persist = (result: ExecutionControlReceipt): ExecutionControlReceipt => {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const tmp = `${path}.${randomUUID()}.tmp`;
      writeFileSync(tmp, JSON.stringify({ fingerprint, receipt: result }) + '\n', { mode: 0o600 });
      renameSync(tmp, path);
      return result;
    };
    if (request.operation === 'steer') {
      if (!turn) return persist(receipt('not_applied', 'coding_steer_unsupported'));
      if (!prior) persist(receipt('unknown', 'dispatch_pending'));
      return persist(deps.agent.steerExecution({ chatId: request.chatId!, turnId: request.turnId!,
        text: request.text ?? '', idempotencyKey: request.idempotencyKey }));
    }
    if (prior && prior.receipt.status !== 'unknown') return prior.receipt;
    if (coding) {
      const job = deps.codingBridge?.getJob(request.jobId!);
      if (!job) return persist(receipt('stale_target', 'job_unavailable'));
      if (!['starting', 'running'].includes(job.status)) return persist(receipt('already_terminal'));
    } else {
      const state = deps.agent.executionTurnState(request.chatId!, request.turnId!);
      if (state !== 'active') return persist(receipt(state === 'terminal' ? 'already_terminal' : 'stale_target', 'turn_not_active'));
    }
    // If the process dies after this point, a retry can safely repeat the same exact cancellation.
    persist(receipt('unknown', 'dispatch_pending'));
    if (request.harnessWorkId) deps.registry?.requestCancel(request.harnessWorkId);
    try {
      if (coding) await deps.codingBridge!.cancelJob(request.jobId!);
      else if (!deps.agent.stop(request.chatId!, request.turnId!).stopped) {
        return persist(receipt('already_terminal'));
      }
      return persist(receipt('cancellation_requested'));
    } catch { return persist(receipt('unknown', 'runtime_acknowledgement_unavailable')); }
  }
  return { execute(request) {
    const key = JSON.stringify(request);
    const prior = inFlight.get(key);
    if (prior) return prior;
    const result = executeOnce(request).finally(() => inFlight.delete(key));
    inFlight.set(key, result);
    return result;
  } };
}
