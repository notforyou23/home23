export type RoundErrorCode =
  | "invalid_request"
  | "not_found"
  | "ineligible_coordinator"
  | "illegal_state"
  | "deadline_exceeded";

export class RoundError extends Error {
  constructor(readonly code: RoundErrorCode, message: string) {
    super(message);
    this.name = "RoundError";
  }
}
