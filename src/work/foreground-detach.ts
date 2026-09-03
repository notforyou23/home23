/**
 * Fail-closed join from a speaking-turn require_work refusal to a detached
 * Attempt. Dispatch only when every required fact and port already exists.
 * Never mint chn_ / cnv_ / msg_ / bot_ / user_ IDs.
 */
import { createHash } from 'node:crypto';

import type { ForegroundDetachRequest } from '../agent/foreground-tool-policy.js';
import type { AgentResponse, CoordinationTurnOrigin, ToolContext } from '../agent/types.js';
import {
  SqliteBotConversationBindingAdapter,
  SqliteMessagingRepository,
  type MessagingActorContext,
} from '../coordination/channels/index.js';
import { workResultIdempotencyKey } from '../coordination/contracts/resident-presence.js';
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
}

export interface ForegroundDetachPorts {
  work: DetachedAttemptWorkPort;
  leases: DetachedAttemptLeasePort;
  results: CanonicalResultCommit;
  readChannelState: (channelId: string) => { channelSequence: number; eventSequence: number } | null;
  now?: () => Date;
}

export interface ForegroundDetachPathDeps {
  registry: WorkRegistry;
  lock: ConversationRunLock;
  runner: DetachedAttemptRunner;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function present(value: string | undefined | null): value is string {
  return typeof value === 'string' && value.trim().length > 0;
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
    instruction?: string;
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
  if (!present(instruction)) missing.push('instruction');

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
      instruction,
    },
    missing,
  };
}

export function readChannelManifestAnchors(
  database: { readOne<T>(sql: string, ...parameters: Array<string | number | bigint | Buffer | null>): T | undefined },
  channelId: string,
): { channelSequence: number; eventSequence: number } | null {
  const channel = database.readOne<{ seq: number }>(
    'SELECT COALESCE(MAX(channel_sequence), 0) AS seq FROM messages WHERE channel_id = ?',
    channelId,
  );
  if (!channel || !Number.isSafeInteger(channel.seq) || channel.seq < 1) return null;
  const events = database.readOne<{ seq: number }>(
    'SELECT COALESCE(MAX(sequence), 0) AS seq FROM events',
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
        coordinationOrigin?: CoordinationTurnOrigin;
      },
    ): Promise<{ turnId: string; response: Promise<AgentResponse> }>;
  },
): DetachedAttemptRunner {
  return {
    async run(input) {
      const { response } = await agent.runWithTurn(input.attemptChatId, input.instruction, {
        coordinationOrigin: {
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
        },
      });
      const result = await response;
      return { text: result.text, artifacts: result.media };
    },
  };
}

export function createLane3ResultCommit(input: {
  messages: Pick<ReturnType<typeof createMessageService>, 'sendMessage'>;
  actorContext: (ids: { requestId: string; correlationId: string }) => MessagingActorContext;
  now?: () => Date;
}): CanonicalResultCommit {
  return {
    async commit(commit) {
      const requestId = generateCoordinationId('request');
      const correlationId = generateCoordinationId('correlation');
      const context = input.actorContext({ requestId, correlationId });
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
  if (!input.ports || !input.pathDeps) missing.unshift('ports');
  if (missing.length > 0) {
    return { created: false, missing: [...new Set(missing)] };
  }

  const ports = input.ports!;
  const pathDeps = input.pathDeps!;
  const facts = collected.facts;
  const anchors = ports.readChannelState(facts.channelId!);
  if (!anchors) {
    if (!missing.includes('channelId')) missing.push('channelId');
    return { created: false, missing };
  }

  const messageIds = [facts.originMessageId!];
  const instruction = facts.instruction!;
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
    label: input.request.tool,
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
        context: sha256(`${included}\0${instruction}`),
        source: sha256(included),
      },
    },
    idempotencyKey: `foreground-detach:${facts.chatId}:${facts.turnId ?? 'turn'}:${facts.tool}`,
    requestId: generateCoordinationId('request'),
    correlationId: generateCoordinationId('correlation'),
  });
  return { created: true, handle };
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
    const jerry = database.readOne<{
      id: string;
      instanceId: string | null;
      keyVersion: number | null;
    }>(
      `SELECT id, active_instance_id AS instanceId, active_key_version AS keyVersion
       FROM bots WHERE resident_binding = 'jerry' AND lifecycle = 'active'`,
    );
    if (!jerry?.instanceId || jerry.keyVersion == null) {
      database.close();
      return null;
    }
    const results = createLane3ResultCommit({
      messages,
      actorContext: ({ requestId, correlationId }) => ({
        principalId: jerry.id,
        requestId,
        correlationId,
        identity: {
          kind: 'resident',
          resident: {
            requestId,
            correlationId,
            credential: {
              residentSlug: 'jerry',
              role: 'resident',
              instanceId: jerry.instanceId!,
              keyVersion: jerry.keyVersion!,
            },
          },
        },
      }),
    });
    const opened = database;
    return {
      work,
      leases,
      results,
      readChannelState: (channelId) => readChannelManifestAnchors(opened, channelId),
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
