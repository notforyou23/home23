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
