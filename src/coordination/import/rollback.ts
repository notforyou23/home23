import { canonicalJson, deepFreeze, sha256 } from "./canonical.js";
import { assertCohortManifestIntegrity } from "./cohorts.js";
import {
  computeSourceRegistryDigest,
  discoverRegisteredSource,
} from "./source-registry.js";
import type {
  CohortManifest,
  LegacySourceRegistry,
  SegmentFingerprint,
} from "./types.js";

export interface ImportRollbackItem {
  readonly importKeyDigest: string;
  readonly bodyImported: boolean;
  readonly referencedByNewActivity: boolean;
}

function immutableSourceContent(fingerprint: SegmentFingerprint) {
  return {
    sourceId: fingerprint.sourceId,
    segmentIdentity: fingerprint.segmentIdentity,
    physicalIdentityDigest: fingerprint.physicalIdentityDigest,
    byteLength: fingerprint.byteLength,
    recordCount: fingerprint.recordCount,
    firstRecordDigest: fingerprint.firstRecordDigest,
    lastRecordDigest: fingerprint.lastRecordDigest,
    tailDigest: fingerprint.tailDigest,
    fullDigest: fingerprint.fullDigest,
    records: fingerprint.records.map((record) => ({ ...record })),
    partialTail: fingerprint.partialTail ? { ...fingerprint.partialTail } : null,
    closed: fingerprint.closed,
  };
}

function sourceFingerprintDigest(fingerprint: SegmentFingerprint): string {
  return sha256(canonicalJson(immutableSourceContent(fingerprint)));
}

export function planImportCohortRollback(input: {
  readonly cohortManifest: CohortManifest;
  readonly batchId: string;
  readonly sourceRegistry: LegacySourceRegistry;
  readonly items: readonly ImportRollbackItem[];
}) {
  if (!input.batchId) throw new Error("cohort rollback batch id is required");
  assertCohortManifestIntegrity(input.cohortManifest, input.sourceRegistry);
  const sourceIds = [...new Set(
    input.cohortManifest.entries.map((entry) => entry.sourceId),
  )].sort();
  if (sourceIds.length === 0) {
    throw new Error("cohort rollback requires reviewed cohort sources");
  }
  const expectedSegments = sourceIds
    .map((sourceId) => {
      const fingerprint = discoverRegisteredSource(input.sourceRegistry, sourceId).fingerprint;
      return {
        ...immutableSourceContent(fingerprint),
        fingerprintDigest: sourceFingerprintDigest(fingerprint),
      };
    })
    .sort((left, right) => {
      const leftKey = `${left.sourceId}\0${left.segmentIdentity}`;
      const rightKey = `${right.sourceId}\0${right.segmentIdentity}`;
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
  return deepFreeze({
    rollbackVersion: 1 as const,
    cohortId: input.cohortManifest.id,
    manifestDigest: input.cohortManifest.manifestDigest,
    batchId: input.batchId,
    batchState: "inactive" as const,
    source: {
      action: "preserve_read_only" as const,
      overwriteAllowed: false as const,
      registryDigest: computeSourceRegistryDigest(input.sourceRegistry),
      expectedSegments,
    },
    preserve: [
      "import_ledger",
      "aliases",
      "provenance",
      "event_boundaries",
      "read_cursors",
      "canonical_event_history",
    ] as const,
    items: input.items.map((item) => ({
      importKeyDigest: item.importKeyDigest,
      canonicalRecord: "preserve_audit_stub" as const,
      canonicalAction: item.referencedByNewActivity
        ? "preserve_referenced_record" as const
        : item.bodyImported
          ? "deactivate_projection_and_remove_unreferenced_copied_body" as const
          : "deactivate_unreferenced_projection" as const,
    })),
  });
}

export function verifyImportCohortRollback(input: {
  readonly rollback: ReturnType<typeof planImportCohortRollback>;
  readonly sourceRegistry: LegacySourceRegistry;
  readonly cohortManifest: CohortManifest;
}) {
  if (input.rollback.source.action !== "preserve_read_only") {
    throw new Error("cohort rollback does not preserve legacy sources read-only");
  }
  assertCohortManifestIntegrity(input.cohortManifest, input.sourceRegistry);
  if (
    input.cohortManifest.id !== input.rollback.cohortId
    || input.cohortManifest.manifestDigest !== input.rollback.manifestDigest
  ) {
    throw new Error("cohort rollback differs from the reviewed cohort manifest");
  }
  const manifestSourceIds = [...new Set(
    input.cohortManifest.entries.map((entry) => entry.sourceId),
  )].sort();
  const rollbackSourceIds = input.rollback.source.expectedSegments
    .map((segment) => segment.sourceId)
    .sort();
  if (canonicalJson(rollbackSourceIds) !== canonicalJson(manifestSourceIds)) {
    throw new Error("cohort rollback source set differs from the reviewed cohort manifest");
  }
  if (
    computeSourceRegistryDigest(input.sourceRegistry)
    !== input.rollback.source.registryDigest
  ) {
    throw new Error("cohort rollback source registry differs from the planned registry");
  }
  const sources = input.rollback.source.expectedSegments.map((before) => {
    const after = discoverRegisteredSource(
      input.sourceRegistry,
      before.sourceId,
    ).fingerprint;
    if (
      after.segmentIdentity !== before.segmentIdentity
      || sourceFingerprintDigest(after) !== before.fingerprintDigest
    ) {
      throw new Error("legacy source changed during cohort rollback");
    }
    return {
      sourceId: before.sourceId,
      segmentIdentity: before.segmentIdentity,
      byteLength: before.byteLength,
      tailDigest: before.tailDigest,
      classification: "unchanged" as const,
    };
  });
  return deepFreeze({
    receiptVersion: 1 as const,
    cohortId: input.rollback.cohortId,
    batchId: input.rollback.batchId,
    manifestDigest: input.rollback.manifestDigest,
    rollbackDigest: sha256(canonicalJson(input.rollback)),
    sourceRegistryDigest: input.rollback.source.registryDigest,
    sourceMutation: "none" as const,
    sources,
  });
}
