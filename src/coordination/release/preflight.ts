import { createHash } from "node:crypto";

import { FEATURE_FLAG_REGISTRY } from "../schema/contract-registry.js";

export const M32_CORE_BASE_SHA = "d25ba5fb6f954a8b365d3713f1300a79195208b5";
export const M32_SURFACE_ORDER = ["unread", "activity", "search", "attachments", "channel"] as const;

export type EvidenceKind = "live_receipt" | "physical_device" | "controlled_rollout" | "non_live_fixture";
export type GateStatus = "passed" | "failed" | "missing";

export interface EvidenceReference {
  status: GateStatus;
  kind: EvidenceKind;
  artifactDigest: string | null;
  receiptId: string | null;
}

export interface ReleaseCandidateManifest {
  manifestVersion: 1;
  evidenceMode: "fixture" | "non_live_review";
  sourceBases: { core: string; apple: string };
  candidates: { core: string; apple: string };
  digests: { contract: string; schema: string };
  flags: Record<string, boolean>;
  epochs: Array<{
    capability: string;
    epoch: number;
    mode: "legacy" | "shadow" | "canonical";
    writer: string;
    rollbackEpoch: number | null;
  }>;
  behaviorEvidence: {
    m14Jerry: EvidenceReference;
    m15Forrest: EvidenceReference;
    m26MacCutover: EvidenceReference;
    m27PhysicalIPhone: EvidenceReference;
    m31Sequential: Array<EvidenceReference & { capability: typeof M32_SURFACE_ORDER[number]; sequence: number }>;
  };
  defects: { p0: number; p1: number; evidenceDigest: string | null };
  rollback: {
    rehearsal: EvidenceReference;
    map: Array<{ scope: string; admissionFlag: string; rollbackEpoch: number; targetWriter: string; procedureDigest: string }>;
  };
}

export interface ReleasePreflightReport {
  reportVersion: 1;
  evidenceMode: "fixture" | "non_live_review";
  liveStateInspected: false;
  stateMutated: false;
  releaseReady: boolean;
  verdict: "release_ready" | "blocked";
  candidates: ReleaseCandidateManifest["candidates"];
  checks: Array<{ gate: string; passed: boolean; detail: string }>;
  blockers: string[];
  reportDigest: string;
}

const sha = (value: unknown) => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const digest = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const present = (value: unknown) => typeof value === "string" && value.trim().length > 0;
const stable = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
};
const hash = (value: unknown) => createHash("sha256").update(stable(value)).digest("hex");
const evidenced = (value: EvidenceReference | undefined, kinds: readonly EvidenceKind[]) =>
  Boolean(value && value.status === "passed" && kinds.includes(value.kind) && digest(value.artifactDigest) && present(value.receiptId));

export function validateReleaseCandidate(input: ReleaseCandidateManifest): ReleasePreflightReport {
  const checks: ReleasePreflightReport["checks"] = [];
  const check = (gate: string, passed: boolean, detail: string) => checks.push({ gate, passed, detail });

  check("manifest_version", input.manifestVersion === 1, "manifestVersion must be exactly 1");
  check("manifest_mode", input.evidenceMode === "fixture" || input.evidenceMode === "non_live_review", "input must remain explicitly fixture/non-live");
  check("exact_core_base", input.sourceBases.core === M32_CORE_BASE_SHA, `Core source base must equal ${M32_CORE_BASE_SHA}`);
  check("exact_apple_base", sha(input.sourceBases.apple), "Apple source base must be an exact 40-character SHA");
  check("exact_candidate_shas", sha(input.candidates.core) && sha(input.candidates.apple), "Core and Apple candidate SHAs must both be exact 40-character SHAs");
  check("contract_schema_digests", digest(input.digests.contract) && digest(input.digests.schema), "contract and schema SHA-256 digests are required");

  const registeredFlags = Object.keys(FEATURE_FLAG_REGISTRY).sort();
  const suppliedFlags = Object.keys(input.flags).sort();
  check("complete_flag_registry", JSON.stringify(registeredFlags) === JSON.stringify(suppliedFlags), "every registered flag, and no unknown flag, must be recorded");
  check("feature_off", suppliedFlags.every((name) => input.flags[name] === false), "every release-preflight flag must remain off");
  check("epochs_recorded", input.epochs.length > 0 && input.epochs.every((entry) => present(entry.capability) && Number.isSafeInteger(entry.epoch) && entry.epoch > 0 && present(entry.writer) && entry.mode !== "canonical" && (entry.rollbackEpoch === null || (Number.isSafeInteger(entry.rollbackEpoch) && entry.rollbackEpoch > 0 && entry.rollbackEpoch < entry.epoch))), "epochs must be explicit, feature-off legacy/shadow records with valid rollback ancestry");

  check("m14_live_receipt", evidenced(input.behaviorEvidence.m14Jerry, ["live_receipt"]), "M14 requires a passed real Jerry live receipt");
  check("m15_live_receipt", evidenced(input.behaviorEvidence.m15Forrest, ["live_receipt"]), "M15 requires a passed, separate Forrest live receipt");
  check("m26_mac_cutover", evidenced(input.behaviorEvidence.m26MacCutover, ["controlled_rollout", "live_receipt"]), "M26 requires passed real Mac cutover evidence");
  check("m27_physical_device", evidenced(input.behaviorEvidence.m27PhysicalIPhone, ["physical_device"]), "M27 requires passed physical-iPhone cutover evidence");
  const sequential = input.behaviorEvidence.m31Sequential;
  check("m31_sequential_receipts", sequential.length === M32_SURFACE_ORDER.length && sequential.every((entry, index) => entry.capability === M32_SURFACE_ORDER[index] && entry.sequence === index + 1 && evidenced(entry, ["live_receipt", "controlled_rollout"])), "M31 requires passed receipts in exact Unread, Activity, Search, Attachments, Channel order");

  check("zero_p0_p1", input.defects.p0 === 0 && input.defects.p1 === 0 && digest(input.defects.evidenceDigest), "a digested defect receipt must report zero unresolved P0 and P1 defects");
  check("rollback_rehearsal", evidenced(input.rollback.rehearsal, ["non_live_fixture", "controlled_rollout", "live_receipt"]), "a passed, digested rollback rehearsal receipt is required");
  check("rollback_map", input.rollback.map.length > 0 && input.rollback.map.every((entry) => present(entry.scope) && registeredFlags.includes(entry.admissionFlag) && Number.isSafeInteger(entry.rollbackEpoch) && entry.rollbackEpoch > 0 && present(entry.targetWriter) && digest(entry.procedureDigest)), "rollback map entries must name scope, registered admission flag, epoch, writer, and procedure digest");

  const blockers = checks.filter((item) => !item.passed).map((item) => item.gate);
  const unsigned = {
    reportVersion: 1 as const,
    evidenceMode: input.evidenceMode,
    liveStateInspected: false as const,
    stateMutated: false as const,
    releaseReady: blockers.length === 0,
    verdict: blockers.length === 0 ? "release_ready" as const : "blocked" as const,
    candidates: input.candidates,
    checks,
    blockers,
  };
  return { ...unsigned, reportDigest: hash(unsigned) };
}
