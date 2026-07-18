# AI OS Kernel + Control Plane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce a minimal Home23 OS kernel (Goal → authorize → Action → Receipt → Outcome → BeliefDelta → Recovery) plus a primary Control Plane (Needs you / In flight / Verified) so fuse and human gates are actionable — not vague escalations.

**Architecture:** New `engine/src/os-kernel/` owns canonical JSON stores under `instances/<agent>/brain/os-kernel/`. Live-problems fuse notify and charter approvals *produce* `OperatorIntent` into Needs you. Dashboard Home renders the three lanes via `/api/os-kernel/*`. Reuse `evidence-v1` receipts and existing remediator catalog for safe actions. WIP cap refuses Goal activation. Prose cannot complete a Goal.

**Tech Stack:** Node.js (CommonJS engine modules), existing dashboard Express routes, `node:test`, existing `pm2_restart` / `reclaim_known_safe_disk` remediators, harness `/api/notify`.

**Spec:** `docs/superpowers/specs/2026-07-17-ai-os-kernel-control-plane-design.md`

---

## File Structure

**Create:**
- `engine/src/os-kernel/schemas.js` — constants, action classes, status enums
- `engine/src/os-kernel/store.js` — load/save goals, actions, operator intents, events append
- `engine/src/os-kernel/receipts.js` — build/complete Action receipts via evidence-v1
- `engine/src/os-kernel/authorize.js` — action-class gate + WIP activate
- `engine/src/os-kernel/safe-actions.js` — closed catalog runner
- `engine/src/os-kernel/operator-intents.js` — create/snooze/resolve Needs-you items
- `engine/src/os-kernel/belief-delta.js` — minimal belief write on outcome
- `engine/src/os-kernel/index.js` — public API for engine + dashboard
- `engine/src/dashboard/os-kernel-api.js` — HTTP handlers (mount from server.js)
- `tests/engine/os-kernel/store.test.cjs`
- `tests/engine/os-kernel/authorize.test.cjs`
- `tests/engine/os-kernel/safe-actions.test.cjs`
- `tests/engine/os-kernel/operator-intents.test.cjs`
- `scripts/os-kernel-flagship-receipt.cjs` — verify flagship pack on disk

**Modify:**
- `engine/src/live-problems/loop.js` — on fuse `notify_jtr`, create OperatorIntent before/with notify
- `engine/src/live-problems/seed.js` — fuse seeds carry `checklist` + optional `safeAction`
- `engine/src/live-problems/remediators.js` — `notify_jtr` accepts structured operator payload
- `engine/src/dashboard/server.js` — mount os-kernel routes
- `engine/src/dashboard/home23-dashboard.js` — Home Control Plane lanes
- `engine/src/dashboard/home23-dashboard.html` — containers for Needs you / In flight / Verified

**Reuse (do not duplicate):**
- `engine/src/evidence/evidence-v1.js`
- `engine/src/trust/trust-kernel.js`
- `engine/src/live-problems/remediators.js` (`pm2_restart`, `reclaim_known_safe_disk`)

**Out of scope this plan:** belief-ledger graph, longitudinal A/B, institutional multi-user, new agents, Phase 0 mega-audit.

---

## Task 1: Kernel schemas + store

**Files:**
- Create: `engine/src/os-kernel/schemas.js`
- Create: `engine/src/os-kernel/store.js`
- Create: `tests/engine/os-kernel/store.test.cjs`

- [ ] **Step 1: Write failing store test**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { OsKernelStore } = require('../../../engine/src/os-kernel/store.js');

test('OsKernelStore persists goal and refuses prose-only complete', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'os-kernel-'));
  const store = new OsKernelStore({ brainDir: dir });
  const goal = store.createGoal({
    title: 'File weekly review',
    owner: 'forrest',
    deliverable: 'instances/forrest/workspace/reports/example.md',
    acceptanceTest: { type: 'file_exists', args: { path: 'instances/forrest/workspace/reports/example.md' } },
  });
  assert.equal(goal.status, 'active');
  assert.throws(() => store.completeGoal(goal.id, { proseOnly: true }), /receipt/i);
});
```

- [ ] **Step 2: Run test — expect FAIL (module missing)**

Run: `node --test tests/engine/os-kernel/store.test.cjs`  
Expected: FAIL cannot find module

- [ ] **Step 3: Implement `schemas.js`**

```js
'use strict';

const ACTION_CLASSES = Object.freeze({
  OBSERVE: 'observe',
  ANALYZE: 'analyze',
  DRAFT: 'draft',
  LOCAL_REVERSIBLE: 'local_reversible',
  EXTERNAL_CONSEQUENTIAL: 'external_consequential',
  DESTRUCTIVE: 'destructive',
});

const GOAL_STATUSES = Object.freeze({
  QUEUED: 'queued',
  ACTIVE: 'active',
  BLOCKED: 'blocked',
  COMPLETE: 'complete',
  CANCELLED: 'cancelled',
});

const INTENT_STATUSES = Object.freeze({
  OPEN: 'open',
  SNOOZED: 'snoozed',
  RESOLVED: 'resolved',
  DENIED: 'denied',
});

const DEFAULT_WIP_ACTIVE_MAX = 3;

module.exports = {
  ACTION_CLASSES,
  GOAL_STATUSES,
  INTENT_STATUSES,
  DEFAULT_WIP_ACTIVE_MAX,
  SCHEMA_GOAL: 'home23.os-kernel.goal.v1',
  SCHEMA_ACTION: 'home23.os-kernel.action.v1',
  SCHEMA_OPERATOR_INTENT: 'home23.operator-intent.v1',
  SCHEMA_EVENT: 'home23.os-kernel.event.v1',
  SCHEMA_BELIEF_DELTA: 'home23.os-kernel.belief-delta.v1',
};
```

- [ ] **Step 4: Implement `store.js`**

Persist under `brainDir/os-kernel/`:
- `goals.json` — `{ goals: [] }`
- `actions.json` — `{ actions: [] }`
- `operator-intents.json` — `{ intents: [] }`
- `events.jsonl` — append-only
- `belief-deltas.jsonl` — append-only

Methods: `createGoal`, `getGoal`, `listGoals`, `setGoalStatus`, `completeGoal` (requires `receiptId` or throws), `listActions`, `listOperatorIntents`, `upsertOperatorIntent`, `appendEvent`, atomic write via temp+rename.

- [ ] **Step 5: Run test — expect PASS**

Run: `node --test tests/engine/os-kernel/store.test.cjs`

- [ ] **Step 6: Commit when jtr authorizes**

```bash
git add engine/src/os-kernel/schemas.js engine/src/os-kernel/store.js tests/engine/os-kernel/store.test.cjs
git commit -m "$(cat <<'EOF'
feat(os-kernel): add goal store with receipt-gated completion

EOF
)"
```

---

## Task 2: Authorize + WIP cap

**Files:**
- Create: `engine/src/os-kernel/authorize.js`
- Create: `tests/engine/os-kernel/authorize.test.cjs`

- [ ] **Step 1: Write failing WIP test**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { OsKernelStore } = require('../../../engine/src/os-kernel/store.js');
const { activateGoal } = require('../../../engine/src/os-kernel/authorize.js');

test('activateGoal refuses when active WIP at cap', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'os-kernel-'));
  const store = new OsKernelStore({ brainDir: dir, wipActiveMax: 1 });
  const a = store.createGoal({
    title: 'A', owner: 'jerry', deliverable: 'a.md',
    acceptanceTest: { type: 'manual' }, status: 'queued',
  });
  const b = store.createGoal({
    title: 'B', owner: 'jerry', deliverable: 'b.md',
    acceptanceTest: { type: 'manual' }, status: 'queued',
  });
  activateGoal(store, a.id);
  assert.throws(() => activateGoal(store, b.id), /WIP|cap/i);
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement `authorize.js`**

```js
'use strict';
const { ACTION_CLASSES, GOAL_STATUSES, DEFAULT_WIP_ACTIVE_MAX } = require('./schemas');

function canAutoRun(actionClass) {
  return [
    ACTION_CLASSES.OBSERVE,
    ACTION_CLASSES.ANALYZE,
    ACTION_CLASSES.DRAFT,
    ACTION_CLASSES.LOCAL_REVERSIBLE,
  ].includes(actionClass);
}

function requiresHuman(actionClass) {
  return actionClass === ACTION_CLASSES.EXTERNAL_CONSEQUENTIAL
    || actionClass === ACTION_CLASSES.DESTRUCTIVE;
}

function activateGoal(store, goalId) {
  const max = store.wipActiveMax ?? DEFAULT_WIP_ACTIVE_MAX;
  const active = store.listGoals().filter((g) => g.status === GOAL_STATUSES.ACTIVE);
  if (active.length >= max) {
    throw new Error(`WIP cap: ${active.length}/${max} active goals`);
  }
  return store.setGoalStatus(goalId, GOAL_STATUSES.ACTIVE);
}

function authorizeAction(store, { goalId, actionClass, capabilityId, preview }) {
  if (requiresHuman(actionClass)) {
    return { allowed: false, reason: 'needs_you', actionClass, preview, capabilityId, goalId };
  }
  if (!canAutoRun(actionClass)) {
    return { allowed: false, reason: 'unknown_class', actionClass };
  }
  return { allowed: true, actionClass, capabilityId, goalId };
}

module.exports = { canAutoRun, requiresHuman, activateGoal, authorizeAction };
```

- [ ] **Step 4: Ensure `createGoal` can start as `queued`; run tests PASS**

- [ ] **Step 5: Commit when authorized**

---

## Task 3: Receipts

**Files:**
- Create: `engine/src/os-kernel/receipts.js`
- Create: `tests/engine/os-kernel/receipts.test.cjs`

- [ ] **Step 1: Failing test — completeGoal with receipt**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { OsKernelStore } = require('../../../engine/src/os-kernel/store.js');
const { buildActionReceipt } = require('../../../engine/src/os-kernel/receipts.js');

test('completeGoal accepts receipt with artifact hash', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'os-kernel-'));
  const deliverable = path.join(dir, 'out.md');
  fs.writeFileSync(deliverable, 'done\n');
  const store = new OsKernelStore({ brainDir: dir });
  const goal = store.createGoal({
    title: 'Ship note',
    owner: 'jerry',
    deliverable,
    acceptanceTest: { type: 'file_exists', args: { path: deliverable } },
  });
  const receipt = buildActionReceipt({
    brainDir: dir,
    goalId: goal.id,
    actionClass: 'draft',
    artifactPath: deliverable,
    testResult: { ok: true, detail: 'file_exists' },
    outcome: 'pass',
  });
  store.completeGoal(goal.id, { receiptId: receipt.id, receipt });
  assert.equal(store.getGoal(goal.id).status, 'complete');
});
```

- [ ] **Step 2: Implement `buildActionReceipt` using `buildEvidenceReceipt` from `engine/src/evidence/evidence-v1.js`; write under `brainDir/os-kernel/receipts/<id>.json`**

- [ ] **Step 3: Tests PASS; commit when authorized**

---

## Task 4: Operator intents + safe actions

**Files:**
- Create: `engine/src/os-kernel/operator-intents.js`
- Create: `engine/src/os-kernel/safe-actions.js`
- Create: `tests/engine/os-kernel/operator-intents.test.cjs`
- Create: `tests/engine/os-kernel/safe-actions.test.cjs`

- [ ] **Step 1: Failing tests**

```js
// operator-intents.test.cjs
test('createFromFuseNotify builds open intent with checklist', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'os-kernel-'));
  const store = new OsKernelStore({ brainDir: dir });
  const { createFromFuseNotify } = require('../../../engine/src/os-kernel/operator-intents.js');
  const intent = createFromFuseNotify(store, {
    problemId: 'jerry_harness_online',
    agent: 'jerry',
    title: 'Harness down',
    why: 'Channels are down after pm2 restart failed',
    evidence: 'pm2_status fail',
    checklist: ['Confirm process name', 'Click Restart harness', 'Mark done if verifier green'],
    safeAction: { id: 'restart_pm2', label: 'Restart harness', args: { name: 'home23-jerry-harness' } },
  });
  assert.equal(intent.status, 'open');
  assert.equal(intent.safe_action.id, 'restart_pm2');
});

// safe-actions.test.cjs
test('safe-actions rejects unknown id and non-home23 pm2 names', async () => {
  const { runSafeAction } = require('../../../engine/src/os-kernel/safe-actions.js');
  await assert.rejects(() => runSafeAction({ id: 'rm_rf', args: {} }, {}), /catalog/i);
  await assert.rejects(
    () => runSafeAction({ id: 'restart_pm2', args: { name: 'nginx' } }, {}),
    /home23/i,
  );
});
```

- [ ] **Step 2: Implement operator-intents** (`createFromFuseNotify`, `snooze`, `resolve`, `deny`, `listOpen`)

Deep link path: `/home23#needs-you=<id>`

- [ ] **Step 3: Implement safe-actions**

```js
async function runSafeAction(spec, ctx) {
  const { runRemediator } = require('../live-problems/remediators');
  const id = spec?.id;
  if (id === 'restart_pm2') {
    const name = String(spec.args?.name || '');
    if (!/^home23-/.test(name)) throw new Error('restart_pm2 limited to home23-*');
    return runRemediator({ type: 'pm2_restart', args: { name } }, ctx);
  }
  if (id === 'reclaim_known_safe_disk') {
    return runRemediator({ type: 'exec_command', args: { name: 'reclaim_known_safe_disk' } }, ctx);
  }
  throw new Error(`safe action not in catalog: ${id}`);
}
module.exports = { runSafeAction };
```

- [ ] **Step 4: Tests PASS; commit when authorized**

---

## Task 5: Public kernel index + fuse notify wiring

**Files:**
- Create: `engine/src/os-kernel/index.js`
- Modify: `engine/src/live-problems/loop.js`
- Modify: `engine/src/live-problems/remediators.js`
- Modify: `engine/src/live-problems/seed.js`
- Create: `tests/engine/os-kernel/fuse-notify-intent.test.cjs`

- [ ] **Step 1: `index.js` exports** `getOsKernel(brainDir)`, `createFromFuseNotify`, `runSafeAction`, `activateGoal`, `buildActionReceipt`, `getControlPlaneSnapshot`

```js
function getControlPlaneSnapshot(store) {
  const now = Date.now();
  const intents = store.listOperatorIntents();
  const needsYou = intents.filter((i) => {
    if (i.status === 'open') return true;
    if (i.status === 'snoozed' && Date.parse(i.snoozeUntil || 0) <= now) return true;
    return false;
  });
  const inFlight = store.listActions().filter((a) => a.status === 'running');
  const verified = store.listGoals().filter((g) => g.status === 'complete').slice(-10).reverse();
  return { needsYou, inFlight, verified };
}
```

- [ ] **Step 2: In `loop.js`, when `isFuseBoxNotify(step)` and about to run remediator, `createFromFuseNotify` using `step.args` checklist/safeAction**

- [ ] **Step 3: `notify_jtr` sends structured short form when `args.operatorIntent` present**

```text
NEEDS YOU — <title>
<why>
1) <checklist[0]>
→ <absolute deep link>
```

Absolute link from `ctx.dashboardBaseUrl` or `http://127.0.0.1:${DASHBOARD_PORT}/home23#needs-you=...`

- [ ] **Step 4: Fuse seeds get `checklist` + `safeAction` (disk, harness, dash, engine, create_file, brain_graph)**

- [ ] **Step 5: Unit test — scenery notify (no fuseBox) does not create intent**

- [ ] **Step 6: Commit when authorized**

---

## Task 6: HTTP API

**Files:**
- Create: `engine/src/dashboard/os-kernel-api.js`
- Modify: `engine/src/dashboard/server.js`

- [ ] **Step 1: Routes**

```text
GET  /api/os-kernel/state
POST /api/os-kernel/intents/:id/safe-action
POST /api/os-kernel/intents/:id/mark-done
POST /api/os-kernel/intents/:id/snooze      body: { hours?: 12 }
POST /api/os-kernel/intents/:id/deny
POST /api/os-kernel/intents/:id/approve
```

`mark-done` / `safe-action`: re-run live-problem verifier if `problemId` set; if still failing, keep intent open + `lastError`.

Auth: same pattern as `/api/live-problems/:id/user-intervention`.

- [ ] **Step 2: Mount near live-problems routes in `server.js`**

- [ ] **Step 3: Smoke** `curl -s localhost:5002/api/os-kernel/state | head`

- [ ] **Step 4: Commit when authorized**

---

## Task 7: Dashboard Control Plane UI

**Files:**
- Modify: `engine/src/dashboard/home23-dashboard.html`
- Modify: `engine/src/dashboard/home23-dashboard.js`

- [ ] **Step 1: Add Home region**

```html
<section id="os-control-plane" class="h23-os-control-plane">
  <div id="os-needs-you"></div>
  <div id="os-in-flight"></div>
  <div id="os-verified"></div>
</section>
```

- [ ] **Step 2: Fetch `/api/os-kernel/state` on Home load; render Needs you cards (title, why, evidence, checklist, buttons)**

Buttons: Do safe action / Mark done / Not now / Deny (when authorize preview).  
Hash `#needs-you=<id>` focuses card.

- [ ] **Step 3: Wire POSTs; refresh**

- [ ] **Step 4: Demote Good Life visually to secondary (keep strip)**

- [ ] **Step 5: Commit when authorized**

---

## Task 8: BeliefDelta minimum

**Files:**
- Create: `engine/src/os-kernel/belief-delta.js`
- Create: `tests/engine/os-kernel/belief-delta.test.cjs`

- [ ] **Step 1: Test appends delta**

```js
test('recordBeliefDelta writes claim and outcome', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'os-kernel-'));
  const store = new OsKernelStore({ brainDir: dir });
  const { recordBeliefDelta } = require('../../../engine/src/os-kernel/belief-delta.js');
  const delta = recordBeliefDelta(store, {
    goalId: 'g1',
    claim: 'harness was down',
    outcome: 'pass',
    revisedBelief: 'harness recovered after pm2 restart',
    evidenceReceiptId: 'r1',
  });
  assert.equal(delta.schema, 'home23.os-kernel.belief-delta.v1');
});
```

- [ ] **Step 2: Implement; call from mark-done / safe-action success; optional TrustKernel claim**

- [ ] **Step 3: PASS; commit when authorized**

---

## Task 9: Flagship #1 harness

**Files:**
- Create: `scripts/os-kernel-flagship-receipt.cjs`
- Create: `docs/receipts/YYYY-MM-DD-os-kernel-flagship-N.md` when each run succeeds

- [ ] **Step 1: Script** creates Goal, verifies deliverable exists, builds receipt, completes Goal, writes BeliefDelta, prints snapshot

Prefer first run:

```bash
node scripts/os-kernel-flagship-receipt.cjs \
  --agent forrest \
  --deliverable instances/forrest/workspace/reports/2026-07-17-weekly.md
```

Expected: exit 0, `flagship_ok`

- [ ] **Step 2: Repeat for flagship #2 and #3 with distinct goals before claiming kernel v0**

- [ ] **Step 3: File receipts under `docs/receipts/`**

---

## Task 10: Engine wiring + regression

**Files:**
- Modify: live-problems init / `ctxProvider` to attach `ctx.osKernel`
- Modify: `engine/src/index.js` if needed

- [ ] **Step 1: Pass `osKernel` into live-problems loop context**

- [ ] **Step 2: Run**

```bash
node --test tests/engine/os-kernel/*.cjs \
  tests/engine/good-life/objective.test.js \
  tests/engine/live-problems/notify-fuse-box.test.cjs
```

Expected: all PASS

- [ ] **Step 3: Restart jerry/forrest engine+dash; smoke Control Plane on `/home23`**

- [ ] **Step 4: Final commit when authorized**

---

## Spec coverage

| Spec requirement | Task |
|------------------|------|
| Goal/Action/Receipt/Event | 1, 3 |
| Action classes + human gate | 2 |
| WIP ≤3 | 2 |
| Receipt required to complete | 1, 3 |
| OperatorIntent / Needs you | 4, 5 |
| Safe catalog only | 4 |
| Fuse → intent + Telegram | 5 |
| Scenery silent | 5 |
| Control plane UI + APIs | 6, 7 |
| BeliefDelta minimum | 8 |
| Flagship proof | 9 |
| Demote Good Life as primary | 7 |

## Notes

- Commit steps are **optional until jtr authorizes** (repo rule).
- Do not expand into belief-ledger / Phase 0 audit in this plan.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-17-ai-os-kernel-control-plane.md`.

**Two execution options:**

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks  
2. **Inline Execution** — this session with checkpoints  

Which approach?
