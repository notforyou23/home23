import {
  ID_REGISTRY,
  type ContractIdKind,
  validateContractId,
} from "../schema/contract-registry.js";

import { UuidV7Generator, isUuidV7, uuidV7 } from "./uuid-v7.js";

export { UuidV7Generator, isUuidV7, uuidV7 } from "./uuid-v7.js";

export type GeneratedCoordinationIdKind = Exclude<ContractIdKind, "principal">;

export function generateCoordinationId(
  kind: GeneratedCoordinationIdKind,
  generator?: UuidV7Generator,
): string {
  const rule = ID_REGISTRY[kind];
  if (!rule?.prefix) {
    throw new Error(`${kind} does not have a generatable coordination ID prefix`);
  }
  const value = `${rule.prefix}${generator?.generate() ?? uuidV7()}`;
  assertCoordinationId(kind, value);
  return value;
}

export function validateCoordinationId(kind: ContractIdKind, value: string): boolean {
  return validateContractId(kind, value);
}

export function assertCoordinationId(kind: ContractIdKind, value: string): void {
  if (!validateCoordinationId(kind, value)) {
    throw new Error(`invalid ${kind} ID`);
  }
}
