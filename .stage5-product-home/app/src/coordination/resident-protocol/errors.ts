export type ResidentProtocolErrorCode =
  | "authentication_failed"
  | "capability_expired"
  | "capability_lifetime_invalid"
  | "capability_not_yet_valid"
  | "capability_replayed"
  | "connection_lost"
  | "deadline_exceeded"
  | "fence_invalid"
  | "frame_malformed"
  | "frame_too_large"
  | "payload_digest_mismatch"
  | "internal_error"
  | "protocol_version_unsupported"
  | "request_cancelled"
  | "request_invalid"
  | "request_rate_limited"
  | "server_busy";

export class ResidentProtocolError extends Error {
  readonly code: ResidentProtocolErrorCode;
  readonly retryable: boolean;
  readonly details: Readonly<Record<string, string | number | boolean | null>>;

  constructor(
    code: ResidentProtocolErrorCode,
    message: string,
    options: {
      retryable?: boolean;
      details?: Readonly<Record<string, string | number | boolean | null>>;
    } = {},
  ) {
    super(message);
    this.name = "ResidentProtocolError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details ?? {};
  }
}
