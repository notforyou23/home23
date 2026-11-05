export type AuthorityCapability =
  | "messages"
  | "roster"
  | "unread"
  | "search"
  | "attachments"
  | "activity"
  | "bot_lifecycle";

export type AuthorityMode = "legacy" | "shadow" | "canonical";
export type ImportCohort = "H0" | "H1" | "H2" | "H3" | "H4" | "H5";

export type LegacySourceType =
  | "conversation_jsonl"
  | "session_turn_jsonl"
  | "workspace_session_jsonl"
  | "upload_chat_manifest";

export interface LegacySourceRegistration {
  readonly sourceId: string;
  readonly owner: {
    readonly residentId: string;
    readonly residentBotId: string;
    readonly domain: string;
  };
  readonly locator: {
    readonly kind: "exact_file";
    readonly absolutePath: string;
  };
  readonly sourceType: LegacySourceType;
  readonly sourceVersion: string;
  readonly parserVersion: string;
  readonly privacyClass: "resident_private" | "owner_private" | "house_shared";
  readonly allowedCohorts: readonly ImportCohort[];
  readonly reviewedBy: string;
  readonly authority: {
    readonly capability: AuthorityCapability;
    readonly mode: AuthorityMode;
    readonly epoch: number;
    readonly writer: string;
  };
  readonly appendOnlyTailing: "disabled" | "reviewed_safe";
  readonly segmentState?: "open" | "closed";
  readonly maxRecordBytes: number;
}

export interface LegacySourceRegistryReceipt {
  readonly sourceId: string;
  readonly owner: LegacySourceRegistration["owner"];
  readonly locatorDigest: string;
  readonly sourceType: LegacySourceType;
  readonly sourceVersion: string;
  readonly parserVersion: string;
  readonly privacyClass: LegacySourceRegistration["privacyClass"];
  readonly allowedCohorts: readonly ImportCohort[];
  readonly reviewedBy: string;
  readonly authority: LegacySourceRegistration["authority"];
  readonly appendOnlyTailing: LegacySourceRegistration["appendOnlyTailing"];
  readonly segmentState: "open" | "closed";
  readonly maxRecordBytes: number;
}

export interface LegacySourceRegistry {
  receipts(): readonly LegacySourceRegistryReceipt[];
  registration(sourceId: string): LegacySourceRegistration | undefined;
}

export interface SegmentRecordFingerprint {
  readonly recordIndex: number;
  readonly byteOffset: number;
  readonly nextByteOffset: number;
  readonly digest: string;
  /** Digest of every source byte through `nextByteOffset`, used by crash cursors. */
  readonly tailDigest: string;
  readonly terminated: boolean;
}

export interface PartialSegmentTail {
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly digest: string;
}

export interface SegmentFingerprint {
  readonly sourceId: string;
  readonly segmentIdentity: string;
  readonly physicalIdentityDigest: string;
  readonly byteLength: number;
  readonly modifiedAt: string;
  readonly recordCount: number;
  readonly firstRecordDigest: string | null;
  readonly lastRecordDigest: string | null;
  readonly tailDigest: string;
  readonly fullDigest: string | null;
  readonly records: readonly SegmentRecordFingerprint[];
  readonly partialTail: PartialSegmentTail | null;
  readonly closed: boolean;
}

export interface ImportSourceWatermark {
  readonly recordIndex: number;
  readonly byteOffset: number;
  readonly tailDigest: string;
}

export interface DiscoveredLegacySource {
  readonly source: LegacySourceRegistryReceipt;
  readonly fingerprint: SegmentFingerprint;
  readonly watermark: ImportSourceWatermark;
}

export interface QuarantineRange {
  readonly startRecordIndex: number;
  readonly endRecordIndexExclusive: number;
  readonly reason:
    | "historical_record_digest_changed"
    | "historical_records_truncated"
    | "closed_segment_changed";
}

export type SegmentChangeClassification =
  | { readonly kind: "unchanged"; readonly quarantine: readonly [] }
  | {
      readonly kind: "append";
      readonly quarantine: readonly [];
      readonly appendedRecordRange: { readonly start: number; readonly endExclusive: number };
    }
  | {
      readonly kind: "rotation";
      readonly quarantine: readonly [];
      readonly previousSegmentIdentity: string;
      readonly nextSegmentIdentity: string;
    }
  | { readonly kind: "historical_edit"; readonly quarantine: readonly QuarantineRange[] }
  | { readonly kind: "truncation"; readonly quarantine: readonly QuarantineRange[] };

export interface CohortManifestEntry {
  readonly sourceId: string;
  readonly segmentIdentity: string;
  readonly recordKey: string;
  readonly recordIndex: number;
  readonly byteOffset: number;
  readonly nextByteOffset: number;
  readonly rawDigest: string;
  readonly parserVersion: string;
  readonly reviewedSourceWatermark: ImportSourceWatermark;
  readonly cohort: ImportCohort;
  readonly bodyDecision: "reference_only" | "include_reviewed";
}

export interface CohortManifestInput {
  readonly id: string;
  readonly snapshotAt: string;
  readonly selectorVersion: string;
  readonly reviewedBy: string;
  readonly entries: readonly CohortManifestEntry[];
}

export interface CohortManifest extends CohortManifestInput {
  readonly manifestVersion: 1;
  readonly recentWindowDays: 90;
  readonly sourceRegistryDigest: string;
  readonly entries: readonly CohortManifestEntry[];
  readonly manifestDigest: string;
}

export type ImportAuthorClass = "owner" | "bot" | "tool" | "system" | "ambiguous";

export interface ImportSourceRecord {
  readonly sourceId: string;
  readonly segmentIdentity: string;
  readonly recordKey: string;
  readonly recordIndex: number;
  readonly byteOffset: number;
  readonly nextByteOffset: number;
  readonly rawDigest: string;
  readonly parserVersion: string;
  readonly sourceTimestamp: string;
  readonly author: {
    readonly class: ImportAuthorClass;
    readonly canonicalPrincipalId: string | null;
  };
  readonly canonicalKind: "message" | "conversation" | "attachment" | "provenance";
  readonly sourceObjectKey: string;
  readonly visibleBody: string | null;
  readonly attachmentReferences: readonly {
    readonly sourceKey: string;
    readonly contentDigest: string | null;
    readonly availability: "available" | "unavailable";
  }[];
  readonly discoveredWatermark: ImportSourceWatermark;
}

export interface CanonicalImportProjection {
  readonly canonicalizationVersion: "visible-text-v1";
  readonly importKeyDigest: string;
  readonly sourceId: string;
  readonly segmentIdentity: string;
  readonly recordKey: string;
  readonly rawDigest: string;
  readonly normalizedDigest: string;
  readonly sourceTimestamp: string;
  readonly author: ImportSourceRecord["author"];
  readonly canonicalKind: ImportSourceRecord["canonicalKind"];
  readonly sourceObjectKey: string;
  readonly bodyImported: boolean;
  readonly visibleBody: string | null;
  readonly attachmentReferences: ImportSourceRecord["attachmentReferences"];
}

export type ImportLedgerState =
  | "discovered"
  | "selected"
  | "imported"
  | "verified"
  | "quarantined"
  | "rolled_back"
  | "skipped_with_reason";

export interface ImportLedgerEntry {
  readonly importKeyDigest: string;
  readonly sourceId: string;
  readonly segmentIdentity: string;
  readonly recordKey: string;
  readonly rawDigest: string;
  readonly state: ImportLedgerState;
  readonly canonicalDigest: string;
}

export interface ImportLedgerView {
  findByNaturalKey(importKeyDigest: string): ImportLedgerEntry | undefined;
  findBySourcePosition(
    sourceId: string,
    segmentIdentity: string,
    recordKey: string,
  ): ImportLedgerEntry | undefined;
}

export interface ImportCursor {
  readonly sourceId: string;
  readonly segmentIdentity: string;
  readonly nextRecordIndex: number;
  readonly nextByteOffset: number;
  readonly committedTailDigest: string;
}

export interface ImportLedgerCommit {
  readonly batchId: string;
  readonly cohortId: string;
  readonly manifestDigest: string;
  /** Actual commit time, deliberately outside immutable canonical content identity. */
  readonly committedAt: string;
  readonly expectedCursor: ImportCursor | null;
  readonly nextCursor: ImportCursor;
  readonly items: readonly ImportLedgerEntry[];
  readonly canonicalEffects: readonly {
    readonly importKeyDigest: string;
    readonly canonicalDigest: string;
    readonly effect: "insert" | "reuse" | "quarantine" | "skip";
  }[];
}

export interface ImportLedger extends ImportLedgerView {
  loadCursor(sourceId: string, segmentIdentity: string): ImportCursor | undefined;
  commitAtomically(commit: ImportLedgerCommit): {
    readonly committed: boolean;
    readonly replayed: boolean;
    readonly nextCursor: ImportCursor;
  };
}

export interface ImportPlanItem {
  readonly sourceId: string;
  readonly segmentIdentity: string;
  readonly recordKey: string;
  readonly cohort: ImportCohort;
  readonly importKeyDigest: string;
  readonly canonicalDigest: string;
  readonly action: "insert" | "already_imported" | "quarantine" | "skip";
  readonly reason: string | null;
  readonly canonical: CanonicalImportProjection | null;
}

export interface ImportPlan {
  readonly planVersion: 1;
  readonly cohortId: string;
  readonly manifestDigest: string;
  readonly selectionSnapshotAt: string;
  readonly canonicalDigest: string;
  readonly items: readonly ImportPlanItem[];
  readonly counts: {
    readonly selected: number;
    readonly inserted: number;
    readonly alreadyImported: number;
    readonly quarantined: number;
    readonly skipped: number;
    readonly bodyBytes: number;
  };
}
