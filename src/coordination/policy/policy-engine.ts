import { digestCanonicalJson, digestExactAction } from "./exact-action.js";
import type {
  ActionImpactClass,
  CrossResidentPrivateContextReadRequest,
  DenyReasonCode,
  ExactAction,
  HardGateReasonCode,
  PolicyDecision,
  PolicyRequest,
  StandingAuthorizationContext,
  JsonValue,
} from "./types.js";

export const CONNECTED_AGENTS_POLICY_VERSION = 1 as const;

const IMPACT_CLASS_ORDER: readonly ActionImpactClass[] = [
  "catastrophic_or_broad_irreversible_loss",
  "material_spend_or_new_financial_obligation",
  "irreversible_credential_security_recovery_or_ownership_transfer",
  "secret_or_private_data_disclosure",
  "ambiguous_high_impact_public_legal_or_sensitive_statement",
];

const KNOWN_IMPACT_CLASSES = new Set<string>(IMPACT_CLASS_ORDER);
const KNOWN_STANDING_STATES = new Set(["within", "outside", "unknown", "not_applicable"]);
const INVALID_EXACT_ACTION_DIGEST = digestCanonicalJson({ invalidExactAction: true });
const INVALID_POLICY_CONTEXT_DIGEST = digestCanonicalJson({ invalidPolicyContext: true });

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNonEmptyStringArray(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => isNonEmptyString(item))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  try {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  } catch {
    return false;
  }
}

function validateExactAction(
  action: unknown,
): { valid: true; actionDigest: string } | { valid: false; actionDigest: string } {
  try {
    const actionDigest = digestExactAction(action as ExactAction);
    if (
      !isRecord(action) ||
      !Object.hasOwn(action, "actorPrincipalId") ||
      !Object.hasOwn(action, "operation") ||
      !Object.hasOwn(action, "target") ||
      !Object.hasOwn(action, "parameters") ||
      !isNonEmptyString(action.actorPrincipalId) ||
      !isNonEmptyString(action.operation) ||
      !isNonEmptyString(action.target)
    ) {
      return { valid: false, actionDigest: INVALID_EXACT_ACTION_DIGEST };
    }
    return { valid: true, actionDigest };
  } catch {
    return { valid: false, actionDigest: INVALID_EXACT_ACTION_DIGEST };
  }
}

function validatePrivateReadRequest(
  request: unknown,
  now: Date,
): { valid: true } | { valid: false; reasonCode: DenyReasonCode } {
  if (!isRecord(request)) {
    return {
      valid: false,
      reasonCode: "deny.cross_resident_private_context_request_invalid",
    };
  }

  if (request.access !== "read" || request.enforcement !== "read_only") {
    return {
      valid: false,
      reasonCode: "deny.cross_resident_private_context_read_only",
    };
  }

  const provenance = request.provenance;
  if (
    !isNonEmptyString(request.projectScope) ||
    !isNonEmptyStringArray(request.subjects) ||
    !isNonEmptyStringArray(request.recipients) ||
    !isNonEmptyStringArray(request.allowedClasses) ||
    !isNonEmptyString(request.expiresAt) ||
    !isRecord(provenance) ||
    !isNonEmptyString(provenance.manifestId) ||
    !isNonEmptyString(provenance.sourceResidentId) ||
    !isNonEmptyStringArray(provenance.sourceReferences)
  ) {
    return {
      valid: false,
      reasonCode: "deny.cross_resident_private_context_request_invalid",
    };
  }

  const expiry = Date.parse(request.expiresAt);
  if (!Number.isFinite(expiry)) {
    return {
      valid: false,
      reasonCode: "deny.cross_resident_private_context_request_invalid",
    };
  }
  if (expiry <= now.getTime()) {
    return {
      valid: false,
      reasonCode: "deny.cross_resident_private_context_expired",
    };
  }

  return { valid: true };
}

function standingValues(standing: StandingAuthorizationContext): unknown[] {
  return [
    standing.scope,
    standing.delegation,
    standing.budget,
    standing.audience,
    standing.allowlist,
  ];
}

function hasUnresolvedStandingAuthority(standing: StandingAuthorizationContext): boolean {
  if (standing.scope === ("not_applicable" as StandingAuthorizationContext["scope"])) {
    return true;
  }
  return standingValues(standing).some(
    (value) => value === "unknown" || !KNOWN_STANDING_STATES.has(String(value)),
  );
}

function isOutsideStandingAuthority(standing: StandingAuthorizationContext): boolean {
  return standingValues(standing).some((value) => value === "outside");
}

function hardGateReason(
  impactClasses: ReadonlySet<ActionImpactClass>,
  standing: StandingAuthorizationContext,
): HardGateReasonCode | null {
  if (impactClasses.has("catastrophic_or_broad_irreversible_loss")) {
    return "hard_gate.catastrophic_or_broad_irreversible_loss";
  }

  if (
    impactClasses.has("material_spend_or_new_financial_obligation") &&
    (standing.scope === "outside" ||
      standing.budget === "outside" ||
      standing.budget === "not_applicable")
  ) {
    return "hard_gate.material_spend_or_new_financial_obligation_outside_standing_authority";
  }

  if (
    impactClasses.has("irreversible_credential_security_recovery_or_ownership_transfer")
  ) {
    return "hard_gate.irreversible_credential_security_recovery_or_ownership_transfer";
  }

  if (
    impactClasses.has("secret_or_private_data_disclosure") &&
    (standing.scope === "outside" ||
      standing.audience === "outside" ||
      standing.audience === "not_applicable")
  ) {
    return "hard_gate.secret_or_private_data_disclosure_outside_established_audience";
  }

  if (
    impactClasses.has("ambiguous_high_impact_public_legal_or_sensitive_statement") &&
    (standing.scope === "outside" || standing.delegation !== "within")
  ) {
    return "hard_gate.ambiguous_high_impact_public_legal_or_sensitive_statement_without_standing_mandate";
  }

  return null;
}

function decision(
  actionDigest: string,
  policyContextDigest: string,
  result: Pick<PolicyDecision, "decision" | "reasonCode">,
): PolicyDecision {
  return {
    policyVersion: CONNECTED_AGENTS_POLICY_VERSION,
    actionDigest,
    policyContextDigest,
    ...result,
  } as PolicyDecision;
}

function classifyPolicyAtBoundary(request: unknown, now: Date): PolicyDecision {
  if (!isRecord(request)) {
    return decision(INVALID_EXACT_ACTION_DIGEST, INVALID_POLICY_CONTEXT_DIGEST, {
      decision: "deny",
      reasonCode: "deny.policy_context_invalid",
    });
  }

  const actionValidation = validateExactAction(request.action);
  const standing = request.standing;
  const impactClasses = request.impactClasses;
  if (!isRecord(standing) || !Array.isArray(impactClasses)) {
    return decision(actionValidation.actionDigest, INVALID_POLICY_CONTEXT_DIGEST, {
      decision: "deny",
      reasonCode: "deny.policy_context_invalid",
    });
  }

  let policyContextDigest: string;
  try {
    policyContextDigest = digestCanonicalJson({
      factSource: request.factSource,
      standing,
      impactClasses: [...new Set(impactClasses)].sort(),
      contextAccess: request.contextAccess,
    } as unknown as JsonValue);
  } catch {
    return decision(actionValidation.actionDigest, INVALID_POLICY_CONTEXT_DIGEST, {
      decision: "deny",
      reasonCode: "deny.policy_context_invalid",
    });
  }

  const decide = (
    result: Pick<PolicyDecision, "decision" | "reasonCode">,
  ): PolicyDecision => decision(actionValidation.actionDigest, policyContextDigest, result);

  if (!actionValidation.valid) {
    return decide({
      decision: "deny",
      reasonCode: "deny.exact_action_invalid",
    });
  }

  const standingAuthorization = standing as unknown as StandingAuthorizationContext;

  if (!Number.isFinite(now.getTime())) {
    return decide({
      decision: "deny",
      reasonCode: "deny.invalid_evaluation_time",
    });
  }

  if (
    !isRecord(request.factSource) ||
    request.factSource.kind !== "trusted_policy_boundary" ||
    !isNonEmptyString(request.factSource.reference)
  ) {
    return decide({
      decision: "deny",
      reasonCode: "deny.policy_facts_untrusted",
    });
  }

  if (
    !isRecord(request.contextAccess) ||
    (request.contextAccess.kind !== "none" &&
      request.contextAccess.kind !== "cross_resident_private")
  ) {
    return decide({
      decision: "deny",
      reasonCode: "deny.unknown_context_access",
    });
  }

  if (request.contextAccess.kind === "cross_resident_private") {
    if (request.contextAccess.request == null) {
      return decide({
        decision: "deny",
        reasonCode: "deny.cross_resident_private_context_explicit_request_required",
      });
    }

    const validation = validatePrivateReadRequest(
      request.contextAccess.request as CrossResidentPrivateContextReadRequest,
      now,
    );
    if (!validation.valid) {
      return decide({ decision: "deny", reasonCode: validation.reasonCode });
    }
    return decide({
      decision: "deny",
      reasonCode: "deny.cross_resident_private_context_grant_unavailable",
    });
  }

  if (
    impactClasses.some(
      (impactClass) =>
        typeof impactClass !== "string" || !KNOWN_IMPACT_CLASSES.has(impactClass),
    )
  ) {
    return decide({
      decision: "deny",
      reasonCode: "deny.unknown_impact_class",
    });
  }

  if (hasUnresolvedStandingAuthority(standingAuthorization)) {
    return decide({
      decision: "deny",
      reasonCode: "deny.standing_authority_unresolved",
    });
  }

  const impacts = new Set(impactClasses as ActionImpactClass[]);
  const gateReason = hardGateReason(impacts, standingAuthorization);
  if (gateReason) {
    return decide({ decision: "hard_gate", reasonCode: gateReason });
  }

  if (isOutsideStandingAuthority(standingAuthorization)) {
    return decide({
      decision: "deny",
      reasonCode: "deny.outside_standing_authority",
    });
  }

  return decide({
    decision: "allow",
    reasonCode: "allow.standing_authority",
  });
}

export function classifyPolicy(request: PolicyRequest, now: Date): PolicyDecision {
  try {
    return classifyPolicyAtBoundary(request, now);
  } catch {
    return decision(INVALID_EXACT_ACTION_DIGEST, INVALID_POLICY_CONTEXT_DIGEST, {
      decision: "deny",
      reasonCode: "deny.policy_context_invalid",
    });
  }
}
