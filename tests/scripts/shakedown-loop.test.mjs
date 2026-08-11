// Focused unit tests for scripts/shakedown-loop.mjs — the single deterministic
// Shakedown outcome loop that replaces the proposal/approval-queue architecture.
//
// Run directly: node --test tests/scripts/shakedown-loop.test.mjs
// Like shakedown-approval-runner.test.mjs, this is a standalone operational-script
// suite, deliberately NOT wired into the cosmo23 package-test-registration authority.
//
// The pure core (buildReceipt / deriveBlockers / the step allowlists) takes
// already-read state and returns the outcome-organized receipt. No filesystem,
// no network, fully deterministic — the IO shell in the script does the reads.

import test from "node:test";
import assert from "node:assert/strict";
import {
  buildReceipt,
  deriveBlockers,
  SAFE_STEPS,
  COLLECTION_STEPS,
} from "../../scripts/shakedown-loop.mjs";

const NOW = "2026-08-06T18:00:00.000Z";

// A realistic, healthy-ish state fixture. Individual tests override slices.
function baseState(overrides = {}) {
  return {
    editorial: {
      distinctUnshippedTopics: 4,
      viableDraftFiles: 6,
      stagedAwaitingDistribution: 2,
      heroPending: 1,
      experientialClaimDrafts: [],
      topUnshipped: [{ topic: "Owsley the Person", words: 1800, path: "/x/a.md" }],
      source: "/supply.json",
    },
    publishing: {
      total: 35,
      alreadyOwnedLive: 35,
      readyOwnedBuild: 0,
      readySubstackDistribution: 10,
      alreadyDistributed: 25,
      items: [
        { slug: "issue-20-the-bear", type: "newsletter", ownedState: "already-owned-live", substackState: "ready-substack-distribution", scheduleState: "unscheduled", scheduledAt: "", nextAction: "Prepare Substack note." },
      ],
      ownedBuilds: [],
      substackActions: [
        { id: "newsletter:issue-20-the-bear", slug: "issue-20-the-bear", nextAction: "Prepare Substack distribution note.", command: "npm run pipeline:distribute-substack -- --item-id newsletter:issue-20-the-bear" },
      ],
      unattendedReadiness: { status: "not-ready-unattended-publishing", preparationBlockers: ["automation-state-not-safe-scan-only"] },
      source: "/scan.json",
    },
    collection: {
      cursorNextIndex: 230,
      passNumber: 3,
      wanted: { wanted: 535, have_audio: 1117, discovered: 131 },
      lastRun: { status: "waiting_for_batch_pair", completedAt: "2026-08-05T20:26:32.724Z", replayVerified: true, candidates: 3 },
      gateReady: false,
      candidateReady: false,
      enrichmentAgeHours: "19.7",
      source: "/daily.json",
    },
    funnel: {
      activeStripeSubscriptions: 5,
      pendingUnclaimedPaid: 0,
      checkoutPaidRate: "0.2727",
      authUsers: 59,
      recentSignups7d: 10,
      emailSignups: 85,
      actionableLeads: 0,
      visitsToday: 25,
      visits7d: 382,
    },
    site: { operatorStatus: "pass", checksPassed: 21, checksTotal: 21, reportAgeHours: "4.2" },
    facebook: { available: false, note: "No authoritative Facebook distribution source is wired." },
    jobs: {
      "shakedown-publish-scan": { enabled: true, lastStatus: "ok", consecutiveErrors: 0, nextRunAt: NOW },
    },
    warnings: [],
    ...overrides,
  };
}

test("receipt is organized by the seven required outcomes plus blockers and safeSteps", () => {
  const r = buildReceipt(baseState(), NOW);
  assert.equal(r.schema, "shakedown.loop.v1");
  assert.equal(r.generatedAt, NOW);
  for (const key of [
    "editorialSupply",
    "ownedSitePublication",
    "substackDistribution",
    "facebookDistribution",
    "archiveCollection",
    "acquisitionFunnel",
  ]) {
    assert.ok(key in r.outcomes, `missing outcome: ${key}`);
  }
  assert.ok(Array.isArray(r.blockers), "blockers must be an array");
  assert.ok(Array.isArray(r.safeSteps.available), "safeSteps.available must be an array");
});

test("no proposal/approval theater vocabulary anywhere in the receipt", () => {
  // The entire point of the rebuild: no fake selected/proposed/approved success,
  // no proposer, no approval-runner, no editorial-queue in the outcome surface.
  const r = buildReceipt(baseState(), NOW);
  const walkKeys = (obj, acc = []) => {
    if (obj && typeof obj === "object") {
      for (const [k, v] of Object.entries(obj)) { acc.push(k); walkKeys(v, acc); }
    }
    return acc;
  };
  const keys = walkKeys(r).join("|").toLowerCase();
  for (const banned of ["proposed", "approved", "approval", "proposer", "editorialqueue", "editorial-queue", "selected"]) {
    assert.doesNotMatch(keys, new RegExp(banned), `receipt key contains banned term: ${banned}`);
  }
});

test("acquisition funnel reports accounts-confirmed-paid = active subs + paid-unclaimed", () => {
  const r = buildReceipt(baseState({
    funnel: { ...baseState().funnel, activeStripeSubscriptions: 5, pendingUnclaimedPaid: 2 },
  }), NOW);
  assert.equal(r.outcomes.acquisitionFunnel.activeStripeSubscriptions, 5);
  assert.equal(r.outcomes.acquisitionFunnel.pendingUnclaimedPaid, 2);
  assert.equal(r.outcomes.acquisitionFunnel.accountsConfirmedPaid, 7);
});

test("a paid-but-unclaimed subscriber is a priority-zero money blocker", () => {
  const blockers = deriveBlockers(baseState({
    funnel: { ...baseState().funnel, pendingUnclaimedPaid: 1 },
  }));
  const b = blockers.find((x) => x.gate === "money");
  assert.ok(b, "expected a money-gated blocker");
  assert.equal(b.severity, "priority-zero");
  assert.equal(blockers[0], b, "priority-zero blocker must sort first");
});

test("staged drafts carrying unverified first-person claims raise a sensitive-claims blocker", () => {
  const blockers = deriveBlockers(baseState({
    editorial: { ...baseState().editorial, experientialClaimDrafts: [{ file: "issue-30.md", count: 3 }] },
  }));
  assert.ok(blockers.some((b) => b.gate === "sensitive-claims"), "expected a sensitive-claims blocker");
});

test("a failing operator check raises a health blocker; a passing one does not", () => {
  assert.ok(deriveBlockers(baseState({ site: { ...baseState().site, operatorStatus: "fail" } }))
    .some((b) => b.gate === "health"));
  assert.ok(!deriveBlockers(baseState()).some((b) => b.gate === "health" && /operator/i.test(b.what)));
});

test("a cron job with consecutive errors raises a health blocker naming the job", () => {
  const blockers = deriveBlockers(baseState({
    jobs: { "shakedown-collection-daily": { enabled: true, lastStatus: "error", consecutiveErrors: 2, nextRunAt: NOW } },
  }));
  assert.ok(blockers.some((b) => b.gate === "health" && /shakedown-collection-daily/.test(b.what)));
});

test("unanswered listener leads raise a credentials/send blocker (reply is a jtr click)", () => {
  const blockers = deriveBlockers(baseState({
    funnel: { ...baseState().funnel, actionableLeads: 3 },
  }));
  assert.ok(blockers.some((b) => b.gate === "credentials" && /lead/i.test(b.what)));
});

test("substack distribution is reported but never auto-run — it carries the gated command, not a success", () => {
  const r = buildReceipt(baseState(), NOW);
  const sd = r.outcomes.substackDistribution;
  assert.equal(sd.readySubstackDistribution, 10);
  assert.equal(sd.pending[0].gatedCommand, "npm run pipeline:distribute-substack -- --item-id newsletter:issue-20-the-bear");
  assert.match(sd.note, /external|credential|never auto/i);
  // The gated substack command must NOT appear in the safe-step allowlist.
  assert.ok(!SAFE_STEPS.some((s) => s.command.join(" ").includes("distribute-substack")));
});

test("facebook distribution is reported as unavailable, not faked", () => {
  const r = buildReceipt(baseState(), NOW);
  assert.equal(r.outcomes.facebookDistribution.available, false);
  assert.match(r.outcomes.facebookDistribution.note, /facebook/i);
});

test("SAFE_STEPS are idempotent read/refresh only — no send, deploy, spend, or production write", () => {
  assert.ok(SAFE_STEPS.length > 0);
  for (const step of SAFE_STEPS) {
    assert.ok(step.id && step.cwd, `${step.id}: needs id + cwd`);
    assert.ok(Array.isArray(step.command) && step.command.length, `${step.id}: needs argv command`);
    const cmd = step.command.join(" ");
    assert.doesNotMatch(
      cmd,
      /deploy|distribute-substack|build-owned|build:newsletter|:apply|send|mail|comp|refund|cancel|ad[-_ ]?spend|acquire|release:promote|promote/i,
      `${step.id}: SAFE step must not run a consequential command: ${cmd}`,
    );
  }
});

test("no step allowlist ever touches ad spend — the loop cannot alter advertising budget", () => {
  for (const step of [...SAFE_STEPS, ...COLLECTION_STEPS]) {
    assert.doesNotMatch(step.command.join(" "), /ad[-_ ]?spend|adspend|adwords|adset|campaign[-_ ]?budget|boost/i,
      `${step.id}: no step may touch ad spend`);
  }
});

test("dry-run receipt lists the safe steps it WOULD run and marks nothing as ran", () => {
  const r = buildReceipt(baseState(), NOW, { mode: "dry-run" });
  assert.equal(r.mode, "dry-run");
  assert.ok(r.safeSteps.available.length >= 1);
  assert.equal(r.safeSteps.ran, undefined, "dry-run must not report ran steps");
});

test("collection promotion is not in the default safe set — it is an explicit opt-in", () => {
  // Autopromote writes the live catalog; it is self-gated but consequential, so
  // the default --apply refresh set must not include it.
  assert.ok(!SAFE_STEPS.some((s) => s.id === "collection-promote"));
  assert.ok(COLLECTION_STEPS.some((s) => s.id === "collection-promote"));
});
