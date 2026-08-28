import { createHash } from "node:crypto";

import { canonicalTimestamp } from "../work/canonical.js";
import type { WorkRecord } from "../work/index.js";
import type { RoundRecord } from "../rounds/index.js";
import { ChannelCoordinatorError } from "./errors.js";
import {
  coordinatorAdmissionPlanJson,
  findCoordinatorAdmissionRoundIds,
  parseCoordinatorAdmissionPlan,
  readCoordinatorAdmissionPlan,
  sameCoordinatorAdmissionPlan,
} from "./admission-plan.js";
import { assertChannelTurnCapacity, selectChannelRecipients } from "./selection.js";
import {
  MAX_CHANNEL_TURNS_PER_BOT,
  MAX_CHANNEL_TURNS_PER_ROUND,
  type ChannelTurnTrigger,
  type CoordinatorAdmissionPlan,
  type CoordinatorAdmissionTarget,
  type CoordinatorDispatch,
  type CoordinatorRoundStatus,
  type CoordinatorAdmissionReplay,
  type CoordinatorTurnDisposition,
  type CreateChannelCoordinatorOptions,
  type ReconcileRoundInput,
} from "./types.js";

interface ChannelRow {
  lifecycle: string;
  responderMode: "mentions_only" | "mention_or_coordinator";
  coordinatorBotId: string | null;
  maxBotTurns: number;
}
interface EligibleBotRow { id: string }

const WORK_TERMINAL = new Set(["succeeded", "failed", "cancelled"]);
const ROUND_TERMINAL = new Set(["completed", "failed", "cancelled"]);

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function assertBoundedIds(ids: readonly string[], label: string): void {
  if (!Array.isArray(ids) || ids.length > 64 || ids.some((id) => typeof id !== "string") ||
      new Set(ids).size !== ids.length) {
    throw new ChannelCoordinatorError("invalid_request", `${label} must be a bounded unique list`);
  }
}

export function createChannelCoordinator(options: CreateChannelCoordinatorOptions) {
  const now = options.now ?? (() => new Date());

  function assertEnabled(): void {
    if (options.enabled !== true) {
      throw new ChannelCoordinatorError("capability_off", "Channel coordination capability is off");
    }
  }

  function assertAuthority(authority: ChannelTurnTrigger["authority"]): void {
    const latest = options.database.readOne<{ epoch: number; mode: string; writer: string }>(
      "SELECT epoch, mode, writer FROM authority_epochs WHERE capability = 'messages' ORDER BY epoch DESC LIMIT 1",
    );
    if (!latest || authority.capability !== "messages" || authority.mode !== "canonical" ||
        authority.epoch !== latest.epoch || latest.mode !== "canonical" ||
        authority.writer !== latest.writer || latest.writer !== options.expectedAuthorityWriter) {
      throw new ChannelCoordinatorError("stale_authority", "current canonical messages authority is required");
    }
  }

  function worksForRound(roundId: string): readonly WorkRecord[] {
    return Object.freeze(options.database.readAll<WorkRecord>(
      `SELECT id, principal_id AS principalId, target_principal_id AS targetPrincipalId,
              channel_id AS channelId, origin_message_id AS originMessageId,
              round_id AS roundId, context_manifest_id AS contextManifestId, kind,
              idempotency_key_digest AS idempotencyKeyDigest, request_digest AS requestDigest,
              state, current_attempt_id AS currentAttemptId, next_fencing_token AS nextFencingToken,
              automatic_offer_count AS automaticOfferCount, max_automatic_offers AS maxAutomaticOffers,
              terminal_reason AS terminalReason, terminal_receipt_digest AS terminalReceiptDigest,
              version, created_at AS createdAt, updated_at AS updatedAt, terminal_at AS terminalAt
       FROM works WHERE round_id = ? ORDER BY target_principal_id, created_at, id`,
      roundId,
    ).map((row) => Object.freeze(row)));
  }

  function roundIdForMessage(channelId: string, messageId: string): string | null {
    const fromWorks = options.database.readAll<{ roundId: string }>(
      `SELECT DISTINCT round_id AS roundId FROM works
       WHERE origin_message_id = ? AND channel_id = ?
         AND kind = 'channel.bot_turn' AND round_id IS NOT NULL`,
      messageId,
      channelId,
    ).map((row) => row.roundId);
    const fromPlans = findCoordinatorAdmissionRoundIds(options.database, {
      channelId,
      originMessageId: messageId,
    });
    const ids = [...new Set([...fromWorks, ...fromPlans])];
    if (ids.length > 1) {
      throw new ChannelCoordinatorError("illegal_state", "message maps to multiple Rounds");
    }
    return ids[0] ?? null;
  }

  function assertPlanTrigger(
    plan: CoordinatorAdmissionPlan,
    input: ChannelTurnTrigger,
  ): void {
    const expectedFromTrigger: CoordinatorAdmissionPlan = Object.freeze({
      ...plan,
      channelId: input.channelId,
      originMessageId: input.messageId,
      originEventId: input.eventId,
      actorPrincipalId: input.actorPrincipalId,
      visibleParticipantIds: Object.freeze([...input.visibleParticipantIds]),
      standingReference: input.standing.reference,
      turnSelection: input.turnSelection ?? Object.freeze({
        modelAlias: null,
        reasoningEffort: null,
      }),
    });
    if (
      plan.channelId !== input.channelId ||
      plan.originMessageId !== input.messageId ||
      plan.originEventId !== input.eventId ||
      plan.actorPrincipalId !== input.actorPrincipalId ||
      !sameCoordinatorAdmissionPlan(plan, input.admissionPlan) ||
      !sameCoordinatorAdmissionPlan(plan, expectedFromTrigger) ||
      plan.selectedTargets.length !== input.plannedBotIds.length ||
      plan.selectedTargets.some(
        (target, index) => target.targetBotId !== input.plannedBotIds[index],
      )
    ) {
      throw new ChannelCoordinatorError(
        "illegal_state",
        "trigger differs from the immutable Round admission plan",
      );
    }
  }

  function createPlannedWork(input: {
    round: RoundRecord;
    plan: CoordinatorAdmissionPlan;
    target: CoordinatorAdmissionTarget;
    manifest: ChannelTurnTrigger["manifest"];
    requestId: string;
    correlationId: string;
  }) {
    const created = options.work.create({
      principalId: input.plan.actorPrincipalId,
      targetPrincipalId: input.target.targetPrincipalId,
      channelId: input.plan.channelId,
      originMessageId: input.plan.originMessageId,
      roundId: input.round.id,
      kind: "channel.bot_turn",
      idempotencyKey:
        `m16:${hash(`${input.plan.originEventId}:${input.plan.originMessageId}:${input.target.targetBotId}`)}`,
      manifest: input.manifest,
      maxAutomaticOffers: 2,
      requestId: input.requestId,
      correlationId: input.correlationId,
      turnSelection: input.plan.turnSelection,
    });
    if (!created.replayed) {
      options.durabilityFailpoint?.("after_work_created", Object.freeze({
        roundId: input.round.id,
        workCount: worksForRound(input.round.id).length,
      }));
    }
    return created;
  }

  function assertWorksFollowPlan(
    round: RoundRecord,
    plan: CoordinatorAdmissionPlan,
    works: readonly WorkRecord[],
  ): void {
    const targetIndexes = new Map(
      plan.selectedTargets.map((target, index) => [target.targetPrincipalId, index]),
    );
    const indexes = works.map((work) => targetIndexes.get(work.targetPrincipalId) ?? -1);
    if (
      new Set(indexes).size !== indexes.length || indexes.includes(-1) ||
      works.some((work) =>
        work.principalId !== plan.actorPrincipalId ||
        work.channelId !== plan.channelId ||
        work.originMessageId !== plan.originMessageId ||
        work.roundId !== round.id || work.kind !== "channel.bot_turn"
      ) ||
      (plan.responseOrder === "parallel" && works.length > plan.selectedTargets.length) ||
      (plan.responseOrder === "sequential" &&
        [...indexes].sort((left, right) => left - right)
          .some((value, index) => value !== index))
    ) {
      throw new ChannelCoordinatorError(
        "illegal_state",
        "durable Channel Works differ from the immutable admission plan",
      );
    }
  }

  function assertTerminalAdmissionComplete(
    round: RoundRecord,
    plan: CoordinatorAdmissionPlan,
    works: readonly WorkRecord[],
  ): void {
    if (!ROUND_TERMINAL.has(round.state)) {
      throw new ChannelCoordinatorError(
        "illegal_state",
        "terminal admission validation requires a terminal Round",
      );
    }
    if (works.some((work) => !WORK_TERMINAL.has(work.state))) {
      throw new ChannelCoordinatorError(
        "illegal_state",
        "terminal Round retains nonterminal Work",
      );
    }
    if (round.state === "completed" && works.some((work) => work.state !== "succeeded")) {
      throw new ChannelCoordinatorError(
        "illegal_state",
        "completed Round retains unsuccessful Work",
      );
    }
    if (works.length === plan.selectedTargets.length) return;
    if (
      round.state === "cancelled" ||
      (round.state === "failed" && round.terminalReason === "deadline_exceeded")
    ) {
      return;
    }
    throw new ChannelCoordinatorError(
      "illegal_state",
      "terminal Round is incomplete relative to its immutable admission plan",
    );
  }

  function cancelQueuedRoundWorks(input: {
    round: RoundRecord;
    works: readonly WorkRecord[];
    actorPrincipalId: string;
    reasonCode: "round_cancelled" | "round_deadline_exceeded";
    requestId: string;
    correlationId: string;
  }): readonly WorkRecord[] {
    const timestamp = canonicalTimestamp(now());
    for (const work of input.works.filter((candidate) => candidate.state === "queued")) {
      options.work.cancelQueued({
        workId: work.id,
        actorPrincipalId: input.actorPrincipalId,
        reasonCode: input.reasonCode,
        sourceReference: `round:${input.round.id}`,
        timestamp,
        requestId: input.requestId,
        correlationId: input.correlationId,
      });
    }
    return worksForRound(input.round.id);
  }

  function repairInitialAdmission(input: {
    round: RoundRecord;
    plan: CoordinatorAdmissionPlan;
    requestId: string;
    correlationId: string;
  }): { round: RoundRecord; works: readonly WorkRecord[] } {
    let round = input.round;
    let existing = worksForRound(round.id);
    assertWorksFollowPlan(round, input.plan, existing);
    if (ROUND_TERMINAL.has(round.state)) {
      existing = cancelQueuedRoundWorks({
        ...input,
        works: existing,
        actorPrincipalId: input.plan.actorPrincipalId,
        reasonCode: round.terminalReason === "deadline_exceeded"
          ? "round_deadline_exceeded"
          : "round_cancelled",
      });
      assertTerminalAdmissionComplete(round, input.plan, existing);
      return Object.freeze({ round, works: existing });
    }
    if (
      now().valueOf() >= new Date(round.deadlineAt).valueOf() &&
      (round.state === "coordinating" || round.state === "waiting")
    ) {
      existing = cancelQueuedRoundWorks({
        ...input,
        works: existing,
        actorPrincipalId: input.plan.actorPrincipalId,
        reasonCode: "round_deadline_exceeded",
      });
      if (existing.some((work) => !WORK_TERMINAL.has(work.state))) {
        return Object.freeze({ round, works: existing });
      }
      round = options.rounds.reconcileDeadline({
        roundId: round.id,
        requestId: input.requestId,
        correlationId: input.correlationId,
      });
      assertTerminalAdmissionComplete(round, input.plan, existing);
      return Object.freeze({ round, works: existing });
    }
    const initialTargets = input.plan.responseOrder === "parallel"
      ? input.plan.selectedTargets
      : input.plan.selectedTargets.slice(0, 1);
    if (round.state === "open") {
      round = options.rounds.beginPass({
        roundId: round.id,
        requestId: input.requestId,
        correlationId: input.correlationId,
      });
    }
    if (ROUND_TERMINAL.has(round.state)) {
      existing = cancelQueuedRoundWorks({
        ...input,
        works: existing,
        actorPrincipalId: input.plan.actorPrincipalId,
        reasonCode: round.terminalReason === "deadline_exceeded"
          ? "round_deadline_exceeded"
          : "round_cancelled",
      });
      assertTerminalAdmissionComplete(round, input.plan, existing);
      return Object.freeze({ round, works: existing });
    }
    for (const target of initialTargets) {
      const alreadyInRound = existing.some(
        (work) => work.targetPrincipalId === target.targetPrincipalId,
      );
      const competing = options.database.readOne<{ count: number }>(
        `SELECT count(*) AS count FROM works
         WHERE channel_id = ? AND target_principal_id = ?
           AND (round_id IS NULL OR round_id <> ?)
           AND state IN ('queued','leased','running','cancelling')`,
        input.plan.channelId,
        target.targetPrincipalId,
        round.id,
      )?.count ?? 0;
      if (!alreadyInRound && competing > 0) {
        throw new ChannelCoordinatorError("turn_in_progress", "Bot already has an active turn");
      }
      createPlannedWork({
        round,
        plan: input.plan,
        target,
        manifest: input.plan.manifest,
        requestId: input.requestId,
        correlationId: input.correlationId,
      });
    }
    existing = worksForRound(round.id);
    assertWorksFollowPlan(round, input.plan, existing);
    if (initialTargets.some((target) =>
      !existing.some((work) => work.targetPrincipalId === target.targetPrincipalId)
    )) {
      throw new ChannelCoordinatorError(
        "illegal_state",
        "Round admission repair did not commit its exact initial Work set",
      );
    }
    return Object.freeze({ round: options.rounds.get(round.id) ?? round, works: existing });
  }

  function resumeAdmission(input: {
    roundId: string;
    authority: ChannelTurnTrigger["authority"];
    requestId: string;
    correlationId: string;
  }): CoordinatorAdmissionReplay {
    assertEnabled();
    assertAuthority(input.authority);
    const round = options.rounds.get(input.roundId);
    if (!round) throw new ChannelCoordinatorError("illegal_state", "admission Round is missing");
    let plan: CoordinatorAdmissionPlan;
    try {
      plan = readCoordinatorAdmissionPlan(options.database, round.id);
    } catch (error) {
      throw new ChannelCoordinatorError(
        "illegal_state",
        `active Round lacks a valid immutable admission plan: ${String(error)}`,
      );
    }
    const repaired = repairInitialAdmission({ ...input, round, plan });
    return Object.freeze({
      round: repaired.round,
      recipients: Object.freeze(
        plan.selectedTargets
          .filter((target) => repaired.works.some(
            (work) => work.targetPrincipalId === target.targetPrincipalId,
          ))
          .map((target) => target.targetPrincipalId),
      ),
      works: repaired.works,
      replayed: true as const,
    });
  }

  function admissionReplay(input: Pick<
    ChannelTurnTrigger,
    "messageId" | "channelId" | "actorPrincipalId" | "authority" | "requestId" | "correlationId"
  >): CoordinatorAdmissionReplay | null {
    assertEnabled();
    assertAuthority(input.authority);
    const message = options.database.readOne<{ authorPrincipalId: string }>(
      `SELECT author_principal_id AS authorPrincipalId FROM messages
       WHERE id = ? AND channel_id = ? AND stored_visibility = 'visible'`,
      input.messageId,
      input.channelId,
    );
    if (!message || message.authorPrincipalId !== input.actorPrincipalId) {
      throw new ChannelCoordinatorError("ineligible", "admission replay requires the exact visible trigger Message");
    }
    const roundId = roundIdForMessage(input.channelId, input.messageId);
    if (!roundId) return null;
    const plan = readCoordinatorAdmissionPlan(options.database, roundId);
    if (
      plan.channelId !== input.channelId || plan.originMessageId !== input.messageId ||
      plan.actorPrincipalId !== input.actorPrincipalId
    ) {
      throw new ChannelCoordinatorError("illegal_state", "Round admission plan differs from replay identity");
    }
    return resumeAdmission({
      roundId,
      authority: input.authority,
      requestId: input.requestId,
      correlationId: input.correlationId,
    });
  }

  function start(input: ChannelTurnTrigger): CoordinatorDispatch {
    assertEnabled();
    assertBoundedIds(input.mentionedBotIds, "mentions");
    assertBoundedIds(input.plannedBotIds, "planned recipients");
    assertBoundedIds(input.visibleParticipantIds, "visible participants");
    assertBoundedIds(input.standing.allowedParticipantIds, "standing allowlist");
    if (input.standing.source !== "trusted_policy_boundary" ||
        input.standing.channelId !== input.channelId || !input.standing.reference) {
      throw new ChannelCoordinatorError("outside_scope", "trusted standing scope does not cover Channel");
    }
    assertAuthority(input.authority);
    const message = options.database.readOne<{ authorPrincipalId: string; roundId: string | null }>(
      `SELECT author_principal_id AS authorPrincipalId, round_id AS roundId
       FROM messages WHERE id = ? AND channel_id = ? AND stored_visibility = 'visible'`,
      input.messageId, input.channelId,
    );
    if (!message || message.authorPrincipalId !== input.actorPrincipalId) {
      throw new ChannelCoordinatorError("ineligible", "trigger must bind a visible canonical Channel Message");
    }
    let plan = parseCoordinatorAdmissionPlan(input.admissionPlan);
    assertPlanTrigger(plan, input);
    const durableRoundId = roundIdForMessage(input.channelId, input.messageId);
    if (message.roundId && durableRoundId && message.roundId !== durableRoundId) {
      throw new ChannelCoordinatorError("illegal_state", "Message and admission plan reference different Rounds");
    }
    const resolvedRoundId = message.roundId ?? durableRoundId;
    let round = resolvedRoundId ? options.rounds.get(resolvedRoundId) : null;
    if (resolvedRoundId && !round) {
      throw new ChannelCoordinatorError(
        "illegal_state",
        "Message references a missing admission Round",
      );
    }
    const replayedRound = round !== null;
    let recipients: readonly string[];
    if (round) {
      plan = readCoordinatorAdmissionPlan(options.database, round.id);
      assertPlanTrigger(plan, input);
      const requested = new Set(input.mentionedBotIds);
      recipients = Object.freeze(
        plan.selectedTargets
          .filter((target) => requested.has(target.targetBotId))
          .map((target) => target.targetBotId),
      );
      if (recipients.length !== input.mentionedBotIds.length || recipients.length === 0) {
        throw new ChannelCoordinatorError("outside_scope", "dispatch recipient is outside the immutable Round plan");
      }
    } else {
      if (!sameCoordinatorAdmissionPlan(plan, Object.freeze({
        ...plan,
        manifest: input.manifest,
      }))) {
        throw new ChannelCoordinatorError("illegal_state", "initial manifest differs from its admission plan");
      }
      const channel = options.database.readOne<ChannelRow & { responseOrder: "parallel" | "sequential" }>(
        `SELECT lifecycle, responder_mode AS responderMode,
                coordinator_bot_id AS coordinatorBotId,
                response_order AS responseOrder, max_bot_turns AS maxBotTurns
         FROM channels WHERE id = ?`,
        input.channelId,
      );
      if (!channel || channel.lifecycle !== "active" ||
          (channel.responderMode === "mention_or_coordinator" && !channel.coordinatorBotId)) {
        throw new ChannelCoordinatorError("ineligible", "active coordinated Channel is required");
      }
      const actor = options.database.readOne<{ count: number }>(
        "SELECT count(*) AS count FROM channel_members WHERE channel_id = ? AND principal_id = ? AND active = 1",
        input.channelId, input.actorPrincipalId,
      );
      if (actor?.count !== 1) {
        throw new ChannelCoordinatorError("ineligible", "trigger actor is not an active member");
      }
      const eligible = options.database.readAll<EligibleBotRow>(
        `SELECT b.id FROM bots b JOIN channel_members m ON m.principal_id = b.id
         WHERE m.channel_id = ? AND m.active = 1 AND m.kind = 'bot'
           AND b.lifecycle = 'active' AND b.continuing_identity = 1 AND b.durable_mailbox = 1
         ORDER BY b.id`,
        input.channelId,
      );
      recipients = selectChannelRecipients(input, eligible);
      const plannedRecipients = selectChannelRecipients({
        ...input,
        selection: "mentions",
        mentionedBotIds: input.plannedBotIds,
      }, eligible);
      if (
        recipients.some((recipient) => !plannedRecipients.includes(recipient)) ||
        plannedRecipients.length !== plan.selectedTargets.length ||
        plannedRecipients.some(
          (recipient, index) => recipient !== plan.selectedTargets[index]?.targetBotId,
        ) || plan.responseOrder !== channel.responseOrder
      ) {
        throw new ChannelCoordinatorError("outside_scope", "trusted admission plan differs from current Channel policy");
      }
      if (plannedRecipients.length > channel.maxBotTurns) {
        throw new ChannelCoordinatorError("round_limit", "planned Bot turns exceed the configured Round limit");
      }
      const initialRecipients = plan.responseOrder === "parallel"
        ? plan.selectedTargets
        : plan.selectedTargets.slice(0, 1);
      for (const target of initialRecipients) {
        const active = options.database.readOne<{ count: number }>(
          `SELECT count(*) AS count FROM works
           WHERE channel_id = ? AND target_principal_id = ?
             AND state IN ('queued','leased','running','cancelling')`,
          input.channelId,
          target.targetPrincipalId,
        )?.count ?? 0;
        if (active > 0) {
          throw new ChannelCoordinatorError("turn_in_progress", "Bot already has an active turn");
        }
      }
      const roundCoordinatorBotId = channel.coordinatorBotId ?? plannedRecipients[0]!;
      round = options.rounds.create({
        channelId: input.channelId,
        coordinatorBotId: roundCoordinatorBotId,
        maxBotTurns: Math.min(8, Math.max(1, channel.maxBotTurns)),
        deadlineAt: input.deadlineAt,
        requestId: input.requestId,
        correlationId: input.correlationId,
        admissionPlan: coordinatorAdmissionPlanJson(plan),
      });
      options.durabilityFailpoint?.("after_round_created", Object.freeze({
        roundId: round.id,
        workCount: 0,
      }));
    }
    if (!round) throw new ChannelCoordinatorError("illegal_state", "admission Round is missing");
    const repaired = repairInitialAdmission({
      round,
      plan,
      requestId: input.requestId,
      correlationId: input.correlationId,
    });
    round = repaired.round;
    if (
      (round.state === "coordinating" || round.state === "waiting") &&
      now().valueOf() >= new Date(round.deadlineAt).valueOf()
    ) {
      throw new ChannelCoordinatorError(
        "illegal_state",
        "expired Round is waiting for its admitted Work to terminalize",
      );
    }
    if (round.channelId !== input.channelId || ROUND_TERMINAL.has(round.state)) {
      throw new ChannelCoordinatorError("illegal_state", "trigger resolves to an incompatible Round");
    }
    if (plan.selectedTargets.length > round.maxBotTurns) {
      throw new ChannelCoordinatorError("round_limit", "planned Bot turns exceed the durable Round limit");
    }

    for (const botId of recipients) {
      const duplicate = round && options.database.readOne<{ id: string }>(
        "SELECT id FROM works WHERE round_id = ? AND target_principal_id = ? AND origin_message_id = ? AND kind = 'channel.bot_turn'",
        round.id, botId, input.messageId,
      );
      const active = options.database.readOne<{ count: number }>(
        `SELECT count(*) AS count FROM works
         WHERE channel_id = ? AND target_principal_id = ?
           AND state IN ('queued','leased','running','cancelling')`,
        input.channelId, botId,
      )?.count ?? 0;
      if (!duplicate && active > 0) {
        throw new ChannelCoordinatorError("turn_in_progress", "Bot already has an active turn");
      }
    }

    const existingRoundWorks = options.database.readOne<{ count: number }>(
      "SELECT count(*) AS count FROM works WHERE round_id = ?", round.id,
    )?.count ?? 0;
    const newRecipients = recipients.filter((botId) => !options.database.readOne<{ id: string }>(
      "SELECT id FROM works WHERE round_id = ? AND target_principal_id = ? AND origin_message_id = ? AND kind = 'channel.bot_turn'",
      round!.id, botId, input.messageId,
    ));
    if (existingRoundWorks + newRecipients.length > round.maxBotTurns) {
      throw new ChannelCoordinatorError("round_limit", "configured Round turn limit reached");
    }
    if (newRecipients.length > 0) {
      assertChannelTurnCapacity({ roundTurns: existingRoundWorks, botTurns: 0, additions: newRecipients.length });
    }
    if (plan.responseOrder === "sequential") {
      const existingTargets = new Set(worksForRound(round.id).map((work) => work.targetPrincipalId));
      let expectedNext = existingTargets.size;
      for (const recipient of newRecipients) {
        if (plan.selectedTargets[expectedNext]?.targetBotId !== recipient) {
          throw new ChannelCoordinatorError("illegal_state", "sequential Work admission is outside durable target order");
        }
        expectedNext += 1;
      }
    }
    for (const botId of newRecipients) {
      const botTurns = options.database.readOne<{ count: number }>(
        "SELECT count(*) AS count FROM works WHERE round_id = ? AND target_principal_id = ?",
        round.id, botId,
      )?.count ?? 0;
      assertChannelTurnCapacity({ roundTurns: existingRoundWorks, botTurns });
    }

    const works = recipients.map((botId) => {
      const counts = options.database.readOne<{ total: number }>(
        "SELECT count(*) AS total FROM works WHERE round_id = ? AND target_principal_id = ?",
        round!.id, botId,
      ) ?? { total: 0 };
      const existing = options.database.readOne<{ id: string }>(
        "SELECT id FROM works WHERE round_id = ? AND target_principal_id = ? AND origin_message_id = ? AND kind = 'channel.bot_turn'",
        round!.id, botId, input.messageId,
      );
      if (!existing && counts.total >= MAX_CHANNEL_TURNS_PER_BOT) throw new ChannelCoordinatorError("turn_limit", "Bot turn limit reached");
      const roundCount = options.database.readOne<{ count: number }>(
        "SELECT count(*) AS count FROM works WHERE round_id = ?", round!.id,
      )?.count ?? 0;
      if (!existing && roundCount >= MAX_CHANNEL_TURNS_PER_ROUND) {
        throw new ChannelCoordinatorError("round_limit", "Round turn limit reached");
      }
      const target = plan.selectedTargets.find((candidate) => candidate.targetBotId === botId);
      if (!target) throw new ChannelCoordinatorError("illegal_state", "planned Work target is missing");
      return createPlannedWork({
        round: round!,
        plan,
        target,
        manifest: input.manifest,
        requestId: input.requestId,
        correlationId: input.correlationId,
      });
    });
    const provenance = Object.freeze({
      sourceEventId: input.eventId,
      sourceMessageId: input.messageId,
      standingReference: input.standing.reference,
      authority: Object.freeze({ ...input.authority }),
    });
    const activityFacts = works.map(({ work }) => Object.freeze({
      sourceKind: "work_attempt" as const,
      workId: work.id,
      roundId: round!.id,
      channelId: input.channelId,
      actorPrincipalId: input.actorPrincipalId,
      targetPrincipalId: work.targetPrincipalId,
      observedState: "queued" as const,
      authorityReference: `m16:${input.authority.writer}:epoch:${input.authority.epoch}`,
      sourceEventId: input.eventId,
    }));
    return Object.freeze({
      round,
      recipients,
      works: Object.freeze(works),
      replayed: replayedRound && works.every((work) => work.replayed),
      provenance,
      activityFacts: Object.freeze(activityFacts),
    });
  }

  function reconcile(input: ReconcileRoundInput): CoordinatorRoundStatus {
    assertEnabled();
    const round = options.rounds.get(input.roundId);
    if (!round) throw new ChannelCoordinatorError("invalid_request", "Round was not found");
    let current = round;
    let works = worksForRound(round.id);
    let plan: CoordinatorAdmissionPlan;
    try {
      plan = readCoordinatorAdmissionPlan(options.database, round.id);
    } catch (error) {
      throw new ChannelCoordinatorError(
        "illegal_state",
        `Round lacks a valid immutable admission plan: ${String(error)}`,
      );
    }
    assertWorksFollowPlan(round, plan, works);
    if (ROUND_TERMINAL.has(current.state)) {
      works = cancelQueuedRoundWorks({
        round: current,
        works,
        actorPrincipalId: plan.actorPrincipalId,
        reasonCode: current.terminalReason === "deadline_exceeded"
          ? "round_deadline_exceeded"
          : "round_cancelled",
        requestId: input.requestId,
        correlationId: input.correlationId,
      });
      assertTerminalAdmissionComplete(current, plan, works);
      return Object.freeze({ round: current, works, outcome: current.state as "completed" | "failed" | "cancelled", reasonCode: current.terminalReason });
    }
    if (new Date(now()).valueOf() >= new Date(current.deadlineAt).valueOf()) {
      works = cancelQueuedRoundWorks({
        round: current,
        works,
        actorPrincipalId: plan.actorPrincipalId,
        reasonCode: "round_deadline_exceeded",
        requestId: input.requestId,
        correlationId: input.correlationId,
      });
      if (works.some((work) => !WORK_TERMINAL.has(work.state))) {
        return Object.freeze({ round: current, works, outcome: "waiting", reasonCode: null });
      }
      current = current.state === "open"
        ? options.rounds.beginPass({
            roundId: current.id,
            requestId: input.requestId,
            correlationId: input.correlationId,
          })
        : options.rounds.reconcileDeadline(input);
      assertTerminalAdmissionComplete(current, plan, works);
      return Object.freeze({ round: current, works, outcome: current.state as "failed" | "cancelled", reasonCode: current.terminalReason });
    }
    if (works.some((work) => !WORK_TERMINAL.has(work.state))) {
      if (current.state === "coordinating") current = options.rounds.wait(input);
      return Object.freeze({ round: current, works, outcome: "waiting", reasonCode: null });
    }
    if (works.length !== plan.selectedTargets.length) {
      throw new ChannelCoordinatorError(
        "illegal_state",
        "Round cannot terminalize before its immutable admission plan is complete",
      );
    }
    const dispositions = input.dispositions ?? {};
    const values = works.map((work) => dispositions[work.id] ?? (work.state === "succeeded" ? "completed" : "permanent_failure"));
    const failures = values.some((value) => value === "permanent_failure" || value === "retryable_failure");
    const allPass = values.length > 0 && values.every((value) => value === "passed");
    if (!failures && works.some((work) => work.state !== "succeeded")) {
      throw new ChannelCoordinatorError(
        "illegal_state",
        "successful Round disposition requires succeeded Work",
      );
    }
    current = options.rounds.terminalize({
      roundId: input.roundId,
      requestId: input.requestId,
      correlationId: input.correlationId,
      status: failures ? "failed" : "completed",
      reasonCode: failures ? (values.some((value) => value === "completed" || value === "passed") ? "partial_failure" : "execution_failed") : (allPass ? "passed" : "completed"),
    });
    assertTerminalAdmissionComplete(current, plan, works);
    return Object.freeze({ round: current, works, outcome: current.state as "completed" | "failed", reasonCode: current.terminalReason });
  }

  function cancel(input: { roundId: string; actorPrincipalId: string; requestId: string; correlationId: string }): CoordinatorRoundStatus {
    assertEnabled();
    const round = options.rounds.get(input.roundId);
    if (!round) throw new ChannelCoordinatorError("invalid_request", "Round was not found");
    const works = cancelQueuedRoundWorks({
      round,
      works: worksForRound(round.id),
      actorPrincipalId: input.actorPrincipalId,
      reasonCode: "round_cancelled",
      requestId: input.requestId,
      correlationId: input.correlationId,
    });
    if (works.some((work) => !WORK_TERMINAL.has(work.state))) {
      return Object.freeze({
        round,
        works,
        outcome: "waiting",
        reasonCode: "cancellation_pending",
      });
    }
    const current = options.rounds.terminalize({
      roundId: round.id,
      status: "cancelled",
      reasonCode: "owner_cancelled",
      requestId: input.requestId,
      correlationId: input.correlationId,
    });
    return Object.freeze({
      round: current,
      works: worksForRound(round.id),
      outcome: current.state as "failed" | "cancelled",
      reasonCode: current.terminalReason,
    });
  }

  return Object.freeze({
    start,
    admissionReplay,
    resumeAdmission,
    recover: reconcile,
    reconcile,
    cancel,
  });
}
