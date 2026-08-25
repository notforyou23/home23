export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | { readonly [key: string]: JsonValue }
  | readonly JsonValue[];

export interface ExactAction {
  actorPrincipalId: string;
  operation: string;
  target: string;
  parameters: JsonValue;
}

export type StandingAuthorizationState =
  | "within"
  | "outside"
  | "unknown"
  | "not_applicable";

export interface StandingAuthorizationContext {
  scope: Exclude<StandingAuthorizationState, "not_applicable">;
  delegation: StandingAuthorizationState;
  budget: StandingAuthorizationState;
  audience: StandingAuthorizationState;
  allowlist: StandingAuthorizationState;
}

/**
 * Provenance for standing and impact facts resolved outside this package.
 * Future runtime wiring must construct this only at its trusted server-side
 * policy boundary, never from model output or an action request body.
 */
export interface PolicyFactSource {
  kind: "trusted_policy_boundary";
  reference: string;
}

export type ActionImpactClass =
  | "catastrophic_or_broad_irreversible_loss"
  | "material_spend_or_new_financial_obligation"
  | "irreversible_credential_security_recovery_or_ownership_transfer"
  | "secret_or_private_data_disclosure"
  | "ambiguous_high_impact_public_legal_or_sensitive_statement";

export interface CrossResidentPrivateContextProvenance {
  manifestId: string;
  sourceResidentId: string;
  sourceReferences: readonly string[];
}

export interface CrossResidentPrivateContextReadRequest {
  access: "read";
  projectScope: string;
  subjects: readonly string[];
  recipients: readonly string[];
  allowedClasses: readonly string[];
  expiresAt: string;
  provenance: CrossResidentPrivateContextProvenance;
  enforcement: "read_only";
}

export type ContextAccess =
  | { kind: "none" }
  | {
      kind: "cross_resident_private";
      request: CrossResidentPrivateContextReadRequest | null;
    };

export interface PolicyRequest {
  action: ExactAction;
  factSource: PolicyFactSource;
  /** Resolved by `factSource`; not caller-selected policy input. */
  standing: StandingAuthorizationContext;
  /** Resolved by `factSource`; not caller-selected policy input. */
  impactClasses: readonly ActionImpactClass[];
  contextAccess: ContextAccess;
}

export type AllowReasonCode = "allow.standing_authority";

export type HardGateReasonCode =
  | "hard_gate.catastrophic_or_broad_irreversible_loss"
  | "hard_gate.material_spend_or_new_financial_obligation_outside_standing_authority"
  | "hard_gate.irreversible_credential_security_recovery_or_ownership_transfer"
  | "hard_gate.secret_or_private_data_disclosure_outside_established_audience"
  | "hard_gate.ambiguous_high_impact_public_legal_or_sensitive_statement_without_standing_mandate";

export type DenyReasonCode =
  | "deny.outside_standing_authority"
  | "deny.standing_authority_unresolved"
  | "deny.invalid_evaluation_time"
  | "deny.policy_facts_untrusted"
  | "deny.policy_context_invalid"
  | "deny.unknown_impact_class"
  | "deny.unknown_context_access"
  | "deny.cross_resident_private_context_explicit_request_required"
  | "deny.cross_resident_private_context_request_invalid"
  | "deny.cross_resident_private_context_expired"
  | "deny.cross_resident_private_context_read_only"
  | "deny.cross_resident_private_context_grant_unavailable";

interface PolicyDecisionBase {
  policyVersion: 1;
  actionDigest: string;
  policyContextDigest: string;
}

export type PolicyDecision =
  | (PolicyDecisionBase & { decision: "allow"; reasonCode: AllowReasonCode })
  | (PolicyDecisionBase & { decision: "hard_gate"; reasonCode: HardGateReasonCode })
  | (PolicyDecisionBase & { decision: "deny"; reasonCode: DenyReasonCode });

export interface GateAuthorization {
  authorizationId: string;
  policyVersion: 1;
  actionDigest: string;
  policyContextDigest: string;
  hardGateReason: HardGateReasonCode;
  expiresAt: string;
}

export interface GateAuthorizationConsumption {
  authorizationId: string;
  actionDigest: string;
  consumedAt: string;
}

/**
 * Future consumers supply this from their trusted authorization boundary.
 * `consumeOnce` must atomically reject an already-consumed authorization and
 * mark a newly accepted authorization consumed before returning true.
 */
export interface GateAuthorizationAuthority {
  verifyAuthorization(authorization: GateAuthorization): boolean;
  consumeOnce(consumption: GateAuthorizationConsumption): boolean;
}

export type GateExecutionReasonCode =
  | AllowReasonCode
  | DenyReasonCode
  | "allow.hard_gate_authorization_consumed"
  | "deny.hard_gate_authorization_required"
  | "deny.hard_gate_authorization_invalid"
  | "deny.hard_gate_authorization_policy_mismatch"
  | "deny.hard_gate_authorization_digest_mismatch"
  | "deny.hard_gate_authorization_context_mismatch"
  | "deny.hard_gate_authorization_reason_mismatch"
  | "deny.hard_gate_authorization_expired"
  | "deny.hard_gate_authorization_unverified"
  | "deny.hard_gate_authorization_replayed"
  | "deny.hard_gate_authorization_consumption_failed";

export interface GateExecutionDecision {
  decision: "allow" | "deny";
  reasonCode: GateExecutionReasonCode;
  actionDigest: string;
  policyDecision: PolicyDecision;
}
