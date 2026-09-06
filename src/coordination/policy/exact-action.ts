import { createHash } from "node:crypto";

import type { ExactAction, JsonValue } from "./types.js";

function canonicalJson(value: JsonValue, ancestors: Set<object>): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("exact action contains a non-finite number");
    return JSON.stringify(value);
  }

  if (typeof value !== "object") {
    throw new TypeError("exact action contains a non-JSON value");
  }

  if (ancestors.has(value)) throw new TypeError("exact action contains a cycle");
  ancestors.add(value);

  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw new TypeError("exact action array is not a plain JSON array");
      }
      if (Object.getOwnPropertySymbols(value).length > 0) {
        throw new TypeError("exact action array contains symbol properties");
      }
      const allowedNames = new Set(["length"]);
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, index);
        if (!descriptor) {
          throw new TypeError("exact action contains a sparse array");
        }
        if (!descriptor.enumerable || !("value" in descriptor)) {
          throw new TypeError(
            "exact action array index must be an enumerable data property",
          );
        }
        allowedNames.add(String(index));
      }
      if (Object.getOwnPropertyNames(value).some((name) => !allowedNames.has(name))) {
        throw new TypeError("exact action array contains non-JSON properties");
      }
      return `[${value.map((item) => canonicalJson(item, ancestors)).join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("exact action value is not a plain JSON object");
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new TypeError("exact action object contains symbol properties");
    }
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
      if (!descriptor.enumerable || !("value" in descriptor)) {
        throw new TypeError("exact action object contains non-JSON properties");
      }
    }

    const entries = Object.keys(value)
      .sort()
      .map((key) => {
        const item = (value as { readonly [key: string]: JsonValue })[key];
        if (item === undefined) throw new TypeError("exact action contains undefined");
        return `${JSON.stringify(key)}:${canonicalJson(item, ancestors)}`;
      });
    return `{${entries.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalizeJsonValue(value: JsonValue): string {
  return canonicalJson(value, new Set());
}

export function digestCanonicalJson(value: JsonValue): string {
  return createHash("sha256").update(canonicalizeJsonValue(value), "utf8").digest("hex");
}

export function canonicalizeExactAction(action: ExactAction): string {
  return canonicalizeJsonValue(action as unknown as JsonValue);
}

export function digestExactAction(action: ExactAction): string {
  return digestCanonicalJson(action as unknown as JsonValue);
}
