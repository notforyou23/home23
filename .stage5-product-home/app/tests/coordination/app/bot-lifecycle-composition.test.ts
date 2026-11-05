import assert from "node:assert/strict";
import test from "node:test";

import {
  createCoordinationRuntimeComposition,
  disabledCoordinationFeatureFlags,
  type BotLifecycleCompositionOptions,
} from "../../../src/coordination/app/index.js";
import { classifyPolicy, type PolicyRequest } from "../../../src/coordination/policy/index.js";
import type { BotLifecycleReceipt } from "../../../src/coordination/bot-lifecycle/index.js";
import type { BotProjection } from "../../../src/coordination/bots/index.js";

const auth = { validateAccessToken: async () => { throw new Error("unused"); } };
const enabledFlags = Object.freeze({
  ...disabledCoordinationFeatureFlags(),
  "coordination.process.enabled": true,
  "coordination.public_api.enabled": true,
  "coordination.bot_lifecycle.enabled": true,
});

function policy(operation: string, target: string): PolicyRequest {
  return {
    action: { actorPrincipalId: "user_owner", operation, target, parameters: {} },
    factSource: { kind: "trusted_policy_boundary", reference: "fixture:canonical-standing-scope" },
    standing: {
      scope: "within", delegation: "within", budget: "within",
      audience: "within", allowlist: "within",
    },
    impactClasses: [],
    contextAccess: { kind: "none" },
  };
}

function fixture() {
  const receipts = new Map<string, BotLifecycleReceipt>();
  const bots = new Map<string, BotProjection>();
  const bindings: string[] = [];
  const policyTargets: string[] = [];
  const options: BotLifecycleCompositionOptions = {
    enabled: true,
    resolveHttpPolicy: ({ operation, target }) => {
      policyTargets.push(target);
      return policy(`bot_lifecycle.${operation}`, target);
    },
    canonicalWriter: "home23-core",
    authority: {
      enabled: () => true,
      currentEpoch: async () => ({
        capability: "bot_lifecycle", epoch: 7, mode: "canonical",
        writer: "home23-core", effectiveAtEventSequence: 41, rollbackEpoch: null,
      }),
      decide: (request) => classifyPolicy(request, new Date("2026-08-25T12:00:00.000Z")),
    },
    mailboxBinder: {
      bindDurableBot: async (input) => {
        bindings.push(input.residentBinding);
        const bot: BotProjection = {
          id: "bot_fixture",
          principalId: "bot_fixture",
          name: input.displayName,
          purpose: input.purpose,
          residentBinding: input.residentBinding,
          conversationId: "conversation_fixture",
          lifecycle: "active",
          availability: "offline",
          version: 1,
          createdAt: "2026-08-25T12:00:00.000Z",
          updatedAt: "2026-08-25T12:00:00.000Z",
        };
        bots.set(bot.id, bot);
        return bot;
      },
      getByBotId: async (id) => bots.get(id) ?? null,
      transitionLifecycle: async (input) => {
        const bot = bots.get(input.botId)!;
        const updated = { ...bot, lifecycle: input.to, updatedAt: input.changedAt };
        bots.set(input.botId, updated);
        return updated;
      },
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
  return { options, receipts, bindings, policyTargets };
}

test("lifecycle stays absent unless every explicit activation condition is present", async () => {
  const f = fixture();
  for (const input of [
    { flags: disabledCoordinationFeatureFlags(), botLifecycle: f.options },
    { flags: enabledFlags, botLifecycle: { ...f.options, enabled: false as const } },
    { flags: enabledFlags, botLifecycle: undefined },
  ]) {
    const composition = await createCoordinationRuntimeComposition({
      flags: input.flags,
      services: { auth },
      botLifecycle: input.botLifecycle as never,
    });
    assert.equal(composition.application.services.botLifecycle, undefined);
    assert.equal(composition.application.capabilities().capabilities.botLifecycle, false);
  }
  assert.deepEqual(f.bindings, []);
});

test("explicit composition derives the stable compatibility binding inside Core", async () => {
  const f = fixture();
  const composition = await createCoordinationRuntimeComposition({
    flags: enabledFlags,
    services: { auth },
    botLifecycle: f.options,
  });
  const receipt = await composition.application.services.botLifecycleApi!.create({
    context: { correlationId: "correlation_fixture" } as never,
    idempotencyKey: "apple-create-specialist-0001",
    displayName: "Ada's Böt",
    purpose: "Bounded help",
  });
  assert.match(receipt.residentBinding!, /^bot-ada-s-bot-[a-f0-9]{16}$/);
  assert.deepEqual(f.policyTargets, [receipt.residentBinding]);
  assert.deepEqual(f.bindings, [receipt.residentBinding]);
  assert.equal("processNames" in receipt, false);
});

test("raw lifecycle service smuggling remains rejected", async () => {
  const composition = await createCoordinationRuntimeComposition({
    flags: enabledFlags,
    services: { auth, botLifecycle: { create() {}, control() {} } } as never,
  });
  assert.equal(composition.application.services.botLifecycle, undefined);
  assert.equal(composition.application.services.botLifecycleApi, undefined);
});
