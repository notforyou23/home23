import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  canonicalJson,
  createCohortManifest,
  createLegacySourceRegistry,
  createResumePlan,
  discoverRegisteredSource,
  planCohortImport,
  planImportCohortRollback,
  sha256,
  verifyImportCohortRollback,
  type ImportLedgerEntry,
  type ImportLedgerView,
  type ImportSourceRecord,
  type LegacySourceRegistration,
  type SegmentFingerprint,
} from "../../../src/coordination/import/index.js";

const SOURCE_ID = "legacy_0198d95f-6c00-7000-8000-000000000091";
const COHORT_ID = "imp_0198d95f-6c00-7000-8000-000000000092";
const RAW_DIGEST = "1111111111111111111111111111111111111111111111111111111111111111";

function sourceRegistration(
  allowedCohorts: LegacySourceRegistration["allowedCohorts"] = ["H0", "H1", "H2", "H4", "H5"],
): LegacySourceRegistration {
  return {
    sourceId: SOURCE_ID,
    owner: {
      residentId: "resident-jerry",
      residentBotId: "bot_0198d95f-6c00-7000-8000-000000000011",
      domain: "direct-conversation",
    },
    locator: { kind: "exact_file", absolutePath: "/private/m17-fixtures/conversation.jsonl" },
    sourceType: "conversation_jsonl",
    sourceVersion: "legacy-v1",
    parserVersion: "jsonl-v1",
    privacyClass: "resident_private",
    allowedCohorts,
    reviewedBy: "user_owner",
    authority: { capability: "messages", mode: "legacy", epoch: 1, writer: "legacy-jsonl" },
    appendOnlyTailing: "reviewed_safe",
    maxRecordBytes: 1_024,
  };
}

const SOURCE_REGISTRY = createLegacySourceRegistry([sourceRegistration()]);

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

function record(overrides: Partial<ImportSourceRecord> = {}): ImportSourceRecord {
  return {
    sourceId: SOURCE_ID,
    segmentIdentity: "segment-a",
    recordKey: "line:0",
    recordIndex: 0,
    byteOffset: 0,
    nextByteOffset: 80,
    rawDigest: RAW_DIGEST,
    parserVersion: "jsonl-v1",
    sourceTimestamp: "2026-08-20T12:00:00.000Z",
    author: { class: "owner", canonicalPrincipalId: "user_owner" },
    canonicalKind: "message",
    sourceObjectKey: "legacy-message-1",
    visibleBody: "hello\r\nworld",
    attachmentReferences: [],
    discoveredWatermark: {
      recordIndex: 1,
      byteOffset: 80,
      tailDigest: "4".repeat(64),
    },
    ...overrides,
  };
}

function manifestEntry(overrides: Record<string, unknown> = {}) {
  return {
    sourceId: SOURCE_ID,
    segmentIdentity: "segment-a",
    recordKey: "line:0",
    recordIndex: 0,
    byteOffset: 0,
    nextByteOffset: 80,
    rawDigest: RAW_DIGEST,
    parserVersion: "jsonl-v1",
    reviewedSourceWatermark: {
      recordIndex: 1,
      byteOffset: 80,
      tailDigest: "4".repeat(64),
    },
    cohort: "H2" as const,
    bodyDecision: "include_reviewed" as const,
    ...overrides,
  };
}

function manifest(
  snapshotAt = "2026-08-25T12:00:00.000Z",
  id = COHORT_ID,
) {
  return createCohortManifest({
    id,
    snapshotAt,
    selectorVersion: "m17-v1",
    reviewedBy: "user_owner",
    entries: [manifestEntry()],
  }, SOURCE_REGISTRY);
}

test("planning the same reviewed fixture twice yields the same canonical result", () => {
  const ledger = new TestLedger();
  const first = planCohortImport(manifest(), [record()], ledger, SOURCE_REGISTRY);
  const second = planCohortImport(manifest(), [record()], ledger, SOURCE_REGISTRY);

  assert.deepEqual(second, first);
  assert.equal(first.items[0]?.action, "insert");
  assert.equal(first.items[0]?.canonical?.visibleBody, "hello\nworld");
  assert.equal(first.items[0]?.canonical?.sourceTimestamp, "2026-08-20T12:00:00.000Z");
  assert.equal(first.selectionSnapshotAt, "2026-08-25T12:00:00.000Z");
  assert.equal("importedAt" in first.items[0]!.canonical!, false);
  assert.equal(first.items[0]?.canonical?.author.class, "owner");
  assert.match(first.canonicalDigest, /^[a-f0-9]{64}$/);

  ledger.seed({
    importKeyDigest: first.items[0]!.importKeyDigest,
    sourceId: SOURCE_ID,
    segmentIdentity: "segment-a",
    recordKey: "line:0",
    rawDigest: RAW_DIGEST,
    state: "verified",
    canonicalDigest: first.items[0]!.canonicalDigest,
  });
  const replay = planCohortImport(manifest(), [record()], ledger, SOURCE_REGISTRY);
  assert.equal(replay.items[0]?.action, "already_imported");
  assert.deepEqual(replay.items[0]?.canonical, first.items[0]?.canonical);
});

test("selection time stays outside canonical identity across reviewed manifests", () => {
  const ledger = new TestLedger();
  const first = planCohortImport(manifest(), [record()], ledger, SOURCE_REGISTRY);
  ledger.seed({
    importKeyDigest: first.items[0]!.importKeyDigest,
    sourceId: SOURCE_ID,
    segmentIdentity: "segment-a",
    recordKey: "line:0",
    rawDigest: RAW_DIGEST,
    state: "verified",
    canonicalDigest: first.items[0]!.canonicalDigest,
  });

  const later = planCohortImport(
    manifest(
      "2026-08-26T12:00:00.000Z",
      "imp_0198d95f-6c00-7000-8000-000000000098",
    ),
    [record()],
    ledger,
    SOURCE_REGISTRY,
  );
  assert.equal(later.items[0]?.action, "already_imported");
  assert.deepEqual(later.items[0]?.canonical, first.items[0]?.canonical);
  assert.equal(later.selectionSnapshotAt, "2026-08-26T12:00:00.000Z");
});

test("terminal ledger states cannot silently become already imported", () => {
  const baseline = planCohortImport(manifest(), [record()], new TestLedger(), SOURCE_REGISTRY);
  const cases = [
    { state: "quarantined" as const, action: "quarantine", reason: "ledger_item_quarantined" },
    { state: "rolled_back" as const, action: "skip", reason: "ledger_item_rolled_back" },
    { state: "skipped_with_reason" as const, action: "skip", reason: "ledger_item_skipped" },
  ];

  for (const item of cases) {
    const ledger = new TestLedger();
    ledger.seed({
      importKeyDigest: baseline.items[0]!.importKeyDigest,
      sourceId: SOURCE_ID,
      segmentIdentity: "segment-a",
      recordKey: "line:0",
      rawDigest: RAW_DIGEST,
      state: item.state,
      canonicalDigest: baseline.items[0]!.canonicalDigest,
    });
    const plan = planCohortImport(manifest(), [record()], ledger, SOURCE_REGISTRY);
    assert.equal(plan.items[0]?.action, item.action, item.state);
    assert.equal(plan.items[0]?.reason, item.reason, item.state);
  }
});

test("pre-commit ledger states still plan the canonical insert", () => {
  const baseline = planCohortImport(manifest(), [record()], new TestLedger(), SOURCE_REGISTRY);
  for (const state of ["discovered", "selected"] as const) {
    const ledger = new TestLedger();
    ledger.seed({
      importKeyDigest: baseline.items[0]!.importKeyDigest,
      sourceId: SOURCE_ID,
      segmentIdentity: "segment-a",
      recordKey: "line:0",
      rawDigest: RAW_DIGEST,
      state,
      canonicalDigest: baseline.items[0]!.canonicalDigest,
    });
    const plan = planCohortImport(manifest(), [record()], ledger, SOURCE_REGISTRY);
    assert.equal(plan.items[0]?.action, "insert", state);
  }
});

test("a source position cannot acquire a second natural import identity", () => {
  const ledger = new TestLedger();
  ledger.seed({
    importKeyDigest: "a".repeat(64),
    sourceId: SOURCE_ID,
    segmentIdentity: "segment-a",
    recordKey: "line:0",
    rawDigest: RAW_DIGEST,
    state: "verified",
    canonicalDigest: "b".repeat(64),
  });

  const plan = planCohortImport(manifest(), [record()], ledger, SOURCE_REGISTRY);
  assert.equal(plan.items[0]?.action, "quarantine");
  assert.equal(plan.items[0]?.reason, "source_position_identity_mismatch");
});

test("body copying is impossible without an eligible reviewed cohort entry", () => {
  assert.throws(
    () => createCohortManifest({
      id: COHORT_ID,
      snapshotAt: "2026-08-25T12:00:00.000Z",
      selectorVersion: "m17-v1",
      reviewedBy: "user_owner",
      entries: [manifestEntry({ cohort: "H4", bodyDecision: "include_reviewed" })],
    }, SOURCE_REGISTRY),
    /H4 cannot import bodies/,
  );

  const referenceOnly = createCohortManifest({
    id: COHORT_ID,
    snapshotAt: "2026-08-25T12:00:00.000Z",
    selectorVersion: "m17-v1",
    reviewedBy: "user_owner",
    entries: [manifestEntry({ cohort: "H0", bodyDecision: "reference_only" })],
  }, SOURCE_REGISTRY);
  const plan = planCohortImport(referenceOnly, [record()], new TestLedger(), SOURCE_REGISTRY);
  assert.equal(plan.items[0]?.canonical?.visibleBody, null);
  assert.equal(plan.items[0]?.canonical?.bodyImported, false);

  const valid = manifest();
  const forged = {
    ...valid,
    entries: valid.entries.map((entry) => ({
      ...entry,
      cohort: "H4" as const,
      bodyDecision: "include_reviewed" as const,
    })),
  };
  assert.throws(
    () => planCohortImport(forged, [record()], new TestLedger(), SOURCE_REGISTRY),
    /cohort manifest.*body policy/,
  );
});

test("a cohort manifest cannot select an unregistered source or a disallowed cohort", () => {
  const unregistered = "legacy_0198d95f-6c00-7000-8000-000000000099";
  assert.throws(
    () => createCohortManifest({
      id: COHORT_ID,
      snapshotAt: "2026-08-25T12:00:00.000Z",
      selectorVersion: "m17-v1",
      reviewedBy: "user_owner",
      entries: [manifestEntry({
        sourceId: unregistered,
        cohort: "H0",
        bodyDecision: "reference_only",
      })],
    }, SOURCE_REGISTRY),
    /not in the reviewed source registry/,
  );

  const restricted = createLegacySourceRegistry([sourceRegistration(["H0"])]);
  assert.throws(
    () => createCohortManifest({
      id: COHORT_ID,
      snapshotAt: "2026-08-25T12:00:00.000Z",
      selectorVersion: "m17-v1",
      reviewedBy: "user_owner",
      entries: [manifestEntry()],
    }, restricted),
    /does not allow cohort H2/,
  );

  assert.throws(
    () => createCohortManifest({
      id: COHORT_ID,
      snapshotAt: "2026-08-25T12:00:00.000Z",
      selectorVersion: "m17-v1",
      reviewedBy: "someone-unregistered",
      entries: [manifestEntry()],
    }, SOURCE_REGISTRY),
    /reviewer must be a canonical principal/,
  );

  assert.throws(
    () => createCohortManifest({
      id: COHORT_ID,
      snapshotAt: "2026-08-25T12:00:00.000Z",
      selectorVersion: "m17-v1",
      reviewedBy: "bot_0198d95f-6c00-7000-8000-000000000011",
      entries: [manifestEntry()],
    }, SOURCE_REGISTRY),
    /reviewer must match the registered source reviewer/,
  );

  const restrictedManifest = createCohortManifest({
    id: COHORT_ID,
    snapshotAt: "2026-08-25T12:00:00.000Z",
    selectorVersion: "m17-v1",
    reviewedBy: "user_owner",
    entries: [manifestEntry({ cohort: "H0", bodyDecision: "reference_only" })],
  }, restricted);
  const forgedCore = {
    ...restrictedManifest,
    entries: restrictedManifest.entries.map((entry) => ({
      ...entry,
      cohort: "H1" as const,
      bodyDecision: "include_reviewed" as const,
    })),
  };
  const { manifestDigest: _oldDigest, ...unsignedForged } = forgedCore;
  const forged = {
    ...unsignedForged,
    manifestDigest: sha256(canonicalJson(unsignedForged)),
  };
  assert.throws(
    () => planCohortImport(forged, [record()], new TestLedger(), restricted),
    /does not allow its selected cohort/,
  );
});

test("planning revalidates the reviewed registry and exact selected source bytes", () => {
  const changed = planCohortImport(
    manifest(),
    [record({ rawDigest: "5".repeat(64) })],
    new TestLedger(),
    SOURCE_REGISTRY,
  );
  assert.equal(changed.items[0]?.action, "quarantine");
  assert.equal(changed.items[0]?.reason, "reviewed_record_changed");

  const driftedRegistry = createLegacySourceRegistry([
    { ...sourceRegistration(), parserVersion: "jsonl-v2" },
  ]);
  assert.throws(
    () => planCohortImport(manifest(), [record()], new TestLedger(), driftedRegistry),
    /source registry differs from the reviewed cohort manifest/,
  );
});

test("canonical authorship is bound to owner and Bot principals", () => {
  const cases: ImportSourceRecord["author"][] = [
    { class: "owner", canonicalPrincipalId: null },
    { class: "owner", canonicalPrincipalId: "bot_0198d95f-6c00-7000-8000-000000000011" },
    { class: "bot", canonicalPrincipalId: "not-a-bot-id" },
    { class: "tool", canonicalPrincipalId: "user_owner" },
  ];
  for (const author of cases) {
    const plan = planCohortImport(
      manifest(),
      [record({ author })],
      new TestLedger(),
      SOURCE_REGISTRY,
    );
    assert.equal(plan.items[0]?.action, "quarantine", JSON.stringify(author));
    assert.equal(plan.items[0]?.reason, "invalid_author_identity", JSON.stringify(author));
  }
});

test("a crash cursor resumes with bounded overlap and dedupe", () => {
  const fingerprint: SegmentFingerprint = {
    sourceId: SOURCE_ID,
    segmentIdentity: "segment-a",
    physicalIdentityDigest: "a".repeat(64),
    byteLength: 18,
    modifiedAt: "2026-08-25T12:00:00.000Z",
    recordCount: 3,
    firstRecordDigest: "1".repeat(64),
    lastRecordDigest: "3".repeat(64),
    tailDigest: "3".repeat(64),
    fullDigest: null,
    records: [
      { recordIndex: 0, byteOffset: 0, nextByteOffset: 6, digest: "a".repeat(64), tailDigest: "1".repeat(64), terminated: true },
      { recordIndex: 1, byteOffset: 6, nextByteOffset: 12, digest: "b".repeat(64), tailDigest: "2".repeat(64), terminated: true },
      { recordIndex: 2, byteOffset: 12, nextByteOffset: 18, digest: "c".repeat(64), tailDigest: "3".repeat(64), terminated: true },
    ],
    partialTail: null,
    closed: false,
  };

  const resume = createResumePlan({
    cursor: {
      sourceId: SOURCE_ID,
      segmentIdentity: "segment-a",
      nextRecordIndex: 2,
      nextByteOffset: 12,
      committedTailDigest: "2".repeat(64),
    },
    current: fingerprint,
    overlapRecords: 1,
  });

  assert.deepEqual(resume, {
    sourceId: SOURCE_ID,
    segmentIdentity: "segment-a",
    startRecordIndex: 1,
    startByteOffset: 6,
    overlapRecords: 1,
    dedupeRequired: true,
  });

  assert.throws(
    () => createResumePlan({
      cursor: {
        sourceId: SOURCE_ID,
        segmentIdentity: "segment-a",
        nextRecordIndex: 2,
        nextByteOffset: 11,
        committedTailDigest: "2".repeat(64),
      },
      current: fingerprint,
      overlapRecords: 1,
    }),
    /byte offset does not match/,
  );

  const partialOnly: SegmentFingerprint = {
    ...fingerprint,
    byteLength: 7,
    recordCount: 0,
    firstRecordDigest: null,
    lastRecordDigest: null,
    tailDigest: "4".repeat(64),
    records: [],
    partialTail: { byteOffset: 0, byteLength: 7, digest: "5".repeat(64) },
  };
  const partialResume = createResumePlan({
    cursor: {
      sourceId: SOURCE_ID,
      segmentIdentity: "segment-a",
      nextRecordIndex: 0,
      nextByteOffset: 0,
      committedTailDigest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    },
    current: partialOnly,
    overlapRecords: 0,
  });
  assert.equal(partialResume.startByteOffset, 0);
});

test("a changed record at a committed source position is quarantined", () => {
  const ledger = new TestLedger();
  ledger.seed({
    importKeyDigest: "a".repeat(64),
    sourceId: SOURCE_ID,
    segmentIdentity: "segment-a",
    recordKey: "line:0",
    rawDigest: "2".repeat(64),
    state: "verified",
    canonicalDigest: "3".repeat(64),
  });

  const plan = planCohortImport(manifest(), [record()], ledger, SOURCE_REGISTRY);
  assert.equal(plan.items[0]?.action, "quarantine");
  assert.equal(plan.items[0]?.reason, "historical_record_changed");
  assert.equal(plan.counts.quarantined, 1);
  assert.equal(plan.counts.inserted, 0);
});

function createRollbackSourceFixture(t: test.TestContext, name: string) {
  const directory = mkdtempSync(join(tmpdir(), `home23-m17-${name}-`));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "conversation.jsonl");
  const sourceBytes = Buffer.from("one\ntwo\n", "utf8");
  writeFileSync(path, sourceBytes);
  const sourceRegistry = createLegacySourceRegistry([{
    ...sourceRegistration(),
    locator: { kind: "exact_file", absolutePath: path },
  }]);
  const discovered = discoverRegisteredSource(sourceRegistry, SOURCE_ID);
  const first = discovered.fingerprint.records[0]!;
  const cohortManifest = createCohortManifest({
    id: COHORT_ID,
    snapshotAt: "2026-08-25T12:00:00.000Z",
    selectorVersion: "m17-rollback-reviewed-v1",
    reviewedBy: "user_owner",
    entries: [{
      sourceId: SOURCE_ID,
      segmentIdentity: discovered.fingerprint.segmentIdentity,
      recordKey: "line:0",
      recordIndex: first.recordIndex,
      byteOffset: first.byteOffset,
      nextByteOffset: first.nextByteOffset,
      rawDigest: first.digest,
      parserVersion: "jsonl-v1",
      reviewedSourceWatermark: discovered.watermark,
      cohort: "H4",
      bodyDecision: "reference_only",
    }],
  }, sourceRegistry);
  return { path, sourceBytes, sourceRegistry, cohortManifest };
}

test("cohort rollback preserves source, provenance, aliases, ledger, and cursors", (t) => {
  const { sourceRegistry, cohortManifest } = createRollbackSourceFixture(t, "rollback-plan");
  const rollback = planImportCohortRollback({
    cohortManifest,
    batchId: "batch-1",
    sourceRegistry,
    items: [
      { importKeyDigest: "1".repeat(64), bodyImported: true, referencedByNewActivity: false },
      { importKeyDigest: "2".repeat(64), bodyImported: true, referencedByNewActivity: true },
    ],
  });

  assert.equal(rollback.batchState, "inactive");
  assert.equal(rollback.source.action, "preserve_read_only");
  assert.equal(rollback.source.overwriteAllowed, false);
  assert.equal(rollback.source.expectedSegments.length, 1);
  assert.equal(rollback.source.expectedSegments[0]?.sourceId, SOURCE_ID);
  assert.match(rollback.source.expectedSegments[0]?.fingerprintDigest ?? "", /^[a-f0-9]{64}$/);
  assert.deepEqual(rollback.preserve, [
    "import_ledger",
    "aliases",
    "provenance",
    "event_boundaries",
    "read_cursors",
    "canonical_event_history",
  ]);
  assert.equal(
    rollback.items[0]?.canonicalAction,
    "deactivate_projection_and_remove_unreferenced_copied_body",
  );
  assert.equal(rollback.items[0]?.canonicalRecord, "preserve_audit_stub");
  assert.equal(rollback.items[1]?.canonicalAction, "preserve_referenced_record");
});

test("rollback verification fails closed unless every allowlisted legacy source is byte-identical", (t) => {
  const {
    path,
    sourceBytes,
    sourceRegistry,
    cohortManifest,
  } = createRollbackSourceFixture(t, "rollback-proof");
  const rollback = planImportCohortRollback({
    cohortManifest,
    batchId: "batch-rollback-proof",
    sourceRegistry,
    items: [{
      importKeyDigest: "1".repeat(64),
      bodyImported: true,
      referencedByNewActivity: false,
    }],
  });
  const receipt = verifyImportCohortRollback({
    rollback,
    sourceRegistry,
    cohortManifest,
  });
  const before = rollback.source.expectedSegments[0]!;

  assert.equal(receipt.sourceMutation, "none");
  assert.deepEqual(receipt.sources, [{
    sourceId: SOURCE_ID,
    segmentIdentity: before.segmentIdentity,
    byteLength: sourceBytes.length,
    tailDigest: before.tailDigest,
    classification: "unchanged",
  }]);
  assert.deepEqual(readFileSync(path), sourceBytes);
  assert.equal(JSON.stringify(receipt).includes(path), false);

  assert.throws(
    () => verifyImportCohortRollback({
      rollback: {
        ...rollback,
        source: { ...rollback.source, expectedSegments: [] },
      },
      sourceRegistry,
      cohortManifest,
    }),
    /source set differs from the reviewed cohort manifest/,
  );

  writeFileSync(path, Buffer.concat([sourceBytes, Buffer.from("three\n")]));
  assert.throws(
    () => verifyImportCohortRollback({
      rollback,
      sourceRegistry,
      cohortManifest,
    }),
    /legacy source changed during cohort rollback/,
  );
});

test("rollback planning refuses a replacement for the reviewed source segment", (t) => {
  const {
    path,
    sourceBytes,
    sourceRegistry,
    cohortManifest,
  } = createRollbackSourceFixture(t, "rollback-rotation");
  const reviewedSegmentIdentity = cohortManifest.entries[0]!.segmentIdentity;
  renameSync(path, `${path}.reviewed`);
  writeFileSync(path, sourceBytes);
  const replacement = discoverRegisteredSource(sourceRegistry, SOURCE_ID);
  assert.notEqual(replacement.fingerprint.segmentIdentity, reviewedSegmentIdentity);

  assert.throws(
    () => planImportCohortRollback({
      cohortManifest,
      batchId: "batch-rollback-rotation",
      sourceRegistry,
      items: [{
        importKeyDigest: "1".repeat(64),
        bodyImported: true,
        referencedByNewActivity: false,
      }],
    }),
    /legacy source segment differs from the reviewed cohort manifest/,
  );
});
