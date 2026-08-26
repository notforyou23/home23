export type MessagingErrorCode =
  | "authority_unavailable"
  | "channel_archived"
  | "channel_id_conflict"
  | "idempotency_conflict"
  | "identity_context_mismatch"
  | "invalid_membership"
  | "invalid_mention"
  | "invalid_relation"
  | "message_id_conflict"
  | "nonmember"
  | "request_invalid"
  | "scope_denied"
  | "sequence_out_of_range"
  | "storage_conflict"
  | "unknown_channel"
  | "unknown_message"
  | "unknown_principal"
  | "version_conflict";

export const MESSAGING_FAILURE_MATRIX: Readonly<
  Record<MessagingErrorCode, { httpStatus: number; retryable: boolean }>
> = Object.freeze({
  authority_unavailable: { httpStatus: 503, retryable: false },
  channel_archived: { httpStatus: 409, retryable: false },
  channel_id_conflict: { httpStatus: 409, retryable: false },
  idempotency_conflict: { httpStatus: 409, retryable: false },
  identity_context_mismatch: { httpStatus: 403, retryable: false },
  invalid_membership: { httpStatus: 422, retryable: false },
  invalid_mention: { httpStatus: 422, retryable: false },
  invalid_relation: { httpStatus: 422, retryable: false },
  message_id_conflict: { httpStatus: 409, retryable: false },
  nonmember: { httpStatus: 403, retryable: false },
  request_invalid: { httpStatus: 400, retryable: false },
  scope_denied: { httpStatus: 403, retryable: false },
  sequence_out_of_range: { httpStatus: 422, retryable: false },
  storage_conflict: { httpStatus: 409, retryable: true },
  unknown_channel: { httpStatus: 404, retryable: false },
  unknown_message: { httpStatus: 404, retryable: false },
  unknown_principal: { httpStatus: 404, retryable: false },
  version_conflict: { httpStatus: 409, retryable: false },
});

export class MessagingError extends Error {
  readonly code: MessagingErrorCode;
  readonly httpStatus: number;
  readonly retryable: boolean;
  readonly details: Readonly<Record<string, string | number | boolean | null>>;

  constructor(
    code: MessagingErrorCode,
    details: Readonly<Record<string, string | number | boolean | null>> = {},
  ) {
    super(code);
    this.name = "MessagingError";
    this.code = code;
    this.httpStatus = MESSAGING_FAILURE_MATRIX[code].httpStatus;
    this.retryable = MESSAGING_FAILURE_MATRIX[code].retryable;
    this.details = Object.freeze({ ...details });
  }
}
