import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import type { MessagingActorContext } from "../channels/types.js";
import { CoordinationHttpError } from "../http/errors.js";

export type HomeUpdateAction = "check" | "update" | "resume" | "recover";
export interface HomeUpdateService {
  status(clientBuild?: number): Promise<unknown>;
  request(input: { action: HomeUpdateAction; clientBuild?: number; idempotencyKey: string }, context: MessagingActorContext): Promise<unknown>;
}

/** Both source and compiled Core resolve the same shipped CLI module. */
export function createHomeUpdateService(installationRoot: string): HomeUpdateService {
  const root = resolve(installationRoot);
  const homeRoot = existsSync(resolve(root, ".home23-install.json")) ? root : dirname(root);
  const moduleURL = pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), "../../../cli/lib/product-home-update.js")).href;
  const controller = () => import(moduleURL);
  return {
    async status(clientBuild) {
      return (await controller()).homeUpdateStatus({ homeRoot, clientBuild });
    },
    async request(input, context) {
      if (context.identity.kind !== "owner" || context.principalId !== "user_owner") {
        throw new CoordinationHttpError("forbidden", 403, false);
      }
      try {
        return await (await controller()).requestHomeUpdate({ ...input, homeRoot, principalId: context.principalId });
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === "idempotency_conflict" || code === "home_update_busy") {
          throw new CoordinationHttpError(code, 409, false, {}, "Read the current home update status before retrying.");
        }
        if (code === "request_invalid") throw new CoordinationHttpError(code, 400, false);
        throw new CoordinationHttpError("home_update_unavailable", 503, true, {}, "Open Home23 on the Mac running your home to check update and recovery status.");
      }
    },
  };
}
