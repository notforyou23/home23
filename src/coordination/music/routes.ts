import express, { type Express, type NextFunction, type Request, type Response } from "express";

import type { CoordinationApplication } from "../app/types.js";
import { CoordinationHttpError } from "../http/errors.js";
import { requireCoordinationAuth, requireCoordinationContext } from "../http/middleware.js";

const SHOW_ID_RE = /^[0-9a-f]{32}$/i;

function route(handler: (request: Request, response: Response) => Promise<void>) {
  return (request: Request, response: Response, next: NextFunction) => {
    void handler(request, response).catch(next);
  };
}

function invalid(): never {
  throw new CoordinationHttpError("request_invalid", 400, false);
}

function validFullPath(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 1024
    && !value.includes("..")
    && !value.includes("\\")
    && !value.includes("\0")
    && !value.includes("://");
}

export function mountJerryStreamRoutes(router: Express, application: CoordinationApplication) {
  const read = requireCoordinationAuth(application, ["product:read"]);
  router.post(
    "/api/v1/music/jerry/stream",
    read,
    express.json({ limit: 4096 }),
    route(async (request, response) => {
      const context = requireCoordinationContext(response);
      if (context.identity.kind !== "owner" || context.principalId !== "user_owner") {
        throw new CoordinationHttpError("forbidden", 403, false);
      }
      if (!application.services.jerryStream) {
        throw new CoordinationHttpError(
          "audio_tokens_unconfigured",
          503,
          true,
          {},
          "Household audio tokens are not configured.",
        );
      }
      const body = request.body;
      if (!body || typeof body !== "object" || Array.isArray(body)) invalid();
      const keys = Object.keys(body as object);
      if (keys.some((key) => key !== "show_id" && key !== "full_path")) invalid();
      const showId = (body as { show_id?: unknown }).show_id;
      const fullPath = (body as { full_path?: unknown }).full_path;
      if (showId === undefined && fullPath === undefined) invalid();
      if (showId !== undefined && (typeof showId !== "string" || !SHOW_ID_RE.test(showId))) invalid();
      if (fullPath !== undefined && !validFullPath(fullPath)) invalid();

      response.setHeader("cache-control", "private, no-store");
      response.json(await application.services.jerryStream.mint({
        ...(typeof showId === "string" ? { show_id: showId } : {}),
        ...(typeof fullPath === "string" ? { full_path: fullPath } : {}),
      }));
    }),
  );
}
