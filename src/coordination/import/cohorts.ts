import { validateContractId } from "../schema/contract-registry.js";
import { canonicalJson, deepFreeze, requireCanonicalTimestamp, sha256 } from "./canonical.js";
import { computeSourceRegistryDigest } from "./source-registry.js";
import type {
  CohortManifest,
  CohortManifestInput,
  ImportCohort,
  LegacySourceRegistry,
} from "./types.js";

const BODY_ELIGIBLE = new Set<ImportCohort>(["H1", "H2", "H3"]);

function unsignedManifest(manifest: Omit<CohortManifest, "manifestDigest">) {
  return {
    manifestVersion: manifest.manifestVersion,
    id: manifest.id,
    snapshotAt: manifest.snapshotAt,
    recentWindowDays: manifest.recentWindowDays,
    sourceRegistryDigest: manifest.sourceRegistryDigest,
    selectorVersion: manifest.selectorVersion,
    reviewedBy: manifest.reviewedBy,
    entries: manifest.entries,
  };
}

export function assertCohortManifestIntegrity(
  manifest: CohortManifest,
  sourceRegistry?: LegacySourceRegistry,
): void {
  if (manifest.manifestVersion !== 1 || manifest.recentWindowDays !== 90) {
    throw new Error("cohort manifest version or frozen recent window is invalid");
  }
  if (!validateContractId("importCohort", manifest.id)) {
    throw new Error("cohort manifest id is invalid");
  }
  requireCanonicalTimestamp(manifest.snapshotAt, "snapshotAt");
  if (!manifest.selectorVersion) throw new Error("cohort selector version is required");
  if (!validateContractId("principal", manifest.reviewedBy)) {
    throw new Error("cohort reviewer must be a canonical principal");
  }
  if (
    sourceRegistry
    && manifest.sourceRegistryDigest !== computeSourceRegistryDigest(sourceRegistry)
  ) {
    throw new Error("source registry differs from the reviewed cohort manifest");
  }
  const positions = new Set<string>();
  for (const entry of manifest.entries) {
    if (
      !validateContractId("legacySource", entry.sourceId)
      || !entry.segmentIdentity
      || !entry.recordKey
    ) {
      throw new Error("cohort manifest source position is invalid");
    }
    if (entry.bodyDecision === "include_reviewed" && !BODY_ELIGIBLE.has(entry.cohort)) {
      throw new Error("cohort manifest violates the reviewed body policy");
    }
    if (!Number.isSafeInteger(entry.recordIndex) || entry.recordIndex < 0) {
      throw new Error("cohort manifest record index is invalid");
    }
    if (
      !Number.isSafeInteger(entry.byteOffset)
      || !Number.isSafeInteger(entry.nextByteOffset)
      || entry.byteOffset < 0
      || entry.nextByteOffset <= entry.byteOffset
    ) {
      throw new Error("cohort manifest record byte bounds are invalid");
    }
    if (!/^[a-f0-9]{64}$/.test(entry.rawDigest) || !entry.parserVersion) {
      throw new Error("cohort manifest record digest or parser version is invalid");
    }
    if (
      !Number.isSafeInteger(entry.reviewedSourceWatermark.recordIndex)
      || !Number.isSafeInteger(entry.reviewedSourceWatermark.byteOffset)
      || entry.reviewedSourceWatermark.recordIndex <= entry.recordIndex
      || entry.reviewedSourceWatermark.byteOffset < entry.nextByteOffset
      || !/^[a-f0-9]{64}$/.test(entry.reviewedSourceWatermark.tailDigest)
    ) {
      throw new Error("cohort manifest reviewed source watermark is invalid");
    }
    const position = canonicalJson({
      sourceId: entry.sourceId,
      segmentIdentity: entry.segmentIdentity,
      recordKey: entry.recordKey,
    });
    if (positions.has(position)) {
      throw new Error("cohort manifest contains a duplicate source position");
    }
    positions.add(position);
    if (sourceRegistry) {
      const registration = sourceRegistry.registration(entry.sourceId);
      if (!registration) throw new Error("cohort manifest source is not registered");
      if (!registration.allowedCohorts.includes(entry.cohort)) {
        throw new Error("cohort manifest source does not allow its selected cohort");
      }
      if (registration.reviewedBy !== manifest.reviewedBy) {
        throw new Error("cohort reviewer must match the registered source reviewer");
      }
      if (registration.parserVersion !== entry.parserVersion) {
        throw new Error("cohort manifest parser differs from its registered source");
      }
    }
  }
  const { manifestDigest: _digest, ...withoutDigest } = manifest;
  const expected = sha256(canonicalJson(unsignedManifest(withoutDigest)));
  if (manifest.manifestDigest !== expected) {
    throw new Error("cohort manifest digest does not match its frozen selection");
  }
}

export function createCohortManifest(
  input: CohortManifestInput,
  sourceRegistry: LegacySourceRegistry,
): CohortManifest {
  if (!validateContractId("importCohort", input.id)) {
    throw new Error(`invalid import cohort id: ${input.id}`);
  }
  requireCanonicalTimestamp(input.snapshotAt, "snapshotAt");
  if (!input.selectorVersion) {
    throw new Error("cohort selector version is required");
  }
  if (!validateContractId("principal", input.reviewedBy)) {
    throw new Error("cohort reviewer must be a canonical principal");
  }
  const positions = new Set<string>();
  const entries = input.entries.map((entry) => {
    if (!entry.sourceId || !entry.segmentIdentity || !entry.recordKey) {
      throw new Error("cohort entries require source, segment, and record identity");
    }
    if (entry.bodyDecision === "include_reviewed" && !BODY_ELIGIBLE.has(entry.cohort)) {
      throw new Error(`${entry.cohort} cannot import bodies`);
    }
    const registration = sourceRegistry.registration(entry.sourceId);
    if (!registration) {
      throw new Error(`source ${entry.sourceId} is not in the reviewed source registry`);
    }
    if (!registration.allowedCohorts.includes(entry.cohort)) {
      throw new Error(`source ${entry.sourceId} does not allow cohort ${entry.cohort}`);
    }
    const position = canonicalJson({
      sourceId: entry.sourceId,
      segmentIdentity: entry.segmentIdentity,
      recordKey: entry.recordKey,
    });
    if (positions.has(position)) {
      throw new Error("one source item may belong only to its highest applicable cohort");
    }
    positions.add(position);
    return { ...entry };
  }).sort((left, right) => {
    const leftCanonical = canonicalJson(left);
    const rightCanonical = canonicalJson(right);
    return leftCanonical < rightCanonical ? -1 : leftCanonical > rightCanonical ? 1 : 0;
  });
  const sourceRegistryDigest = computeSourceRegistryDigest(sourceRegistry);
  const unsigned = {
    manifestVersion: 1 as const,
    id: input.id,
    snapshotAt: input.snapshotAt,
    recentWindowDays: 90 as const,
    sourceRegistryDigest,
    selectorVersion: input.selectorVersion,
    reviewedBy: input.reviewedBy,
    entries,
  };
  const manifest = deepFreeze({
    ...unsigned,
    manifestDigest: sha256(canonicalJson(unsigned)),
  });
  assertCohortManifestIntegrity(manifest, sourceRegistry);
  return manifest;
}
