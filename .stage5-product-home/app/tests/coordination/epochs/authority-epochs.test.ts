import assert from "node:assert/strict";
import {
  generateKeyPairSync,
  sign as signEd25519,
  verify as verifyEd25519,
} from "node:crypto";
import test from "node:test";

import {
  authorityReceiptSigningPayload,
  planAuthorityRollback,
  validateAuthorityEpochTransition,
  validateInitialAuthorityEpoch,
  type AuthorityEpoch,
  type AuthorityReceiptSignature,
  type AuthorityRolloutReceipt,
  type UnsignedAuthorityRolloutReceipt,
} from "../../../src/coordination/epochs/index.js";
import { sha256 } from "../../../src/coordination/import/index.js";

const LEGACY: AuthorityEpoch = {
  capability: "messages",
  epoch: 1,
  mode: "legacy",
  writer: "legacy-jsonl",
  effectiveAtEventSequence: null,
  rollbackEpoch: null,
};

const SHADOW: AuthorityEpoch = {
  capability: "messages",
  epoch: 2,
  mode: "shadow",
  writer: "legacy-jsonl",
  effectiveAtEventSequence: null,
  rollbackEpoch: null,
};

const CANONICAL: AuthorityEpoch = {
  capability: "messages",
  epoch: 3,
  mode: "canonical",
  writer: "home23-coordination",
  effectiveAtEventSequence: 120,
  rollbackEpoch: 1,
};

const ROLLED_BACK: AuthorityEpoch = {
  capability: "messages",
  epoch: 4,
  mode: "legacy",
  writer: "legacy-jsonl",
  effectiveAtEventSequence: 144,
  rollbackEpoch: 1,
};

const RESHADOW: AuthorityEpoch = {
  capability: "messages",
  epoch: 5,
  mode: "shadow",
  writer: "legacy-jsonl",
  effectiveAtEventSequence: null,
  rollbackEpoch: null,
};

const SIGNATURE_KEY = "operator-key-1";

function sign(unsigned: UnsignedAuthorityRolloutReceipt): AuthorityRolloutReceipt {
  const signature: AuthorityReceiptSignature = {
    algorithm: "ed25519",
    keyId: SIGNATURE_KEY,
    value: sha256(authorityReceiptSigningPayload(unsigned)),
  };
  return { ...unsigned, signature };
}

function verify(payload: string, signature: AuthorityReceiptSignature): boolean {
  return signature.keyId === SIGNATURE_KEY && signature.value === sha256(payload);
}

function receipt(
  current: AuthorityEpoch,
  proposed: AuthorityEpoch,
  overrides: Partial<UnsignedAuthorityRolloutReceipt> = {},
): AuthorityRolloutReceipt {
  return sign({
    receiptVersion: 1,
    capability: proposed.capability,
    fromEpoch: current.epoch,
    toEpoch: proposed.epoch,
    fromAuthority: { mode: current.mode, writer: current.writer },
    toAuthority: { mode: proposed.mode, writer: proposed.writer },
    sourceWatermark: {
      sourceId: "legacy_0198d95f-6c00-7000-8000-000000000091",
      segmentIdentity: "segment-a",
      recordIndex: 24,
      byteOffset: 2048,
      tailDigest: "1".repeat(64),
    },
    destinationWatermark: {
      eventSequence: proposed.effectiveAtEventSequence ?? 120,
      messageCount: 24,
      orderedDigest: "2".repeat(64),
    },
    samePathCanary: {
      operationId: "listChannelMessages",
      route: "/api/v1/channels/chn_0198d95f-6c00-7000-8000-000000000022/messages",
      requestDigest: "3".repeat(64),
      passed: true,
    },
    driftCount: 0,
    activeFlags: {
      "coordination.process.enabled": proposed.mode === "canonical",
      "coordination.public_api.enabled": proposed.mode === "canonical",
      "coordination.resident.jerry.enabled": false,
      "coordination.resident.forrest.enabled": false,
      "coordination.channels.enabled": false,
      "coordination.import.shadow_enabled": proposed.mode === "shadow",
      "coordination.search.canonical": false,
      "coordination.apple.mac_cutover": false,
      "coordination.apple.iphone_cutover": false,
      "coordination.bot_lifecycle.enabled": false,
      "coordination.compaction.enabled": false,
    },
    rollbackTarget: proposed.rollbackEpoch,
    operator: "user_owner",
    effectiveAtEventSequence: proposed.effectiveAtEventSequence,
    legacyWriterDisposition: proposed.mode === "canonical"
      ? "disabled"
      : proposed.mode === "shadow"
        ? "unchanged_authoritative"
        : "restored_authoritative",
    issuedAt: "2026-08-25T12:00:00.000Z",
    ...overrides,
  });
}

test("initial authority permits the M02 legacy and shadow shapes but never canonical", () => {
  assert.deepEqual(validateInitialAuthorityEpoch(LEGACY), { decision: "valid" });
  assert.deepEqual(validateInitialAuthorityEpoch({ ...LEGACY, mode: "shadow" }), {
    decision: "valid",
  });
  assert.deepEqual(validateInitialAuthorityEpoch({ ...LEGACY, mode: "canonical" }), {
    decision: "denied",
    reason: "initial_epoch_must_be_legacy",
  });
});

test("legacy-to-shadow keeps the legacy writer and has no rollback target", () => {
  const result = validateAuthorityEpochTransition({
    current: LEGACY,
    proposed: SHADOW,
    history: [LEGACY],
    receipt: receipt(LEGACY, SHADOW),
    activeCanonicalWriters: [],
    verifySignature: verify,
  });
  assert.equal(result.decision, "valid");
});

test("a signed shadow-to-canonical receipt validates without applying the flip", () => {
  const rollout = receipt(SHADOW, CANONICAL);
  const result = validateAuthorityEpochTransition({
    current: SHADOW,
    proposed: CANONICAL,
    history: [LEGACY, SHADOW],
    receipt: rollout,
    activeCanonicalWriters: [],
    verifySignature: verify,
  });

  assert.equal(result.decision, "valid");
  assert.match(result.transitionDigest ?? "", /^[a-f0-9]{64}$/);
  assert.match(result.receiptDigest ?? "", /^[a-f0-9]{64}$/);
  assert.deepEqual(SHADOW, {
    capability: "messages",
    epoch: 2,
    mode: "shadow",
    writer: "legacy-jsonl",
    effectiveAtEventSequence: null,
    rollbackEpoch: null,
  });
});

test("canonical labels and flags cannot authorize a transition without a signed receipt", () => {
  const result = validateAuthorityEpochTransition({
    current: SHADOW,
    proposed: CANONICAL,
    history: [LEGACY, SHADOW],
    receipt: undefined as never,
    activeCanonicalWriters: [],
    verifySignature: () => true,
  });

  assert.deepEqual(result, { decision: "denied", reason: "receipt_signature_missing" });
  assert.equal(SHADOW.mode, "shadow");
  assert.equal(CANONICAL.mode, "canonical");
});

test("a real Ed25519 operator signature authorizes only its exact receipt payload", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const fakeSigned = receipt(SHADOW, CANONICAL);
  const { signature: _signature, ...unsigned } = fakeSigned;
  const payload = authorityReceiptSigningPayload(unsigned);
  const rollout: AuthorityRolloutReceipt = {
    ...unsigned,
    signature: {
      algorithm: "ed25519",
      keyId: "operator-ed25519-1",
      value: signEd25519(null, Buffer.from(payload, "utf8"), privateKey).toString("base64"),
    },
  };
  const result = validateAuthorityEpochTransition({
    current: SHADOW,
    proposed: CANONICAL,
    history: [LEGACY, SHADOW],
    receipt: rollout,
    activeCanonicalWriters: [],
    verifySignature: (signingPayload, signature) => verifyEd25519(
      null,
      Buffer.from(signingPayload, "utf8"),
      publicKey,
      Buffer.from(signature.value, "base64"),
    ),
  });

  assert.equal(result.decision, "valid");
  assert.equal(validateAuthorityEpochTransition({
    current: SHADOW,
    proposed: { ...CANONICAL, writer: "label-only-writer" },
    history: [LEGACY, SHADOW],
    receipt: rollout,
    activeCanonicalWriters: [],
    verifySignature: () => true,
  }).decision, "denied");
});

test("an invalid authority transition is denied before signature can authorize it", () => {
  const illegal = { ...CANONICAL, epoch: 2, rollbackEpoch: 1 };
  let verificationCalls = 0;
  const result = validateAuthorityEpochTransition({
    current: LEGACY,
    proposed: illegal,
    history: [LEGACY],
    receipt: receipt(LEGACY, illegal),
    activeCanonicalWriters: [],
    verifySignature: () => {
      verificationCalls += 1;
      return true;
    },
  });

  assert.deepEqual(result, { decision: "denied", reason: "illegal_transition" });
  assert.equal(verificationCalls, 0);
});

test("canonical authority requires zero drift, a canary, stopped legacy writes, and one writer", () => {
  const cases: Array<{
    name: string;
    rollout: AuthorityRolloutReceipt;
    activeCanonicalWriters?: readonly string[];
    reason: string;
  }> = [
    {
      name: "drift",
      rollout: receipt(SHADOW, CANONICAL, { driftCount: 1 }),
      reason: "canonical_drift_present",
    },
    {
      name: "canary",
      rollout: receipt(SHADOW, CANONICAL, {
        samePathCanary: {
          operationId: "listChannelMessages",
          route: "/api/v1/channels/chn_0198d95f-6c00-7000-8000-000000000022/messages",
          requestDigest: "3".repeat(64),
          passed: false,
        },
      }),
      reason: "same_path_canary_failed",
    },
    {
      name: "legacy writer",
      rollout: receipt(SHADOW, CANONICAL, { legacyWriterDisposition: "unchanged_authoritative" }),
      reason: "legacy_writer_still_independent",
    },
    {
      name: "dual writer",
      rollout: receipt(SHADOW, CANONICAL),
      activeCanonicalWriters: ["other-coordination-writer"],
      reason: "dual_canonical_writer",
    },
  ];

  for (const item of cases) {
    const result = validateAuthorityEpochTransition({
      current: SHADOW,
      proposed: CANONICAL,
      history: [LEGACY, SHADOW],
      receipt: item.rollout,
      activeCanonicalWriters: item.activeCanonicalWriters ?? [],
      verifySignature: verify,
    });
    assert.equal(result.decision, "denied", item.name);
    assert.equal(result.reason, item.reason, item.name);
  }
});

test("epoch receipts reject invented routes, flags, stale history, and uncrossed watermarks", () => {
  const base = receipt(SHADOW, CANONICAL);
  const cases = [
    {
      rollout: receipt(SHADOW, CANONICAL, {
        samePathCanary: { ...base.samePathCanary, route: "/api/v1/invented/messages" },
      }),
      history: [LEGACY, SHADOW],
      reason: "same_path_canary_invalid",
    },
    {
      rollout: receipt(SHADOW, CANONICAL, {
        activeFlags: { ...base.activeFlags, inventedFlag: true },
      }),
      history: [LEGACY, SHADOW],
      reason: "active_flags_invalid",
    },
    {
      rollout: receipt(SHADOW, CANONICAL, {
        destinationWatermark: { ...base.destinationWatermark, eventSequence: 119 },
      }),
      history: [LEGACY, SHADOW],
      reason: "destination_watermark_before_effective_epoch",
    },
    {
      rollout: base,
      history: [LEGACY, SHADOW, { ...CANONICAL, epoch: 4 }],
      reason: "current_epoch_not_latest",
    },
  ];

  for (const item of cases) {
    const result = validateAuthorityEpochTransition({
      current: SHADOW,
      proposed: CANONICAL,
      history: item.history,
      receipt: item.rollout,
      activeCanonicalWriters: [],
      verifySignature: verify,
    });
    assert.equal(result.decision, "denied");
    assert.equal(result.reason, item.reason);
  }
});

test("an unsigned, invalidly signed, or transition-unbound receipt is denied", () => {
  const valid = receipt(SHADOW, CANONICAL);
  const cases = [
    {
      receipt: { ...valid, signature: undefined } as never,
      verifier: verify,
      reason: "receipt_signature_missing",
    },
    {
      receipt: valid,
      verifier: () => false,
      reason: "receipt_signature_invalid",
    },
    {
      receipt: receipt(SHADOW, CANONICAL, { toEpoch: 99 }),
      verifier: verify,
      reason: "receipt_transition_mismatch",
    },
  ];

  for (const item of cases) {
    const result = validateAuthorityEpochTransition({
      current: SHADOW,
      proposed: CANONICAL,
      history: [LEGACY, SHADOW],
      receipt: item.receipt,
      activeCanonicalWriters: [],
      verifySignature: item.verifier,
    });
    assert.equal(result.decision, "denied");
    assert.equal(result.reason, item.reason);
  }
});

test("a signed receipt cannot be replayed for a different canonical writer", () => {
  const result = validateAuthorityEpochTransition({
    current: SHADOW,
    proposed: { ...CANONICAL, writer: "alternate-coordination-writer" },
    history: [LEGACY, SHADOW],
    receipt: receipt(SHADOW, CANONICAL),
    activeCanonicalWriters: [],
    verifySignature: verify,
  });

  assert.deepEqual(result, { decision: "denied", reason: "receipt_transition_mismatch" });
});

test("rollback appends a new legacy epoch and preserves both source histories", () => {
  const rollback = planAuthorityRollback({
    current: CANONICAL,
    rollbackTarget: LEGACY,
    history: [LEGACY, SHADOW, CANONICAL],
    effectiveAtEventSequence: 144,
  });

  assert.deepEqual(rollback.proposedEpoch, {
    capability: "messages",
    epoch: 4,
    mode: "legacy",
    writer: "legacy-jsonl",
    effectiveAtEventSequence: 144,
    rollbackEpoch: 1,
  });
  assert.equal(rollback.legacySource.action, "preserve_read_only");
  assert.equal(rollback.legacySource.overwriteAllowed, false);
  assert.equal(rollback.legacySource.appendAllowed, false);
  assert.equal(rollback.canonicalHistory.action, "preserve_read_only");
  assert.equal(rollback.historyMutation, "append_new_epoch_only");
  assert.equal(rollback.steps.includes("identify_missing_suffix_without_writing_legacy_source"), true);
  assert.equal(
    rollback.steps.some((step) => step.includes("export_missing_canonical_suffix")),
    false,
  );

  const result = validateAuthorityEpochTransition({
    current: CANONICAL,
    proposed: rollback.proposedEpoch,
    history: [LEGACY, SHADOW, CANONICAL],
    receipt: receipt(CANONICAL, rollback.proposedEpoch),
    activeCanonicalWriters: ["home23-coordination"],
    verifySignature: verify,
  });
  assert.equal(result.decision, "valid");
});

test("authority transitions reject mode-incoherent event boundaries", () => {
  const shadowWithBoundary: AuthorityEpoch = {
    ...SHADOW,
    effectiveAtEventSequence: 1,
  };
  const rollbackWithoutBoundary: AuthorityEpoch = {
    ...CANONICAL,
    epoch: 4,
    mode: "legacy",
    writer: LEGACY.writer,
    effectiveAtEventSequence: null,
  };
  const rollbackBeforeCanonical: AuthorityEpoch = {
    ...rollbackWithoutBoundary,
    effectiveAtEventSequence: 119,
  };
  const rollbackBeyondDestination: AuthorityEpoch = {
    ...rollbackWithoutBoundary,
    effectiveAtEventSequence: 144,
  };
  const rollbackAfterReshadow: AuthorityEpoch = {
    ...ROLLED_BACK,
    epoch: 6,
    effectiveAtEventSequence: 1,
    rollbackEpoch: ROLLED_BACK.epoch,
  };
  const canonicalAfterReshadow: AuthorityEpoch = {
    ...CANONICAL,
    epoch: 6,
    effectiveAtEventSequence: 1,
    rollbackEpoch: ROLLED_BACK.epoch,
  };
  const cases = [
    {
      name: "shadow cutover",
      current: LEGACY,
      proposed: shadowWithBoundary,
      history: [LEGACY],
      rollout: receipt(LEGACY, shadowWithBoundary),
      reason: "invalid_epoch_record",
    },
    {
      name: "missing rollback boundary",
      current: CANONICAL,
      proposed: rollbackWithoutBoundary,
      history: [LEGACY, SHADOW, CANONICAL],
      rollout: receipt(CANONICAL, rollbackWithoutBoundary),
      reason: "invalid_epoch_record",
    },
    {
      name: "backdated rollback boundary",
      current: CANONICAL,
      proposed: rollbackBeforeCanonical,
      history: [LEGACY, SHADOW, CANONICAL],
      rollout: receipt(CANONICAL, rollbackBeforeCanonical),
      reason: "invalid_epoch_record",
    },
    {
      name: "uncrossed rollback boundary",
      current: CANONICAL,
      proposed: rollbackBeyondDestination,
      history: [LEGACY, SHADOW, CANONICAL],
      rollout: receipt(CANONICAL, rollbackBeyondDestination, {
        destinationWatermark: {
          eventSequence: 143,
          messageCount: 24,
          orderedDigest: "2".repeat(64),
        },
      }),
      reason: "destination_watermark_before_effective_epoch",
    },
    {
      name: "rollback behind a prior cutover after reshadow",
      current: RESHADOW,
      proposed: rollbackAfterReshadow,
      history: [LEGACY, SHADOW, CANONICAL, ROLLED_BACK, RESHADOW],
      rollout: receipt(RESHADOW, rollbackAfterReshadow),
      reason: "invalid_epoch_record",
    },
    {
      name: "canonical recutover behind a prior rollback",
      current: RESHADOW,
      proposed: canonicalAfterReshadow,
      history: [LEGACY, SHADOW, CANONICAL, ROLLED_BACK, RESHADOW],
      rollout: receipt(RESHADOW, canonicalAfterReshadow),
      reason: "invalid_epoch_record",
    },
  ] as const;

  for (const item of cases) {
    assert.deepEqual(validateAuthorityEpochTransition({
      current: item.current,
      proposed: item.proposed,
      history: item.history,
      receipt: item.rollout,
      activeCanonicalWriters: [],
      verifySignature: verify,
    }), {
      decision: "denied",
      reason: item.reason,
    }, item.name);
  }
});

test("rollback planning cannot precede any prior authority boundary", () => {
  assert.throws(
    () => planAuthorityRollback({
      current: CANONICAL,
      rollbackTarget: LEGACY,
      history: [LEGACY, SHADOW, CANONICAL],
      effectiveAtEventSequence: 119,
    }),
    /rollback effective event sequence cannot precede current authority/,
  );
  assert.throws(
    () => planAuthorityRollback({
      current: RESHADOW,
      rollbackTarget: ROLLED_BACK,
      history: [LEGACY, SHADOW, CANONICAL, ROLLED_BACK, RESHADOW],
      effectiveAtEventSequence: 1,
    }),
    /rollback effective event sequence cannot precede current authority/,
  );
});

test("rollback planning rejects a shadow epoch carrying a cutover boundary", () => {
  assert.throws(
    () => planAuthorityRollback({
      current: { ...RESHADOW, effectiveAtEventSequence: 145 },
      rollbackTarget: ROLLED_BACK,
      history: [LEGACY, SHADOW, CANONICAL, ROLLED_BACK],
      effectiveAtEventSequence: 146,
    }),
    /shadow authority cannot have an effective event sequence/,
  );
});
