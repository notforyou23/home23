export type BotDirectoryErrorCode =
  | "alias_collision"
  | "availability_transition_invalid"
  | "binding_conflict"
  | "binding_not_persistent"
  | "identity_collision"
  | "protocol_version_unsupported"
  | "registration_stale"
  | "request_invalid"
  | "storage_conflict"
  | "unauthorized_registration";

const HTTP_STATUS: Readonly<Record<BotDirectoryErrorCode, number>> = Object.freeze({
  alias_collision: 409,
  availability_transition_invalid: 409,
  binding_conflict: 409,
  binding_not_persistent: 422,
  identity_collision: 409,
  protocol_version_unsupported: 409,
  registration_stale: 409,
  request_invalid: 400,
  storage_conflict: 409,
  unauthorized_registration: 403,
});

export class BotDirectoryError extends Error {
  readonly code: BotDirectoryErrorCode;
  readonly httpStatus: number;
  readonly details: Readonly<Record<string, string | number | boolean | null>>;

  constructor(
    code: BotDirectoryErrorCode,
    details: Readonly<Record<string, string | number | boolean | null>> = {},
  ) {
    super(code);
    this.name = "BotDirectoryError";
    this.code = code;
    this.httpStatus = HTTP_STATUS[code];
    this.details = Object.freeze({ ...details });
  }
}
