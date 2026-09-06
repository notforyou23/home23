import type {
  AuthAdmissionVerifier,
  AuthMutationContext,
} from "../../../src/coordination/auth/index.js";
import {
  createAuthService,
  type CreateAuthServiceOptions,
} from "../../../src/coordination/auth/index.js";

let sequence = 1;

export const TEST_ADMISSION_VERIFIER: AuthAdmissionVerifier = Object.freeze({
  verifyLocalOperator(evidence: unknown) {
    if (!evidence || typeof evidence !== "object" || !("authenticated" in evidence)) {
      return { allowed: false, reason: "operator_auth_required" } as const;
    }
    const operator = evidence as { authenticated?: unknown; network?: unknown };
    if (operator.authenticated !== true) {
      return { allowed: false, reason: "operator_auth_required" } as const;
    }
    if (operator.network !== "loopback") {
      return { allowed: false, reason: "network_not_allowed" } as const;
    }
    return { allowed: true, network: "loopback", rateLimitKey: "test-operator" } as const;
  },
  verifyClient(evidence: unknown) {
    if (evidence !== "loopback" && evidence !== "vpn") {
      return { allowed: false, reason: "network_not_allowed" } as const;
    }
    return { allowed: true, network: evidence, rateLimitKey: `test-${evidence}` } as const;
  },
});

export function createTestAuthService(
  options: Omit<CreateAuthServiceOptions, "admissionVerifier">,
) {
  return createAuthService({ ...options, admissionVerifier: TEST_ADMISSION_VERIFIER });
}

export function mutation(label: string): AuthMutationContext {
  const requestSuffix = (sequence++).toString(16).padStart(12, "0");
  const correlationSuffix = (sequence++).toString(16).padStart(12, "0");
  return {
    idempotencyKey: `m06-${label}-${requestSuffix}`,
    requestId: `req_0198d95f-6c00-7000-8000-${requestSuffix}`,
    correlationId: `cor_0198d95f-6c00-7000-8000-${correlationSuffix}`,
  };
}
