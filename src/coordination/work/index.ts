export {
  M11_MACHINE_NAMES,
  assertM11Transition,
  canM11Transition,
  isM11Terminal,
  type M11MachineName,
} from "./state-machines.js";
export {
  WORK_SCHEMA_DELTA_CANONICAL_JSON,
  WORK_SCHEMA_DELTA_PROPOSAL,
  WORK_SCHEMA_DELTA_SHA256,
  WORK_SCHEMA_DELTA_SQL,
  computeWorkSchemaDeltaDigest,
} from "./schema-delta.js";
export { WorkError, type WorkErrorCode } from "./errors.js";
export { createWorkService } from "./service.js";
export { createProductWorkControl, type ProductWorkControlPort, type ProductWorkMutationResult, type ProductWorkProjection } from "./product-control.js";
export { M11MessageProvenanceAuthority } from "./message-provenance.js";
export { createRecoveryService } from "./recovery-service.js";
export type {
  ContextManifest,
  ContextManifestInput,
  CancelQueuedWorkInput,
  CancelQueuedWorkResult,
  CreateWorkInput,
  CreateWorkResult,
  CreateWorkServiceOptions,
  M11Database,
  QueuedCancellationReceipt,
  WorkGeneratedIdKind,
  WorkRecord,
  WorkState,
  WorkTurnSelection,
} from "./types.js";
export type {
  CreateRecoveryServiceOptions,
  PositiveSourceTruth,
  RecoverStartupInput,
  RecoveryIdentity,
  RecoveryReceipt,
  SourceTruth,
  TerminalSourceTruth,
  UnknownSourceTruth,
} from "./recovery-types.js";
