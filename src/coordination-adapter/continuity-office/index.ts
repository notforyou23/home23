export { createIsolatedContinuityOffice } from './adapter.js';
export { ContinuityOfficeError, type ContinuityOfficeErrorCode } from './errors.js';
export {
  mapContinuityWorkToCurrentContract,
  workResultIdempotencyKey,
  type ContinuityContractMapping,
  type CurrentWorkContractShape,
} from './contract-map.js';
export {
  ACCEPTED_BY_CONTINUITY_OFFICE,
  CONTINUITY_OFFICE_ID,
  HEADQUARTERS_OFFICE_ID,
  WAITING_FOR_HEADQUARTERS,
} from './constants.js';
export type {
  BoundedContinuityContext,
  BoundedContinuityContextInput,
  CanonicalWriteAuthority,
  CompleteContinuityWorkInput,
  ContinuityCapability,
  ContinuityIngressRequest,
  ContinuityIngressResult,
  ContinuityMessage,
  ContinuityWorkAdmitRequest,
  ContinuityWorkRecord,
  IsolatedContinuityOffice,
  IsolatedContinuityOfficeOptions,
  OfficeFenceBinding,
  OfficeRecord,
  ReconciliationResult,
  TakeoverInput,
} from './types.js';
