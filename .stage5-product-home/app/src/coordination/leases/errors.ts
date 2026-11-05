export type LeaseErrorCode =
  | "invalid_request"
  | "not_found"
  | "illegal_state"
  | "stale_fence"
  | "retry_budget_exhausted"
  | "terminal_conflict";

export class LeaseError extends Error {
  constructor(
    readonly code: LeaseErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "LeaseError";
  }
}
