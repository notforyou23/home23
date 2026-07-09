# Shared-Service Startup Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serialize Home23 shared-service startup across concurrent CLI callers, preserve evidence about every startup pass, and repair the current COSMO PM2/listener split without disturbing unrelated PM2 apps or user-owned changes.

**Architecture:** A new ESM module owns one atomic cross-process lock for the entire Evobrew/COSMO/ScreenLogic startup pass. It refreshes exact-name PM2 state only after lock acquisition, starts missing services sequentially, waits for verified online PIDs, writes an ignored JSONL receipt, and fails closed on duplicates or timeouts. `runStart()` delegates its three existing check-then-start blocks to this coordinator.

**Tech Stack:** Node.js ESM, Node built-in test runner, PM2 CLI, atomic filesystem operations, existing Home23 CLI and onboarding docs.

## Global Constraints

- Never run `pm2 stop all`, `pm2 delete all`, or a broad Home23 restart.
- Preserve every pre-existing modified or untracked file; stage only files named in this plan.
- Keep `instances/`, `logs/`, `ecosystem.config.cjs`, PM2 dumps, and recovery receipts local and untracked.
- Use test-first red/green cycles for every production behavior change.
- The normal CLI startup path must never kill a listener or guess how to repair duplicate PM2 records.
- The live repair may terminate only the confirmed idle Home23 COSMO orphan and mutate only `home23-cosmo23`.
- Push scoped portable commits to `origin/main` only after focused tests, build, full tests, contracts, and live verification pass.

---

### Task 1: Atomic shared-start lock and concurrent-call regression

**Files:**
- Create: `tests/cli/shared-service-start.test.js`
- Create: `cli/lib/shared-service-start.js`

**Interfaces:**
- Produces: `SHARED_SERVICES: ReadonlyArray<{name: string, label: string}>`
- Produces: `coordinateSharedServiceStartup(options): Promise<StartupReceipt>`
- Produces: `acquireStartupLock(options): Promise<LockHandle>`
- Produces: `releaseStartupLock(lockPath, token): boolean`
- Consumes: injected `listProcesses`, `startService`, `pidAlive`, `wait`, `appendReceipt`, `now`, and `randomId` dependencies so tests exercise real coordination without touching live PM2.

- [ ] **Step 1: Write the failing concurrent-start test**

Create `tests/cli/shared-service-start.test.js` with the real filesystem lock and injected PM2 boundaries:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  SHARED_SERVICES,
  coordinateSharedServiceStartup,
} from '../../cli/lib/shared-service-start.js';

function onlineRow(name, pid) {
  return { name, pid, pm2_env: { status: 'online' } };
}

test('concurrent callers start each missing shared service exactly once', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'home23-shared-start-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const lockPath = join(dir, 'shared-service-start.lock');
  const receiptPath = join(dir, 'shared-service-startup.jsonl');
  const online = new Map();
  const starts = new Map();
  let nextPid = 4000;

  const dependencies = {
    listProcesses: async () => Array.from(online, ([name, pid]) => onlineRow(name, pid)),
    startService: async ({ name }) => {
      starts.set(name, (starts.get(name) || 0) + 1);
      await new Promise((resolve) => setTimeout(resolve, 15));
      online.set(name, nextPid++);
    },
    appendReceipt: async (receipt) => {
      const { appendFile } = await import('node:fs/promises');
      await appendFile(receiptPath, `${JSON.stringify(receipt)}\n`);
    },
  };

  const options = {
    home23Root: '/tmp/home23',
    lockPath,
    receiptPath,
    pollMs: 5,
    lockTimeoutMs: 1000,
    startupTimeoutMs: 1000,
    dependencies,
  };

  const results = await Promise.all([
    coordinateSharedServiceStartup(options),
    coordinateSharedServiceStartup(options),
  ]);

  assert.equal(results.every((result) => result.ok), true);
  assert.deepEqual(Object.fromEntries(starts), Object.fromEntries(SHARED_SERVICES.map(({ name }) => [name, 1])));
  assert.equal(results.filter((result) => result.services.every((service) => service.action === 'started')).length, 1);
  assert.equal(results.filter((result) => result.services.every((service) => service.action === 'already-online')).length, 1);
  const receipts = (await readFile(receiptPath, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(receipts.length, 2);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --test --test-concurrency=1 tests/cli/shared-service-start.test.js
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `cli/lib/shared-service-start.js`.

- [ ] **Step 3: Implement the minimal atomic lock and coordinator**

Create `cli/lib/shared-service-start.js` with these production contracts:

```js
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const SHARED_SERVICES = Object.freeze([
  Object.freeze({ name: 'home23-evobrew', label: 'Evobrew' }),
  Object.freeze({ name: 'home23-cosmo23', label: 'COSMO 2.3' }),
  Object.freeze({ name: 'home23-screenlogic', label: 'ScreenLogic bridge' }),
]);

const LOCK_SCHEMA = 'home23.shared-service-start.lock.v1';
const RECEIPT_SCHEMA = 'home23.shared-service-start.receipt.v1';
const PM2_ENV_BLOCKLIST = [
  'cron_restart', 'watch', 'HOME23_AGENT', 'INSTANCE_ID', 'DASHBOARD_PORT',
  'COSMO_DASHBOARD_PORT', 'REALTIME_PORT', 'MCP_HTTP_PORT',
  'COSMO_RUNTIME_DIR', 'COSMO_WORKSPACE_PATH',
];

const waitDefault = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function pidAliveDefault(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function readLock(lockPath) {
  try { return JSON.parse(readFileSync(lockPath, 'utf8')); } catch { return null; }
}

export async function acquireStartupLock({
  lockPath,
  home23Root,
  timeoutMs,
  pollMs,
  staleLockAgeMs,
  dependencies,
}) {
  const startedAtMs = dependencies.now();
  const token = dependencies.randomId();
  const owner = {
    schema: LOCK_SCHEMA,
    token,
    pid: dependencies.processId,
    createdAt: new Date(startedAtMs).toISOString(),
    argv: dependencies.argv,
    home23Root,
  };
  let recovered = 0;
  mkdirSync(dirname(lockPath), { recursive: true });

  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx', 0o600);
      writeFileSync(fd, `${JSON.stringify(owner)}\n`);
      closeSync(fd);
      return { lockPath, token, owner, waitMs: dependencies.now() - startedAtMs, staleLocksRecovered: recovered };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const current = readLock(lockPath);
      const ageMs = dependencies.now() - statSync(lockPath).mtimeMs;
      const stale = current?.pid
        ? !dependencies.pidAlive(Number(current.pid))
        : ageMs >= staleLockAgeMs;
      if (stale) {
        unlinkSync(lockPath);
        recovered += 1;
        continue;
      }
      if (dependencies.now() - startedAtMs >= timeoutMs) {
        throw new Error(`Timed out waiting for shared-service startup lock owned by pid ${current?.pid || 'unknown'}`);
      }
      await dependencies.wait(pollMs);
    }
  }
}

export function releaseStartupLock(lockPath, token) {
  const current = readLock(lockPath);
  if (!current || current.token !== token) return false;
  unlinkSync(lockPath);
  return true;
}

export async function coordinateSharedServiceStartup(options) {
  const home23Root = options.home23Root;
  const lockPath = options.lockPath || join(tmpdir(), 'home23', 'shared-service-start.lock');
  const receiptPath = options.receiptPath || join(home23Root, 'logs', 'shared-service-startup.jsonl');
  const dependencies = {
    listProcesses: listProcessesDefault,
    startService: (service) => startServiceDefault(service, home23Root),
    appendReceipt: (receipt) => appendReceiptDefault(receiptPath, receipt),
    pidAlive: pidAliveDefault,
    wait: waitDefault,
    now: Date.now,
    randomId: randomUUID,
    processId: process.pid,
    argv: process.argv,
    warn: (message) => console.warn(message),
    ...options.dependencies,
  };
  const receipt = {
    schema: RECEIPT_SCHEMA,
    recordedAt: new Date(dependencies.now()).toISOString(),
    caller: { pid: dependencies.processId, argv: dependencies.argv },
    services: [],
    ok: false,
  };
  let lock;
  let failure;

  try {
    lock = await acquireStartupLock({
      lockPath,
      home23Root,
      timeoutMs: options.lockTimeoutMs || 30_000,
      pollMs: options.pollMs || 100,
      staleLockAgeMs: options.staleLockAgeMs || 120_000,
      dependencies,
    });
    receipt.lock = { waitMs: lock.waitMs, staleLocksRecovered: lock.staleLocksRecovered };
    for (const service of options.services || SHARED_SERVICES) {
      const before = exactRecords(await dependencies.listProcesses(), service.name);
      if (before.length > 1) throw new Error(`Duplicate PM2 records for ${service.name}`);
      if (isOnline(before[0])) {
        receipt.services.push({ name: service.name, before, action: 'already-online', after: before });
        continue;
      }
      await dependencies.startService(service);
      const after = await waitForOnline(service.name, dependencies, options.startupTimeoutMs || 15_000, options.pollMs || 100);
      receipt.services.push({ name: service.name, before, action: 'started', after });
    }
    receipt.ok = true;
  } catch (error) {
    failure = error;
    receipt.error = error.message;
  } finally {
    if (lock) releaseStartupLock(lockPath, lock.token);
    try { await dependencies.appendReceipt(receipt); }
    catch (error) { dependencies.warn(`[shared-service-start] receipt write failed: ${error.message}`); }
  }

  if (failure) throw failure;
  return receipt;
}
```

Complete the module with the production helpers used above:

```js
function exactRecords(processes, name) {
  return processes.filter((entry) => entry.name === name);
}

function isOnline(entry) {
  return entry?.pm2_env?.status === 'online' && Number(entry.pid) > 0;
}

async function waitForOnline(name, dependencies, timeoutMs, pollMs) {
  const deadline = dependencies.now() + timeoutMs;
  for (;;) {
    const records = exactRecords(await dependencies.listProcesses(), name);
    if (records.length > 1) throw new Error(`Duplicate PM2 records for ${name}`);
    if (isOnline(records[0])) return records;
    if (dependencies.now() >= deadline) throw new Error(`Timed out waiting for ${name} to become online`);
    await dependencies.wait(pollMs);
  }
}

function parsePm2List(text) {
  const lines = String(text || '').trim().split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const candidate = lines.slice(index).join('\n').trim();
    if (!candidate.startsWith('[')) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed)) return parsed;
    } catch { /* try the next suffix */ }
  }
  throw new Error('pm2 jlist did not return a JSON process list');
}

function cleanCommandEnv() {
  const env = { ...process.env };
  for (const key of PM2_ENV_BLOCKLIST) delete env[key];
  return env;
}

async function listProcessesDefault() {
  return parsePm2List(execFileSync('pm2', ['jlist'], {
    encoding: 'utf8',
    env: cleanCommandEnv(),
    maxBuffer: 20 * 1024 * 1024,
    timeout: 8_000,
  }));
}

async function startServiceDefault(service, home23Root) {
  const unsetArgs = PM2_ENV_BLOCKLIST.flatMap((key) => ['-u', key]);
  execFileSync('env', [
    ...unsetArgs,
    'pm2', 'start', join(home23Root, 'ecosystem.config.cjs'),
    '--only', service.name, '--update-env', '--silent',
  ], { cwd: home23Root, env: cleanCommandEnv(), stdio: 'pipe', timeout: 45_000 });
}

async function appendReceiptDefault(receiptPath, receipt) {
  mkdirSync(dirname(receiptPath), { recursive: true });
  appendFileSync(receiptPath, `${JSON.stringify(receipt)}\n`);
}
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
node --test --test-concurrency=1 tests/cli/shared-service-start.test.js
```

Expected: PASS with one start per shared service and two receipts.

- [ ] **Step 5: Commit the atomic coordinator slice**

```bash
git add cli/lib/shared-service-start.js tests/cli/shared-service-start.test.js
git diff --cached --check
git commit -m "fix: serialize shared service startup"
```

---

### Task 2: Failure safety, stale locks, and receipt coverage

**Files:**
- Modify: `tests/cli/shared-service-start.test.js`
- Modify: `cli/lib/shared-service-start.js`

**Interfaces:**
- Consumes: Task 1 coordinator and lock functions.
- Produces: fail-closed duplicate handling, stale-lock recovery, guaranteed release, timeout reporting, and receipt-write isolation.

- [ ] **Step 1: Add failing behavioral tests**

Add six independent tests using the Task 1 temporary-directory fixture and these exact assertions:

1. `stale dead-owner lock is recovered and recorded`: write valid lock JSON with PID `999999`, inject `pidAlive: () => false`, run the coordinator, then assert `result.ok === true`, `result.lock.staleLocksRecovered === 1`, and the lock path no longer exists.
2. `live lock owner is not displaced before timeout`: write valid lock JSON with token `live-owner`, inject `pidAlive: () => true`, deterministic `now()` advancement, and a no-op `wait`; assert rejection matches `/Timed out waiting/` and re-read the file to assert its token is still `live-owner`.
3. `duplicate PM2 records fail closed without calling startService`: return two online exact-name rows from `listProcesses`; assert rejection matches `/Duplicate PM2 records/` and the start counter remains `0`.
4. `start failure releases the lock and writes a failed receipt`: make `startService` throw `new Error('synthetic start failure')`; assert rejection matches that text, the lock path is absent, the captured receipt has `ok === false`, and its first service has `action === 'failed'`.
5. `startup timeout releases the lock`: let `startService` resolve while `listProcesses` remains stopped, advance `now()` in injected `wait()`, and assert rejection matches `/Timed out waiting for home23-evobrew/` plus an absent lock path.
6. `receipt failure warns without hiding successful startup`: begin with all three services online, make `appendReceipt` throw `new Error('synthetic receipt failure')`, capture `warn`, and assert the returned result has `ok === true` with exactly one warning matching `/receipt write failed/`.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
node --test --test-concurrency=1 tests/cli/shared-service-start.test.js
```

Expected: at least the failed-start receipt assertion fails because the Task 1 coordinator does not yet preserve the failing service's before/action/after record.

- [ ] **Step 3: Implement minimal failure receipts and race-safe stale-lock cleanup**

Adjust the service loop so every attempted service gets a record before start, updates that record after verification, and captures its own error before rethrowing:

```js
const serviceReceipt = { name: service.name, before, action: 'starting', after: [] };
receipt.services.push(serviceReceipt);
try {
  await dependencies.startService(service);
  serviceReceipt.after = await waitForOnline(
    service.name,
    dependencies,
    options.startupTimeoutMs || 15_000,
    options.pollMs || 100,
  );
  serviceReceipt.action = 'started';
} catch (error) {
  serviceReceipt.action = 'failed';
  serviceReceipt.error = error.message;
  throw error;
}
```

When removing a stale lock, re-read the file and require its token to match the stale token observed before unlinking. If the token changed, resume polling instead of removing the new owner's lock.

- [ ] **Step 4: Run focused and related lock tests**

Run:

```bash
node --test --test-concurrency=1 \
  tests/cli/shared-service-start.test.js \
  tests/scripts/home23-pm2-watchdog-daemon.test.cjs \
  tests/scripts/home23-pm2-watchdog.test.cjs
```

Expected: all tests PASS.

- [ ] **Step 5: Commit failure-safety coverage**

```bash
git add cli/lib/shared-service-start.js tests/cli/shared-service-start.test.js
git diff --cached --check
git commit -m "test: harden shared startup failure handling"
```

---

### Task 3: Integrate the coordinator into `home23 start`

**Files:**
- Modify: `cli/lib/pm2-commands.js:8-120`
- Modify: `tests/cli/shared-service-start.test.js`
- Modify: `docs/ONBOARDING.md:92-132`

**Interfaces:**
- Consumes: `coordinateSharedServiceStartup({ home23Root })` from Task 1.
- Produces: one coordinated startup pass for Evobrew, COSMO, and ScreenLogic after agent PM2 startup.

- [ ] **Step 1: Add the failing public-contract assertion**

Add a test proving the shared service registry remains exact and ordered:

```js
test('shared startup contract covers Evobrew, COSMO, and ScreenLogic in order', () => {
  assert.deepEqual(SHARED_SERVICES.map(({ name }) => name), [
    'home23-evobrew',
    'home23-cosmo23',
    'home23-screenlogic',
  ]);
});
```

Before modifying `pm2-commands.js`, run the repository search assertion:

```bash
test "$(rg -c "Start (evobrew|cosmo23|ScreenLogic)" cli/lib/pm2-commands.js)" -gt 0
```

Expected: exit 0, proving the three old independent blocks still exist and must be removed.

- [ ] **Step 2: Replace the three check-then-start blocks**

At the top of `cli/lib/pm2-commands.js`, add:

```js
import { coordinateSharedServiceStartup } from './shared-service-start.js';
```

Delete the three independent `pm2 jlist` / `pm2 start --only` blocks for Evobrew, COSMO, and ScreenLogic. Replace them with:

```js
  const sharedStartup = await coordinateSharedServiceStartup({ home23Root });
  for (const service of sharedStartup.services) {
    const label = SHARED_SERVICE_LABELS.get(service.name) || service.name;
    console.log(`  ${label}: ${service.action}`);
  }
```

Import `SHARED_SERVICES` as well and build `SHARED_SERVICE_LABELS` once:

```js
import {
  SHARED_SERVICES,
  coordinateSharedServiceStartup,
} from './shared-service-start.js';

const SHARED_SERVICE_LABELS = new Map(SHARED_SERVICES.map((service) => [service.name, service.label]));
```

- [ ] **Step 3: Document the serialized contract**

Add to `docs/ONBOARDING.md` immediately after the status verification section:

```markdown
### Concurrent starts and shared services

`home23 start` serializes startup of the shared Evobrew, COSMO, and ScreenLogic services. Multiple concurrent start commands re-check PM2 state inside one cross-process lock, so each missing shared service is started once. Local evidence is appended to `logs/shared-service-startup.jsonl`.

If PM2 reports duplicate records or a service port is owned by an untracked process, stop and inspect the exact service. Use only exact-name PM2 commands; never use global stop/delete commands.
```

- [ ] **Step 4: Verify the old pattern is gone and imports are valid**

Run:

```bash
! rg -n "Start evobrew|Start cosmo23|Start ScreenLogic bridge" cli/lib/pm2-commands.js
node -e "import('./cli/lib/pm2-commands.js')"
node --test --test-concurrency=1 tests/cli/shared-service-start.test.js
git diff --check -- cli/lib/pm2-commands.js cli/lib/shared-service-start.js tests/cli/shared-service-start.test.js docs/ONBOARDING.md
```

Expected: no old independent blocks, module import exits 0, tests PASS, diff check exits 0.

- [ ] **Step 5: Commit CLI integration and docs**

```bash
git add cli/lib/pm2-commands.js cli/lib/shared-service-start.js tests/cli/shared-service-start.test.js docs/ONBOARDING.md
git diff --cached --check
git commit -m "fix: coordinate Home23 shared services"
```

---

### Task 4: Repair and persist the live COSMO state

**Files:**
- Create local ignored receipt: `instances/jerry/brain/evidence/pm2-recovery/2026-07-09-cosmo-startup-race.json`
- Create local safety backup: `/Users/jtr/.pm2/safety-backups/pre-cosmo-race-repair-<timestamp>.dump.pm2`

**Interfaces:**
- Consumes: live `pm2 jlist`, `lsof`, `/api/status`, generated `ecosystem.config.cjs`, and saved `dump.pm2`.
- Produces: one PM2-managed COSMO listener whose PM2 PID owns `43210`, plus a verified saved PM2 dump and local receipt.

- [ ] **Step 1: Capture pre-repair evidence and enforce the idle gate**

Run read-only checks:

```bash
pm2 jlist | jq -r '.[] | select(.name=="home23-cosmo23") | {name,pid,pm_id,status:.pm2_env.status,restarts:.pm2_env.restart_time,script:.pm2_env.pm_exec_path}'
lsof -nP -iTCP:43210 -sTCP:LISTEN
curl -sS --max-time 5 http://127.0.0.1:43210/api/status | jq '{success,lifecycle,activeRun,processOnline,apiReachable}'
ps -p "$(lsof -tiTCP:43210 -sTCP:LISTEN)" -o pid=,ppid=,command=
```

Required before mutation: `success=true`, `activeRun=false`, and listener command equals this checkout's `cosmo23/server/index.js`.

- [ ] **Step 2: Back up the saved PM2 authority**

```bash
timestamp="$(date +%Y%m%d-%H%M%S)"
mkdir -p /Users/jtr/.pm2/safety-backups
cp /Users/jtr/.pm2/dump.pm2 "/Users/jtr/.pm2/safety-backups/pre-cosmo-race-repair-${timestamp}.dump.pm2"
if [[ -f /Users/jtr/.pm2/dump.pm2.bak ]]; then
  cp /Users/jtr/.pm2/dump.pm2.bak "/Users/jtr/.pm2/safety-backups/pre-cosmo-race-repair-${timestamp}.dump.pm2.bak"
fi
```

- [ ] **Step 3: Perform the scoped repair**

With the listener PID captured from Step 1:

```bash
kill -TERM "$cosmo_listener_pid"
```

Poll until that PID is gone and port `43210` is free. Then run only:

```bash
pm2 delete home23-cosmo23
env -u cron_restart -u watch -u HOME23_AGENT -u INSTANCE_ID \
  -u DASHBOARD_PORT -u COSMO_DASHBOARD_PORT -u REALTIME_PORT \
  -u MCP_HTTP_PORT -u COSMO_RUNTIME_DIR -u COSMO_WORKSPACE_PATH \
  pm2 start /Users/jtr/_JTR23_/release/home23/ecosystem.config.cjs \
  --only home23-cosmo23 --update-env
```

Do not mutate any other PM2 name.

- [ ] **Step 4: Verify live identity before saving**

Run:

```bash
pm2 jlist | jq -r '.[] | select(.name=="home23-cosmo23") | {name,pid,pm_id,status:.pm2_env.status,restarts:.pm2_env.restart_time,script:.pm2_env.pm_exec_path}'
lsof -nP -iTCP:43210 -sTCP:LISTEN
curl -sS --max-time 5 http://127.0.0.1:43210/api/status | jq '{success,lifecycle,activeRun,processOnline,apiReachable}'
pm2 jlist | jq -r '[.[] | select(.name|startswith("home23-")) | {name,status:.pm2_env.status,pid}]'
```

Required: exactly one COSMO record, status online, nonzero PID, PM2 PID equals the listener PID, route success, lifecycle idle, activeRun false, and every other Home23 service remains online.

- [ ] **Step 5: Save and verify PM2 authority**

```bash
pm2 save
jq -r '[.[] | {name,status,pid,script:.pm_exec_path}]' /Users/jtr/.pm2/dump.pm2
```

Required: the intended 15 app names are present with no extras or omissions, and the COSMO entry is online with script `/Users/jtr/_JTR23_/release/home23/cosmo23/server/index.js`.

- [ ] **Step 6: Write the local recovery receipt**

Use `apply_patch` only after all post-repair values are captured. Create `instances/jerry/brain/evidence/pm2-recovery/2026-07-09-cosmo-startup-race.json` with literal evidence values and no template markers. The object must contain:

- `schema` equal to `home23.pm2-recovery.receipt.v1`;
- `incident` equal to `cosmo-shared-startup-race`;
- literal ISO timestamps from the diagnosis and repair checks;
- `before` with PM2 status `errored`, orphan PID `11940`, port `43210`, and `activeRun: false`;
- the five executed action descriptions in order;
- `after` with the actual matching PM2/listener PID, status `online`, lifecycle `idle`, `activeRun: false`, and `savedDumpVerified: true`;
- the literal safety-backup path created in Step 2;
- verification booleans for PM2 port ownership, route success, and all other Home23 apps online.

Validate the finished receipt with `jq '.'`. The receipt stays ignored and is not staged.

---

### Task 5: Full verification, scoped review, push, and closeout

**Files:**
- Verify only; no new production files expected.

**Interfaces:**
- Consumes: all portable commits and live receipts.
- Produces: verified `origin/main`, clean scoped stage, and goal completion evidence.

- [ ] **Step 1: Run focused verification**

```bash
node --test --test-concurrency=1 \
  tests/cli/shared-service-start.test.js \
  tests/scripts/home23-pm2-watchdog-daemon.test.cjs \
  tests/scripts/home23-pm2-watchdog.test.cjs
```

Expected: all PASS.

- [ ] **Step 2: Run release/onboarding verification**

```bash
npm run build
npm test
npm run test:contracts
git diff --check
```

Expected: all commands exit 0.

- [ ] **Step 3: Verify fresh-install separation remains intact**

```bash
git ls-files -ci --exclude-standard
git archive HEAD | tar -tf - | rg '^(instances/|config/(home|targets|cron-jobs)\.yaml|ecosystem\.config\.cjs)'
```

Expected: both commands produce no tracked-runtime-state matches.

- [ ] **Step 4: Review the scoped history and worktree**

```bash
git log --oneline origin/main..HEAD
git status --short --branch
git show --stat --oneline HEAD
git diff origin/main...HEAD -- \
  cli/lib/shared-service-start.js \
  cli/lib/pm2-commands.js \
  tests/cli/shared-service-start.test.js \
  docs/ONBOARDING.md \
  docs/superpowers/specs/2026-07-09-shared-service-startup-safety-design.md \
  docs/superpowers/plans/2026-07-09-shared-service-startup-safety.md
```

Required: only scoped portable files are committed; pre-existing user changes remain unstaged.

- [ ] **Step 5: Push and verify remote state**

```bash
git push origin main
git rev-parse HEAD
git rev-parse origin/main
```

Expected: both revisions match.

- [ ] **Step 6: Final live readback**

```bash
pm2 jlist | jq -r '.[] | select((.name|startswith("home23-"))) | [.name,.pm2_env.status,(.pid|tostring)] | @tsv'
lsof -nP -iTCP:43210 -sTCP:LISTEN
curl -sS --max-time 5 http://127.0.0.1:43210/api/status | jq '{success,lifecycle,activeRun,processOnline,apiReachable}'
jq '.' instances/jerry/brain/evidence/pm2-recovery/2026-07-09-cosmo-startup-race.json
```

Required: all Home23 apps online, PM2 COSMO PID owns `43210`, COSMO is healthy-idle, and the receipt matches live truth.
