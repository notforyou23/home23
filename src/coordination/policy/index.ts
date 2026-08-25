export { canonicalizeExactAction, digestExactAction } from "./exact-action.js";
export { evaluateActionForExecution } from "./gate-execution.js";
export { CONNECTED_AGENTS_POLICY_VERSION, classifyPolicy } from "./policy-engine.js";
export type {
  ActionImpactClass,
  AllowReasonCode,
  ContextAccess,
  CrossResidentPrivateContextProvenance,
  CrossResidentPrivateContextReadRequest,
  DenyReasonCode,
  ExactAction,
  GateAuthorization,
  GateAuthorizationAuthority,
  GateAuthorizationConsumption,
  GateExecutionDecision,
  GateExecutionReasonCode,
  HardGateReasonCode,
  JsonPrimitive,
  JsonValue,
  PolicyDecision,
  PolicyFactSource,
  PolicyRequest,
  StandingAuthorizationContext,
  StandingAuthorizationState,
} from "./types.js";
