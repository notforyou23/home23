import registryDocument from "../contracts/v1/registry.json" with { type: "json" };

export const CONNECTED_AGENTS_CONTRACT_VERSION = 1 as const;

type UnknownPolicy = "preserve" | "reject" | "ignore_and_advance_cursor";

interface IdRule {
  prefix: string | null;
  pattern: string;
  visibility: string;
  meaning?: string;
  ordering?: string;
}

interface StateMachineRule {
  states: string[];
  transitions: [string, string][];
  terminal: string[];
  terminalPolicy: string;
}

interface PublicEnumRule {
  values: string[];
  unknownPolicy: UnknownPolicy;
  unknownAction: string;
}

interface FeatureFlagRule {
  default: false;
  effectWhenOff: string;
}

interface AuthorityEpochRule {
  capabilities: string[];
  modes: string[];
  mutationPolicy: "append_new_epoch";
  writerPolicy: string;
  flagPolicy: string;
  requiredReceiptFields: string[];
}

interface ApiOperationRule {
  method: string;
  path: string;
  authorityCapability: string | null;
}

interface RegistryDocument {
  contractVersion: number;
  ids: Record<string, IdRule>;
  stateMachines: Record<string, StateMachineRule>;
  publicEnums: Record<string, PublicEnumRule>;
  featureFlags: Record<string, FeatureFlagRule>;
  authorityEpoch: AuthorityEpochRule;
  protocol: Record<string, unknown>;
  scope: Record<string, unknown>;
  apiOperations: Record<string, ApiOperationRule>;
}

const registry = registryDocument as unknown as RegistryDocument;

if (registry.contractVersion !== CONNECTED_AGENTS_CONTRACT_VERSION) {
  throw new Error(
    `Connected Agents registry version ${registry.contractVersion} does not match ${CONNECTED_AGENTS_CONTRACT_VERSION}`,
  );
}

export const ID_REGISTRY = Object.freeze(registry.ids);
export const STATE_MACHINE_REGISTRY = Object.freeze(registry.stateMachines);
export const PUBLIC_ENUM_REGISTRY = Object.freeze(registry.publicEnums);
export const FEATURE_FLAG_REGISTRY = Object.freeze(registry.featureFlags);
export const AUTHORITY_EPOCH_REGISTRY = Object.freeze(registry.authorityEpoch);
export const PROTOCOL_REGISTRY = Object.freeze(registry.protocol);
export const CONTRACT_SCOPE_REGISTRY = Object.freeze(registry.scope);
export const API_OPERATION_REGISTRY = Object.freeze(registry.apiOperations);

export type ContractIdKind = keyof typeof ID_REGISTRY;
export type StateMachineName = keyof typeof STATE_MACHINE_REGISTRY;
export type PublicEnumName = keyof typeof PUBLIC_ENUM_REGISTRY;

const idPatterns = new Map<string, RegExp>();

export function validateContractId(kind: ContractIdKind, value: string): boolean {
  const rule = ID_REGISTRY[kind];
  if (!rule) return false;
  let pattern = idPatterns.get(kind);
  if (!pattern) {
    pattern = new RegExp(rule.pattern);
    idPatterns.set(kind, pattern);
  }
  return pattern.test(value);
}

export function isLegalTransition(
  machineName: StateMachineName,
  from: string,
  to: string,
): boolean {
  const machine = STATE_MACHINE_REGISTRY[machineName];
  if (!machine || !machine.states.includes(from) || !machine.states.includes(to)) {
    return false;
  }
  if (machine.terminal.includes(from)) return false;
  return machine.transitions.some(([source, destination]) => source === from && destination === to);
}

export type DecodedPublicEnum =
  | { kind: "known"; value: string }
  | { kind: "unknown"; rawValue: string; action: string };

export function decodePublicEnum(
  enumName: PublicEnumName,
  rawValue: string,
): DecodedPublicEnum {
  const rule = PUBLIC_ENUM_REGISTRY[enumName];
  if (!rule) throw new Error(`unknown public enum registry: ${enumName}`);
  if (rule.values.includes(rawValue)) return { kind: "known", value: rawValue };
  if (rule.unknownPolicy === "reject") {
    throw new Error(`unknown ${enumName} value: ${rawValue}`);
  }
  return {
    kind: "unknown",
    rawValue,
    action: rule.unknownAction,
  };
}
