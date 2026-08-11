// Guard test: shakedown-status.mjs must not resurrect the retired proposal/
// approval-queue surface. The operating model is scripts/shakedown-loop.mjs;
// the status digest reports real blockers, never proposer/approval-runner/queue
// theater. This is a source-level contract test (like the approval-runner
// allowlist test) — the assembler does heavy filesystem IO, so we assert on the
// shape of the code and its emitted latest.json rather than re-running it here.
//
// Run directly: node --test tests/scripts/shakedown-status-retirement.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const STATUS_SRC = readFileSync(join(HERE, "../../scripts/shakedown-status.mjs"), "utf-8");

test("status assembler no longer reads the editorial queue or shells the approval runner", () => {
  assert.doesNotMatch(STATUS_SRC, /article-editorial-queue/, "must not read the editorial queue");
  assert.doesNotMatch(STATUS_SRC, /shakedown-approval-runner/, "must not invoke the approval runner");
  assert.doesNotMatch(STATUS_SRC, /shakedown-proposer-cycle/, "must not surface the proposer cron");
});

test("status assembler emits an honest blockers surface, not a proposals/approvedQueue surface", () => {
  assert.match(STATUS_SRC, /status\.blockers\s*=/, "must build a blockers array");
  assert.doesNotMatch(STATUS_SRC, /status\.needsYou\s*=/, "needsYou proposals surface is retired");
  assert.doesNotMatch(STATUS_SRC, /status\.approvedQueue\s*=/, "approvedQueue surface is retired");
  assert.doesNotMatch(STATUS_SRC, /status\.approvalRunner\s*=/, "approvalRunner surface is retired");
});
