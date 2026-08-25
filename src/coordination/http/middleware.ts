import type { ErrorRequestHandler, RequestHandler, Response } from "express";

import { AuthError, type AuthNetwork, type HouseAuthScope } from "../auth/index.js";
import {
  CoordinationLifecycleDrainingError,
  type CoordinationApplication,
  type CoordinationLifecycle,
} from "../app/index.js";
import type { MessagingActorContext } from "../channels/index.js";
import { assertCoordinationId, generateCoordinationId } from "../ids/index.js";
import { CoordinationHttpError, toCoordinationHttpFailure } from "./errors.js";

export interface CoordinationRequestMetadata {
  requestId: string;
  correlationId: string;
  networkEvidence: AuthNetwork;
  remoteAddress: string;
}

export interface CoordinationHttpLocals {
  coordinationMetadata?: CoordinationRequestMetadata;
  coordinationContext?: MessagingActorContext;
  coordinationIdempotencyKey?: string;
}

function locals(response: Response): CoordinationHttpLocals {
  return response.locals as CoordinationHttpLocals;
}

function receiptId(
  kind: "request" | "correlation",
  header: string | undefined,
): string {
  if (header === undefined) return generateCoordinationId(kind);
  try {
    assertCoordinationId(kind, header);
    return header;
  } catch {
    throw new CoordinationHttpError(
      "request_invalid",
      400,
      false,
      { header: kind === "request" ? "x-request-id" : "x-correlation-id" },
      "A request receipt identifier is invalid.",
    );
  }
}

export const coordinationRequestMetadata: RequestHandler = (request, response, next) => {
  try {
    const remoteAddress = request.socket.remoteAddress;
    if (
      typeof remoteAddress !== "string" ||
      !(
        remoteAddress === "::1" ||
        remoteAddress.startsWith("127.") ||
        remoteAddress.startsWith("::ffff:127.")
      )
    ) {
      throw new AuthError("network_not_allowed");
    }
    const metadata = Object.freeze({
      requestId: receiptId("request", request.get("x-request-id")),
      correlationId: receiptId("correlation", request.get("x-correlation-id")),
      networkEvidence: "loopback" as const,
      remoteAddress,
    });
    locals(response).coordinationMetadata = metadata;
    response.setHeader("x-request-id", metadata.requestId);
    response.setHeader("x-correlation-id", metadata.correlationId);
    next();
  } catch (error) {
    next(error);
  }
};

export function coordinateRequestLifecycle(
  lifecycle: CoordinationLifecycle,
): RequestHandler {
  return (_request, response, next) => {
    let release: () => void;
    try {
      release = lifecycle.beginRequest();
    } catch (error) {
      next(error instanceof CoordinationLifecycleDrainingError
        ? error
        : new CoordinationLifecycleDrainingError());
      return;
    }
    let released = false;
    const finish = () => {
      if (released) return;
      released = true;
      release();
    };
    response.once("finish", finish);
    response.once("close", finish);
    next();
  };
}

function bearerToken(value: string | undefined): string {
  if (value === undefined) throw new AuthError("access_invalid");
  const match = /^Bearer ([^\s,]+)$/.exec(value);
  if (!match?.[1]) throw new AuthError("access_invalid");
  return match[1];
}

export function requireCoordinationAuth(
  application: CoordinationApplication,
  requiredScopes: readonly HouseAuthScope[],
): RequestHandler {
  return async (request, response, next) => {
    try {
      const metadata = requireCoordinationMetadata(response);
      const principal = await application.services.auth.validateAccessToken({
        accessToken: bearerToken(request.get("authorization")),
        network: metadata.networkEvidence,
        requiredScopes,
      });
      locals(response).coordinationContext = Object.freeze({
        principalId: principal.principalId,
        requestId: metadata.requestId,
        correlationId: metadata.correlationId,
        identity: Object.freeze({
          kind: "owner" as const,
          auth: principal,
        }),
      });
      next();
    } catch (error) {
      next(error);
    }
  };
}

export function requireIdempotencyKey(
  application: CoordinationApplication,
): RequestHandler {
  return (request, response, next) => {
    const key = request.get("idempotency-key");
    const limits = application.capabilities().limits;
    if (key === undefined) {
      next(new CoordinationHttpError(
        "idempotency_key_required",
        400,
        false,
        {},
        "An Idempotency-Key header is required.",
      ));
      return;
    }
    if (
      key.length < limits.idempotencyKeyMinimum ||
      key.length > limits.idempotencyKeyMaximum ||
      !/^[\x20-\x7e]+$/.test(key)
    ) {
      next(new CoordinationHttpError(
        "idempotency_key_invalid",
        400,
        false,
        {},
        "The Idempotency-Key header is invalid.",
      ));
      return;
    }
    locals(response).coordinationIdempotencyKey = key;
    next();
  };
}

export function requireCoordinationMetadata(
  response: Response,
): CoordinationRequestMetadata {
  const metadata = locals(response).coordinationMetadata;
  if (!metadata) throw new Error("coordination request metadata is unavailable");
  return metadata;
}

export function requireCoordinationContext(response: Response): MessagingActorContext {
  const context = locals(response).coordinationContext;
  if (!context) throw new Error("coordination authentication context is unavailable");
  return context;
}

export function coordinationIdempotencyKey(response: Response): string {
  const key = locals(response).coordinationIdempotencyKey;
  if (!key) throw new Error("coordination idempotency key is unavailable");
  return key;
}

export const coordinationErrorHandler: ErrorRequestHandler = (
  error,
  _request,
  response,
  _next,
) => {
  const failure = toCoordinationHttpFailure(error);
  const requestId = locals(response).coordinationMetadata?.requestId ??
    generateCoordinationId("request");
  response.status(failure.httpStatus).json({
    error: {
      code: failure.code,
      message: failure.message,
      retryable: failure.retryable,
      requestId,
      details: failure.details,
    },
  });
};
