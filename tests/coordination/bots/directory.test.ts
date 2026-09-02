import assert from "node:assert/strict";
import test from "node:test";

import {
  BotDirectoryError,
  createBotDirectory,
  type ApprovedBotBinding,
  type AuthenticatedResidentContext,
  type GeneratedBotDirectoryIdKind,
  type OwnerBotDirectoryMutationContext,
} from "../../../src/coordination/bots/index.js";

import { TestBotDirectoryRepository } from "./test-repository.js";

const BOT_IDS = [
  "bot_0198d95f-6c00-7000-8000-000000000011",
  "bot_0198d95f-6c00-7000-8000-000000000012",
  "bot_0198d95f-6c00-7000-8000-000000000013",
] as const;
const ALIAS_IDS = [
  "alias_0198d95f-6c00-7000-8000-000000000021",
  "alias_0198d95f-6c00-7000-8000-000000000022",
  "alias_0198d95f-6c00-7000-8000-000000000023",
  "alias_0198d95f-6c00-7000-8000-000000000024",
  "alias_0198d95f-6c00-7000-8000-000000000025",
  "alias_0198d95f-6c00-7000-8000-000000000026",
] as const;

const JERRY: ApprovedBotBinding = {
  residentBinding: "jerry",
  name: "Jerry",
  purpose: "Primary persistent household assistant.",
  continuingIdentity: true,
  durableMailbox: true,
  requiredCapabilities: ["messages"],
  aliases: [{ namespace: "resident", value: "jerry" }],
};

const FORREST: ApprovedBotBinding = {
  residentBinding: "forrest",
  name: "Forrest",
  purpose: "Persistent specialist with a durable mailbox.",
  continuingIdentity: true,
  durableMailbox: true,
  requiredCapabilities: ["messages", "research"],
  aliases: [{ namespace: "resident", value: "forrest" }],
};

function coordinationId(kind: "request" | "correlation", suffix: number): string {
  const prefix = kind === "request" ? "req_" : "cor_";
  return `${prefix}0198d95f-6c00-7000-8000-${suffix.toString(16).padStart(12, "0")}`;
}

function residentContext(
  residentSlug: string,
  instanceId: string,
  keyVersion: number,
  receiptSuffix: number,
  role: AuthenticatedResidentContext["credential"]["role"] = "resident",
): AuthenticatedResidentContext {
  return {
    credential: { residentSlug, instanceId, keyVersion, role },
    requestId: coordinationId("request", receiptSuffix),
    correlationId: coordinationId("correlation", receiptSuffix),
  };
}

function ownerContext(receiptSuffix: number): OwnerBotDirectoryMutationContext {
  return {
    principalId: "user_owner",
    requestId: coordinationId("request", receiptSuffix),
    correlationId: coordinationId("correlation", receiptSuffix),
  };
}

function idGenerator() {
  let botIndex = 0;
  let aliasIndex = 0;
  return (kind: GeneratedBotDirectoryIdKind): string => {
    if (kind === "bot") return BOT_IDS[botIndex++] ?? BOT_IDS.at(-1)!;
    return ALIAS_IDS[aliasIndex++] ?? ALIAS_IDS.at(-1)!;
  };
}

function service(
  repository: TestBotDirectoryRepository,
  clock: { now: Date },
  generateId = idGenerator(),
) {
  return createBotDirectory({
    repository,
    now: () => clock.now,
    idGenerator: generateId,
    availabilityPolicy: {
      degradedAfterMs: 30_000,
      offlineAfterMs: 90_000,
    },
  });
}

async function seedVisibleRoster(
  directory: ReturnType<typeof createBotDirectory>,
) {
  return Promise.all([
    directory.ensurePersistentBinding(JERRY, ownerContext(1)),
    directory.ensurePersistentBinding(FORREST, ownerContext(2)),
  ]);
}

test("Jerry and Forrest retain stable Bot principals across resident restarts", async () => {
  const repository = new TestBotDirectoryRepository();
  const clock = { now: new Date("2026-08-25T12:00:00.000Z") };
  const firstDirectory = service(repository, clock);
  const [seededJerry, seededForrest] = await seedVisibleRoster(firstDirectory);

  const firstRegistration = await firstDirectory.registerResident({
    context: residentContext("jerry", "resident-jerry-incarnation-1", 1, 11),
    botBinding: "jerry",
    protocolVersion: 1,
    capabilities: ["messages"],
  });
  const available = await firstDirectory.heartbeatResident({
    context: residentContext("jerry", "resident-jerry-incarnation-1", 1, 12),
    availability: "available",
  });
  const firstForrestRegistration = await firstDirectory.registerResident({
    context: residentContext("forrest", "resident-forrest-incarnation-1", 1, 13),
    botBinding: "forrest",
    protocolVersion: 1,
    capabilities: ["messages", "research"],
  });
  await firstDirectory.heartbeatResident({
    context: residentContext("forrest", "resident-forrest-incarnation-1", 1, 14),
    availability: "available",
  });

  clock.now = new Date("2026-08-25T12:00:05.000Z");
  const restartedDirectory = service(repository, clock);
  const [reseededJerry, reseededForrest] = await seedVisibleRoster(restartedDirectory);
  await assert.rejects(
    restartedDirectory.registerResident({
      context: residentContext("jerry", "resident-jerry-incarnation-2", 1, 15),
      botBinding: "jerry",
      protocolVersion: 1,
      capabilities: ["messages"],
    }),
    (error: unknown) =>
      error instanceof BotDirectoryError && error.code === "registration_stale",
  );
  const restarted = await restartedDirectory.registerResident({
    context: residentContext("jerry", "resident-jerry-incarnation-2", 2, 16),
    botBinding: "jerry",
    protocolVersion: 1,
    capabilities: ["messages"],
  });
  const restartedForrest = await restartedDirectory.registerResident({
    context: residentContext("forrest", "resident-forrest-incarnation-2", 2, 17),
    botBinding: "forrest",
    protocolVersion: 1,
    capabilities: ["messages", "research"],
  });

  assert.equal(seededJerry.id, BOT_IDS[0]);
  assert.equal(seededForrest.id, BOT_IDS[1]);
  assert.equal(firstRegistration.botId, seededJerry.id);
  assert.equal(firstForrestRegistration.botId, seededForrest.id);
  assert.equal(firstRegistration.availability, "starting");
  assert.equal(available.availability, "available");
  assert.equal(reseededJerry.id, seededJerry.id);
  assert.equal(reseededForrest.id, seededForrest.id);
  assert.equal(restarted.botId, seededJerry.id);
  assert.equal(restarted.principalId, seededJerry.principalId);
  assert.equal(restarted.availability, "degraded");
  assert.equal(restartedForrest.botId, seededForrest.id);
  assert.equal(restartedForrest.principalId, seededForrest.principalId);
  assert.equal(restartedForrest.availability, "degraded");
  assert.equal((await restartedDirectory.heartbeatResident({
    context: residentContext("jerry", "resident-jerry-incarnation-2", 2, 18),
    availability: "available",
  })).availability, "available");
  assert.equal((await restartedDirectory.heartbeatResident({
    context: residentContext("forrest", "resident-forrest-incarnation-2", 2, 19),
    availability: "available",
  })).availability, "available");
  await assert.rejects(
    restartedDirectory.registerResident({
      context: residentContext("jerry", "resident-jerry-incarnation-1", 1, 20),
      botBinding: "jerry",
      protocolVersion: 1,
      capabilities: ["messages"],
    }),
    (error: unknown) =>
      error instanceof BotDirectoryError && error.code === "registration_stale",
  );
  assert.deepEqual(repository.principals, new Set([
    "user_owner",
    seededJerry.id,
    seededForrest.id,
  ]));
  assert.deepEqual(
    repository.committedMutations
      .filter((mutation) => mutation.kind !== "binding")
      .slice(0, 2),
    [
      {
        kind: "registration",
        requestId: coordinationId("request", 11),
        correlationId: coordinationId("correlation", 11),
      },
      {
        kind: "heartbeat",
        requestId: coordinationId("request", 12),
        correlationId: coordinationId("correlation", 12),
      },
    ],
  );

  const roster = await restartedDirectory.listVisibleBots();
  assert.deepEqual(roster.map((bot) => bot.name), ["Forrest", "Jerry"]);
  assert.equal(roster.some((bot) => "activeInstanceId" in bot), false);
  assert.equal(roster.some((bot) => "residentCapabilities" in bot), false);
  assert.equal(
    (await restartedDirectory.resolveAlias("resident", "jerry"))?.id,
    seededJerry.id,
  );
});

test("unbound temporary hands and nonpersistent definitions never enter the roster", async () => {
  const repository = new TestBotDirectoryRepository();
  const clock = { now: new Date("2026-08-25T13:00:00.000Z") };
  const directory = service(repository, clock);
  await seedVisibleRoster(directory);

  await assert.rejects(
    directory.registerResident({
      context: residentContext("coding-worker", "temporary-hand-1", 1, 21),
      botBinding: "coding-worker",
      protocolVersion: 1,
      capabilities: ["messages"],
    }),
    (error: unknown) =>
      error instanceof BotDirectoryError &&
      error.code === "unauthorized_registration",
  );
  await assert.rejects(
    directory.ensurePersistentBinding({
      residentBinding: "temporary-hand",
      name: "Temporary hand",
      purpose: "One execution only.",
      continuingIdentity: false,
      durableMailbox: false,
      requiredCapabilities: ["messages"],
      aliases: [],
    }, ownerContext(22)),
    (error: unknown) =>
      error instanceof BotDirectoryError && error.code === "binding_not_persistent",
  );

  assert.deepEqual(
    (await directory.listVisibleBots()).map((bot) => bot.name),
    ["Forrest", "Jerry"],
  );
  assert.equal(repository.bots.size, 2);
});

test("lifecycle inventory retains archived Bots without admitting them to active surfaces", async () => {
  const repository = new TestBotDirectoryRepository();
  const clock = { now: new Date("2026-08-25T13:30:00.000Z") };
  const directory = service(repository, clock);
  const [jerry, forrest] = await seedVisibleRoster(directory);
  const stored = repository.bots.get(forrest.id)!;
  repository.bots.set(forrest.id, {
    ...stored,
    lifecycle: "archived",
    activeInstanceId: null,
    activeKeyVersion: null,
    residentProtocolVersion: null,
    residentCapabilities: [],
    residentRegisteredAt: null,
    lastHeartbeatAt: null,
    reportedAvailability: null,
    version: stored.version + 1,
    updatedAt: "2026-08-25T13:30:01.000Z",
  });

  assert.deepEqual((await directory.listVisibleBots()).map((bot) => bot.id), [jerry.id]);
  assert.deepEqual(
    (await directory.listLifecycleBots()).map((bot) => [bot.id, bot.lifecycle]),
    [[forrest.id, "archived"], [jerry.id, "active"]],
  );
  const archived = await directory.getLifecycleBot(forrest.id);
  assert.equal(archived?.principalId, forrest.principalId);
  assert.equal(archived?.conversationId, forrest.conversationId);
  assert.equal(archived?.residentBinding, forrest.residentBinding);
  assert.equal(archived?.availability, "offline");
  assert.equal(await directory.resolveAlias("resident", "forrest"), null);
});

test("stale heartbeats degrade then take a Bot offline without identity or mailbox churn", async () => {
  const repository = new TestBotDirectoryRepository();
  const clock = { now: new Date("2026-08-25T14:00:00.000Z") };
  const directory = service(repository, clock);
  const [jerry] = await seedVisibleRoster(directory);
  await directory.registerResident({
    context: residentContext("jerry", "resident-jerry-incarnation-1", 1, 31),
    botBinding: "jerry",
    protocolVersion: 1,
    capabilities: ["messages"],
  });
  await directory.heartbeatResident({
    context: residentContext("jerry", "resident-jerry-incarnation-1", 1, 32),
    availability: "available",
  });

  clock.now = new Date("2026-08-25T14:00:30.000Z");
  const degraded = (await directory.listVisibleBots()).find(
    (bot) => bot.id === jerry.id,
  );
  clock.now = new Date("2026-08-25T14:01:30.000Z");
  const offline = (await directory.listVisibleBots()).find(
    (bot) => bot.id === jerry.id,
  );

  assert.equal(degraded?.availability, "degraded");
  assert.equal(offline?.availability, "offline");
  assert.equal(offline?.id, jerry.id);
  assert.equal(offline?.principalId, jerry.id);
  assert.equal(offline?.conversationId, null);
  assert.equal(repository.bots.has(jerry.id), true);
  assert.equal(
    (await directory.resolveAlias("resident", "jerry"))?.principalId,
    jerry.id,
  );

  await assert.rejects(
    directory.heartbeatResident({
      context: residentContext("jerry", "resident-jerry-incarnation-1", 1, 33),
      availability: "available",
    }),
    (error: unknown) =>
      error instanceof BotDirectoryError && error.code === "registration_stale",
  );
  const recovered = await directory.registerResident({
    context: residentContext("jerry", "resident-jerry-incarnation-2", 1, 34),
    botBinding: "jerry",
    protocolVersion: 1,
    capabilities: ["messages"],
  });
  assert.equal(recovered.botId, jerry.id);
  assert.equal(recovered.availability, "starting");
});

test("capability projection degrades truthfully and M02 availability transitions fail closed", async () => {
  const repository = new TestBotDirectoryRepository();
  const clock = { now: new Date("2026-08-25T15:00:00.000Z") };
  const directory = service(repository, clock);
  const [, forrest] = await seedVisibleRoster(directory);

  const registered = await directory.registerResident({
    context: residentContext("forrest", "resident-forrest-1", 1, 41),
    botBinding: "forrest",
    protocolVersion: 1,
    capabilities: ["messages"],
  });
  assert.equal(registered.botId, forrest.id);
  assert.equal(registered.availability, "degraded");

  await assert.rejects(
    directory.heartbeatResident({
      context: residentContext("forrest", "resident-forrest-1", 1, 42),
      availability: "busy",
    }),
    (error: unknown) =>
      error instanceof BotDirectoryError &&
      error.code === "availability_transition_invalid",
  );
});

test("alias collisions, peer-binding mismatch, and nonresident roles fail closed", async () => {
  const repository = new TestBotDirectoryRepository();
  const clock = { now: new Date("2026-08-25T16:00:00.000Z") };
  const directory = service(repository, clock);
  const [jerry] = await seedVisibleRoster(directory);

  await assert.rejects(
    directory.ensurePersistentBinding({
      residentBinding: "records-specialist",
      name: "Records Specialist",
      purpose: "Continuing records specialist.",
      continuingIdentity: true,
      durableMailbox: true,
      requiredCapabilities: ["messages"],
      aliases: [{ namespace: "resident", value: "jerry" }],
    }, ownerContext(51)),
    (error: unknown) =>
      error instanceof BotDirectoryError && error.code === "alias_collision",
  );
  await assert.rejects(
    directory.registerResident({
      context: residentContext("jerry", "resident-jerry-1", 1, 52),
      botBinding: "forrest",
      protocolVersion: 1,
      capabilities: ["messages"],
    }),
    (error: unknown) =>
      error instanceof BotDirectoryError &&
      error.code === "unauthorized_registration",
  );
  await assert.rejects(
    directory.registerResident({
      context: residentContext("jerry", "resident-jerry-1", 1, 53, "observer"),
      botBinding: "jerry",
      protocolVersion: 1,
      capabilities: ["messages"],
    }),
    (error: unknown) =>
      error instanceof BotDirectoryError &&
      error.code === "unauthorized_registration",
  );

  assert.equal(repository.bots.size, 2);
  assert.equal(
    (await directory.resolveAlias("resident", "jerry"))?.id,
    jerry.id,
  );
});

test("malformed aliases and storage identity collisions fail without partial publication", async () => {
  const repository = new TestBotDirectoryRepository();
  const clock = { now: new Date("2026-08-25T17:00:00.000Z") };
  const directory = service(repository, clock);

  await assert.rejects(
    directory.ensurePersistentBinding({
      ...JERRY,
      aliases: [{ namespace: "resident", value: 23 as unknown as string }],
    }, ownerContext(61)),
    (error: unknown) =>
      error instanceof BotDirectoryError && error.code === "request_invalid",
  );
  assert.equal(repository.bots.size, 0);

  repository.principals.add(BOT_IDS[0]);
  const collisionDirectory = service(repository, clock);
  await assert.rejects(
    collisionDirectory.ensurePersistentBinding(JERRY, ownerContext(62)),
    (error: unknown) =>
      error instanceof BotDirectoryError && error.code === "identity_collision",
  );
  assert.equal(repository.bots.size, 0);
  assert.equal(repository.aliases.size, 0);
  assert.deepEqual(repository.principals, new Set([BOT_IDS[0]]));
});
