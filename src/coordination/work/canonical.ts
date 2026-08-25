import { createHash } from "node:crypto";

import { assertCoordinationId } from "../ids/index.js";
import type { ContractIdKind } from "../schema/contract-registry.js";

import { WorkError, type WorkErrorCode } from "./errors.js";

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite canonical JSON number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error("canonical JSON requires plain JSON values");
  }
  return `{${Object.entries(value)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(",")}}`;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function assertExactKeys(
  value: unknown,
  allowed: readonly string[],
  code: WorkErrorCode,
  label: string,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new WorkError(code, `${label} must be a plain object`);
  }
  const keys = Object.keys(value).sort();
  const expected = [...allowed].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new WorkError(code, `${label} contains missing or forbidden fields`);
  }
}

export function assertId(kind: ContractIdKind, value: unknown, code: WorkErrorCode): string {
  if (typeof value !== "string") throw new WorkError(code, `invalid ${kind} ID`);
  try {
    assertCoordinationId(kind, value);
  } catch {
    throw new WorkError(code, `invalid ${kind} ID`);
  }
  return value;
}

export function assertDigest(value: unknown, code: WorkErrorCode, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new WorkError(code, `${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

export function assertSafeReference(
  value: unknown,
  code: WorkErrorCode,
  label: string,
): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 256 ||
    !/^[a-z][a-z0-9_-]*:[A-Za-z0-9._:-]+$/.test(value) ||
    value.includes("..")
  ) {
    throw new WorkError(code, `${label} must be a privacy-safe authority reference`);
  }
  return value;
}

export function canonicalTimestamp(date: Date): string {
  const value = date.toISOString();
  if (value.length !== 24) throw new Error("M11 timestamps require UTC milliseconds");
  return value;
}
