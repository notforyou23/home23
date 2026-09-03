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
  ReasonedLeaseBindingInput,
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
import {
  TERMINAL_WORK_STATUSES,
  type AsyncWorkRecord,
  type AsyncWorkTerminalResult,
  type CoordinationWorkDestination,
  type WorkOffice,
} from './types.js';

const ARTIFACT_ID_RE =
  /^art_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TERMINAL_CANONICAL_STATES = new Set(['succeeded', 'failed', 'cancelled']);

function honestArtifactSummary(label: string, artifacts: readonly MediaAttachment[]): string {
  const names = artifacts.map((artifact) =>
    (artifact.fileName || artifact.path.split('/').pop() || artifact.type).slice(0, 80));
  const listed = names.slice(0, 8).join(', ');
  const extra = names.length > 8 ? `, +${names.length - 8} more` : '';
  return `Work finished: ${label} (${artifacts.length} artifact${artifacts.length === 1 ? '' : 's'}: ${listed}${extra})`;
}

function artifactIdsFromMedia(artifacts: readonly MediaAttachment[]): string[] {
  return artifacts.map((artifact) => artifact.path).filter((path) => ARTIFACT_ID_RE.test(path));
}

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
  revoke(input: ReasonedLeaseBindingInput): unknown;
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
  resolveArtifactIds?: (input: {
    artifacts: readonly MediaAttachment[];
    binding: LeaseBindingInput;
  }) => readonly string[] | Promise<readonly string[]>;
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
  const completedByWork = new Map<string, DetachedAttemptResult>();
  const bindings = new Map<string, LeaseBindingInput>();
  const cancelRequested = new Set<string>();
  const lastMessage = new Map<string, { messageId: string; replayed: boolean }>();

  const resultSink = (artifactIds: readonly string[]): ReceiptSinks => ({
    appendHistory: () => {
      throw new Error('detached Attempt must not append conversation transcript rows');
    },
    commitCoordinationCompletion: async (commit: CoordinationCompletionCommit) => {
      const summaryArtifacts = commit.artifacts.length > 0
        ? commit.artifacts
        : artifactIds.map((id) => ({ type: 'document' as const, path: id, fileName: id }));
      const text = commit.terminalText?.trim()
        || (artifactIds.length > 0 ? honestArtifactSummary(commit.childWorkId, summaryArtifacts) : '');
      if (commit.status !== 'completed' || (!text && artifactIds.length === 0)) return;
      const committed = await deps.results.commit({
        workId: commit.parentWorkId,
        channelId: commit.channelId,
        conversationId: commit.conversationId,
        originMessageId: commit.originMessageId,
        text: text || null,
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

  function findHarness(workId: string): AsyncWorkRecord | undefined {
    return deps.registry.list({}).find((record) => record.parentWorkId === workId);
  }

  function cacheResult(result: DetachedAttemptResult): DetachedAttemptResult {
    completed.set(result.harnessWorkId, result);
    completedByWork.set(result.workId, result);
    return result;
  }

  function wasCancelled(harnessWorkId: string, workId: string): boolean {
    return cancelRequested.has(harnessWorkId) || cancelRequested.has(workId);
  }

  function mapCanonicalStatus(state: string | undefined): DetachedAttemptResult['status'] | undefined {
    if (state === 'succeeded') return 'completed';
    if (state === 'failed') return 'failed';
    if (state === 'cancelled') return 'cancelled';
    return undefined;
  }

  function persistableArtifacts(
    media: readonly MediaAttachment[],
    artifactIds: readonly string[],
  ): MediaAttachment[] {
    const have = new Set(artifactIdsFromMedia(media));
    const extras = artifactIds
      .filter((id) => !have.has(id))
      .map((id) => ({ type: 'document' as const, path: id, fileName: id }));
    return [...media, ...extras];
  }

  async function resolveIds(
    media: readonly MediaAttachment[],
    binding: LeaseBindingInput,
  ): Promise<string[]> {
    const fromMedia = artifactIdsFromMedia(media);
    const resolved = deps.resolveArtifactIds
      ? [...await deps.resolveArtifactIds({ artifacts: media, binding })]
      : [];
    return [...new Set([...fromMedia, ...resolved])];
  }

  async function replayTerminal(
    workId: string,
    input: DetachedAttemptDispatchInput,
    harness: AsyncWorkRecord | undefined,
  ): Promise<DetachedAttemptResult> {
    const cached = completedByWork.get(workId)
      ?? (harness ? completed.get(harness.workId) : undefined);
    const work = deps.work.get(workId);
    const status = cached?.status
      ?? mapCanonicalStatus(work?.state)
      ?? (harness?.status === 'completed' ? 'completed'
        : harness?.status === 'cancelled' ? 'cancelled'
        : harness?.status === 'failed' ? 'failed'
        : 'completed');
    const text = cached?.text ?? harness?.terminalResult?.resultText ?? null;
    const artifactIds = cached?.artifactIds
      ?? artifactIdsFromMedia(harness?.terminalResult?.artifacts ?? []);
    let messageId = cached?.messageId ?? null;
    if (status === 'completed' && (text || artifactIds.length > 0)) {
      const committed = await deps.results.commit({
        workId,
        channelId: harness?.coordinationDestination?.channelId ?? input.channelId,
        conversationId: harness?.coordinationDestination?.conversationId ?? input.conversationId,
        originMessageId: harness?.coordinationDestination?.originMessageId ?? input.originMessageId,
        text,
        artifactIds,
        idempotencyKey: `work-result:${workId}`,
      });
      messageId = committed.messageId;
    }
    return cacheResult(Object.freeze({
      workId,
      harnessWorkId: harness?.workId ?? cached?.harnessWorkId ?? `replay:${workId}`,
      messageId,
      replayed: true,
      text,
      artifactIds: Object.freeze([...artifactIds]),
      status,
    }));
  }

  function replayHandle(
    input: DetachedAttemptDispatchInput,
    authority: Readonly<DetachedDispatchAuthority>,
    workId: string,
    harness: AsyncWorkRecord | undefined,
  ): DetachedAttemptHandle {
    const dest = harness?.coordinationDestination;
    let current: ReturnType<DetachedAttemptLeasePort['current']> | undefined;
    try {
      current = deps.leases.current(workId);
    } catch {
      current = undefined;
    }
    const attemptChatId = harness?.resultHandle.type === 'subagent_chat'
      ? harness.resultHandle.chatId
      : attemptChatFor(input.office, input.channelId, workId);
    return {
      workId,
      harnessWorkId: harness?.workId ?? `replay:${workId}`,
      attemptId: dest?.attemptId ?? current?.attempt.id ?? '',
      leaseId: dest?.leaseId ?? current?.lease.id ?? '',
      fencingToken: dest?.fencingToken ?? current?.attempt.fencingToken ?? 0,
      attemptChatId,
      conversationChatId: input.conversationChatId,
      office: input.office,
      authority,
      settled: replayTerminal(workId, input, harness),
    };
  }

  async function settle(
    input: DetachedAttemptDispatchInput,
    authority: Readonly<DetachedDispatchAuthority>,
    binding: LeaseBindingInput,
    destination: CoordinationWorkDestination,
    harness: AsyncWorkRecord,
    attemptChatId: string,
  ): Promise<DetachedAttemptResult> {
    const cached = completed.get(harness.workId) ?? completedByWork.get(binding.workId);
    if (cached) return cached;

    let status: DetachedAttemptResult['status'] = 'failed';
    let text: string | null = null;
    let receiptText = `[Async work failed] ${harness.label}\n(work ${harness.workId})`;
    let artifactIds: string[] = [];
    let media: MediaAttachment[] = [];

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
        media = [...(ran.artifacts ?? [])];
        artifactIds = await resolveIds(media, binding);
        const trimmed = ran.text.trim();
        if (!trimmed && media.length === 0 && artifactIds.length === 0) {
          throw new Error('successful detached Attempt produced no answer');
        }
        text = trimmed || honestArtifactSummary(harness.label, persistableArtifacts(media, artifactIds));
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
      artifactIds = [];
      media = [];
    }

    if (wasCancelled(harness.workId, binding.workId)) {
      status = 'cancelled';
      text = null;
      artifactIds = [];
      media = [];
      receiptText = `[Async work cancelled] ${harness.label}\n(work ${harness.workId})`;
    }

    const persisted = persistableArtifacts(media, artifactIds);
    const terminal: AsyncWorkTerminalResult = Object.freeze({
      receiptText,
      resultText: text,
      artifacts: Object.freeze(persisted.map((artifact) => Object.freeze({ ...artifact }))),
    });
    const harnessStatus = status === 'completed' ? 'completed' : status === 'cancelled' ? 'cancelled' : 'failed';
    const done = deps.registry.complete(
      harness.workId,
      harnessStatus,
      status === 'failed' ? receiptText : undefined,
      terminal,
    );

    deps.leases.terminalize({
      ...binding,
      receipt: {
        status: status === 'completed' ? 'succeeded' : status === 'cancelled' ? 'cancelled' : 'failed',
        sourceReference: input.authorityReference,
        resultDigest: status === 'completed' && text ? sha256(text) : null,
        artifactIds: status === 'completed' ? artifactIds : [],
        timestamp: canonicalTimestamp(now()),
      },
    });

    await deliver(done, terminal, status === 'completed' ? artifactIds : []);
    const message = lastMessage.get(harness.workId);
    return cacheResult(Object.freeze({
      workId: binding.workId,
      harnessWorkId: harness.workId,
      messageId: message?.messageId ?? null,
      replayed: message?.replayed ?? false,
      text,
      artifactIds: Object.freeze([...artifactIds]),
      status,
    }));
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

    const workId = created.work.id;
    const flying = inflight.get(workId);
    if (flying) return flying;

    const latest = deps.work.get(workId) ?? created.work;
    const existingHarness = findHarness(workId);
    if (
      TERMINAL_CANONICAL_STATES.has(latest.state)
      || (existingHarness && TERMINAL_WORK_STATUSES.has(existingHarness.status))
    ) {
      return replayHandle(input, authority, workId, existingHarness);
    }

    let binding: LeaseBindingInput;
    if (created.replayed && created.work.currentAttemptId) {
      const current = deps.leases.current(workId);
      binding = {
        workId,
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
        workId,
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

    const destination = destinationFor(input, workId, binding);
    const reuseHarness = existingHarness && !TERMINAL_WORK_STATUSES.has(existingHarness.status)
      ? existingHarness
      : undefined;
    const attemptChatId = reuseHarness?.resultHandle.type === 'subagent_chat'
      ? reuseHarness.resultHandle.chatId
      : attemptChatFor(input.office, input.channelId, workId);
    const harness = reuseHarness ?? deps.registry.create({
      kind: 'subagent',
      originChatId: residentAttemptChatId(input.channelId, workId),
      parentWorkId: workId,
      coordinationDestination: destination,
      deliveryMode: 'detached',
      office: input.office,
      label: input.label,
      resultHandle: { type: 'subagent_chat', chatId: attemptChatId },
    });
    bindings.set(harness.workId, binding);
    if (!reuseHarness) {
      deps.registry.appendEvidence(
        harness.workId,
        `detached ${input.office} attempt ${binding.attemptId} off ${input.conversationChatId}`,
      );
      if (input.deadlineAt) {
        deps.registry.appendEvidence(harness.workId, `deadline ${input.deadlineAt}`);
      }
    }

    const handle: DetachedAttemptHandle = {
      workId,
      harnessWorkId: harness.workId,
      attemptId: binding.attemptId,
      leaseId: binding.leaseId,
      fencingToken: binding.fencingToken,
      attemptChatId,
      conversationChatId: input.conversationChatId,
      office: input.office,
      authority,
      settled: settle(input, authority, binding, destination, harness, attemptChatId)
        .finally(() => inflight.delete(workId)),
    };
    inflight.set(workId, handle);
    return handle;
  }

  async function replayCompletion(harnessWorkId: string): Promise<DetachedAttemptResult | undefined> {
    const harness = deps.registry.get(harnessWorkId);
    const cached = completed.get(harnessWorkId)
      ?? (harness?.parentWorkId ? completedByWork.get(harness.parentWorkId) : undefined);
    if (!harness) return cached;
    const artifactIds = cached?.artifactIds
      ?? artifactIdsFromMedia(harness.terminalResult?.artifacts ?? []);
    const terminal = harness.terminalResult ?? {
      receiptText: `[Async work ${harness.status}] ${harness.label}\n(work ${harness.workId})`,
      resultText: cached?.text ?? null,
      artifacts: Object.freeze(persistableArtifacts([], artifactIds)),
    };
    await deliver(harness, terminal, artifactIds);
    if (!cached) return undefined;
    const again = await deps.results.commit({
      workId: cached.workId,
      channelId: harness.coordinationDestination?.channelId ?? '',
      conversationId: harness.coordinationDestination?.conversationId ?? '',
      originMessageId: harness.coordinationDestination?.originMessageId ?? '',
      text: cached.text,
      artifactIds,
      idempotencyKey: `work-result:${cached.workId}`,
    });
    return cacheResult(Object.freeze({
      ...cached,
      messageId: again.messageId,
      replayed: true,
    }));
  }

  return Object.freeze({
    dispatch,
    replayCompletion,
    noteProgress: (harnessWorkId: string, summary: string) =>
      deps.registry.noteProgress(harnessWorkId, summary),
    appendEvidence: (harnessWorkId: string, note: string) =>
      deps.registry.appendEvidence(harnessWorkId, note),
    requestCancel: (cancel: WorkCancelDeps, harnessWorkId: string): WorkCancelOutcome => {
      const harness = deps.registry.get(harnessWorkId);
      if (!harness) return requestAsyncWorkCancel(cancel, harnessWorkId);
      if (TERMINAL_WORK_STATUSES.has(harness.status)) {
        return requestAsyncWorkCancel(cancel, harnessWorkId);
      }
      cancelRequested.add(harnessWorkId);
      if (harness.parentWorkId) cancelRequested.add(harness.parentWorkId);
      const stored = bindings.get(harnessWorkId);
      if (stored) {
        try {
          deps.leases.revoke({ ...stored, reasonCode: 'operator_cancel' });
        } catch {
          // already revoked / not the current running lease
        }
      }
      return requestAsyncWorkCancel(cancel, harnessWorkId);
    },
    getHarness: (harnessWorkId: string) => deps.registry.get(harnessWorkId),
  });
}
