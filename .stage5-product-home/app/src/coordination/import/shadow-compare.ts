import {
  API_OPERATION_REGISTRY,
  AUTHORITY_EPOCH_REGISTRY,
  validateContractId,
} from "../schema/contract-registry.js";
import {
  canonicalJson,
  deepFreeze,
  requireCanonicalTimestamp,
  requireSha256,
  sha256,
} from "./canonical.js";
import { classifySegmentChange } from "./fingerprints.js";
import type { CanonicalSearchResponse, SearchCompleteness } from "../search/index.js";
import type {
  AuthorityCapability,
  AuthorityMode,
  ImportSourceWatermark,
  SegmentFingerprint,
} from "./types.js";

export interface ShadowComparableRecord {
  readonly stableKey: string;
  readonly sourceRecordIndex: number;
  readonly sourceRecordDigest: string;
  readonly speakerKey: string;
  readonly normalizedDigest: string;
  readonly attachmentCount: number;
  readonly availableAttachmentCount: number;
}

export type ShadowMismatchClassification =
  | "source_changed"
  | "projection_lag"
  | "alias_ambiguity"
  | "search_route_blind"
  | "content_mismatch";

export interface ShadowCompareInput {
  readonly sourceId: string;
  readonly capability: AuthorityCapability;
  readonly authority: { readonly mode: AuthorityMode; readonly epoch: number; readonly writer: string };
  readonly range: { readonly startRecordIndex: number; readonly endRecordIndexExclusive: number };
  readonly sourceFingerprintBefore: SegmentFingerprint;
  readonly sourceFingerprintAfter: SegmentFingerprint;
  readonly sourceWatermarkBefore: ImportSourceWatermark;
  readonly sourceWatermarkAfter: ImportSourceWatermark;
  readonly canonicalWatermark: {
    readonly eventSequence: number;
    readonly messageCount: number;
    readonly projectedSourceRecordIndex: number;
  };
  readonly includedClasses: readonly string[];
  readonly excludedClasses: readonly string[];
  readonly privacyFilters: readonly string[];
  readonly aliasMappingVersion: string;
  readonly aliasAmbiguities: readonly string[];
  readonly collisions: readonly string[];
  readonly quarantines: readonly string[];
  readonly excludedStableKeys?: readonly string[];
  readonly sourceRecords: readonly ShadowComparableRecord[];
  readonly canonicalRecords: readonly ShadowComparableRecord[];
  readonly samePathCanary?: {
    readonly operationId: string;
    readonly route: string;
    readonly queryDigest: string;
    readonly passed: boolean;
  };
  /** Actual response returned by the canonical M09 same-path search service. */
  readonly searchResponse?: CanonicalSearchResponse;
}

function nonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function validateFingerprint(fingerprint: SegmentFingerprint, sourceId: string): void {
  if (fingerprint.sourceId !== sourceId) throw new Error("shadow fingerprint source id mismatch");
  requireSha256(fingerprint.segmentIdentity, "shadow fingerprint segment identity");
  requireSha256(fingerprint.physicalIdentityDigest, "shadow fingerprint physical identity");
  requireSha256(fingerprint.tailDigest, "shadow fingerprint tailDigest");
  requireCanonicalTimestamp(fingerprint.modifiedAt, "shadow fingerprint modifiedAt");
  if (
    !nonNegativeInteger(fingerprint.byteLength)
    || fingerprint.recordCount !== fingerprint.records.length
  ) {
    throw new Error("shadow fingerprint count or byte length is invalid");
  }
  let nextExpectedOffset = 0;
  for (const [index, record] of fingerprint.records.entries()) {
    if (
      record.recordIndex !== index
      || record.byteOffset !== nextExpectedOffset
      || !nonNegativeInteger(record.nextByteOffset)
      || record.nextByteOffset <= record.byteOffset
      || record.nextByteOffset > fingerprint.byteLength
      || typeof record.terminated !== "boolean"
      || (!record.terminated && (!fingerprint.closed || index !== fingerprint.records.length - 1))
    ) {
      throw new Error("shadow fingerprint record boundary is invalid");
    }
    requireSha256(record.digest, "shadow fingerprint record digest");
    requireSha256(record.tailDigest, "shadow fingerprint record tail digest");
    nextExpectedOffset = record.nextByteOffset;
  }
  if (
    fingerprint.firstRecordDigest !== (fingerprint.records[0]?.digest ?? null)
    || fingerprint.lastRecordDigest !== (fingerprint.records.at(-1)?.digest ?? null)
  ) {
    throw new Error("shadow fingerprint first or last digest is invalid");
  }
  if (fingerprint.partialTail) {
    if (
      fingerprint.closed
      || fingerprint.partialTail.byteOffset !== nextExpectedOffset
      || !Number.isSafeInteger(fingerprint.partialTail.byteLength)
      || fingerprint.partialTail.byteLength < 1
      || fingerprint.partialTail.byteOffset + fingerprint.partialTail.byteLength
        !== fingerprint.byteLength
    ) {
      throw new Error("shadow fingerprint partial tail is invalid");
    }
    requireSha256(fingerprint.partialTail.digest, "shadow fingerprint partial tail digest");
  } else if (nextExpectedOffset !== fingerprint.byteLength) {
    throw new Error("shadow fingerprint record boundary does not reach its byte length");
  }
  if (fingerprint.closed) {
    if (fingerprint.fullDigest !== fingerprint.tailDigest) {
      throw new Error("closed shadow fingerprint full digest is invalid");
    }
  } else if (fingerprint.fullDigest !== null) {
    throw new Error("open shadow fingerprint cannot claim a full digest");
  }
  if (
    !fingerprint.partialTail
    && fingerprint.records.length > 0
    && fingerprint.records.at(-1)?.tailDigest !== fingerprint.tailDigest
  ) {
    throw new Error("shadow fingerprint final record tail digest is invalid");
  }
}

function validateWatermark(
  watermark: ImportSourceWatermark,
  fingerprint: SegmentFingerprint,
  field: string,
): void {
  requireSha256(watermark.tailDigest, `${field} tailDigest`);
  if (
    watermark.recordIndex !== fingerprint.recordCount
    || watermark.byteOffset !== fingerprint.byteLength
    || watermark.tailDigest !== fingerprint.tailDigest
  ) {
    throw new Error(`${field} does not match its source fingerprint`);
  }
}

function validateRecords(records: readonly ShadowComparableRecord[], label: string): void {
  const stableKeys = new Set<string>();
  for (const record of records) {
    if (
      !record.stableKey
      || !record.speakerKey
      || !nonNegativeInteger(record.sourceRecordIndex)
      || stableKeys.has(record.stableKey)
    ) {
      throw new Error(`${label} has a missing or duplicate stable key`);
    }
    stableKeys.add(record.stableKey);
    requireSha256(record.sourceRecordDigest, `${label} sourceRecordDigest`);
    requireSha256(record.normalizedDigest, `${label} normalizedDigest`);
    if (
      !nonNegativeInteger(record.attachmentCount)
      || !nonNegativeInteger(record.availableAttachmentCount)
      || record.availableAttachmentCount > record.attachmentCount
    ) {
      throw new Error(`${label} attachment counts are invalid`);
    }
  }
}

const ROUTE_ID_KINDS: Record<string, Parameters<typeof validateContractId>[0]> = {
  botId: "bot",
  channelId: "channel",
  artifactId: "artifact",
  workId: "work",
  pairingSessionId: "pairingSession",
};

function routeMatchesTemplate(template: string, route: string): boolean {
  const expected = template.split("/");
  const actual = route.split("/");
  if (expected.length !== actual.length) return false;
  return expected.every((segment, index) => {
    const placeholder = /^\{([^}]+)\}$/.exec(segment)?.[1];
    if (!placeholder) return segment === actual[index];
    const idKind = ROUTE_ID_KINDS[placeholder];
    return Boolean(idKind && actual[index] && validateContractId(idKind, actual[index]!));
  });
}

function samePathCanaryValid(
  canary: NonNullable<ShadowCompareInput["samePathCanary"]>,
  capability: AuthorityCapability,
): boolean {
  const operation = API_OPERATION_REGISTRY[
    canary.operationId as keyof typeof API_OPERATION_REGISTRY
  ];
  return Boolean(
    operation
    && operation.authorityCapability === capability
    && routeMatchesTemplate(operation.path, canary.route),
  );
}

function validateEvidenceLabels(values: readonly string[], field: string): void {
  if (values.length === 0 || new Set(values).size !== values.length) {
    throw new Error(`shadow ${field} must be a nonempty duplicate-free list`);
  }
  if (values.some((value) => value.length === 0 || value.length > 256 || value.includes("\0"))) {
    throw new Error(`shadow ${field} contains an invalid value`);
  }
}

function validateInput(input: ShadowCompareInput): void {
  if (!validateContractId("legacySource", input.sourceId)) {
    throw new Error("shadow comparison source id is invalid");
  }
  if (
    !AUTHORITY_EPOCH_REGISTRY.capabilities.includes(input.capability)
    || input.authority.mode !== "shadow"
    || !Number.isSafeInteger(input.authority.epoch)
    || input.authority.epoch < 1
    || !input.authority.writer
  ) {
    throw new Error("shadow comparison authority is invalid");
  }
  validateFingerprint(input.sourceFingerprintBefore, input.sourceId);
  validateFingerprint(input.sourceFingerprintAfter, input.sourceId);
  validateWatermark(input.sourceWatermarkBefore, input.sourceFingerprintBefore, "source watermark before");
  validateWatermark(input.sourceWatermarkAfter, input.sourceFingerprintAfter, "source watermark after");
  if (
    !nonNegativeInteger(input.range.startRecordIndex)
    || !nonNegativeInteger(input.range.endRecordIndexExclusive)
    || input.range.endRecordIndexExclusive < input.range.startRecordIndex
    || input.range.endRecordIndexExclusive > input.sourceFingerprintBefore.recordCount
    || input.sourceRecords.length
      !== input.range.endRecordIndexExclusive - input.range.startRecordIndex
  ) {
    throw new Error("shadow comparable range is invalid");
  }
  if (
    !nonNegativeInteger(input.canonicalWatermark.eventSequence)
    || input.canonicalWatermark.messageCount !== input.canonicalRecords.length
    || !nonNegativeInteger(input.canonicalWatermark.projectedSourceRecordIndex)
    || input.canonicalWatermark.projectedSourceRecordIndex > input.sourceFingerprintAfter.recordCount
  ) {
    throw new Error("shadow canonical message count or watermark is invalid");
  }
  if (!input.aliasMappingVersion) {
    throw new Error("shadow comparison mapping version and privacy filters are required");
  }
  validateEvidenceLabels(input.includedClasses, "included classes");
  validateEvidenceLabels(input.excludedClasses, "excluded classes");
  validateEvidenceLabels(input.privacyFilters, "privacy filters");
  if (input.includedClasses.some((value) => input.excludedClasses.includes(value))) {
    throw new Error("shadow record classes cannot be both included and excluded");
  }
  validateRecords(input.sourceRecords, "shadow source records");
  validateRecords(input.canonicalRecords, "shadow canonical records");
  for (const [offset, record] of input.sourceRecords.entries()) {
    const sourceRecordIndex = input.range.startRecordIndex + offset;
    const fingerprintRecord = input.sourceFingerprintBefore.records[sourceRecordIndex];
    if (
      record.sourceRecordIndex !== sourceRecordIndex
      || record.sourceRecordDigest !== fingerprintRecord?.digest
    ) {
      throw new Error("shadow source record does not match the source fingerprint");
    }
  }
  if (input.capability === "search" && !input.samePathCanary) {
    throw new Error("search shadow comparison requires a same-path canary");
  }
  if (input.samePathCanary) {
    if (!samePathCanaryValid(input.samePathCanary, input.capability)) {
      throw new Error("shadow canary does not name a registered same-path route");
    }
    requireSha256(input.samePathCanary.queryDigest, "shadow same-path canary queryDigest");
  }
  if (input.capability === "search" && !input.searchResponse) {
    throw new Error("search shadow comparison requires M09 search response evidence");
  }
  if (input.searchResponse) {
    const response = input.searchResponse;
    const visibility = response.completeness;
    const expectedScope = visibility.filters.scope === "all"
      ? "all"
      : `channel:${visibility.filters.channelId}`;
    if (
      input.capability !== "search"
      || !validateContractId("request", response.requestId)
      || !validateContractId("correlation", response.correlationId)
      || typeof response.query !== "string"
      || sha256(response.query) !== input.samePathCanary?.queryDigest
      || response.scope !== expectedScope
      || !nonNegativeInteger(response.throughEventSequence)
      || response.throughEventSequence < visibility.sourceEventSequence
      || visibility.respondingRoute !== "/api/v1/search"
      || visibility.respondingRoute !== input.samePathCanary?.route
      || visibility.authoritativeSource !== "coordination.messages"
      || visibility.indexRoute !== "sqlite_fts5"
      || visibility.sourceEventSequence !== input.canonicalWatermark.eventSequence
      || !nonNegativeInteger(visibility.sourceEventSequence)
      || !nonNegativeInteger(visibility.indexedThroughEventSequence)
      || !nonNegativeInteger(visibility.crossingProof.sourceRows)
      || !nonNegativeInteger(visibility.crossingProof.indexedRows)
      || visibility.crossingProof.sourceRows < input.canonicalRecords.length
      || !validateContractId("principal", visibility.filters.principalId)
      || canonicalJson(visibility.filters.sourceClasses) !== canonicalJson(["coordination.messages"])
      || visibility.filters.membership !== "active"
      || visibility.filters.visibility !== "visible_not_tombstoned"
      || !visibility.samePathCanary.id
      || typeof visibility.samePathCanary.found !== "boolean"
      || visibility.samePathCanary.found !== input.samePathCanary?.passed
      || !["complete", "partial"].includes(visibility.status)
      || !["complete", "scoped_empty", "route_blind"].includes(visibility.verdict)
      || visibility.importCoverage.bodyImported !== 0
      || visibility.importCoverage.referenceOnly !== 0
      || !visibility.reason
    ) {
      throw new Error("M09 search visibility evidence is malformed or unbound");
    }
    requireCanonicalTimestamp(
      visibility.crossingProof.checkedAt,
      "search visibility crossing checkedAt",
    );
    requireCanonicalTimestamp(
      visibility.samePathCanary.checkedAt,
      "search visibility canary checkedAt",
    );
    if (
      visibility.filters.scope === "channel"
        ? !visibility.filters.channelId
          || !validateContractId("channel", visibility.filters.channelId)
        : visibility.filters.scope !== "all" || visibility.filters.channelId !== null
    ) {
      throw new Error("M09 search visibility scope is malformed");
    }
  }
}

function copySearchVisibility(value: SearchCompleteness): SearchCompleteness {
  return {
    ...value,
    crossingProof: { ...value.crossingProof },
    filters: {
      ...value.filters,
      sourceClasses: ["coordination.messages"],
    },
    samePathCanary: { ...value.samePathCanary },
    importCoverage: { ...value.importCoverage },
  };
}

export function compareShadowRead(input: ShadowCompareInput) {
  validateInput(input);
  const mismatches: Array<{
    classification: ShadowMismatchClassification;
    stableKey: string | null;
    detail: string;
  }> = [];
  const sourceChange = classifySegmentChange(
    input.sourceFingerprintBefore,
    input.sourceFingerprintAfter,
  );
  if (["rotation", "historical_edit", "truncation"].includes(sourceChange.kind)) {
    mismatches.push({
      classification: "source_changed",
      stableKey: null,
      detail: `source changed during comparable range: ${sourceChange.kind}`,
    });
  }
  const lagRecords = Math.max(
    0,
    input.range.endRecordIndexExclusive - input.canonicalWatermark.projectedSourceRecordIndex,
  );
  if (lagRecords > 0) {
    mismatches.push({
      classification: "projection_lag",
      stableKey: null,
      detail: `canonical projection is ${lagRecords} source records behind`,
    });
  }
  for (const alias of [...input.aliasAmbiguities, ...input.collisions]) {
    mismatches.push({
      classification: "alias_ambiguity",
      stableKey: alias,
      detail: "legacy identity is ambiguous or collides",
    });
  }
  if (input.quarantines.length > 0) {
    mismatches.push({
      classification: "source_changed",
      stableKey: null,
      detail: `${input.quarantines.length} compared source ranges are quarantined`,
    });
  }

  const excluded = new Set(input.excludedStableKeys ?? []);
  if (excluded.size !== (input.excludedStableKeys?.length ?? 0)) {
    throw new Error("shadow exclusions contain duplicate stable keys");
  }
  const sourceKeys = new Set(input.sourceRecords.map((record) => record.stableKey));
  for (const stableKey of excluded) {
    if (!sourceKeys.has(stableKey)) throw new Error("shadow exclusion does not name a source record");
  }
  const comparableSource = input.sourceRecords.filter((record) => !excluded.has(record.stableKey));
  const length = Math.max(comparableSource.length, input.canonicalRecords.length);
  for (let index = 0; index < length; index += 1) {
    const source = comparableSource[index];
    const canonical = input.canonicalRecords[index];
    if (!source || !canonical || canonicalJson(source) !== canonicalJson(canonical)) {
      mismatches.push({
        classification: "content_mismatch",
        stableKey: source?.stableKey ?? canonical?.stableKey ?? null,
        detail: "ordered speaker, digest, or attachment projection differs",
      });
    }
  }
  if (input.samePathCanary && !input.samePathCanary.passed) {
    mismatches.push({ classification: "content_mismatch", stableKey: null, detail: "same-path canary failed" });
  }
  const searchVisibility = input.searchResponse?.completeness;
  if (searchVisibility && (
    searchVisibility.status !== "complete"
    || searchVisibility.verdict === "route_blind"
    || searchVisibility.sourceEventSequence
      !== searchVisibility.indexedThroughEventSequence
    || searchVisibility.crossingProof.sourceRows
      !== searchVisibility.crossingProof.indexedRows
    || !searchVisibility.samePathCanary.found
  )) {
    mismatches.push({
      classification: "search_route_blind",
      stableKey: null,
      detail: "M09 route, source/index watermark, crossing, or same-path canary is incomplete",
    });
  }

  const attachmentTotals = (records: readonly ShadowComparableRecord[]) => records.reduce(
    (total, record) => ({
      references: total.references + record.attachmentCount,
      available: total.available + record.availableAttachmentCount,
    }),
    { references: 0, available: 0 },
  );
  return deepFreeze({
    receiptVersion: 1 as const,
    sourceId: input.sourceId,
    capability: input.capability,
    authority: { ...input.authority },
    range: { ...input.range },
    sourceChange,
    sourceWatermarkBefore: { ...input.sourceWatermarkBefore },
    sourceWatermarkAfter: { ...input.sourceWatermarkAfter },
    canonicalWatermark: { ...input.canonicalWatermark },
    includedClasses: [...input.includedClasses],
    excludedClasses: [...input.excludedClasses],
    privacyFilters: [...input.privacyFilters],
    aliasMappingVersion: input.aliasMappingVersion,
    orderedMessageCount: {
      source: comparableSource.length,
      canonical: input.canonicalRecords.length,
    },
    orderedDigest: {
      source: sha256(canonicalJson(comparableSource)),
      canonical: sha256(canonicalJson(input.canonicalRecords)),
    },
    attachments: {
      source: attachmentTotals(comparableSource),
      canonical: attachmentTotals(input.canonicalRecords),
    },
    expectedExclusions: [...excluded].sort(),
    samePathCanary: input.samePathCanary ? { ...input.samePathCanary } : null,
    searchVisibility: searchVisibility
      ? copySearchVisibility(searchVisibility)
      : null,
    searchObservation: input.searchResponse
      ? {
          requestId: input.searchResponse.requestId,
          correlationId: input.searchResponse.correlationId,
          queryDigest: input.samePathCanary!.queryDigest,
          scope: input.searchResponse.scope,
          throughEventSequence: input.searchResponse.throughEventSequence,
        }
      : null,
    lagRecords,
    collisionCount: input.collisions.length,
    quarantineCount: input.quarantines.length,
    driftCount: mismatches.length,
    mismatches,
    verdict: mismatches.length === 0 ? "match" as const : "blocked" as const,
  });
}
