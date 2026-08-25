const SENSITIVE_KEYS = new Set([
  "authorization",
  "cookie",
  "setcookie",
  "pairingcode",
  "codeverifier",
  "refreshtoken",
  "accesstoken",
  "token",
  "secret",
  "password",
  "keymaterial",
  "signingkey",
  "accesssigningkey",
  "credentialgenerationkey",
  "idempotencydigestkey",
  "refreshdigestkey",
]);

function normalizedKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function redactEmbeddedCredentials(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [REDACTED]")
    .replace(/h23r1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/g, "[REDACTED]")
    .replace(/\b(?:[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}|[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}[- ][ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5})\b/gi, "[REDACTED]")
    .replace(
      /\b[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g,
      "[REDACTED]",
    );
}

function redactValue(value: unknown, ancestors: WeakSet<object>): unknown {
  if (typeof value === "string") return redactEmbeddedCredentials(value);
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "undefined"
  ) {
    return value;
  }
  if (typeof value !== "object") return String(value);
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    return "[REDACTED:BINARY]";
  }
  if (ancestors.has(value)) return "[REDACTED:CIRCULAR]";
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry) => redactValue(entry, ancestors));
    }
    if (value instanceof Error) {
      return {
        name: value.name,
        message: redactEmbeddedCredentials(value.message),
      };
    }
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      output[key] = SENSITIVE_KEYS.has(normalizedKey(key))
        ? "[REDACTED]"
        : redactValue(entry, ancestors);
    }
    return output;
  } finally {
    ancestors.delete(value);
  }
}

export function redactAuthDiagnostic(value: unknown): unknown {
  return redactValue(value, new WeakSet<object>());
}
