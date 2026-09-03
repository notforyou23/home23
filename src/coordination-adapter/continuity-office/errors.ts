export type ContinuityOfficeErrorCode =
  | 'unauthenticated'
  | 'unknown_office'
  | 'illegal_capability'
  | 'private_export_forbidden'
  | 'headquarters_available'
  | 'stale_fence'
  | 'illegal_state'
  | 'not_found';

export class ContinuityOfficeError extends Error {
  constructor(
    readonly code: ContinuityOfficeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ContinuityOfficeError';
  }
}
