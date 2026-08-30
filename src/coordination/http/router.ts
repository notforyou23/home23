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
import { ResumableSsePump, resolveEventResumeSequence } from "../events/index.js";
import { encodeCommunicationEventEnvelope } from "../communications/index.js";
import { once } from "node:events";
import { REASONING_EFFORTS, type ReasoningEffort } from "../../agent/reasoning-effort.js";

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

function waitForEventPoll(request: Request, response: Response, delayMs = 250): Promise<boolean> {
  if (request.aborted || request.destroyed || response.destroyed || response.writableEnded) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const finish = (connected: boolean) => {
      clearTimeout(timer);
      request.off("aborted", disconnected);
      response.off("close", disconnected);
      resolve(connected);
    };
    const disconnected = () => finish(false);
    const timer = setTimeout(() => finish(true), delayMs);
    request.once("aborted", disconnected);
    response.once("close", disconnected);
  });
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

  router.post("/api/v1/pairing/sessions", requireIdempotencyKey(application), jsonBody,
    asyncRoute(async (request,response)=>{if(!application.capabilities().pairingAvailable||!application.services.auth.issuePairing)throw unavailable("bootstrap");const body=jsonObjectBody(request.body);if(typeof body.deviceName!=="string")throw new CoordinationHttpError("request_invalid",400,false);const metadata=requireCoordinationMetadata(response);const result=await application.services.auth.issuePairing({deviceName:body.deviceName,operator:metadata.networkEvidence,mutation:{idempotencyKey:coordinationIdempotencyKey(response),requestId:metadata.requestId,correlationId:metadata.correlationId}});response.status(201).json(result);}),
  );
  router.post("/api/v1/pairing/sessions/:pairingSessionId/redeem",requireIdempotencyKey(application),jsonBody,
    asyncRoute(async(request,response)=>{if(!application.capabilities().pairingAvailable||!application.services.auth.redeemPairing)throw unavailable("bootstrap");const body=jsonObjectBody(request.body);const device=body.device as Record<string,unknown>|undefined;if(typeof body.pairingCode!=="string"||!device||(device.platform!=="macos"&&device.platform!=="ios")||typeof device.name!=="string"||typeof device.appBuild!=="string"||(body.credentialProfile!==undefined&&body.credentialProfile!=="product"&&body.credentialProfile!=="legacy_bridge"))throw new CoordinationHttpError("request_invalid",400,false);const metadata=requireCoordinationMetadata(response);response.json(await application.services.auth.redeemPairing({pairingSessionId:pathParameter(request.params.pairingSessionId),pairingCode:body.pairingCode,network:metadata.networkEvidence,device:{platform:device.platform,name:device.name,appBuild:device.appBuild},credentialProfile:body.credentialProfile as "product"|"legacy_bridge"|undefined,mutation:{idempotencyKey:coordinationIdempotencyKey(response),requestId:metadata.requestId,correlationId:metadata.correlationId}}));}),
  );
  router.post("/api/v1/sessions/refresh",requireIdempotencyKey(application),jsonBody,
    asyncRoute(async(request,response)=>{if(!application.services.auth.refreshSession)throw unavailable("bootstrap");const body=jsonObjectBody(request.body);if(typeof body.refreshToken!=="string")throw new CoordinationHttpError("request_invalid",400,false);const metadata=requireCoordinationMetadata(response);response.json(await application.services.auth.refreshSession({refreshToken:body.refreshToken,network:metadata.networkEvidence,mutation:{idempotencyKey:coordinationIdempotencyKey(response),requestId:metadata.requestId,correlationId:metadata.correlationId}}));}),
  );
  router.delete("/api/v1/sessions/current",requireIdempotencyKey(application),
    asyncRoute(async(request,response)=>{if(!application.services.auth.revokeCurrentSession)throw unavailable("bootstrap");const metadata=requireCoordinationMetadata(response);const authorization=request.get("authorization");if(!authorization?.startsWith("Bearer "))throw new CoordinationHttpError("unauthorized",401,false);await application.services.auth.revokeCurrentSession({accessToken:authorization.slice(7),network:metadata.networkEvidence,mutation:{idempotencyKey:coordinationIdempotencyKey(response),requestId:metadata.requestId,correlationId:metadata.correlationId}});response.status(204).end();}),
  );

  const productRead = requireCoordinationAuth(application, ["product:read"]);
  const messageSend = requireCoordinationAuth(application, ["message:send"]);
  const attachmentRead = requireCoordinationAuth(application, ["product:read"]);
  const attachmentWrite = requireCoordinationAuth(application, ["attachment:write"]);
  const legacyBridgeAccess = requireCoordinationAuth(application, ["legacy-bridge:access"]);

  router.get("/api/v1/legacy-bridge/session", legacyBridgeAccess,
    asyncRoute(async (_request, response) => {
      const context = requireCoordinationContext(response);
      if (context.identity.kind !== "owner") throw new CoordinationHttpError("unauthorized", 401, false);
      response.json({
        ok: true,
        principalId: context.principalId,
        deviceId: context.identity.auth.deviceId,
        sessionId: context.identity.auth.sessionId,
        scopes: context.identity.auth.scopes,
      });
    }),
  );

  router.get("/api/v1/bootstrap", productRead, asyncRoute(async (request, response) => {
    if (!application.capabilities().capabilities.bootstrap || !application.services.bootstrap) {
      throw unavailable("bootstrap");
    }
    // Bootstrap is a full, consistent snapshot. Clients still send their
    // durable cursor so reconnects can use the same request shape; validate it
    // but return the complete snapshot regardless of its value.
    if (request.query.after !== undefined) integerQuery(request.query.after, 0);
    const bootstrap = await application.services.bootstrap.getBootstrap({
      context: requireCoordinationContext(response),
    });
    const advertised = application.capabilities();
    response.json({
      ...bootstrap,
      capabilities: {
        channels: advertised.capabilities.channelsRead,
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

  router.get("/api/v1/authority-epochs", productRead, asyncRoute(async (_request, response) => {
    if (!application.services.authorityEpochs) throw unavailable("bootstrap");
    const metadata = requireCoordinationMetadata(response);
    response.json({
      requestId: metadata.requestId,
      correlationId: metadata.correlationId,
      ...(await application.services.authorityEpochs.listCurrent()),
    });
  }));

  const unavailableRoute = (capability: CapabilityName) =>
    (_request: Request, _response: Response, next: NextFunction) =>
      next(unavailable(capability));

  router.get("/api/v1/bots", productRead, asyncRoute(async (_request, response) => {
    if (!application.services.bots) throw unavailable("bootstrap");
    const metadata = requireCoordinationMetadata(response);
    response.json({ ...metadata, bots: await application.services.bots.listVisibleBots(), nextCursor: null, throughEventSequence: 0 });
  }));
  router.get("/api/v1/bots/:botId", productRead, asyncRoute(async (request, response) => {
    if (!application.services.bots) throw unavailable("bootstrap");
    const botId = pathParameter(request.params.botId);
    const bot = (await application.services.bots.listVisibleBots()).find((item) => item.id === botId);
    if (!bot) throw new CoordinationHttpError("bot_not_found", 404, false);
    response.json({ bot });
  }));
  router.get("/api/v1/bots/:botId/details", productRead, asyncRoute(async (request, response) => {
    if (!application.services.bots) throw unavailable("bootstrap");
    const botId = pathParameter(request.params.botId);
    const bot = (await application.services.bots.listVisibleBots()).find((item) => item.id === botId);
    if (!bot) throw new CoordinationHttpError("bot_not_found", 404, false);
    response.json({
      bot,
      executionBoundary: {
        kind: "local_mac",
        label: "This Mac",
        attested: true,
        isolation: {
          status: "unavailable",
          blocker: {
            code: "isolated_execution_not_attested",
            capability: "isolated_execution",
            retryable: false,
          },
        },
      },
      routineSummary: {
        status: "unavailable",
        blocker: {
          code: "canonical_scheduler_adapter_unavailable",
          capability: "routine_summary",
          retryable: false,
        },
      },
      consequentialApproval: {
        status: "unavailable",
        blocker: {
          code: "consequential_action_consumer_unavailable",
          capability: "inline_approval",
          retryable: false,
        },
      },
    });
  }));
  router.get("/api/v1/channels", productRead, asyncRoute(async (request, response) => {
    if (!application.capabilities().capabilities.channelsRead || !application.services.channels) throw unavailable("channelsRead");
    response.json(await application.services.channels.listChannels({ context: requireCoordinationContext(response), cursor: nullableQuery(request.query.cursor), limit: integerQuery(request.query.limit, 50) }));
  }));
  router.get("/api/v1/channels/:channelId", productRead, asyncRoute(async (request, response) => {
    if (!application.capabilities().capabilities.channelsRead || !application.services.channels) throw unavailable("channelsRead");
    const metadata = requireCoordinationMetadata(response);
    response.json({
      ...metadata,
      channel: await application.services.channels.getChannel({ context: requireCoordinationContext(response), channelId: pathParameter(request.params.channelId) }),
      throughEventSequence: 0,
    });
  }));
  router.get("/api/v1/conversations", productRead, asyncRoute(async (_request, response) => {
    if (!application.capabilities().capabilities.conversationsRead || !application.services.unread) throw unavailable("conversationsRead");
    response.json({ conversations: await application.services.unread.listInbox({ context: requireCoordinationContext(response) }) });
  }));
  router.get("/api/v1/inbox", productRead, asyncRoute(async (_request, response) => {
    if (!application.capabilities().capabilities.conversationsRead || !application.services.unread) throw unavailable("conversationsRead");
    const metadata = requireCoordinationMetadata(response);
    response.json({ ...metadata, conversations: await application.services.unread.listInbox({ context: requireCoordinationContext(response) }), nextCursor: null, throughEventSequence: 0 });
  }));
  router.get("/api/v1/channels/:channelId/messages", productRead, asyncRoute(async (request, response) => {
    if (!application.capabilities().capabilities.messagesRead || !application.services.messages) throw unavailable("messagesRead");
    const before = request.query.before === undefined ? undefined : integerQuery(request.query.before, 0);
    const metadata = requireCoordinationMetadata(response);
    const channelId = pathParameter(request.params.channelId);
    const page = await application.services.messages.listMessages({ context: requireCoordinationContext(response), channelId, ...(before === undefined ? {} : { beforeSequence: before }), limit: integerQuery(request.query.limit, 50) });
    const conversationId = page.messages[0]?.conversationId ?? (application.services.channels ? (await application.services.channels.getChannel({ context: requireCoordinationContext(response), channelId })).conversationId : null);
    if (!conversationId) throw unavailable("messagesRead");
    response.json({ ...metadata, channelId, conversationId, messages: page.messages, nextCursor: null, throughEventSequence: 0 });
  }));
  router.get("/api/v1/unread", productRead, asyncRoute(async (request, response) => {
    if (!application.capabilities().capabilities.unreadRead || !application.services.unread) throw unavailable("unreadRead");
    const channelId = nullableQuery(request.query.channelId);
    if (channelId) response.json(await application.services.unread.getUnread({ context: requireCoordinationContext(response), channelId }));
    else response.json({ conversations: await application.services.unread.listInbox({ context: requireCoordinationContext(response) }) });
  }));
  router.get("/api/v1/activity", productRead, asyncRoute(async (request, response) => {
    if (!application.capabilities().capabilities.activity || !application.services.activity) throw unavailable("activity");
    const rawScope = nullableQuery(request.query.scope) ?? "all";
    const scope = rawScope === "all" ? { kind: "all" as const } : rawScope.startsWith("channel:") ? { kind: "channel" as const, channelId: rawScope.slice(8) } : null;
    if (!scope) throw new CoordinationHttpError("request_invalid", 400, false);
    const afterSequence = request.query.afterSequence === undefined ? null : integerQuery(request.query.afterSequence, 0);
    const afterKey = nullableQuery(request.query.afterKey);
    if ((afterSequence === null) !== (afterKey === null)) throw new CoordinationHttpError("request_invalid", 400, false);
    response.json(await application.services.activity.list({ context: requireCoordinationContext(response), scope, after: afterSequence === null ? null : { eventSequence: afterSequence, key: afterKey! }, limit: integerQuery(request.query.limit, 50) }));
  }));

  router.post("/api/v1/channels", messageSend, requireIdempotencyKey(application), jsonBody, asyncRoute(async (request, response) => {
    if (!application.capabilities().capabilities.channelMutation || !application.services.channels) throw unavailable("channelMutation");
    const body = jsonObjectBody(request.body);
    const common = { context: requireCoordinationContext(response), memberBotIds: body.memberBotIds as string[], title: body.title as string, purpose: body.purpose as string, pinned: body.pinned as boolean, responderPolicy: body.responderPolicy as any, idempotencyKey: coordinationIdempotencyKey(response) };
    const result = body.kind === "direct" ? await application.services.channels.createDirectConversation(common) : body.kind === "group" ? await application.services.channels.createGroupChannel(common) : (() => { throw new CoordinationHttpError("request_invalid", 400, false); })();
    response.status(result.outcome === "created" ? 201 : 200).json(result);
  }));
  router.post("/api/v1/bots", messageSend, requireIdempotencyKey(application), jsonBody, asyncRoute(async (request, response) => {
    if (!application.capabilities().capabilities.botLifecycle || !application.services.botLifecycleApi) throw unavailable("botLifecycle");
    const body = jsonObjectBody(request.body);
    if (typeof body.residentBinding !== "string" || typeof body.displayName !== "string" || typeof body.purpose !== "string" || !Array.isArray(body.requiredCapabilities) || !body.requiredCapabilities.every((item) => typeof item === "string")) throw new CoordinationHttpError("request_invalid", 400, false);
    const receipt = await application.services.botLifecycleApi.create({ context: requireCoordinationContext(response), idempotencyKey: coordinationIdempotencyKey(response), residentBinding: body.residentBinding, displayName: body.displayName, purpose: body.purpose, requiredCapabilities: body.requiredCapabilities });
    response.status(201).json({ receipt });
  }));
  for (const operation of ["start", "stop", "restart", "archive", "restore"] as const) {
    router.post(`/api/v1/bots/:botId/${operation}`, messageSend, requireIdempotencyKey(application), asyncRoute(async (request, response) => {
      if (!application.capabilities().capabilities.botLifecycle || !application.services.botLifecycleApi) throw unavailable("botLifecycle");
      response.json({ receipt: await application.services.botLifecycleApi.control({ context: requireCoordinationContext(response), idempotencyKey: coordinationIdempotencyKey(response), botId: pathParameter(request.params.botId), operation }) });
    }));
  }
  router.get("/api/v1/events", productRead, asyncRoute(async (request, response) => {
    if (!application.capabilities().capabilities.eventReplay || !application.services.events) {
      throw unavailable("eventReplay");
    }
    const headerCursor = request.get("last-event-id");
    const queryCursor = request.query.after;
    if (queryCursor !== undefined && (typeof queryCursor !== "string" || !/^[0-9]+$/.test(queryCursor))) {
      throw new CoordinationHttpError("request_invalid", 400, false);
    }
    let afterSequence: number;
    try {
      afterSequence = resolveEventResumeSequence({
        ...(queryCursor === undefined ? {} : { after: Number(queryCursor) }),
        ...(headerCursor === undefined ? {} : { lastEventId: headerCursor }),
      });
    } catch {
      throw new CoordinationHttpError("request_invalid", 400, false);
    }
    const metadata = requireCoordinationMetadata(response);
    const pump = new ResumableSsePump({
      repository: application.services.events,
      requestId: metadata.requestId,
      sink: {
        write: (chunk) => response.write(chunk),
        waitForDrain: async () => { await once(response, "drain"); },
      },
    });
    response.setHeader("content-type", "text/event-stream; charset=utf-8");
    response.setHeader("cache-control", "no-cache, no-transform");
    response.setHeader("connection", "keep-alive");
    const result = await pump.replay(afterSequence);
    if (result.kind === "reset") {
      if (!response.headersSent) response.status(409).json(result);
      else response.end();
      return;
    }
    response.flushHeaders();
    let cursor = result.throughSequence;
    while (lifecycle.state() === "accepting" && await waitForEventPoll(request, response)) {
      const replay = await pump.replay(cursor);
      if (replay.kind === "reset") break;
      cursor = replay.throughSequence;
      await pump.heartbeatIfDue();
    }
    if (!response.writableEnded && !response.destroyed) response.end();
  }));

  router.get("/api/v1/communications/events", productRead, asyncRoute(async (request, response) => {
    if (
      !application.capabilities().capabilities.communicationEvidence ||
      !application.services.communications
    ) {
      throw unavailable("communicationEvidence");
    }
    const metadata = requireCoordinationMetadata(response);
    const result = application.services.communications.history({
      afterSequence: integerQuery(request.query.after, 0),
      limit: integerQuery(request.query.limit, 100),
      requestId: metadata.requestId,
      ...(request.query.conversationId === undefined
        ? {}
        : { conversationId: pathParameter(request.query.conversationId as string) }),
    });
    if (result.kind === "reset") {
      response.status(409).json({ error: result.error });
      return;
    }
    response.json({
      ...result,
      events: result.events.map(encodeCommunicationEventEnvelope),
    });
  }));

  router.get(
    "/api/v1/channels/:channelId/execution-options",
    productRead,
    asyncRoute(async (request, response) => {
      if (
        !application.capabilities().capabilities.modelSelection ||
        !application.services.messageSubmission?.selectionOptions
      ) {
        throw unavailable("modelSelection");
      }
      const metadata = requireCoordinationMetadata(response);
      const options = await application.services.messageSubmission.selectionOptions({
        context: requireCoordinationContext(response),
        channelId: pathParameter(request.params.channelId),
      });
      response.json({ ...metadata, ...options });
    }),
  );

  router.post(
    "/api/v1/channels/:channelId/messages",
    messageSend,
    requireIdempotencyKey(application),
    jsonBody,
    asyncRoute(async (request, response) => {
      if (!application.capabilities().capabilities.messageSubmission || !application.services.messageSubmission) {
        throw unavailable("messageSubmission");
      }
      const body = jsonObjectBody(request.body);
      const required = ["messageId", "clientMessageId", "text", "attachmentIds", "mentions", "replyToMessageId"];
      const modelAlias = body.modelAlias === undefined ? null : body.modelAlias;
      const requestedEffort = body.reasoningEffort === undefined ? null : body.reasoningEffort;
      if (required.some((key) => !(key in body)) ||
          typeof body.messageId !== "string" || typeof body.clientMessageId !== "string" ||
          (typeof body.text !== "string" && body.text !== null) ||
          !Array.isArray(body.attachmentIds) || !body.attachmentIds.every((id) => typeof id === "string") ||
          !Array.isArray(body.mentions) || !body.mentions.every((id) => typeof id === "string") ||
          (typeof body.replyToMessageId !== "string" && body.replyToMessageId !== null) ||
          (modelAlias !== null &&
            (typeof modelAlias !== "string" || modelAlias.length < 1 || modelAlias.length > 256 ||
              /[\0\r\n]/u.test(modelAlias))) ||
          (requestedEffort !== null &&
            (typeof requestedEffort !== "string" ||
              !REASONING_EFFORTS.includes(requestedEffort as ReasoningEffort)))) {
        throw new CoordinationHttpError("request_invalid", 400, false);
      }
      if (
        body.attachmentIds.length > 0 &&
        !application.capabilities().capabilities.attachments
      ) {
        throw unavailable("attachments");
      }
      const result = await application.services.messageSubmission.submitMessage({
        context: requireCoordinationContext(response),
        channelId: pathParameter(request.params.channelId),
        idempotencyKey: coordinationIdempotencyKey(response),
        body: {
          messageId: body.messageId,
          clientMessageId: body.clientMessageId,
          text: body.text,
          attachmentIds: body.attachmentIds,
          mentions: body.mentions,
          replyToMessageId: body.replyToMessageId,
          modelAlias: modelAlias as string | null,
          reasoningEffort: requestedEffort as ReasoningEffort | null,
        },
      });
      const { response: _terminalResponse, ...accepted } = result;
      response.status(202).json(accepted);
    }),
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
    const requireAttachmentCapability = () => {
      if (!application.capabilities().capabilities.attachments) {
        throw unavailable("attachments");
      }
    };
    router.post(
      "/api/v1/attachments",
      attachmentWrite,
      requireIdempotencyKey(application),
      asyncRoute(async (request, response) => {
        requireAttachmentCapability();
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
        requireAttachmentCapability();
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
        requireAttachmentCapability();
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

  router.get("/api/v1/work/:workId", productRead, asyncRoute(async (request, response) => {
    if (!application.capabilities().capabilities.work || !application.services.workControl) throw unavailable("work");
    response.json({ work: application.services.workControl.get({ context: requireCoordinationContext(response), workId: pathParameter(request.params.workId) }) });
  }));

  for (const operation of ["cancel", "retry"] as const) router.post(
    `/api/v1/work/:workId/${operation}`, messageSend, requireIdempotencyKey(application),
    asyncRoute(async (request, response) => {
      if (!application.capabilities().capabilities.workMutation || !application.services.workControl) throw unavailable("workMutation");
      const result = application.services.workControl[operation]({ context: requireCoordinationContext(response), workId: pathParameter(request.params.workId), idempotencyKey: coordinationIdempotencyKey(response) });
      response.status(operation === "retry" && !result.replayed ? 201 : operation === "cancel" && result.outcome === "cancellation_requested" ? 202 : 200).json(result);
    }),
  );

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
