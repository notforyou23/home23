import { AuthError } from "../auth/index.js";
import { MessagingError } from "../channels/index.js";
import { CanonicalSearchError } from "../search/index.js";
import { CoordinationLifecycleDrainingError } from "../app/index.js";

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
  if (error instanceof CanonicalSearchError) {
    return {
      code: error.code,
      httpStatus: error.httpStatus,
      retryable: error.retryable,
      details: error.details,
      message: "Search request failed.",
    };
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
