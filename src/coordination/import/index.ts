export { canonicalJson, deepFreeze, requireCanonicalTimestamp, requireSha256, sha256 } from "./canonical.js";
export { assertCohortManifestIntegrity, createCohortManifest } from "./cohorts.js";
export { createResumePlan, type ImportResumePlan } from "./cursors.js";
export { classifySegmentChange } from "./fingerprints.js";
export {
  bindCanonicalImportMessage,
  type BindCanonicalImportMessageInput,
  type CanonicalImportMessageBinding,
} from "./materialization.js";
export { planCohortImport } from "./planner.js";
export {
  planImportCohortRollback,
  verifyImportCohortRollback,
  type ImportRollbackItem,
} from "./rollback.js";
export {
  computeImportSchemaDeltaDigest,
  IMPORT_SCHEMA_DELTA_CANONICAL_JSON,
  IMPORT_SCHEMA_DELTA_PROPOSAL,
  IMPORT_SCHEMA_DELTA_SHA256,
} from "./schema-delta.js";
export { compareShadowRead, type ShadowComparableRecord, type ShadowCompareInput, type ShadowMismatchClassification } from "./shadow-compare.js";
export { computeSourceRegistryDigest, createLegacySourceRegistry, discoverRegisteredSource } from "./source-registry.js";
export type {
  AuthorityCapability,
  AuthorityMode,
  CanonicalImportProjection,
  CohortManifest,
  CohortManifestEntry,
  CohortManifestInput,
  DiscoveredLegacySource,
  ImportCohort,
  ImportCursor,
  ImportLedger,
  ImportLedgerCommit,
  ImportLedgerEntry,
  ImportLedgerState,
  ImportLedgerView,
  ImportPlan,
  ImportPlanItem,
  ImportSourceRecord,
  ImportSourceWatermark,
  LegacySourceRegistration,
  LegacySourceRegistry,
  LegacySourceRegistryReceipt,
  LegacySourceType,
  QuarantineRange,
  SegmentChangeClassification,
  SegmentFingerprint,
  SegmentRecordFingerprint,
} from "./types.js";
