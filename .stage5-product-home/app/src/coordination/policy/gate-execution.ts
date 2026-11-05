import { classifyPolicy, CONNECTED_AGENTS_POLICY_VERSION } from "./policy-engine.js";
import type {
  GateAuthorization,
  GateAuthorizationAuthority,
  GateExecutionDecision,
  GateExecutionReasonCode,
  PolicyDecision,
  PolicyRequest,
} from "./types.js";

function executionDecision(
  policyDecision: PolicyDecision,
  decision: "allow" | "deny",
  reasonCode: GateExecutionReasonCode,
): GateExecutionDecision {
  return {
    decision,
    reasonCode,
    actionDigest: policyDecision.actionDigest,
    policyDecision,
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Future action executors call this immediately before execution. It always
 * reclassifies current inputs; authorization evidence is considered only when
 * that current decision is still a hard gate.
 */
export function evaluateActionForExecution(
  request: PolicyRequest,
  authorization: GateAuthorization | null,
  authority: GateAuthorizationAuthority,
  now: Date,
): GateExecutionDecision {
  const current = classifyPolicy(request, now);

  if (current.decision === "allow") {
    return executionDecision(current, "allow", current.reasonCode);
  }
  if (current.decision === "deny") {
    return executionDecision(current, "deny", current.reasonCode);
  }

  if (authorization === null) {
    return executionDecision(current, "deny", "deny.hard_gate_authorization_required");
  }
  if (
    typeof authorization !== "object" ||
    !isNonEmptyString(authorization.authorizationId) ||
    !isNonEmptyString(authorization.expiresAt) ||
    !isNonEmptyString(authorization.actionDigest) ||
    !isNonEmptyString(authorization.policyContextDigest) ||
    !isNonEmptyString(authorization.hardGateReason) ||
    typeof authorization.policyVersion !== "number"
  ) {
    return executionDecision(current, "deny", "deny.hard_gate_authorization_invalid");
  }
  if (authorization.policyVersion !== CONNECTED_AGENTS_POLICY_VERSION) {
    return executionDecision(
      current,
      "deny",
      "deny.hard_gate_authorization_policy_mismatch",
    );
  }
  if (authorization.actionDigest !== current.actionDigest) {
    return executionDecision(
      current,
      "deny",
      "deny.hard_gate_authorization_digest_mismatch",
    );
  }
  if (authorization.policyContextDigest !== current.policyContextDigest) {
    return executionDecision(
      current,
      "deny",
      "deny.hard_gate_authorization_context_mismatch",
    );
  }
  if (authorization.hardGateReason !== current.reasonCode) {
    return executionDecision(
      current,
      "deny",
      "deny.hard_gate_authorization_reason_mismatch",
    );
  }

  const expiry = Date.parse(authorization.expiresAt);
  if (!Number.isFinite(expiry)) {
    return executionDecision(current, "deny", "deny.hard_gate_authorization_invalid");
  }
  if (expiry <= now.getTime()) {
    return executionDecision(current, "deny", "deny.hard_gate_authorization_expired");
  }

  try {
    if (!authority.verifyAuthorization(authorization)) {
      return executionDecision(current, "deny", "deny.hard_gate_authorization_unverified");
    }
  } catch {
    return executionDecision(current, "deny", "deny.hard_gate_authorization_unverified");
  }

  try {
    const consumed = authority.consumeOnce({
      authorizationId: authorization.authorizationId,
      actionDigest: authorization.actionDigest,
      consumedAt: now.toISOString(),
    });
    if (!consumed) {
      return executionDecision(current, "deny", "deny.hard_gate_authorization_replayed");
    }
  } catch {
    return executionDecision(
      current,
      "deny",
      "deny.hard_gate_authorization_consumption_failed",
    );
  }

  return executionDecision(current, "allow", "allow.hard_gate_authorization_consumed");
}
