import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openCoordinationDatabase } from "../../../src/coordination/db/index.js";
import { bindCanonicalImportMessage, createCohortManifest, createLegacySourceRegistry, executeAtomicImport, type ImportLedgerView, type ImportSourceRecord } from "../../../src/coordination/import/index.js";
import { fixtureId, OWNER_ID } from "../messaging/test-fixture.js";

const SOURCE = "legacy_0198d95f-6c00-7000-8000-000000000091";
const COHORT = "imp_0198d95f-6c00-7000-8000-000000000092";
const SEGMENT = "d".repeat(64), RAW = "2".repeat(64), TAIL = "4".repeat(64);
const AT = "2026-08-25T12:00:00.000Z";
const emptyLedger: ImportLedgerView = { findByNaturalKey: () => undefined, findBySourcePosition: () => undefined };

function readyBinding() {
  const registry = createLegacySourceRegistry([{ sourceId: SOURCE, owner: { residentId: "resident-jerry", residentBotId: fixtureId("bot", 11), domain: "direct" }, locator: { kind: "exact_file", absolutePath: join(tmpdir(), "never-read-m17.jsonl") }, sourceType: "conversation_jsonl", sourceVersion: "legacy-v1", parserVersion: "jsonl-v1", privacyClass: "resident_private", allowedCohorts: ["H2"], reviewedBy: OWNER_ID, authority: { capability: "messages", mode: "legacy", epoch: 1, writer: "legacy" }, appendOnlyTailing: "disabled", maxRecordBytes: 1024 }]);
  const watermark = { recordIndex: 1, byteOffset: 80, tailDigest: TAIL };
  const record: ImportSourceRecord = { sourceId: SOURCE, segmentIdentity: SEGMENT, recordKey: "line:0", recordIndex: 0, byteOffset: 0, nextByteOffset: 80, rawDigest: RAW, parserVersion: "jsonl-v1", sourceTimestamp: "2026-08-20T12:00:00.000Z", author: { class: "owner", canonicalPrincipalId: OWNER_ID }, canonicalKind: "message", sourceObjectKey: "legacy-message-42", visibleBody: "atomic crossing", attachmentReferences: [], discoveredWatermark: watermark };
  const manifest = createCohortManifest({ id: COHORT, snapshotAt: AT, selectorVersion: "m17-reviewed-v1", reviewedBy: OWNER_ID, entries: [{ sourceId: SOURCE, segmentIdentity: SEGMENT, recordKey: "line:0", recordIndex: 0, byteOffset: 0, nextByteOffset: 80, rawDigest: RAW, parserVersion: "jsonl-v1", reviewedSourceWatermark: watermark, cohort: "H2", bodyDecision: "include_reviewed" }] }, registry);
  const binding = bindCanonicalImportMessage({ planning: { manifest, sourceRecords: [record], ledger: emptyLedger, sourceRegistry: registry, itemIndex: 0 }, existingAliases: [], actor: { principalId: OWNER_ID, kind: "owner", displayName: "Owner" }, channelId: fixtureId("channel", 702), messageId: fixtureId("message", 702), aliasId: fixtureId("alias", 702), aliasNamespace: "legacy-message", materializedAt: AT });
  assert.equal(binding.decision, "ready");
  if (binding.decision !== "ready") throw new Error("fixture not ready");
  return binding;
}

function fixture(t: test.TestContext) {
  const path = join(mkdtempSync(join(tmpdir(), "home23-m17-executor-")), "coordination.sqlite");
  const db = openCoordinationDatabase({ path, now: () => new Date(AT) });
  t.after(() => db.close());
  db.mutateWithEvent((tx) => {
    tx.run("INSERT INTO principals (id,kind,created_at) VALUES ('user_owner','owner',?)", AT);
    tx.run("INSERT INTO channels (id,kind,title,purpose,owner_principal_id,responder_mode,coordinator_bot_id,response_order,max_bot_turns,lifecycle,pinned,version,next_message_sequence,created_at,updated_at) VALUES (?,'group','Import','',?,'mentions_only',NULL,'parallel',1,'active',0,1,1,?,?)", fixtureId("channel", 702), OWNER_ID, AT, AT);
    tx.run("INSERT INTO channel_members (channel_id,principal_id,kind,role,active,joined_at,left_at) VALUES (?,?,'owner','owner',1,?,NULL)", fixtureId("channel", 702), OWNER_ID, AT);
    tx.run("INSERT INTO authority_epochs (capability,epoch,mode,writer,effective_at_event_sequence,rollback_epoch,receipt_json,created_at) VALUES ('messages',1,'legacy','legacy',NULL,NULL,'{}',?)", AT);
    return { value: null, event: { type: "channel.created", aggregateKind: "channel", aggregateId: fixtureId("channel", 702), aggregateVersion: 1, channelId: fixtureId("channel", 702), actorPrincipalId: OWNER_ID, requestId: fixtureId("request", 700), correlationId: fixtureId("correlation", 700), payload: {}, createdAt: AT } };
  });
  return db;
}

function input(binding = readyBinding()) {
  return { binding, evidence: { source: { registryDigest: binding.planningReceipt.sourceRegistryDigest, locatorDigest: "3".repeat(64), physicalIdentityDigest: "5".repeat(64), ownerBotId: fixtureId("bot", 11), ownerDomain: "direct", sourceType: "conversation_jsonl", sourceVersion: "legacy-v1", parserVersion: "jsonl-v1", privacyClass: "resident_private" as const, receipt: { frozen: true } }, exactFingerprint: { segmentIdentity: SEGMENT, rawDigest: RAW, watermark: { recordIndex: 1, byteOffset: 80, tailDigest: TAIL } }, expectedCursor: null, authority: { capability: "messages" as const, epoch: 1 } }, batchId: "batch-reviewed-1", itemId: "imi_reviewed_1", requestId: fixtureId("request", 703), correlationId: fixtureId("correlation", 703), committedAt: AT };
}

test("atomic executor rolls back staged writes and commits ordered events/search exactly once", (t) => {
  const db = fixture(t), request = input();
  assert.throws(() => executeAtomicImport(db, { ...request, injectFailureAfter: "canonical" }), /injected partial failure/);
  assert.equal(db.readOne<{ n: number }>("SELECT count(*) AS n FROM import_batches")!.n, 0);
  const committed = executeAtomicImport(db, request);
  assert.equal(committed.outcome, "committed");
  assert.equal(executeAtomicImport(db, request).outcome, "replayed");
  assert.deepEqual(db.readAll<{ type: string }>("SELECT type FROM events WHERE request_id=? ORDER BY sequence", request.requestId).map(x => x.type), ["message.appended", "import.updated"]);
  assert.equal(db.readOne<{ n: number }>("SELECT count(*) AS n FROM message_fts WHERE message_fts MATCH 'atomic'")!.n, 1);
  const watermark = db.readOne<{ source: number; indexed: number }>("SELECT source_event_sequence AS source,indexed_through_event_sequence AS indexed FROM search_watermarks");
  assert.equal(watermark!.source, watermark!.indexed);
  assert.throws(() => executeAtomicImport(db, { ...request, correlationId: fixtureId("correlation", 704) }), /changed replay/);
});

test("executor rejects stale evidence, duplicate identity, and terminal ledger reuse", (t) => {
  const db = fixture(t), request = input();
  assert.throws(() => executeAtomicImport(db, { ...request, evidence: { ...request.evidence, authority: { capability: "messages", epoch: 2 } } }), /stale authority/);
  assert.throws(() => executeAtomicImport(db, { ...request, evidence: { ...request.evidence, exactFingerprint: { ...request.evidence.exactFingerprint, rawDigest: "9".repeat(64) } } }), /fingerprint/);
  executeAtomicImport(db, request);
  const next = input();
  const second = { ...next, evidence: { ...next.evidence, expectedCursor: { recordIndex: 1, byteOffset: 80, tailDigest: TAIL } }, batchId: "batch-reviewed-2", itemId: "imi_reviewed_2", requestId: fixtureId("request", 705), correlationId: fixtureId("correlation", 705) };
  assert.throws(() => executeAtomicImport(db, second), /UNIQUE|terminal|identity/);
  assert.equal(db.readOne<{ n: number }>("SELECT count(*) AS n FROM import_batches")!.n, 1);
});
