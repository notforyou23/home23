import type { AgentResponse, CoordinationTurnOrigin } from "../../agent/types.js";
import {
  ChannelCoordinatorError,
  type CoordinatorTurnDisposition,
} from "../channel-coordinator/index.js";
import type { createChannelCoordinator } from "../channel-coordinator/index.js";
import { MessagingError, type MessagingActorContext } from "../channels/index.js";
import type { MessageProjection, MessageTurnSelection } from "../messages/index.js";
import type { AuthorityEpoch } from "../epochs/index.js";
import { isCanonicalMessagesAuthority } from "../epochs/index.js";
import type { ContextManifestInput, WorkRecord } from "../work/index.js";
import type {
  CoordinationChannelCoordinatorPort,
  CoordinationLeasePort,
  CoordinationMessageSubmissionRequest,
  CoordinationWorkPort,
} from "./types.js";
import type {
  DirectMessageMessagePort,
  DirectMessageResidentTarget,
} from "./direct-message.js";

function responseMessageId(workId: string): string {
  if (!workId.startsWith("wrk_")) throw new Error("Work ID cannot derive a Message ID");
  return `msg_${workId.slice(4)}`;
}

function once(callback: () => void): () => void {
  let called = false;
  return () => {
    if (called) return;
    called = true;
    callback();
  };
}

export interface GroupChannelResidentTarget {
  targetBotId: string;
  targetBotDisplayName: string;
  targetPrincipalId: string;
  residentBinding: string;
}

export interface GroupChannelPreparedContext {
  channelId: string;
  conversationId: string;
  originMessageId: string;
  originEventId: string;
  actorPrincipalId: string;
  visibleParticipantIds: readonly string[];
  selectedTargets: readonly GroupChannelResidentTarget[];
  responseOrder: "parallel" | "sequential";
  standingReference: string;
  instruction: string;
  manifest: ContextManifestInput;
}

export interface GroupChannelMessageContextPort {
  loadOrigin(input: {
    context: MessagingActorContext;
    channelId: string;
    messageId: string;
  }): Promise<{
    message: MessageProjection;
    attachmentIds: readonly string[];
    eventSequence: number;
  }>;
  prepare(input: {
    context: MessagingActorContext;
    channelId: string;
    originMessage: MessageProjection;
    attachmentIds: readonly string[];
    eventSequence: number;
  }): Promise<GroupChannelPreparedContext>;
  recover(work: WorkRecord): Promise<GroupChannelPreparedContext>;
  listRecoveryRoundIds(limit: number): readonly string[];
  listRoundWorks(roundId: string): readonly WorkRecord[];
  responseOrder(roundId: string): "parallel" | "sequential";
  hasResult(workId: string): boolean;
}

type ChannelCoordinator = Pick<
  ReturnType<typeof createChannelCoordinator>,
  "start" | "reconcile"
>;

type WorkExecution = Readonly<{
  workId: string;
  disposition: CoordinatorTurnDisposition;
  message: MessageProjection | null;
}>;

/**
 * Complete M08 -> M16 -> M11 -> resident -> M08 group-Channel path. The
 * caller owns feature activation; this service still verifies canonical
 * message authority for every admission and recovery operation.
 */
export function createGroupChannelMessageService(options: {
  messages: DirectMessageMessagePort;
  context: GroupChannelMessageContextPort;
  coordinator: ChannelCoordinator;
  work: CoordinationWorkPort;
  leases: CoordinationLeasePort;
  resolveResident(residentBinding: string): DirectMessageResidentTarget | undefined;
  authority: { current(): AuthorityEpoch | null };
  recordMessage(input: {
    message: MessageProjection;
    kind: "user_message_committed" | "assistant_message_committed";
    requestId: string;
    correlationId: string;
    turnSelection?: MessageTurnSelection;
  }): Promise<void>;
  beginWork(): () => void;
  recoveryIdentity(): { requestId: string; correlationId: string };
  now?: () => Date;
  roundDeadlineMs?: number;
}) {
  const now = options.now ?? (() => new Date());
  const roundDeadlineMs = options.roundDeadlineMs ?? 30 * 60_000;
  if (!Number.isSafeInteger(roundDeadlineMs) || roundDeadlineMs < 1_000) {
    throw new TypeError("Channel Round deadline must be at least one second");
  }
  const workInFlight = new Map<string, Promise<WorkExecution>>();
  const roundInFlight = new Map<string, Promise<Readonly<Record<string, unknown>>>>();

  const assertAuthority = (): AuthorityEpoch => {
    const authority = options.authority.current();
    if (!isCanonicalMessagesAuthority(authority)) {
      throw new MessagingError("authority_unavailable");
    }
    return authority!;
  };
  const residentFor = (residentBinding: string): DirectMessageResidentTarget => {
    const target = options.resolveResident(residentBinding);
    if (!target) {
      throw new ChannelCoordinatorError(
        "ineligible",
        "Channel recipient resident is not enabled",
      );
    }
    return target;
  };

  async function assertSelection(
    targets: readonly GroupChannelResidentTarget[],
    selection: MessageTurnSelection,
    identity: { requestId: string; correlationId: string },
  ): Promise<void> {
    if (selection.modelAlias === null && selection.reasoningEffort === null) return;
    const catalogs = await Promise.all(targets.map((prepared) =>
      residentFor(prepared.residentBinding).models.modelCatalog(identity)
    ));
    if (catalogs.some((catalog) =>
      (selection.modelAlias !== null &&
        !catalog.models.some((model) => model.alias === selection.modelAlias)) ||
      (selection.reasoningEffort !== null &&
        !catalog.reasoningEfforts.includes(selection.reasoningEffort!))
    )) {
      throw new MessagingError("request_invalid");
    }
  }

  function originFor(input: {
    work: WorkRecord;
    prepared: GroupChannelPreparedContext;
    target: DirectMessageResidentTarget;
    targetContext: GroupChannelResidentTarget;
    offer: ReturnType<CoordinationLeasePort["offer"]>;
  }): CoordinationTurnOrigin {
    if (input.work.roundId === null) throw new Error("Channel Work has no Round");
    return Object.freeze({
      kind: "coordination",
      workId: input.work.id,
      attemptId: input.offer.attempt.id,
      leaseId: input.offer.lease.id,
      holderPrincipalId: input.targetContext.targetPrincipalId,
      holderInstanceId: input.target.holderInstanceId,
      authorityReference: input.offer.attempt.authorityReference,
      fencingToken: input.offer.fencingToken,
      channelId: input.prepared.channelId,
      originMessageId: input.prepared.originMessageId,
      roundId: input.work.roundId,
    });
  }

  function recoveredOrigin(input: {
    work: WorkRecord;
    prepared: GroupChannelPreparedContext;
    target: DirectMessageResidentTarget;
    targetContext: GroupChannelResidentTarget;
  }): {
    origin: CoordinationTurnOrigin;
    phase: "offered" | "accepted" | "running" | "completed";
  } {
    if (input.work.roundId === null) throw new Error("Channel Work has no Round");
    const current = options.leases.current(input.work.id);
    const exactBinding =
      current.work.kind === "channel.bot_turn" &&
      current.work.channelId === input.prepared.channelId &&
      current.work.originMessageId === input.prepared.originMessageId &&
      current.work.roundId === input.work.roundId &&
      current.work.targetPrincipalId === input.targetContext.targetPrincipalId &&
      current.attempt.holderPrincipalId === input.targetContext.targetPrincipalId &&
      current.attempt.holderInstanceId === input.target.holderInstanceId &&
      current.lease.holderPrincipalId === current.attempt.holderPrincipalId &&
      current.lease.holderInstanceId === current.attempt.holderInstanceId &&
      current.lease.fencingToken === current.attempt.fencingToken &&
      current.attempt.authorityReference ===
        `resident:${input.targetContext.residentBinding}`;
    if (!exactBinding) throw new Error("Channel Work recovery binding is not exact");
    let phase: "offered" | "accepted" | "running" | "completed";
    if (
      current.work.state === "leased" && current.attempt.state === "offered" &&
      current.lease.state === "offered"
    ) phase = "offered";
    else if (
      current.work.state === "leased" && current.attempt.state === "accepted" &&
      current.lease.state === "active"
    ) phase = "accepted";
    else if (
      current.work.state === "running" && current.attempt.state === "running" &&
      current.lease.state === "active"
    ) phase = "running";
    else if (
      current.work.state === "succeeded" && current.attempt.state === "succeeded" &&
      current.lease.state === "released"
    ) phase = "completed";
    else throw new Error("Channel Work recovery lifecycle is ambiguous");
    return Object.freeze({
      phase,
      origin: Object.freeze({
        kind: "coordination",
        workId: current.work.id,
        attemptId: current.attempt.id,
        leaseId: current.lease.id,
        holderPrincipalId: current.attempt.holderPrincipalId,
        holderInstanceId: current.attempt.holderInstanceId,
        authorityReference: current.attempt.authorityReference,
        fencingToken: current.attempt.fencingToken,
        channelId: current.work.channelId,
        originMessageId: current.work.originMessageId,
        roundId: current.work.roundId,
      }),
    });
  }

  function dispatchWork(input: {
    work: WorkRecord;
    prepared: GroupChannelPreparedContext;
    requestId: string;
    correlationId: string;
    recovery: boolean;
  }): Promise<WorkExecution> {
    const existing = workInFlight.get(input.work.id);
    if (existing) return existing;
    const execution = (async (): Promise<WorkExecution> => {
      if (options.context.hasResult(input.work.id)) {
        return Object.freeze({
          workId: input.work.id,
          disposition: "completed",
          message: null,
        });
      }
      const currentWork = options.work.get(input.work.id);
      if (!currentWork) throw new Error("Channel Work disappeared before dispatch");
      if (currentWork.state === "failed" || currentWork.state === "cancelled") {
        return Object.freeze({
          workId: currentWork.id,
          disposition: "permanent_failure",
          message: null,
        });
      }
      const targetContext = input.prepared.selectedTargets.find(
        (candidate) => candidate.targetPrincipalId === currentWork.targetPrincipalId,
      );
      if (!targetContext) throw new Error("Channel Work target is outside recovered context");
      const target = residentFor(targetContext.residentBinding);
      let origin: CoordinationTurnOrigin;
      let recoveryPhase: "offered" | "accepted" | "running" | "completed" | null = null;
      if (input.recovery) {
        if (currentWork.state === "queued" && currentWork.currentAttemptId === null) {
          const offer = options.leases.offer({
            workId: currentWork.id,
            holderPrincipalId: targetContext.targetPrincipalId,
            holderInstanceId: target.holderInstanceId,
            authorityReference: `resident:${targetContext.residentBinding}`,
            automatic: true,
            requestId: input.requestId,
            correlationId: input.correlationId,
          });
          origin = originFor({ work: currentWork, prepared: input.prepared, target, targetContext, offer });
        } else {
          const recovered = recoveredOrigin({
            work: currentWork,
            prepared: input.prepared,
            target,
            targetContext,
          });
          origin = recovered.origin;
          recoveryPhase = recovered.phase;
        }
      } else {
        const offer = options.leases.offer({
          workId: currentWork.id,
          holderPrincipalId: targetContext.targetPrincipalId,
          holderInstanceId: target.holderInstanceId,
          authorityReference: `resident:${targetContext.residentBinding}`,
          automatic: true,
          requestId: input.requestId,
          correlationId: input.correlationId,
        });
        origin = originFor({ work: currentWork, prepared: input.prepared, target, targetContext, offer });
      }
      const residentRequest = {
        chatId: `coordination:${input.prepared.channelId}:${currentWork.id}`,
        instruction: input.prepared.instruction,
        origin,
        requestId: input.requestId,
        correlationId: input.correlationId,
        turnSelection: options.work.getTurnSelection(currentWork.id),
        communication: {
          conversationId: input.prepared.conversationId,
          responseMessageId: responseMessageId(currentWork.id),
          actor: {
            principalId: targetContext.targetPrincipalId,
            displayName: targetContext.targetBotDisplayName,
            kind: "resident_bot",
          },
        },
      };
      let agentResponse: AgentResponse;
      if (recoveryPhase === "completed") {
        const run = await target.resident.recoverCompleted(residentRequest);
        agentResponse = await run.response;
      } else {
        const run = recoveryPhase === "running"
          ? await target.resident.reattach(residentRequest)
          : recoveryPhase === "accepted"
            ? await target.resident.continueAccepted(residentRequest)
            : await target.resident.execute(residentRequest);
        const [response, receipt] = await Promise.allSettled([run.response, run.receipt]);
        if (receipt.status === "rejected") throw receipt.reason;
        if (response.status === "rejected") throw response.reason;
        agentResponse = response.value;
      }
      if (!agentResponse.text.trim()) {
        return Object.freeze({
          workId: currentWork.id,
          disposition: "passed",
          message: null,
        });
      }
      const result = await options.messages.sendMessage({
        context: target.context({
          principalId: targetContext.targetPrincipalId,
          requestId: input.requestId,
          correlationId: input.correlationId,
        }),
        channelId: input.prepared.channelId,
        messageId: responseMessageId(currentWork.id),
        authorPrincipalId: targetContext.targetPrincipalId,
        idempotencyKey: `work-result:${currentWork.id}`,
        kind: "result",
        text: agentResponse.text,
        mentions: [],
        clientMessageId: null,
        replyToMessageId: input.prepared.originMessageId,
        tombstonesMessageId: null,
        provenance: { roundId: currentWork.roundId, workId: currentWork.id },
      });
      await options.recordMessage({
        message: result.message,
        kind: "assistant_message_committed",
        requestId: input.requestId,
        correlationId: input.correlationId,
      });
      return Object.freeze({
        workId: currentWork.id,
        disposition: "completed",
        message: result.message,
      });
    })().catch((error: unknown) => {
      const current = options.work.get(input.work.id);
      if (current?.state === "failed" || current?.state === "cancelled") {
        return Object.freeze({
          workId: input.work.id,
          disposition: "permanent_failure" as const,
          message: null,
        });
      }
      throw error;
    });
    workInFlight.set(input.work.id, execution);
    void execution.finally(() => workInFlight.delete(input.work.id)).catch(() => undefined);
    return execution;
  }

  async function executeWorks(input: {
    roundId: string;
    works: readonly WorkRecord[];
    preparedByWork: ReadonlyMap<string, GroupChannelPreparedContext>;
    responseOrder: "parallel" | "sequential";
    requestId: string;
    correlationId: string;
    recovery: boolean;
  }): Promise<readonly WorkExecution[]> {
    const execute = (work: WorkRecord) => {
      if (options.context.hasResult(work.id)) {
        return Promise.resolve(Object.freeze({
          workId: work.id,
          disposition: "completed" as const,
          message: null,
        }));
      }
      if (work.state === "failed" || work.state === "cancelled") {
        return Promise.resolve(Object.freeze({
          workId: work.id,
          disposition: "permanent_failure" as const,
          message: null,
        }));
      }
      const prepared = input.preparedByWork.get(work.id);
      if (!prepared) throw new Error("Channel Work has no prepared context");
      return dispatchWork({
        work,
        prepared,
        requestId: input.requestId,
        correlationId: input.correlationId,
        recovery: input.recovery || work.state !== "queued",
      });
    };
    if (input.responseOrder === "sequential") {
      const results: WorkExecution[] = [];
      for (const work of input.works) results.push(await execute(work));
      return Object.freeze(results);
    }
    const settled = await Promise.allSettled(input.works.map(execute));
    const rejected = settled.find(
      (entry): entry is PromiseRejectedResult => entry.status === "rejected",
    );
    if (rejected) throw rejected.reason;
    return Object.freeze(settled.map((entry) =>
      (entry as PromiseFulfilledResult<WorkExecution>).value
    ));
  }

  function scheduleRound(input: {
    roundId: string;
    works: readonly WorkRecord[];
    preparedByWork: ReadonlyMap<string, GroupChannelPreparedContext>;
    responseOrder: "parallel" | "sequential";
    requestId: string;
    correlationId: string;
    recovery: boolean;
    endWork: () => void;
  }): Promise<Readonly<Record<string, unknown>>> {
    const existing = roundInFlight.get(input.roundId);
    if (existing) {
      input.endWork();
      return existing;
    }
    const execution = (async () => {
      const results = await executeWorks(input);
      const dispositions = Object.fromEntries(
        results.map((result) => [result.workId, result.disposition]),
      );
      const reconciled = options.coordinator.reconcile({
        roundId: input.roundId,
        dispositions,
        requestId: input.requestId,
        correlationId: input.correlationId,
      });
      return Object.freeze({
        round: reconciled.round,
        works: reconciled.works,
        outcome: reconciled.outcome,
        reasonCode: reconciled.reasonCode,
        messages: Object.freeze(
          results.flatMap((result) => result.message === null ? [] : [result.message]),
        ),
      });
    })().finally(input.endWork);
    roundInFlight.set(input.roundId, execution);
    void execution.finally(() => roundInFlight.delete(input.roundId)).catch(() => undefined);
    return execution;
  }

  async function startPrepared(input: {
    context: MessagingActorContext;
    prepared: GroupChannelPreparedContext;
    turnSelection: MessageTurnSelection;
  }): Promise<Readonly<Record<string, unknown> & { response?: Promise<unknown> }>> {
    const authority = assertAuthority();
    if (input.prepared.selectedTargets.length === 0) {
      return Object.freeze({
        requestId: input.context.requestId,
        correlationId: input.context.correlationId,
        channelId: input.prepared.channelId,
        conversationId: input.prepared.conversationId,
        round: null,
        works: Object.freeze([]),
        replayed: false,
      });
    }
    for (const target of input.prepared.selectedTargets) residentFor(target.residentBinding);
    await assertSelection(input.prepared.selectedTargets, input.turnSelection, input.context);
    const dispatch = options.coordinator.start({
      eventId: input.prepared.originEventId,
      messageId: input.prepared.originMessageId,
      channelId: input.prepared.channelId,
      actorPrincipalId: input.prepared.actorPrincipalId,
      selection: "mentions",
      mentionedBotIds: input.prepared.selectedTargets.map((target) => target.targetBotId),
      visibleParticipantIds: input.prepared.visibleParticipantIds,
      standing: {
        source: "trusted_policy_boundary",
        reference: input.prepared.standingReference,
        channelId: input.prepared.channelId,
        allowedParticipantIds: input.prepared.visibleParticipantIds,
        broadcastAllowed: false,
      },
      authority: {
        capability: "messages",
        mode: "canonical",
        epoch: authority.epoch,
        writer: authority.writer,
      },
      deadlineAt: new Date(now().valueOf() + roundDeadlineMs).toISOString(),
      manifest: input.prepared.manifest,
      turnSelection: input.turnSelection,
      requestId: input.context.requestId,
      correlationId: input.context.correlationId,
    });
    const preparedByWork = new Map(
      dispatch.works.map(({ work }) => [work.id, input.prepared]),
    );
    const endWork = once(options.beginWork());
    const response = scheduleRound({
      roundId: dispatch.round.id,
      works: dispatch.works.map(({ work }) => work),
      preparedByWork,
      responseOrder: input.prepared.responseOrder,
      requestId: input.context.requestId,
      correlationId: input.context.correlationId,
      recovery: dispatch.replayed,
      endWork,
    });
    void response.catch(() => undefined);
    return Object.freeze({
      requestId: input.context.requestId,
      correlationId: input.context.correlationId,
      channelId: input.prepared.channelId,
      conversationId: input.prepared.conversationId,
      round: dispatch.round,
      works: Object.freeze(dispatch.works.map(({ work }) => work)),
      replayed: dispatch.replayed,
      response,
    });
  }

  const channelCoordinator: CoordinationChannelCoordinatorPort = Object.freeze({
    async startFromMessage(
      input: Parameters<CoordinationChannelCoordinatorPort["startFromMessage"]>[0],
    ) {
      assertAuthority();
      if (input.context.identity.kind !== "owner") {
        throw new MessagingError("identity_context_mismatch");
      }
      const origin = await options.context.loadOrigin(input);
      const prepared = await options.context.prepare({
        context: input.context,
        channelId: input.channelId,
        originMessage: origin.message,
        attachmentIds: origin.attachmentIds,
        eventSequence: origin.eventSequence,
      });
      const started = await startPrepared({
        context: input.context,
        prepared,
        turnSelection: Object.freeze({ modelAlias: null, reasoningEffort: null }),
      });
      const { response: _response, ...accepted } = started;
      return Object.freeze(accepted);
    },
  });

  return Object.freeze({
    channelCoordinator,

    async submitMessage(input: {
      context: MessagingActorContext;
      channelId: string;
      idempotencyKey: string;
      body: CoordinationMessageSubmissionRequest;
    }) {
      assertAuthority();
      if (input.context.identity.kind !== "owner" || input.body.text === null) {
        throw new MessagingError("request_invalid");
      }
      const turnSelection = Object.freeze({
        modelAlias: input.body.modelAlias,
        reasoningEffort: input.body.reasoningEffort,
      });
      const appended = await options.messages.sendMessage({
        context: input.context,
        channelId: input.channelId,
        messageId: input.body.messageId,
        authorPrincipalId: input.context.principalId,
        idempotencyKey: input.idempotencyKey,
        kind: "text",
        text: input.body.text,
        mentions: input.body.mentions,
        attachmentIds: input.body.attachmentIds,
        clientMessageId: input.body.clientMessageId,
        replyToMessageId: input.body.replyToMessageId,
        tombstonesMessageId: null,
        provenance: { roundId: null, workId: null },
        turnSelection,
      });
      await options.recordMessage({
        message: appended.message,
        kind: "user_message_committed",
        requestId: input.context.requestId,
        correlationId: input.context.correlationId,
        turnSelection,
      });
      const prepared = await options.context.prepare({
        context: input.context,
        channelId: input.channelId,
        originMessage: appended.message,
        attachmentIds: input.body.attachmentIds,
        eventSequence: appended.receipt.eventSequence,
      });
      const started = await startPrepared({
        context: input.context,
        prepared,
        turnSelection,
      });
      return Object.freeze({
        ...started,
        message: appended.message,
        replayed: appended.outcome === "replayed" || started.replayed === true,
        throughEventSequence: appended.receipt.eventSequence,
      });
    },

    async recoverResidentWork() {
      assertAuthority();
      const roundIds = options.context.listRecoveryRoundIds(100);
      let scheduled = 0;
      let refused = 0;
      for (const roundId of roundIds) {
        try {
          const works = options.context.listRoundWorks(roundId);
          const preparedByWork = new Map<string, GroupChannelPreparedContext>();
          for (const work of works) {
            if (
              !options.context.hasResult(work.id) &&
              !["failed", "cancelled"].includes(work.state)
            ) {
              preparedByWork.set(work.id, await options.context.recover(work));
            }
          }
          const identity = options.recoveryIdentity();
          const endWork = once(options.beginWork());
          const response = scheduleRound({
            roundId,
            works,
            preparedByWork,
            responseOrder: options.context.responseOrder(roundId),
            requestId: identity.requestId,
            correlationId: identity.correlationId,
            recovery: true,
            endWork,
          });
          void response.catch(() => undefined);
          scheduled += 1;
        } catch {
          refused += 1;
        }
      }
      return Object.freeze({ discovered: roundIds.length, scheduled, refused });
    },
  });
}
