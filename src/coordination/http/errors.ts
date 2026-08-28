import { AuthError } from "../auth/index.js";
import { MessagingError } from "../channels/index.js";
import { CanonicalSearchError } from "../search/index.js";
import { CoordinationLifecycleDrainingError } from "../app/index.js";
import { ArtifactError } from "../artifacts/index.js";
import { BotLifecycleError } from "../bot-lifecycle/index.js";
import { ChannelCoordinatorError } from "../channel-coordinator/index.js";
import { WorkError } from "../work/index.js";
import { LeaseError } from "../leases/index.js";
import { ActivityReadError } from "../activity/index.js";

export class CoordinationHttpError extends Error {
  readonly name = "CoordinationHttpError";

  constructor(
    readonly code: string,
    readonly httpStatus: number,
    readonly retryable: boolean,
    readonly details: Readonly<Record<string, string | number | boolean | null>> = {},
    message = "Request failed.",
  ) {
    super(message);
  }
}

export interface CoordinationHttpFailure {
  code: string;
  httpStatus: number;
  retryable: boolean;
  details: Readonly<Record<string, string | number | boolean | null>>;
  message: string;
}

function bodyParserFailureType(error: unknown): unknown {
  return error && typeof error === "object" && "type" in error
    ? (error as { type?: unknown }).type
    : undefined;
}

function isBodyParserFailure(error: unknown): boolean {
  return Boolean(
    bodyParserFailureType(error) === "entity.parse.failed",
  );
}

export function toCoordinationHttpFailure(error: unknown): CoordinationHttpFailure {
  if (error instanceof CoordinationHttpError) {
    return {
      code: error.code,
      httpStatus: error.httpStatus,
      retryable: error.retryable,
      details: error.details,
      message: error.message,
    };
  }
  if (error instanceof AuthError) {
    return {
      code: error.reasonCode,
      httpStatus: error.httpStatus,
      retryable: error.retryable,
      details: {},
      message: error.reasonCode === "access_invalid"
        ? "Authentication is required."
        : "Authentication failed.",
    };
  }
  if (error instanceof MessagingError) {
    return {
      code: error.code,
      httpStatus: error.httpStatus,
      retryable: error.retryable,
      details: error.details,
      message: "Messaging request failed.",
    };
  }
  if (error instanceof ArtifactError) {
    return {
      code: error.code,
      httpStatus: error.httpStatus,
      retryable: error.retryable,
      details: {},
      message: "Attachment request failed.",
    };
  }
  if (error instanceof BotLifecycleError) {
    const status = error.code === "bot_not_found" || error.code === "resident_not_found" ? 404
      : error.code === "standing_authority_denied" ? 403
      : error.code === "capability_disabled" || error.code === "authority_unavailable" ? 503
      : error.code === "request_invalid" ? 400 : 409;
    return { code: error.code, httpStatus: status, retryable: false, details: {}, message: "Bot lifecycle request failed." };
  }
  if (error instanceof ChannelCoordinatorError) {
    const status = error.code === "capability_off" ? 503
      : error.code === "outside_scope" ? 403
      : error.code === "invalid_request" ? 400 : 409;
    return { code: error.code, httpStatus: status, retryable: false, details: {}, message: "Channel coordination request failed." };
  }
  if (error instanceof CanonicalSearchError) {
    return {
      code: error.code,
      httpStatus: error.httpStatus,
      retryable: error.retryable,
      details: error.details,
      message: "Search request failed.",
    };
  }
  if (error instanceof ActivityReadError) {
    return {
      code: error.code,
      httpStatus: error.httpStatus,
      retryable: error.retryable,
      details: error.details,
      message: "Activity could not be reconstructed from canonical facts.",
    };
  }
  if (error instanceof WorkError || error instanceof LeaseError) {
    const status = error.code === "not_found" ? 404
      : error.code === "ineligible" ? 403
      : error.code === "invalid_request" || error.code === "invalid_manifest" ? 400
      : 409;
    return { code: error.code, httpStatus: status,
      retryable: error.code === "stale_fence", details: {}, message: "Work request failed." };
  }
  if (error instanceof CoordinationLifecycleDrainingError) {
    return {
      code: "server_draining",
      httpStatus: 503,
      retryable: true,
      details: {},
      message: "The coordination service is draining.",
    };
  }
  if (isBodyParserFailure(error)) {
    return {
      code: "request_invalid",
      httpStatus: 400,
      retryable: false,
      details: {},
      message: "The JSON request body is invalid.",
    };
  }
  if (bodyParserFailureType(error) === "entity.too.large") {
    return {
      code: "payload_too_large",
      httpStatus: 413,
      retryable: false,
      details: {},
      message: "The JSON request body exceeds the configured limit.",
    };
  }
  return {
    code: "internal_error",
    httpStatus: 500,
    retryable: false,
    details: {},
    message: "The coordination service could not complete the request.",
  };
}
