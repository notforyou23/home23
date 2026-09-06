import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  resolveMessagingActor,
} from "../../../src/coordination/channels/index.js";
import {
  bindCanonicalImportMessage,
  canonicalJson,
  createCohortManifest,
  createLegacySourceRegistry,
  planCohortImport,
  sha256,
  type ImportLedgerEntry,
  type ImportLedgerView,
  type ImportSourceRecord,
  type LegacySourceRegistry,
} from "../../../src/coordination/import/index.js";
import type { AliasBinding } from "../../../src/coordination/aliases/index.js";
import {
  OWNER_ID,
  createMessagingFixture,
  fixtureId,
  ownerContext,
} from "../messaging/test-fixture.js";

const SOURCE_ID = "legacy_0198d95f-6c00-7000-8000-000000000091";
const COHORT_ID = "imp_0198d95f-6c00-7000-8000-000000000092";
const SEGMENT_ID = "d".repeat(64);
const RAW_DIGEST = "2".repeat(64);
const SOURCE_TIMESTAMP = "2026-08-20T12:00:00.000Z";
const MATERIALIZED_AT = "2026-08-25T12:00:00.000Z";

class TestLedger implements ImportLedgerView {
  readonly naturalKeys = new Map<string, ImportLedgerEntry>();
  readonly positions = new Map<string, ImportLedgerEntry>();

  findByNaturalKey(importKeyDigest: string): ImportLedgerEntry | undefined {
    return this.naturalKeys.get(importKeyDigest);
  }

  findBySourcePosition(
    sourceId: string,
    segmentIdentity: string,
    recordKey: string,
  ): ImportLedgerEntry | undefined {
    return this.positions.get(`${sourceId}:${segmentIdentity}:${recordKey}`);
  }

  seed(entry: ImportLedgerEntry): void {
    this.naturalKeys.set(entry.importKeyDigest, entry);
    this.positions.set(
      `${entry.sourceId}:${entry.segmentIdentity}:${entry.recordKey}`,
      entry,
    );
  }
}

function registry(): LegacySourceRegistry {
  return createLegacySourceRegistry([{
    sourceId: SOURCE_ID,
    owner: {
      residentId: "resident-jerry",
      residentBotId: "bot_0198d95f-6c00-7000-8000-000000000011",
      domain: "direct-conversation",
    },
    locator: {
      kind: "exact_file",
      absolutePath: join(tmpdir(), "home23-m17-reviewed-fixture.jsonl"),
    },
    sourceType: "conversation_jsonl",
    sourceVersion: "legacy-v1",
    parserVersion: "jsonl-v1",
    privacyClass: "resident_private",
    allowedCohorts: ["H1", "H2", "H4", "H5"],
    reviewedBy: OWNER_ID,
    authority: {
      capability: "messages",
      mode: "legacy",
      epoch: 1,
      writer: "legacy-jsonl",
    },
    appendOnlyTailing: "reviewed_safe",
    maxRecordBytes: 65_536,
  }]);
}

function reviewedPlanningInput(options: {
  readonly visibleBody?: string | null;
  readonly cohort?: "H1" | "H2" | "H4" | "H5";
  readonly bodyDecision?: "include_reviewed" | "reference_only";
  readonly recordRawDigest?: string;
  readonly manifestRawDigest?: string;
  readonly ledger?: TestLedger;
} = {}) {
  const sourceRegistry = registry();
  const visibleBody = options.visibleBody === undefined
    ? "Imported canonical crossing canary."
    : options.visibleBody;
  const cohort = options.cohort ?? "H2";
  const bodyDecision = options.bodyDecision
    ?? (cohort === "H4" || cohort === "H5" ? "reference_only" : "include_reviewed");
  const sourceRecords: readonly ImportSourceRecord[] = [{
    sourceId: SOURCE_ID,
    segmentIdentity: SEGMENT_ID,
    recordKey: "line:0",
    recordIndex: 0,
    byteOffset: 0,
    nextByteOffset: 80,
    rawDigest: options.recordRawDigest ?? RAW_DIGEST,
    parserVersion: "jsonl-v1",
    sourceTimestamp: SOURCE_TIMESTAMP,
    author: { class: "owner", canonicalPrincipalId: OWNER_ID },
    canonicalKind: "message",
    sourceObjectKey: "legacy-message-42",
    visibleBody,
    attachmentReferences: [],
    discoveredWatermark: {
      recordIndex: 1,
      byteOffset: 80,
      tailDigest: "4".repeat(64),
    },
  }];
  const manifest = createCohortManifest({
    id: COHORT_ID,
    snapshotAt: MATERIALIZED_AT,
    selectorVersion: "m17-reviewed-v1",
    reviewedBy: OWNER_ID,
    entries: [{
      sourceId: SOURCE_ID,
      segmentIdentity: SEGMENT_ID,
      recordKey: "line:0",
      recordIndex: 0,
      byteOffset: 0,
      nextByteOffset: 80,
      rawDigest: options.manifestRawDigest ?? RAW_DIGEST,
      parserVersion: "jsonl-v1",
      reviewedSourceWatermark: {
        recordIndex: 1,
        byteOffset: 80,
        tailDigest: "4".repeat(64),
      },
      cohort,
      bodyDecision,
    }],
  }, sourceRegistry);
  return {
    manifest,
    sourceRecords,
    ledger: options.ledger ?? new TestLedger(),
    sourceRegistry,
    itemIndex: 0,
  };
}

async function resolvedOwner(t: test.TestContext, suffix: number) {
  const fixture = await createMessagingFixture();
  t.after(fixture.close);
  return resolveMessagingActor(
    ownerContext(suffix),
    fixture.directory,
    "message:send",
  );
}

test("M17 emits a proposal-only M04 transaction bound to reviewed planning and canonical schema v3", async (t) => {
  const actor = await resolvedOwner(t, 701);
  const planning = reviewedPlanningInput();
  const binding = bindCanonicalImportMessage({
    planning,
    existingAliases: [],
    actor,
    channelId: fixtureId("channel", 702),
    messageId: fixtureId("message", 702),
    aliasId: fixtureId("alias", 702),
    aliasNamespace: "legacy-message",
    materializedAt: MATERIALIZED_AT,
  });

  assert.equal(binding.decision, "ready");
  if (binding.decision !== "ready") return;
  assert.deepEqual(binding.planningReceipt, {
    cohortId: COHORT_ID,
    manifestDigest: planning.manifest.manifestDigest,
    sourceRegistryDigest: planning.manifest.sourceRegistryDigest,
    snapshotAt: planning.manifest.snapshotAt,
    reviewedBy: planning.manifest.reviewedBy,
    planDigest: sha256(canonicalJson(planCohortImport(
      planning.manifest,
      planning.sourceRecords,
      planning.ledger,
      planning.sourceRegistry,
    ))),
    itemIndex: 0,
  });
  assert.equal(binding.m04TransactionProposal.owner, "M04");
  assert.equal(binding.m04TransactionProposal.status, "proposal_only");
  assert.equal(binding.m04TransactionProposal.schema.version, 3);
  assert.deepEqual(binding.m04TransactionProposal.requiredAtomicWrites, [
    "import_items",
    "aliases",
    "messages",
    "events",
    "message_fts",
    "search_watermarks",
    "import_cursors",
  ]);
  assert.deepEqual(binding.m04TransactionProposal.requiredOrderedEvents, [
    "message.appended",
    "import.updated",
  ]);
  assert.equal(
    binding.m04TransactionProposal.message.projection.createdAt,
    SOURCE_TIMESTAMP,
  );
  assert.equal(
    binding.m04TransactionProposal.alias.binding.createdAt,
    MATERIALIZED_AT,
  );
  assert.equal(
    binding.m04TransactionProposal.alias.binding.targetId,
    fixtureId("message", 702),
  );
  assert.equal("provenance" in binding.m04TransactionProposal.alias.binding, false);
  assert.equal("actor" in binding.m04TransactionProposal.message, false);
  assert.equal("messageCommit" in binding, false);
  assert.deepEqual(binding.m04TransactionProposal.search, {
    sourceClass: "coordination.messages",
    indexTable: "message_fts",
    watermarkTable: "search_watermarks",
    maintenance: "CoordinationDatabase.rebuildCanonicalSearchIndex",
    rebuildSqlSha256:
      "d1cbbc7729e59f36dc0bd1e26d5a92a9ac1f4648a6289ec8319e8090fb4638d7",
  });
});

test("M17 retry proposals preserve one M08 idempotency key and conflict on changed canonical requests", async (t) => {
  const actor = await resolvedOwner(t, 711);
  const input = {
    planning: reviewedPlanningInput(),
    existingAliases: [] as readonly AliasBinding[],
    actor,
    channelId: fixtureId("channel", 711),
    messageId: fixtureId("message", 711),
    aliasId: fixtureId("alias", 711),
    aliasNamespace: "legacy-message",
    materializedAt: MATERIALIZED_AT,
  };
  const first = bindCanonicalImportMessage(input);
  const replay = bindCanonicalImportMessage(input);
  const conflict = bindCanonicalImportMessage({
    ...input,
    messageId: fixtureId("message", 712),
    aliasId: fixtureId("alias", 712),
  });

  assert.equal(first.decision, "ready");
  assert.equal(replay.decision, "ready");
  assert.equal(conflict.decision, "ready");
  if (first.decision !== "ready" || replay.decision !== "ready" || conflict.decision !== "ready") {
    return;
  }
  assert.deepEqual(replay, first);
  assert.equal(
    conflict.m04TransactionProposal.message.idempotency.keyDigest,
    first.m04TransactionProposal.message.idempotency.keyDigest,
  );
  assert.notEqual(
    conflict.m04TransactionProposal.message.idempotency.requestDigest,
    first.m04TransactionProposal.message.idempotency.requestDigest,
  );
});

test("canonical alias conflicts deny the whole M04 proposal", async (t) => {
  const actor = await resolvedOwner(t, 721);
  const existing: AliasBinding = {
    id: fixtureId("alias", 721),
    namespace: "legacy-message",
    aliasDigest: sha256(canonicalJson({
      aliasCanonicalizationVersion: 1,
      namespace: "legacy-message",
      legacyId: "legacy-message-42",
    })),
    targetType: "message",
    targetId: fixtureId("message", 999),
    active: true,
    createdAt: SOURCE_TIMESTAMP,
    updatedAt: SOURCE_TIMESTAMP,
  };

  const binding = bindCanonicalImportMessage({
    planning: reviewedPlanningInput(),
    existingAliases: [existing],
    actor,
    channelId: fixtureId("channel", 721),
    messageId: fixtureId("message", 721),
    aliasId: fixtureId("alias", 722),
    aliasNamespace: "legacy-message",
    materializedAt: MATERIALIZED_AT,
  });

  assert.deepEqual(binding, {
    decision: "denied",
    reason: "alias_collision",
    aliasDigest: existing.aliasDigest,
  });
  assert.equal("m04TransactionProposal" in binding, false);
});

test("reviewed reference-only history cannot become a bodyless canonical Message", async (t) => {
  const actor = await resolvedOwner(t, 731);
  const planning = reviewedPlanningInput({
    cohort: "H4",
    bodyDecision: "reference_only",
  });
  const binding = bindCanonicalImportMessage({
    planning,
    existingAliases: [],
    actor,
    channelId: fixtureId("channel", 731),
    messageId: fixtureId("message", 731),
    aliasId: fixtureId("alias", 731),
    aliasNamespace: "legacy-message",
    materializedAt: MATERIALIZED_AT,
  });

  assert.equal(binding.decision, "reference_only");
  assert.equal("m04TransactionProposal" in binding, false);
});

test("replanning changed reviewed bytes quarantines before materialization", async (t) => {
  const actor = await resolvedOwner(t, 741);
  const binding = bindCanonicalImportMessage({
    planning: reviewedPlanningInput({ recordRawDigest: "9".repeat(64) }),
    existingAliases: [],
    actor,
    channelId: fixtureId("channel", 741),
    messageId: fixtureId("message", 741),
    aliasId: fixtureId("alias", 741),
    aliasNamespace: "legacy-message",
    materializedAt: MATERIALIZED_AT,
  });

  assert.deepEqual(binding, {
    decision: "denied",
    reason: "import_item_quarantine",
  });
});

test("already-imported ledger labels cannot claim completion without an M04 target lookup", async (t) => {
  const actor = await resolvedOwner(t, 751);
  const initial = reviewedPlanningInput();
  const planned = planCohortImport(
    initial.manifest,
    initial.sourceRecords,
    initial.ledger,
    initial.sourceRegistry,
  );
  const ledger = new TestLedger();
  ledger.seed({
    importKeyDigest: planned.items[0]!.importKeyDigest,
    sourceId: SOURCE_ID,
    segmentIdentity: SEGMENT_ID,
    recordKey: "line:0",
    rawDigest: RAW_DIGEST,
    state: "verified",
    canonicalDigest: planned.items[0]!.canonicalDigest,
  });
  const binding = bindCanonicalImportMessage({
    planning: { ...initial, ledger },
    existingAliases: [],
    actor,
    channelId: fixtureId("channel", 751),
    messageId: fixtureId("message", 751),
    aliasId: fixtureId("alias", 751),
    aliasNamespace: "legacy-message",
    materializedAt: MATERIALIZED_AT,
  });

  assert.deepEqual(binding, {
    decision: "denied",
    reason: "m04_materialization_lookup_required",
  });
});

test("M17 enforces the M08 NUL body boundary on reviewed source text", async (t) => {
  const actor = await resolvedOwner(t, 761);
  assert.throws(
    () => bindCanonicalImportMessage({
      planning: reviewedPlanningInput({ visibleBody: "reviewed\0body" }),
      existingAliases: [],
      actor,
      channelId: fixtureId("channel", 761),
      messageId: fixtureId("message", 761),
      aliasId: fixtureId("alias", 761),
      aliasNamespace: "legacy-message",
      materializedAt: MATERIALIZED_AT,
    }),
    /invalid for M08/,
  );
});
