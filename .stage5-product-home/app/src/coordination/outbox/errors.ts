export type OutboxErrorCode = "invalid_request" | "illegal_state";

export class OutboxError extends Error {
  constructor(readonly code: OutboxErrorCode, message: string) {
    super(message);
    this.name = "OutboxError";
  }
}
