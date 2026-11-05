import assert from "node:assert/strict";
import {
  generateKeyPairSync,
  sign,
  type KeyObject,
} from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openCoordinationDatabase } from "../../../src/coordination/db/index.js";
import {
  authorityReceiptSigningPayload,
  COORDINATION_ATTACHMENTS_WRITER,
  type AuthorityEpoch,
  type AuthorityRolloutReceipt,
  type UnsignedAuthorityRolloutReceipt,
} from "../../../src/coordination/epochs/index.js";
import { generateCoordinationId } from "../../../src/coordination/ids/index.js";
import {
  executeM31AttachmentAuthorityTransition,
  FEATURE_OFF_ATTACHMENTS_WRITER,
  initializeM31AttachmentAuthority,
  type M31AttachmentBaselineEvidence,
} from "../../../src/coordination/operations/index.js";
import { bootstrapJerry } from "../../../src/coordination/operations/bootstrap-jerry.js";
import { FEATURE_FLAG_REGISTRY } from "../../../src/coordination/schema/contract-registry.js";

const bootstrapAuthority = Object.freeze({
  approved: true,
  kind: "m14-bootstrap",
  operator: "user_owner",
  resident: "jerry",
  legacyWriterAuthoritative: true,
  coordinationFlagsAllFalse: true,
} as const);

const baselineEvidence: M31AttachmentBaselineEvidence = Object.freeze({
  approved: true,
  kind: "m31-attachments-feature-off-baseline",
  operator: "user_owner",
  attachmentAdmissionEnabled: false,
  noExistingAttachmentWriter: true,
});

function currentEpoch(databasePath: string): AuthorityEpoch | null {
  const database = openCoordinationDatabase({ path: databasePath });
  try {
    return database.readOne<AuthorityEpoch>(
      `SELECT capability, epoch, mode, writer,
              effective_at_event_sequence AS effectiveAtEventSequence,
              rollback_epoch AS rollbackEpoch
       FROM authority_epochs
       WHERE capability = 'attachments'
       ORDER BY epoch DESC LIMIT 1`,
    ) ?? null;
  } finally {
    database.close();
  }
}

function eventSequence(databasePath: string): number {
  const database = openCoordinationDatabase({ path: databasePath });
  try {
    return database.readOne<{ sequence: number }>(
      "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM events",
    )?.sequence ?? 0;
  } finally {
    database.close();
  }
}

function activeDirectFlags(): Record<string, boolean> {
  const flags = Object.fromEntries(
    Object.keys(FEATURE_FLAG_REGISTRY).map((flag) => [flag, false]),
  ) as Record<string, boolean>;
  flags["coordination.process.enabled"] = true;
  flags["coordination.public_api.enabled"] = true;
  flags["coordination.resident.jerry.enabled"] = true;
  return flags;
}

function signedReceipt(input: {
  from: AuthorityEpoch;
  to: AuthorityEpoch;
  privateKey: KeyObject;
  issuedAt: string;
  destinationSequence: number;
}): AuthorityRolloutReceipt {
  const unsigned: UnsignedAuthorityRolloutReceipt = {
    receiptVersion: 1,
    capability: "attachments",
    fromEpoch: input.from.epoch,
    toEpoch: input.to.epoch,
    fromAuthority: {
      mode: input.from.mode,
      writer: input.from.writer,
    },
    toAuthority: {
      mode: input.to.mode,
      writer: input.to.writer,
    },
    sourceWatermark: {
      sourceId: "legacy_0198d95f-6c00-7000-8000-000000000099",
      segmentIdentity: "isolated-m31-attachment-authority",
      recordIndex: 0,
      byteOffset: 0,
      tailDigest: "1".repeat(64),
    },
    destinationWatermark: {
      eventSequence: input.destinationSequence,
      messageCount: 0,
      orderedDigest: "2".repeat(64),
    },
    samePathCanary: {
      operationId: "createAttachment",
      route: "/api/v1/attachments",
      requestDigest: "3".repeat(64),
      passed: true,
    },
    driftCount: 0,
    activeFlags: activeDirectFlags(),
    rollbackTarget: input.to.rollbackEpoch,
    operator: "user_owner",
    effectiveAtEventSequence: input.to.effectiveAtEventSequence,
    legacyWriterDisposition: input.to.mode === "canonical"
      ? "disabled"
      : input.to.mode === "shadow"
        ? "unchanged_authoritative"
        : "restored_authoritative",
    issuedAt: input.issuedAt,
  };
  return Object.freeze({
    ...unsigned,
    signature: {
      algorithm: "ed25519",
      keyId: "isolated-m31-attachment-operator",
      value: sign(
        null,
        Buffer.from(authorityReceiptSigningPayload(unsigned), "utf8"),
        input.privateKey,
      ).toString("base64"),
    },
  });
}

test("M31 attachment authority initializes feature-off then advances and rolls back only through signed epochs", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "home23-m31-attachment-authority-"));
  const databasePath = join(root, "coordination.sqlite3");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  await bootstrapJerry({
    databasePath,
    apply: true,
    authority: bootstrapAuthority,
    serverInstanceId: "home23-jerry-harness",
    keyVersion: 1,
  });
  const identity = () => ({
    requestId: generateCoordinationId("request"),
    correlationId: generateCoordinationId("correlation"),
  });

  const preflight = initializeM31AttachmentAuthority({
    databasePath,
    evidence: baselineEvidence,
    ...identity(),
  });
  assert.equal(preflight.mode, "preflight");
  assert.equal(preflight.mutated, false);
  assert.equal(currentEpoch(databasePath), null);
  assert.throws(() => initializeM31AttachmentAuthority({
    databasePath,
    evidence: baselineEvidence,
    ...identity(),
    apply: true,
  }), /explicit authorization/u);
  assert.equal(currentEpoch(databasePath), null);

  const initialized = initializeM31AttachmentAuthority({
    databasePath,
    evidence: baselineEvidence,
    ...identity(),
    apply: true,
    liveAuthorized: true,
    now: () => new Date("2026-08-27T18:00:00.000Z"),
  });
  assert.equal(initialized.mutated, true);
  const legacy = currentEpoch(databasePath)!;
  assert.deepEqual(legacy, {
    capability: "attachments",
    epoch: 1,
    mode: "legacy",
    writer: FEATURE_OFF_ATTACHMENTS_WRITER,
    effectiveAtEventSequence: null,
    rollbackEpoch: null,
  });
  assert.equal(initializeM31AttachmentAuthority({
    databasePath,
    evidence: baselineEvidence,
    ...identity(),
    apply: true,
    liveAuthorized: true,
  }).outcome, "already_present");

  const keys = generateKeyPairSync("ed25519");
  const publicKeyPem = keys.publicKey
    .export({ format: "pem", type: "spki" })
    .toString();
  const execute = (
    receipt: AuthorityRolloutReceipt,
    apply = true,
    liveAuthorized = true,
  ) => executeM31AttachmentAuthorityTransition({
    databasePath,
    receipt,
    publicKeyPem,
    activeCanonicalWriters: [],
    attachmentAdmissionEnabled: false,
    ...identity(),
    apply,
    liveAuthorized,
  });

  const shadow: AuthorityEpoch = Object.freeze({
    ...legacy,
    epoch: 2,
    mode: "shadow",
  });
  const shadowReceipt = signedReceipt({
    from: legacy,
    to: shadow,
    privateKey: keys.privateKey,
    issuedAt: "2026-08-27T18:01:00.000Z",
    destinationSequence: eventSequence(databasePath),
  });
  assert.equal(execute(shadowReceipt, false, false).mutated, false);
  assert.deepEqual(currentEpoch(databasePath), legacy);
  assert.throws(() => execute(shadowReceipt, true, false), /explicit authorization/u);
  assert.deepEqual(currentEpoch(databasePath), legacy);
  assert.equal(execute(shadowReceipt).mutated, true);
  assert.deepEqual(currentEpoch(databasePath), shadow);

  const canonicalSequence = eventSequence(databasePath);
  const canonical: AuthorityEpoch = Object.freeze({
    capability: "attachments",
    epoch: 3,
    mode: "canonical",
    writer: COORDINATION_ATTACHMENTS_WRITER,
    effectiveAtEventSequence: canonicalSequence,
    rollbackEpoch: 1,
  });
  const canonicalReceipt = signedReceipt({
    from: shadow,
    to: canonical,
    privateKey: keys.privateKey,
    issuedAt: "2026-08-27T18:02:00.000Z",
    destinationSequence: canonicalSequence,
  });
  assert.equal(execute(canonicalReceipt).mutated, true);
  assert.deepEqual(currentEpoch(databasePath), canonical);

  const rollbackSequence = eventSequence(databasePath);
  const rollback: AuthorityEpoch = Object.freeze({
    capability: "attachments",
    epoch: 4,
    mode: "legacy",
    writer: FEATURE_OFF_ATTACHMENTS_WRITER,
    effectiveAtEventSequence: rollbackSequence,
    rollbackEpoch: 1,
  });
  const rollbackReceipt = signedReceipt({
    from: canonical,
    to: rollback,
    privateKey: keys.privateKey,
    issuedAt: "2026-08-27T18:03:00.000Z",
    destinationSequence: rollbackSequence,
  });
  assert.equal(execute(rollbackReceipt).mutated, true);
  assert.deepEqual(currentEpoch(databasePath), rollback);

  const database = openCoordinationDatabase({ path: databasePath });
  try {
    assert.deepEqual(
      database.readAll<{ epoch: number; mode: string; writer: string }>(
        `SELECT epoch, mode, writer FROM authority_epochs
         WHERE capability = 'attachments' ORDER BY epoch`,
      ),
      [
        { epoch: 1, mode: "legacy", writer: FEATURE_OFF_ATTACHMENTS_WRITER },
        { epoch: 2, mode: "shadow", writer: FEATURE_OFF_ATTACHMENTS_WRITER },
        { epoch: 3, mode: "canonical", writer: COORDINATION_ATTACHMENTS_WRITER },
        { epoch: 4, mode: "legacy", writer: FEATURE_OFF_ATTACHMENTS_WRITER },
      ],
    );
    assert.equal(
      database.readOne<{ count: number }>(
        `SELECT count(*) AS count FROM events
         WHERE aggregate_kind = 'authorityEpoch'
           AND aggregate_id = 'authority:attachments'`,
      )?.count,
      4,
    );
  } finally {
    database.close();
  }
});

test("M31 attachment authority refuses absent evidence, enabled admission, bad flags, and mislabeled writer", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "home23-m31-attachment-authority-deny-"));
  const databasePath = join(root, "coordination.sqlite3");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  await bootstrapJerry({
    databasePath,
    apply: true,
    authority: bootstrapAuthority,
    serverInstanceId: "home23-jerry-harness",
    keyVersion: 1,
  });
  assert.throws(() => initializeM31AttachmentAuthority({
    databasePath,
    ...{
      requestId: generateCoordinationId("request"),
      correlationId: generateCoordinationId("correlation"),
    },
  }), /feature-off evidence/u);
  initializeM31AttachmentAuthority({
    databasePath,
    evidence: baselineEvidence,
    requestId: generateCoordinationId("request"),
    correlationId: generateCoordinationId("correlation"),
    apply: true,
    liveAuthorized: true,
  });
  const legacy = currentEpoch(databasePath)!;
  const shadow: AuthorityEpoch = { ...legacy, epoch: 2, mode: "shadow" };
  const keys = generateKeyPairSync("ed25519");
  const receipt = signedReceipt({
    from: legacy,
    to: shadow,
    privateKey: keys.privateKey,
    issuedAt: "2026-08-27T19:01:00.000Z",
    destinationSequence: eventSequence(databasePath),
  });
  const base = {
    databasePath,
    receipt,
    publicKeyPem: keys.publicKey.export({ format: "pem", type: "spki" }).toString(),
    activeCanonicalWriters: [],
    requestId: generateCoordinationId("request"),
    correlationId: generateCoordinationId("correlation"),
    apply: true,
    liveAuthorized: true,
  };
  assert.throws(() => executeM31AttachmentAuthorityTransition({
    ...base,
    attachmentAdmissionEnabled: true,
  } as never), /admission disabled/u);
  const missingFlag = {
    ...receipt,
    activeFlags: {
      ...receipt.activeFlags,
      "coordination.resident.jerry.enabled": false,
    },
  };
  assert.throws(() => executeM31AttachmentAuthorityTransition({
    ...base,
    receipt: missingFlag,
    attachmentAdmissionEnabled: false,
  }), /preserve stable Jerry direct messaging/u);

  const canonical: AuthorityEpoch = {
    capability: "attachments",
    epoch: 2,
    mode: "canonical",
    writer: "label-only-writer",
    effectiveAtEventSequence: eventSequence(databasePath),
    rollbackEpoch: 1,
  };
  const mislabeled = signedReceipt({
    from: legacy,
    to: canonical,
    privateKey: keys.privateKey,
    issuedAt: "2026-08-27T19:02:00.000Z",
    destinationSequence: canonical.effectiveAtEventSequence!,
  });
  assert.throws(() => executeM31AttachmentAuthorityTransition({
    ...base,
    receipt: mislabeled,
    attachmentAdmissionEnabled: false,
  }), /canonical writer must be exactly home23-coordination/u);
  assert.deepEqual(currentEpoch(databasePath), legacy);
});
