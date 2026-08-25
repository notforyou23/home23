import { createHash } from "node:crypto";

export const M31_CORE_BASE_SHA = "bec6f102b2f9f96bb05524bf1ac223833df99645";
export const M31_CAPABILITY_ORDER = ["unread", "activity", "search", "attachments", "channel"] as const;

export type M31Capability = (typeof M31_CAPABILITY_ORDER)[number];

export interface M31ActivationFixture {
  evidenceMode: "fixture";
  coreBaseSha: string;
  capability: M31Capability;
  capturedAt: string;
  directMessaging: {
    stable: true;
    macReceiptDigest: string;
    iphoneReceiptDigest: string;
    observationWindow: { startedAt: string; endedAt: string };
  };
  incidents: { openP0: number; openP1: number };
  featureFlag: { key: string; before: false; after: false; independentKillSwitch: string };
  authority: {
    capability: M31Capability;
    currentEpoch: number;
    activationEpoch: number;
    writer: string;
  };
  watermarks: { source: number; destination: number };
  canary: {
    id: string;
    correlationId: string;
    verdict: "passed";
    evidenceKind: "missed_event_convergence" | "activity_provenance" | "search_evidence_chain" | "exact_hash_round_trip" | "cross_platform_channel_correlation";
    evidence: string;
  };
  drift: { compared: number; mismatches: 0; digest: string };
  rollback: {
    flagValue: false;
    targetEpoch: number;
    targetWriter: string;
    directMessagingRemainsAvailable: true;
  };
  priorCapabilityReceipt: null | {
    capability: M31Capability;
    verdict: "fixture_ready_for_operator_review";
    receiptDigest: string;
  };
}

export interface M31PreflightReceipt {
  receiptVersion: 1;
  evidenceMode: "fixture";
  liveActivationAttempted: false;
  liveSuccess: false;
  activationAuthorized: false;
  advertised: false;
  verdict: "fixture_ready_for_operator_review";
  coreBaseSha: string;
  capability: M31Capability;
  sequence: number;
  checks: readonly { name: string; passed: boolean; detail: string }[];
  authority: M31ActivationFixture["authority"];
  watermarks: M31ActivationFixture["watermarks"];
  canary: M31ActivationFixture["canary"];
  drift: M31ActivationFixture["drift"];
  rollback: M31ActivationFixture["rollback"];
  limitations: readonly string[];
  receiptDigest: string;
}

const digestPattern = /^[a-f0-9]{64}$/;
const present = (value: unknown) => typeof value === "string" && value.trim().length > 0;
const positiveInteger = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0;
const sha256 = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export class M31PreflightError extends Error {
  constructor(readonly failures: readonly string[]) {
    super(`M31 activation preflight blocked: ${failures.join("; ")}`);
  }
}

export function runM31ActivationFixture(input: M31ActivationFixture): M31PreflightReceipt {
  const checks: Array<{ name: string; passed: boolean; detail: string }> = [];
  const check = (name: string, passed: boolean, detail: string) => checks.push({ name, passed, detail });
  const sequence = M31_CAPABILITY_ORDER.indexOf(input.capability);
  const previous = sequence > 0 ? M31_CAPABILITY_ORDER[sequence - 1] : null;
  const priorReceipt = input.priorCapabilityReceipt;
  const evidenceKinds = {
    unread: "missed_event_convergence",
    activity: "activity_provenance",
    search: "search_evidence_chain",
    attachments: "exact_hash_round_trip",
    channel: "cross_platform_channel_correlation",
  } as const;

  check("fixture_only", input.evidenceMode === "fixture", "only synthetic fixture evidence is accepted");
  check("locked_base", input.coreBaseSha === M31_CORE_BASE_SHA, "Core rollout-prep base must be exact");
  check("known_capability", sequence >= 0, "capability must be in the M31 activation order");
  check("direct_stable", input.directMessaging?.stable === true
    && digestPattern.test(input.directMessaging.macReceiptDigest)
    && digestPattern.test(input.directMessaging.iphoneReceiptDigest)
    && Date.parse(input.directMessaging.observationWindow.startedAt) < Date.parse(input.directMessaging.observationWindow.endedAt),
  "stable Mac and iPhone direct-message receipt references and an observation window are required");
  check("no_p0_p1", input.incidents?.openP0 === 0 && input.incidents?.openP1 === 0,
    "no open P0 or P1 defect may be represented");
  check("feature_off", input.featureFlag?.before === false && input.featureFlag?.after === false
    && present(input.featureFlag.key) && present(input.featureFlag.independentKillSwitch),
  "the capability must stay off and name its independent kill switch");
  check("authority", input.authority?.capability === input.capability
    && positiveInteger(input.authority.currentEpoch)
    && input.authority.activationEpoch === input.authority.currentEpoch + 1
    && present(input.authority.writer),
  "exact current and proposed activation epochs plus writer are required");
  check("watermarks", Number.isSafeInteger(input.watermarks?.source) && input.watermarks.source >= 0
    && input.watermarks.destination === input.watermarks.source,
  "source and destination watermarks must be exact and converged");
  check("canary", present(input.canary?.id) && present(input.canary?.correlationId)
    && input.canary?.verdict === "passed" && input.canary?.evidenceKind === evidenceKinds[input.capability]
    && present(input.canary?.evidence),
  "a capability-specific fixture canary and correlation are required");
  check("drift", positiveInteger(input.drift?.compared) && input.drift?.mismatches === 0
    && digestPattern.test(input.drift?.digest ?? ""),
  "a non-empty comparison with zero drift and an exact digest is required");
  check("rollback", input.rollback?.flagValue === false
    && input.rollback?.targetEpoch === input.authority?.activationEpoch + 1
    && present(input.rollback?.targetWriter)
    && input.rollback?.directMessagingRemainsAvailable === true,
  "rollback must name the next epoch/writer, disable only this flag, and preserve direct messaging");
  check("sequential_receipt", previous === null
    ? priorReceipt === null
    : priorReceipt !== null
      && priorReceipt.capability === previous
      && priorReceipt.verdict === "fixture_ready_for_operator_review"
      && digestPattern.test(priorReceipt.receiptDigest),
  previous === null ? "unread must have no prior capability receipt" : `exactly one retained ${previous} receipt is required`);

  const failures = checks.filter(({ passed }) => !passed).map(({ name }) => name);
  if (failures.length > 0) throw new M31PreflightError(failures);

  const unsigned = {
    receiptVersion: 1 as const,
    evidenceMode: "fixture" as const,
    liveActivationAttempted: false as const,
    liveSuccess: false as const,
    activationAuthorized: false as const,
    advertised: false as const,
    verdict: "fixture_ready_for_operator_review" as const,
    coreBaseSha: input.coreBaseSha,
    capability: input.capability,
    sequence: sequence + 1,
    checks,
    authority: input.authority,
    watermarks: input.watermarks,
    canary: input.canary,
    drift: input.drift,
    rollback: input.rollback,
    limitations: [
      "fixture evidence does not establish live direct-message stability",
      "fixture canaries and drift comparisons do not authorize activation",
      "operator authority and live capability-specific canaries remain required",
    ] as const,
  };
  return Object.freeze({ ...unsigned, receiptDigest: sha256(unsigned) });
}
