import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  M31_CAPABILITY_ORDER,
  M31_CORE_BASE_SHA,
  M31PreflightError,
  runM31ActivationFixture,
  type M31ActivationFixture,
  type M31Capability,
} from "../../../src/coordination/rollout/index.js";

const hash = (character: string) => character.repeat(64);
const evidenceKinds = {
  unread: "missed_event_convergence",
  activity: "activity_provenance",
  search: "search_evidence_chain",
  attachments: "exact_hash_round_trip",
  channel: "cross_platform_channel_correlation",
} as const;

function fixture(capability: M31Capability, prior: M31ActivationFixture["priorCapabilityReceipt"] = null): M31ActivationFixture {
  const index = M31_CAPABILITY_ORDER.indexOf(capability);
  return {
    evidenceMode: "fixture",
    coreBaseSha: M31_CORE_BASE_SHA,
    capability,
    capturedAt: "2026-08-25T20:00:00.000Z",
    directMessaging: {
      stable: true,
      macReceiptDigest: hash("a"),
      iphoneReceiptDigest: hash("b"),
      observationWindow: { startedAt: "2026-08-24T20:00:00.000Z", endedAt: "2026-08-25T20:00:00.000Z" },
    },
    incidents: { openP0: 0, openP1: 0 },
    featureFlag: { key: `connected.${capability}.enabled`, before: false, after: false, independentKillSwitch: `disable-connected-${capability}` },
    authority: { capability, currentEpoch: 20 + index * 2, activationEpoch: 21 + index * 2, writer: `canonical-${capability}-writer` },
    watermarks: { source: 100 + index, destination: 100 + index },
    canary: { id: `fixture-${capability}-canary`, correlationId: `fixture-${capability}-correlation`, verdict: "passed", evidenceKind: evidenceKinds[capability], evidence: `synthetic ${evidenceKinds[capability]} evidence` },
    drift: { compared: 3, mismatches: 0, digest: hash(String(index + 1)) },
    rollback: { flagValue: false, targetEpoch: 22 + index * 2, targetWriter: `rollback-${capability}-writer`, directMessagingRemainsAvailable: true },
    priorCapabilityReceipt: prior,
  };
}

function chain(): ReturnType<typeof runM31ActivationFixture>[] {
  const receipts: ReturnType<typeof runM31ActivationFixture>[] = [];
  for (const capability of M31_CAPABILITY_ORDER) {
    const prior = receipts.at(-1);
    receipts.push(runM31ActivationFixture(fixture(capability, prior ? {
      capability: prior.capability,
      verdict: prior.verdict,
      receiptDigest: prior.receiptDigest,
    } : null)));
  }
  return receipts;
}

test("validates the exact five-capability order one fixture receipt at a time", () => {
  const receipts = chain();
  assert.deepEqual(receipts.map(({ capability }) => capability), ["unread", "activity", "search", "attachments", "channel"]);
  assert.deepEqual(receipts.map(({ sequence }) => sequence), [1, 2, 3, 4, 5]);
  assert.equal(new Set(receipts.map(({ receiptDigest }) => receiptDigest)).size, 5);
});

test("receipts stay feature-off and cannot claim authority, advertising, or live success", () => {
  for (const receipt of chain()) {
    assert.equal(receipt.evidenceMode, "fixture");
    assert.equal(receipt.liveActivationAttempted, false);
    assert.equal(receipt.liveSuccess, false);
    assert.equal(receipt.activationAuthorized, false);
    assert.equal(receipt.advertised, false);
    assert.equal(receipt.rollback.directMessagingRemainsAvailable, true);
  }
});

test("fails closed on skipped receipts, unstable direct messaging, incidents, or enabled flags", () => {
  const input = fixture("search", { capability: "unread", verdict: "fixture_ready_for_operator_review", receiptDigest: hash("c") });
  input.directMessaging.stable = false as true;
  input.incidents.openP1 = 1;
  input.featureFlag.after = true as false;
  assert.throws(() => runM31ActivationFixture(input), (error: unknown) => error instanceof M31PreflightError
    && ["direct_stable", "no_p0_p1", "feature_off", "sequential_receipt"].every((name) => error.failures.includes(name)));
});

test("requires exact epochs, converged watermarks, capability evidence, zero drift, and rollback target", () => {
  const input = fixture("unread");
  input.authority.activationEpoch += 1;
  input.watermarks.destination -= 1;
  input.canary.evidenceKind = "search_evidence_chain";
  input.drift.mismatches = 1 as 0;
  assert.throws(() => runM31ActivationFixture(input), (error: unknown) => error instanceof M31PreflightError
    && ["authority", "watermarks", "canary", "drift", "rollback"].every((name) => error.failures.includes(name)));
});

test("CLI explicitly refuses live mode before reading any fixture", () => {
  const result = spawnSync(process.execPath, ["scripts/coordination/m31-activation-preflight.mjs", "--live"], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /no live mode/);
});
