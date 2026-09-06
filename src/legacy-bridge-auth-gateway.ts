import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, request as upstreamRequest, type IncomingMessage, type ServerResponse } from "node:http";

interface GatewayEntry {
  listenPort: number;
  upstreamPort: number;
  staticToken: string;
}

interface GatewayConfig {
  bindHost: string;
  coordinationOrigin: string;
  gateways: GatewayEntry[];
}

const ALLOWED_ROUTES: ReadonlyArray<[string, RegExp]> = [
  ["POST", /^\/api\/chat\/(turn|stop-turn|realtime\/session)$/],
  ["GET", /^\/api\/chat\/(stream|turn-status|pending|models|history|conversations)(?:\/[^/]+)?$/],
  ["GET", /^\/api\/chat\/media(?:\/.*)?$/],
  ["PATCH", /^\/api\/chat\/conversations\/[^/]+$/],
  ["POST", /^\/api\/device\/register$/],
  ["DELETE", /^\/api\/device\/register$/],
  ["GET", /^\/api\/device\/registry$/],
] as const;

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function bearer(request: IncomingMessage): string | undefined {
  const header = request.headers.authorization;
  if (typeof header === "string" && header.startsWith("Bearer ") && header.length <= 4103) return header;
  const url = new URL(request.url ?? "/", "http://legacy.invalid");
  const token = url.searchParams.get("token");
  return token && token.length <= 4096 ? `Bearer ${token}` : undefined;
}

function json(response: ServerResponse, status: number, body: object): void {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

export async function authorizeLegacyBridgeRequest(input: {
  authorization: string | undefined;
  staticToken: string;
  coordinationOrigin: string;
  fetchImpl?: typeof fetch;
}): Promise<"scoped" | "unauthorized" | "unavailable"> {
  if (!input.authorization) return "unauthorized";
  if (safeEqual(input.authorization, `Bearer ${input.staticToken}`)) return "unauthorized";
  try {
    const response = await (input.fetchImpl ?? fetch)(`${input.coordinationOrigin}/api/v1/legacy-bridge/session`, {
      headers: { authorization: input.authorization, accept: "application/json" },
      signal: AbortSignal.timeout(5_000),
    });
    if (response.status === 401 || response.status === 403) return "unauthorized";
    if (!response.ok) return "unavailable";
    const receipt = await response.json() as { ok?: unknown; scopes?: unknown };
    return receipt.ok === true
      && Array.isArray(receipt.scopes)
      && receipt.scopes.includes("legacy-bridge:access")
      ? "scoped"
      : "unauthorized";
  } catch {
    return "unavailable";
  }
}

export function createLegacyBridgeGateway(entry: GatewayEntry, config: Pick<GatewayConfig, "coordinationOrigin">) {
  return createServer(async (request, response) => {
    const path = new URL(request.url ?? "/", "http://legacy.invalid").pathname;
    if (!ALLOWED_ROUTES.some(([method, pattern]) => request.method === method && pattern.test(path))) {
      json(response, 404, { error: "Not found" });
      return;
    }
    const decision = await authorizeLegacyBridgeRequest({
      authorization: bearer(request),
      staticToken: entry.staticToken,
      coordinationOrigin: config.coordinationOrigin,
    });
    if (decision === "unauthorized") {
      json(response, 401, { error: "Unauthorized" });
      return;
    }
    if (decision === "unavailable") {
      json(response, 503, { error: "Auth service unavailable" });
      return;
    }
    const forward = (body?: Buffer) => {
      const headers = { ...request.headers, host: `127.0.0.1:${entry.upstreamPort}`, authorization: `Bearer ${entry.staticToken}` };
      if (body) headers["content-length"] = String(body.length);
      const upstream = upstreamRequest({ hostname: "127.0.0.1", port: entry.upstreamPort, method: request.method, path: request.url, headers }, (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      });
      upstream.on("error", () => {
        if (!response.headersSent) json(response, 502, { error: "Bridge unavailable" });
        else response.destroy();
      });
      if (body) upstream.end(body); else request.pipe(upstream);
    };
    if (request.method === "POST" && path === "/api/device/register") {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > 64 * 1024) { json(response, 413, { error: "Payload too large" }); return; }
        chunks.push(bytes);
      }
      const body = Buffer.concat(chunks);
      try {
        const parsed = JSON.parse(body.toString("utf8")) as { bundle_id?: unknown };
        if (parsed.bundle_id !== "com.regina6.home23") { json(response, 403, { error: "Production bundle required" }); return; }
      } catch { json(response, 400, { error: "Invalid JSON" }); return; }
      forward(body);
    } else {
      forward();
    }
  });
}

function loadConfig(path: string): GatewayConfig {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as GatewayConfig;
  const sharedToken = process.env.HOME23_LEGACY_BRIDGE_STATIC_TOKEN;
  parsed.gateways = parsed.gateways?.map((entry) => ({ ...entry, staticToken: entry.staticToken || sharedToken || "" }));
  if (!parsed || typeof parsed.bindHost !== "string" || parsed.bindHost === "0.0.0.0"
      || !/^http:\/\/127\.0\.0\.1:\d+$/.test(parsed.coordinationOrigin)
      || !Array.isArray(parsed.gateways) || parsed.gateways.length < 1
      || parsed.gateways.some((entry) => !Number.isSafeInteger(entry.listenPort)
        || !Number.isSafeInteger(entry.upstreamPort)
        || entry.listenPort < 1024 || entry.listenPort > 65535
        || entry.upstreamPort < 1024 || entry.upstreamPort > 65535
        || typeof entry.staticToken !== "string" || entry.staticToken.length < 32 || entry.staticToken.length > 4096)) {
    throw new Error("legacy bridge gateway configuration invalid");
  }
  return parsed;
}

const configPath = process.env.HOME23_LEGACY_BRIDGE_GATEWAY_CONFIG;
if (configPath) {
  const config = loadConfig(configPath);
  for (const entry of config.gateways) {
    createLegacyBridgeGateway(entry, config).listen(entry.listenPort, config.bindHost, () => {
      console.log(`[legacy-bridge-auth-gateway] listening ${config.bindHost}:${entry.listenPort} -> 127.0.0.1:${entry.upstreamPort}`);
    });
  }
}
