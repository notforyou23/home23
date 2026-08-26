import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  BotLifecycleError,
  createBotLifecycleService,
  type BotLifecycleReceipt,
  type PersistentBotControlRequest,
  type PersistentBotCreateRequest,
  type ProvisionedResident,
  type ResidentCreateSpec,
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
  return {
    requestId: "request_create_1", correlationId: "correlation_create_1",
    actorPrincipalId: "user_owner", residentBinding: "fixture-bot",
    displayName: "Fixture Bot", purpose: "A disposable persistent specialist",
    requiredCapabilities: ["chat"], expectedAuthorityEpoch: 7,
    policy: policy("bot_lifecycle.create", "fixture-bot"), ...overrides,
  };
}

function controlRequest(
  operation: PersistentBotControlRequest["operation"],
  requestId: string,
): PersistentBotControlRequest {
  return {
    requestId, correlationId: `correlation_${requestId}`, actorPrincipalId: "user_owner",
    botId: "bot_fixture", operation, expectedAuthorityEpoch: 7,
    policy: policy(`bot_lifecycle.${operation}`, "bot_fixture"),
  };
}

async function fixture(options: { failMailbox?: boolean; enabled?: boolean; mode?: "legacy" | "canonical" } = {}) {
  const root = await mkdtemp(join(tmpdir(), "home23-m28-"));
  const residents = new Map<string, ProvisionedResident>();
  const bots = new Map<string, BotProjection>();
  const receipts = new Map<string, BotLifecycleReceipt>();
  const processCalls: Array<{ operation: string; names: readonly string[] }> = [];
  const archived: string[] = [];
  let createCalls = 0;

  const service = createBotLifecycleService({
    authority: {
      enabled: () => options.enabled ?? true,
      currentEpoch: async () => ({
        capability: "bot_lifecycle", epoch: 7, mode: options.mode ?? "canonical",
        writer: "home23-coordination", effectiveAtEventSequence: 41, rollbackEpoch: 1,
      }),
      decide: (request) => classifyPolicy(request, new Date(NOW)),
    },
    provisioner: {
      inspect: async (binding) => residents.get(binding) ?? null,
      create: async (spec: ResidentCreateSpec) => {
        createCalls += 1;
        assert.equal(spec.copyPrivateMemory, false);
        const instancePath = join(root, "instances", spec.residentBinding);
        await mkdir(instancePath, { recursive: true });
        await writeFile(join(instancePath, "config.json"), JSON.stringify({
          residentBinding: spec.residentBinding, continuingIdentity: true,
        }));
        const resident: ProvisionedResident = {
          kind: "persistent_resident", residentBinding: spec.residentBinding, instancePath,
          processNames: [
            `home23-${spec.residentBinding}`,
            `home23-${spec.residentBinding}-dash`,
            `home23-${spec.residentBinding}-harness`,
          ],
        };
        residents.set(spec.residentBinding, resident);
        return resident;
      },
      archivePartial: async (resident) => {
        const archivePath = `${resident.instancePath}.partial-archive`;
        await rename(resident.instancePath, archivePath);
        archived.push(archivePath);
        residents.delete(resident.residentBinding);
      },
    },
    mailboxBinder: {
      bindAfterResidentCreated: async (input) => {
        if (options.failMailbox) throw Object.assign(new Error("db unavailable"), { code: "db_unavailable" });
        const existing = [...bots.values()].find((bot) => bot.residentBinding === input.residentBinding);
        if (existing) return existing;
        const bot: BotProjection = {
          id: "bot_fixture", principalId: "bot_fixture", name: input.displayName,
          purpose: input.purpose, lifecycle: "active", availability: "offline",
          conversationId: "conversation_fixture", residentBinding: input.residentBinding,
          version: 1, createdAt: NOW, updatedAt: NOW,
        };
        bots.set(bot.id, bot);
        return bot;
      },
      getByBotId: async (id) => bots.get(id) ?? null,
      transitionLifecycle: async (input) => {
        const current = bots.get(input.botId);
        if (!current) throw Object.assign(new Error("bot_not_found"), { code: "bot_not_found" });
        if (current.lifecycle !== input.from && current.lifecycle !== input.to) {
          throw Object.assign(new Error("lifecycle_conflict"), { code: "lifecycle_conflict" });
        }
        const updated = { ...current, lifecycle: input.to, version: current.version + 1, updatedAt: input.changedAt };
        bots.set(input.botId, updated);
        return updated;
      },
    },
    processes: {
      startExact: async (names) => { processCalls.push({ operation: "start", names: [...names] }); },
      stopExact: async (names) => { processCalls.push({ operation: "stop", names: [...names] }); },
      restartExact: async (names) => { processCalls.push({ operation: "restart", names: [...names] }); },
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
  });
  return { root, service, residents, bots, receipts, processCalls, archived, createCalls: () => createCalls };
}

test("disposable create is idempotent and binds mailbox only after CLI-shaped resident files exist", async () => {
  const f = await fixture();
  const first = await f.service.create(createRequest());
  const duplicate = await f.service.create(createRequest());
  assert.deepEqual(duplicate, first);
  assert.equal(f.createCalls(), 1);
  assert.equal(first.botId, "bot_fixture");
  assert.equal(first.mailboxId, "conversation_fixture");
  assert.deepEqual(first.completedPhases, ["authorized", "resident_created", "mailbox_bound"]);
  const config = JSON.parse(await readFile(join(f.root, "instances/fixture-bot/config.json"), "utf8"));
  assert.equal(config.continuingIdentity, true);
  await assert.rejects(f.service.create(createRequest({ displayName: "Changed" })), {
    code: "request_id_conflict",
  });
});

test("exact-name stop/start/restart preserves stable Bot ID and mailbox", async () => {
  const f = await fixture();
  const created = await f.service.create(createRequest());
  for (const [operation, requestId] of [["stop", "request_stop"], ["start", "request_start"], ["restart", "request_restart"]] as const) {
    const receipt = await f.service.control(controlRequest(operation, requestId));
    assert.equal(receipt.botId, created.botId);
    assert.equal(receipt.mailboxId, created.mailboxId);
  }
  assert.deepEqual(f.processCalls.map((call) => call.operation), ["stop", "start", "restart"]);
  assert.ok(f.processCalls.every((call) => call.names.every((name) => name.startsWith("home23-fixture-bot"))));
  assert.equal(f.bots.get("bot_fixture")?.conversationId, "conversation_fixture");
});

test("archive and restore are authorized, idempotent, and preserve stable transcript identity", async () => {
  const f = await fixture();
  const created = await f.service.create(createRequest());
  const archived = await f.service.control(controlRequest("archive", "request_archive"));
  assert.equal(archived.mailboxId, created.mailboxId);
  assert.equal(f.bots.get(created.botId!)?.lifecycle, "archived");
  assert.deepEqual(f.processCalls.map((call) => call.operation), ["stop"]);
  assert.deepEqual(await f.service.control(controlRequest("archive", "request_archive")), archived);

  const restored = await f.service.control(controlRequest("restore", "request_restore"));
  assert.equal(restored.mailboxId, created.mailboxId);
  assert.equal(f.bots.get(created.botId!)?.lifecycle, "active");
  assert.deepEqual(f.processCalls.map((call) => call.operation), ["stop", "start"]);
});

test("mailbox failure archives partial resident and records a retry-safe failure receipt", async () => {
  const f = await fixture({ failMailbox: true });
  await assert.rejects(f.service.create(createRequest()), (error: unknown) => {
    assert.ok(error instanceof BotLifecycleError);
    assert.equal(error.code, "operation_failed");
    const receipt = error.receipt as BotLifecycleReceipt;
    assert.deepEqual(receipt.failure, {
      phase: "mailbox_bind", code: "db_unavailable", partialResidentArchived: true,
    });
    return true;
  });
  assert.equal(f.archived.length, 1);
  const retry = await f.service.create(createRequest());
  assert.equal(retry.outcome, "failed");
  assert.equal(f.createCalls(), 1);
});

test("feature, epoch, standing scope, exact action, and temporary-hand boundaries fail closed", async () => {
  const disabled = await fixture({ enabled: false });
  await assert.rejects(disabled.service.create(createRequest()), { code: "capability_disabled" });

  const legacy = await fixture({ mode: "legacy" });
  await assert.rejects(legacy.service.create(createRequest()), { code: "authority_unavailable" });

  const f = await fixture();
  await assert.rejects(f.service.create(createRequest({ expectedAuthorityEpoch: 6 })), { code: "authority_epoch_mismatch" });
  const baseOutside = policy("bot_lifecycle.create", "fixture-bot");
  const outside: PolicyRequest = {
    ...baseOutside,
    standing: { ...baseOutside.standing, scope: "outside" },
  };
  await assert.rejects(f.service.create(createRequest({ policy: outside })), { code: "standing_authority_denied" });
  await assert.rejects(f.service.create(createRequest({
    policy: policy("bot_lifecycle.start", "fixture-bot"),
  })), { code: "standing_authority_denied" });

  f.residents.set("temporary-hand", {
    kind: "temporary_hand" as never, residentBinding: "temporary-hand", instancePath: join(f.root, "tmp"),
    processNames: ["home23-temporary-hand"],
  });
  await assert.rejects(f.service.create(createRequest({
    requestId: "request_temp", correlationId: "correlation_temp", residentBinding: "temporary-hand",
    policy: policy("bot_lifecycle.create", "temporary-hand"),
  })), { code: "process_manifest_invalid" });
  assert.equal(f.bots.size, 0);
});

test("process manifest rejects broad or adjacent resident controls", async () => {
  const f = await fixture();
  await f.service.create(createRequest());
  const resident = f.residents.get("fixture-bot")!;
  f.residents.set("fixture-bot", { ...resident, processNames: ["home23-other-bot"] });
  await assert.rejects(f.service.control(controlRequest("stop", "request_bad_manifest")), {
    code: "process_manifest_invalid",
  });
  assert.equal(f.processCalls.length, 0);
});
