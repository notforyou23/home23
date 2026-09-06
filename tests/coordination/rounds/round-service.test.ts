import assert from "node:assert/strict";
import test from "node:test";

import {
  AT,
  BOT_ID,
  CHANNEL_ID,
  M11TestDatabase,
  OWNER_ID,
  createFixtureIdGenerator,
  fixtureId,
} from "../work/test-fixture.js";

const DEADLINE = "2026-08-25T16:10:00.000Z";

function mutationInput(suffix: number) {
  return {
    requestId: fixtureId("request", suffix),
    correlationId: fixtureId("correlation", suffix),
  };
}

function createInput(maxBotTurns = 2) {
  return {
    channelId: CHANNEL_ID,
    coordinatorBotId: BOT_ID,
    maxBotTurns,
    deadlineAt: DEADLINE,
    ...mutationInput(100),
  };
}

test("Round creation accepts exactly one persistent local Channel Bot and maxBotTurns 1 through 8", async (t) => {
  const { RoundError, createRoundService } = await import("../../../src/coordination/rounds/index.js")
    .catch((error: unknown) => assert.fail(`M11 Round service is unavailable: ${String(error)}`));
  const database = M11TestDatabase.temporary();
  t.after(() => database.close());
  const service = createRoundService({
    database,
    generateId: createFixtureIdGenerator(4_000),
    now: () => new Date(AT),
  });

  for (const maxBotTurns of [0, 9]) {
    assert.throws(
      () => service.create(createInput(maxBotTurns)),
      (error: unknown) => error instanceof RoundError && error.code === "invalid_request",
    );
  }
  assert.throws(
    () => service.create({ ...createInput(), coordinatorBotId: OWNER_ID }),
    (error: unknown) => error instanceof RoundError && error.code === "ineligible_coordinator",
  );

  const principalsBefore = database.readOne<{ count: number }>("SELECT count(*) AS count FROM principals")?.count;
  const membersBefore = database.readOne<{ count: number }>("SELECT count(*) AS count FROM channel_members")?.count;
  const round = service.create(createInput(8));
  assert.equal(round.state, "open");
  assert.equal(round.coordinatorBotId, BOT_ID);
  assert.equal(round.maxBotTurns, 8);
  assert.equal(round.passCount, 0);
  assert.equal(round.terminalReason, null);
  assert.equal(database.readOne<{ count: number }>("SELECT count(*) AS count FROM principals")?.count, principalsBefore);
  assert.equal(database.readOne<{ count: number }>("SELECT count(*) AS count FROM channel_members")?.count, membersBefore);
});

test("Round passes are monotonic and exceeding the bound terminates with the exact reason", async (t) => {
  const { RoundError, createRoundService } = await import("../../../src/coordination/rounds/index.js");
  const database = M11TestDatabase.temporary();
  t.after(() => database.close());
  const generateId = createFixtureIdGenerator(5_000);
  let service = createRoundService({ database, generateId, now: () => new Date(AT) });
  const created = service.create(createInput(2));

  const first = service.beginPass({ roundId: created.id, ...mutationInput(101) });
  assert.equal(first.state, "coordinating");
  assert.equal(first.passCount, 1);
  service.wait({ roundId: created.id, ...mutationInput(102) });
  database.reopen();
  service = createRoundService({ database, generateId, now: () => new Date(AT) });
  const second = service.beginPass({ roundId: created.id, ...mutationInput(103) });
  assert.equal(second.passCount, 2);
  service.wait({ roundId: created.id, ...mutationInput(104) });
  const exhausted = service.beginPass({ roundId: created.id, ...mutationInput(105) });
  assert.equal(exhausted.state, "failed");
  assert.equal(exhausted.passCount, 2);
  assert.equal(exhausted.terminalReason, "max_bot_turns_exhausted");
  assert.throws(
    () => service.beginPass({ roundId: created.id, ...mutationInput(106) }),
    (error: unknown) => error instanceof RoundError && error.code === "illegal_state",
  );
  assert.throws(
    () => database.raw.prepare("UPDATE rounds SET coordinator_bot_id = ? WHERE id = ?")
      .run(OWNER_ID, created.id),
    /terminal Round is immutable/,
  );
});

test("Round deadline and terminal operations use only legal transitions and retain an exact reason", async (t) => {
  const { RoundError, createRoundService } = await import("../../../src/coordination/rounds/index.js");
  const database = M11TestDatabase.temporary();
  t.after(() => database.close());
  const generateId = createFixtureIdGenerator(6_000);
  let clock = new Date(AT);
  const service = createRoundService({ database, generateId, now: () => clock });
  const deadlineRound = service.create(createInput(2));
  service.beginPass({ roundId: deadlineRound.id, ...mutationInput(110) });
  service.wait({ roundId: deadlineRound.id, ...mutationInput(111) });
  clock = new Date(DEADLINE);
  const expired = service.reconcileDeadline({ roundId: deadlineRound.id, ...mutationInput(112) });
  assert.equal(expired.state, "failed");
  assert.equal(expired.terminalReason, "deadline_exceeded");

  clock = new Date(AT);
  const completeRound = service.create({ ...createInput(1), ...mutationInput(113) });
  service.beginPass({ roundId: completeRound.id, ...mutationInput(114) });
  const completed = service.terminalize({
    roundId: completeRound.id,
    status: "completed",
    reasonCode: "coordinator_complete",
    ...mutationInput(115),
  });
  assert.equal(completed.state, "completed");
  assert.equal(completed.terminalReason, "coordinator_complete");
  assert.throws(
    () => service.terminalize({
      roundId: completeRound.id,
      status: "failed",
      reasonCode: "late_failure",
      ...mutationInput(116),
    }),
    (error: unknown) => error instanceof RoundError && error.code === "illegal_state",
  );
  assert.throws(
    () => service.create({ ...createInput(), deadlineAt: AT, ...mutationInput(117) }),
    (error: unknown) => error instanceof RoundError && error.code === "invalid_request",
  );
});

test("waiting at the exact deadline fails the Round with deadline_exceeded", async (t) => {
  const { createRoundService } = await import("../../../src/coordination/rounds/index.js");
  const database = M11TestDatabase.temporary();
  t.after(() => database.close());
  let clock = new Date(AT);
  const service = createRoundService({
    database,
    generateId: createFixtureIdGenerator(6_500),
    now: () => clock,
  });
  const round = service.create({ ...createInput(2), ...mutationInput(120) });
  service.beginPass({ roundId: round.id, ...mutationInput(121) });

  clock = new Date(DEADLINE);
  const failed = service.wait({ roundId: round.id, ...mutationInput(122) });
  assert.equal(failed.state, "failed");
  assert.equal(failed.passCount, 1);
  assert.equal(failed.terminalReason, "deadline_exceeded");
  assert.equal(failed.terminalAt, DEADLINE);
});

test("completion after the deadline fails the Round instead of committing a late success", async (t) => {
  const { createRoundService } = await import("../../../src/coordination/rounds/index.js");
  const database = M11TestDatabase.temporary();
  t.after(() => database.close());
  let clock = new Date(AT);
  const service = createRoundService({
    database,
    generateId: createFixtureIdGenerator(6_700),
    now: () => clock,
  });
  const round = service.create({ ...createInput(2), ...mutationInput(130) });
  service.beginPass({ roundId: round.id, ...mutationInput(131) });

  clock = new Date("2026-08-25T16:10:00.001Z");
  const failed = service.terminalize({
    roundId: round.id,
    status: "completed",
    reasonCode: "coordinator_complete",
    ...mutationInput(132),
  });
  assert.equal(failed.state, "failed");
  assert.equal(failed.terminalReason, "deadline_exceeded");
  assert.equal(failed.terminalAt, "2026-08-25T16:10:00.001Z");
  assert.equal(
    database.readOne<{ count: number }>(
      "SELECT count(*) AS count FROM rounds WHERE id = ? AND state = 'completed'",
      round.id,
    )?.count,
    0,
  );
});

test("an expired open Round cancels legally for begin, terminal, and explicit cancel requests", async (t) => {
  const { RoundError, createRoundService } = await import("../../../src/coordination/rounds/index.js");
  const database = M11TestDatabase.temporary();
  t.after(() => database.close());
  let clock = new Date(AT);
  const service = createRoundService({
    database,
    generateId: createFixtureIdGenerator(6_900),
    now: () => clock,
  });
  const beginRound = service.create({ ...createInput(2), ...mutationInput(140) });
  const terminalRound = service.create({ ...createInput(2), ...mutationInput(141) });
  const cancelRound = service.create({ ...createInput(2), ...mutationInput(142) });

  clock = new Date(DEADLINE);
  const fromBegin = service.beginPass({ roundId: beginRound.id, ...mutationInput(143) });
  assert.equal(fromBegin.state, "cancelled");
  assert.equal(fromBegin.passCount, 0);
  assert.equal(fromBegin.terminalReason, "deadline_exceeded");

  const fromTerminal = service.terminalize({
    roundId: terminalRound.id,
    status: "completed",
    reasonCode: "coordinator_complete",
    ...mutationInput(144),
  });
  assert.equal(fromTerminal.state, "cancelled");
  assert.equal(fromTerminal.terminalReason, "deadline_exceeded");

  const fromCancel = service.terminalize({
    roundId: cancelRound.id,
    status: "cancelled",
    reasonCode: "operator_cancelled",
    ...mutationInput(145),
  });
  assert.equal(fromCancel.state, "cancelled");
  assert.equal(fromCancel.terminalReason, "deadline_exceeded");
  assert.throws(
    () => service.terminalize({
      roundId: cancelRound.id,
      status: "cancelled",
      reasonCode: "operator_cancelled",
      ...mutationInput(146),
    }),
    (error: unknown) => error instanceof RoundError && error.code === "illegal_state",
  );
});
