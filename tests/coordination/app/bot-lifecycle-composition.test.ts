import assert from "node:assert/strict";
import test from "node:test";

import {
  createCoordinationRuntimeComposition,
  disabledCoordinationFeatureFlags,
  type BotLifecycleCompositionOptions,
} from "../../../src/coordination/app/index.js";
import { classifyPolicy, type PolicyRequest } from "../../../src/coordination/policy/index.js";
import type {
  BotLifecycleReceipt,
  ProvisionedResident,
} from "../../../src/coordination/bot-lifecycle/index.js";

const auth = { validateAccessToken: async () => { throw new Error("unused"); } };
const enabledFlags = Object.freeze({
  ...disabledCoordinationFeatureFlags(),
  "coordination.process.enabled": true,
  "coordination.public_api.enabled": true,
  "coordination.bot_lifecycle.enabled": true,
});

function policy(operation: string, target: string, scope: "within" | "outside" = "within"): PolicyRequest {
  return {
    action: { actorPrincipalId: "user_owner", operation, target, parameters: {} },
    factSource: { kind: "trusted_policy_boundary", reference: "fixture:canonical-standing-scope" },
    standing: {
      scope,
      delegation: "within",
      budget: "within",
      audience: "within",
      allowlist: "within",
    },
    impactClasses: [],
    contextAccess: { kind: "none" },
  };
}

function fixture() {
  const receipts = new Map<string, BotLifecycleReceipt>();
  const residents = new Map<string, ProvisionedResident>();
  const processCalls: Array<{ operation: string; names: readonly string[] }> = [];
  const createSpecs: unknown[] = [];
  const options: BotLifecycleCompositionOptions = {
    enabled: true,
    canonicalWriter: "home23-core",
    authority: {
      enabled: () => true,
      currentEpoch: async () => ({
        capability: "bot_lifecycle", epoch: 7, mode: "canonical",
        writer: "home23-core", effectiveAtEventSequence: 41, rollbackEpoch: null,
      }),
      decide: (request) => classifyPolicy(request, new Date("2026-08-25T12:00:00.000Z")),
    },
    provisioner: {
      inspect: async (binding) => residents.get(binding) ?? null,
      create: async (spec) => {
        createSpecs.push(spec);
        const resident = Object.freeze({
          kind: "persistent_resident" as const,
          residentBinding: spec.residentBinding,
          instancePath: `/fixture/instances/${spec.residentBinding}`,
          processNames: Object.freeze([`home23-${spec.residentBinding}`]),
        });
        residents.set(spec.residentBinding, resident);
        return resident;
      },
      archivePartial: async () => undefined,
    },
    mailboxBinder: {
      bindAfterResidentCreated: async (input) => ({
        id: "bot_fixture", principalId: "bot_fixture", displayName: input.displayName,
        purpose: input.purpose, requiredCapabilities: input.requiredCapabilities,
        residentBinding: input.residentBinding, conversationId: "conversation_fixture",
        status: "active", createdAt: "2026-08-25T12:00:00.000Z",
        updatedAt: "2026-08-25T12:00:00.000Z", archivedAt: null,
      }),
      getByBotId: async () => null,
    },
    processes: {
      startExact: async (names) => { processCalls.push({ operation: "start", names }); },
      stopExact: async (names) => { processCalls.push({ operation: "stop", names }); },
      restartExact: async (names) => { processCalls.push({ operation: "restart", names }); },
    },
    receipts: {
      get: async (requestId) => receipts.get(requestId) ?? null,
      putIfAbsent: async (receipt) => {
        const prior = receipts.get(receipt.requestId);
        if (prior) return prior;
        receipts.set(receipt.requestId, receipt);
        return receipt;
      },
    },
    now: () => new Date("2026-08-25T12:00:00.000Z"),
  };
  return { options, receipts, processCalls, createSpecs };
}

function request(policyRequest = policy("bot_lifecycle.create", "helper")) {
  return {
    requestId: "request_fixture", correlationId: "correlation_fixture",
    actorPrincipalId: "user_owner" as const, residentBinding: "helper",
    displayName: "Helper", purpose: "Bounded help", requiredCapabilities: ["research"],
    policy: policyRequest, expectedAuthorityEpoch: 7,
  };
}

test("M28 stays absent and unadvertised unless every explicit activation condition is present", async () => {
  const f = fixture();
  for (const input of [
    { flags: disabledCoordinationFeatureFlags(), botLifecycle: f.options },
    { flags: enabledFlags, botLifecycle: { ...f.options, enabled: false as const } },
    { flags: enabledFlags, botLifecycle: undefined },
  ]) {
    const composition = await createCoordinationRuntimeComposition({
      flags: input.flags, services: { auth }, botLifecycle: input.botLifecycle as never,
    });
    assert.equal(composition.application.services.botLifecycle, undefined);
    assert.equal(composition.application.capabilities().capabilities.botLifecycle, false);
  }
  assert.equal(f.createSpecs.length, 0);
  assert.equal(f.processCalls.length, 0);
});

test("raw service smuggling is rejected and explicit composition remains internal-only", async () => {
  const f = fixture();
  const smuggled = await createCoordinationRuntimeComposition({
    flags: enabledFlags,
    services: { auth, botLifecycle: { create() {}, control() {} } } as never,
  });
  assert.equal(smuggled.application.services.botLifecycle, undefined);

  const composition = await createCoordinationRuntimeComposition({
    flags: enabledFlags, services: { auth }, botLifecycle: f.options,
  });
  assert.ok(composition.application.services.botLifecycle);
  assert.equal(composition.application.capabilities().capabilities.botLifecycle, false);
});

test("composed M28 denies noncanonical standing scope and exact-action mismatches before effects", async () => {
  const f = fixture();
  const composition = await createCoordinationRuntimeComposition({
    flags: enabledFlags, services: { auth }, botLifecycle: f.options,
  });
  const service = composition.application.services.botLifecycle!;
  await assert.rejects(service.create(request(policy("bot_lifecycle.create", "helper", "outside"))), {
    code: "standing_authority_denied",
  });
  await assert.rejects(service.create(request(policy("bot_lifecycle.start", "helper"))), {
    code: "standing_authority_denied",
  });
  await assert.rejects(service.create(request(policy("bot_lifecycle.create", "different-target"))), {
    code: "standing_authority_denied",
  });
  assert.equal(f.createSpecs.length, 0);
  assert.equal(f.processCalls.length, 0);
});

test("composed M28 rejects temporary hands, is idempotent, and never requests private-memory copying", async () => {
  const f = fixture();
  f.options.provisioner.inspect = async (binding) => binding === "temporary-hand" ? ({
    kind: "temporary_hand" as never, residentBinding: binding,
    instancePath: "/fixture/temporary", processNames: ["home23-temporary-hand"],
  }) : null;
  const composition = await createCoordinationRuntimeComposition({
    flags: enabledFlags, services: { auth }, botLifecycle: f.options,
  });
  const service = composition.application.services.botLifecycle!;
  await assert.rejects(service.create({
    ...request(policy("bot_lifecycle.create", "temporary-hand")),
    requestId: "request_temporary", residentBinding: "temporary-hand",
  }), { code: "process_manifest_invalid" });

  const first = await service.create(request());
  const replay = await service.create(request());
  assert.strictEqual(replay, first);
  assert.equal(f.receipts.size, 1);
  assert.equal(f.createSpecs.length, 1);
  assert.equal((f.createSpecs[0] as { copyPrivateMemory: unknown }).copyPrivateMemory, false);
  assert.equal(JSON.stringify(first).includes("private"), false);
});
