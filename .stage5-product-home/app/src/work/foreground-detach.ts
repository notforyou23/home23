/**
 * Fail-closed join from a speaking-turn require_work refusal to a detached
 * Attempt. Dispatch only when every required fact and port already exists.
 * Never mint chn_ / cnv_ / msg_ / bot_ / user_ IDs.
 */
import { createHash } from 'node:crypto';

import type { ForegroundDetachRequest } from '../agent/foreground-tool-policy.js';
import type {
  AgentResponse,
  CoordinationTurnOrigin,
  DurableAgentEvent,
  ToolContext,
} from '../agent/types.js';
import { ResidentCommunicationEventProjector } from '../coordination-adapter/index.js';
import {
  SqliteBotConversationBindingAdapter,
  SqliteMessagingRepository,
  type MessagingActorContext,
} from '../coordination/channels/index.js';
import { workResultIdempotencyKey } from '../coordination/contracts/resident-presence.js';
import { SqliteCommunicationEventRepository } from '../coordination/communications/index.js';
import { openCoordinationDatabase, type CoordinationDatabase } from '../coordination/db/index.js';
import { generateCoordinationId } from '../coordination/ids/index.js';
import { createLeaseService } from '../coordination/leases/index.js';
import { createMessageService } from '../coordination/messages/index.js';
import { createBotDirectory, SqliteBotDirectoryRepository } from '../coordination/bots/index.js';
import { createWorkService, M11MessageProvenanceAuthority } from '../coordination/work/index.js';
import {
  createDetachedAttemptPath,
  type CanonicalResultCommit,
  type ConversationRunLock,
  type DetachedAttemptHandle,
  type DetachedAttemptLeasePort,
  type DetachedAttemptRunner,
  type DetachedAttemptWorkPort,
} from './detached-attempt.js';
import { isConversationForegroundChat } from './detach.js';
import type { WorkRegistry } from './registry.js';

export const FOREGROUND_DETACH_MISSING_FACTS = Object.freeze([
  'ports',
  'channelId',
  'conversationId',
  'originMessageId',
  'principalId',
  'targetPrincipalId',
  'residentBinding',
  'residentInstanceId',
  'authorityReference',
  'instruction',
  'attachments',
] as const);

export type ForegroundDetachMissingFact = (typeof FOREGROUND_DETACH_MISSING_FACTS)[number];

export type ForegroundDetachResult =
  | { created: true; handle: DetachedAttemptHandle }
  | { created: false; missing: ForegroundDetachMissingFact[] };

export interface ForegroundDetachFactSource {
  chatId?: string;
  turnRuntime?: { turnId?: string } | null;
  authenticatedUserMessage?: ToolContext['authenticatedUserMessage'];
  channelId?: string;
  conversationId?: string;
  originMessageId?: string;
  principalId?: string;
  targetPrincipalId?: string;
  residentBinding?: string;
  residentInstanceId?: string;
  authorityReference?: string;
  speakingWorkId?: string;
  invocationId?: string;
  executionInstruction?: string;
  assignmentLabel?: string;
}

export interface ForegroundDetachPorts {
  work: DetachedAttemptWorkPort;
  leases: DetachedAttemptLeasePort;
  results: CanonicalResultCommit;
  readChannelState: (channelId: string, originMessageId: string) => { channelSequence: number; eventSequence: number } | null;
  readOriginAttachmentIds: (messageId: string) => readonly string[];
  evidence?: ResidentAttemptEvidencePorts;
  isAccountableResident?: (workId: string, residentBinding: string) => boolean;
  listRecoverableWorkIds?: (residentBinding: string, limit: number) => readonly string[];
  now?: () => Date;
}

export interface ForegroundDetachPathDeps {
  registry: WorkRegistry;
  lock: ConversationRunLock;
  runner: DetachedAttemptRunner;
}

export interface ResidentAttemptEvidencePorts {
  append(input: Parameters<SqliteCommunicationEventRepository['append']>[0]): unknown | Promise<unknown>;
  actorFor(principalId: string): { principalId: string; displayName: string; kind: string } | null;
  isCancellationRequested(workId: string): boolean;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function present(value: string | undefined | null): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function safeAssignmentLabel(instruction: string): string {
  const collapsed = instruction
    .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (collapsed.length <= 100) return collapsed;
  return `${collapsed.slice(0, 99).trimEnd()}…`;
}

function resultMessageId(workId: string): string {
  if (!workId.startsWith('wrk_')) {
    throw new Error('Work ID cannot derive a result Message ID');
  }
  return `msg_${workId.slice(4)}`;
}

export function collectForegroundDetachFacts(
  request: ForegroundDetachRequest,
  context?: ForegroundDetachFactSource,
): {
  facts: {
    chatId: string;
    turnId?: string;
    tool: string;
    channelId?: string;
    conversationId?: string;
    originMessageId?: string;
    principalId?: string;
    targetPrincipalId?: string;
    residentBinding?: string;
    residentInstanceId?: string;
    authorityReference?: string;
    speakingWorkId?: string;
    instruction?: string;
    invocationId?: string;
    executionInstruction?: string;
    assignmentLabel?: string;
  };
  missing: ForegroundDetachMissingFact[];
} {
  const channelId = request.channelId ?? context?.channelId;
  const conversationId = request.conversationId ?? context?.conversationId;
  const originMessageId = request.originMessageId ?? context?.originMessageId;
  const principalId = request.principalId ?? context?.principalId;
  const targetPrincipalId = request.targetPrincipalId ?? context?.targetPrincipalId;
  const residentBinding = request.residentBinding ?? context?.residentBinding;
  const residentInstanceId = request.residentInstanceId ?? context?.residentInstanceId;
  const instruction = request.instruction
    ?? context?.authenticatedUserMessage?.text;
  const executionInstruction = request.executionInstruction ?? instruction;
  let authorityReference = request.authorityReference ?? context?.authorityReference;
  if (!present(authorityReference) && present(residentBinding)) {
    authorityReference = `resident:${residentBinding}`;
  }
  if (
    present(authorityReference)
    && present(residentBinding)
    && authorityReference !== `resident:${residentBinding}`
  ) {
    authorityReference = undefined;
  }

  const missing: ForegroundDetachMissingFact[] = [];
  if (!present(channelId)) missing.push('channelId');
  if (!present(conversationId)) missing.push('conversationId');
  if (!present(originMessageId)) missing.push('originMessageId');
  if (!present(principalId)) missing.push('principalId');
  if (!present(targetPrincipalId)) missing.push('targetPrincipalId');
  if (!present(residentBinding)) missing.push('residentBinding');
  if (!present(residentInstanceId)) missing.push('residentInstanceId');
  if (!present(authorityReference)) missing.push('authorityReference');
  if (!present(instruction) || !present(executionInstruction)) missing.push('instruction');

  return {
    facts: {
      chatId: request.chatId,
      turnId: request.turnId ?? context?.turnRuntime?.turnId,
      tool: request.tool,
      channelId,
      conversationId,
      originMessageId,
      principalId,
      targetPrincipalId,
      residentBinding,
      residentInstanceId,
      authorityReference,
      speakingWorkId: request.speakingWorkId ?? context?.speakingWorkId,
      invocationId: request.invocationId ?? context?.invocationId,
      instruction,
      executionInstruction,
      assignmentLabel: request.assignmentLabel ?? context?.assignmentLabel,
    },
    missing,
  };
}

export function readChannelManifestAnchors(
  database: { readOne<T>(sql: string, ...parameters: Array<string | number | bigint | Buffer | null>): T | undefined },
  channelId: string,
  originMessageId: string,
): { channelSequence: number; eventSequence: number } | null {
  const channel = database.readOne<{ seq: number }>(
    'SELECT channel_sequence AS seq FROM messages WHERE channel_id = ? AND id = ?',
    channelId,
    originMessageId,
  );
  if (!channel || !Number.isSafeInteger(channel.seq) || channel.seq < 1) return null;
  const events = database.readOne<{ seq: number }>(
    `SELECT COALESCE(MAX(sequence), 0) AS seq FROM events
      WHERE aggregate_kind = 'message' AND aggregate_id = ?`,
    originMessageId,
  );
  return {
    channelSequence: channel.seq,
    eventSequence: events && Number.isSafeInteger(events.seq) ? events.seq : 0,
  };
}

export function createForegroundDetachLock(
  agent: Pick<ConversationRunLock, 'isRunning'>,
): ConversationRunLock {
  const attemptChats = new Set<string>();
  return {
    isRunning(chatId) {
      if (isConversationForegroundChat(chatId)) return agent.isRunning(chatId);
      return attemptChats.has(chatId);
    },
    markActive(chatId) {
      if (isConversationForegroundChat(chatId)) return;
      attemptChats.add(chatId);
    },
    clear(chatId) {
      attemptChats.delete(chatId);
    },
  };
}

export function createResidentAttemptRunner(
  agent: {
    runWithTurn(
      chatId: string,
      userText: string,
      opts?: {
        turnId?: string;
        coordinationOrigin?: CoordinationTurnOrigin;
        coordinationDelivery?: import('../agent/types.js').CoordinationTurnDeliveryContext;
        coordinationWorkDestination?: import('./types.js').CoordinationWorkDestination;
        onDurableEvent?: (event: DurableAgentEvent) => void;
      },
    ): Promise<{ turnId: string; response: Promise<AgentResponse> }>;
    stop?(chatId: string, turnId?: string): { stopped: boolean };
  },
  evidence?: ResidentAttemptEvidencePorts,
): DetachedAttemptRunner {
  return {
    async run(input) {
      const origin: CoordinationTurnOrigin = {
        kind: 'coordination',
        workId: input.destination.parentWorkId,
        attemptId: input.destination.attemptId,
        leaseId: input.destination.leaseId,
        holderPrincipalId: input.destination.targetPrincipalId,
        holderInstanceId: input.destination.residentInstanceId,
        authorityReference: input.destination.authorityReference,
        fencingToken: input.destination.fencingToken,
        channelId: input.destination.channelId,
        originMessageId: input.destination.originMessageId,
        roundId: null,
      };
      const actor = evidence?.actorFor(input.destination.targetPrincipalId) ?? null;
      if (evidence && !actor) throw new Error('Working Thread accountable resident is unavailable');
      const projector = actor ? new ResidentCommunicationEventProjector({
        conversationId: input.destination.conversationId,
        responseMessageId: resultMessageId(input.destination.parentWorkId),
        actor,
      }, origin) : null;
      let evidenceFailure: unknown;
      let nestedFailure: string | null = null;
      let evidenceChain = Promise.resolve();
      const turnId = `resident-work-${input.destination.parentWorkId.slice(4)}`;
      let cancelPoll: ReturnType<typeof setInterval> | undefined;
      const abortController = new AbortController();
      const onDurableEvent = (durable: DurableAgentEvent): void => {
        if (durable.event.type === 'tool_result' && durable.event.success === false) {
          nestedFailure = `${durable.event.tool} failed: ${durable.event.result}`;
        }
        if (!evidence || !projector) return;
        const event = projector.project(durable);
        evidenceChain = evidenceChain.then(async () => {
          if (evidenceFailure !== undefined) return;
          try {
            await evidence.append({
              event,
              requestId: generateCoordinationId('request'),
              correlationId: generateCoordinationId('correlation'),
            });
          } catch (error) {
            evidenceFailure = error;
          }
        });
      };
      if (evidence && (agent.stop || input.execute)) {
        cancelPoll = setInterval(() => {
          if (evidence.isCancellationRequested(input.destination.parentWorkId)) {
            abortController.abort(new Error('Working Thread was stopped'));
            agent.stop?.(input.attemptChatId, input.execute ? undefined : turnId);
          }
        }, 500);
        cancelPoll.unref?.();
      }
      try {
        if (input.execute) {
          let sequence = 0;
          const result = await input.execute({
            destination: input.destination,
            attemptChatId: input.attemptChatId,
            abortController,
            onEvent: (event) => onDurableEvent({
              turnId,
              sequence: ++sequence,
              occurredAt: new Date().toISOString(),
              provider: null,
              model: null,
              reasoningEffort: null,
              event,
            }),
          });
          await evidenceChain;
          if (evidenceFailure !== undefined) {
            throw evidenceFailure instanceof Error
              ? evidenceFailure
              : new Error('Working Thread communication evidence could not be persisted');
          }
          if (abortController.signal.aborted) throw new Error('Working Thread was stopped');
          if (nestedFailure !== null) throw new Error(nestedFailure);
          return result;
        }
        const { response } = await agent.runWithTurn(input.attemptChatId, input.instruction, {
          turnId,
          coordinationWorkDestination: input.destination,
          coordinationOrigin: origin,
          coordinationDelivery: {
            conversationId: input.destination.conversationId,
            targetPrincipalId: input.destination.targetPrincipalId,
            targetDisplayName: actor?.displayName ?? input.authority.residentBinding,
            targetKind: actor?.kind ?? 'resident_bot',
          },
          onDurableEvent,
        });
        const result = await response;
        await evidenceChain;
        if (evidenceFailure !== undefined) {
          throw evidenceFailure instanceof Error
            ? evidenceFailure
            : new Error('Working Thread communication evidence could not be persisted');
        }
        if (nestedFailure !== null) throw new Error(nestedFailure);
        return { text: result.text, artifacts: result.media };
      } finally {
        if (cancelPoll) clearInterval(cancelPoll);
      }
    },
  };
}

export function createLane3ResultCommit(input: {
  messages: Pick<ReturnType<typeof createMessageService>, 'sendMessage'>;
  actorContext: (ids: { requestId: string; correlationId: string; workId: string }) => MessagingActorContext;
  now?: () => Date;
}): CanonicalResultCommit {
  return {
    async commit(commit) {
      const requestId = generateCoordinationId('request');
      const correlationId = generateCoordinationId('correlation');
      const context = input.actorContext({ requestId, correlationId, workId: commit.workId });
      const posted = await input.messages.sendMessage({
        context,
        channelId: commit.channelId,
        messageId: resultMessageId(commit.workId),
        authorPrincipalId: context.principalId,
        idempotencyKey: workResultIdempotencyKey(commit.workId),
        kind: 'result',
        text: commit.text,
        mentions: [],
        clientMessageId: null,
        attachmentIds: [...commit.artifactIds],
        replyToMessageId: commit.originMessageId,
        tombstonesMessageId: null,
        provenance: { roundId: null, workId: commit.workId },
      });
      return {
        messageId: posted.message.id,
        replayed: posted.outcome === 'replayed',
      };
    },
  };
}

export function dispatchForegroundDetach(input: {
  request: ForegroundDetachRequest;
  context?: ForegroundDetachFactSource;
  ports: ForegroundDetachPorts | null;
  pathDeps: ForegroundDetachPathDeps | null;
  path?: ReturnType<typeof createDetachedAttemptPath>;
}): ForegroundDetachResult {
  const collected = collectForegroundDetachFacts(input.request, input.context);
  const missing = [...collected.missing];
  if (
    missing.includes('principalId') && input.ports &&
    collected.facts.speakingWorkId
  ) {
    const speakingWork = input.ports.work.get(collected.facts.speakingWorkId);
    if (speakingWork) {
      collected.facts.principalId = speakingWork.principalId;
      missing.splice(missing.indexOf('principalId'), 1);
    }
  }
  if (!input.ports || !input.pathDeps) missing.unshift('ports');
  if (missing.length > 0) {
    return { created: false, missing: [...new Set(missing)] };
  }

  const ports = input.ports!;
  const pathDeps = input.pathDeps!;
  const facts = collected.facts;
  if (ports.readOriginAttachmentIds(facts.originMessageId!).length > 0) {
    return { created: false, missing: ['attachments'] };
  }
  const anchors = ports.readChannelState(facts.channelId!, facts.originMessageId!);
  if (!anchors) {
    if (!missing.includes('channelId')) missing.push('channelId');
    return { created: false, missing };
  }

  const messageIds = [facts.originMessageId!];
  const originInstruction = facts.instruction!;
  const instruction = facts.executionInstruction!;
  const assignment = safeAssignmentLabel(facts.assignmentLabel ?? originInstruction);
  const included = [...messageIds].sort().join('\0');
  const path = input.path ?? createDetachedAttemptPath({
    registry: pathDeps.registry,
    work: ports.work,
    leases: ports.leases,
    runner: pathDeps.runner,
    results: ports.results,
    lock: pathDeps.lock,
    now: ports.now,
  });
  const handle = path.dispatch({
    office: 'resident',
    workKind: 'resident_work_thread',
    label: assignment,
    conversationChatId: facts.chatId,
    instruction,
    principalId: facts.principalId!,
    targetPrincipalId: facts.targetPrincipalId!,
    residentBinding: facts.residentBinding!,
    residentInstanceId: facts.residentInstanceId!,
    authorityReference: facts.authorityReference!,
    channelId: facts.channelId!,
    conversationId: facts.conversationId!,
    originMessageId: facts.originMessageId!,
    manifest: {
      privacy: 'channel_only',
      channelId: facts.channelId!,
      messageIds,
      artifactIds: [],
      counts: { messages: 1, artifacts: 0 },
      watermarks: {
        channelSequence: anchors.channelSequence,
        eventSequence: anchors.eventSequence,
      },
      digests: {
        context: sha256(`${included}\0${originInstruction}\0${instruction}`),
        source: sha256(included),
      },
    },
    idempotencyKey: `foreground-detach:${sha256(
      `${facts.chatId}\0${facts.turnId ?? 'turn'}\0${facts.invocationId ?? facts.tool}`,
    )}`,
    requestId: generateCoordinationId('request'),
    correlationId: generateCoordinationId('correlation'),
    presentation: {
      title: assignment.slice(0, 88),
      summary: assignment.slice(0, 280),
    },
    ...(input.request.execute ? { execute: input.request.execute } : {}),
  });
  return { created: true, handle };
}

export function createCanonicalOrphanRecovery(input: {
  database: Pick<CoordinationDatabase, 'readOne'>;
  work: ReturnType<typeof createWorkService>;
  leases: ReturnType<typeof createLeaseService>;
  now?: () => Date;
}): (workId: string) => 'failed' | 'cancelled' | null {
  const now = input.now ?? (() => new Date());
  return (workId) => {
    let parent = input.work.get(workId);
    if (!parent || parent.kind !== 'resident_work_thread' ||
        !['queued', 'leased', 'running', 'cancelling'].includes(parent.state)) return null;
    if (parent.state === 'queued' && parent.currentAttemptId === null) {
      const resident = input.database.readOne<{ residentBinding: string; instanceId: string | null }>(
        `SELECT resident_binding AS residentBinding, active_instance_id AS instanceId
           FROM bots WHERE principal_id = ? AND lifecycle = 'active'`,
        parent.targetPrincipalId,
      );
      if (!resident?.instanceId) return null;
      const identity = {
        requestId: generateCoordinationId('request'),
        correlationId: generateCoordinationId('correlation'),
      };
      const offer = input.leases.offer({
        workId,
        holderPrincipalId: parent.targetPrincipalId,
        holderInstanceId: resident.instanceId,
        authorityReference: `resident:${resident.residentBinding}`,
        automatic: true,
        ...identity,
      });
      const binding = {
        workId,
        attemptId: offer.attempt.id,
        leaseId: offer.lease.id,
        holderPrincipalId: parent.targetPrincipalId,
        holderInstanceId: resident.instanceId,
        fencingToken: offer.fencingToken,
        ...identity,
      };
      input.leases.accept(binding);
      input.leases.start(binding);
      parent = input.work.get(workId)!;
    } else if (parent.state === 'leased') {
      const current = input.leases.current(workId);
      const binding = {
        workId,
        attemptId: current.attempt.id,
        leaseId: current.lease.id,
        holderPrincipalId: current.attempt.holderPrincipalId,
        holderInstanceId: current.attempt.holderInstanceId,
        fencingToken: current.attempt.fencingToken,
        requestId: generateCoordinationId('request'),
        correlationId: generateCoordinationId('correlation'),
      };
      if (current.attempt.state === 'offered') input.leases.accept(binding);
      else if (current.attempt.state !== 'accepted') return null;
      input.leases.start(binding);
      parent = input.work.get(workId)!;
    }
    const current = input.leases.current(workId);
    const cancelled = parent.state === 'cancelling' || current.attempt.state === 'cancel_requested';
    const status = cancelled ? 'cancelled' as const : 'failed' as const;
    input.leases.terminalize({
      workId,
      attemptId: current.attempt.id,
      leaseId: current.lease.id,
      holderPrincipalId: current.attempt.holderPrincipalId,
      holderInstanceId: current.attempt.holderInstanceId,
      fencingToken: current.attempt.fencingToken,
      requestId: generateCoordinationId('request'),
      correlationId: generateCoordinationId('correlation'),
      receipt: {
        status,
        sourceReference: current.attempt.authorityReference,
        resultDigest: null,
        artifactIds: [],
        timestamp: now().toISOString(),
      },
    });
    return status;
  };
}

export function tryOpenForegroundDetachPorts(
  env: NodeJS.ProcessEnv = process.env,
): (ForegroundDetachPorts & { close: () => void }) | null {
  const databasePath = env.HOME23_COORDINATION_DB_PATH;
  if (!databasePath) return null;
  let database: CoordinationDatabase | undefined;
  try {
    database = openCoordinationDatabase({ path: databasePath });
    const work = createWorkService({ database, generateId: generateCoordinationId });
    const leases = createLeaseService({
      database,
      generateId: generateCoordinationId,
      leaseTtlMs: 60_000,
    });
    const botRepository = new SqliteBotDirectoryRepository(database);
    const botDirectory = createBotDirectory({
      repository: botRepository,
      availabilityPolicy: { degradedAfterMs: 30_000, offlineAfterMs: 120_000 },
    });
    const participantDirectory = {
      listVisibleBots: botDirectory.listVisibleBots,
      resolveAlias: botDirectory.resolveAlias,
      getBotByResidentBinding: (binding: string) => botRepository.getBotByResidentBinding(binding),
    };
    const messages = createMessageService({
      repository: new SqliteMessagingRepository(database, {
        botConversationBinding: new SqliteBotConversationBindingAdapter(),
        messageProvenanceAuthorization: new M11MessageProvenanceAuthority(),
      }),
      participantDirectory,
    });
    const opened = database;
    const communicationRepository = new SqliteCommunicationEventRepository(opened);
    const recoverOrphan = createCanonicalOrphanRecovery({ database: opened, work, leases });
    const results = createLane3ResultCommit({
      messages,
      actorContext: ({ requestId, correlationId, workId }) => {
        const resident = opened.readOne<{
          id: string;
          residentBinding: string;
          instanceId: string | null;
          keyVersion: number | null;
        }>(
          `SELECT bot.id, bot.resident_binding AS residentBinding,
                  bot.active_instance_id AS instanceId, bot.active_key_version AS keyVersion
             FROM works work JOIN bots bot ON bot.principal_id = work.target_principal_id
            WHERE work.id = ? AND bot.lifecycle = 'active'`,
          workId,
        );
        if (!resident?.residentBinding || !resident.instanceId || resident.keyVersion == null) {
          throw new Error('Working Thread accountable resident is unavailable');
        }
        return {
          principalId: resident.id,
          requestId,
          correlationId,
          identity: {
            kind: 'resident',
            resident: {
              requestId,
              correlationId,
              credential: {
                residentSlug: resident.residentBinding,
                role: 'resident',
                instanceId: resident.instanceId,
                keyVersion: resident.keyVersion,
              },
            },
          },
        };
      },
    });
    return {
      work: Object.freeze({ ...work, recoverOrphan }),
      leases,
      results,
      readChannelState: (channelId, originMessageId) =>
        readChannelManifestAnchors(opened, channelId, originMessageId),
      readOriginAttachmentIds: (messageId) => opened.readAll<{ artifactId: string }>(
        'SELECT artifact_id AS artifactId FROM message_artifacts WHERE message_id = ? ORDER BY ordinal',
        messageId,
      ).map((row) => row.artifactId),
      evidence: {
        append: (input) => communicationRepository.append(input),
        actorFor: (principalId) => {
          const resident = opened.readOne<{ principalId: string; displayName: string }>(
            `SELECT principal_id AS principalId, name AS displayName
               FROM bots WHERE principal_id = ? AND lifecycle = 'active'`,
            principalId,
          );
          return resident ? { ...resident, kind: 'resident_bot' } : null;
        },
        isCancellationRequested: (workId) => Boolean(opened.readOne<{ id: string }>(
          `SELECT work.id FROM works work
             LEFT JOIN attempts attempt ON attempt.id = work.current_attempt_id
            WHERE work.id = ? AND (work.state = 'cancelling' OR attempt.state = 'cancel_requested')`,
          workId,
        )),
      },
      isAccountableResident: (workId, residentBinding) => Boolean(opened.readOne<{ id: string }>(
        `SELECT work.id FROM works work JOIN bots bot ON bot.principal_id = work.target_principal_id
          WHERE work.id = ? AND bot.resident_binding = ?`,
        workId,
        residentBinding,
      )),
      listRecoverableWorkIds: (residentBinding, limit) => opened.readAll<{ id: string }>(
        `SELECT work.id FROM works work
           JOIN bots bot ON bot.principal_id = work.target_principal_id
          WHERE work.kind = 'resident_work_thread'
            AND work.state IN ('queued', 'leased', 'running', 'cancelling')
            AND bot.resident_binding = ?
          ORDER BY work.created_at, work.id LIMIT ?`,
        residentBinding,
        limit,
      ).map((row) => row.id),
      close: () => opened.close(),
    };
  } catch {
    try {
      database?.close();
    } catch {
      // fail-closed: ports stay null
    }
    return null;
  }
}
