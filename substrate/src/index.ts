/**
 * Home23 Substrate OS — Body (Cut 1) + Metabolism (Cut 2)
 * Public API surface.
 */

export * from './types.js';
export { SeedLedger } from './ledger.js';
export { CheckpointManager, computeStateHash } from './checkpoint.js';
export { CapabilityMembrane } from './membrane.js';
export { ResourceAccounting } from './resource.js';
export { SeedProcess } from './seed.js';
export {
  makeInitialCell,
  makeInitialCells,
  routeEvent,
  applyMetabolicTransition,
  cloneCell,
  serializeCell,
  deserializeCell,
  continuousStateHash,
} from './cells.js';
export {
  generateReservoir,
  encodeEvent,
  metabolicStep,
  computeReadouts,
  eventDeltaSeconds,
  METABOLISM_VERSION,
  INPUT_DIM,
} from './metabolism.js';
export type { Reservoir, Readouts } from './metabolism.js';
export {
  WORKSPACE_CAPACITY,
  admissionScore,
  scoreCells,
  buildPacket,
  evaluateWorkspace,
} from './workspace.js';
export {
  EchoLobe,
  ModelLobe,
  validateLobeResult,
  applyLobeDeltas,
  buildLobePrompt,
  parseLobeResponse,
  LOBE_DELTA_ALLOWLIST,
} from './lobe.js';
export type { LobeAdapter, LobeTransport, ValidatedLobeResult, RejectedProposal } from './lobe.js';
export {
  emptyDevelopment,
  emptyCellPlasticState,
  cloneDevelopment,
  developmentMagnitude,
  applyCorrectionPlasticity,
  applyConsequencePlasticity,
  applyConsolidation,
  normalizeDevelopment,
  trustFor,
  QUIET_GAP_SECONDS,
  effectiveDispositions,
  effectiveSalienceWeights,
  effectiveNoveltyWeights,
  sourcePrefix,
  PLASTICITY_VERSION,
} from './plasticity.js';
export type { DevelopmentalState, CellPlasticState, PlasticUpdateSummary } from './plasticity.js';
