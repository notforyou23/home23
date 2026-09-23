import express, { type Express, type Request, type Response, type NextFunction } from "express";
import type { CoordinationApplication } from "../app/types.js";
import { CoordinationHttpError } from "../http/errors.js";
import { coordinationIdempotencyKey, requireCoordinationAuth, requireCoordinationContext, requireIdempotencyKey } from "../http/middleware.js";
import type { HomeUpdateAction } from "./service.js";

function route(handler: (request: Request, response: Response) => Promise<void>) {
  return (request: Request, response: Response, next: NextFunction) => void handler(request, response).catch(next);
}
function build(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && /^[0-9]+$/.test(value)) value = Number(value);
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new CoordinationHttpError("request_invalid", 400, false);
  return value;
}
export function mountHomeUpdateRoutes(router: Express, application: CoordinationApplication) {
  const read = requireCoordinationAuth(application, ["product:read"]);
  const manage = requireCoordinationAuth(application, ["product:read", "message:send"]);
  const service = (response: Response) => {
    const context = requireCoordinationContext(response);
    if (context.identity.kind !== "owner" || context.principalId !== "user_owner") throw new CoordinationHttpError("forbidden", 403, false);
    if (!application.flags["coordination.process.enabled"] || !application.flags["coordination.public_api.enabled"] || !application.services.homeUpdate) {
      throw new CoordinationHttpError("home_update_unavailable", 503, true);
    }
    response.setHeader("cache-control", "private, no-store");
    return application.services.homeUpdate;
  };
  router.get("/api/v1/home-update", read, route(async (request, response) => {
    response.json(await service(response).status(build(request.query.clientBuild)));
  }));
  router.post("/api/v1/home-update", manage, requireIdempotencyKey(application),
    express.json({ limit: 1024 }), route(async (request, response) => {
      const body = request.body;
      if (!body || typeof body !== "object" || Array.isArray(body)
          || Object.keys(body).some(key => !["action", "clientBuild"].includes(key))
          || !["check", "update", "resume", "recover"].includes(body.action)
          || body.clientBuild === undefined) {
        throw new CoordinationHttpError("request_invalid", 400, false);
      }
      const result = await service(response).request({ action: body.action as HomeUpdateAction,
        clientBuild: build(body.clientBuild), idempotencyKey: coordinationIdempotencyKey(response) }, requireCoordinationContext(response));
      response.status(202).json(result);
    }));
}
