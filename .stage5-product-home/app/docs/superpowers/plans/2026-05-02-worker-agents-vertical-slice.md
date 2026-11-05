# Worker Agents Vertical Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first reusable Home23 worker-agent slice with a `systems` worker that can be created, listed, run through the backend connector, leave receipts, feed Jerry's workspace and brain, expose house-agent tools, and emit engine observations without creating a full engine.

**Architecture:** Workers live under `instances/workers/<name>` and are discovered separately from full agents. The reusable runtime lives in `src/workers`, the first backend connector mounts on the existing harness API in `src/home.ts`, Jerry and Forrest call it through normal tools, and the engine observes receipts through a new `work.worker-runs` channel. The first slice is deliberately single-worker and single-active-run-per-owner so safety, receipts, and observability land before parallel worker orchestration.

**Tech Stack:** Node 20, TypeScript ESM, Express 5, `js-yaml`, `node:test`, `tsx`, existing Home23 agent loop and engine channel patterns.

---

## Scope

This plan implements one complete worker path:

```text
CLI/API/chat/live-problems
  -> worker registry
  -> worker runner
  -> systems worker workspace and run folder
  -> receipt.json
  -> instances/jerry/workspace/worker-runs/<run-id>.md
  -> instances/jerry/brain/worker-runs.jsonl
  -> work.worker-runs engine channel
```

It does not build the dashboard UI, macOS UI, every default worker template, or multi-worker parallel scheduling. Those are separate plans after this slice proves the connector and receipt contract.

## File Structure

- Create `config/workers.json`
  - Defines packaged worker templates and the default initial worker list.
- Create `cli/templates/workers/systems/worker.yaml`
  - Template config for the first `systems` worker.
- Create `cli/templates/workers/systems/workspace/IDENTITY.md`
  - Worker identity and boundaries.
- Create `cli/templates/workers/systems/workspace/PLAYBOOK.md`
  - Systems diagnostic playbook with Home23-specific non-destructive rules.
- Create `cli/templates/workers/systems/workspace/NOW.md`
  - Mutable current-state note seeded during worker creation.
- Create `src/workers/types.ts`
  - Shared worker config, run request, run status, receipt, and connector event types.
- Create `src/workers/registry.ts`
  - Loads packaged templates and `instances/workers/*/worker.yaml` without touching full-agent discovery.
- Create `src/workers/scaffold.ts`
  - Creates `instances/workers/<name>` from templates with idempotent directory creation.
- Create `src/workers/receipts.ts`
  - Writes and reads `receipt.json`, owner workspace Markdown, and owner brain JSONL.
- Create `src/workers/runner.ts`
  - Runs a worker through the owner harness context and enforces one active run per owner.
- Create `src/workers/connector.ts`
  - Express router for the first `/api/workers` connector endpoints. Live event streaming follows after this slice.
- Create `src/workers/index.ts`
  - Barrel exports for worker modules.
- Create `cli/lib/worker-commands.js`
  - CLI command handlers for `worker create`, `worker list`, and `worker run`.
- Modify `cli/home23.js`
  - Register the new `worker` command group.
- Modify `src/home.ts`
  - Mount the worker connector on the existing harness app, passing agent loop context.
- Create `src/agent/tools/workers.ts`
  - House-agent tools that call the connector instead of duplicating runtime logic.
- Modify `src/agent/tools/index.ts`
  - Register `worker_list`, `worker_run`, `worker_status`, `worker_receipt`, and `worker_promote_memory`.
- Modify `src/agent/types.ts`
  - Add optional `workerConnectorBaseUrl?: string` to `ToolContext`.
- Create `engine/src/channels/work/worker-runs-channel.js`
  - Polls owner brain worker-run receipts and emits `work.worker-runs` observations.
- Modify `engine/src/index.js`
  - Register the worker-runs channel next to `work.live-problems`, integrating with current in-progress edits.
- Modify `engine/src/live-problems/remediators.js`
  - Add `dispatch_to_worker`.
- Modify `engine/src/live-problems/loop.js`
  - Treat worker dispatch as a Tier-3 lock holder, using the existing dispatch lifecycle.
- Modify `src/agent/context-assembly.ts`
  - Add a concise worker roster and recent worker-run receipt section to house-agent context.

## Task 1: Worker Types And Registry

**Files:**
- Create: `src/workers/types.ts`
- Create: `src/workers/registry.ts`
- Create: `src/workers/index.ts`
- Create: `config/workers.json`
- Test: `tests/workers/registry.test.ts`

- [ ] **Step 1: Write registry tests**

Create `tests/workers/registry.test.ts`:

```ts
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { listWorkerTemplates, listWorkers, loadWorker } from '../../src/workers/registry.js';

function tempRoot() {
  return mkdtempSync(path.join(tmpdir(), 'home23-workers-'));
}

test('listWorkerTemplates reads packaged worker templates', () => {
  const root = tempRoot();
  mkdirSync(path.join(root, 'config'), { recursive: true });
  writeFileSync(path.join(root, 'config', 'workers.json'), JSON.stringify({
    templates: {
      systems: {
        displayName: 'Systems',
        class: 'ops',
        ownerAgent: 'jerry',
        purpose: 'Diagnose Home23 host and PM2 issues.'
      }
    }
  }, null, 2));

  const templates = listWorkerTemplates(root);
  assert.equal(templates.length, 1);
  assert.equal(templates[0].name, 'systems');
  assert.equal(templates[0].ownerAgent, 'jerry');
});

test('listWorkers ignores full agents and loads only instances/workers configs', () => {
  const root = tempRoot();
  mkdirSync(path.join(root, 'instances', 'jerry'), { recursive: true });
  mkdirSync(path.join(root, 'instances', 'workers', 'systems'), { recursive: true });
  writeFileSync(path.join(root, 'instances', 'jerry', 'config.yaml'), 'name: jerry\n');
  writeFileSync(path.join(root, 'instances', 'workers', 'systems', 'worker.yaml'), [
    'kind: worker',
    'name: systems',
    'displayName: Systems',
    'ownerAgent: jerry',
    'class: ops',
    'purpose: Diagnose Home23 host/process issues.',
    'tools:',
    '  shell: true',
    'limits:',
    '  maxRuntimeMinutes: 45'
  ].join('\n'));

  const workers = listWorkers(root);
  assert.deepEqual(workers.map(w => w.name), ['systems']);

  const loaded = loadWorker(root, 'systems');
  assert.equal(loaded.name, 'systems');
  assert.equal(loaded.ownerAgent, 'jerry');
  assert.equal(loaded.rootPath.endsWith(path.join('instances', 'workers', 'systems')), true);
});
```

- [ ] **Step 2: Run registry tests to verify failure**

Run:

```bash
node --import tsx --test --test-concurrency=1 tests/workers/registry.test.ts
```

Expected: fail with a module-not-found error for `src/workers/registry.js`.

- [ ] **Step 3: Add shared worker types**

Create `src/workers/types.ts`:

```ts
export type WorkerRunStatus =
  | 'queued'
  | 'running'
  | 'fixed'
  | 'no_change'
  | 'blocked'
  | 'failed'
  | 'cancelled';

export type WorkerVerifierStatus = 'pass' | 'fail' | 'unknown' | 'not_run';

export interface WorkerTemplateSummary {
  name: string;
  displayName: string;
  class: string;
  ownerAgent: string;
  purpose: string;
}

export interface WorkerConfig {
  kind: 'worker';
  name: string;
  displayName: string;
  ownerAgent: string;
  class: string;
  purpose: string;
  provider?: string;
  model?: string;
  tools?: Record<string, boolean>;
  safetyPolicy?: Record<string, unknown>;
  feedsBrains?: string[];
  visibleTo?: string[];
  limits?: {
    maxRuntimeMinutes?: number;
    maxToolCalls?: number;
    maxTokens?: number;
  };
  rootPath: string;
  configPath: string;
}

export interface WorkerRunRequest {
  worker: string;
  prompt: string;
  ownerAgent?: string;
  requestedBy: 'human' | 'house-agent' | 'live-problems' | 'good-life' | 'cron' | 'cli' | 'api';
  requester?: string;
  source?: {
    type: string;
    id?: string;
    url?: string;
  };
  metadata?: Record<string, unknown>;
}

export interface WorkerReceiptAction {
  type: string;
  path?: string;
  target?: string;
  detail?: string;
}

export interface WorkerReceiptEvidence {
  type: string;
  detail: string;
  status?: WorkerVerifierStatus;
}

export interface WorkerMemoryCandidate {
  text: string;
  confidence: number;
  appliesTo?: string[];
}

export interface WorkerRunReceipt {
  schema: 'home23.worker-run.v1';
  runId: string;
  worker: string;
  ownerAgent: string;
  requestedBy: WorkerRunRequest['requestedBy'];
  requester?: string;
  startedAt: string;
  finishedAt: string;
  status: WorkerRunStatus;
  verifierStatus: WorkerVerifierStatus;
  summary: string;
  rootCause?: string;
  actions: WorkerReceiptAction[];
  evidence: WorkerReceiptEvidence[];
  artifacts: string[];
  memoryCandidates: WorkerMemoryCandidate[];
  source?: WorkerRunRequest['source'];
}

export interface WorkerRunRecord {
  runId: string;
  worker: string;
  ownerAgent: string;
  requestedBy: WorkerRunRequest['requestedBy'];
  startedAt: string;
  finishedAt?: string;
  status: WorkerRunStatus;
  runPath: string;
  receiptPath?: string;
  summary?: string;
}

export type WorkerConnectorEvent =
  | { type: 'worker_run_started'; runId: string; worker: string; ownerAgent: string }
  | { type: 'worker_run_progress'; runId: string; message: string }
  | { type: 'worker_run_receipt'; runId: string; status: WorkerRunStatus; verifierStatus: WorkerVerifierStatus }
  | { type: 'worker_run_failed'; runId: string; status: WorkerRunStatus; summary: string }
  | { type: 'worker_brain_feed'; runId: string; brain: string; status: 'written' | 'skipped' };
```

- [ ] **Step 4: Add packaged template config**

Create `config/workers.json`:

```json
{
  "schema": "home23.workers.v1",
  "templates": {
    "systems": {
      "displayName": "Systems",
      "class": "ops",
      "ownerAgent": "jerry",
      "purpose": "Diagnose Home23 host, PM2, ports, logs, and scoped service issues without destructive global operations."
    }
  }
}
```

- [ ] **Step 5: Implement the registry**

Create `src/workers/registry.ts`:

```ts
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import type { WorkerConfig, WorkerTemplateSummary } from './types.js';

function readJson(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function readYaml(filePath: string): unknown {
  return yaml.load(readFileSync(filePath, 'utf8'));
}

function assertObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function normalizeWorkerConfig(raw: unknown, rootPath: string, configPath: string): WorkerConfig {
  assertObject(raw, configPath);
  const kind = asString(raw.kind, 'kind');
  if (kind !== 'worker') throw new Error(`${configPath} kind must be worker`);

  return {
    kind: 'worker',
    name: asString(raw.name, 'name'),
    displayName: asString(raw.displayName, 'displayName'),
    ownerAgent: asString(raw.ownerAgent, 'ownerAgent'),
    class: asString(raw.class, 'class'),
    purpose: asString(raw.purpose, 'purpose'),
    provider: typeof raw.provider === 'string' ? raw.provider : undefined,
    model: typeof raw.model === 'string' ? raw.model : undefined,
    tools: raw.tools && typeof raw.tools === 'object' && !Array.isArray(raw.tools) ? raw.tools as Record<string, boolean> : {},
    safetyPolicy: raw.safetyPolicy && typeof raw.safetyPolicy === 'object' && !Array.isArray(raw.safetyPolicy) ? raw.safetyPolicy as Record<string, unknown> : {},
    feedsBrains: Array.isArray(raw.feedsBrains) ? raw.feedsBrains.filter(v => typeof v === 'string') : [asString(raw.ownerAgent, 'ownerAgent')],
    visibleTo: Array.isArray(raw.visibleTo) ? raw.visibleTo.filter(v => typeof v === 'string') : [asString(raw.ownerAgent, 'ownerAgent')],
    limits: raw.limits && typeof raw.limits === 'object' && !Array.isArray(raw.limits) ? raw.limits as WorkerConfig['limits'] : {},
    rootPath,
    configPath
  };
}

export function workersDir(projectRoot: string): string {
  return path.join(projectRoot, 'instances', 'workers');
}

export function listWorkerTemplates(projectRoot: string): WorkerTemplateSummary[] {
  const filePath = path.join(projectRoot, 'config', 'workers.json');
  if (!existsSync(filePath)) return [];
  const raw = readJson(filePath);
  assertObject(raw, filePath);
  const templates = raw.templates;
  assertObject(templates, 'templates');

  return Object.entries(templates)
    .map(([name, value]) => {
      assertObject(value, `templates.${name}`);
      return {
        name,
        displayName: asString(value.displayName, `${name}.displayName`),
        class: asString(value.class, `${name}.class`),
        ownerAgent: asString(value.ownerAgent, `${name}.ownerAgent`),
        purpose: asString(value.purpose, `${name}.purpose`)
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function listWorkers(projectRoot: string): WorkerConfig[] {
  const dir = workersDir(projectRoot);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => path.join(dir, entry.name))
    .map(rootPath => path.join(rootPath, 'worker.yaml'))
    .filter(filePath => existsSync(filePath))
    .map(filePath => normalizeWorkerConfig(readYaml(filePath), path.dirname(filePath), filePath))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function loadWorker(projectRoot: string, name: string): WorkerConfig {
  const worker = listWorkers(projectRoot).find(w => w.name === name);
  if (!worker) throw new Error(`Worker not found: ${name}`);
  return worker;
}
```

- [ ] **Step 6: Add worker module exports**

Create `src/workers/index.ts`:

```ts
export * from './types.js';
export * from './registry.js';
```

- [ ] **Step 7: Run registry tests**

Run:

```bash
node --import tsx --test --test-concurrency=1 tests/workers/registry.test.ts
```

Expected: pass.

- [ ] **Step 8: Commit Task 1**

```bash
git add config/workers.json src/workers/types.ts src/workers/registry.ts src/workers/index.ts tests/workers/registry.test.ts
git commit -m "feat: add worker registry"
```

## Task 2: Systems Worker Template And CLI Scaffolding

**Files:**
- Create: `cli/templates/workers/systems/worker.yaml`
- Create: `cli/templates/workers/systems/workspace/IDENTITY.md`
- Create: `cli/templates/workers/systems/workspace/PLAYBOOK.md`
- Create: `cli/templates/workers/systems/workspace/NOW.md`
- Create: `src/workers/scaffold.ts`
- Create: `cli/lib/worker-commands.js`
- Modify: `cli/home23.js`
- Test: `tests/workers/scaffold.test.ts`

- [ ] **Step 1: Write scaffold tests**

Create `tests/workers/scaffold.test.ts`:

```ts
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createWorkerFromTemplate } from '../../src/workers/scaffold.js';

function tempRoot() {
  return mkdtempSync(path.join(tmpdir(), 'home23-worker-scaffold-'));
}

test('createWorkerFromTemplate creates a worker without creating agent config', () => {
  const projectRoot = tempRoot();
  const result = createWorkerFromTemplate(projectRoot, {
    name: 'systems',
    template: 'systems',
    ownerAgent: 'jerry'
  });

  assert.equal(result.worker.name, 'systems');
  assert.equal(existsSync(path.join(projectRoot, 'instances', 'workers', 'systems', 'worker.yaml')), true);
  assert.equal(existsSync(path.join(projectRoot, 'instances', 'workers', 'systems', 'workspace', 'IDENTITY.md')), true);
  assert.equal(existsSync(path.join(projectRoot, 'instances', 'workers', 'systems', 'runs')), true);
  assert.equal(existsSync(path.join(projectRoot, 'instances', 'workers', 'systems', 'logs')), true);
  assert.equal(existsSync(path.join(projectRoot, 'instances', 'workers', 'systems', 'config.yaml')), false);

  const text = readFileSync(path.join(projectRoot, 'instances', 'workers', 'systems', 'worker.yaml'), 'utf8');
  assert.match(text, /name: systems/);
  assert.match(text, /ownerAgent: jerry/);
});

test('createWorkerFromTemplate refuses to overwrite existing worker config', () => {
  const projectRoot = tempRoot();
  createWorkerFromTemplate(projectRoot, { name: 'systems', template: 'systems', ownerAgent: 'jerry' });
  const before = statSync(path.join(projectRoot, 'instances', 'workers', 'systems', 'worker.yaml')).mtimeMs;
  assert.throws(
    () => createWorkerFromTemplate(projectRoot, { name: 'systems', template: 'systems', ownerAgent: 'jerry' }),
    /already exists/
  );
  const after = statSync(path.join(projectRoot, 'instances', 'workers', 'systems', 'worker.yaml')).mtimeMs;
  assert.equal(after, before);
});
```

- [ ] **Step 2: Run scaffold tests to verify failure**

```bash
node --import tsx --test --test-concurrency=1 tests/workers/scaffold.test.ts
```

Expected: fail with module-not-found for `src/workers/scaffold.js`.

- [ ] **Step 3: Add systems worker template**

Create `cli/templates/workers/systems/worker.yaml`:

```yaml
kind: worker
name: systems
displayName: Systems
ownerAgent: jerry
class: ops
purpose: Diagnose Home23 host, PM2, ports, logs, and scoped service issues without destructive global operations.
tools:
  shell: true
  files: true
  cron: true
  brain: true
  web: false
safetyPolicy:
  pm2Scope: home23-only
  forbidGlobalPm2: true
  forbidForcePush: true
  requireVerifierBeforeSuccess: true
feedsBrains:
  - jerry
visibleTo:
  - jerry
  - forrest
limits:
  maxRuntimeMinutes: 45
  maxToolCalls: 80
  maxTokens: 120000
```

Create `cli/templates/workers/systems/workspace/IDENTITY.md`:

```md
# Systems Worker

You are the Home23 systems worker. You diagnose host, PM2, process, port, log, and scoped service problems for Home23.

You are not a house agent. Jerry owns your work unless a request explicitly names another owner. You do not create engines, dashboards, feeders, or autonomous brain loops.

Hard boundaries:

- Never run `pm2 stop all`.
- Never run `pm2 delete all`.
- Restart only named Home23 PM2 processes when the request and evidence require it.
- Treat existing workspace changes as important Home23/Codex work.
- Preserve evidence before and after actions.
- A run is successful only when the requested verifier or an equivalent concrete check passes.
```

Create `cli/templates/workers/systems/workspace/PLAYBOOK.md`:

```md
# Systems Playbook

Default inspection order:

1. Identify the exact Home23 process, port, verifier, or log named by the request.
2. Check process state with scoped PM2 commands.
3. Check the endpoint or file freshness the verifier depends on.
4. Read only the logs needed for the named process.
5. Prefer diagnosis and evidence over restarts.
6. If a restart is needed, restart only the named Home23 process.
7. Re-run the verifier and record the result.

Useful commands:

- `pm2 jlist`
- `curl -s http://localhost:5002/api/state`
- `curl -s http://localhost:5002/api/good-life`
```

Create `cli/templates/workers/systems/workspace/NOW.md`:

```md
# Systems Worker Now

No active run yet.
```

- [ ] **Step 4: Implement scaffolding**

Create `src/workers/scaffold.ts`:

```ts
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { loadWorker } from './registry.js';
import type { WorkerConfig } from './types.js';

export interface CreateWorkerOptions {
  name: string;
  template: string;
  ownerAgent?: string;
}

export interface CreateWorkerResult {
  worker: WorkerConfig;
  createdPath: string;
}

function assertWorkerName(name: string): string {
  if (!/^[a-z][a-z0-9-]{1,62}$/.test(name)) {
    throw new Error('Worker name must be lowercase kebab-case and 2-63 characters long');
  }
  return name;
}

export function createWorkerFromTemplate(projectRoot: string, opts: CreateWorkerOptions): CreateWorkerResult {
  const name = assertWorkerName(opts.name);
  const template = assertWorkerName(opts.template);
  const sourceDir = path.join(projectRoot, 'cli', 'templates', 'workers', template);
  const targetDir = path.join(projectRoot, 'instances', 'workers', name);
  const targetConfig = path.join(targetDir, 'worker.yaml');

  if (!existsSync(sourceDir)) throw new Error(`Worker template not found: ${template}`);
  if (existsSync(targetConfig)) throw new Error(`Worker already exists: ${name}`);

  mkdirSync(path.dirname(targetDir), { recursive: true });
  cpSync(sourceDir, targetDir, { recursive: true, errorOnExist: false });
  mkdirSync(path.join(targetDir, 'runs'), { recursive: true });
  mkdirSync(path.join(targetDir, 'logs'), { recursive: true });
  mkdirSync(path.join(targetDir, 'workspace', 'sessions'), { recursive: true });
  mkdirSync(path.join(targetDir, 'workspace', 'artifacts'), { recursive: true });

  const raw = yaml.load(readFileSync(targetConfig, 'utf8')) as Record<string, unknown>;
  raw.name = name;
  if (opts.ownerAgent) raw.ownerAgent = opts.ownerAgent;
  writeFileSync(targetConfig, yaml.dump(raw, { lineWidth: 120, noRefs: true }));

  return {
    worker: loadWorker(projectRoot, name),
    createdPath: targetDir
  };
}
```

Update `src/workers/index.ts`:

```ts
export * from './types.js';
export * from './registry.js';
export * from './scaffold.js';
```

- [ ] **Step 5: Add CLI command handlers**

Create `cli/lib/worker-commands.js`:

```js
import path from 'node:path';
import { pathToFileURL } from 'node:url';

async function loadWorkersModule() {
  const url = pathToFileURL(path.join(process.cwd(), 'src', 'workers', 'index.ts')).href;
  return await import(url);
}

function parseOptions(args) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--template') out.template = args[++i];
    else if (arg === '--owner') out.ownerAgent = args[++i];
    else out._.push(arg);
  }
  return out;
}

export async function handleWorkerCommand(args, projectRoot = process.cwd()) {
  const [subcommand, ...rest] = args;
  const workers = await loadWorkersModule();

  if (subcommand === 'create') {
    const opts = parseOptions(rest);
    const name = opts._[0];
    if (!name) throw new Error('Usage: home23 worker create <name> --template <template> [--owner <agent>]');
    const result = workers.createWorkerFromTemplate(projectRoot, {
      name,
      template: opts.template || name,
      ownerAgent: opts.ownerAgent
    });
    console.log(`created worker ${result.worker.name} at ${result.createdPath}`);
    return;
  }

  if (subcommand === 'list') {
    const rows = workers.listWorkers(projectRoot);
    if (rows.length === 0) {
      console.log('no workers created');
      return;
    }
    for (const worker of rows) {
      console.log(`${worker.name}\t${worker.ownerAgent}\t${worker.class}\t${worker.purpose}`);
    }
    return;
  }

  if (subcommand === 'run') {
    throw new Error('worker run is added after the backend connector lands in Task 5');
  }

  throw new Error('Usage: home23 worker <create|list|run> ...');
}
```

- [ ] **Step 6: Register CLI command**

Modify `cli/home23.js` near the main command dispatch:

```js
if (command === 'worker') {
  const { handleWorkerCommand } = await import('./lib/worker-commands.js');
  await handleWorkerCommand(args);
  process.exit(0);
}
```

Place this before the default unknown-command branch, alongside existing command groups.

- [ ] **Step 7: Run scaffold tests and CLI smoke**

```bash
node --import tsx --test --test-concurrency=1 tests/workers/scaffold.test.ts
node --import tsx cli/home23.js worker create systems --template systems
node --import tsx cli/home23.js worker list
```

Expected:

- Tests pass.
- `instances/workers/systems/worker.yaml` exists.
- `instances/workers/systems/config.yaml` does not exist.
- `worker list` prints `systems`.

- [ ] **Step 8: Commit Task 2**

```bash
git add cli/templates/workers/systems src/workers/scaffold.ts src/workers/index.ts cli/lib/worker-commands.js cli/home23.js tests/workers/scaffold.test.ts instances/workers/systems
git commit -m "feat: scaffold systems worker"
```

## Task 3: Receipt Writer And Brain Feed

**Files:**
- Create: `src/workers/receipts.ts`
- Modify: `src/workers/index.ts`
- Test: `tests/workers/receipts.test.ts`

- [ ] **Step 1: Write receipt tests**

Create `tests/workers/receipts.test.ts`:

```ts
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { writeWorkerReceipt } from '../../src/workers/receipts.js';
import type { WorkerRunReceipt } from '../../src/workers/types.js';

function receipt(runId = 'wr_20260502_143000_systems_ab12'): WorkerRunReceipt {
  return {
    schema: 'home23.worker-run.v1',
    runId,
    worker: 'systems',
    ownerAgent: 'jerry',
    requestedBy: 'live-problems',
    startedAt: '2026-05-02T14:30:00.000Z',
    finishedAt: '2026-05-02T14:42:00.000Z',
    status: 'fixed',
    verifierStatus: 'pass',
    summary: 'Scoped process check passed.',
    rootCause: 'Dashboard process needed scoped restart.',
    actions: [{ type: 'pm2_restart', target: 'home23-jerry-dash' }],
    evidence: [{ type: 'http', detail: 'GET /api/state returned 200', status: 'pass' }],
    artifacts: ['instances/workers/systems/runs/wr_20260502_143000_systems_ab12/transcript.md'],
    memoryCandidates: [{ text: 'Dashboard state checks should use port 5002.', confidence: 0.9, appliesTo: ['dashboard'] }]
  };
}

test('writeWorkerReceipt writes run receipt, owner workspace markdown, and brain jsonl', () => {
  const projectRoot = mkdtempSync(path.join(tmpdir(), 'home23-receipts-'));
  const runPath = path.join(projectRoot, 'instances', 'workers', 'systems', 'runs', receipt().runId);
  const written = writeWorkerReceipt(projectRoot, runPath, receipt());

  assert.equal(existsSync(written.receiptPath), true);
  assert.equal(existsSync(path.join(projectRoot, 'instances', 'jerry', 'workspace', 'worker-runs', `${receipt().runId}.md`)), true);
  assert.equal(existsSync(path.join(projectRoot, 'instances', 'jerry', 'brain', 'worker-runs.jsonl')), true);

  const brainLine = readFileSync(path.join(projectRoot, 'instances', 'jerry', 'brain', 'worker-runs.jsonl'), 'utf8').trim();
  const parsed = JSON.parse(brainLine);
  assert.equal(parsed.runId, receipt().runId);
  assert.equal(parsed.summary, 'Scoped process check passed.');
  assert.equal(parsed.transcriptIncluded, false);
});
```

- [ ] **Step 2: Run receipt tests to verify failure**

```bash
node --import tsx --test --test-concurrency=1 tests/workers/receipts.test.ts
```

Expected: fail with module-not-found for `src/workers/receipts.js`.

- [ ] **Step 3: Implement receipt writer**

Create `src/workers/receipts.ts`:

```ts
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { WorkerRunReceipt } from './types.js';

export interface WrittenWorkerReceipt {
  receiptPath: string;
  ownerWorkspacePath: string;
  ownerBrainPath: string;
}

function ensureDir(dir: string) {
  mkdirSync(dir, { recursive: true });
}

function receiptMarkdown(receipt: WorkerRunReceipt, receiptPath: string): string {
  const evidence = receipt.evidence.map(e => `- ${e.type}: ${e.detail}${e.status ? ` (${e.status})` : ''}`).join('\n') || '- none recorded';
  const actions = receipt.actions.map(a => `- ${a.type}${a.target ? `: ${a.target}` : ''}${a.path ? `: ${a.path}` : ''}${a.detail ? `: ${a.detail}` : ''}`).join('\n') || '- none recorded';
  const memory = receipt.memoryCandidates.map(m => `- ${m.text} (confidence ${m.confidence})`).join('\n') || '- none';

  return [
    `# Worker Run ${receipt.runId}`,
    '',
    `Worker: ${receipt.worker}`,
    `Owner: ${receipt.ownerAgent}`,
    `Requested by: ${receipt.requestedBy}`,
    `Status: ${receipt.status}`,
    `Verifier: ${receipt.verifierStatus}`,
    `Started: ${receipt.startedAt}`,
    `Finished: ${receipt.finishedAt}`,
    '',
    '## Summary',
    receipt.summary,
    '',
    '## Root Cause',
    receipt.rootCause || 'Not established.',
    '',
    '## Actions',
    actions,
    '',
    '## Evidence',
    evidence,
    '',
    '## Memory Candidates',
    memory,
    '',
    '## Receipt',
    receiptPath
  ].join('\n');
}

export function writeWorkerReceipt(projectRoot: string, runPath: string, receipt: WorkerRunReceipt): WrittenWorkerReceipt {
  ensureDir(runPath);
  const receiptPath = path.join(runPath, 'receipt.json');
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);

  const ownerWorkspaceDir = path.join(projectRoot, 'instances', receipt.ownerAgent, 'workspace', 'worker-runs');
  ensureDir(ownerWorkspaceDir);
  const ownerWorkspacePath = path.join(ownerWorkspaceDir, `${receipt.runId}.md`);
  writeFileSync(ownerWorkspacePath, `${receiptMarkdown(receipt, receiptPath)}\n`);

  const ownerBrainDir = path.join(projectRoot, 'instances', receipt.ownerAgent, 'brain');
  ensureDir(ownerBrainDir);
  const ownerBrainPath = path.join(ownerBrainDir, 'worker-runs.jsonl');
  const brainRecord = {
    schema: 'home23.worker-run-memory.v1',
    runId: receipt.runId,
    worker: receipt.worker,
    ownerAgent: receipt.ownerAgent,
    requestedBy: receipt.requestedBy,
    status: receipt.status,
    verifierStatus: receipt.verifierStatus,
    startedAt: receipt.startedAt,
    finishedAt: receipt.finishedAt,
    summary: receipt.summary,
    rootCause: receipt.rootCause || null,
    actions: receipt.actions,
    evidence: receipt.evidence,
    memoryCandidates: receipt.memoryCandidates,
    receiptPath,
    ownerWorkspacePath,
    transcriptIncluded: false
  };
  appendFileSync(ownerBrainPath, `${JSON.stringify(brainRecord)}\n`);

  return { receiptPath, ownerWorkspacePath, ownerBrainPath };
}

export function readWorkerReceipt(receiptPath: string): WorkerRunReceipt {
  if (!existsSync(receiptPath)) throw new Error(`Receipt not found: ${receiptPath}`);
  return JSON.parse(readFileSync(receiptPath, 'utf8')) as WorkerRunReceipt;
}
```

Update `src/workers/index.ts`:

```ts
export * from './types.js';
export * from './registry.js';
export * from './scaffold.js';
export * from './receipts.js';
```

- [ ] **Step 4: Run receipt tests**

```bash
node --import tsx --test --test-concurrency=1 tests/workers/receipts.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit Task 3**

```bash
git add src/workers/receipts.ts src/workers/index.ts tests/workers/receipts.test.ts
git commit -m "feat: write worker run receipts"
```

## Task 4: Worker Runner

**Files:**
- Create: `src/workers/runner.ts`
- Modify: `src/workers/index.ts`
- Test: `tests/workers/runner.test.ts`

- [ ] **Step 1: Write runner tests with an injected fake agent loop**

Create `tests/workers/runner.test.ts`:

```ts
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runWorker } from '../../src/workers/runner.js';
import type { AgentLoopRunner, ToolContext } from '../../src/agent/types.js';

function seedWorker(projectRoot: string) {
  const dir = path.join(projectRoot, 'instances', 'workers', 'systems');
  mkdirSync(path.join(dir, 'workspace'), { recursive: true });
  mkdirSync(path.join(dir, 'runs'), { recursive: true });
  writeFileSync(path.join(dir, 'worker.yaml'), [
    'kind: worker',
    'name: systems',
    'displayName: Systems',
    'ownerAgent: jerry',
    'class: ops',
    'purpose: Diagnose systems issues.',
    'limits:',
    '  maxRuntimeMinutes: 45'
  ].join('\n'));
  writeFileSync(path.join(dir, 'workspace', 'IDENTITY.md'), '# Systems\n');
  writeFileSync(path.join(dir, 'workspace', 'PLAYBOOK.md'), '# Playbook\n');
}

function fakeContext(projectRoot: string, loop: AgentLoopRunner): ToolContext {
  return {
    scheduler: null,
    ttsService: null,
    browser: null,
    projectRoot,
    enginePort: 5001,
    agentName: 'jerry',
    cosmo23BaseUrl: 'http://localhost:43210',
    brainRoute: null,
    workspacePath: path.join(projectRoot, 'instances', 'jerry', 'workspace'),
    tempDir: path.join(projectRoot, '.tmp'),
    contextManager: {
      getSystemPrompt: () => 'house prompt',
      getPromptSourceInfo: () => ({ generatedAt: new Date().toISOString(), totalSections: 0, loadedFiles: [] }),
      invalidate: () => undefined
    },
    subAgentTracker: { active: 0, maxConcurrent: 1, queue: [] },
    chatId: 'test',
    telegramAdapter: null,
    runAgentLoop: loop
  };
}

test('runWorker writes input, transcript, receipt, and owner brain feed', async () => {
  const projectRoot = mkdtempSync(path.join(tmpdir(), 'home23-runner-'));
  seedWorker(projectRoot);
  const loop: AgentLoopRunner = async (systemPrompt, userMessage) => {
    assert.match(systemPrompt, /Systems/);
    assert.match(userMessage, /Check PM2/);
    return { text: 'Summary: checked scoped PM2 state\nVerifier: pass', model: 'fake', toolCallCount: 0, durationMs: 5 };
  };

  const result = await runWorker({
    projectRoot,
    request: { worker: 'systems', prompt: 'Check PM2', requestedBy: 'api' },
    ctx: fakeContext(projectRoot, loop)
  });

  assert.equal(result.receipt.worker, 'systems');
  assert.equal(result.receipt.ownerAgent, 'jerry');
  assert.equal(result.receipt.status, 'no_change');
  assert.equal(result.receipt.verifierStatus, 'pass');
  assert.equal(existsSync(path.join(result.runPath, 'input.md')), true);
  assert.equal(existsSync(path.join(result.runPath, 'transcript.md')), true);
  assert.equal(existsSync(path.join(result.runPath, 'receipt.json')), true);
  assert.match(readFileSync(path.join(projectRoot, 'instances', 'jerry', 'brain', 'worker-runs.jsonl'), 'utf8'), /checked scoped PM2 state/);
});
```

- [ ] **Step 2: Run runner tests to verify failure**

```bash
node --import tsx --test --test-concurrency=1 tests/workers/runner.test.ts
```

Expected: fail with module-not-found for `src/workers/runner.js`.

- [ ] **Step 3: Implement worker runner**

Create `src/workers/runner.ts`:

```ts
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadWorker } from './registry.js';
import { writeWorkerReceipt } from './receipts.js';
import type { ToolContext } from '../agent/types.js';
import type { WorkerRunReceipt, WorkerRunRequest } from './types.js';

const activeOwners = new Set<string>();

export interface RunWorkerInput {
  projectRoot: string;
  request: WorkerRunRequest;
  ctx: ToolContext;
}

export interface RunWorkerResult {
  runId: string;
  runPath: string;
  receipt: WorkerRunReceipt;
}

function runId(worker: string, now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const suffix = Math.random().toString(16).slice(2, 6);
  return `wr_${stamp}_${worker}_${suffix}`;
}

function workerSystemPrompt(workerName: string, identity: string, playbook: string): string {
  return [
    `You are the reusable Home23 worker named ${workerName}.`,
    '',
    identity,
    '',
    playbook,
    '',
    'Return concise findings with evidence. Do not claim success unless a concrete verifier or equivalent check passed.'
  ].join('\n');
}

function receiptFromResponse(args: {
  request: WorkerRunRequest;
  runId: string;
  runPath: string;
  worker: ReturnType<typeof loadWorker>;
  startedAt: string;
  finishedAt: string;
  responseText: string;
}): WorkerRunReceipt {
  const verifierStatus = /verifier:\s*pass/i.test(args.responseText) ? 'pass' : 'unknown';
  const status = /fixed/i.test(args.responseText) ? 'fixed' : 'no_change';
  const summary = args.responseText.split('\n').find(line => line.trim())?.replace(/^Summary:\s*/i, '').trim() || 'Worker run completed.';
  return {
    schema: 'home23.worker-run.v1',
    runId: args.runId,
    worker: args.worker.name,
    ownerAgent: args.request.ownerAgent || args.worker.ownerAgent,
    requestedBy: args.request.requestedBy,
    requester: args.request.requester,
    startedAt: args.startedAt,
    finishedAt: args.finishedAt,
    status,
    verifierStatus,
    summary,
    actions: [],
    evidence: [{ type: 'worker_response', detail: summary, status: verifierStatus }],
    artifacts: [path.join(args.runPath, 'transcript.md')],
    memoryCandidates: [],
    source: args.request.source
  };
}

export async function runWorker(input: RunWorkerInput): Promise<RunWorkerResult> {
  const worker = loadWorker(input.projectRoot, input.request.worker);
  const owner = input.request.ownerAgent || worker.ownerAgent;
  if (activeOwners.has(owner)) throw new Error(`Worker run already active for owner ${owner}`);
  if (!input.ctx.runAgentLoop) throw new Error('Worker runner requires runAgentLoop in ToolContext');

  activeOwners.add(owner);
  try {
    const id = runId(worker.name);
    const runPath = path.join(worker.rootPath, 'runs', id);
    mkdirSync(runPath, { recursive: true });

    const startedAt = new Date().toISOString();
    const identityPath = path.join(worker.rootPath, 'workspace', 'IDENTITY.md');
    const playbookPath = path.join(worker.rootPath, 'workspace', 'PLAYBOOK.md');
    const identity = await import('node:fs').then(fs => fs.existsSync(identityPath) ? fs.readFileSync(identityPath, 'utf8') : '');
    const playbook = await import('node:fs').then(fs => fs.existsSync(playbookPath) ? fs.readFileSync(playbookPath, 'utf8') : '');

    writeFileSync(path.join(runPath, 'input.md'), input.request.prompt);
    const systemPrompt = workerSystemPrompt(worker.name, identity, playbook);
    const response = await input.ctx.runAgentLoop(systemPrompt, input.request.prompt, [], {
      ...input.ctx,
      agentName: owner,
      workspacePath: path.join(worker.rootPath, 'workspace'),
      chatId: `worker:${worker.name}:${id}`
    });
    const finishedAt = new Date().toISOString();
    writeFileSync(path.join(runPath, 'transcript.md'), response.text);

    const receipt = receiptFromResponse({
      request: { ...input.request, ownerAgent: owner },
      runId: id,
      runPath,
      worker,
      startedAt,
      finishedAt,
      responseText: response.text
    });
    writeWorkerReceipt(input.projectRoot, runPath, receipt);
    return { runId: id, runPath, receipt };
  } finally {
    activeOwners.delete(owner);
  }
}
```

Update `src/workers/index.ts`:

```ts
export * from './types.js';
export * from './registry.js';
export * from './scaffold.js';
export * from './receipts.js';
export * from './runner.js';
```

- [ ] **Step 4: Run runner tests**

```bash
node --import tsx --test --test-concurrency=1 tests/workers/runner.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit Task 4**

```bash
git add src/workers/runner.ts src/workers/index.ts tests/workers/runner.test.ts
git commit -m "feat: run reusable workers"
```

## Task 5: Backend Connector API

**Files:**
- Create: `src/workers/connector.ts`
- Modify: `cli/lib/worker-commands.js`
- Modify: `src/workers/index.ts`
- Modify: `src/home.ts`
- Test: `tests/workers/connector.test.ts`

- [ ] **Step 1: Write connector handler tests**

Create `tests/workers/connector.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWorkerHandlers } from '../../src/workers/connector.js';

test('worker handlers list workers through injected dependencies', async () => {
  const handlers = createWorkerHandlers({
    projectRoot: '/tmp/home23',
    listWorkers: () => [{ name: 'systems', ownerAgent: 'jerry', class: 'ops', purpose: 'Diagnose', displayName: 'Systems' }],
    listTemplates: () => [],
    runWorker: async () => { throw new Error('not used'); },
    readRunReceipt: async () => { throw new Error('not used'); }
  });

  const result = await handlers.listWorkers();
  assert.equal(result.workers[0].name, 'systems');
});

test('worker handlers start a run through injected runner', async () => {
  const handlers = createWorkerHandlers({
    projectRoot: '/tmp/home23',
    listWorkers: () => [],
    listTemplates: () => [],
    runWorker: async request => ({
      runId: 'wr_1',
      runPath: '/tmp/home23/instances/workers/systems/runs/wr_1',
      receipt: {
        schema: 'home23.worker-run.v1',
        runId: 'wr_1',
        worker: 'systems',
        ownerAgent: 'jerry',
        requestedBy: request.requestedBy,
        startedAt: '2026-05-02T00:00:00.000Z',
        finishedAt: '2026-05-02T00:01:00.000Z',
        status: 'no_change',
        verifierStatus: 'pass',
        summary: request.prompt,
        actions: [],
        evidence: [],
        artifacts: [],
        memoryCandidates: []
      }
    }),
    readRunReceipt: async () => { throw new Error('not used'); }
  });

  const result = await handlers.startRun('systems', { prompt: 'check host', requestedBy: 'api' });
  assert.equal(result.runId, 'wr_1');
  assert.equal(result.receipt.summary, 'check host');
});

test('worker handlers promote memory candidates for an existing receipt', async () => {
  const handlers = createWorkerHandlers({
    projectRoot: '/tmp/home23',
    listWorkers: () => [],
    listTemplates: () => [],
    runWorker: async () => { throw new Error('not used'); },
    readRunReceipt: async () => ({
      schema: 'home23.worker-run.v1',
      runId: 'wr_1',
      worker: 'systems',
      ownerAgent: 'jerry',
      requestedBy: 'api',
      startedAt: '2026-05-02T00:00:00.000Z',
      finishedAt: '2026-05-02T00:01:00.000Z',
      status: 'no_change',
      verifierStatus: 'pass',
      summary: 'checked',
      actions: [],
      evidence: [],
      artifacts: [],
      memoryCandidates: [{ text: 'Use scoped PM2 checks first.', confidence: 0.9 }]
    })
  });

  const result = await handlers.promoteMemory('wr_1');
  assert.equal(result.runId, 'wr_1');
  assert.equal(result.candidates, 1);
  assert.equal(result.status, 'ready_for_memory_curator');
});
```

- [ ] **Step 2: Run connector tests to verify failure**

```bash
node --import tsx --test --test-concurrency=1 tests/workers/connector.test.ts
```

Expected: fail with module-not-found for `src/workers/connector.js`.

- [ ] **Step 3: Implement connector handlers and Express mount**

Create `src/workers/connector.ts`:

```ts
import express from 'express';
import path from 'node:path';
import { listWorkerTemplates, listWorkers } from './registry.js';
import { runWorker as defaultRunWorker } from './runner.js';
import { readWorkerReceipt } from './receipts.js';
import type { ToolContext } from '../agent/types.js';
import type { WorkerRunRequest, WorkerRunReceipt } from './types.js';

type WorkerSummary = Pick<ReturnType<typeof listWorkers>[number], 'name' | 'displayName' | 'ownerAgent' | 'class' | 'purpose'>;

export interface WorkerHandlerDeps {
  projectRoot: string;
  ctx?: ToolContext;
  listWorkers?: () => WorkerSummary[];
  listTemplates?: () => ReturnType<typeof listWorkerTemplates>;
  runWorker?: (request: WorkerRunRequest) => Promise<{ runId: string; runPath: string; receipt: WorkerRunReceipt }>;
  readRunReceipt?: (runId: string) => Promise<WorkerRunReceipt>;
}

export function createWorkerHandlers(deps: WorkerHandlerDeps) {
  const list = deps.listWorkers || (() => listWorkers(deps.projectRoot));
  const templates = deps.listTemplates || (() => listWorkerTemplates(deps.projectRoot));
  const runner = deps.runWorker || ((request: WorkerRunRequest) => {
    if (!deps.ctx) throw new Error('Worker connector requires ToolContext');
    return defaultRunWorker({ projectRoot: deps.projectRoot, request, ctx: deps.ctx });
  });

  return {
    async listWorkers() {
      return { workers: list() };
    },
    async getWorker(name: string) {
      const worker = list().find(w => w.name === name);
      if (!worker) throw new Error(`Worker not found: ${name}`);
      return { worker };
    },
    async listTemplates() {
      return { templates: templates() };
    },
    async startRun(worker: string, body: Partial<WorkerRunRequest> & { prompt?: string }) {
      if (!body.prompt || typeof body.prompt !== 'string') throw new Error('prompt is required');
      return await runner({
        worker,
        prompt: body.prompt,
        ownerAgent: body.ownerAgent,
        requestedBy: body.requestedBy || 'api',
        requester: body.requester,
        source: body.source,
        metadata: body.metadata
      });
    },
    async readReceipt(runId: string) {
      if (deps.readRunReceipt) return await deps.readRunReceipt(runId);
      const matches = listWorkers(deps.projectRoot)
        .map(worker => path.join(worker.rootPath, 'runs', runId, 'receipt.json'));
      const found = matches.find(filePath => {
        try {
          readWorkerReceipt(filePath);
          return true;
        } catch {
          return false;
        }
      });
      if (!found) throw new Error(`Worker run not found: ${runId}`);
      return readWorkerReceipt(found);
    },
    async promoteMemory(runId: string) {
      const receipt = await this.readReceipt(runId);
      return {
        runId,
        status: 'ready_for_memory_curator',
        candidates: receipt.memoryCandidates.length,
        memoryCandidates: receipt.memoryCandidates
      };
    }
  };
}

export function createWorkerRouter(deps: WorkerHandlerDeps): express.Router {
  const router = express.Router();
  const handlers = createWorkerHandlers(deps);

  router.get('/api/workers', async (_req, res) => {
    try { res.json(await handlers.listWorkers()); } catch (err) { res.status(500).json({ error: String(err instanceof Error ? err.message : err) }); }
  });
  router.get('/api/workers/:name', async (req, res) => {
    try { res.json(await handlers.getWorker(req.params.name)); } catch (err) { res.status(404).json({ error: String(err instanceof Error ? err.message : err) }); }
  });
  router.get('/api/workers/templates', async (_req, res) => {
    try { res.json(await handlers.listTemplates()); } catch (err) { res.status(500).json({ error: String(err instanceof Error ? err.message : err) }); }
  });
  router.post('/api/workers/:name/runs', async (req, res) => {
    try { res.json(await handlers.startRun(req.params.name, req.body || {})); } catch (err) { res.status(400).json({ error: String(err instanceof Error ? err.message : err) }); }
  });
  router.get('/api/workers/runs/:runId/receipt', async (req, res) => {
    try { res.json(await handlers.readReceipt(req.params.runId)); } catch (err) { res.status(404).json({ error: String(err instanceof Error ? err.message : err) }); }
  });
  router.post('/api/workers/runs/:runId/promote-memory', async (req, res) => {
    try { res.json(await handlers.promoteMemory(req.params.runId)); } catch (err) { res.status(404).json({ error: String(err instanceof Error ? err.message : err) }); }
  });

  return router;
}
```

Update `src/workers/index.ts`:

```ts
export * from './types.js';
export * from './registry.js';
export * from './scaffold.js';
export * from './receipts.js';
export * from './runner.js';
export * from './connector.js';
```

- [ ] **Step 4: Mount connector in harness backend**

Modify `src/home.ts` where the bridge or harness Express app is assembled. Add an import:

```ts
import { createWorkerRouter } from './workers/connector.js';
```

After JSON body middleware and before fallback routes, mount:

```ts
bridgeApp.use(createWorkerRouter({
  projectRoot,
  ctx: toolContext
}));
```

If the local variable names differ, use the existing `projectRoot` and `ToolContext` object that already backs `/api/diagnose`. Do not create a second agent loop or a second server.

- [ ] **Step 5: Run connector tests**

```bash
node --import tsx --test --test-concurrency=1 tests/workers/connector.test.ts
```

Expected: pass.

- [ ] **Step 6: Add CLI worker run against the connector**

Modify `cli/lib/worker-commands.js` so the `run` branch posts to the connector instead of reading worker folders directly:

```js
  if (subcommand === 'run') {
    const opts = parseOptions(rest);
    const name = opts._[0];
    const prompt = opts._.slice(1).join(' ');
    if (!name || !prompt) throw new Error('Usage: home23 worker run <name> "<prompt>"');
    const baseUrl = process.env.HOME23_WORKER_CONNECTOR_URL || 'http://127.0.0.1:5004';
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/workers/${encodeURIComponent(name)}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt, requestedBy: 'cli', requester: 'home23-cli' })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `worker connector HTTP ${res.status}`);
    console.log(JSON.stringify(data, null, 2));
    return;
  }
```

- [ ] **Step 7: Run CLI command against a fake connector during implementation**

Start a tiny local fake connector from a separate shell or test helper, then run:

```bash
HOME23_WORKER_CONNECTOR_URL=http://127.0.0.1:<fake-port> node --import tsx cli/home23.js worker run systems "check host"
```

Expected: the command prints JSON containing `runId`.

- [ ] **Step 8: Commit Task 5**

```bash
git add src/workers/connector.ts src/workers/index.ts src/home.ts cli/lib/worker-commands.js tests/workers/connector.test.ts
git commit -m "feat: expose worker connector api"
```

## Task 6: House-Agent Worker Tools

**Files:**
- Create: `src/agent/tools/workers.ts`
- Modify: `src/agent/tools/index.ts`
- Modify: `src/agent/types.ts`
- Test: `tests/agent/tools/workers.test.ts`

- [ ] **Step 1: Write tool tests**

Create `tests/agent/tools/workers.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { workerListTool, workerRunTool } from '../../../src/agent/tools/workers.js';
import type { ToolContext } from '../../../src/agent/types.js';

function ctx(fetchImpl: typeof fetch): ToolContext {
  return {
    scheduler: null,
    ttsService: null,
    browser: null,
    projectRoot: '/tmp/home23',
    enginePort: 5001,
    agentName: 'jerry',
    cosmo23BaseUrl: 'http://localhost:43210',
    brainRoute: null,
    workspacePath: '/tmp/home23/instances/jerry/workspace',
    tempDir: '/tmp/home23/.tmp',
    contextManager: {
      getSystemPrompt: () => '',
      getPromptSourceInfo: () => ({ generatedAt: '', totalSections: 0, loadedFiles: [] }),
      invalidate: () => undefined
    },
    subAgentTracker: { active: 0, maxConcurrent: 1, queue: [] },
    chatId: 'test',
    telegramAdapter: null,
    runAgentLoop: null,
    workerConnectorBaseUrl: 'http://worker.test',
    fetch: fetchImpl
  } as ToolContext & { fetch: typeof fetch };
}

test('worker_list calls connector', async () => {
  const fakeFetch = async (url: string | URL | Request) => {
    assert.equal(String(url), 'http://worker.test/api/workers');
    return new Response(JSON.stringify({ workers: [{ name: 'systems', ownerAgent: 'jerry' }] }), { status: 200 });
  };
  const result = await workerListTool.execute({}, ctx(fakeFetch as typeof fetch));
  assert.match(result.content, /systems/);
});

test('worker_run posts prompt to connector', async () => {
  const fakeFetch = async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(url), 'http://worker.test/api/workers/systems/runs');
    assert.equal(init?.method, 'POST');
    assert.match(String(init?.body), /check host/);
    return new Response(JSON.stringify({ runId: 'wr_1', receipt: { status: 'no_change', verifierStatus: 'pass', summary: 'checked' } }), { status: 200 });
  };
  const result = await workerRunTool.execute({ worker: 'systems', prompt: 'check host' }, ctx(fakeFetch as typeof fetch));
  assert.match(result.content, /wr_1/);
  assert.match(result.content, /checked/);
});
```

- [ ] **Step 2: Run tool tests to verify failure**

```bash
node --import tsx --test --test-concurrency=1 tests/agent/tools/workers.test.ts
```

Expected: fail with module-not-found for `src/agent/tools/workers.js`.

- [ ] **Step 3: Add worker connector fields to ToolContext**

Modify `src/agent/types.ts` inside `ToolContext`:

```ts
  workerConnectorBaseUrl?: string;
```

If tests use an injected fetch helper, add this optional field as well:

```ts
  fetch?: typeof fetch;
```

- [ ] **Step 4: Implement tools**

Create `src/agent/tools/workers.ts`:

```ts
import type { ToolContext, ToolDefinition } from '../types.js';

function baseUrl(ctx: ToolContext): string {
  return ctx.workerConnectorBaseUrl || `http://127.0.0.1:${process.env.HOME23_BRIDGE_PORT || '5004'}`;
}

function fetcher(ctx: ToolContext): typeof fetch {
  return ctx.fetch || fetch;
}

async function jsonRequest(ctx: ToolContext, path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetcher(ctx)(`${baseUrl(ctx)}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers || {}) }
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error((data && typeof data === 'object' && 'error' in data) ? String(data.error) : `HTTP ${res.status}`);
  return data;
}

export const workerListTool: ToolDefinition = {
  name: 'worker_list',
  description: 'List reusable Home23 workers available through the worker connector.',
  input_schema: { type: 'object', properties: {}, additionalProperties: false },
  async execute(_input, ctx) {
    const data = await jsonRequest(ctx, '/api/workers');
    return { content: JSON.stringify(data, null, 2) };
  }
};

export const workerRunTool: ToolDefinition = {
  name: 'worker_run',
  description: 'Run a reusable Home23 worker through the backend connector and return the receipt summary.',
  input_schema: {
    type: 'object',
    properties: {
      worker: { type: 'string' },
      prompt: { type: 'string' },
      requestedBy: { type: 'string', enum: ['house-agent', 'human', 'live-problems', 'good-life', 'cron', 'cli', 'api'] }
    },
    required: ['worker', 'prompt'],
    additionalProperties: false
  },
  async execute(input, ctx) {
    const worker = String(input.worker || '');
    const prompt = String(input.prompt || '');
    const data = await jsonRequest(ctx, `/api/workers/${encodeURIComponent(worker)}/runs`, {
      method: 'POST',
      body: JSON.stringify({ prompt, requestedBy: input.requestedBy || 'house-agent', requester: ctx.agentName })
    }) as { runId?: string; receipt?: { status?: string; verifierStatus?: string; summary?: string } };
    return { content: `Worker run ${data.runId}: ${data.receipt?.status || 'unknown'} / verifier ${data.receipt?.verifierStatus || 'unknown'}\n${data.receipt?.summary || ''}` };
  }
};

export const workerStatusTool: ToolDefinition = {
  name: 'worker_status',
  description: 'Return current worker roster and recent status from the connector.',
  input_schema: { type: 'object', properties: {}, additionalProperties: false },
  async execute(_input, ctx) {
    const data = await jsonRequest(ctx, '/api/workers');
    return { content: JSON.stringify(data, null, 2) };
  }
};

export const workerReceiptTool: ToolDefinition = {
  name: 'worker_receipt',
  description: 'Fetch a worker run receipt by run id.',
  input_schema: {
    type: 'object',
    properties: { runId: { type: 'string' } },
    required: ['runId'],
    additionalProperties: false
  },
  async execute(input, ctx) {
    const data = await jsonRequest(ctx, `/api/workers/runs/${encodeURIComponent(String(input.runId))}/receipt`);
    return { content: JSON.stringify(data, null, 2) };
  }
};

export const workerPromoteMemoryTool: ToolDefinition = {
  name: 'worker_promote_memory',
  description: 'Mark worker receipt memory candidates for promotion through the connector.',
  input_schema: {
    type: 'object',
    properties: { runId: { type: 'string' } },
    required: ['runId'],
    additionalProperties: false
  },
  async execute(input, ctx) {
    const data = await jsonRequest(ctx, `/api/workers/runs/${encodeURIComponent(String(input.runId))}/promote-memory`, { method: 'POST', body: '{}' });
    return { content: JSON.stringify(data, null, 2) };
  }
};
```

- [ ] **Step 5: Register tools**

Modify `src/agent/tools/index.ts` imports:

```ts
import { workerListTool, workerRunTool, workerStatusTool, workerReceiptTool, workerPromoteMemoryTool } from './workers.js';
```

Register before `promoteToMemoryTool`:

```ts
  registry.register(workerListTool);
  registry.register(workerRunTool);
  registry.register(workerStatusTool);
  registry.register(workerReceiptTool);
  registry.register(workerPromoteMemoryTool);
```

- [ ] **Step 6: Run tool tests**

```bash
node --import tsx --test --test-concurrency=1 tests/agent/tools/workers.test.ts
```

Expected: pass.

- [ ] **Step 7: Commit Task 6**

```bash
git add src/agent/types.ts src/agent/tools/workers.ts src/agent/tools/index.ts tests/agent/tools/workers.test.ts
git commit -m "feat: add worker tools"
```

## Task 7: Engine Worker-Runs Channel

**Files:**
- Create: `engine/src/channels/work/worker-runs-channel.js`
- Modify: `engine/src/index.js`
- Test: `tests/engine/channels/work/worker-runs-channel.test.js`

- [ ] **Step 1: Write channel test**

Create `tests/engine/channels/work/worker-runs-channel.test.js`:

```js
'use strict';

import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WorkerRunsChannel } from '../../../../engine/src/channels/work/worker-runs-channel.js';

test('WorkerRunsChannel emits completed worker receipt after priming', async () => {
  const root = mkdtempSync(join(tmpdir(), 'home23-worker-channel-'));
  const file = join(root, 'worker-runs.jsonl');
  writeFileSync(file, JSON.stringify({ runId: 'wr_1', worker: 'systems', updatedAt: '2026-05-02T00:00:00.000Z', status: 'running' }) + '\n');
  const channel = new WorkerRunsChannel({ path: file, intervalMs: 1000 });

  assert.deepEqual(await channel.poll(), []);
  appendFileSync(file, JSON.stringify({ runId: 'wr_1', worker: 'systems', finishedAt: '2026-05-02T00:01:00.000Z', status: 'no_change', verifierStatus: 'pass', summary: 'checked' }) + '\n');
  const raw = await channel.poll();
  assert.equal(raw.length, 1);
  const parsed = channel.parse(raw[0]);
  const obs = channel.verify(parsed);
  assert.equal(obs.channelId, 'work.worker-runs');
  assert.equal(obs.flag, 'COLLECTED');
  assert.equal(obs.payload.worker, 'systems');
  assert.deepEqual(channel.crystallize(obs).tags, ['work', 'worker-run', 'systems', 'no_change']);
});
```

- [ ] **Step 2: Run channel test to verify failure**

```bash
node --test --test-concurrency=1 tests/engine/channels/work/worker-runs-channel.test.js
```

Expected: fail with module-not-found for `worker-runs-channel.js`.

- [ ] **Step 3: Implement channel**

Create `engine/src/channels/work/worker-runs-channel.js`:

```js
/**
 * WorkerRunsChannel polls owner brain worker-runs.jsonl and emits work events
 * when a worker receipt changes. Raw transcripts stay in worker run folders.
 */

import { existsSync, readFileSync } from 'node:fs';
import { PollChannel } from '../base/poll-channel.js';
import { ChannelClass, makeObservation } from '../contract.js';

export class WorkerRunsChannel extends PollChannel {
  constructor({ path, intervalMs = 30 * 1000, id = 'work.worker-runs' }) {
    super({ id, class: ChannelClass.WORK, intervalMs });
    this.path = path;
    this._seen = new Map();
    this._primed = false;
  }

  async poll() {
    if (!existsSync(this.path)) return [];
    const lines = readFileSync(this.path, 'utf8').split('\n').filter(Boolean);
    const out = [];
    for (const line of lines) {
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      const key = record.runId;
      if (!key) continue;
      const updatedAt = record.finishedAt || record.updatedAt || record.startedAt || '';
      const stateKey = `${updatedAt}:${record.status || ''}:${record.verifierStatus || ''}`;
      if (this._seen.get(key) !== stateKey) {
        this._seen.set(key, stateKey);
        if (this._primed) out.push(record);
      }
    }
    this._primed = true;
    return out;
  }

  parse(raw) {
    return {
      payload: raw,
      sourceRef: `worker-run:${raw.runId}`,
      producedAt: raw.finishedAt || raw.updatedAt || raw.startedAt || new Date().toISOString()
    };
  }

  verify(parsed) {
    return makeObservation({
      channelId: this.id,
      sourceRef: parsed.sourceRef,
      payload: parsed.payload,
      flag: 'COLLECTED',
      confidence: parsed.payload.verifierStatus === 'pass' ? 0.95 : 0.8,
      producedAt: parsed.producedAt,
      verifierId: 'worker-runs:jsonl'
    });
  }

  crystallize(obs) {
    const tags = ['work', 'worker-run'];
    if (obs.payload.worker) tags.push(obs.payload.worker);
    if (obs.payload.status) tags.push(obs.payload.status);
    return { method: 'work_event', type: 'observation', topic: 'worker-run', tags };
  }
}
```

- [ ] **Step 4: Register engine channel**

Modify `engine/src/index.js` in the existing `if (workCfg?.enabled)` channel setup section:

```js
const { WorkerRunsChannel } = await import('./channels/work/worker-runs-channel.js');
```

Register a channel for Jerry's worker-run brain feed using the local channel bus variable name from that block. In current Home23 this is `channelBus`, so the registration should be:

```js
channelBus.register(new WorkerRunsChannel({
  path: path.join(repoRoot, 'instances', 'jerry', 'brain', 'worker-runs.jsonl'),
  intervalMs: 30 * 1000
}));
registered.push('work.worker-runs');
```

Place this next to `LiveProblemsChannel` and keep the surrounding current code intact.

- [ ] **Step 5: Run channel test**

```bash
node --test --test-concurrency=1 tests/engine/channels/work/worker-runs-channel.test.js
```

Expected: pass.

- [ ] **Step 6: Commit Task 7**

```bash
git add engine/src/channels/work/worker-runs-channel.js engine/src/index.js tests/engine/channels/work/worker-runs-channel.test.js
git commit -m "feat: observe worker run receipts"
```

## Task 8: Live Problems Dispatch To Worker

**Files:**
- Modify: `engine/src/live-problems/remediators.js`
- Modify: `engine/src/live-problems/loop.js`
- Test: `tests/engine/live-problems/dispatch-worker.test.js`

- [ ] **Step 1: Write dispatch test**

Create `tests/engine/live-problems/dispatch-worker.test.js`:

```js
'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const { RemediatorRunner } = require('../../../engine/src/live-problems/remediators.js');

test('dispatch_to_worker posts to worker connector', async () => {
  let body = '';
  const server = http.createServer((req, res) => {
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/api/workers/systems/runs');
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ runId: 'wr_1', receipt: { status: 'no_change', verifierStatus: 'pass', summary: 'checked' } }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const runner = new RemediatorRunner({
    workerConnectorBaseUrl: `http://127.0.0.1:${port}`,
    logger: { info() {}, warn() {} }
  });
  const result = await runner.dispatch_to_worker({
    problem: { id: 'lp_1', title: 'host check', severity: 'warn' },
    args: { worker: 'systems', budgetHours: 4 }
  });

  server.close();
  assert.equal(result.outcome, 'dispatched');
  assert.equal(result.turnId, 'wr_1');
  assert.match(body, /host check/);
  assert.match(body, /live-problems/);
});
```

- [ ] **Step 2: Run dispatch test to verify failure**

```bash
node --test --test-concurrency=1 tests/engine/live-problems/dispatch-worker.test.js
```

Expected: fail because `dispatch_to_worker` does not exist.

- [ ] **Step 3: Add remediator**

Modify `engine/src/live-problems/remediators.js` inside `RemediatorRunner`:

```js
  async dispatch_to_worker({ problem, args = {} }) {
    const worker = args.worker || 'systems';
    const baseUrl = this.workerConnectorBaseUrl || this.harnessBaseUrl || process.env.HOME23_WORKER_CONNECTOR_URL;
    if (!baseUrl) return { outcome: 'rejected', detail: 'worker connector url unset' };
    const prompt = [
      `Live Problem: ${problem.title || problem.id}`,
      `Problem ID: ${problem.id}`,
      `Severity: ${problem.severity || 'unknown'}`,
      '',
      problem.description || '',
      '',
      'Diagnose with evidence. If you act, use scoped Home23 operations only. Re-run the verifier or record the concrete check used.'
    ].join('\n');
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/workers/${encodeURIComponent(worker)}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt,
        requestedBy: 'live-problems',
        requester: 'engine',
        source: { type: 'live-problem', id: problem.id },
        metadata: { budgetHours: args.budgetHours || 4 }
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { outcome: 'failed', detail: data.error || `worker connector HTTP ${res.status}` };
    return { outcome: 'dispatched', turnId: data.runId, detail: data.receipt?.summary || `worker ${worker} dispatched` };
  }
```

Also initialize `workerConnectorBaseUrl` in the constructor from options.

- [ ] **Step 4: Keep Tier-3 lock semantics**

Modify `engine/src/live-problems/loop.js` where `dispatch_to_agent` is treated as a long-running dispatched operation. Include `dispatch_to_worker` in the same branch:

```js
const isTier3Dispatch = step.type === 'dispatch_to_agent' || step.type === 'dispatch_to_worker';
```

Use that boolean wherever the loop checks or advances a dispatched Tier-3 action. This keeps one active high-impact diagnostic path at a time.

- [ ] **Step 5: Run dispatch test**

```bash
node --test --test-concurrency=1 tests/engine/live-problems/dispatch-worker.test.js
```

Expected: pass.

- [ ] **Step 6: Commit Task 8**

```bash
git add engine/src/live-problems/remediators.js engine/src/live-problems/loop.js tests/engine/live-problems/dispatch-worker.test.js
git commit -m "feat: dispatch live problems to workers"
```

## Task 9: House-Agent Context Awareness

**Files:**
- Modify: `src/agent/context-assembly.ts`
- Test: `tests/agent/context-worker-runs.test.ts`

- [ ] **Step 1: Write context test**

Create `tests/agent/context-worker-runs.test.ts`:

```ts
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { buildWorkerContextSection } from '../../src/agent/context-assembly.js';

test('buildWorkerContextSection shows roster and recent receipts without transcripts', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'home23-worker-context-'));
  mkdirSync(path.join(root, 'instances', 'workers', 'systems'), { recursive: true });
  mkdirSync(path.join(root, 'instances', 'jerry', 'brain'), { recursive: true });
  writeFileSync(path.join(root, 'instances', 'workers', 'systems', 'worker.yaml'), [
    'kind: worker',
    'name: systems',
    'displayName: Systems',
    'ownerAgent: jerry',
    'class: ops',
    'purpose: Diagnose host issues.'
  ].join('\n'));
  writeFileSync(path.join(root, 'instances', 'jerry', 'brain', 'worker-runs.jsonl'), JSON.stringify({
    runId: 'wr_1',
    worker: 'systems',
    status: 'no_change',
    verifierStatus: 'pass',
    summary: 'Checked host signal.',
    transcriptIncluded: false
  }) + '\n');

  const section = buildWorkerContextSection(root, 'jerry');
  assert.match(section, /systems/);
  assert.match(section, /Checked host signal/);
  assert.doesNotMatch(section, /transcript.md/);
});
```

- [ ] **Step 2: Run context test to verify failure**

```bash
node --import tsx --test --test-concurrency=1 tests/agent/context-worker-runs.test.ts
```

Expected: fail because `buildWorkerContextSection` does not exist.

- [ ] **Step 3: Add context helper and wire it into assembly**

Modify `src/agent/context-assembly.ts`:

```ts
export function buildWorkerContextSection(projectRoot: string, agentName: string): string {
  const workersDir = join(projectRoot, 'instances', 'workers');
  const workers = existsSync(workersDir)
    ? readdirSync(workersDir, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => {
          const filePath = join(workersDir, entry.name, 'worker.yaml');
          if (!existsSync(filePath)) return null;
          const text = readFileSync(filePath, 'utf8');
          return {
            name: entry.name,
            ownerAgent: text.match(/^ownerAgent:\s*(.+)$/m)?.[1]?.trim() || 'jerry',
            class: text.match(/^class:\s*(.+)$/m)?.[1]?.trim() || 'worker',
            purpose: text.match(/^purpose:\s*(.+)$/m)?.[1]?.trim() || 'Reusable worker.',
            visibleTo: text.match(/^visibleTo:\s*$/m) ? [agentName] : []
          };
        })
        .filter(Boolean)
    : [];
  const visibleWorkers = workers.filter((worker: { visibleTo?: string[]; ownerAgent: string }) => {
    return worker.ownerAgent === agentName || (worker.visibleTo || []).includes(agentName);
  });
  const brainPath = join(projectRoot, 'instances', agentName, 'brain', 'worker-runs.jsonl');
  const recent = existsSync(brainPath)
    ? readFileSync(brainPath, 'utf8').split('\n').filter(Boolean).slice(-5).map((line: string) => JSON.parse(line))
    : [];

  if (visibleWorkers.length === 0 && recent.length === 0) return '';
  return [
    '## Worker Agents',
    '',
    'Available reusable workers:',
    ...visibleWorkers.map((w: { name: string; ownerAgent: string; class: string; purpose: string }) => `- ${w.name} (${w.class}, owner ${w.ownerAgent}): ${w.purpose}`),
    '',
    'Recent worker receipts:',
    ...(recent.length ? recent.map((r: { runId: string; worker: string; status: string; verifierStatus: string; summary: string }) => `- ${r.runId} ${r.worker}: ${r.status}, verifier ${r.verifierStatus}. ${r.summary}`) : ['- none'])
  ].join('\n');
}
```

Then include the returned section in the existing system-context assembly path for Jerry and Forrest. Keep it concise and do not include raw transcripts.

Also extend the existing import line at the top of `src/agent/context-assembly.ts`:

```ts
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
```

- [ ] **Step 4: Run context test**

```bash
node --import tsx --test --test-concurrency=1 tests/agent/context-worker-runs.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit Task 9**

```bash
git add src/agent/context-assembly.ts tests/agent/context-worker-runs.test.ts
git commit -m "feat: include worker receipts in agent context"
```

## Task 10: End-To-End Verification

**Files:**
- No new files.
- Verify all files touched by Tasks 1-9.

- [ ] **Step 1: Typecheck**

```bash
npm run build
```

Expected: TypeScript build exits 0.

- [ ] **Step 2: Run focused worker and tool tests**

```bash
node --import tsx --test --test-concurrency=1 \
  tests/workers/registry.test.ts \
  tests/workers/scaffold.test.ts \
  tests/workers/receipts.test.ts \
  tests/workers/runner.test.ts \
  tests/workers/connector.test.ts \
  tests/agent/tools/workers.test.ts \
  tests/agent/context-worker-runs.test.ts
```

Expected: all tests pass.

- [ ] **Step 3: Run focused engine tests**

```bash
node --test --test-concurrency=1 \
  tests/engine/channels/work/worker-runs-channel.test.js \
  tests/engine/live-problems/dispatch-worker.test.js
```

Expected: all tests pass.

- [ ] **Step 4: Run full existing test suite**

```bash
npm test
```

Expected: existing suite passes. If a pre-existing failure appears, capture the exact failing test and command output before changing code.

- [ ] **Step 5: Manual CLI smoke**

```bash
node --import tsx cli/home23.js worker list
test -f instances/workers/systems/worker.yaml
test ! -f instances/workers/systems/config.yaml
```

Expected:

- `worker list` prints `systems`.
- `worker.yaml` exists.
- No full-agent `config.yaml` exists under the worker directory.

- [ ] **Step 6: Manual connector smoke after targeted restart**

After build passes, restart only the harness process that owns the connector:

```bash
pm2 restart home23-jerry-harness
curl -s http://127.0.0.1:5004/api/workers | python3 -m json.tool
```

Expected: JSON contains the `systems` worker. If the harness bridge port differs in current config, use the configured Jerry harness port.

- [ ] **Step 7: Manual worker run smoke**

```bash
curl -s -X POST http://127.0.0.1:5004/api/workers/systems/runs \
  -H 'content-type: application/json' \
  -d '{"prompt":"Check that the Home23 dashboard state endpoint responds without changing any process.","requestedBy":"api","requester":"manual-smoke"}' \
  | python3 -m json.tool
```

Expected:

- Response includes `runId`.
- `instances/workers/systems/runs/<run-id>/receipt.json` exists.
- `instances/jerry/workspace/worker-runs/<run-id>.md` exists.
- `instances/jerry/brain/worker-runs.jsonl` has one new line for the run.

- [ ] **Step 8: Commit verification adjustments only if needed**

If verification requires a small fix:

```bash
git add <exact files changed for the fix>
git commit -m "fix: stabilize worker vertical slice"
```

If no fixes were needed, do not create an empty commit.

## Safety Checks Before Final Delivery

- [ ] `instances/workers/systems/config.yaml` does not exist.
- [ ] `ecosystem.config.cjs` was not changed by worker creation.
- [ ] No code path scans `instances/workers/*` as full agents.
- [ ] Worker runs write receipts, not raw transcripts, into owner brain feeds.
- [ ] Systems worker identity explicitly refuses global PM2 stop/delete operations.
- [ ] `dispatch_to_agent` still works.
- [ ] `dispatch_to_worker` starts with `systems` only and can expand after this slice.
- [ ] Dashboard and macOS clients can use the connector contract without reading worker folders directly.

## Follow-On Plans After This Slice

1. Dashboard and macOS worker UI against the connector endpoints.
2. Server-sent `/api/workers/events` stream with live run progress.
3. Default templates for `scheduler`, `freshness`, and `brain-guardian`.
4. Worker router with deterministic classification and router-worker fallback.
5. Good Life lane routing to workers.
6. Cron automations that call the connector when cheap checks produce actionable packets.
