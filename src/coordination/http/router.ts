import express, { type NextFunction, type Request, type Response } from "express";

import type {
  CoordinationAdvertisedCapabilities,
  CoordinationApplication,
  CoordinationLifecycle,
} from "../app/index.js";
import { CoordinationHttpError } from "./errors.js";
import {
  coordinationErrorHandler,
  coordinationIdempotencyKey,
  coordinationRequestMetadata,
  coordinateRequestLifecycle,
  requireCoordinationAuth,
  requireCoordinationContext,
  requireCoordinationMetadata,
  requireIdempotencyKey,
} from "./middleware.js";

type CapabilityName = keyof CoordinationAdvertisedCapabilities;

function unavailable(capability: CapabilityName): CoordinationHttpError {
  return new CoordinationHttpError(
    "capability_unavailable",
    503,
    true,
    { capability },
    "The requested coordination capability is unavailable.",
  );
}

function integerQuery(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) {
    throw new CoordinationHttpError("request_invalid", 400, false);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new CoordinationHttpError("request_invalid", 400, false);
  }
  return parsed;
}

function nullableQuery(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || value.length === 0) {
    throw new CoordinationHttpError("request_invalid", 400, false);
  }
  return value;
}

function pathParameter(value: string | string[] | undefined): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new CoordinationHttpError("request_invalid", 400, false);
  }
  return value;
}

function jsonObjectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CoordinationHttpError("request_invalid", 400, false);
  }
  return value as Record<string, unknown>;
}

function asyncRoute(
  handler: (request: Request, response: Response) => Promise<void>,
) {
  return (request: Request, response: Response, next: NextFunction) => {
    void handler(request, response).catch(next);
  };
}

export function createCoordinationRouter(input: {
  application: CoordinationApplication;
  lifecycle: CoordinationLifecycle;
}) {
  const { application, lifecycle } = input;
  const router = express();
  const jsonBody = express.json({
    limit: application.capabilities().limits.jsonBodyBytes,
  });
  router.disable("x-powered-by");
  router.use(coordinationRequestMetadata);
  router.use(coordinateRequestLifecycle(lifecycle));

  router.get("/api/v1/capabilities", (_request, response) => {
    response.json(application.capabilities());
  });

  const productRead = requireCoordinationAuth(application, ["product:read"]);
  const messageSend = requireCoordinationAuth(application, ["message:send"]);

  router.get("/api/v1/bootstrap", productRead, asyncRoute(async (request, response) => {
    if (!application.capabilities().capabilities.bootstrap || !application.services.bootstrap) {
      throw unavailable("bootstrap");
    }
    if (request.query.after !== undefined) {
      throw new CoordinationHttpError("request_invalid", 400, false);
    }
    const bootstrap = await application.services.bootstrap.getBootstrap({
      context: requireCoordinationContext(response),
    });
    const advertised = application.capabilities();
    response.json({
      ...bootstrap,
      capabilities: {
        channels: false,
        attachments: advertised.capabilities.attachments,
        search: advertised.capabilities.search,
        push: false,
        eventReplay: advertised.capabilities.eventReplay,
        botLifecycle: advertised.capabilities.botLifecycle,
      },
      limits: {
        ...bootstrap.limits,
        ...advertised.limits,
      },
    });
  }));

  const unavailableRoute = (capability: CapabilityName) =>
    (_request: Request, _response: Response, next: NextFunction) =>
      next(unavailable(capability));

  router.get("/api/v1/channels", productRead, unavailableRoute("channelsRead"));
  router.get("/api/v1/channels/:channelId", productRead, unavailableRoute("channelsRead"));
  router.get("/api/v1/conversations", productRead, unavailableRoute("conversationsRead"));
  router.get(
    "/api/v1/channels/:channelId/messages",
    productRead,
    unavailableRoute("messagesRead"),
  );
  router.get("/api/v1/unread", productRead, unavailableRoute("unreadRead"));
  router.get("/api/v1/activity", productRead, unavailableRoute("activity"));
  router.get("/api/v1/events", productRead, unavailableRoute("eventReplay"));

  router.post(
    "/api/v1/channels/:channelId/messages",
    messageSend,
    requireIdempotencyKey(application),
    unavailableRoute("messageSubmission"),
  );

  router.post(
    "/api/v1/channels/:channelId/read",
    productRead,
    requireIdempotencyKey(application),
    jsonBody,
    asyncRoute(async (request, response) => {
      if (
        !application.capabilities().capabilities.readCursorMutation ||
        !application.services.unread
      ) {
        throw unavailable("readCursorMutation");
      }
      const body = jsonObjectBody(request.body);
      const throughSequence = body.throughSequence;
      if (!Number.isSafeInteger(throughSequence) || (throughSequence as number) < 0) {
        throw new CoordinationHttpError("request_invalid", 400, false);
      }
      const result = await application.services.unread.markRead({
        context: requireCoordinationContext(response),
        channelId: pathParameter(request.params.channelId),
        readThroughSequence: throughSequence as number,
        idempotencyKey: coordinationIdempotencyKey(response),
      });
      const metadata = requireCoordinationMetadata(response);
      response.json({
        requestId: metadata.requestId,
        correlationId: metadata.correlationId,
        ...result.unread,
        throughEventSequence: result.receipt.eventSequence,
      });
    }),
  );

  router.get("/api/v1/search", productRead, asyncRoute(async (request, response) => {
    if (!application.capabilities().capabilities.search || !application.services.search) {
      throw unavailable("search");
    }
    const rawScope = nullableQuery(request.query.scope) ?? "all";
    const scope = rawScope === "all"
      ? { kind: "all" as const }
      : rawScope.startsWith("channel:")
        ? { kind: "channel" as const, channelId: rawScope.slice("channel:".length) }
        : null;
    if (!scope) throw new CoordinationHttpError("request_invalid", 400, false);
    const query = nullableQuery(request.query.q);
    if (query === null) {
      throw new CoordinationHttpError("request_invalid", 400, false);
    }
    response.json(await application.services.search.search({
      context: requireCoordinationContext(response),
      query,
      scope,
      cursor: nullableQuery(request.query.cursor),
      limit: integerQuery(request.query.limit, 50),
    }));
  }));

  router.get("/api/v1/work/:workId", productRead, unavailableRoute("work"));

  for (const operation of ["cancel", "retry"] as const) {
    router.post(
      `/api/v1/work/:workId/${operation}`,
      messageSend,
      requireIdempotencyKey(application),
      unavailableRoute("workMutation"),
    );
  }

  router.use((_request, _response, next) => {
    next(new CoordinationHttpError(
      "route_not_found",
      404,
      false,
      {},
      "The requested coordination route does not exist.",
    ));
  });
  router.use(coordinationErrorHandler);
  return router;
}
