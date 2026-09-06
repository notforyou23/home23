import assert from "node:assert/strict";
import test from "node:test";

import { FEATURE_FLAG_REGISTRY } from "../../../src/coordination/schema/contract-registry.js";
import { M32_CORE_BASE_SHA, M32_SURFACE_ORDER, validateReleaseCandidate, type EvidenceReference, type ReleaseCandidateManifest } from "../../../src/coordination/release/index.js";

const sha = (character: string) => character.repeat(40);
const digest = (character: string) => character.repeat(64);
const evidence = (kind: EvidenceReference["kind"], id: string): EvidenceReference => ({ status: "passed", kind, artifactDigest: digest("a"), receiptId: id });

function manifest(): ReleaseCandidateManifest {
  return {
    manifestVersion: 1,
    evidenceMode: "fixture",
    sourceBases: { core: M32_CORE_BASE_SHA, apple: sha("b") },
    candidates: { core: sha("c"), apple: sha("d") },
    digests: { contract: digest("e"), schema: digest("f") },
    flags: Object.fromEntries(Object.keys(FEATURE_FLAG_REGISTRY).map((name) => [name, false])),
    epochs: [{ capability: "messages", epoch: 2, mode: "shadow", writer: "legacy-message-writer", rollbackEpoch: 1 }],
    behaviorEvidence: {
      m14Jerry: evidence("live_receipt", "m14-jerry"),
      m15Forrest: evidence("live_receipt", "m15-forrest"),
      m26MacCutover: evidence("controlled_rollout", "m26-mac"),
      m27PhysicalIPhone: evidence("physical_device", "m27-iphone"),
      m31Sequential: M32_SURFACE_ORDER.map((capability, index) => ({ ...evidence("controlled_rollout", `m31-${capability}`), capability, sequence: index + 1 })),
    },
    defects: { p0: 0, p1: 0, evidenceDigest: digest("1") },
    rollback: {
      rehearsal: evidence("non_live_fixture", "rollback-rehearsal"),
      map: [{ scope: "messages", admissionFlag: "coordination.public_api.enabled", rollbackEpoch: 1, targetWriter: "legacy-message-writer", procedureDigest: digest("2") }],
    },
  };
}

test("complete, explicitly evidenced fixture input is deterministic but still typed non-live", () => {
  const input = manifest();
  const first = validateReleaseCandidate(input);
  const second = validateReleaseCandidate(structuredClone(input));
  assert.equal(first.releaseReady, true);
  assert.equal(first.evidenceMode, "fixture");
  assert.equal(first.liveStateInspected, false);
  assert.equal(first.stateMutated, false);
  assert.equal(first.reportDigest, second.reportDigest);
});

test("missing live canaries, device/cutover evidence, sequential receipts, defect proof, rollback, or SHAs refuse ready", () => {
  const input = manifest();
  input.candidates.apple = "missing";
  input.behaviorEvidence.m14Jerry = { status: "missing", kind: "live_receipt", artifactDigest: null, receiptId: null };
  input.behaviorEvidence.m15Forrest = { status: "missing", kind: "live_receipt", artifactDigest: null, receiptId: null };
  input.behaviorEvidence.m26MacCutover = evidence("non_live_fixture", "fake-mac");
  input.behaviorEvidence.m27PhysicalIPhone = evidence("non_live_fixture", "simulator");
  input.behaviorEvidence.m31Sequential.reverse();
  input.defects.p1 = 1;
  input.rollback.rehearsal.status = "missing";
  const result = validateReleaseCandidate(input);
  assert.equal(result.releaseReady, false);
  assert.equal(result.verdict, "blocked");
  assert.deepEqual(result.blockers, ["exact_candidate_shas", "m14_live_receipt", "m15_live_receipt", "m26_mac_cutover", "m27_physical_device", "m31_sequential_receipts", "zero_p0_p1", "rollback_rehearsal"]);
});

test("flags cannot activate capability and epochs cannot claim canonical authority", () => {
  const input = manifest();
  input.flags["coordination.public_api.enabled"] = true;
  input.epochs[0]!.mode = "canonical";
  const result = validateReleaseCandidate(input);
  assert.equal(result.releaseReady, false);
  assert.ok(result.blockers.includes("feature_off"));
  assert.ok(result.blockers.includes("epochs_recorded"));
});

test("wrong Core base, abbreviated SHAs, fixture device evidence, and undigested rollback map fail closed", () => {
  const input = manifest();
  input.sourceBases.core = sha("0");
  input.sourceBases.apple = "96550d3";
  input.behaviorEvidence.m27PhysicalIPhone.kind = "non_live_fixture";
  input.rollback.map[0]!.procedureDigest = "";
  const result = validateReleaseCandidate(input);
  for (const blocker of ["exact_core_base", "exact_apple_base", "m27_physical_device", "rollback_map"]) assert.ok(result.blockers.includes(blocker));
});

test("unknown manifest versions are never accepted", () => {
  const input = manifest();
  input.manifestVersion = 2 as 1;
  assert.ok(validateReleaseCandidate(input).blockers.includes("manifest_version"));
});
