import { createHash } from "node:crypto";

import { canonicalTimestamp } from "../work/canonical.js";
import type { WorkRecord } from "../work/index.js";
import { ChannelCoordinatorError } from "./errors.js";
import { assertChannelTurnCapacity, selectChannelRecipients } from "./selection.js";
import {
  MAX_CHANNEL_TURNS_PER_BOT,
  MAX_CHANNEL_TURNS_PER_ROUND,
  type ChannelTurnTrigger,
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

  function admissionReplay(input: Pick<
    ChannelTurnTrigger,
    "messageId" | "channelId" | "actorPrincipalId" | "authority"
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
    const prior = options.database.readAll<{ roundId: string }>(
      `SELECT DISTINCT round_id AS roundId FROM works
       WHERE origin_message_id = ? AND channel_id = ?
         AND kind = 'channel.bot_turn' AND round_id IS NOT NULL`,
      input.messageId,
      input.channelId,
    );
    if (prior.length === 0) return null;
    if (prior.length !== 1) {
      throw new ChannelCoordinatorError("illegal_state", "message maps to multiple Rounds");
    }
    const round = options.rounds.get(prior[0]!.roundId);
    if (!round || round.channelId !== input.channelId) {
      throw new ChannelCoordinatorError("illegal_state", "message references a missing or incompatible Round");
    }
    const works = worksForRound(round.id);
    if (
      works.length === 0 ||
      works.some((work) => work.originMessageId !== input.messageId || work.roundId !== round.id)
    ) {
      throw new ChannelCoordinatorError("illegal_state", "Round has no exact original Work set");
    }
    return Object.freeze({
      round,
      recipients: Object.freeze([...new Set(works.map((work) => work.targetPrincipalId))].sort()),
      works,
      replayed: true as const,
    });
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
    const channel = options.database.readOne<ChannelRow>(
      `SELECT lifecycle, responder_mode AS responderMode,
              coordinator_bot_id AS coordinatorBotId,
              max_bot_turns AS maxBotTurns
       FROM channels WHERE id = ?`,
      input.channelId,
    );
    if (!channel || channel.lifecycle !== "active" ||
        (channel.responderMode === "mention_or_coordinator" && !channel.coordinatorBotId)) {
      throw new ChannelCoordinatorError("ineligible", "active coordinated Channel is required");
    }
    const message = options.database.readOne<{ authorPrincipalId: string; roundId: string | null }>(
      `SELECT author_principal_id AS authorPrincipalId, round_id AS roundId
       FROM messages WHERE id = ? AND channel_id = ? AND stored_visibility = 'visible'`,
      input.messageId, input.channelId,
    );
    if (!message || message.authorPrincipalId !== input.actorPrincipalId) {
      throw new ChannelCoordinatorError("ineligible", "trigger must bind a visible canonical Channel Message");
    }
    const actor = options.database.readOne<{ count: number }>(
      "SELECT count(*) AS count FROM channel_members WHERE channel_id = ? AND principal_id = ? AND active = 1",
      input.channelId, input.actorPrincipalId,
    );
    if (actor?.count !== 1) throw new ChannelCoordinatorError("ineligible", "trigger actor is not an active member");
    const eligible = options.database.readAll<EligibleBotRow>(
      `SELECT b.id FROM bots b JOIN channel_members m ON m.principal_id = b.id
       WHERE m.channel_id = ? AND m.active = 1 AND m.kind = 'bot'
         AND b.lifecycle = 'active' AND b.continuing_identity = 1 AND b.durable_mailbox = 1
       ORDER BY b.id`,
      input.channelId,
    );
    const recipients = selectChannelRecipients(input, eligible);
    const plannedRecipients = selectChannelRecipients({
      ...input,
      selection: "mentions",
      mentionedBotIds: input.plannedBotIds,
    }, eligible);
    if (recipients.some((recipient) => !plannedRecipients.includes(recipient))) {
      throw new ChannelCoordinatorError("outside_scope", "dispatch recipient is outside the trusted Round plan");
    }
    if (recipients.length > MAX_CHANNEL_TURNS_PER_ROUND) {
      throw new ChannelCoordinatorError("round_limit", "recipient set exceeds Round turn limit");
    }
    if (plannedRecipients.length > channel.maxBotTurns) {
      throw new ChannelCoordinatorError("round_limit", "planned Bot turns exceed the configured Round limit");
    }
    // mentions_only Channels intentionally have no policy coordinator. A Round
    // still requires one lifecycle principal, so bind it deterministically to
    // the first selected recipient without changing the Channel policy.
    const roundCoordinatorBotId = channel.coordinatorBotId ?? plannedRecipients[0]!;

    const prior = options.database.readAll<{ roundId: string }>(
      `SELECT DISTINCT round_id AS roundId FROM works
       WHERE origin_message_id = ? AND kind = 'channel.bot_turn' AND round_id IS NOT NULL`,
      input.messageId,
    );
    if (prior.length > 1) throw new ChannelCoordinatorError("illegal_state", "message maps to multiple Rounds");
    let round = message.roundId
      ? options.rounds.get(message.roundId)
      : prior[0]?.roundId ? options.rounds.get(prior[0].roundId) : null;
    if (message.roundId && !round) {
      throw new ChannelCoordinatorError("illegal_state", "Message references a missing Round");
    }
    const replayedRound = prior.length === 1;
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
    if (!round) {
      round = options.rounds.create({
        channelId: input.channelId,
        coordinatorBotId: roundCoordinatorBotId,
        maxBotTurns: Math.min(8, Math.max(1, channel.maxBotTurns)),
        deadlineAt: input.deadlineAt,
        requestId: input.requestId,
        correlationId: input.correlationId,
      });
      round = options.rounds.beginPass({ roundId: round.id, requestId: input.requestId, correlationId: input.correlationId });
    } else if (!replayedRound && round.state === "waiting") {
      round = options.rounds.beginPass({ roundId: round.id, requestId: input.requestId, correlationId: input.correlationId });
    } else if (
      (round.state === "coordinating" || round.state === "waiting") &&
      now().valueOf() >= new Date(round.deadlineAt).valueOf()
    ) {
      round = options.rounds.reconcileDeadline({
        roundId: round.id,
        requestId: input.requestId,
        correlationId: input.correlationId,
      });
    }
    if (round.channelId !== input.channelId ||
        round.coordinatorBotId !== roundCoordinatorBotId || ROUND_TERMINAL.has(round.state)) {
      throw new ChannelCoordinatorError("illegal_state", "trigger resolves to an incompatible Round");
    }
    if (plannedRecipients.length > round.maxBotTurns) {
      throw new ChannelCoordinatorError("round_limit", "planned Bot turns exceed the durable Round limit");
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
      return options.work.create({
        principalId: input.actorPrincipalId,
        targetPrincipalId: botId,
        channelId: input.channelId,
        originMessageId: input.messageId,
        roundId: round!.id,
        kind: "channel.bot_turn",
        idempotencyKey: `m16:${hash(`${input.eventId}:${input.messageId}:${botId}`)}`,
        manifest: input.manifest,
        maxAutomaticOffers: 2,
        requestId: input.requestId,
        correlationId: input.correlationId,
        ...(input.turnSelection === undefined
          ? {}
          : { turnSelection: input.turnSelection }),
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
    const works = worksForRound(round.id);
    if (ROUND_TERMINAL.has(current.state)) {
      return Object.freeze({ round: current, works, outcome: current.state as "completed" | "failed" | "cancelled", reasonCode: current.terminalReason });
    }
    if (new Date(now()).valueOf() >= new Date(current.deadlineAt).valueOf()) {
      current = options.rounds.reconcileDeadline(input);
      return Object.freeze({ round: current, works, outcome: current.state as "failed" | "cancelled", reasonCode: current.terminalReason });
    }
    if (works.some((work) => !WORK_TERMINAL.has(work.state))) {
      if (current.state === "coordinating") current = options.rounds.wait(input);
      return Object.freeze({ round: current, works, outcome: "waiting", reasonCode: null });
    }
    const dispositions = input.dispositions ?? {};
    const values = works.map((work) => dispositions[work.id] ?? (work.state === "succeeded" ? "completed" : "permanent_failure"));
    const failures = values.some((value) => value === "permanent_failure" || value === "retryable_failure");
    const allPass = values.length > 0 && values.every((value) => value === "passed");
    current = options.rounds.terminalize({
      roundId: input.roundId,
      requestId: input.requestId,
      correlationId: input.correlationId,
      status: failures ? "failed" : "completed",
      reasonCode: failures ? (values.some((value) => value === "completed" || value === "passed") ? "partial_failure" : "execution_failed") : (allPass ? "passed" : "completed"),
    });
    return Object.freeze({ round: current, works, outcome: current.state as "completed" | "failed", reasonCode: current.terminalReason });
  }

  function cancel(input: { roundId: string; actorPrincipalId: string; requestId: string; correlationId: string }): CoordinatorRoundStatus {
    assertEnabled();
    const round = options.rounds.get(input.roundId);
    if (!round) throw new ChannelCoordinatorError("invalid_request", "Round was not found");
    const works = worksForRound(round.id);
    const at = canonicalTimestamp(now());
    for (const work of works.filter((candidate) => candidate.state === "queued")) {
      options.work.cancelQueued({
        workId: work.id,
        actorPrincipalId: input.actorPrincipalId,
        reasonCode: "round_cancelled",
        sourceReference: `round:${round.id}`,
        timestamp: at,
        requestId: input.requestId,
        correlationId: input.correlationId,
      });
    }
    const current = options.rounds.terminalize({
      roundId: round.id,
      status: "cancelled",
      reasonCode: "owner_cancelled",
      requestId: input.requestId,
      correlationId: input.correlationId,
    });
    return Object.freeze({ round: current, works: worksForRound(round.id), outcome: "cancelled", reasonCode: current.terminalReason });
  }

  return Object.freeze({ start, admissionReplay, recover: reconcile, reconcile, cancel });
}
