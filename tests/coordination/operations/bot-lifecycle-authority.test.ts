import assert from "node:assert/strict";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openCoordinationDatabase } from "../../../src/coordination/db/index.js";
import {
  authorityReceiptSigningPayload,
  type AuthorityEpoch,
  type AuthorityRolloutReceipt,
  type UnsignedAuthorityRolloutReceipt,
} from "../../../src/coordination/epochs/index.js";
import { generateCoordinationId } from "../../../src/coordination/ids/index.js";
import {
  executeBotLifecycleAuthorityTransition,
  FEATURE_OFF_BOT_LIFECYCLE_WRITER,
  initializeBotLifecycleAuthority,
} from "../../../src/coordination/operations/index.js";
import { bootstrapJerry } from "../../../src/coordination/operations/bootstrap-jerry.js";
import { FEATURE_FLAG_REGISTRY } from "../../../src/coordination/schema/contract-registry.js";

function activeHouseFlags(): Record<string, boolean> {
  const flags = Object.fromEntries(
    Object.keys(FEATURE_FLAG_REGISTRY).map((flag) => [flag, false]),
  ) as Record<string, boolean>;
  for (const flag of [
    "coordination.process.enabled",
    "coordination.public_api.enabled",
    "coordination.resident.jerry.enabled",
    "coordination.resident.forrest.enabled",
    "coordination.channels.enabled",
  ]) flags[flag] = true;
  return flags;
}

function signedShadowReceipt(input: {
  current: AuthorityEpoch;
  destinationSequence: number;
  messageCount: number;
  privateKey: KeyObject;
}): AuthorityRolloutReceipt {
  const unsigned: UnsignedAuthorityRolloutReceipt = {
    receiptVersion: 1,
    capability: "bot_lifecycle",
    fromEpoch: input.current.epoch,
    toEpoch: 2,
    fromAuthority: {
      mode: input.current.mode,
      writer: input.current.writer,
    },
    toAuthority: {
      mode: "shadow",
      writer: FEATURE_OFF_BOT_LIFECYCLE_WRITER,
    },
    sourceWatermark: {
      sourceId: "legacy_0198d95f-6c00-7000-8000-000000000091",
      segmentIdentity: "isolated-create-bot-authority",
      recordIndex: 1,
      byteOffset: 1,
      tailDigest: "1".repeat(64),
    },
    destinationWatermark: {
      eventSequence: input.destinationSequence,
      messageCount: input.messageCount,
      orderedDigest: "2".repeat(64),
    },
    samePathCanary: {
      operationId: "createBot",
      route: "/api/v1/bots",
      requestDigest: "3".repeat(64),
      passed: true,
    },
    driftCount: 0,
    activeFlags: activeHouseFlags(),
    rollbackTarget: null,
    operator: "user_owner",
    effectiveAtEventSequence: null,
    legacyWriterDisposition: "unchanged_authoritative",
    issuedAt: "2026-09-02T18:00:00.000Z",
  };
  return Object.freeze({
    ...unsigned,
    signature: {
      algorithm: "ed25519",
      keyId: "isolated-bot-lifecycle-operator",
      value: sign(
        null,
        Buffer.from(authorityReceiptSigningPayload(unsigned), "utf8"),
        input.privateKey,
      ).toString("base64"),
    },
  });
}

test("Bot lifecycle authority refuses a signed stale destination watermark before append", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "home23-bot-lifecycle-authority-"));
  const databasePath = join(root, "coordination.sqlite3");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  await bootstrapJerry({
    databasePath,
    apply: true,
    authority: {
      approved: true,
      kind: "m14-bootstrap",
      operator: "user_owner",
      resident: "jerry",
      legacyWriterAuthoritative: true,
      coordinationFlagsAllFalse: true,
    },
    serverInstanceId: "home23-jerry-harness",
    keyVersion: 1,
  });
  const identity = () => ({
    requestId: generateCoordinationId("request"),
    correlationId: generateCoordinationId("correlation"),
  });
  initializeBotLifecycleAuthority({
    databasePath,
    ...identity(),
    apply: true,
    liveAuthorized: true,
    evidence: {
      approved: true,
      kind: "bot-lifecycle-feature-off-baseline",
      operator: "user_owner",
      botLifecycleEnabled: false,
      noExistingBotLifecycleWriter: true,
    },
  });
  const snapshot = () => {
    const database = openCoordinationDatabase({ path: databasePath });
    try {
      return {
        eventSequence: database.readOne<{ value: number }>(
          "SELECT COALESCE(MAX(sequence), 0) AS value FROM events",
        )!.value,
        messageCount: database.readOne<{ value: number }>(
          "SELECT count(*) AS value FROM messages",
        )!.value,
        current: database.readOne<AuthorityEpoch>(`
          SELECT capability, epoch, mode, writer,
                 effective_at_event_sequence AS effectiveAtEventSequence,
                 rollback_epoch AS rollbackEpoch
          FROM authority_epochs WHERE capability = 'bot_lifecycle'
          ORDER BY epoch DESC LIMIT 1
        `)!,
      };
    } finally {
      database.close();
    }
  };
  const captured = snapshot();
  const keys = generateKeyPairSync("ed25519");
  const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const stale = signedShadowReceipt({
    current: captured.current,
    destinationSequence: captured.eventSequence,
    messageCount: captured.messageCount,
    privateKey: keys.privateKey,
  });

  const database = openCoordinationDatabase({ path: databasePath });
  try {
    const createdAt = "2026-09-02T18:00:01.000Z";
    database.mutateWithEvent(() => ({
      value: undefined,
      event: {
        type: "fixture.snapshot_advanced",
        aggregateKind: "fixture",
        aggregateId: "bot-lifecycle-watermark",
        aggregateVersion: 1,
        channelId: null,
        actorPrincipalId: "user_owner",
        ...identity(),
        payload: {},
        createdAt,
      },
    }));
  } finally {
    database.close();
  }

  assert.throws(() => executeBotLifecycleAuthorityTransition({
    databasePath,
    ...identity(),
    receipt: stale,
    publicKeyPem,
    activeCanonicalWriters: [],
    botLifecycleEnabled: false,
    apply: true,
    liveAuthorized: true,
  }), /destination watermark no longer matches/u);
  assert.equal(snapshot().current.epoch, 1);

  const fresh = snapshot();
  const applied = executeBotLifecycleAuthorityTransition({
    databasePath,
    ...identity(),
    receipt: signedShadowReceipt({
      current: fresh.current,
      destinationSequence: fresh.eventSequence,
      messageCount: fresh.messageCount,
      privateKey: keys.privateKey,
    }),
    publicKeyPem,
    activeCanonicalWriters: [],
    botLifecycleEnabled: false,
    apply: true,
    liveAuthorized: true,
  });
  assert.equal(applied.mutated, true);
  assert.equal(snapshot().current.epoch, 2);
});
