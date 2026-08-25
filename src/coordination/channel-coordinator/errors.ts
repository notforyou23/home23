export type ChannelCoordinatorErrorCode =
  | "capability_off"
  | "invalid_request"
  | "ineligible"
  | "outside_scope"
  | "stale_authority"
  | "turn_in_progress"
  | "turn_limit"
  | "round_limit"
  | "illegal_state";

export class ChannelCoordinatorError extends Error {
  constructor(readonly code: ChannelCoordinatorErrorCode, message: string) {
    super(message);
    this.name = "ChannelCoordinatorError";
  }
}
