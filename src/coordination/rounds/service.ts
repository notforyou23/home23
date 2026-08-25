import { assertCoordinationId } from "../ids/index.js";
import { assertExactKeys, assertId, canonicalTimestamp } from "../work/canonical.js";
import { assertM11Transition } from "../work/state-machines.js";

import { RoundError } from "./errors.js";
import type {
  CreateRoundInput,
  CreateRoundServiceOptions,
  MutateRoundInput,
  RoundRecord,
  TerminalizeRoundInput,
} from "./types.js";

interface RoundRow extends RoundRecord {}

const ROUND_SELECT = `
SELECT id, channel_id AS channelId, coordinator_bot_id AS coordinatorBotId,
       state, max_bot_turns AS maxBotTurns, pass_count AS passCount,
       deadline_at AS deadlineAt, terminal_reason AS terminalReason, version,
       created_at AS createdAt, updated_at AS updatedAt, terminal_at AS terminalAt
FROM rounds`;

function freezeRound(row: RoundRow): RoundRecord {
  return Object.freeze({ ...row });
}

function assertMutationIdentity(input: MutateRoundInput): MutateRoundInput {
  assertExactKeys(input, ["roundId", "requestId", "correlationId"], "invalid_request", "Round mutation");
  assertId("round", input.roundId, "invalid_request");
  assertId("request", input.requestId, "invalid_request");
  assertId("correlation", input.correlationId, "invalid_request");
  return input;
}

function assertReasonCode(reasonCode: unknown): string {
  if (typeof reasonCode !== "string" || !/^[a-z][a-z0-9_.-]{0,63}$/.test(reasonCode)) {
    throw new RoundError("invalid_request", "terminal reason must be a bounded identifier");
  }
  return reasonCode;
}

export function createRoundService(options: CreateRoundServiceOptions) {
  const now = options.now ?? (() => new Date());

  function read(roundId: string): RoundRecord {
    const row = options.database.readOne<RoundRow>(`${ROUND_SELECT} WHERE id = ?`, roundId);
    if (!row) throw new RoundError("not_found", "Round was not found");
    return freezeRound(row);
  }

  function event(
    round: Pick<RoundRecord, "id" | "channelId" | "coordinatorBotId" | "version">,
    identity: Pick<MutateRoundInput, "requestId" | "correlationId">,
    createdAt: string,
    state: RoundRecord["state"],
    passCount: number,
    reasonCode: string | null,
  ) {
    return {
      type: "turn.updated",
      aggregateKind: "round",
      aggregateId: round.id,
      aggregateVersion: round.version + 1,
      channelId: round.channelId,
      actorPrincipalId: round.coordinatorBotId,
      requestId: identity.requestId,
      correlationId: identity.correlationId,
      payload: {
        roundId: round.id,
        coordinatorBotId: round.coordinatorBotId,
        state,
        passCount,
        reasonCode,
      },
      createdAt,
    } as const;
  }

  function terminalizeExact(
    round: RoundRecord,
    identity: Pick<MutateRoundInput, "requestId" | "correlationId">,
    state: "completed" | "failed" | "cancelled",
    reasonCode: string,
    at: string,
  ): RoundRecord {
    if (["completed", "failed", "cancelled"].includes(round.state)) {
      throw new RoundError("illegal_state", "terminal Round is immutable");
    }
    try {
      assertM11Transition("round", round.state, state);
    } catch {
      throw new RoundError("illegal_state", `Round cannot transition ${round.state} -> ${state}`);
    }
    options.database.mutateWithEvent((transaction) => {
      transaction.run(
        `UPDATE rounds SET state = ?, terminal_reason = ?, terminal_at = ?,
           updated_at = ?, version = version + 1 WHERE id = ?`,
        state, reasonCode, at, at, round.id,
      );
      return {
        value: undefined,
        event: event(round, identity, at, state, round.passCount, reasonCode),
      };
    });
    return read(round.id);
  }

  function enforceDeadline(
    round: RoundRecord,
    identity: Pick<MutateRoundInput, "requestId" | "correlationId">,
    at: string,
  ): RoundRecord | null {
    if (["completed", "failed", "cancelled"].includes(round.state)) return null;
    if (new Date(at).valueOf() < new Date(round.deadlineAt).valueOf()) return null;
    if (round.state === "coordinating" || round.state === "waiting") {
      return terminalizeExact(round, identity, "failed", "deadline_exceeded", at);
    }
    return terminalizeExact(round, identity, "cancelled", "deadline_exceeded", at);
  }

  return Object.freeze({
    create(input: CreateRoundInput): RoundRecord {
      assertExactKeys(
        input,
        ["channelId", "coordinatorBotId", "maxBotTurns", "deadlineAt", "requestId", "correlationId"],
        "invalid_request",
        "Round creation",
      );
      const channelId = assertId("channel", input.channelId, "invalid_request");
      const coordinatorBotId = assertId("principal", input.coordinatorBotId, "invalid_request");
      const requestId = assertId("request", input.requestId, "invalid_request");
      const correlationId = assertId("correlation", input.correlationId, "invalid_request");
      if (!Number.isSafeInteger(input.maxBotTurns) || input.maxBotTurns < 1 || input.maxBotTurns > 8) {
        throw new RoundError("invalid_request", "maxBotTurns must be between 1 and 8");
      }
      const deadline = new Date(input.deadlineAt);
      if (
        Number.isNaN(deadline.valueOf()) ||
        canonicalTimestamp(deadline) !== input.deadlineAt ||
        deadline.valueOf() <= now().valueOf()
      ) {
        throw new RoundError("invalid_request", "Round deadline must be a future canonical UTC timestamp");
      }
      const eligible = options.database.readOne<{ count: number }>(
        `SELECT count(*) AS count
         FROM bots b
         JOIN channel_members m ON m.principal_id = b.id
         JOIN channels c ON c.id = m.channel_id
         WHERE b.id = ? AND m.channel_id = ? AND b.principal_id = b.id
           AND b.lifecycle = 'active' AND b.continuing_identity = 1
           AND b.durable_mailbox = 1 AND m.kind = 'bot' AND m.active = 1
           AND c.lifecycle = 'active'`,
        coordinatorBotId,
        channelId,
      );
      if (eligible?.count !== 1) {
        throw new RoundError("ineligible_coordinator", "coordinator must be one persistent local Channel Bot");
      }
      const roundId = options.generateId("round");
      assertCoordinationId("round", roundId);
      const createdAt = canonicalTimestamp(now());
      options.database.mutateWithEvent((transaction) => {
        transaction.run(
          `INSERT INTO rounds (
            id, channel_id, coordinator_bot_id, state, max_bot_turns,
            pass_count, deadline_at, terminal_reason, version, created_at,
            updated_at, terminal_at
          ) VALUES (?, ?, ?, 'open', ?, 0, ?, NULL, 1, ?, ?, NULL)`,
          roundId, channelId, coordinatorBotId, input.maxBotTurns,
          input.deadlineAt, createdAt, createdAt,
        );
        return {
          value: undefined,
          event: {
            type: "turn.updated",
            aggregateKind: "round",
            aggregateId: roundId,
            aggregateVersion: 1,
            channelId,
            actorPrincipalId: coordinatorBotId,
            requestId,
            correlationId,
            payload: {
              roundId,
              coordinatorBotId,
              state: "open",
              passCount: 0,
              reasonCode: null,
            },
            createdAt,
          },
        };
      });
      return read(roundId);
    },

    beginPass(input: MutateRoundInput): RoundRecord {
      assertMutationIdentity(input);
      const round = read(input.roundId);
      if (round.state !== "open" && round.state !== "waiting") {
        throw new RoundError("illegal_state", "only open or waiting Round may begin a pass");
      }
      const at = canonicalTimestamp(now());
      const deadlineResult = enforceDeadline(round, input, at);
      if (deadlineResult) return deadlineResult;
      if (round.passCount >= round.maxBotTurns) {
        if (round.state === "waiting") {
          return terminalizeExact(round, input, "failed", "max_bot_turns_exhausted", at);
        }
        throw new RoundError("illegal_state", "open Round has no available Bot pass");
      }
      try {
        assertM11Transition("round", round.state, "coordinating");
      } catch {
        throw new RoundError("illegal_state", "Round cannot begin coordination");
      }
      const passCount = round.passCount + 1;
      options.database.mutateWithEvent((transaction) => {
        transaction.run(
          "UPDATE rounds SET state = 'coordinating', pass_count = ?, updated_at = ?, version = version + 1 WHERE id = ?",
          passCount, at, round.id,
        );
        return {
          value: undefined,
          event: event(round, input, at, "coordinating", passCount, null),
        };
      });
      return read(round.id);
    },

    wait(input: MutateRoundInput): RoundRecord {
      assertMutationIdentity(input);
      const round = read(input.roundId);
      if (round.state !== "coordinating") throw new RoundError("illegal_state", "only coordinating Round may wait");
      const at = canonicalTimestamp(now());
      const deadlineResult = enforceDeadline(round, input, at);
      if (deadlineResult) return deadlineResult;
      assertM11Transition("round", "coordinating", "waiting");
      options.database.mutateWithEvent((transaction) => {
        transaction.run(
          "UPDATE rounds SET state = 'waiting', updated_at = ?, version = version + 1 WHERE id = ?",
          at, round.id,
        );
        return {
          value: undefined,
          event: event(round, input, at, "waiting", round.passCount, null),
        };
      });
      return read(round.id);
    },

    reconcileDeadline(input: MutateRoundInput): RoundRecord {
      assertMutationIdentity(input);
      const round = read(input.roundId);
      if (round.state !== "coordinating" && round.state !== "waiting") {
        throw new RoundError("illegal_state", "deadline reconciliation requires coordinating or waiting Round");
      }
      const at = canonicalTimestamp(now());
      const deadlineResult = enforceDeadline(round, input, at);
      if (!deadlineResult) throw new RoundError("invalid_request", "Round deadline has not elapsed");
      return deadlineResult;
    },

    terminalize(input: TerminalizeRoundInput): RoundRecord {
      assertExactKeys(
        input,
        ["roundId", "status", "reasonCode", "requestId", "correlationId"],
        "invalid_request",
        "Round terminal request",
      );
      const roundId = assertId("round", input.roundId, "invalid_request");
      assertId("request", input.requestId, "invalid_request");
      assertId("correlation", input.correlationId, "invalid_request");
      if (!["completed", "failed", "cancelled"].includes(input.status)) {
        throw new RoundError("invalid_request", "invalid Round terminal status");
      }
      const reasonCode = assertReasonCode(input.reasonCode);
      const round = read(roundId);
      const at = canonicalTimestamp(now());
      const deadlineResult = enforceDeadline(round, input, at);
      if (deadlineResult) return deadlineResult;
      return terminalizeExact(round, input, input.status, reasonCode, at);
    },

    get(roundId: string): RoundRecord | null {
      assertCoordinationId("round", roundId);
      const row = options.database.readOne<RoundRow>(`${ROUND_SELECT} WHERE id = ?`, roundId);
      return row ? freezeRound(row) : null;
    },
  });
}
