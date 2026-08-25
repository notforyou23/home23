import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  CONNECTED_AGENTS_POLICY_VERSION,
  classifyPolicy,
  digestExactAction,
  evaluateActionForExecution,
  type GateAuthorization,
  type GateAuthorizationAuthority,
  type GateAuthorizationConsumption,
  type PolicyRequest,
  type StandingAuthorizationContext,
} from "../../../src/coordination/policy/index.js";

const NOW = new Date("2026-08-24T16:00:00.000Z");

const STANDING_AUTHORIZED: StandingAuthorizationContext = {
  scope: "within",
  delegation: "within",
  budget: "within",
  audience: "within",
  allowlist: "within",
};

function financialRequest(): PolicyRequest {
  return {
    action: {
      actorPrincipalId: "bot_jerry",
      operation: "accept_financial_obligation",
      target: "vendor:example",
      parameters: { amount: "2500.00", currency: "USD", termMonths: 12 },
    },
    factSource: {
      kind: "trusted_policy_boundary",
      reference: "test:resolved-standing-authority",
    },
    standing: { ...STANDING_AUTHORIZED, budget: "outside" },
    impactClasses: ["material_spend_or_new_financial_obligation"],
    contextAccess: { kind: "none" },
  };
}

function authorizationFor(request: PolicyRequest): GateAuthorization {
  const receipt = classifyPolicy(request, NOW);
  assert.equal(receipt.decision, "hard_gate");
  return {
    authorizationId: "gate-authorization-001",
    policyVersion: CONNECTED_AGENTS_POLICY_VERSION,
    actionDigest: receipt.actionDigest,
    policyContextDigest: receipt.policyContextDigest,
    hardGateReason: receipt.reasonCode,
    expiresAt: "2026-08-24T16:05:00.000Z",
  };
}

class TestGateAuthority implements GateAuthorizationAuthority {
  readonly consumed = new Set<string>();
  valid = true;

  verifyAuthorization(): boolean {
    return this.valid;
  }

  consumeOnce(consumption: GateAuthorizationConsumption): boolean {
    if (this.consumed.has(consumption.authorizationId)) return false;
    this.consumed.add(consumption.authorizationId);
    return true;
  }
}

test("exact-action digest is canonical and changes with the bound action", () => {
  const action = {
    actorPrincipalId: "bot_jerry",
    operation: "publish",
    target: "channel:known",
    parameters: { body: "hello", audience: "known" },
  } as const;
  const expected = createHash("sha256")
    .update(
      '{"actorPrincipalId":"bot_jerry","operation":"publish","parameters":{"audience":"known","body":"hello"},"target":"channel:known"}',
    )
    .digest("hex");

  assert.equal(digestExactAction(action), expected);
  assert.equal(
    digestExactAction({
      parameters: { audience: "known", body: "hello" },
      target: "channel:known",
      operation: "publish",
      actorPrincipalId: "bot_jerry",
    }),
    expected,
  );
  assert.notEqual(
    digestExactAction({ ...action, parameters: { ...action.parameters, body: "changed" } }),
    expected,
  );
});

test("exact-action digest rejects sparse and non-JSON runtime values", () => {
  const base = {
    actorPrincipalId: "bot_jerry",
    operation: "publish",
    target: "channel:known",
  };

  assert.throws(
    () => digestExactAction({ ...base, parameters: new Array(1) }),
    /sparse array/,
  );
  assert.throws(
    () => digestExactAction({ ...base, parameters: new Date() as never }),
    /plain JSON object/,
  );

  let getterReads = 0;
  const accessorArray = ["placeholder"];
  Object.defineProperty(accessorArray, "0", {
    get() {
      getterReads += 1;
      return "unstable";
    },
    enumerable: true,
  });
  assert.throws(
    () => digestExactAction({ ...base, parameters: accessorArray }),
    /array index must be an enumerable data property/,
  );
  assert.equal(getterReads, 0);

  const nonEnumerableArray = ["hidden"];
  Object.defineProperty(nonEnumerableArray, "0", {
    value: "hidden",
    enumerable: false,
  });
  assert.throws(
    () => digestExactAction({ ...base, parameters: nonEnumerableArray }),
    /array index must be an enumerable data property/,
  );
});

test("execution rejects a digest mismatch without consuming authorization", () => {
  const request = financialRequest();
  const authority = new TestGateAuthority();
  const authorization = authorizationFor(request);
  const changedRequest: PolicyRequest = {
    ...request,
    action: {
      ...request.action,
      parameters: { amount: "5000.00", currency: "USD", termMonths: 12 },
    },
  };

  const result = evaluateActionForExecution(
    changedRequest,
    authorization,
    authority,
    NOW,
  );

  assert.equal(result.decision, "deny");
  assert.equal(result.reasonCode, "deny.hard_gate_authorization_digest_mismatch");
  assert.equal(authority.consumed.size, 0);
});

test("execution rejects expired authorization without consuming it", () => {
  const request = financialRequest();
  const authority = new TestGateAuthority();
  const authorization = {
    ...authorizationFor(request),
    expiresAt: "2026-08-24T16:00:00.000Z",
  };

  const result = evaluateActionForExecution(request, authorization, authority, NOW);

  assert.equal(result.decision, "deny");
  assert.equal(result.reasonCode, "deny.hard_gate_authorization_expired");
  assert.equal(authority.consumed.size, 0);
});

test("malformed runtime authorization evidence returns a stable denial", () => {
  const request = financialRequest();
  const authority = new TestGateAuthority();
  const malformed = {
    ...authorizationFor(request),
    authorizationId: undefined,
  } as never;

  const result = evaluateActionForExecution(request, malformed, authority, NOW);

  assert.equal(result.decision, "deny");
  assert.equal(result.reasonCode, "deny.hard_gate_authorization_invalid");
  assert.equal(authority.consumed.size, 0);
});

test("a verified hard-gate authorization is consumed exactly once", () => {
  const request = financialRequest();
  const authority = new TestGateAuthority();
  const authorization = authorizationFor(request);

  const first = evaluateActionForExecution(request, authorization, authority, NOW);
  const replay = evaluateActionForExecution(request, authorization, authority, NOW);

  assert.equal(first.decision, "allow");
  assert.equal(first.reasonCode, "allow.hard_gate_authorization_consumed");
  assert.equal(replay.decision, "deny");
  assert.equal(replay.reasonCode, "deny.hard_gate_authorization_replayed");
  assert.deepEqual([...authority.consumed], [authorization.authorizationId]);
});

test("execution re-evaluates current policy before trusting or consuming evidence", () => {
  const initialRequest = financialRequest();
  const authorization = authorizationFor(initialRequest);
  const authority = new TestGateAuthority();
  const currentRequest: PolicyRequest = {
    ...initialRequest,
    standing: { ...initialRequest.standing, budget: "unknown" },
  };

  const result = evaluateActionForExecution(
    currentRequest,
    authorization,
    authority,
    NOW,
  );

  assert.equal(result.decision, "deny");
  assert.equal(result.reasonCode, "deny.standing_authority_unresolved");
  assert.equal(authority.consumed.size, 0);
});

test("authorization is bound to the complete re-evaluated policy context", () => {
  const initialRequest = financialRequest();
  const authorization = authorizationFor(initialRequest);
  const authority = new TestGateAuthority();
  const expandedImpactRequest: PolicyRequest = {
    ...initialRequest,
    impactClasses: [
      ...initialRequest.impactClasses,
      "irreversible_credential_security_recovery_or_ownership_transfer",
    ],
  };

  const result = evaluateActionForExecution(
    expandedImpactRequest,
    authorization,
    authority,
    NOW,
  );

  assert.equal(result.policyDecision.decision, "hard_gate");
  assert.equal(
    result.policyDecision.reasonCode,
    "hard_gate.material_spend_or_new_financial_obligation_outside_standing_authority",
  );
  assert.equal(result.decision, "deny");
  assert.equal(result.reasonCode, "deny.hard_gate_authorization_context_mismatch");
  assert.equal(authority.consumed.size, 0);
});

test("caller-supplied evidence cannot self-authorize without trusted verification", () => {
  const request = financialRequest();
  const authority = new TestGateAuthority();
  authority.valid = false;

  const result = evaluateActionForExecution(
    request,
    authorizationFor(request),
    authority,
    NOW,
  );

  assert.equal(result.decision, "deny");
  assert.equal(result.reasonCode, "deny.hard_gate_authorization_unverified");
  assert.equal(authority.consumed.size, 0);
});

test("execution preserves autonomous allow decisions without consuming gate state", () => {
  const request: PolicyRequest = {
    action: {
      actorPrincipalId: "bot_jerry",
      operation: "known_recipient_message",
      target: "recipient:known",
      parameters: { body: "status update" },
    },
    factSource: {
      kind: "trusted_policy_boundary",
      reference: "test:resolved-standing-authority",
    },
    standing: STANDING_AUTHORIZED,
    impactClasses: [],
    contextAccess: { kind: "none" },
  };
  const authority = new TestGateAuthority();

  const result = evaluateActionForExecution(request, null, authority, NOW);

  assert.equal(result.decision, "allow");
  assert.equal(result.reasonCode, "allow.standing_authority");
  assert.equal(authority.consumed.size, 0);
});
