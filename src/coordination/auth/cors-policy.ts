const ALLOWED_METHODS = Object.freeze(["GET", "POST", "PATCH", "DELETE", "OPTIONS"]);
const ALLOWED_HEADERS = Object.freeze([
  "authorization",
  "content-type",
  "idempotency-key",
  "last-event-id",
]);

export type CorsReasonCode =
  | "cors_origin_denied"
  | "cors_method_denied"
  | "cors_header_denied";

export interface CorsEvaluationInput {
  origin: string | null;
  method: string;
  requestedMethod?: string;
  requestHeaders: readonly string[];
}

export type CorsEvaluation =
  | { allowed: true; responseHeaders: Record<string, string> }
  | {
      allowed: false;
      reason: CorsReasonCode;
      responseHeaders: Record<string, string>;
    };

function validateConfiguredOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("CORS allowed origin is invalid");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    parsed.origin !== value
  ) {
    throw new Error("CORS allowed origin must be an exact HTTP(S) origin");
  }
  const loopbackHost = parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "[::1]";
  if (parsed.protocol === "http:" && !loopbackHost) {
    throw new Error("CORS cleartext origins are restricted to loopback hosts");
  }
  return value;
}

export function createCorsPolicy(options: { allowedOrigins: readonly string[] }) {
  const allowedOrigins = new Set(options.allowedOrigins.map(validateConfiguredOrigin));

  function deny(reason: CorsReasonCode, preflight: boolean): CorsEvaluation {
    return {
      allowed: false,
      reason,
      responseHeaders: {
        Vary: preflight
          ? "Origin, Access-Control-Request-Method, Access-Control-Request-Headers"
          : "Origin",
      },
    };
  }

  function evaluate(input: CorsEvaluationInput): CorsEvaluation {
    if (input.origin === null) return { allowed: true, responseHeaders: {} };
    const preflight = input.method.toUpperCase() === "OPTIONS";
    if (!allowedOrigins.has(input.origin)) return deny("cors_origin_denied", preflight);
    const method = (preflight ? input.requestedMethod : input.method)?.toUpperCase();
    if (!method || !ALLOWED_METHODS.includes(method)) {
      return deny("cors_method_denied", preflight);
    }
    const headers = input.requestHeaders.map((header) => header.trim().toLowerCase());
    if (headers.some((header) => !header || !ALLOWED_HEADERS.includes(header))) {
      return deny("cors_header_denied", preflight);
    }
    if (!preflight) {
      return {
        allowed: true,
        responseHeaders: {
          "Access-Control-Allow-Origin": input.origin,
          Vary: "Origin",
        },
      };
    }
    return {
      allowed: true,
      responseHeaders: {
        "Access-Control-Allow-Origin": input.origin,
        "Access-Control-Allow-Methods": ALLOWED_METHODS.join(", "),
        "Access-Control-Allow-Headers": ALLOWED_HEADERS.join(", "),
        "Access-Control-Max-Age": "600",
        Vary: "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
      },
    };
  }

  return Object.freeze({ evaluate });
}
