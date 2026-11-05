export type CanonicalSearchErrorCode =
  | "request_invalid"
  | "scope_denied"
  | "cursor_invalid";

export const CANONICAL_SEARCH_FAILURE_MATRIX: Readonly<
  Record<CanonicalSearchErrorCode, { httpStatus: number; retryable: boolean }>
> = Object.freeze({
  request_invalid: { httpStatus: 400, retryable: false },
  scope_denied: { httpStatus: 403, retryable: false },
  cursor_invalid: { httpStatus: 400, retryable: false },
});

export class CanonicalSearchError extends Error {
  readonly httpStatus: number;
  readonly retryable: boolean;
  readonly details: Readonly<Record<string, string | number | boolean | null>>;

  constructor(
    readonly code: CanonicalSearchErrorCode,
    details: Readonly<Record<string, string | number | boolean | null>> = {},
  ) {
    super(code);
    this.name = "CanonicalSearchError";
    this.httpStatus = CANONICAL_SEARCH_FAILURE_MATRIX[code].httpStatus;
    this.retryable = CANONICAL_SEARCH_FAILURE_MATRIX[code].retryable;
    this.details = Object.freeze({ ...details });
  }
}
