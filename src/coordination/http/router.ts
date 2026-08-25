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
  const attachmentRead = requireCoordinationAuth(application, ["product:read"]);
  const attachmentWrite = requireCoordinationAuth(application, ["attachment:write"]);

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

  // The complete service is the activation unit: registering partial metadata
  // or byte routes would advertise an attachment capability that cannot safely
  // upload/retry. With no service these paths deliberately fall through to 404.
  if (application.capabilities().capabilities.attachments && application.services.attachments) {
    const attachments = application.services.attachments;
    router.post(
      "/api/v1/attachments",
      attachmentWrite,
      requireIdempotencyKey(application),
      asyncRoute(async (request, response) => {
        const contentType = request.get("content-type");
        if (!contentType?.toLowerCase().startsWith("multipart/form-data;")) {
          throw new CoordinationHttpError("request_invalid", 400, false);
        }
        const rawLength = request.get("content-length");
        const contentLength = rawLength === undefined ? null : Number(rawLength);
        if (contentLength !== null && (!Number.isSafeInteger(contentLength) || contentLength < 0)) {
          throw new CoordinationHttpError("request_invalid", 400, false);
        }
        const attachment = await attachments.create({
          context: requireCoordinationContext(response),
          idempotencyKey: coordinationIdempotencyKey(response),
          contentType,
          contentLength,
          body: request,
        });
        const metadata = requireCoordinationMetadata(response);
        response.status(201).json({
          requestId: metadata.requestId,
          correlationId: metadata.correlationId,
          attachment,
          throughEventSequence: attachment.throughEventSequence,
        });
      }),
    );
    router.get(
      "/api/v1/attachments/:artifactId",
      attachmentRead,
      asyncRoute(async (request, response) => {
        const attachment = await attachments.getMetadata({
          context: requireCoordinationContext(response),
          artifactId: pathParameter(request.params.artifactId),
        });
        const metadata = requireCoordinationMetadata(response);
        response.json({
          requestId: metadata.requestId,
          correlationId: metadata.correlationId,
          attachment,
          throughEventSequence: attachment.throughEventSequence,
        });
      }),
    );
    router.get(
      "/api/v1/attachments/:artifactId/content",
      attachmentRead,
      asyncRoute(async (request, response) => {
        const rangeHeader = request.get("range");
        const download = await attachments.openDownload({
          context: requireCoordinationContext(response),
          artifactId: pathParameter(request.params.artifactId),
          ...(rangeHeader === undefined ? {} : { rangeHeader }),
        });
        response.status(download.status);
        response.setHeader("accept-ranges", "bytes");
        response.setHeader("content-type", download.contentType);
        response.setHeader("content-length", String(download.contentLength));
        response.setHeader("etag", `\"sha256:${download.sha256}\"`);
        response.setHeader("content-disposition", "attachment");
        if (download.range) {
          response.setHeader(
            "content-range",
            `bytes ${download.range.start}-${download.range.end}/${download.range.total}`,
          );
        }
        download.content.on("error", (error) => response.destroy(error));
        download.content.pipe(response);
      }),
    );
  }

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
