export type BotLifecycleErrorCode =
  | "capability_disabled"
  | "authority_unavailable"
  | "authority_epoch_mismatch"
  | "standing_authority_denied"
  | "request_invalid"
  | "bot_not_found"
  | "invalid_durable_binding"
  | "permanent_resident_protected"
  | "request_id_conflict"
  | "operation_failed";

export class BotLifecycleError extends Error {
  constructor(
    readonly code: BotLifecycleErrorCode,
    message: string = code,
    readonly receipt?: unknown,
  ) {
    super(message);
    this.name = "BotLifecycleError";
  }
}
