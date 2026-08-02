// Focused unit tests for scripts/shakedown-approval-runner.mjs — the missing
// Lane 3 -> Lane 1 approval executor (Task 9,
// docs/superpowers/plans/2026-07-25-shakedown-jerry-proposer.md).
//
// Run directly: node --test tests/scripts/shakedown-approval-runner.test.mjs
// Not wired into the cosmo23 package-test-registration authority — that list
// governs a specific engine-internal test corpus (tests/cosmo23, tests/security,
// tests/shared); this suite covers a standalone operational script instead.

import test from "node:test";
import assert from "node:assert/strict";
import { parseQueue, extractContract, classify, ALLOWLIST } from "../../scripts/shakedown-approval-runner.mjs";

test("parseQueue extracts state, title, and body for each marker", () => {
  const src = `# Queue

### [proposed] First idea
- why: because

### [approved] Second idea
- opportunityId: opp-1
- machineAction: do-thing
- args: {"x":1}

### [done] Third idea
- executed already
`;
  const entries = parseQueue(src);
  assert.equal(entries.length, 3);
  assert.equal(entries[0].state, "proposed");
  assert.equal(entries[0].title, "First idea");
  assert.equal(entries[1].state, "approved");
  assert.match(entries[1].body, /opportunityId: opp-1/);
  assert.equal(entries[2].state, "done");
});

test("extractContract returns null when opportunityId or machineAction is missing (prose card)", () => {
  const proseBody = `- why: this matters
- evidence: some file
- action: Lane 1 finalize-issue-md — do the thing by hand
- risk: low`;
  assert.equal(extractContract(proseBody), null);
});

test("extractContract parses a well-formed structured card", () => {
  const body = `- opportunityId: opp-42
- machineAction: run-publish-scan
- args: {"mode":"scan"}`;
  const c = extractContract(body);
  assert.deepEqual(c, { opportunityId: "opp-42", machineAction: "run-publish-scan", args: { mode: "scan" } });
});

test("extractContract flags invalid JSON args instead of silently dropping them", () => {
  const body = `- opportunityId: opp-43
- machineAction: run-publish-scan
- args: {not json}`;
  const c = extractContract(body);
  assert.equal(c.opportunityId, "opp-43");
  assert.ok(c.argsError);
});

test("classify: non-approved entries are never executable regardless of body content", () => {
  const entry = { state: "proposed", title: "x", body: "- opportunityId: opp-1\n- machineAction: run-publish-scan" };
  const result = classify(entry, { entries: {} });
  assert.equal(result.classification, "not-approved(proposed)");
});

test("classify: approved prose card (the real current state of the queue) is needs-structuring, never executed", () => {
  const entry = {
    state: "approved",
    title: "Ship Bear -> Sphere",
    body: `- why: it matters\n- action: Lane 1 finalize-issue-md — cut overlap, keep unique thread\n- risk: low`,
  };
  const result = classify(entry, { entries: {} });
  assert.equal(result.classification, "needs-structuring");
});

test("classify: structured card naming an action NOT in the allowlist is blocked, never executed", () => {
  const entry = {
    state: "approved",
    title: "Structured but unknown action",
    body: `- opportunityId: opp-99\n- machineAction: totally-made-up-action\n- args: {}`,
  };
  const result = classify(entry, { entries: {} });
  assert.equal(result.classification, "blocked");
  assert.match(result.reason, /not in allowlist/);
});

// Args used to be parsed, validated, and then silently discarded: runOne runs
// the allowlisted spec.command verbatim. An operator who wrote args into an
// approved card would believe they took effect. Passing them through is not the
// fix — the allowlist runs EXACT pre-reviewed commands — so an approval that
// carries args is blocked and told why.
test("classify: an approved card carrying args is blocked, not silently run without them", () => {
  const entry = {
    state: "approved",
    title: "Structured with args",
    body: `- opportunityId: opp-args-1\n- machineAction: run-publish-scan\n- args: {"dryRun": true}`,
  };
  const result = classify(entry, { entries: {} });
  assert.equal(result.classification, "blocked");
  assert.match(result.reason, /accepts no args/);
});

test("classify: an empty args block is still machine-ready", () => {
  const entry = {
    state: "approved",
    title: "Structured, no args",
    body: `- opportunityId: opp-args-2\n- machineAction: run-publish-scan\n- args: {}`,
  };
  assert.equal(classify(entry, { entries: {} }).classification, "machine-ready");
});

test("classify: terminal ledger state for an opportunityId is never re-executed (exactly-once)", () => {
  const entry = {
    state: "approved",
    title: "Already ran",
    body: `- opportunityId: opp-done-1\n- machineAction: whatever\n- args: {}`,
  };
  for (const status of ["done", "failed", "blocked"]) {
    const ledger = { entries: { "opp-done-1": { status } } };
    const result = classify(entry, ledger);
    assert.equal(result.classification, `already-${status}`);
  }
});

test("allowlist contains only deliberately reviewed, read-only entries — no production write/deploy/send action", () => {
  // As of 2026-07-30 exactly one entry is live: run-publish-scan, a read-only
  // scan already run independently by the shakedown-publish-scan cron job.
  // Any future addition must be reviewed the same way: named here explicitly,
  // not silently expanded.
  const keys = Object.keys(ALLOWLIST);
  assert.deepEqual(keys, ["run-publish-scan"]);
  for (const key of keys) {
    const spec = ALLOWLIST[key];
    assert.ok(spec.cwd, `${key} must have an explicit cwd`);
    assert.ok(Array.isArray(spec.command) && spec.command.length > 0, `${key} must have an explicit argv command`);
    // Guard against ever silently allowlisting a build/deploy/publish/send action.
    const cmdStr = spec.command.join(" ");
    assert.doesNotMatch(cmdStr, /deploy|distribute-substack|send|build-owned|build:newsletter/i);
  }
});
