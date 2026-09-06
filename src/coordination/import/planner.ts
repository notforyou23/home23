import { canonicalJson, deepFreeze, requireCanonicalTimestamp, requireSha256, sha256 } from "./canonical.js";
import { assertCohortManifestIntegrity } from "./cohorts.js";
import { validateContractId } from "../schema/contract-registry.js";
import type {
  CanonicalImportProjection,
  CohortManifest,
  CohortManifestEntry,
  ImportLedgerView,
  ImportPlan,
  ImportPlanItem,
  ImportSourceRecord,
  LegacySourceRegistry,
} from "./types.js";

function positionKey(value: Pick<ImportSourceRecord, "sourceId" | "segmentIdentity" | "recordKey">): string {
  return canonicalJson({
    sourceId: value.sourceId,
    segmentIdentity: value.segmentIdentity,
    recordKey: value.recordKey,
  });
}

function importKeyDigest(record: ImportSourceRecord): string {
  return sha256(canonicalJson({
    sourceId: record.sourceId,
    segmentIdentity: record.segmentIdentity,
    recordOffsetOrKey: record.recordKey,
    rawDigest: record.rawDigest,
    parserVersion: record.parserVersion,
  }));
}

function validAuthorIdentity(author: ImportSourceRecord["author"]): boolean {
  if (author.class === "owner") return author.canonicalPrincipalId === "user_owner";
  if (author.class === "bot") {
    return typeof author.canonicalPrincipalId === "string"
      && validateContractId("bot", author.canonicalPrincipalId);
  }
  if (author.class === "tool" || author.class === "system") {
    return author.canonicalPrincipalId === null;
  }
  return false;
}

function canonicalProjection(
  record: ImportSourceRecord,
  entry: CohortManifestEntry,
  manifest: CohortManifest,
  keyDigest: string,
): CanonicalImportProjection {
  const includeBody = entry.bodyDecision === "include_reviewed";
  const visibleBody = includeBody
    ? record.visibleBody?.replace(/\r\n?/g, "\n").normalize("NFC") ?? null
    : null;
  const normalizedDigest = sha256(canonicalJson({
    canonicalizationVersion: "visible-text-v1",
    author: record.author,
    canonicalKind: record.canonicalKind,
    sourceObjectKey: record.sourceObjectKey,
    sourceTimestamp: record.sourceTimestamp,
    visibleBody,
    attachmentReferences: record.attachmentReferences,
  }));
  return deepFreeze({
    canonicalizationVersion: "visible-text-v1",
    importKeyDigest: keyDigest,
    sourceId: record.sourceId,
    segmentIdentity: record.segmentIdentity,
    recordKey: record.recordKey,
    rawDigest: record.rawDigest,
    normalizedDigest,
    sourceTimestamp: record.sourceTimestamp,
    author: { ...record.author },
    canonicalKind: record.canonicalKind,
    sourceObjectKey: record.sourceObjectKey,
    bodyImported: includeBody,
    visibleBody,
    attachmentReferences: record.attachmentReferences.map((reference) => ({ ...reference })),
  });
}

function quarantine(
  entry: CohortManifestEntry,
  record: ImportSourceRecord | undefined,
  reason: string,
): ImportPlanItem {
  const fallbackDigest = sha256(canonicalJson({ entry, reason }));
  return deepFreeze({
    sourceId: entry.sourceId,
    segmentIdentity: entry.segmentIdentity,
    recordKey: entry.recordKey,
    cohort: entry.cohort,
    importKeyDigest: record ? importKeyDigest(record) : fallbackDigest,
    canonicalDigest: fallbackDigest,
    action: "quarantine",
    reason,
    canonical: null,
  });
}

export function planCohortImport(
  manifest: CohortManifest,
  sourceRecords: readonly ImportSourceRecord[],
  ledger: ImportLedgerView,
  sourceRegistry: LegacySourceRegistry,
): ImportPlan {
  assertCohortManifestIntegrity(manifest, sourceRegistry);
  const records = new Map<string, ImportSourceRecord>();
  for (const record of sourceRecords) {
    requireSha256(record.rawDigest, "source record rawDigest");
    requireCanonicalTimestamp(record.sourceTimestamp, "source record timestamp");
    const key = positionKey(record);
    if (records.has(key)) throw new Error("source records contain a duplicate source position");
    records.set(key, record);
  }

  const items = manifest.entries.map((entry): ImportPlanItem => {
    const record = records.get(positionKey(entry));
    if (!record) return quarantine(entry, undefined, "selected_source_record_missing");
    if (
      record.recordIndex !== entry.recordIndex
      || record.byteOffset !== entry.byteOffset
      || record.nextByteOffset !== entry.nextByteOffset
      || record.rawDigest !== entry.rawDigest
      || record.parserVersion !== entry.parserVersion
      || canonicalJson(record.discoveredWatermark) !== canonicalJson(entry.reviewedSourceWatermark)
    ) {
      return quarantine(entry, record, "reviewed_record_changed");
    }
    const keyDigest = importKeyDigest(record);
    const existingAtPosition = ledger.findBySourcePosition(
      record.sourceId,
      record.segmentIdentity,
      record.recordKey,
    );
    if (existingAtPosition && existingAtPosition.rawDigest !== record.rawDigest) {
      return quarantine(entry, record, "historical_record_changed");
    }
    if (existingAtPosition && existingAtPosition.importKeyDigest !== keyDigest) {
      return quarantine(entry, record, "source_position_identity_mismatch");
    }
    if (record.author.class === "ambiguous") {
      return quarantine(entry, record, "ambiguous_authorship");
    }
    if (!validAuthorIdentity(record.author)) {
      return quarantine(entry, record, "invalid_author_identity");
    }
    if (
      entry.bodyDecision === "include_reviewed"
      && (record.author.class === "tool" || record.author.class === "system")
    ) {
      return quarantine(entry, record, "non_authored_record_cannot_become_product_body");
    }
    if (entry.bodyDecision === "include_reviewed" && record.visibleBody === null) {
      return quarantine(entry, record, "reviewed_body_missing");
    }
    if (entry.cohort === "H2") {
      const snapshot = new Date(manifest.snapshotAt).getTime();
      const sourceTime = new Date(record.sourceTimestamp).getTime();
      const earliest = snapshot - manifest.recentWindowDays * 24 * 60 * 60 * 1_000;
      if (sourceTime < earliest || sourceTime > snapshot) {
        return quarantine(entry, record, "outside_frozen_h2_window");
      }
    }
    if (entry.cohort === "H5") {
      return deepFreeze({
        sourceId: record.sourceId,
        segmentIdentity: record.segmentIdentity,
        recordKey: record.recordKey,
        cohort: entry.cohort,
        importKeyDigest: keyDigest,
        canonicalDigest: keyDigest,
        action: "skip",
        reason: "internal_or_ambiguous_cohort",
        canonical: null,
      });
    }

    const canonical = canonicalProjection(record, entry, manifest, keyDigest);
    const projectionDigest = sha256(canonicalJson(canonical));
    const existing = ledger.findByNaturalKey(keyDigest);
    if (existing?.state === "quarantined") {
      return deepFreeze({
        sourceId: record.sourceId,
        segmentIdentity: record.segmentIdentity,
        recordKey: record.recordKey,
        cohort: entry.cohort,
        importKeyDigest: keyDigest,
        canonicalDigest: existing.canonicalDigest,
        action: "quarantine",
        reason: "ledger_item_quarantined",
        canonical: null,
      });
    }
    if (existing?.state === "rolled_back" || existing?.state === "skipped_with_reason") {
      return deepFreeze({
        sourceId: record.sourceId,
        segmentIdentity: record.segmentIdentity,
        recordKey: record.recordKey,
        cohort: entry.cohort,
        importKeyDigest: keyDigest,
        canonicalDigest: existing.canonicalDigest,
        action: "skip",
        reason: existing.state === "rolled_back"
          ? "ledger_item_rolled_back"
          : "ledger_item_skipped",
        canonical: null,
      });
    }
    if (existing && existing.canonicalDigest !== projectionDigest) {
      return quarantine(entry, record, "ledger_canonical_digest_mismatch");
    }
    return deepFreeze({
      sourceId: record.sourceId,
      segmentIdentity: record.segmentIdentity,
      recordKey: record.recordKey,
      cohort: entry.cohort,
      importKeyDigest: keyDigest,
      canonicalDigest: projectionDigest,
      action: existing?.state === "imported" || existing?.state === "verified"
        ? "already_imported"
        : "insert",
      reason: null,
      canonical,
    });
  });

  const bodyBytes = items.reduce((total, item) => (
    total + (item.canonical?.visibleBody === null || item.canonical?.visibleBody === undefined
      ? 0
      : Buffer.byteLength(item.canonical.visibleBody, "utf8"))
  ), 0);
  const planCore = {
    planVersion: 1 as const,
    cohortId: manifest.id,
    manifestDigest: manifest.manifestDigest,
    selectionSnapshotAt: manifest.snapshotAt,
    items,
    counts: {
      selected: items.length,
      inserted: items.filter((item) => item.action === "insert").length,
      alreadyImported: items.filter((item) => item.action === "already_imported").length,
      quarantined: items.filter((item) => item.action === "quarantine").length,
      skipped: items.filter((item) => item.action === "skip").length,
      bodyBytes,
    },
  };
  const canonicalDigest = sha256(canonicalJson(items.map((item) => item.canonical)));
  return deepFreeze({ ...planCore, canonicalDigest });
}
