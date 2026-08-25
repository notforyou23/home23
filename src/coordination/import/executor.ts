import type { CoordinationDatabase } from "../db/database.js";
import type { CanonicalImportMessageBinding } from "./materialization.js";
import { canonicalJson, requireCanonicalTimestamp, requireSha256, sha256 } from "./canonical.js";
import { COORDINATION_SCHEMA_CHECKSUM, COORDINATION_SCHEMA_VERSION } from "../migrations/index.js";

type ReadyBinding = Extract<CanonicalImportMessageBinding, { decision: "ready" }>;

export interface AtomicImportEvidence {
  readonly source: {
    readonly registryDigest: string; readonly locatorDigest: string;
    readonly physicalIdentityDigest: string; readonly ownerBotId: string;
    readonly ownerDomain: string; readonly sourceType: string;
    readonly sourceVersion: string; readonly parserVersion: string;
    readonly privacyClass: "resident_private" | "owner_private" | "house_shared";
    readonly receipt: object;
  };
  readonly exactFingerprint: {
    readonly segmentIdentity: string; readonly rawDigest: string;
    readonly watermark: { readonly recordIndex: number; readonly byteOffset: number; readonly tailDigest: string };
  };
  readonly expectedCursor: { readonly recordIndex: number; readonly byteOffset: number; readonly tailDigest: string } | null;
  readonly authority: { readonly capability: "messages"; readonly epoch: number };
}

export interface ExecuteAtomicImportInput {
  readonly binding: ReadyBinding;
  readonly evidence: AtomicImportEvidence;
  readonly batchId: string;
  readonly itemId: string;
  readonly requestId: string;
  readonly correlationId: string;
  readonly committedAt: string;
  readonly injectFailureAfter?: "ledgers" | "canonical";
}

export interface AtomicImportResult {
  readonly outcome: "committed" | "replayed";
  readonly batchId: string; readonly itemId: string; readonly messageId: string;
}

function fail(message: string): never { throw new Error(`atomic import refused: ${message}`); }

export function executeAtomicImport(database: CoordinationDatabase, input: ExecuteAtomicImportInput): AtomicImportResult {
  const { binding, evidence } = input;
  const proposal = binding.m04TransactionProposal;
  if (COORDINATION_SCHEMA_VERSION !== 4 || database.openReceipt.schemaChecksum !== COORDINATION_SCHEMA_CHECKSUM) fail("schema/checksum mismatch");
  if (proposal.owner !== "M04" || proposal.status !== "proposal_only" || proposal.schema.version !== 3 || proposal.schema.checksum !== "ddac2fb83bf73837f5200725697eff7d55a685f18a6c144fc33df17b75f113c2") fail("transaction proposal is not the reviewed ready proposal");
  if (canonicalJson(proposal.requiredOrderedEvents) !== canonicalJson(["message.appended", "import.updated"])) fail("event order changed");
  if (evidence.source.registryDigest !== binding.planningReceipt.sourceRegistryDigest) fail("source registry differs from frozen manifest");
  requireCanonicalTimestamp(input.committedAt, "committedAt");
  requireSha256(binding.planningReceipt.manifestDigest, "manifest digest");
  requireSha256(binding.planningReceipt.planDigest, "planning receipt digest");
  for (const [name, digest] of Object.entries({ registry: evidence.source.registryDigest, locator: evidence.source.locatorDigest, physical: evidence.source.physicalIdentityDigest, raw: evidence.exactFingerprint.rawDigest, tail: evidence.exactFingerprint.watermark.tailDigest })) requireSha256(digest, name);
  const canonical = proposal.message.projection;
  const provenance = proposal.importProvenance;
  if (evidence.exactFingerprint.segmentIdentity !== provenance.segmentIdentity || evidence.exactFingerprint.rawDigest !== provenance.rawDigest || canonicalJson(evidence.exactFingerprint.watermark) !== canonicalJson(provenance.reviewedSourceWatermark)) fail("source fingerprint/watermark changed");
  const requestDigest = sha256(canonicalJson({ planningReceipt: binding.planningReceipt, proposal, evidence, batchId: input.batchId, itemId: input.itemId, requestId: input.requestId, correlationId: input.correlationId }));
  const existing = database.readOne<{ requestDigest: string; resultJson: string }>("SELECT request_digest AS requestDigest, result_json AS resultJson FROM import_batches WHERE id = ?", input.batchId);
  if (existing) {
    if (existing.requestDigest !== requestDigest) fail("changed replay");
    const stored = JSON.parse(existing.resultJson) as AtomicImportResult;
    return Object.freeze({ ...stored, outcome: "replayed" });
  }
  const latest = database.readOne<{ epoch: number }>("SELECT epoch FROM authority_epochs WHERE capability = 'messages' ORDER BY epoch DESC LIMIT 1");
  if (!latest || latest.epoch !== evidence.authority.epoch) fail("stale authority epoch");
  const priorItem = database.readOne<{ state: string; rawDigest: string; canonicalDigest: string }>("SELECT state,raw_digest AS rawDigest,canonical_digest AS canonicalDigest FROM import_items WHERE import_key_digest=? OR (source_id=? AND segment_identity=? AND record_key=?)", provenance.importKeyDigest, provenance.sourceId, provenance.segmentIdentity, provenance.recordKey);
  if (priorItem) fail(`terminal ledger reuse (${priorItem.state})`);
  const cursor = database.readOne<{ recordIndex: number; byteOffset: number; tailDigest: string }>("SELECT next_record_index AS recordIndex, next_byte_offset AS byteOffset, committed_tail_digest AS tailDigest FROM import_cursors WHERE source_id = ? AND segment_identity = ?", provenance.sourceId, evidence.exactFingerprint.segmentIdentity);
  if (canonicalJson(cursor ?? null) !== canonicalJson(evidence.expectedCursor)) fail("stale source watermark/cursor");
  const result: AtomicImportResult = Object.freeze({ outcome: "committed", batchId: input.batchId, itemId: input.itemId, messageId: canonical.id });
  const mutation = database.mutateWithEvent((tx) => {
    tx.run("INSERT OR IGNORE INTO legacy_sources (id,registry_digest,locator_digest,physical_identity_digest,owner_bot_id,owner_domain,source_type,source_version,parser_version,privacy_class,receipt_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", provenance.sourceId, evidence.source.registryDigest, evidence.source.locatorDigest, evidence.source.physicalIdentityDigest, evidence.source.ownerBotId, evidence.source.ownerDomain, evidence.source.sourceType, evidence.source.sourceVersion, evidence.source.parserVersion, evidence.source.privacyClass, canonicalJson(evidence.source.receipt), input.committedAt);
    const storedSource = tx.readOne<{ registryDigest: string; locatorDigest: string; physicalIdentityDigest: string }>("SELECT registry_digest AS registryDigest, locator_digest AS locatorDigest, physical_identity_digest AS physicalIdentityDigest FROM legacy_sources WHERE id = ?", provenance.sourceId);
    if (!storedSource || storedSource.registryDigest !== evidence.source.registryDigest || storedSource.locatorDigest !== evidence.source.locatorDigest || storedSource.physicalIdentityDigest !== evidence.source.physicalIdentityDigest) fail("source identity changed or duplicated");
    tx.run("INSERT OR IGNORE INTO import_cohorts (id,manifest_digest,manifest_json,reviewed_by,snapshot_at,created_at) VALUES (?,?,?,?,?,?)", binding.planningReceipt.cohortId, binding.planningReceipt.manifestDigest, canonicalJson(binding.planningReceipt), binding.planningReceipt.reviewedBy, binding.planningReceipt.snapshotAt, input.committedAt);
    const storedCohort = tx.readOne<{ digest: string }>("SELECT manifest_digest AS digest FROM import_cohorts WHERE id = ?", binding.planningReceipt.cohortId);
    if (storedCohort?.digest !== binding.planningReceipt.manifestDigest) fail("cohort manifest changed");
    tx.run("INSERT INTO import_batches (id,cohort_id,manifest_digest,plan_digest,request_digest,state,result_json,request_id,correlation_id,created_at,committed_at) VALUES (?,?,?,?,?,'active',?,?,?,?,?)", input.batchId, binding.planningReceipt.cohortId, binding.planningReceipt.manifestDigest, binding.planningReceipt.planDigest, requestDigest, canonicalJson(result), input.requestId, input.correlationId, input.committedAt, input.committedAt);
    if (input.injectFailureAfter === "ledgers") fail("injected partial failure after ledgers");
    const channel = tx.readOne<{ sequence: number }>("SELECT next_message_sequence AS sequence FROM channels WHERE id = ?", canonical.channelId);
    if (!channel) fail("target channel missing");
    tx.run("UPDATE channels SET next_message_sequence = next_message_sequence + 1, updated_at = ? WHERE id = ?", input.committedAt, canonical.channelId);
    tx.run("INSERT INTO messages (id,channel_id,channel_sequence,author_principal_id,author_kind,author_display_name,kind,body_text,stored_visibility,client_message_id,reply_to_message_id,tombstones_message_id,round_id,work_id,created_at) VALUES (?,?,?,?,?,?,?,?,'visible',?,?,?,?,?,?)", canonical.id, canonical.channelId, channel.sequence, canonical.author.principalId, canonical.author.kind, canonical.author.displayName, canonical.kind, canonical.text, canonical.clientMessageId, canonical.replyToMessageId, canonical.tombstonesMessageId, canonical.provenance.roundId, canonical.provenance.workId, canonical.createdAt);
    const alias = proposal.alias;
    if (alias.decision !== "create") fail("alias must be newly bound");
    tx.run("INSERT INTO aliases (id,namespace,alias_digest,target_type,target_id,active,created_at,updated_at) VALUES (?,?,?,?,?,1,?,?)", alias.binding.id, alias.binding.namespace, alias.binding.aliasDigest, alias.binding.targetType, alias.binding.targetId, alias.binding.createdAt, alias.binding.updatedAt);
    tx.run("INSERT INTO import_items (id,batch_id,cohort_id,source_id,segment_identity,record_key,raw_digest,import_key_digest,state,canonical_digest,target_type,target_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,'imported',?,'message',?,?,?)", input.itemId, input.batchId, binding.planningReceipt.cohortId, provenance.sourceId, provenance.segmentIdentity, provenance.recordKey, provenance.rawDigest, provenance.importKeyDigest, provenance.canonicalDigest, canonical.id, input.committedAt, input.committedAt);
    if (evidence.expectedCursor === null) tx.run("INSERT INTO import_cursors (source_id,segment_identity,next_record_index,next_byte_offset,committed_tail_digest,version,updated_at) VALUES (?,?,?,?,?,1,?)", provenance.sourceId, provenance.segmentIdentity, evidence.exactFingerprint.watermark.recordIndex, evidence.exactFingerprint.watermark.byteOffset, evidence.exactFingerprint.watermark.tailDigest, input.committedAt);
    else {
      const changed = tx.run("UPDATE import_cursors SET next_record_index=?,next_byte_offset=?,committed_tail_digest=?,version=version+1,updated_at=? WHERE source_id=? AND segment_identity=? AND next_record_index=? AND next_byte_offset=? AND committed_tail_digest=?", evidence.exactFingerprint.watermark.recordIndex, evidence.exactFingerprint.watermark.byteOffset, evidence.exactFingerprint.watermark.tailDigest, input.committedAt, provenance.sourceId, provenance.segmentIdentity, evidence.expectedCursor.recordIndex, evidence.expectedCursor.byteOffset, evidence.expectedCursor.tailDigest);
      if (changed.changes !== 1) fail("cursor compare-and-swap failed");
    }
    tx.run("INSERT INTO idempotency_records (principal_id,operation,idempotency_key_digest,request_digest,result_kind,result_ref_json,request_id,correlation_id,created_at) VALUES (?,'message.append',?,?,'message',?,?,?,?)", canonical.author.principalId, proposal.message.idempotency.keyDigest, proposal.message.idempotency.requestDigest, canonicalJson({ messageId: canonical.id, eventReference: { aggregateKind: "message", aggregateId: canonical.id, aggregateVersion: 1 } }), input.requestId, input.correlationId, input.committedAt);
    if (input.injectFailureAfter === "canonical") fail("injected partial failure after canonical writes");
    return { value: result, events: [{ type: "message.appended", aggregateKind: "message", aggregateId: canonical.id, aggregateVersion: 1, channelId: canonical.channelId, actorPrincipalId: canonical.author.principalId, requestId: input.requestId, correlationId: input.correlationId, payload: { messageId: canonical.id, imported: true }, createdAt: input.committedAt }, { type: "import.updated", aggregateKind: "import", aggregateId: input.batchId, aggregateVersion: 1, channelId: canonical.channelId, actorPrincipalId: canonical.author.principalId, requestId: input.requestId, correlationId: input.correlationId, payload: { batchId: input.batchId, state: "active", messageId: canonical.id }, createdAt: input.committedAt }] };
  });
  return mutation.value;
}
