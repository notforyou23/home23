import express, { type Express, type Request, type Response, type NextFunction } from "express";
import type { CoordinationApplication } from "../app/types.js";
import { REASONING_EFFORTS, type ReasoningEffort } from "../../agent/reasoning-effort.js";
import { LIVE_VOICE_MODEL, LIVE_VOICE_VOICES, LIVE_VOICE_PACES, type LiveVoiceAccess, type LiveVoiceStart } from "../app/live-voice.js";
import { CoordinationHttpError } from "./errors.js";
import { requireCoordinationAuth, requireCoordinationContext, requireCoordinationMetadata,
  requireIdempotencyKey, coordinationIdempotencyKey } from "./middleware.js";

function parameter(value: string | string[] | undefined) {
  if (typeof value !== "string" || !value || value.length > 256) throw new CoordinationHttpError("request_invalid", 400, false);
  return value;
}
function access(request: Request, response: Response): LiveVoiceAccess {
  return { context: requireCoordinationContext(response), channelId: parameter(request.params.channelId),
    accessToken: request.get("authorization")!.slice("Bearer ".length),
    network: requireCoordinationMetadata(response).networkEvidence };
}
function route(handler: (request: Request, response: Response) => Promise<void>) {
  return (request: Request, response: Response, next: NextFunction) => { void handler(request, response).catch(next); };
}

export function mountLiveVoiceRoutes(router: Express, application: CoordinationApplication) {
  const auth = requireCoordinationAuth(application, ["product:read", "message:send"]);
  const idempotency = requireIdempotencyKey(application);
  const json = express.json({ limit: application.capabilities().limits.jsonBodyBytes });
  const base = "/api/v1/channels/:channelId/voice";
  const service = (cleanup = false) => {
    if (!application.services.liveVoice || (!cleanup && !application.capabilities().capabilities.messageSubmission)) {
      throw new CoordinationHttpError("voice_unavailable", 503, false);
    }
    return application.services.liveVoice;
  };
  router.get(base, auth, route(async (request, response) => {
    response.set("Cache-Control", "no-store");
    response.json(application.services.liveVoice && application.capabilities().capabilities.messageSubmission
      ? await service().capability(access(request, response))
      : { available: false, model: LIVE_VOICE_MODEL, reason: "Live voice is unavailable on this Home23 installation." });
  }));
  router.post(`${base}/sessions`, auth, idempotency, json, route(async (request, response) => {
    const body = request.body;
    if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.sdp !== "string" ||
      !body.sdp.trim() || Buffer.byteLength(body.sdp) > 65_536 ||
      (body.modelAlias != null && (typeof body.modelAlias !== "string" || body.modelAlias.length > 256)) ||
      (body.voice != null && !LIVE_VOICE_VOICES.includes(body.voice)) ||
      (body.speakingPace != null && !LIVE_VOICE_PACES.includes(body.speakingPace)) ||
      (body.reasoningEffort != null && !REASONING_EFFORTS.includes(body.reasoningEffort))) {
      throw new CoordinationHttpError("request_invalid", 400, false);
    }
    response.set("Cache-Control", "no-store");
    response.status(201).json(await service().start({ ...access(request, response),
      idempotencyKey: coordinationIdempotencyKey(response), sdp: body.sdp,
      voice: (body.voice ?? "marin") as LiveVoiceStart["voice"], speakingPace: (body.speakingPace ?? "normal") as LiveVoiceStart["speakingPace"],
      modelAlias: body.modelAlias ?? null, reasoningEffort: (body.reasoningEffort ?? null) as ReasoningEffort | null }));
  }));
  router.post(`${base}/sessions/:sessionId/heartbeat`, auth, idempotency, json, route(async (request, response) => {
    response.set("Cache-Control", "no-store");
    response.json(await service().heartbeat({ ...access(request, response), sessionId: parameter(request.params.sessionId) }));
  }));
  router.post(`${base}/sessions/:sessionId/close`, auth, idempotency, json, route(async (request, response) => {
    response.set("Cache-Control", "no-store");
    response.json(await service(true).close({ ...access(request, response), sessionId: parameter(request.params.sessionId) }));
  }));
}
