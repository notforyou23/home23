import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { CoordinationHttpError } from "../http/errors.js";
import { redactStashSecrets } from "./redact.js";

export const DEFAULT_HOUSEHOLD_TOKEN_URL =
  "http://127.0.0.1:3005/api/v1/audio/household-token";
export const DEFAULT_HOUSE_SERVICE_KEY_PATH = join(
  homedir(),
  ".config/shakedown/house-service.key",
);
export const HOUSEHOLD_TOKEN_CACHE_SKEW_MS = 60_000;
const MAX_KEY_BYTES = 8_192;
const DEFAULT_TIMEOUT_MS = 8_000;
const SHOW_ID_RE = /^[0-9a-f]{32}$/i;
const FORBIDDEN_PROXY_HEADERS = [
  "x-forwarded-for",
  "x-forwarded-host",
  "forwarded",
  "via",
  "x-real-ip",
] as const;

export interface JerryStreamRequest {
  show_id?: string;
  full_path?: string;
}

export interface JerryStreamFile {
  index: number;
  full_path: string;
  allowed: boolean;
  url: string;
}

export interface JerryStreamResponse {
  url: string | null;
  expires_at: string;
  show_id: string;
  files: JerryStreamFile[];
}

export interface JerryStreamService {
  mint(request: JerryStreamRequest): Promise<JerryStreamResponse>;
}

export interface JerryStreamServiceOptions {
  keyPath?: string;
  mintUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  cacheSkewMs?: number;
  timeoutMs?: number;
  warn?: (message: string) => void;
}

interface CachedMint {
  expiresAtMs: number;
  response: JerryStreamResponse;
}

function fail(
  code: string,
  httpStatus: number,
  retryable: boolean,
  message: string,
): never {
  throw new CoordinationHttpError(code, httpStatus, retryable, {}, message);
}

function assertLoopbackMintUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    fail("audio_tokens_unconfigured", 503, true, "Household audio tokens are not configured.");
  }
  const loopback =
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "localhost" ||
    parsed.hostname === "[::1]" ||
    parsed.hostname === "::1";
  if (parsed.protocol !== "http:" || parsed.username || parsed.password || !loopback) {
    fail("local_only", 403, false, "The household token mint must be called on loopback.");
  }
  return parsed;
}

export function showIdFromFullPath(fullPath: string): string | null {
  const first = fullPath.split("/")[0] ?? "";
  return SHOW_ID_RE.test(first) ? first.toLowerCase() : null;
}

function cacheKey(request: JerryStreamRequest): string | null {
  if (typeof request.show_id === "string" && SHOW_ID_RE.test(request.show_id)) {
    return request.show_id.toLowerCase();
  }
  if (typeof request.full_path === "string") return showIdFromFullPath(request.full_path);
  return null;
}

function projectFiles(value: unknown): JerryStreamFile[] {
  if (!Array.isArray(value)) return [];
  const files: JerryStreamFile[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const file = entry as Record<string, unknown>;
    if (typeof file.full_path !== "string" || typeof file.url !== "string") continue;
    files.push({
      index: Number.isSafeInteger(file.index) ? (file.index as number) : files.length,
      full_path: file.full_path,
      allowed: file.allowed !== false,
      url: file.url,
    });
  }
  return files;
}

function selectUrl(files: readonly JerryStreamFile[], fullPath?: string): string | null {
  if (fullPath) {
    const exact = files.find((file) => file.full_path === fullPath);
    if (exact) return exact.url;
    const suffix = files.find(
      (file) => file.full_path.endsWith(`/${fullPath}`) || file.full_path.endsWith(fullPath),
    );
    if (suffix) return suffix.url;
  }
  return files.find((file) => file.allowed)?.url ?? files[0]?.url ?? null;
}

function projectResponse(mint: Record<string, unknown>, fullPath?: string): JerryStreamResponse {
  if (typeof mint.show_id !== "string" || !SHOW_ID_RE.test(mint.show_id)) {
    fail("audio_tokens_unavailable", 503, true, "Household audio tokens are unavailable.");
  }
  if (typeof mint.expires_at !== "string" || Number.isNaN(Date.parse(mint.expires_at))) {
    fail("audio_tokens_unavailable", 503, true, "Household audio tokens are unavailable.");
  }
  const files = projectFiles(mint.files);
  return {
    url: selectUrl(files, fullPath),
    expires_at: mint.expires_at,
    show_id: mint.show_id.toLowerCase(),
    files,
  };
}

function mintBody(request: JerryStreamRequest): Record<string, string> {
  const body: Record<string, string> = {};
  if (request.show_id) body.show_id = request.show_id.toLowerCase();
  if (request.full_path) body.full_path = request.full_path;
  return body;
}

function headerRecord(headers: RequestInit["headers"]): Record<string, string> {
  const record: Record<string, string> = {};
  if (!headers) return record;
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      record[key.toLowerCase()] = value;
    });
    return record;
  }
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) record[String(key).toLowerCase()] = String(value);
    return record;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined) record[key.toLowerCase()] = String(value);
  }
  return record;
}

export function assertNoProxyHeaders(headers: RequestInit["headers"]): void {
  const record = headerRecord(headers);
  for (const name of FORBIDDEN_PROXY_HEADERS) {
    if (name in record) {
      fail("local_only", 403, false, "The household token mint must be called on loopback.");
    }
  }
}

function mapUpstreamError(status: number, code: string | undefined): never {
  if (status === 401 || code === "service_key_required") {
    fail("service_key_required", 401, false, "The house service key was rejected.");
  }
  if (status === 403 || code === "local_only") {
    fail("local_only", 403, false, "The household token mint must be called on loopback.");
  }
  if (status === 404 || code === "show_not_found") {
    fail("show_not_found", 404, false, "That show was not found.");
  }
  if (code === "audio_tokens_unconfigured") {
    fail("audio_tokens_unconfigured", 503, true, "Household audio tokens are not configured.");
  }
  fail("audio_tokens_unavailable", 503, true, "Household audio tokens are unavailable.");
}

async function readHouseServiceKey(keyPath: string): Promise<string> {
  let raw: string;
  try {
    raw = await readFile(keyPath, { encoding: "utf8" });
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT") {
      fail("audio_tokens_unconfigured", 503, true, "Household audio tokens are not configured.");
    }
    fail("audio_tokens_unavailable", 503, true, "Household audio tokens are unavailable.");
  }
  const key = raw.trim();
  if (!key || Buffer.byteLength(key, "utf8") > MAX_KEY_BYTES) {
    fail("audio_tokens_unconfigured", 503, true, "Household audio tokens are not configured.");
  }
  return key;
}

async function readUpstreamErrorCode(response: Response): Promise<string | undefined> {
  try {
    const body = await response.json() as { error?: unknown };
    return typeof body.error === "string" ? body.error : undefined;
  } catch {
    return undefined;
  }
}

export function createJerryStreamService(
  options: JerryStreamServiceOptions = {},
): JerryStreamService {
  const keyPath = options.keyPath ?? DEFAULT_HOUSE_SERVICE_KEY_PATH;
  const mintUrl = assertLoopbackMintUrl(options.mintUrl ?? DEFAULT_HOUSEHOLD_TOKEN_URL).href;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const cacheSkewMs = options.cacheSkewMs ?? HOUSEHOLD_TOKEN_CACHE_SKEW_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const warn = (message: string) => {
    options.warn?.(redactStashSecrets(message));
  };
  const cache = new Map<string, CachedMint>();

  const cached = (showId: string, fullPath?: string): JerryStreamResponse | null => {
    const entry = cache.get(showId);
    if (!entry || now() >= entry.expiresAtMs - cacheSkewMs) {
      if (entry) cache.delete(showId);
      return null;
    }
    return {
      ...entry.response,
      url: selectUrl(entry.response.files, fullPath),
    };
  };

  return {
    async mint(request) {
      const showId = cacheKey(request);
      if (showId) {
        const hit = cached(showId, request.full_path);
        if (hit) return hit;
      }

      const key = await readHouseServiceKey(keyPath);
      const headers = {
        accept: "application/json",
        "content-type": "application/json",
        "x-house-service-key": key,
      };
      assertNoProxyHeaders(headers);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      timer.unref?.();
      let response: Response;
      try {
        response = await fetchImpl(mintUrl, {
          method: "POST",
          headers,
          body: JSON.stringify(mintBody(request)),
          redirect: "error",
          signal: controller.signal,
        });
      } catch (error) {
        warn(`household-token mint failed: ${error instanceof Error ? error.message : "unavailable"}`);
        fail("audio_tokens_unavailable", 503, true, "Household audio tokens are unavailable.");
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        const code = await readUpstreamErrorCode(response);
        warn(`household-token mint failed status=${response.status}`);
        mapUpstreamError(response.status, code);
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        fail("audio_tokens_unavailable", 503, true, "Household audio tokens are unavailable.");
      }
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        fail("audio_tokens_unavailable", 503, true, "Household audio tokens are unavailable.");
      }

      const projected = projectResponse(payload as Record<string, unknown>, request.full_path);
      cache.set(projected.show_id, {
        expiresAtMs: Date.parse(projected.expires_at),
        response: projected,
      });
      return projected;
    },
  };
}
