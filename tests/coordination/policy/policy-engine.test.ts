import assert from "node:assert/strict";
import test from "node:test";

import {
  CONNECTED_AGENTS_POLICY_VERSION,
  classifyPolicy,
  type ActionImpactClass,
  type CrossResidentPrivateContextReadRequest,
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

function policyRequest(
  operation: string,
  options: {
    impactClasses?: readonly ActionImpactClass[];
    standing?: StandingAuthorizationContext;
    contextAccess?: PolicyRequest["contextAccess"];
  } = {},
): PolicyRequest {
  return {
    action: {
      actorPrincipalId: "bot_jerry",
      operation,
      target: `resource:${operation}`,
      parameters: { requestedBy: "user_owner" },
    },
    factSource: {
      kind: "trusted_policy_boundary",
      reference: "test:resolved-standing-authority",
    },
    standing: options.standing ?? STANDING_AUTHORIZED,
    impactClasses: options.impactClasses ?? [],
    contextAccess: options.contextAccess ?? { kind: "none" },
  };
}

test("the five exact severe classes are the only hard-gate reasons", () => {
  const cases: Array<{
    name: string;
    impactClass: ActionImpactClass;
    standing: StandingAuthorizationContext;
    reasonCode: string;
  }> = [
    {
      name: "catastrophic or broad irreversible loss",
      impactClass: "catastrophic_or_broad_irreversible_loss",
      standing: STANDING_AUTHORIZED,
      reasonCode: "hard_gate.catastrophic_or_broad_irreversible_loss",
    },
    {
      name: "material spend or new obligation outside budget",
      impactClass: "material_spend_or_new_financial_obligation",
      standing: { ...STANDING_AUTHORIZED, budget: "outside" },
      reasonCode:
        "hard_gate.material_spend_or_new_financial_obligation_outside_standing_authority",
    },
    {
      name: "irreversible credential, security, recovery, or ownership transfer",
      impactClass: "irreversible_credential_security_recovery_or_ownership_transfer",
      standing: STANDING_AUTHORIZED,
      reasonCode:
        "hard_gate.irreversible_credential_security_recovery_or_ownership_transfer",
    },
    {
      name: "secret or private-data disclosure outside its audience",
      impactClass: "secret_or_private_data_disclosure",
      standing: { ...STANDING_AUTHORIZED, audience: "outside" },
      reasonCode:
        "hard_gate.secret_or_private_data_disclosure_outside_established_audience",
    },
    {
      name: "ambiguous high-impact statement without a mandate",
      impactClass: "ambiguous_high_impact_public_legal_or_sensitive_statement",
      standing: { ...STANDING_AUTHORIZED, delegation: "not_applicable" },
      reasonCode:
        "hard_gate.ambiguous_high_impact_public_legal_or_sensitive_statement_without_standing_mandate",
    },
  ];

  for (const item of cases) {
    const receipt = classifyPolicy(
      policyRequest(item.name, {
        impactClasses: [item.impactClass],
        standing: item.standing,
      }),
      NOW,
    );

    assert.equal(receipt.policyVersion, CONNECTED_AGENTS_POLICY_VERSION, item.name);
    assert.equal(receipt.decision, "hard_gate", item.name);
    assert.equal(receipt.reasonCode, item.reasonCode, item.name);
    assert.match(receipt.actionDigest, /^[a-f0-9]{64}$/, item.name);
  }
});

test("ordinary authorized actions remain autonomous explicit non-gates", () => {
  const operations = [
    "ordinary deletion",
    "routine account or config change",
    "ordinary remote-machine mutation",
    "known-recipient communication",
    "delegated publishing in standing scope",
  ];

  for (const operation of operations) {
    const receipt = classifyPolicy(policyRequest(operation), NOW);

    assert.equal(receipt.decision, "allow", operation);
    assert.equal(receipt.reasonCode, "allow.standing_authority", operation);
  }
});

test("standing scope is primary for qualified severe effects and ordinary work", () => {
  const cases: Array<{
    name: string;
    request: PolicyRequest;
    decision: "allow" | "deny";
    reasonCode: string;
  }> = [
    {
      name: "material spend inside standing budget",
      request: policyRequest("budgeted purchase", {
        impactClasses: ["material_spend_or_new_financial_obligation"],
      }),
      decision: "allow",
      reasonCode: "allow.standing_authority",
    },
    {
      name: "private disclosure inside established audience",
      request: policyRequest("authorized private disclosure", {
        impactClasses: ["secret_or_private_data_disclosure"],
      }),
      decision: "allow",
      reasonCode: "allow.standing_authority",
    },
    {
      name: "high-impact publishing with a standing mandate",
      request: policyRequest("mandated public statement", {
        impactClasses: [
          "ambiguous_high_impact_public_legal_or_sensitive_statement",
        ],
      }),
      decision: "allow",
      reasonCode: "allow.standing_authority",
    },
    {
      name: "ordinary work outside standing scope",
      request: policyRequest("routine but undelegated work", {
        standing: { ...STANDING_AUTHORIZED, scope: "outside" },
      }),
      decision: "deny",
      reasonCode: "deny.outside_standing_authority",
    },
    {
      name: "known recipient outside the standing allowlist",
      request: policyRequest("known-recipient communication", {
        standing: { ...STANDING_AUTHORIZED, allowlist: "outside" },
      }),
      decision: "deny",
      reasonCode: "deny.outside_standing_authority",
    },
    {
      name: "material spend with unresolved budget authority",
      request: policyRequest("purchase with missing budget", {
        impactClasses: ["material_spend_or_new_financial_obligation"],
        standing: { ...STANDING_AUTHORIZED, budget: "unknown" },
      }),
      decision: "deny",
      reasonCode: "deny.standing_authority_unresolved",
    },
    {
      name: "scope cannot be treated as not applicable",
      request: policyRequest("work without a resolved scope", {
        standing: { ...STANDING_AUTHORIZED, scope: "not_applicable" } as never,
      }),
      decision: "deny",
      reasonCode: "deny.standing_authority_unresolved",
    },
  ];

  for (const item of cases) {
    const receipt = classifyPolicy(item.request, NOW);
    assert.equal(receipt.decision, item.decision, item.name);
    assert.equal(receipt.reasonCode, item.reasonCode, item.name);
  }
});

test("an unknown impact class fails closed without expanding the hard-gate taxonomy", () => {
  const request = policyRequest("future risk signal") as PolicyRequest & {
    impactClasses: string[];
  };
  request.impactClasses = ["future_unreviewed_gate"];

  const receipt = classifyPolicy(request, NOW);

  assert.equal(receipt.decision, "deny");
  assert.equal(receipt.reasonCode, "deny.unknown_impact_class");
});

test("untrusted policy facts cannot choose standing authority or impact classes", () => {
  const request = policyRequest("caller-selected authority");
  request.factSource = { kind: "model_input", reference: "request-body" } as never;

  const receipt = classifyPolicy(request, NOW);

  assert.equal(receipt.decision, "deny");
  assert.equal(receipt.reasonCode, "deny.policy_facts_untrusted");
});

test("a non-canonical policy context cannot produce allow or hard-gate", () => {
  const request = policyRequest("catastrophic action", {
    impactClasses: ["catastrophic_or_broad_irreversible_loss"],
    standing: { ...STANDING_AUTHORIZED },
  });
  Object.defineProperty(request.standing, "hiddenAuthority", {
    value: "caller-selected",
    enumerable: false,
  });

  const receipt = classifyPolicy(request, NOW);

  assert.equal(receipt.decision, "deny");
  assert.equal(receipt.reasonCode, "deny.policy_context_invalid");
});

test("structurally invalid policy facts return deterministic denials", () => {
  const cases = [
    { ...policyRequest("null standing facts"), standing: null },
    { ...policyRequest("null impact facts"), impactClasses: null },
  ] as never[];

  for (const request of cases) {
    const receipt = classifyPolicy(request, NOW);
    assert.equal(receipt.decision, "deny");
    assert.equal(receipt.reasonCode, "deny.policy_context_invalid");
  }
});

test("implicit cross-resident private context is denied", () => {
  const receipt = classifyPolicy(
    policyRequest("read another resident context", {
      contextAccess: { kind: "cross_resident_private", request: null },
    }),
    NOW,
  );

  assert.equal(receipt.decision, "deny");
  assert.equal(
    receipt.reasonCode,
    "deny.cross_resident_private_context_explicit_request_required",
  );
});

test("an unknown context-access discriminator fails closed", () => {
  const request = policyRequest("future private context mode");
  request.contextAccess = { kind: "future_cross_resident_mode" } as never;

  const receipt = classifyPolicy(request, NOW);

  assert.equal(receipt.decision, "deny");
  assert.equal(receipt.reasonCode, "deny.unknown_context_access");
});

test("an invalid evaluation clock fails closed", () => {
  const receipt = classifyPolicy(policyRequest("routine work"), new Date("invalid"));

  assert.equal(receipt.decision, "deny");
  assert.equal(receipt.reasonCode, "deny.invalid_evaluation_time");
});

test("a future cross-resident read request is structured but cannot grant itself access", () => {
  const readRequest: CrossResidentPrivateContextReadRequest = {
    access: "read",
    projectScope: "connected-agent-architecture",
    subjects: ["resident:jerry"],
    recipients: ["resident:forrest"],
    allowedClasses: ["decision_receipt"],
    expiresAt: "2026-08-25T16:00:00.000Z",
    provenance: {
      manifestId: "context-manifest-001",
      sourceResidentId: "resident:jerry",
      sourceReferences: ["decision:privacy-boundary"],
    },
    enforcement: "read_only",
  };

  const unavailable = classifyPolicy(
    policyRequest("read explicitly granted context", {
      contextAccess: { kind: "cross_resident_private", request: readRequest },
    }),
    NOW,
  );
  assert.equal(unavailable.decision, "deny");
  assert.equal(
    unavailable.reasonCode,
    "deny.cross_resident_private_context_grant_unavailable",
  );

  const write = classifyPolicy(
    policyRequest("write another resident context", {
      contextAccess: {
        kind: "cross_resident_private",
        request: { ...readRequest, access: "write" } as never,
      },
    }),
    NOW,
  );
  assert.equal(write.decision, "deny");
  assert.equal(write.reasonCode, "deny.cross_resident_private_context_read_only");

  const expired = classifyPolicy(
    policyRequest("read expired context", {
      contextAccess: {
        kind: "cross_resident_private",
        request: { ...readRequest, expiresAt: "2026-08-24T15:59:59.999Z" },
      },
    }),
    NOW,
  );
  assert.equal(expired.decision, "deny");
  assert.equal(expired.reasonCode, "deny.cross_resident_private_context_expired");

  const missingProvenance = classifyPolicy(
    policyRequest("read context without provenance", {
      contextAccess: {
        kind: "cross_resident_private",
        request: { ...readRequest, provenance: undefined } as never,
      },
    }),
    NOW,
  );
  assert.equal(missingProvenance.decision, "deny");
  assert.equal(
    missingProvenance.reasonCode,
    "deny.policy_context_invalid",
  );
});
