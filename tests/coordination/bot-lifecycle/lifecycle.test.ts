import assert from "node:assert/strict";
import test from "node:test";

import {
  BotLifecycleError,
  createBotLifecycleService,
  derivePersistentBotBinding,
  type BotLifecycleReceipt,
  type PersistentBotControlRequest,
  type PersistentBotCreateRequest,
} from "../../../src/coordination/bot-lifecycle/index.js";
import type { BotProjection } from "../../../src/coordination/bots/index.js";
import { classifyPolicy, type PolicyRequest } from "../../../src/coordination/policy/index.js";

const NOW = "2026-08-25T16:00:00.000Z";

function policy(operation: string, target: string): PolicyRequest {
  return {
    action: { actorPrincipalId: "user_owner", operation, target, parameters: {} },
    factSource: { kind: "trusted_policy_boundary", reference: "fixture:standing-scope" },
    standing: {
      scope: "within", delegation: "within", budget: "within",
      audience: "within", allowlist: "within",
    },
    impactClasses: [],
    contextAccess: { kind: "none" },
  };
}

function createRequest(overrides: Partial<PersistentBotCreateRequest> = {}): PersistentBotCreateRequest {
  const requestId = overrides.requestId ?? "request_create_fixture_bot";
  const displayName = overrides.displayName ?? "Fixture Bot";
  const target = derivePersistentBotBinding({ requestId, displayName });
  return {
    requestId,
    correlationId: "correlation_create_1",
    actorPrincipalId: "user_owner",
    displayName,
    purpose: "A durable lightweight specialist",
    expectedAuthorityEpoch: 7,
    policy: policy("bot_lifecycle.create", target),
    ...overrides,
  };
}

function controlRequest(
  operation: PersistentBotControlRequest["operation"],
  requestId: string,
): PersistentBotControlRequest {
  return {
    requestId,
    correlationId: `correlation_${requestId}`,
    actorPrincipalId: "user_owner",
    botId: "bot_fixture",
    operation,
    expectedAuthorityEpoch: 7,
    policy: policy(`bot_lifecycle.${operation}`, "bot_fixture"),
  };
}

function fixture(options: {
  failBind?: boolean;
  enabled?: boolean;
  bindProjection?: (bot: BotProjection) => BotProjection;
  transitionProjection?: (bot: BotProjection) => BotProjection;
} = {}) {
  const bots = new Map<string, BotProjection>();
  const receipts = new Map<string, BotLifecycleReceipt>();
  const bindCalls: string[] = [];
  const transitionCalls: string[] = [];
  const forbiddenEffects: string[] = [];
  const service = createBotLifecycleService({
    authority: {
      enabled: () => options.enabled ?? true,
      currentEpoch: async () => ({
        capability: "bot_lifecycle", epoch: 7, mode: "canonical",
        writer: "home23-coordination", effectiveAtEventSequence: 41, rollbackEpoch: 1,
      }),
      decide: (request) => classifyPolicy(request, new Date(NOW)),
    },
    mailboxBinder: {
      bindDurableBot: async (input) => {
        bindCalls.push(input.residentBinding);
        if (options.failBind) throw Object.assign(new Error("db unavailable"), { code: "db_unavailable" });
        const existing = [...bots.values()].find((bot) => bot.residentBinding === input.residentBinding);
        if (existing) return existing;
        const bot: BotProjection = {
          id: "bot_fixture",
          principalId: "bot_fixture",
          name: input.displayName,
          purpose: input.purpose,
          lifecycle: "active",
          availability: "offline",
          conversationId: "conversation_fixture",
          residentBinding: input.residentBinding,
          version: 1,
          createdAt: NOW,
          updatedAt: NOW,
        };
        const projected = options.bindProjection?.(bot) ?? bot;
        bots.set(projected.id, projected);
        return projected;
      },
      getByBotId: async (id) => bots.get(id) ?? null,
      transitionLifecycle: async (input) => {
        transitionCalls.push(`${input.from}->${input.to}`);
        const current = bots.get(input.botId);
        if (!current) throw Object.assign(new Error("not found"), { code: "bot_not_found" });
        const updated: BotProjection = {
          ...current,
          lifecycle: input.to,
          version: current.version + 1,
          updatedAt: input.changedAt,
        };
        const projected = options.transitionProjection?.(updated) ?? updated;
        bots.set(input.botId, projected);
        return projected;
      },
    },
    receipts: {
      get: async (id) => receipts.get(id) ?? null,
      putIfAbsent: async (receipt) => {
        const prior = receipts.get(receipt.requestId);
        if (prior) return prior;
        receipts.set(receipt.requestId, receipt);
        return receipt;
      },
    },
    canonicalWriter: "home23-coordination",
    now: () => new Date(NOW),
    // A legacy caller can still carry these properties at runtime. The new
    // service has no code path or type dependency capable of invoking them.
    provisioner: { create: async () => { forbiddenEffects.push("provision"); } },
    processes: { startExact: async () => { forbiddenEffects.push("start"); } },
  } as never);
  return { service, bots, receipts, bindCalls, transitionCalls, forbiddenEffects };
}

test("create derives a nonresident compatibility binding and idempotently creates one mailbox", async () => {
  const f = fixture();
  const request = createRequest() as PersistentBotCreateRequest & {
    residentBinding: string;
    requiredCapabilities: readonly string[];
  };
  request.residentBinding = "jerry";
  request.requiredCapabilities = ["process-control"];

  const first = await f.service.create(request);
  const replay = await f.service.create(request);

  assert.strictEqual(replay, first);
  assert.match(first.residentBinding!, /^bot-fixture-bot-[a-f0-9]{16}$/);
  assert.notEqual(first.residentBinding, request.residentBinding);
  assert.equal(first.botId, "bot_fixture");
  assert.equal(first.mailboxId, "conversation_fixture");
  assert.deepEqual(first.completedPhases, ["authorized", "mailbox_bound"]);
  assert.equal("processNames" in first, false);
  assert.equal(f.bindCalls.length, 1);
  assert.deepEqual(f.forbiddenEffects, []);
  await assert.rejects(
    f.service.create({ ...request, displayName: "Changed" }),
    { code: "request_id_conflict" },
  );
});

test("archive and restore retain the exact Bot and mailbox identity without process effects", async () => {
  const f = fixture();
  const created = await f.service.create(createRequest());
  const archived = await f.service.control(controlRequest("archive", "request_archive"));
  assert.equal(archived.botId, created.botId);
  assert.equal(archived.mailboxId, created.mailboxId);
  assert.equal(f.bots.get("bot_fixture")?.lifecycle, "archived");

  const restored = await f.service.control(controlRequest("restore", "request_restore"));
  assert.equal(restored.botId, created.botId);
  assert.equal(restored.mailboxId, created.mailboxId);
  assert.equal(f.bots.get("bot_fixture")?.lifecycle, "active");
  assert.deepEqual(f.transitionCalls, ["active->archived", "archived->active"]);
  assert.deepEqual(f.forbiddenEffects, []);
});

test("Jerry and Forrest are centrally protected from archive and restore", async () => {
  for (const [residentBinding, lifecycle, operation] of [
    ["jerry", "active", "archive"],
    ["forrest", "archived", "restore"],
  ] as const) {
    const f = fixture();
    f.bots.set("bot_fixture", {
      id: "bot_fixture",
      principalId: "bot_fixture",
      name: residentBinding === "jerry" ? "Jerry" : "Forrest",
      purpose: "Permanent house resident",
      lifecycle,
      availability: "offline",
      conversationId: "conversation_fixture",
      residentBinding,
      version: 1,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await assert.rejects(
      f.service.control(controlRequest(operation, `request_protect_${residentBinding}`)),
      { code: "permanent_resident_protected" },
    );
    assert.deepEqual(f.transitionCalls, []);
  }
});

test("create refuses an incoherent or non-active Bot projection", async () => {
  for (const bindProjection of [
    (bot: BotProjection): BotProjection => ({ ...bot, lifecycle: "provisioning" }),
    (bot: BotProjection): BotProjection => ({ ...bot, principalId: "bot_other" }),
    (bot: BotProjection): BotProjection => ({ ...bot, conversationId: null }),
    (bot: BotProjection): BotProjection => ({ ...bot, residentBinding: "jerry" }),
  ]) {
    const f = fixture({ bindProjection });
    await assert.rejects(f.service.create(createRequest()), (error: unknown) => {
      assert.ok(error instanceof BotLifecycleError);
      assert.equal(error.code, "operation_failed");
      assert.equal((error.receipt as BotLifecycleReceipt).failure?.code, "invalid_durable_binding");
      return true;
    });
  }
});

test("archive refuses a transition projection that changes lifecycle or durable identity", async () => {
  for (const transitionProjection of [
    (bot: BotProjection): BotProjection => ({ ...bot, lifecycle: "active" }),
    (bot: BotProjection): BotProjection => ({ ...bot, principalId: "bot_other" }),
    (bot: BotProjection): BotProjection => ({ ...bot, conversationId: "conversation_other" }),
    (bot: BotProjection): BotProjection => ({ ...bot, residentBinding: "bot-other" }),
  ]) {
    const f = fixture({ transitionProjection });
    await f.service.create(createRequest());
    await assert.rejects(
      f.service.control(controlRequest("archive", `request_bad_transition_${f.transitionCalls.length}`)),
      (error: unknown) => {
        assert.ok(error instanceof BotLifecycleError);
        assert.equal(error.code, "operation_failed");
        assert.equal((error.receipt as BotLifecycleReceipt).failure?.code, "invalid_durable_binding");
        return true;
      },
    );
  }
});

test("daemon controls fail closed even when an internal caller bypasses TypeScript", async () => {
  const f = fixture();
  await f.service.create(createRequest());
  for (const operation of ["start", "stop", "restart"]) {
    await assert.rejects(
      f.service.control({ ...controlRequest("archive", `request_${operation}`), operation } as never),
      { code: "request_invalid" },
    );
  }
  assert.deepEqual(f.transitionCalls, []);
  assert.deepEqual(f.forbiddenEffects, []);
});

test("binding failure is retry-safe and contains no resident cleanup fiction", async () => {
  const f = fixture({ failBind: true });
  await assert.rejects(f.service.create(createRequest()), (error: unknown) => {
    assert.ok(error instanceof BotLifecycleError);
    assert.equal(error.code, "operation_failed");
    const receipt = error.receipt as BotLifecycleReceipt;
    assert.deepEqual(receipt.failure, { phase: "mailbox_bind", code: "db_unavailable" });
    assert.equal("processNames" in receipt, false);
    return true;
  });
  assert.equal((await f.service.create(createRequest())).outcome, "failed");
  assert.equal(f.bindCalls.length, 1);
});

test("feature, epoch, and exact Core-derived policy target fail closed", async () => {
  const disabled = fixture({ enabled: false });
  await assert.rejects(disabled.service.create(createRequest()), { code: "capability_disabled" });

  const f = fixture();
  await assert.rejects(
    f.service.create(createRequest({ expectedAuthorityEpoch: 6 })),
    { code: "authority_epoch_mismatch" },
  );
  await assert.rejects(
    f.service.create(createRequest({ policy: policy("bot_lifecycle.create", "jerry") })),
    { code: "standing_authority_denied" },
  );
  assert.equal(f.bindCalls.length, 0);
});
