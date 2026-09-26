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

/** Durable Round Works contradict the immutable admission plan. Both sides are
 * immutable rows, so every later start reaches the same verdict: recovery
 * refuses such a Round permanently instead of retrying it at each boot. */
export class ChannelAdmissionContradictionError extends ChannelCoordinatorError {
  constructor(
    readonly reasonCode: "admission_works_mismatch" | "admission_terminal_inconsistent",
    message: string,
  ) {
    super("illegal_state", message);
  }
}
