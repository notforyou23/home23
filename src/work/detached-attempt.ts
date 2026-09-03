/**
 * One create-Work → run-Attempt → return-result path for long assignments.
 *
 * Calls Lane 3 Work/lease APIs. Execution is scheduled on a Work-scoped chat
 * so the conversation run lock is not held for the life of the Attempt.
 * Completion is idempotent: one canonical Jerry result Message.
 */
import { createHash, randomBytes } from 'node:crypto';

import type {
  ContextManifestInput,
  CreateWorkInput as CanonicalCreateWorkInput,
  CreateWorkResult,
  WorkRecord,
} from '../coordination/work/index.js';
import type {
  LeaseBindingInput,
  OfferLeaseInput,
  OfferLeaseResult,
  TerminalizeInput,
  TerminalizeResult,
} from '../coordination/leases/index.js';
import type { MediaAttachment } from '../types.js';
import { handleWorkCompletion, type CompletionDeps } from './completion.js';
import { requestAsyncWorkCancel, type WorkCancelDeps, type WorkCancelOutcome } from './cancel.js';
import {
  delegatedAttemptChatId,
  residentAttemptChatId,
} from './detach.js';
import type { WorkRegistry } from './registry.js';
import type { CoordinationCompletionCommit, ReceiptSinks } from './receipt-delivery.js';
import type {
  AsyncWorkRecord,
  AsyncWorkTerminalResult,
  CoordinationWorkDestination,
  WorkOffice,
} from './types.js';

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function canonicalTimestamp(date: Date): string {
  const value = date.toISOString();
  if (value.length !== 24) throw new Error('detached Attempt timestamps require UTC milliseconds');
  return value;
}

export interface ConversationRunLock {
  isRunning(chatId: string): boolean;
  markActive(chatId: string): void;
  clear(chatId: string): void;
}

export interface DetachedDispatchAuthority {
  principalId: string;
  targetPrincipalId: string;
  residentBinding: string;
  residentInstanceId: string;
  authorityReference: string;
  channelId: string;
  conversationId: string;
  originMessageId: string;
  conversationChatId: string;
  instruction: string;
}

export interface DetachedAttemptDispatchInput extends DetachedDispatchAuthority {
  office: WorkOffice;
  label: string;
  manifest: ContextManifestInput;
  idempotencyKey: string;
  requestId: string;
  correlationId: string;
  workKind?: string;
  maxAutomaticOffers?: number;
  deadlineAt?: string;
}

export interface CanonicalResultCommit {
  commit(input: {
    workId: string;
    channelId: string;
    conversationId: string;
    originMessageId: string;
    text: string | null;
    artifactIds: readonly string[];
    idempotencyKey: string;
  }): Promise<{ messageId: string; replayed: boolean }>;
}

export interface DetachedAttemptRunner {
  run(input: {
    attemptChatId: string;
    conversationChatId: string;
    office: WorkOffice;
    instruction: string;
    authority: Readonly<DetachedDispatchAuthority>;
    destination: CoordinationWorkDestination;
    onProgress: (summary: string) => void;
    onEvidence: (note: string) => void;
  }): Promise<{
    text: string;
    artifacts?: readonly MediaAttachment[];
  }>;
}

export interface DetachedAttemptWorkPort {
  create(input: CanonicalCreateWorkInput): CreateWorkResult;
  get(workId: string): WorkRecord | null;
}

export interface DetachedAttemptLeasePort {
  offer(input: OfferLeaseInput): OfferLeaseResult;
  accept(input: LeaseBindingInput): { work: WorkRecord; attempt: { id: string }; lease: { id: string } };
  start(input: LeaseBindingInput): { work: WorkRecord; attempt: { id: string }; lease: { id: string } };
  current(workId: string): {
    work: WorkRecord;
    attempt: {
      id: string;
      holderPrincipalId: string;
      holderInstanceId: string;
      authorityReference: string;
      fencingToken: number;
    };
    lease: { id: string };
  };
  terminalize(input: TerminalizeInput): TerminalizeResult;
}

export interface DetachedAttemptResult {
  workId: string;
  harnessWorkId: string;
  messageId: string | null;
  replayed: boolean;
  text: string | null;
  artifactIds: readonly string[];
  status: 'completed' | 'failed' | 'cancelled';
}

export interface DetachedAttemptHandle {
  workId: string;
  harnessWorkId: string;
  attemptId: string;
  leaseId: string;
  fencingToken: number;
  attemptChatId: string;
  conversationChatId: string;
  office: WorkOffice;
  authority: Readonly<DetachedDispatchAuthority>;
  settled: Promise<DetachedAttemptResult>;
}

export interface DetachedAttemptPathDeps {
  registry: WorkRegistry;
  work: DetachedAttemptWorkPort;
  leases: DetachedAttemptLeasePort;
  runner: DetachedAttemptRunner;
  results: CanonicalResultCommit;
  lock: ConversationRunLock;
  now?: () => Date;
}

function bindingFor(
  input: DetachedAttemptDispatchInput,
  offer: OfferLeaseResult,
): LeaseBindingInput {
  return {
    workId: offer.work.id,
    attemptId: offer.attempt.id,
    leaseId: offer.lease.id,
    holderPrincipalId: input.targetPrincipalId,
    holderInstanceId: input.residentInstanceId,
    fencingToken: offer.fencingToken,
    requestId: input.requestId,
    correlationId: input.correlationId,
  };
}

function destinationFor(
  input: DetachedAttemptDispatchInput,
  workId: string,
  binding: LeaseBindingInput,
): CoordinationWorkDestination {
  return Object.freeze({
    kind: 'coordination',
    parentWorkId: workId,
    channelId: input.channelId,
    conversationId: input.conversationId,
    originMessageId: input.originMessageId,
    attemptId: binding.attemptId,
    leaseId: binding.leaseId,
    fencingToken: binding.fencingToken,
    targetPrincipalId: input.targetPrincipalId,
    residentBinding: input.residentBinding,
    residentInstanceId: input.residentInstanceId,
    authorityReference: input.authorityReference,
  });
}

function attemptChatFor(office: WorkOffice, channelId: string, workId: string): string {
  return office === 'delegated'
    ? delegatedAttemptChatId(channelId, workId, randomBytes(16).toString('hex'))
    : residentAttemptChatId(channelId, workId);
}

export function createDetachedAttemptPath(deps: DetachedAttemptPathDeps) {
  const now = deps.now ?? (() => new Date());
  const inflight = new Map<string, DetachedAttemptHandle>();
  const completed = new Map<string, DetachedAttemptResult>();

  const lastMessage = new Map<string, { messageId: string; replayed: boolean }>();

  const resultSink = (artifactIds: readonly string[]): ReceiptSinks => ({
    appendHistory: () => {
      throw new Error('detached Attempt must not append conversation transcript rows');
    },
    commitCoordinationCompletion: async (commit: CoordinationCompletionCommit) => {
      if (commit.status !== 'completed' || !commit.terminalText?.trim()) return;
      const committed = await deps.results.commit({
        workId: commit.parentWorkId,
        channelId: commit.channelId,
        conversationId: commit.conversationId,
        originMessageId: commit.originMessageId,
        text: commit.terminalText,
        artifactIds,
        idempotencyKey: `work-result:${commit.parentWorkId}`,
      });
      lastMessage.set(commit.childWorkId, committed);
    },
  });

  const completionDeps = (artifactIds: readonly string[]): CompletionDeps => ({
    registry: deps.registry,
    sinks: resultSink(artifactIds),
    review: { coding: false, subagent: false, cron: false },
    isChatBusy: (chatId) => deps.lock.isRunning(chatId),
    waitForIdleMs: 0,
    idlePollMs: 1,
    runReviewTurn: async () => {
      throw new Error('detached Attempt completion must not run a conversation review turn');
    },
  });

  async function deliver(
    harness: AsyncWorkRecord,
    result: string | AsyncWorkTerminalResult,
    artifactIds: readonly string[],
  ): Promise<void> {
    await handleWorkCompletion(harness, result, completionDeps(artifactIds));
  }

  async function settle(
    input: DetachedAttemptDispatchInput,
    authority: Readonly<DetachedDispatchAuthority>,
    binding: LeaseBindingInput,
    destination: CoordinationWorkDestination,
    harness: AsyncWorkRecord,
    attemptChatId: string,
  ): Promise<DetachedAttemptResult> {
    const cached = completed.get(harness.workId);
    if (cached) return cached;

    let status: DetachedAttemptResult['status'] = 'failed';
    let text: string | null = null;
    let receiptText = `[Async work failed] ${harness.label}\n(work ${harness.workId})`;
    const artifactIds: string[] = [];

    try {
      deps.lock.markActive(attemptChatId);
      try {
        const ran = await deps.runner.run({
          attemptChatId,
          conversationChatId: input.conversationChatId,
          office: input.office,
          instruction: input.instruction,
          authority,
          destination,
          onProgress: (summary) => deps.registry.noteProgress(harness.workId, summary),
          onEvidence: (note) => {
            deps.registry.appendEvidence(harness.workId, note);
          },
        });
        const trimmed = ran.text.trim();
        if (!trimmed && (ran.artifacts?.length ?? 0) === 0) {
          throw new Error('successful detached Attempt produced no answer');
        }
        text = trimmed || null;
        receiptText = `[Attempt complete] ${harness.label}`;
        status = 'completed';
      } finally {
        deps.lock.clear(attemptChatId);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      receiptText = `[Async work failed] ${harness.label}\n\nError: ${message}\n(work ${harness.workId})`;
      status = 'failed';
      text = null;
    }

    const terminal: AsyncWorkTerminalResult = Object.freeze({
      receiptText,
      resultText: text,
      artifacts: Object.freeze([]),
    });
    const done = deps.registry.complete(
      harness.workId,
      status === 'completed' ? 'completed' : 'failed',
      status === 'failed' ? receiptText : undefined,
      terminal,
    );

    deps.leases.terminalize({
      ...binding,
      receipt: {
        status: status === 'completed' ? 'succeeded' : 'failed',
        sourceReference: input.authorityReference,
        resultDigest: text ? sha256(text) : null,
        artifactIds,
        timestamp: canonicalTimestamp(now()),
      },
    });

    await deliver(done, terminal, artifactIds);
    const message = lastMessage.get(harness.workId);
    const result: DetachedAttemptResult = Object.freeze({
      workId: binding.workId,
      harnessWorkId: harness.workId,
      messageId: message?.messageId ?? null,
      replayed: message?.replayed ?? false,
      text,
      artifactIds: Object.freeze([...artifactIds]),
      status,
    });
    completed.set(harness.workId, result);
    return result;
  }

  function dispatch(input: DetachedAttemptDispatchInput): DetachedAttemptHandle {
    if (!input.instruction.trim()) {
      throw new TypeError('detached Attempt instruction is required');
    }
    if (input.authorityReference !== `resident:${input.residentBinding}`) {
      throw new TypeError('authority reference must be resident:<binding>');
    }

    const authority = Object.freeze({
      principalId: input.principalId,
      targetPrincipalId: input.targetPrincipalId,
      residentBinding: input.residentBinding,
      residentInstanceId: input.residentInstanceId,
      authorityReference: input.authorityReference,
      channelId: input.channelId,
      conversationId: input.conversationId,
      originMessageId: input.originMessageId,
      conversationChatId: input.conversationChatId,
      instruction: input.instruction,
    });

    const created = deps.work.create({
      principalId: input.principalId,
      targetPrincipalId: input.targetPrincipalId,
      channelId: input.channelId,
      originMessageId: input.originMessageId,
      roundId: null,
      kind: input.workKind ?? 'resident_turn',
      idempotencyKey: input.idempotencyKey,
      manifest: input.manifest,
      maxAutomaticOffers: input.maxAutomaticOffers ?? 2,
      requestId: input.requestId,
      correlationId: input.correlationId,
    });

    const existing = inflight.get(created.work.id);
    if (existing) return existing;

    let binding: LeaseBindingInput;
    if (created.replayed && created.work.currentAttemptId) {
      const current = deps.leases.current(created.work.id);
      binding = {
        workId: created.work.id,
        attemptId: current.attempt.id,
        leaseId: current.lease.id,
        holderPrincipalId: current.attempt.holderPrincipalId,
        holderInstanceId: current.attempt.holderInstanceId,
        fencingToken: current.attempt.fencingToken,
        requestId: input.requestId,
        correlationId: input.correlationId,
      };
    } else {
      const offer = deps.leases.offer({
        workId: created.work.id,
        holderPrincipalId: input.targetPrincipalId,
        holderInstanceId: input.residentInstanceId,
        authorityReference: input.authorityReference,
        automatic: true,
        requestId: input.requestId,
        correlationId: input.correlationId,
      });
      binding = bindingFor(input, offer);
      deps.leases.accept(binding);
      deps.leases.start(binding);
    }

    const destination = destinationFor(input, created.work.id, binding);
    const attemptChatId = attemptChatFor(input.office, input.channelId, created.work.id);
    const harness = deps.registry.create({
      kind: 'subagent',
      originChatId: residentAttemptChatId(input.channelId, created.work.id),
      parentWorkId: created.work.id,
      coordinationDestination: destination,
      deliveryMode: 'detached',
      office: input.office,
      label: input.label,
      resultHandle: { type: 'subagent_chat', chatId: attemptChatId },
    });
    deps.registry.appendEvidence(
      harness.workId,
      `detached ${input.office} attempt ${binding.attemptId} off ${input.conversationChatId}`,
    );
    if (input.deadlineAt) {
      deps.registry.appendEvidence(harness.workId, `deadline ${input.deadlineAt}`);
    }

    const handle: DetachedAttemptHandle = {
      workId: created.work.id,
      harnessWorkId: harness.workId,
      attemptId: binding.attemptId,
      leaseId: binding.leaseId,
      fencingToken: binding.fencingToken,
      attemptChatId,
      conversationChatId: input.conversationChatId,
      office: input.office,
      authority,
      settled: settle(input, authority, binding, destination, harness, attemptChatId)
        .finally(() => inflight.delete(created.work.id)),
    };
    inflight.set(created.work.id, handle);
    return handle;
  }

  async function replayCompletion(harnessWorkId: string): Promise<DetachedAttemptResult | undefined> {
    const cached = completed.get(harnessWorkId);
    const harness = deps.registry.get(harnessWorkId);
    if (!harness) return cached;
    const terminal = harness.terminalResult ?? {
      receiptText: `[Async work ${harness.status}] ${harness.label}\n(work ${harness.workId})`,
      resultText: cached?.text ?? null,
      artifacts: Object.freeze([]),
    };
    await deliver(harness, terminal, cached?.artifactIds ?? []);
    if (!cached) return undefined;
    const again = await deps.results.commit({
      workId: cached.workId,
      channelId: harness.coordinationDestination?.channelId ?? '',
      conversationId: harness.coordinationDestination?.conversationId ?? '',
      originMessageId: harness.coordinationDestination?.originMessageId ?? '',
      text: cached.text,
      artifactIds: cached.artifactIds,
      idempotencyKey: `work-result:${cached.workId}`,
    });
    const replayed: DetachedAttemptResult = Object.freeze({
      ...cached,
      messageId: again.messageId,
      replayed: true,
    });
    completed.set(harnessWorkId, replayed);
    return replayed;
  }

  return Object.freeze({
    dispatch,
    replayCompletion,
    noteProgress: (harnessWorkId: string, summary: string) =>
      deps.registry.noteProgress(harnessWorkId, summary),
    appendEvidence: (harnessWorkId: string, note: string) =>
      deps.registry.appendEvidence(harnessWorkId, note),
    requestCancel: (cancel: WorkCancelDeps, harnessWorkId: string): WorkCancelOutcome =>
      requestAsyncWorkCancel(cancel, harnessWorkId),
    getHarness: (harnessWorkId: string) => deps.registry.get(harnessWorkId),
  });
}
