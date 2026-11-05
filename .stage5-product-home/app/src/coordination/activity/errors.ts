export type ActivityReadErrorCode =
  | "activity_source_incomplete"
  | "activity_projection_conflict"
  | "activity_source_unstable";

export class ActivityReadError extends Error {
  readonly name = "ActivityReadError";
  readonly httpStatus = 503;
  readonly retryable: boolean;
  readonly details: Readonly<{ diagnostic: string }>;

  constructor(
    readonly code: ActivityReadErrorCode,
    diagnostic: string,
    retryable = false,
  ) {
    super(code);
    this.retryable = retryable;
    this.details = Object.freeze({ diagnostic: diagnostic.slice(0, 1_024) });
  }
}
