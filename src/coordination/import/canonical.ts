import { createHash } from "node:crypto";

export function canonicalJson(value: unknown, ancestors = new Set<object>()): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON cannot encode a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new Error("canonical JSON contains a circular array");
    ancestors.add(value);
    try {
      const entries: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new Error(`canonical JSON contains a sparse array at index ${index}`);
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || descriptor.get || descriptor.set) {
          throw new Error(`canonical JSON contains an accessor property at array index ${index}`);
        }
        entries.push(canonicalJson(descriptor.value, ancestors));
      }
      return `[${entries.join(",")}]`;
    } finally {
      ancestors.delete(value);
    }
  }
  if (!value || typeof value !== "object") {
    throw new Error("canonical JSON cannot encode a non-JSON value");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("canonical JSON contains a non-JSON object");
  }
  if (ancestors.has(value)) throw new Error("canonical JSON contains a circular object");
  ancestors.add(value);
  try {
    const symbols = Object.getOwnPropertySymbols(value)
      .filter((symbol) => Object.getOwnPropertyDescriptor(value, symbol)?.enumerable);
    if (symbols.length > 0) throw new Error("canonical JSON contains an enumerable symbol key");
    const entries = Object.keys(value).sort().map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || descriptor.get || descriptor.set) {
        throw new Error(`canonical JSON contains an accessor property: ${key}`);
      }
      return `${JSON.stringify(key)}:${canonicalJson(descriptor.value, ancestors)}`;
    });
    return `{${entries.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export function requireSha256(value: string, field: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`${field} must be a lowercase SHA-256 digest`);
}

export function requireCanonicalTimestamp(value: string, field: string): void {
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== value) {
    throw new Error(`${field} must be a canonical ISO-8601 timestamp`);
  }
}
