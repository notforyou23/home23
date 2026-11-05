export type WorkErrorCode =
  | "idempotency_conflict"
  | "invalid_manifest"
  | "invalid_request"
  | "not_found"
  | "ineligible"
  | "illegal_state"
  | "terminal_conflict";

export class WorkError extends Error {
  constructor(
    readonly code: WorkErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WorkError";
  }
}
