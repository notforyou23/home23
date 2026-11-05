# Durable Async Work Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One durable Async Work contract covering coding jobs and sub-agents — durable records, root-origin routing, list/status/cancel endpoints, restart recovery, a real `chatId + workId` iOS push contract, and a post-completion review step — replacing today's closure-based delivery and the fake-`turnId` push.

**Architecture:** A new `src/work/` module owns `AsyncWorkRecord` (per-record JSON files under `instances/<agent>/async-work/`, atomic tmp+rename like the coding job-store). Work records are created at the tool boundary (`coding_run`/`coding_continue`/`spawn_agent`) where origin context is real, resolved to the **root** conversation via `resolveRootChatId` so nested `subagent:` chats never strand results. Completion flows through one pipeline (`src/work/completion.ts`): compact receipt into the origin conversation always; failures deliver immediately; successes on coding work run a **review turn** in an isolated `workreview:<workId>` chat whose report is what reaches the human; at most one push per work item using a new `kind: "async_work"` APNs payload carrying `chatId + workId` (never a fake turnId). A bearer-authed `/api/work` HTTP surface on the bridge port gives iOS durable list/status/receipt/cancel. Boot reconciliation marks lost sub-agents `interrupted`, re-delivers undelivered terminal receipts, and backfills orphan jobs. On iOS, the blind turn-adoption path gets a server-format turnId gate (`t_…` only), a validated `async_work` route payload, an `AsyncWorkService`, and a compact active-work strip in chat.

**Tech Stack:** TypeScript harness (node:test via tsx, Express on the 5004 bridge, APNs JWT client), Swift/SwiftUI iOS app with SPM `Home23Shared` (XCTest via `swift test`; app target verified via Xcode Cmd+B — xcodebuild CLI is broken on this Mac).

**Repos:**
- Harness: `/Users/jtr/_JTR23_/release/home23/.claude/worktrees/durable-async-work-a7972a` (branch `claude_jtr/durable-async-work-a7972a`, based on `41d48c88`)
- iOS: `/Users/jtr/xCode_Builds/Home23` (branch `main`, based on `fbc03e7`)

**Verified baseline facts (do not re-derive):**
- Server turn ids are `t_<base36>_<base36>` (`src/chat/turn-types.ts newTurnId()`); coding job ids are `cj_…`; brain ops are `brop_…`.
- `deliverCodingJobResult` (`src/acp/result-delivery.ts:75`) currently pushes `turnId: job.id` — the contract bug this plan removes.
- A coding job launched inside a sub-agent gets `requestedBy = "subagent:<parent>:<4hex>"` and delivers nowhere (`result-delivery.ts:81`, asserted intended at `tests/acp/result-delivery.test.ts:135-147` — that assertion gets flipped).
- `spawn_agent` (`src/agent/tools/subagent.ts`) has no run id, an in-memory-only tracker with a dead `queue`, delivery via captured closure, an unguarded Telegram fetch (fires for non-numeric chats), and no iOS push.
- iOS `ChatViewModel.checkpointInitialRouteIfNeeded()` (`ChatViewModel.swift:534`) adopts ANY pushed turnId into durable cache and polls it as a turn; `OpenChatRoutePayload` accepts any non-empty string as turnId.
- Bridge HTTP auth patterns: `timingSafeEqual` bearer in `src/routes/device.ts:23-34`; router-mount pattern in `src/workers/connector.ts` + `src/home.ts:1095`.
- Pre-existing worktree env failure: `tests/cosmo23/runtime-dependency-compatibility.test.cjs` + `spend-meter.test.cjs` fail on missing `node_modules/undici` (install gap, not code). Run `npm install` before the final full-suite gate.

---

## Part 1 — Harness

### Task 1: Work record types + root-origin resolution

**Files:**
- Create: `src/work/types.ts`
- Test: `tests/work/types.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/work/types.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveRootChatId,
  newWorkId,
  isHumanOrigin,
  TERMINAL_WORK_STATUSES,
} from '../../src/work/types.ts';

test('resolveRootChatId returns non-subagent ids unchanged', () => {
  assert.equal(resolveRootChatId('ios_3d1c6ad844c1_jerry_tj_67482f5e'), 'ios_3d1c6ad844c1_jerry_tj_67482f5e');
  assert.equal(resolveRootChatId('123456789'), '123456789');
  assert.equal(resolveRootChatId('cron-agent-daily'), 'cron-agent-daily');
});

test('resolveRootChatId unwraps one subagent layer', () => {
  assert.equal(resolveRootChatId('subagent:ios_abc_jerry_x_ff00:ab12'), 'ios_abc_jerry_x_ff00');
  assert.equal(resolveRootChatId('subagent:123456789:ab12'), '123456789');
});

test('resolveRootChatId unwraps nested subagent layers', () => {
  assert.equal(resolveRootChatId('subagent:subagent:123456789:ab12:cd34'), '123456789');
});

test('resolveRootChatId leaves malformed subagent ids alone', () => {
  assert.equal(resolveRootChatId('subagent:'), 'subagent:');
  assert.equal(resolveRootChatId('subagent:x'), 'subagent:x');
});

test('newWorkId shape', () => {
  const id = newWorkId();
  assert.match(id, /^aw_[a-z0-9]+_[0-9a-f]{4}$/);
  assert.notEqual(newWorkId(), id);
});

test('isHumanOrigin', () => {
  assert.equal(isHumanOrigin('123456789'), true);       // Telegram
  assert.equal(isHumanOrigin('-100987'), true);          // Telegram group
  assert.equal(isHumanOrigin('ios_abc_jerry_x_ff'), true);
  assert.equal(isHumanOrigin('mac_abc_jerry_x_ff'), true);
  assert.equal(isHumanOrigin('cron-agent-daily'), false);
  assert.equal(isHumanOrigin('subagent:123:ab12'), false);
  assert.equal(isHumanOrigin('worker:shakedown'), false);
});

test('terminal statuses', () => {
  for (const s of ['completed', 'failed', 'cancelled', 'interrupted']) {
    assert.equal(TERMINAL_WORK_STATUSES.has(s as never), true);
  }
  for (const s of ['queued', 'running', 'blocked']) {
    assert.equal(TERMINAL_WORK_STATUSES.has(s as never), false);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test tests/work/types.test.ts`
Expected: FAIL — cannot find module `src/work/types.ts`

- [ ] **Step 3: Write the implementation**

```ts
// src/work/types.ts
/**
 * Async Work contract (Step 31).
 *
 * One durable record shape for detached work — coding jobs and sub-agents in
 * this first slice. The record is the routing authority: originChatId is
 * always the ROOT human/channel conversation (never a `subagent:` chat), so
 * completion delivery can never strand a result in a hidden sub-chat.
 */
import { randomBytes } from 'node:crypto';

export type AsyncWorkKind = 'coding' | 'subagent';

export type AsyncWorkStatus =
  | 'queued' | 'running' | 'blocked'
  | 'completed' | 'failed' | 'cancelled' | 'interrupted';

export const TERMINAL_WORK_STATUSES: ReadonlySet<AsyncWorkStatus> =
  new Set(['completed', 'failed', 'cancelled', 'interrupted']);

/**
 * Honest values only (anti-theater): the harness can attest that a review
 * happened, not that the work is "correct". 'reviewed' means the review turn
 * ran and its report was delivered; 'skipped' means review was configured but
 * could not run (busy origin, review turn error); 'none' means review was not
 * applicable (failures, review disabled for the kind, non-human origin).
 */
export type VerificationStatus = 'none' | 'pending' | 'reviewed' | 'skipped';

export type WorkResultHandle =
  | { type: 'coding_job'; jobId: string }
  | { type: 'subagent_chat'; chatId: string };

export interface AsyncWorkRecord {
  schema: 'home23.async-work.v1';
  workId: string;                 // aw_<base36 ts>_<4hex>
  kind: AsyncWorkKind;
  agent: string;                  // HOME23_AGENT owning this record
  originChatId: string;           // ROOT conversation (resolveRootChatId applied)
  originTurnId?: string;          // turn that launched the work, when known
  parentWorkId?: string;          // set when launched from inside another work item
  label: string;
  status: AsyncWorkStatus;
  startedAt: string;              // ISO
  updatedAt: string;              // ISO
  finishedAt?: string;            // ISO
  progressSummary?: string;
  resultHandle: WorkResultHandle;
  verification: VerificationStatus;
  /** Set once the receipt/report reached the origin conversation. Recovery re-delivers when absent. */
  deliveredAt?: string;
  error?: string;
}

export function newWorkId(): string {
  return `aw_${Date.now().toString(36)}_${randomBytes(2).toString('hex')}`;
}

const SUBAGENT_CHAT_RE = /^subagent:(.*):[0-9a-f]{4}$/;

/** Unwrap `subagent:<parent>:<hex>` layers (bounded) to the root conversation id. */
export function resolveRootChatId(chatId: string): string {
  let current = chatId;
  for (let i = 0; i < 10; i++) {
    const m = SUBAGENT_CHAT_RE.exec(current);
    if (!m) return current;
    current = m[1];
  }
  return current;
}

/** Origins a human actually reads: Telegram numeric chats and iOS/Mac app conversations. */
export function isHumanOrigin(chatId: string): boolean {
  return /^-?\d+$/.test(chatId) || chatId.startsWith('ios_') || chatId.startsWith('mac_');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test tests/work/types.test.ts`
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add src/work/types.ts tests/work/types.test.ts
git commit -m "feat(work): async-work record types + root-origin resolution"
```

---

### Task 2: Durable work store

**Files:**
- Create: `src/work/work-store.ts`
- Test: `tests/work/work-store.test.ts`

Mirror `src/acp/job-store.ts` (atomic tmp+rename, corrupt-skip on list). One JSON file per record: `<workDir>/<workId>.json`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/work/work-store.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkStore } from '../../src/work/work-store.ts';
import type { AsyncWorkRecord } from '../../src/work/types.ts';

function makeRecord(overrides: Partial<AsyncWorkRecord> = {}): AsyncWorkRecord {
  return {
    schema: 'home23.async-work.v1',
    workId: 'aw_t1_ab12',
    kind: 'coding',
    agent: 'jerry',
    originChatId: 'ios_abc_jerry_x_ff',
    label: 'fix the thing',
    status: 'running',
    startedAt: '2026-08-06T12:00:00.000Z',
    updatedAt: '2026-08-06T12:00:00.000Z',
    resultHandle: { type: 'coding_job', jobId: 'cj_x_1111' },
    verification: 'none',
    ...overrides,
  };
}

test('write/read/list round-trip, newest first, corrupt skipped', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'work-store-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new WorkStore(dir);

  store.write(makeRecord({ workId: 'aw_t1_aaaa', startedAt: '2026-08-06T10:00:00.000Z' }));
  store.write(makeRecord({ workId: 'aw_t2_bbbb', startedAt: '2026-08-06T11:00:00.000Z' }));
  writeFileSync(join(dir, 'aw_bad_cccc.json'), '{nope');

  assert.equal(store.read('aw_t1_aaaa')?.workId, 'aw_t1_aaaa');
  assert.equal(store.read('aw_missing_dddd'), undefined);

  const listed = store.list();
  assert.deepEqual(listed.map(r => r.workId), ['aw_t2_bbbb', 'aw_t1_aaaa']);
});

test('update patches and bumps updatedAt', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'work-store-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new WorkStore(dir);
  store.write(makeRecord());
  const updated = store.update('aw_t1_ab12', { status: 'completed', finishedAt: '2026-08-06T12:05:00.000Z' });
  assert.equal(updated?.status, 'completed');
  assert.notEqual(updated?.updatedAt, '2026-08-06T12:00:00.000Z');
  assert.equal(store.read('aw_t1_ab12')?.status, 'completed');
  assert.equal(store.update('aw_missing_x', { status: 'failed' }), undefined);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test tests/work/work-store.test.ts`
Expected: FAIL — cannot find module `src/work/work-store.ts`

- [ ] **Step 3: Write the implementation**

```ts
// src/work/work-store.ts
/**
 * Durable per-record store for async work. One JSON file per record under
 * instances/<agent>/async-work/. Same durability idiom as src/acp/job-store.ts:
 * atomic tmp+rename writes, corrupt records skipped (with a warning) on list.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AsyncWorkRecord } from './types.js';

export class WorkStore {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  recordPath(workId: string): string {
    return join(this.dir, `${workId}.json`);
  }

  write(record: AsyncWorkRecord): void {
    const path = this.recordPath(record.workId);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(record, null, 2));
    try {
      renameSync(tmp, path);
    } catch (err) {
      try { unlinkSync(tmp); } catch { /* best effort */ }
      throw err;
    }
  }

  read(workId: string): AsyncWorkRecord | undefined {
    const path = this.recordPath(workId);
    if (!existsSync(path)) return undefined;
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as AsyncWorkRecord;
    } catch {
      console.warn(`[work] corrupt record skipped: ${path}`);
      return undefined;
    }
  }

  update(workId: string, patch: Partial<AsyncWorkRecord>): AsyncWorkRecord | undefined {
    const current = this.read(workId);
    if (!current) return undefined;
    const next: AsyncWorkRecord = { ...current, ...patch, updatedAt: new Date().toISOString() };
    this.write(next);
    return next;
  }

  /** All records, newest startedAt first. Corrupt files are skipped. */
  list(): AsyncWorkRecord[] {
    const out: AsyncWorkRecord[] = [];
    for (const name of readdirSync(this.dir)) {
      if (!name.startsWith('aw_') || !name.endsWith('.json')) continue;
      const rec = this.read(name.slice(0, -'.json'.length));
      if (rec) out.push(rec);
    }
    return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.workId.localeCompare(a.workId));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test tests/work/work-store.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/work/work-store.ts tests/work/work-store.test.ts
git commit -m "feat(work): durable per-record work store (atomic writes)"
```

---

### Task 3: Work registry

**Files:**
- Create: `src/work/registry.ts`
- Test: `tests/work/registry.test.ts`

The registry is the lifecycle authority: create at tool boundary, terminal transition exactly once, throttled progress, cancel-intent tracking, boot reconciliation. It is deliberately free of delivery/IO deps beyond the store.

- [ ] **Step 1: Write the failing test**

```ts
// tests/work/registry.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkStore } from '../../src/work/work-store.ts';
import { WorkRegistry } from '../../src/work/registry.ts';

function makeRegistry(t: { after(fn: () => void): void }): WorkRegistry {
  const dir = mkdtempSync(join(tmpdir(), 'work-reg-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return new WorkRegistry({ store: new WorkStore(dir), agent: 'jerry' });
}

test('create resolves root origin and returns a running record', (t) => {
  const reg = makeRegistry(t);
  const rec = reg.create({
    kind: 'coding',
    originChatId: 'subagent:ios_abc_jerry_x_ff:ab12',
    label: 'fix flaky test',
    resultHandle: { type: 'coding_job', jobId: 'cj_a_1111' },
    originTurnId: 't_x_y',
    parentWorkId: 'aw_parent_0000',
  });
  assert.match(rec.workId, /^aw_/);
  assert.equal(rec.originChatId, 'ios_abc_jerry_x_ff'); // root, not the subagent chat
  assert.equal(rec.status, 'running');
  assert.equal(rec.verification, 'none');
  assert.equal(reg.get(rec.workId)?.label, 'fix flaky test');
});

test('findByJobId and list filters', (t) => {
  const reg = makeRegistry(t);
  const a = reg.create({ kind: 'coding', originChatId: '123', label: 'a', resultHandle: { type: 'coding_job', jobId: 'cj_a_1' } });
  reg.create({ kind: 'subagent', originChatId: 'ios_x_jerry_y_z', label: 'b', resultHandle: { type: 'subagent_chat', chatId: 'subagent:ios_x_jerry_y_z:aaaa' } });
  reg.complete(a.workId, 'completed');

  assert.equal(reg.findByJobId('cj_a_1')?.workId, a.workId);
  assert.equal(reg.findByJobId('cj_nope'), undefined);
  assert.equal(reg.list({ active: true }).length, 1);
  assert.equal(reg.list({ originChatId: '123' }).length, 1);
  assert.equal(reg.list().length, 2);
});

test('complete is terminal-once and maps cancel intent', (t) => {
  const reg = makeRegistry(t);
  const rec = reg.create({ kind: 'subagent', originChatId: '123', label: 'x', resultHandle: { type: 'subagent_chat', chatId: 'subagent:123:aaaa' } });

  reg.requestCancel(rec.workId);
  const done = reg.complete(rec.workId, 'failed', 'operator_stop');
  assert.equal(done.status, 'cancelled'); // failed + cancel intent => cancelled
  assert.ok(done.finishedAt);

  const again = reg.complete(rec.workId, 'completed');
  assert.equal(again.status, 'cancelled'); // terminal-once: second transition ignored
});

test('noteProgress throttles writes', (t) => {
  const reg = makeRegistry(t);
  const rec = reg.create({ kind: 'coding', originChatId: '123', label: 'x', resultHandle: { type: 'coding_job', jobId: 'cj_p_1' } });
  reg.noteProgress(rec.workId, '3 events · tool_use Bash');
  const first = reg.get(rec.workId)!.progressSummary;
  reg.noteProgress(rec.workId, '4 events · tool_use Read'); // within throttle window
  assert.equal(reg.get(rec.workId)!.progressSummary, first);
});

test('reconcileOnBoot: subagent work interrupted, undelivered terminal coding work surfaced, orphan jobs backfilled', (t) => {
  const reg = makeRegistry(t);
  const sub = reg.create({ kind: 'subagent', originChatId: '123', label: 'lost sub', resultHandle: { type: 'subagent_chat', chatId: 'subagent:123:aaaa' } });
  const cod = reg.create({ kind: 'coding', originChatId: '123', label: 'done while down', resultHandle: { type: 'coding_job', jobId: 'cj_d_1' } });

  const result = reg.reconcileOnBoot({
    jobs: [
      { id: 'cj_d_1', status: 'completed', requestedBy: '123', label: 'done while down', startedAt: '2026-08-06T10:00:00.000Z' },
      { id: 'cj_run_2', status: 'running', requestedBy: 'subagent:ios_a_jerry_b_c:ab12', label: 'orphan running', startedAt: '2026-08-06T10:01:00.000Z' },
    ],
  });

  assert.equal(reg.get(sub.workId)!.status, 'interrupted');
  assert.equal(reg.get(cod.workId)!.status, 'completed');
  // both need delivery: the interrupted subagent and the finished-while-down coding work
  assert.deepEqual(result.needsDelivery.map(w => w.workId).sort(), [cod.workId, sub.workId].sort());
  // the orphan running job got a backfilled record with root origin
  const backfilled = reg.findByJobId('cj_run_2');
  assert.ok(backfilled);
  assert.equal(backfilled!.originChatId, 'ios_a_jerry_b_c');
  assert.equal(backfilled!.status, 'running');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test tests/work/registry.test.ts`
Expected: FAIL — cannot find module `src/work/registry.ts`

- [ ] **Step 3: Write the implementation**

```ts
// src/work/registry.ts
/**
 * WorkRegistry — lifecycle authority for async work records.
 *
 * Records are created at the tool boundary (coding_run/coding_continue/
 * spawn_agent) where origin context is real. Terminal transitions happen
 * exactly once. Delivery is NOT this module's job — home.ts wires terminal
 * records into the completion pipeline and marks deliveredAt there.
 */
import {
  TERMINAL_WORK_STATUSES,
  newWorkId,
  resolveRootChatId,
  type AsyncWorkKind,
  type AsyncWorkRecord,
  type AsyncWorkStatus,
  type WorkResultHandle,
} from './types.js';
import type { WorkStore } from './work-store.js';

const PROGRESS_THROTTLE_MS = 15_000;

export interface CreateWorkInput {
  kind: AsyncWorkKind;
  /** May be a `subagent:` chat — resolved to root here. */
  originChatId: string;
  originTurnId?: string;
  parentWorkId?: string;
  label: string;
  resultHandle: WorkResultHandle;
}

/** Minimal view of a coding job for boot reconciliation (avoids acp type import cycle). */
export interface ReconcileJobView {
  id: string;
  status: string; // starting | running | completed | failed | cancelled | interrupted
  requestedBy?: string;
  label?: string;
  startedAt: string;
}

export interface ReconcileResult {
  /** Terminal records whose receipt never reached the origin (deliver now). */
  needsDelivery: AsyncWorkRecord[];
  interrupted: AsyncWorkRecord[];
  backfilled: AsyncWorkRecord[];
}

const CODING_TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted']);

export class WorkRegistry {
  private readonly store: WorkStore;
  private readonly agent: string;
  private readonly cancelRequested = new Set<string>();
  private readonly lastProgressAt = new Map<string, number>();

  constructor(deps: { store: WorkStore; agent: string }) {
    this.store = deps.store;
    this.agent = deps.agent;
  }

  create(input: CreateWorkInput): AsyncWorkRecord {
    const now = new Date().toISOString();
    const record: AsyncWorkRecord = {
      schema: 'home23.async-work.v1',
      workId: newWorkId(),
      kind: input.kind,
      agent: this.agent,
      originChatId: resolveRootChatId(input.originChatId),
      originTurnId: input.originTurnId,
      parentWorkId: input.parentWorkId,
      label: input.label,
      status: 'running',
      startedAt: now,
      updatedAt: now,
      resultHandle: input.resultHandle,
      verification: 'none',
    };
    this.store.write(record);
    return record;
  }

  get(workId: string): AsyncWorkRecord | undefined {
    return this.store.read(workId);
  }

  list(filter: { originChatId?: string; active?: boolean; limit?: number } = {}): AsyncWorkRecord[] {
    let records = this.store.list();
    if (filter.originChatId) records = records.filter(r => r.originChatId === filter.originChatId);
    if (filter.active) records = records.filter(r => !TERMINAL_WORK_STATUSES.has(r.status));
    if (filter.limit && filter.limit > 0) records = records.slice(0, filter.limit);
    return records;
  }

  findByJobId(jobId: string): AsyncWorkRecord | undefined {
    return this.store.list().find(r => r.resultHandle.type === 'coding_job' && r.resultHandle.jobId === jobId);
  }

  update(workId: string, patch: Partial<AsyncWorkRecord>): AsyncWorkRecord | undefined {
    return this.store.update(workId, patch);
  }

  /** Record operator cancel intent so a kill that lands as 'failed' reports 'cancelled'. */
  requestCancel(workId: string): void {
    this.cancelRequested.add(workId);
  }

  /**
   * Terminal transition, exactly once. A second call returns the record
   * unchanged — recovery and live listeners can race safely.
   */
  complete(workId: string, status: AsyncWorkStatus, error?: string): AsyncWorkRecord {
    const current = this.store.read(workId);
    if (!current) throw new Error(`unknown work id: ${workId}`);
    if (TERMINAL_WORK_STATUSES.has(current.status)) return current;
    const mapped: AsyncWorkStatus =
      status === 'failed' && this.cancelRequested.has(workId) ? 'cancelled' : status;
    this.cancelRequested.delete(workId);
    return this.store.update(workId, {
      status: mapped,
      finishedAt: new Date().toISOString(),
      ...(error ? { error } : {}),
    })!;
  }

  /** Throttled progress note (disk write at most every 15s per work item). */
  noteProgress(workId: string, summary: string): void {
    const now = Date.now();
    const last = this.lastProgressAt.get(workId) ?? 0;
    if (now - last < PROGRESS_THROTTLE_MS) return;
    const current = this.store.read(workId);
    if (!current || TERMINAL_WORK_STATUSES.has(current.status)) return;
    this.lastProgressAt.set(workId, now);
    this.store.update(workId, { progressSummary: summary });
  }

  /**
   * Boot reconciliation, run after bridge.recover():
   * - non-terminal subagent work → interrupted (the in-process promise is gone)
   * - non-terminal coding work → sync with the job store (finished while the
   *   harness was down → terminal now; still running → leave running)
   * - terminal work never delivered → surface for delivery
   * - running jobs with no work record → backfill (root-resolved origin)
   */
  reconcileOnBoot(input: { jobs: ReconcileJobView[] }): ReconcileResult {
    const jobsById = new Map(input.jobs.map(j => [j.id, j]));
    const interrupted: AsyncWorkRecord[] = [];
    const backfilled: AsyncWorkRecord[] = [];

    for (const rec of this.store.list()) {
      if (TERMINAL_WORK_STATUSES.has(rec.status)) continue;
      if (rec.kind === 'subagent') {
        interrupted.push(this.complete(rec.workId, 'interrupted', 'harness restarted while sub-agent was running'));
        continue;
      }
      const jobId = rec.resultHandle.type === 'coding_job' ? rec.resultHandle.jobId : null;
      const job = jobId ? jobsById.get(jobId) : undefined;
      if (!job) {
        interrupted.push(this.complete(rec.workId, 'interrupted', 'coding job record missing after restart'));
        continue;
      }
      if (CODING_TERMINAL.has(job.status)) {
        this.complete(rec.workId, job.status as AsyncWorkStatus);
      }
      // else: still running (bridge resumed its tailer) — leave as-is
    }

    for (const job of input.jobs) {
      if (CODING_TERMINAL.has(job.status)) continue;
      if (this.findByJobId(job.id)) continue;
      backfilled.push(this.create({
        kind: 'coding',
        originChatId: job.requestedBy ?? 'unknown',
        label: job.label ?? job.id,
        resultHandle: { type: 'coding_job', jobId: job.id },
      }));
    }

    const needsDelivery = this.store.list().filter(
      r => TERMINAL_WORK_STATUSES.has(r.status) && !r.deliveredAt,
    );
    return { needsDelivery, interrupted, backfilled };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test tests/work/registry.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/work/registry.ts tests/work/registry.test.ts
git commit -m "feat(work): WorkRegistry lifecycle authority with boot reconciliation"
```

---

### Task 4: Receipt delivery routing (replaces `src/acp/result-delivery.ts`)

**Files:**
- Create: `src/work/receipt-delivery.ts`
- Create: `tests/work/receipt-delivery.test.ts`
- Delete (in Task 9, after home.ts rewires): `src/acp/result-delivery.ts`, `tests/acp/result-delivery.test.ts`

Pure routing on the work record's root origin. The push sink carries `workId` — **no turnId field exists in the sink signature**, making the old bug unrepresentable.

- [ ] **Step 1: Write the failing test**

```ts
// tests/work/receipt-delivery.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { deliverWorkReceipt, workPushBody, type ReceiptSinks } from '../../src/work/receipt-delivery.ts';
import type { AsyncWorkRecord } from '../../src/work/types.ts';

const SECRET_TAIL = 'API_KEY=sk-secret-123 private diff content that must never hit the lock screen';

function makeWork(overrides: Partial<AsyncWorkRecord> = {}): AsyncWorkRecord {
  return {
    schema: 'home23.async-work.v1',
    workId: 'aw_t_ab12',
    kind: 'coding',
    agent: 'jerry',
    originChatId: 'ios_conv_42',
    label: 'scheduler fix',
    status: 'completed',
    startedAt: '2026-08-06T12:00:00.000Z',
    updatedAt: '2026-08-06T12:05:00.000Z',
    resultHandle: { type: 'coding_job', jobId: 'cj_x_1111' },
    verification: 'none',
    ...overrides,
  };
}

function capture() {
  const calls: { history: Array<{ chatId: string; text: string }>; telegram: Array<{ chatId: string; text: string }>; push: Array<{ chatId: string; workId: string; status: string; body: string }> } =
    { history: [], telegram: [], push: [] };
  const sinks: ReceiptSinks = {
    appendHistory: (chatId, text) => calls.history.push({ chatId, text }),
    sendTelegram: (chatId, text) => calls.telegram.push({ chatId, text }),
    pushWork: (input) => calls.push.push(input),
  };
  return { calls, sinks };
}

test('ios origin: history + one async_work push carrying workId, tail never on lock screen', () => {
  const { calls, sinks } = capture();
  const route = deliverWorkReceipt(makeWork(), `[Async work completed] scheduler fix\n${SECRET_TAIL}`, sinks);
  assert.equal(route, 'ios');
  assert.equal(calls.history.length, 1);
  assert.equal(calls.history[0].chatId, 'ios_conv_42');
  assert.equal(calls.push.length, 1);
  assert.equal(calls.push[0].workId, 'aw_t_ab12');
  assert.equal(calls.push[0].chatId, 'ios_conv_42');
  assert.ok(!calls.push[0].body.includes('sk-secret-123'));
  assert.equal(calls.telegram.length, 0);
});

test('mac origin routes like ios', () => {
  const { calls, sinks } = capture();
  const route = deliverWorkReceipt(makeWork({ originChatId: 'mac_dev_jerry_a_b' }), 'text', sinks);
  assert.equal(route, 'ios');
  assert.equal(calls.push[0].chatId, 'mac_dev_jerry_a_b');
});

test('numeric origin: history + telegram, no push', () => {
  const { calls, sinks } = capture();
  const route = deliverWorkReceipt(makeWork({ originChatId: '-100123' }), 'full text', sinks);
  assert.equal(route, 'telegram');
  assert.equal(calls.telegram.length, 1);
  assert.equal(calls.push.length, 0);
});

test('other origins (cron, worker) are history-only', () => {
  const { calls, sinks } = capture();
  const route = deliverWorkReceipt(makeWork({ originChatId: 'cron-agent-daily' }), 'text', sinks);
  assert.equal(route, 'none');
  assert.equal(calls.history.length, 1);
  assert.equal(calls.telegram.length, 0);
  assert.equal(calls.push.length, 0);
});

test('missing sinks degrade to history-only without throwing', () => {
  const history: string[] = [];
  const route = deliverWorkReceipt(makeWork(), 'text', { appendHistory: (_c, t) => history.push(t) });
  assert.equal(route, 'none');
  assert.equal(history.length, 1);
});

test('push body is a concise status line per status', () => {
  assert.equal(workPushBody(makeWork()), 'Work finished: scheduler fix');
  assert.equal(workPushBody(makeWork({ status: 'failed' })), 'Work failed: scheduler fix');
  assert.equal(workPushBody(makeWork({ status: 'interrupted', label: '' })), 'Work interrupted.');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test tests/work/receipt-delivery.test.ts`
Expected: FAIL — cannot find module

- [ ] **Step 3: Write the implementation**

```ts
// src/work/receipt-delivery.ts
/**
 * Receipt routing for terminal async work (supersedes src/acp/result-delivery.ts).
 *
 * Routes on the record's ROOT origin conversation:
 *   numeric      → Telegram (full text)
 *   ios_ / mac_  → APNs async_work push (concise line; chatId + workId, never a turnId)
 *   anything else→ history only
 * The full receipt text always lands in the origin conversation's history.
 * Branches are mutually exclusive — at most one push per work item. Missing
 * sinks degrade to history-only; nothing here throws.
 */
import type { AsyncWorkRecord } from './types.js';

export type WorkDeliveryRoute = 'none' | 'telegram' | 'ios';

export interface ReceiptSinks {
  /** Append the full receipt/report to the origin conversation. Always called. */
  appendHistory: (chatId: string, text: string) => void;
  /** Present only when a bot token is configured. */
  sendTelegram?: (chatId: string, text: string) => void;
  /** Present only when an APNs pusher is installed. Carries workId — no turnId exists here. */
  pushWork?: (input: { chatId: string; workId: string; status: string; body: string }) => void;
}

/** Concise lock-screen line — label + status only, never receipt content. */
export function workPushBody(work: AsyncWorkRecord): string {
  const label = work.label?.trim();
  if (work.status === 'completed') return label ? `Work finished: ${label}` : 'Work finished.';
  return label ? `Work ${work.status}: ${label}` : `Work ${work.status}.`;
}

export function deliverWorkReceipt(
  work: AsyncWorkRecord,
  fullText: string,
  sinks: ReceiptSinks,
): WorkDeliveryRoute {
  sinks.appendHistory(work.originChatId, fullText);

  if (/^-?\d+$/.test(work.originChatId)) {
    if (sinks.sendTelegram) {
      sinks.sendTelegram(work.originChatId, fullText.slice(0, 4096));
      return 'telegram';
    }
    return 'none';
  }

  if (work.originChatId.startsWith('ios_') || work.originChatId.startsWith('mac_')) {
    if (sinks.pushWork) {
      sinks.pushWork({ chatId: work.originChatId, workId: work.workId, status: work.status, body: workPushBody(work) });
      return 'ios';
    }
    return 'none';
  }

  return 'none';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test tests/work/receipt-delivery.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/work/receipt-delivery.ts tests/work/receipt-delivery.test.ts
git commit -m "feat(work): root-origin receipt routing with async_work push sink"
```

---

### Task 5: APNs `async_work` payload

**Files:**
- Modify: `src/push/types.ts` (after `ChatPushPayload`, ~line 73)
- Modify: `src/push/apns-pusher.ts` (after `notifyTurnComplete`, ~line 119)
- Test: `tests/work/push-payload.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/work/push-payload.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAsyncWorkPayload } from '../../src/push/types.ts';

test('async_work payload carries chatId + workId and no turnId key', () => {
  const p = buildAsyncWorkPayload({
    agentName: 'jerry',
    chatId: 'ios_conv_42',
    workId: 'aw_t_ab12',
    status: 'completed',
    body: 'Work finished: scheduler fix',
  });
  assert.equal(p.kind, 'async_work');
  assert.equal(p.chatId, 'ios_conv_42');
  assert.equal(p.workId, 'aw_t_ab12');
  assert.equal(p.status, 'completed');
  assert.equal(p.aps.alert.title, 'jerry');
  assert.equal(p.aps.alert.body, 'Work finished: scheduler fix');
  assert.ok(!('turnId' in p));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test tests/work/push-payload.test.ts`
Expected: FAIL — `buildAsyncWorkPayload` is not exported

- [ ] **Step 3: Write the implementation**

In `src/push/types.ts`, after the `ChatPushPayload` interface:

```ts
/** Terminal async-work notification. `kind` discriminates from legacy chat pushes. */
export interface AsyncWorkPushPayload {
  aps: {
    alert: { title: string; body: string };
    'mutable-content': 1;
    sound: 'default';
  };
  kind: 'async_work';
  chatId: string;   // origin conversation to open on tap
  workId: string;   // work receipt to surface
  status: string;   // terminal AsyncWorkStatus
  agent: string;
}

export function buildAsyncWorkPayload(input: {
  agentName: string;
  chatId: string;
  workId: string;
  status: string;
  body: string;
}): AsyncWorkPushPayload {
  return {
    aps: {
      alert: { title: input.agentName, body: input.body },
      'mutable-content': 1,
      sound: 'default',
    },
    kind: 'async_work',
    chatId: input.chatId,
    workId: input.workId,
    status: input.status,
    agent: input.agentName,
  };
}
```

Update the `PushPayload` union in the same file (find `export type PushPayload =` and add `| AsyncWorkPushPayload`).

In `src/push/apns-pusher.ts`, after `notifyTurnComplete` (import `buildAsyncWorkPayload` from `./types.js`):

```ts
  /**
   * Fire pushes for terminal async work (coding jobs, sub-agents). Same
   * device-lookup/410-invalidation semantics as notifyTurnComplete, but the
   * payload carries chatId + workId — never a turnId.
   */
  async notifyAsyncWork(opts: { chatId: string; workId: string; status: string; body: string }): Promise<void> {
    const devices = this.registry.lookupByChatId(opts.chatId);
    if (devices.length === 0) return;
    if (!opts.body.trim()) return;

    const payload = buildAsyncWorkPayload({
      agentName: this.agentName,
      chatId: opts.chatId,
      workId: opts.workId,
      status: opts.status,
      body: this.preview(opts.body),
    });

    await Promise.allSettled(devices.map(async (dev) => {
      try {
        const result = await this.client.send(dev.device_token, payload, dev.env);
        if (result.status === 410) {
          console.log(`[push] ${this.agentName}: device ${dev.device_token.slice(0, 8)}… gone (410), invalidating`);
          this.registry.invalidate(dev.device_token, dev.bundle_id);
        } else if (result.status >= 400) {
          console.warn(`[push] ${this.agentName}: ${result.status} ${result.reason ?? ''} for ${dev.device_token.slice(0, 8)}…`);
        }
      } catch (err) {
        console.warn(`[push] ${this.agentName}: send failed for ${dev.device_token.slice(0, 8)}…:`, err instanceof Error ? err.message : err);
      }
    }));
  }
```

- [ ] **Step 4: Run test + typecheck**

Run: `node --import tsx --test tests/work/push-payload.test.ts && npm run build`
Expected: PASS; tsc clean

- [ ] **Step 5: Commit**

```bash
git add src/push/types.ts src/push/apns-pusher.ts tests/work/push-payload.test.ts
git commit -m "feat(push): async_work APNs payload (chatId + workId, no turnId)"
```

---

### Task 6: Completion pipeline with review turn

**Files:**
- Create: `src/work/completion.ts`
- Test: `tests/work/completion.test.ts`

Behavior contract (from the spec):
- **Failure interrupts immediately:** failed/cancelled/interrupted → deliver compact receipt now, one push, `verification: 'none'`.
- **Success reports once:** completed coding work with a human origin and review enabled → append compact receipt (evidence, no push), run a review turn in an isolated `workreview:<workId>` chat, deliver Jerry's report with the single push; `verification: 'reviewed'`. Review not possible (origin busy past timeout, review turn throws) → deliver compact receipt with the push, `verification: 'skipped'`.
- Sub-agent successes and non-human origins deliver directly (`verification: 'none'`); review for subagents is config-off by default.
- `deliveredAt` set exactly once at the end; records already delivered are skipped (recovery-safe).

- [ ] **Step 1: Write the failing test**

```ts
// tests/work/completion.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkStore } from '../../src/work/work-store.ts';
import { WorkRegistry } from '../../src/work/registry.ts';
import { handleWorkCompletion, reviewPrompt, type CompletionDeps } from '../../src/work/completion.ts';
import { type ReceiptSinks } from '../../src/work/receipt-delivery.ts';

function setup(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'work-comp-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const registry = new WorkRegistry({ store: new WorkStore(dir), agent: 'jerry' });
  const calls = { history: [] as Array<{ chatId: string; text: string }>, push: [] as Array<{ chatId: string; workId: string }>, telegram: [] as string[], reviews: [] as Array<{ chatId: string; prompt: string }> };
  const sinks: ReceiptSinks = {
    appendHistory: (chatId, text) => calls.history.push({ chatId, text }),
    sendTelegram: (chatId, _text) => calls.telegram.push(chatId),
    pushWork: (i) => calls.push.push({ chatId: i.chatId, workId: i.workId }),
  };
  const deps: CompletionDeps = {
    registry,
    sinks,
    review: { coding: true, subagent: false },
    isChatBusy: () => false,
    waitForIdleMs: 50,
    idlePollMs: 10,
    runReviewTurn: async (chatId, prompt) => {
      calls.reviews.push({ chatId, prompt });
      return 'Report: diff verified, tests green, work lives in cj_x_1111. Nothing remains.';
    },
  };
  return { registry, calls, deps };
}

test('failure delivers immediately with one push, verification none', async (t) => {
  const { registry, calls, deps } = setup(t);
  const rec = registry.create({ kind: 'coding', originChatId: 'ios_conv_42', label: 'x', resultHandle: { type: 'coding_job', jobId: 'cj_f_1' } });
  const done = registry.complete(rec.workId, 'failed', 'exit 1');
  await handleWorkCompletion(done, 'receipt: it failed', deps);
  assert.equal(calls.reviews.length, 0);
  assert.equal(calls.push.length, 1);
  assert.equal(calls.history.length, 1);
  const final = registry.get(rec.workId)!;
  assert.equal(final.verification, 'none');
  assert.ok(final.deliveredAt);
});

test('coding success with human origin: evidence receipt (no push) then reviewed report (one push)', async (t) => {
  const { registry, calls, deps } = setup(t);
  const rec = registry.create({ kind: 'coding', originChatId: 'ios_conv_42', label: 'sched fix', resultHandle: { type: 'coding_job', jobId: 'cj_s_1' } });
  const done = registry.complete(rec.workId, 'completed');
  await handleWorkCompletion(done, 'receipt: evidence tail', deps);

  assert.equal(calls.reviews.length, 1);
  assert.equal(calls.reviews[0].chatId, `workreview:${rec.workId}`);
  assert.equal(calls.history.length, 2); // evidence receipt + report, both to origin
  assert.ok(calls.history.every(h => h.chatId === 'ios_conv_42'));
  assert.equal(calls.push.length, 1);   // exactly one push, after review
  assert.equal(registry.get(rec.workId)!.verification, 'reviewed');
});

test('review skipped when origin stays busy; receipt still delivered with push', async (t) => {
  const { registry, calls, deps } = setup(t);
  deps.isChatBusy = () => true;
  const rec = registry.create({ kind: 'coding', originChatId: '12345', label: 'x', resultHandle: { type: 'coding_job', jobId: 'cj_b_1' } });
  const done = registry.complete(rec.workId, 'completed');
  await handleWorkCompletion(done, 'receipt', deps);
  assert.equal(calls.reviews.length, 0);
  assert.equal(calls.telegram.length, 1);
  assert.equal(registry.get(rec.workId)!.verification, 'skipped');
});

test('review turn throwing falls back to direct receipt, verification skipped', async (t) => {
  const { registry, calls, deps } = setup(t);
  deps.runReviewTurn = async () => { throw new Error('provider down'); };
  const rec = registry.create({ kind: 'coding', originChatId: 'ios_conv_42', label: 'x', resultHandle: { type: 'coding_job', jobId: 'cj_e_1' } });
  const done = registry.complete(rec.workId, 'completed');
  await handleWorkCompletion(done, 'receipt', deps);
  assert.equal(calls.push.length, 1);
  assert.equal(registry.get(rec.workId)!.verification, 'skipped');
});

test('subagent success delivers directly (review off by default)', async (t) => {
  const { registry, calls, deps } = setup(t);
  const rec = registry.create({ kind: 'subagent', originChatId: 'ios_conv_42', label: 'sub', resultHandle: { type: 'subagent_chat', chatId: 'subagent:ios_conv_42:aaaa' } });
  const done = registry.complete(rec.workId, 'completed');
  await handleWorkCompletion(done, 'sub result text', deps);
  assert.equal(calls.reviews.length, 0);
  assert.equal(calls.push.length, 1);
  assert.equal(registry.get(rec.workId)!.verification, 'none');
});

test('already-delivered records are skipped (recovery dedupe)', async (t) => {
  const { registry, calls, deps } = setup(t);
  const rec = registry.create({ kind: 'subagent', originChatId: 'ios_conv_42', label: 'sub', resultHandle: { type: 'subagent_chat', chatId: 'subagent:ios_conv_42:aaaa' } });
  const done = registry.complete(rec.workId, 'completed');
  await handleWorkCompletion(done, 'text', deps);
  await handleWorkCompletion(registry.get(rec.workId)!, 'text', deps);
  assert.equal(calls.push.length, 1);
});

test('reviewPrompt includes work id, label, and evidence', () => {
  const p = reviewPrompt({ workId: 'aw_1_ab', label: 'sched fix', kind: 'coding' } as never, 'EVIDENCE');
  assert.ok(p.includes('aw_1_ab'));
  assert.ok(p.includes('sched fix'));
  assert.ok(p.includes('EVIDENCE'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test tests/work/completion.test.ts`
Expected: FAIL — cannot find module

- [ ] **Step 3: Write the implementation**

```ts
// src/work/completion.ts
/**
 * Terminal pipeline for async work — the "Jerry report-back" step.
 *
 * Raw worker output is evidence, not the agent's conclusion. On successful
 * coding work with a human origin, a review turn runs in an isolated
 * `workreview:<workId>` chat (keeping the origin transcript clean of injected
 * prompts); the review's report is what reaches the human, with the single
 * push. Failures skip review and interrupt immediately. Every path appends a
 * durable receipt to the ORIGIN conversation and stamps deliveredAt exactly
 * once, so boot recovery can re-run this for undelivered terminal records.
 */
import { isHumanOrigin, type AsyncWorkRecord } from './types.js';
import { deliverWorkReceipt, workPushBody, type ReceiptSinks } from './receipt-delivery.js';
import type { WorkRegistry } from './registry.js';

export interface CompletionDeps {
  registry: WorkRegistry;
  sinks: ReceiptSinks;
  /** Per-kind review switch. Defaults wired in home.ts: { coding: true, subagent: false }. */
  review: { coding: boolean; subagent: boolean };
  /** True while the given chat has an active run (review defers to live turns). */
  isChatBusy: (chatId: string) => boolean;
  waitForIdleMs: number;
  idlePollMs: number;
  /** Run a tracked turn in the given chat, resolving to the assistant's final text. */
  runReviewTurn: (chatId: string, prompt: string) => Promise<string>;
}

export function reviewPrompt(work: AsyncWorkRecord, evidence: string): string {
  return [
    `[async-work review] Work "${work.label}" (${work.workId}, kind: ${work.kind}) reported success.`,
    `Treat the evidence below as a claim, not a conclusion. Verify what you can cheaply`,
    `(coding_result, git diff/log in the job workspace, run a targeted check if fast), then`,
    `write the report you would send the owner: what changed, whether your verification`,
    `passed (say plainly if it did not or you could not check), where the work lives, and`,
    `what remains or needs their judgment. The report is your final message text.`,
    ``,
    `Evidence:`,
    evidence,
  ].join('\n');
}

async function waitForIdle(chatId: string, deps: CompletionDeps): Promise<boolean> {
  const deadline = Date.now() + deps.waitForIdleMs;
  while (Date.now() < deadline) {
    if (!deps.isChatBusy(chatId)) return true;
    await new Promise(resolve => setTimeout(resolve, deps.idlePollMs));
  }
  return !deps.isChatBusy(chatId);
}

/**
 * Deliver a terminal work record. `receiptText` is the compact durable receipt
 * (built by the caller from the job receipt / sub-agent result). Never throws.
 */
export async function handleWorkCompletion(
  work: AsyncWorkRecord,
  receiptText: string,
  deps: CompletionDeps,
): Promise<void> {
  try {
    const current = deps.registry.get(work.workId) ?? work;
    if (current.deliveredAt) return;

    const reviewWanted =
      current.status === 'completed' &&
      deps.review[current.kind] &&
      isHumanOrigin(current.originChatId);

    if (!reviewWanted) {
      deliverWorkReceipt(current, receiptText, deps.sinks);
      deps.registry.update(current.workId, { deliveredAt: new Date().toISOString() });
      return;
    }

    // Evidence lands durably first — no push yet; the report is the notification.
    deps.sinks.appendHistory(current.originChatId, receiptText);
    deps.registry.update(current.workId, { verification: 'pending' });

    let report: string | null = null;
    if (await waitForIdle(current.originChatId, deps)) {
      try {
        report = await deps.runReviewTurn(`workreview:${current.workId}`, reviewPrompt(current, receiptText));
      } catch (err) {
        console.warn(`[work] review turn failed for ${current.workId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (report && report.trim()) {
      deps.sinks.appendHistory(current.originChatId, report);
      if (/^-?\d+$/.test(current.originChatId)) {
        deps.sinks.sendTelegram?.(current.originChatId, report.slice(0, 4096));
      } else {
        deps.sinks.pushWork?.({
          chatId: current.originChatId,
          workId: current.workId,
          status: current.status,
          body: workPushBody(current),
        });
      }
      deps.registry.update(current.workId, { verification: 'reviewed', deliveredAt: new Date().toISOString() });
      return;
    }

    // Review could not run — the receipt itself becomes the notification.
    if (/^-?\d+$/.test(current.originChatId)) {
      deps.sinks.sendTelegram?.(current.originChatId, receiptText.slice(0, 4096));
    } else {
      deps.sinks.pushWork?.({
        chatId: current.originChatId,
        workId: current.workId,
        status: current.status,
        body: workPushBody(current),
      });
    }
    deps.registry.update(current.workId, { verification: 'skipped', deliveredAt: new Date().toISOString() });
  } catch (err) {
    console.warn(`[work] completion delivery failed for ${work.workId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test tests/work/completion.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/work/completion.ts tests/work/completion.test.ts
git commit -m "feat(work): completion pipeline — evidence receipt, review turn, single push"
```

---

### Task 7: Tool-boundary wiring — `ToolContext`, coding tools, `spawn_agent`

**Files:**
- Modify: `src/agent/types.ts` (`ToolContext`, ~line 56; add `WorkRegistryRef` near `CodingBridgeRef` ~line 125)
- Modify: `src/agent/tools/coding.ts` (`coding_run` ~line 196, `coding_continue` ~line 240)
- Modify: `src/agent/tools/subagent.ts` (whole delivery block)
- Test: extend `tests/agent/tools/subagent-isolation.test.ts`; new assertions in `tests/agent/tools/coding.test.ts`

- [ ] **Step 1: Add the minimal registry ref + context fields**

In `src/agent/types.ts`, next to `CodingBridgeRef`:

```ts
/** Minimal interface to the async-work registry — avoids importing the full class */
export interface WorkRegistryRef {
  create(input: {
    kind: 'coding' | 'subagent';
    originChatId: string;
    originTurnId?: string;
    parentWorkId?: string;
    label: string;
    resultHandle: { type: 'coding_job'; jobId: string } | { type: 'subagent_chat'; chatId: string };
  }): { workId: string; originChatId: string };
  complete(workId: string, status: 'completed' | 'failed' | 'cancelled' | 'interrupted', error?: string): unknown;
}
```

In `ToolContext`, after `codingBridge`:

```ts
  workRegistry?: WorkRegistryRef | null;
  /** Set when this context belongs to work spawned by another work item (nesting). */
  parentWorkId?: string;
  /** Terminal async-work hook installed by home.ts — runs the completion pipeline. */
  onWorkTerminal?: (workId: string, resultText: string) => void;
```

- [ ] **Step 2: Write the failing tests**

Append to `tests/agent/tools/subagent-isolation.test.ts` (follow the existing harness in that file for building a `ToolContext`; reuse its context factory):

```ts
test('spawn_agent registers async work, threads parentWorkId, and reports via onWorkTerminal', async () => {
  const created: unknown[] = [];
  const completed: Array<{ workId: string; status: string }> = [];
  const terminal: Array<{ workId: string; text: string }> = [];
  const ctx = makeCtx({   // the file's existing context factory
    chatId: 'ios_abc_jerry_x_ff',
    workRegistry: {
      create: (input: never) => { created.push(input); return { workId: 'aw_test_0001', originChatId: 'ios_abc_jerry_x_ff' }; },
      complete: (workId: string, status: string) => { completed.push({ workId, status }); return {}; },
    },
    onWorkTerminal: (workId: string, text: string) => terminal.push({ workId, text }),
  });
  const result = await spawnAgentTool.execute({ task: 'do a thing' }, ctx);
  assert.ok(result.content.includes('aw_test_0001'));   // work id surfaced to the caller
  await waitForSubagentSettled();                        // file's existing async settle helper, or poll
  assert.equal(created.length, 1);
  assert.equal(completed[0]?.status, 'completed');
  assert.equal(terminal[0]?.workId, 'aw_test_0001');
});

test('sub-agent context carries parentWorkId so nested coding work links to it', async () => {
  let capturedSubCtx: ToolContext | null = null;
  const ctx = makeCtx({
    chatId: 'ios_abc_jerry_x_ff',
    workRegistry: { create: () => ({ workId: 'aw_test_0002', originChatId: 'ios_abc_jerry_x_ff' }), complete: () => ({}) },
    runAgentLoop: async (_sp, _msg, _tools, subCtx) => { capturedSubCtx = subCtx; return { text: 'ok' } as never; },
  });
  await spawnAgentTool.execute({ task: 'nested' }, ctx);
  await waitForSubagentSettled();
  assert.equal(capturedSubCtx?.parentWorkId, 'aw_test_0002');
});
```

Append to `tests/agent/tools/coding.test.ts` (follow that file's existing fake-bridge harness):

```ts
test('coding_run creates an async-work record with root origin and turn id', async () => {
  const created: Array<Record<string, unknown>> = [];
  const ctx = makeCtx({   // the file's existing context factory with fake codingBridge
    chatId: 'subagent:ios_abc_jerry_x_ff:ab12',
    parentWorkId: 'aw_parent_0001',
    turnRuntime: { turnId: 't_a_b' } as never,
    workRegistry: { create: (i: Record<string, unknown>) => { created.push(i); return { workId: 'aw_c_1', originChatId: 'ios_abc_jerry_x_ff' }; }, complete: () => ({}) },
  });
  await codingRunTool.execute({ prompt: 'fix it', wait_seconds: 0 }, ctx);
  assert.equal(created.length, 1);
  assert.equal(created[0].kind, 'coding');
  assert.equal(created[0].originChatId, 'subagent:ios_abc_jerry_x_ff:ab12'); // registry resolves root itself
  assert.equal(created[0].parentWorkId, 'aw_parent_0001');
  assert.equal(created[0].originTurnId, 't_a_b');
  assert.equal((created[0].resultHandle as { jobId: string }).jobId, /* the fake bridge's job id */ fakeJobId);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --import tsx --test tests/agent/tools/subagent-isolation.test.ts tests/agent/tools/coding.test.ts`
Expected: FAIL — new assertions

- [ ] **Step 4: Implement**

`src/agent/tools/coding.ts` — in `coding_run` immediately after `startJob` resolves (~line 196 block), and identically in `coding_continue`:

```ts
      const job = await bridge.startJob({ /* existing options unchanged */ });
      ctx.workRegistry?.create({
        kind: 'coding',
        originChatId: ctx.chatId,
        originTurnId: ctx.turnRuntime?.turnId,
        parentWorkId: ctx.parentWorkId,
        label: label ?? job.label ?? job.prompt.slice(0, 100),
        resultHandle: { type: 'coding_job', jobId: job.id },
      });
```

`src/agent/tools/subagent.ts` — rework `runSubAgent` and the spawn block:

```ts
    const work = ctx.workRegistry?.create({
      kind: 'subagent',
      originChatId: ctx.chatId,
      originTurnId: ctx.turnRuntime?.turnId,
      parentWorkId: ctx.parentWorkId,
      label: headline,
      resultHandle: { type: 'subagent_chat', chatId: subChatId },
    }) ?? null;

    const runSubAgent = async (): Promise<void> => {
      tracker.active++;
      try {
        const subCtx: ToolContext = { ...ctx, chatId: subChatId, parentWorkId: work?.workId ?? ctx.parentWorkId };
        // … existing systemPrompt + runAgentLoop call unchanged …

        const text = `[Sub-agent complete] ${headline}\n\n${result.text}`;
        // 1. Live stream to the parent turn if it still exists (unchanged)
        if (ctx.onEvent) {
          ctx.onEvent({ type: 'subagent_result', task: task.slice(0, 200), result: result.text });
        }
        // 2. Terminal delivery via the async-work pipeline (root origin, numeric-checked
        //    Telegram, iOS push). Falls back to the old direct append when no registry.
        if (work && ctx.onWorkTerminal) {
          ctx.workRegistry!.complete(work.workId, 'completed');
          ctx.onWorkTerminal(work.workId, text);
        } else if (ctx.conversationHistory) {
          ctx.conversationHistory.append(ctx.chatId, [{ role: 'assistant' as const, content: text, ts: new Date().toISOString() }]);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const text = `[Sub-agent failed] ${headline}\n\n${message}`;
        if (ctx.onEvent) {
          ctx.onEvent({ type: 'subagent_result', task: task.slice(0, 200), result: text });
        }
        if (work && ctx.onWorkTerminal) {
          ctx.workRegistry!.complete(work.workId, 'failed', message);
          ctx.onWorkTerminal(work.workId, text);
        } else if (ctx.conversationHistory) {
          ctx.conversationHistory.append(ctx.chatId, [{ role: 'assistant' as const, content: text, ts: new Date().toISOString() }]);
        }
      } finally {
        tracker.active--;
        if (tracker.queue.length > 0) {
          const next = tracker.queue.shift()!;
          next.resolve();
        }
      }
    };
```

Delete the old inline Telegram block (`subagent.ts:76-92`) entirely — the pipeline owns channel routing now (this also fixes the unguarded non-numeric Telegram fetch, and failure notices now reach channels too). Update the return string:

```ts
    return { content: `Sub-agent spawned for: "${task.slice(0, 200)}"${work ? ` (work ${work.workId}${isolated ? `, session ${subChatId}` : ''})` : (isolated ? ` (session ${subChatId})` : '')}. Results will be delivered when complete.` };
```

- [ ] **Step 5: Run tests, typecheck, commit**

Run: `node --import tsx --test tests/agent/tools/subagent-isolation.test.ts tests/agent/tools/coding.test.ts && npm run build`
Expected: PASS; tsc clean

```bash
git add src/agent/types.ts src/agent/tools/coding.ts src/agent/tools/subagent.ts tests/agent/tools/subagent-isolation.test.ts tests/agent/tools/coding.test.ts
git commit -m "feat(work): register async work at the tool boundary; spawn_agent delivers via pipeline"
```

---

### Task 8: HTTP surface — `/api/work` on the bridge port

**Files:**
- Create: `src/routes/async-work.ts`
- Test: `tests/routes/async-work.test.ts`

Bearer auth with `timingSafeEqual` exactly like `src/routes/device.ts:23-34` (header-only; empty configured token ⇒ open, matching the rest of the bridge).

- [ ] **Step 1: Write the failing test**

```ts
// tests/routes/async-work.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { WorkStore } from '../../src/work/work-store.ts';
import { WorkRegistry } from '../../src/work/registry.ts';
import { createAsyncWorkRouter } from '../../src/routes/async-work.ts';

function startApp(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'work-routes-'));
  const registry = new WorkRegistry({ store: new WorkStore(dir), agent: 'jerry' });
  const cancelled: string[] = [];
  const stopped: string[] = [];
  const app = express();
  app.use(express.json());
  app.use('/api/work', createAsyncWorkRouter({
    registry,
    token: 'secret',
    cancelCodingJob: async (jobId) => { cancelled.push(jobId); },
    stopChat: (chatId) => { stopped.push(chatId); return true; },
    readReceiptDetail: (work) => ({ note: `detail for ${work.workId}` }),
  }));
  const server = app.listen(0);
  t.after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });
  const port = (server.address() as AddressInfo).port;
  return { registry, cancelled, stopped, base: `http://127.0.0.1:${port}` };
}

const AUTH = { headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' } };

test('auth required', async (t) => {
  const { base } = startApp(t);
  const res = await fetch(`${base}/api/work`);
  assert.equal(res.status, 401);
});

test('list with filters, get, receipt', async (t) => {
  const { registry, base } = startApp(t);
  const a = registry.create({ kind: 'coding', originChatId: 'ios_c_jerry_x_y', label: 'a', resultHandle: { type: 'coding_job', jobId: 'cj_1' } });
  const b = registry.create({ kind: 'subagent', originChatId: '123', label: 'b', resultHandle: { type: 'subagent_chat', chatId: 'subagent:123:aaaa' } });
  registry.complete(b.workId, 'completed');

  const all = await (await fetch(`${base}/api/work`, AUTH)).json();
  assert.equal(all.work.length, 2);
  const active = await (await fetch(`${base}/api/work?active=1`, AUTH)).json();
  assert.deepEqual(active.work.map((w: { workId: string }) => w.workId), [a.workId]);
  const byChat = await (await fetch(`${base}/api/work?chatId=123`, AUTH)).json();
  assert.deepEqual(byChat.work.map((w: { workId: string }) => w.workId), [b.workId]);

  const one = await (await fetch(`${base}/api/work/${a.workId}`, AUTH)).json();
  assert.equal(one.workId, a.workId);
  assert.equal((await fetch(`${base}/api/work/aw_missing_x`, AUTH)).status, 404);

  const receipt = await (await fetch(`${base}/api/work/${a.workId}/receipt`, AUTH)).json();
  assert.equal(receipt.work.workId, a.workId);
  assert.equal(receipt.detail.note, `detail for ${a.workId}`);
});

test('cancel routes by kind and records intent', async (t) => {
  const { registry, cancelled, stopped, base } = startApp(t);
  const cod = registry.create({ kind: 'coding', originChatId: '1', label: 'c', resultHandle: { type: 'coding_job', jobId: 'cj_c_9' } });
  const sub = registry.create({ kind: 'subagent', originChatId: '1', label: 's', resultHandle: { type: 'subagent_chat', chatId: 'subagent:1:bbbb' } });

  const r1 = await fetch(`${base}/api/work/${cod.workId}/cancel`, { method: 'POST', ...AUTH });
  assert.equal(r1.status, 202);
  assert.deepEqual(cancelled, ['cj_c_9']);

  const r2 = await fetch(`${base}/api/work/${sub.workId}/cancel`, { method: 'POST', ...AUTH });
  assert.equal(r2.status, 202);
  assert.deepEqual(stopped, ['subagent:1:bbbb']);

  registry.complete(cod.workId, 'completed');
  const r3 = await fetch(`${base}/api/work/${cod.workId}/cancel`, { method: 'POST', ...AUTH });
  assert.equal(r3.status, 409); // already terminal
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test tests/routes/async-work.test.ts`
Expected: FAIL — cannot find module

- [ ] **Step 3: Write the implementation**

```ts
// src/routes/async-work.ts
/**
 * Durable async-work HTTP surface on the bridge port (Step 31):
 *   GET  /api/work                 ?chatId=&active=1&limit=   list
 *   GET  /api/work/:workId                                    status
 *   GET  /api/work/:workId/receipt                            record + kind-specific detail
 *   POST /api/work/:workId/cancel                             cancel (202) — terminal ⇒ 409
 * Bearer auth via timingSafeEqual, same policy as src/routes/device.ts.
 */
import { Router, type Request, type Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { TERMINAL_WORK_STATUSES, type AsyncWorkRecord } from '../work/types.js';
import type { WorkRegistry } from '../work/registry.js';

export interface AsyncWorkRouterDeps {
  registry: WorkRegistry;
  token: string;
  cancelCodingJob: (jobId: string) => Promise<void>;
  /** Abort the active run for a chat (sub-agent cancel). Returns whether a run was found. */
  stopChat: (chatId: string) => boolean;
  /** Kind-specific receipt detail (coding receipt + events tail / sub-chat tail). */
  readReceiptDetail: (work: AsyncWorkRecord) => unknown;
}

function checkAuth(req: Request, res: Response, token: string): boolean {
  if (!token) return true;
  const header = req.headers.authorization ?? '';
  const expected = `Bearer ${token}`;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    res.status(401).json({ error: 'unauthorized' });
    return false;
  }
  return true;
}

export function createAsyncWorkRouter(deps: AsyncWorkRouterDeps): Router {
  const router = Router();

  router.get('/', (req, res) => {
    if (!checkAuth(req, res, deps.token)) return;
    const chatId = typeof req.query.chatId === 'string' ? req.query.chatId : undefined;
    const active = req.query.active === '1' || req.query.active === 'true';
    const limit = Number.parseInt(String(req.query.limit ?? ''), 10);
    res.json({
      work: deps.registry.list({
        originChatId: chatId,
        active,
        limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 200) : 50,
      }),
    });
  });

  router.get('/:workId', (req, res) => {
    if (!checkAuth(req, res, deps.token)) return;
    const work = deps.registry.get(req.params.workId);
    if (!work) return void res.status(404).json({ error: 'unknown work id' });
    res.json(work);
  });

  router.get('/:workId/receipt', (req, res) => {
    if (!checkAuth(req, res, deps.token)) return;
    const work = deps.registry.get(req.params.workId);
    if (!work) return void res.status(404).json({ error: 'unknown work id' });
    res.json({ work, detail: deps.readReceiptDetail(work) });
  });

  router.post('/:workId/cancel', (req, res) => {
    if (!checkAuth(req, res, deps.token)) return;
    const work = deps.registry.get(req.params.workId);
    if (!work) return void res.status(404).json({ error: 'unknown work id' });
    if (TERMINAL_WORK_STATUSES.has(work.status)) {
      return void res.status(409).json({ error: 'already terminal', status: work.status });
    }
    deps.registry.requestCancel(work.workId);
    if (work.resultHandle.type === 'coding_job') {
      const jobId = work.resultHandle.jobId;
      deps.cancelCodingJob(jobId).catch(err =>
        console.warn(`[work] cancel of ${jobId} failed: ${err instanceof Error ? err.message : String(err)}`));
    } else {
      deps.stopChat(work.resultHandle.chatId);
    }
    res.status(202).json({ workId: work.workId, cancel: 'requested' });
  });

  return router;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test tests/routes/async-work.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/routes/async-work.ts tests/routes/async-work.test.ts
git commit -m "feat(work): bearer-authed /api/work list/status/receipt/cancel routes"
```

---

### Task 9: `home.ts` wiring — registry, listener rewrite, boot reconciliation, route mount

**Files:**
- Modify: `src/home.ts` (coding wiring block ~lines 911-970; route mounts ~line 1095; toolContext setup)
- Delete: `src/acp/result-delivery.ts`, `tests/acp/result-delivery.test.ts`
- Modify: `config/home.yaml.example` (document the `asyncWork` block)

This is integration glue — verified by `npm run build` + the full targeted suite + existing wiring tests (`tests/agent/turn-entrypoint-callers.test.ts` and friends), not new unit tests.

- [ ] **Step 1: Instantiate the work system (before the ACP bridge block, after `commandCtx.scheduler = scheduler;`)**

```ts
  // ── Async work registry (Step 31) ──
  // One durable contract for detached work: coding jobs + sub-agents.
  const workStore = new WorkStore(join(INSTANCE_DIR, 'async-work'));
  const workRegistry = new WorkRegistry({ store: workStore, agent: AGENT_NAME });
  toolContext.workRegistry = workRegistry;

  const asyncWorkRaw = (config as { asyncWork?: { review?: { coding?: boolean; subagent?: boolean }; reviewIdleTimeoutMs?: number } }).asyncWork ?? {};
  const workReview = {
    coding: asyncWorkRaw.review?.coding ?? true,
    subagent: asyncWorkRaw.review?.subagent ?? false,
  };

  const buildWorkSinks = (): ReceiptSinks => {
    const sinks: ReceiptSinks = {
      appendHistory: (chatId, text) => {
        try {
          history.append(chatId, [{ role: 'assistant', content: text, ts: new Date().toISOString() }]);
        } catch (err) {
          console.warn(`[work] history delivery failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    };
    if (process.env.TELEGRAM_BOT_TOKEN) {
      sinks.sendTelegram = (chatId, text) => {
        fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text }),
        }).catch((err) => console.warn(`[work] Telegram delivery failed: ${err instanceof Error ? err.message : String(err)}`));
      };
    }
    const pusher = agent.getPusher();
    if (pusher) {
      sinks.pushWork = (input) => {
        pusher.notifyAsyncWork({ chatId: input.chatId, workId: input.workId, status: input.status, body: input.body })
          .catch((err) => console.warn(`[work] iOS push failed: ${err instanceof Error ? err.message : String(err)}`));
      };
    }
    return sinks;
  };

  const completionDeps = (): CompletionDeps => ({
    registry: workRegistry,
    sinks: buildWorkSinks(),
    review: workReview,
    isChatBusy: (chatId) => agent.isRunning(chatId),
    waitForIdleMs: asyncWorkRaw.reviewIdleTimeoutMs ?? 120_000,
    idlePollMs: 10_000,
    runReviewTurn: async (chatId, prompt) =>
      (await executeTrackedTurn(agent, chatId, prompt, { inactivityMs: 5 * 60_000 })).response.text,
  });

  const codingReceiptText = (work: AsyncWorkRecord, job: CodingJobRecord, receipt: CodingJobReceipt | undefined): string => {
    const tail = receipt?.resultTail ? `\n\n${receipt.resultTail.slice(0, 1500)}` : '';
    return `[Async work ${work.status}] ${work.label}${tail}\n(work ${work.workId}; job ${job.id}; coding_result for full output)`;
  };

  toolContext.onWorkTerminal = (workId, resultText) => {
    const work = workRegistry.get(workId);
    if (!work) return;
    void handleWorkCompletion(work, resultText, completionDeps());
  };
```

Imports to add at the top of `home.ts`:

```ts
import { WorkStore } from './work/work-store.js';
import { WorkRegistry } from './work/registry.js';
import { handleWorkCompletion, type CompletionDeps } from './work/completion.js';
import type { ReceiptSinks } from './work/receipt-delivery.js';
import type { AsyncWorkRecord } from './work/types.js';
import { createAsyncWorkRouter } from './routes/async-work.js';
```

Remove: `import { deliverCodingJobResult, type CodingResultSinks } from './acp/result-delivery.js';`

- [ ] **Step 2: Replace the `job_finished` listener body and add progress**

Replace the entire listener installed at `codingBridge.addListener(...)` (the block currently building `CodingResultSinks` and calling `deliverCodingJobResult`) with:

```ts
    codingBridge.addListener((event) => {
      if (event.type === 'job_started') {
        console.log(`[coding] job ${event.job.id} started (${event.job.backend}) in ${event.job.cwd}`);
        return;
      }
      if (event.type === 'job_event') {
        const work = workRegistry.findByJobId(event.jobId);
        if (work) {
          const e = event.event;
          const note = e.kind === 'tool_use' ? `tool: ${e.tool}` : e.kind;
          workRegistry.noteProgress(work.workId, note);
        }
        return;
      }
      // job_finished
      const { job, receipt } = event;
      console.log(`[coding] job ${job.id} ${job.status} (${job.backend}, ${Math.round(receipt.durationMs / 1000)}s)`);
      const work = workRegistry.findByJobId(job.id)
        ?? workRegistry.create({
          kind: 'coding',
          originChatId: job.requestedBy ?? 'unknown',
          label: job.label ?? job.prompt.slice(0, 100),
          resultHandle: { type: 'coding_job', jobId: job.id },
        });
      const done = workRegistry.complete(work.workId, job.status as AsyncWorkRecord['status'], job.error);
      void handleWorkCompletion(done, codingReceiptText(done, job, receipt), completionDeps());
    });
```

- [ ] **Step 3: Boot reconciliation after `codingBridge.recover()`**

Immediately after the existing `recover()` try/catch (keep that block), add:

```ts
  // ── Async-work boot reconciliation ──
  // Lost sub-agents → interrupted; jobs that finished while the harness was
  // down → deliver their receipts now; running jobs without records → backfill.
  try {
    const reconciled = workRegistry.reconcileOnBoot({ jobs: codingBridge?.listJobs() ?? [] });
    if (reconciled.interrupted.length || reconciled.backfilled.length || reconciled.needsDelivery.length) {
      console.log(`[work] boot reconcile: ${reconciled.interrupted.length} interrupted, ${reconciled.backfilled.length} backfilled, ${reconciled.needsDelivery.length} to deliver`);
    }
    for (const work of reconciled.needsDelivery) {
      let text = `[Async work ${work.status}] ${work.label}\n(work ${work.workId})`;
      if (work.resultHandle.type === 'coding_job' && codingBridge) {
        const job = codingBridge.getJob(work.resultHandle.jobId);
        const receipt = codingBridge.getReceipt(work.resultHandle.jobId);
        if (job) text = codingReceiptText(work, job, receipt);
      }
      if (work.status === 'interrupted') {
        text = `[Async work interrupted] ${work.label} — the harness restarted while this was running.` +
          (work.resultHandle.type === 'coding_job' ? ` Job ${work.resultHandle.jobId} may be resumable via coding_continue.` : '') +
          `\n(work ${work.workId})`;
      }
      void handleWorkCompletion(work, text, completionDeps());
    }
  } catch (err) {
    console.warn(`[work] boot reconcile failed: ${err instanceof Error ? err.message : String(err)}`);
  }
```

Note this block must run even when `codingBridge` is null (acp disabled) so lost sub-agents still get interrupted — place it OUTSIDE the `if (acpConfig.enabled)` block.

- [ ] **Step 4: Mount the routes (next to the worker router mount, ~line 1095)**

```ts
  bridgeApp.use('/api/work', createAsyncWorkRouter({
    registry: workRegistry,
    token: bridgeToken,   // the same resolveQueryNotebookBridgeToken() value used by chat routes
    cancelCodingJob: async (jobId) => { if (codingBridge) await codingBridge.cancelJob(jobId); },
    stopChat: (chatId) => agent.stop(chatId).stopped,
    readReceiptDetail: (work) => {
      if (work.resultHandle.type === 'coding_job' && codingBridge) {
        return {
          receipt: codingBridge.getReceipt(work.resultHandle.jobId) ?? null,
          events: codingBridge.readEventsTail(work.resultHandle.jobId, 30),
        };
      }
      if (work.resultHandle.type === 'subagent_chat') {
        try { return { messages: history.load(work.resultHandle.chatId).slice(-5) }; } catch { return { messages: [] }; }
      }
      return null;
    },
  }));
```

(Confirm the local name of the bridge token variable at the mount site — `src/home.ts:1042` — and reuse it.)

- [ ] **Step 5: Document config, delete superseded module, verify, commit**

Append to `config/home.yaml.example` (near the `acp:` example):

```yaml
# Async work (Step 31): post-completion review + delivery behavior
asyncWork:
  review:
    coding: true       # successful coding jobs get a Jerry review turn before reporting
    subagent: false    # sub-agent results deliver directly
  reviewIdleTimeoutMs: 120000
```

```bash
git rm src/acp/result-delivery.ts tests/acp/result-delivery.test.ts
```

Run: `npm run build && node --import tsx --test tests/work/*.test.ts tests/routes/async-work.test.ts tests/agent/tools/coding.test.ts tests/agent/tools/subagent-isolation.test.ts tests/acp/bridge.test.ts tests/acp/job-store.test.ts tests/agent/turn-entrypoint-callers.test.ts`
Expected: tsc clean, all PASS

```bash
git add -A src/home.ts config/home.yaml.example
git commit -m "feat(work): wire registry into home — listener rewrite, boot reconcile, /api/work mount; retire result-delivery"
```

---

### Task 10: Test registration + full harness gate + design doc

**Files:**
- Modify: `package.json` ("test" script)
- Create: `docs/design/STEP31-ASYNC-WORK-DESIGN.md`

- [ ] **Step 1: Register new test globs**

In the `"test"` script in `package.json`, after `tests/acp/*.test.ts`, add: `tests/work/*.test.ts tests/routes/*.test.ts`.

- [ ] **Step 2: Heal the worktree install and run the full gate**

```bash
npm install && npm run build && npm test
```

Expected: everything green. If `tests/cosmo23/runtime-dependency-compatibility.test.cjs` / `spend-meter.test.cjs` still fail on `undici` after `npm install`, they are the documented pre-existing worktree env issue — note it in the commit message and do not chase it here.

- [ ] **Step 3: Write the design doc**

`docs/design/STEP31-ASYNC-WORK-DESIGN.md` — concise (this plan is the detailed artifact): the record schema, the origin-resolution rule, the completion pipeline (evidence → review → single push), the `/api/work` surface, the `async_work` push contract (`chatId + workId`, explicitly "never a turnId"), boot reconciliation semantics, and the config block. Link Step 29 and note `result-delivery.ts` retirement.

- [ ] **Step 4: Commit**

```bash
git add package.json docs/design/STEP31-ASYNC-WORK-DESIGN.md
git commit -m "chore(work): register work/route tests; STEP31 design doc"
```

---

## Part 2 — iOS (`/Users/jtr/xCode_Builds/Home23`)

### Task 11: Shared contracts — turn-id policy, async-work payload + records

**Files:**
- Create: `Home23Shared/Sources/Home23Shared/Models/AsyncWorkContracts.swift`
- Create: `Home23Shared/Tests/Home23SharedTests/AsyncWorkContractsTests.swift`

- [ ] **Step 1: Write the failing tests**

```swift
// Home23Shared/Tests/Home23SharedTests/AsyncWorkContractsTests.swift
import XCTest
@testable import Home23Shared

final class AsyncWorkContractsTests: XCTestCase {
    // MARK: TurnIDPolicy — the cj_ fix
    func testServerTurnIDsAccepted() {
        XCTAssertTrue(Home23TurnIDPolicy.isServerTurnID("t_mfy1x2_ab12cd34"))
        XCTAssertTrue(Home23TurnIDPolicy.isServerTurnID("t_1a_9"))
    }

    func testForeignIDsRejected() {
        XCTAssertFalse(Home23TurnIDPolicy.isServerTurnID("cj_20260805_ab12"))   // coding job id
        XCTAssertFalse(Home23TurnIDPolicy.isServerTurnID("aw_abc_ff00"))         // work id
        XCTAssertFalse(Home23TurnIDPolicy.isServerTurnID("brop_x"))
        XCTAssertFalse(Home23TurnIDPolicy.isServerTurnID(""))
        XCTAssertFalse(Home23TurnIDPolicy.isServerTurnID("t_UPPER_case"))
        XCTAssertFalse(Home23TurnIDPolicy.isServerTurnID("t_no-second-part"))
    }

    // MARK: OpenAsyncWorkRoutePayload
    func testAsyncWorkPayloadParses() {
        let payload = OpenAsyncWorkRoutePayload(userInfo: [
            "kind": "async_work",
            "chatId": "ios_abc_jerry_x_ff",
            "workId": "aw_mfy1x2_ab12",
            "status": "completed",
            "agent": "jerry",
            "aps": ["alert": ["title": "jerry", "body": "Work finished"]],
        ])
        XCTAssertEqual(payload?.chatId, "ios_abc_jerry_x_ff")
        XCTAssertEqual(payload?.workId, "aw_mfy1x2_ab12")
        XCTAssertEqual(payload?.status, "completed")
        XCTAssertEqual(payload?.agent, "jerry")
    }

    func testAsyncWorkPayloadRejectsBadShapes() {
        XCTAssertNil(OpenAsyncWorkRoutePayload(userInfo: ["kind": "async_work", "chatId": "c"]))               // missing workId
        XCTAssertNil(OpenAsyncWorkRoutePayload(userInfo: ["kind": "async_work", "chatId": "", "workId": "aw_a_ff00"]))
        XCTAssertNil(OpenAsyncWorkRoutePayload(userInfo: ["kind": "async_work", "chatId": "c", "workId": "cj_notwork_1"]))
        XCTAssertNil(OpenAsyncWorkRoutePayload(userInfo: ["kind": "query_operation", "chatId": "c", "workId": "aw_a_ff00"]))
    }

    // MARK: record decode
    func testWorkRecordDecodesAndClassifiesActive() throws {
        let json = """
        {"work":[{"schema":"home23.async-work.v1","workId":"aw_a_ff00","kind":"coding","agent":"jerry","originChatId":"ios_x","label":"fix","status":"running","startedAt":"2026-08-06T12:00:00.000Z","updatedAt":"2026-08-06T12:01:00.000Z","resultHandle":{"type":"coding_job","jobId":"cj_1"},"verification":"none","progressSummary":"tool: Bash"}]}
        """.data(using: .utf8)!
        let decoded = try JSONDecoder().decode(AsyncWorkListResponse.self, from: json)
        XCTAssertEqual(decoded.work.count, 1)
        let rec = decoded.work[0]
        XCTAssertEqual(rec.workId, "aw_a_ff00")
        XCTAssertTrue(rec.isActive)
        XCTAssertEqual(rec.progressSummary, "tool: Bash")
    }

    func testTerminalStatusesNotActive() throws {
        for status in ["completed", "failed", "cancelled", "interrupted"] {
            let rec = AsyncWorkRecordContract(workId: "aw_a_ff00", kind: "coding", agent: "jerry", originChatId: "c", originTurnId: nil, parentWorkId: nil, label: "x", status: status, startedAt: "", updatedAt: "", finishedAt: nil, progressSummary: nil, verification: nil, error: nil)
            XCTAssertFalse(rec.isActive, status)
        }
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/jtr/xCode_Builds/Home23/Home23Shared && swift test --filter AsyncWorkContractsTests`
Expected: FAIL — types not found

- [ ] **Step 3: Write the implementation**

```swift
// Home23Shared/Sources/Home23Shared/Models/AsyncWorkContracts.swift
import Foundation

/// Server turn ids are `t_<base36>_<base36>` (harness `newTurnId()`). Anything
/// else — `cj_` coding jobs, `aw_` work ids, `brop_` operations — must never be
/// adopted as a chat turn. This is the gate that prevents the pushed-id wedge.
public enum Home23TurnIDPolicy {
    private static let pattern = "^t_[a-z0-9]+_[a-z0-9]+$"
    public static func isServerTurnID(_ value: String) -> Bool {
        value.range(of: pattern, options: .regularExpression) != nil
    }
}

/// Validated `kind: "async_work"` push payload — `chatId + workId`, no turnId.
public struct OpenAsyncWorkRoutePayload: Equatable, Sendable {
    public let chatId: String
    public let workId: String
    public let status: String?
    public let agent: String?

    private static let workIdPattern = "^aw_[a-z0-9]+_[0-9a-f]{4}$"

    public init?(userInfo: [AnyHashable: Any]) {
        guard let kind = userInfo["kind"] as? String, kind == "async_work" else { return nil }
        guard let chatId = (userInfo["chatId"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
              !chatId.isEmpty, chatId.count <= 200 else { return nil }
        guard let workId = (userInfo["workId"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
              workId.range(of: Self.workIdPattern, options: .regularExpression) != nil else { return nil }
        self.chatId = chatId
        self.workId = workId
        self.status = userInfo["status"] as? String
        self.agent = userInfo["agent"] as? String
    }
}

/// Mirror of the harness `AsyncWorkRecord` (schema home23.async-work.v1).
public struct AsyncWorkRecordContract: Codable, Equatable, Sendable {
    public let workId: String
    public let kind: String
    public let agent: String
    public let originChatId: String
    public let originTurnId: String?
    public let parentWorkId: String?
    public let label: String
    public let status: String
    public let startedAt: String
    public let updatedAt: String
    public let finishedAt: String?
    public let progressSummary: String?
    public let verification: String?
    public let error: String?

    public init(workId: String, kind: String, agent: String, originChatId: String, originTurnId: String?, parentWorkId: String?, label: String, status: String, startedAt: String, updatedAt: String, finishedAt: String?, progressSummary: String?, verification: String?, error: String?) {
        self.workId = workId; self.kind = kind; self.agent = agent
        self.originChatId = originChatId; self.originTurnId = originTurnId
        self.parentWorkId = parentWorkId; self.label = label; self.status = status
        self.startedAt = startedAt; self.updatedAt = updatedAt; self.finishedAt = finishedAt
        self.progressSummary = progressSummary; self.verification = verification; self.error = error
    }

    public var isActive: Bool {
        ["queued", "running", "blocked"].contains(status)
    }
}

public struct AsyncWorkListResponse: Codable, Sendable {
    public let work: [AsyncWorkRecordContract]
}
```

(Decoding note: the server record has extra keys — `schema`, `resultHandle`, `deliveredAt` — which `Codable` ignores by default. Do not add them; the app has no use for the handle internals in slice 1.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/jtr/xCode_Builds/Home23/Home23Shared && swift test --filter AsyncWorkContractsTests`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/jtr/xCode_Builds/Home23
git add Home23Shared/Sources/Home23Shared/Models/AsyncWorkContracts.swift Home23Shared/Tests/Home23SharedTests/AsyncWorkContractsTests.swift
git commit -m "feat(shared): async-work contracts + server turn-id policy (rejects cj_/aw_ as turns)"
```

---

### Task 12: Close the fake-turn hole — payload + checkpoint gates

**Files:**
- Modify: `Home23Shared/Sources/Home23Shared/Models/OpenChatRoutePayload.swift` (turnId acceptance, ~lines 39-50)
- Modify: `Home23/Sources/Features/Chat/ChatViewModel.swift` (`checkpointInitialRouteIfNeeded`, ~line 534)
- Test: extend `Home23Shared/Tests/Home23SharedTests/` payload tests (find the existing `OpenChatRoutePayload` test file; if none exists, add cases to `AsyncWorkContractsTests.swift`)

- [ ] **Step 1: Write the failing test**

```swift
    // MARK: OpenChatRoutePayload turnId hardening
    func testLegacyChatPayloadDropsForeignTurnIds() {
        let payload = OpenChatRoutePayload(userInfo: [
            "chatId": "ios_abc_jerry_x_ff",
            "agent": "jerry",
            "turnId": "cj_20260805_ab12",
        ])
        XCTAssertEqual(payload?.chatId, "ios_abc_jerry_x_ff")  // chat still opens
        XCTAssertNil(payload?.turnId)                            // foreign id never adopted
    }

    func testLegacyChatPayloadKeepsServerTurnIds() {
        let payload = OpenChatRoutePayload(userInfo: [
            "chatId": "ios_abc_jerry_x_ff",
            "turnId": "t_mfy1x2_ab12cd34",
        ])
        XCTAssertEqual(payload?.turnId, "t_mfy1x2_ab12cd34")
    }
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /Users/jtr/xCode_Builds/Home23/Home23Shared && swift test --filter AsyncWorkContractsTests`
Expected: FAIL — foreign turnId currently accepted

- [ ] **Step 3: Implement both gates**

In `OpenChatRoutePayload.swift`, where `turnId` is extracted from `turnId | turn_id | activeTurnId` and trimmed, wrap the final assignment:

```swift
        let rawTurnId = /* existing extraction/trim of turnId|turn_id|activeTurnId */
        self.turnId = rawTurnId.flatMap { Home23TurnIDPolicy.isServerTurnID($0) ? $0 : nil }
```

In `ChatViewModel.swift` `checkpointInitialRouteIfNeeded()`, harden the entry guard (defense in depth — covers cached routes minted before this build):

```swift
        guard let routedTurnID = initialTurnID, !routedTurnID.isEmpty else { return true }
        guard Home23TurnIDPolicy.isServerTurnID(routedTurnID) else {
            // A foreign id (coding job, work id) can never be a chat turn — do not
            // checkpoint it, do not poll it. The conversation opens normally.
            return true
        }
```

- [ ] **Step 4: Verify**

Run: `cd /Users/jtr/xCode_Builds/Home23/Home23Shared && swift test`
Expected: PASS (full shared suite — the HUD/policy suites must stay green)
App target: compile-verify via Xcode Cmd+B (xcodebuild CLI broken on this Mac) — defer to the final task's verification note if Xcode isn't open now.

- [ ] **Step 5: Commit**

```bash
git add Home23Shared/Sources/Home23Shared/Models/OpenChatRoutePayload.swift Home23/Sources/Features/Chat/ChatViewModel.swift Home23Shared/Tests/Home23SharedTests/AsyncWorkContractsTests.swift
git commit -m "fix(chat): never adopt non-turn ids from pushes — closes the cj_ fake-turn wedge"
```

---

### Task 13: Route the `async_work` push

**Files:**
- Modify: `Home23/Sources/Core/Push/PushRouter.swift` (payload discrimination, ~lines 218-225; tap-through)
- Modify: `Home23/Sources/Features/Chat/ChatShellView.swift` (`.home23OpenChat` consumer already handles turnId-less routes)

- [ ] **Step 1: Add the route case**

In `PushRouter.swift` where payloads are discriminated (`if userInfo["kind"] == nil { … legacyChat … }`), add an `async_work` branch before the query branch:

```swift
        if let kind = userInfo["kind"] as? String, kind == "async_work" {
            guard let payload = OpenAsyncWorkRoutePayload(userInfo: userInfo) else { return nil }
            return .asyncWork(payload)
        }
```

Add `case asyncWork(OpenAsyncWorkRoutePayload)` to the route enum in the same file, and handle it wherever the enum is switched (foreground-suppression check and tap-through). Tap-through converts to the existing chat-open flow **without a turnId**, then announces the work arrival for any listening surface:

```swift
        case .asyncWork(let payload):
            NotificationCenter.default.post(name: .home23SelectChatFromPush, object: nil)
            NotificationCenter.default.post(name: .home23OpenChat, object: nil, userInfo: [
                "chatId": payload.chatId,
                "agent": payload.agent ?? "",
            ])
            NotificationCenter.default.post(name: .home23AsyncWorkArrived, object: nil, userInfo: [
                "workId": payload.workId,
                "chatId": payload.chatId,
            ])
```

Define the notification name next to the existing ones (find `home23OpenChat`'s definition and mirror it):

```swift
public extension Notification.Name {
    static let home23AsyncWorkArrived = Notification.Name("home23AsyncWorkArrived")
}
```

Foreground suppression: in the `willPresent` path where `currentlyOpenRoute` matches suppress the banner for `.asyncWork` exactly as for `.legacyChat` when the chatId matches the open conversation (the receipt is already visible in the transcript).

- [ ] **Step 2: Verify ChatShellView tolerates a turnId-less open**

`ChatShellView.swift:91-147` builds the route from `.home23OpenChat` userInfo; with no `"turnId"` key the canonical route's turnId is nil and `Home23ChatSelectionPolicy.initialTurnID` returns nil — confirm by reading, no change expected. The conversation opens, `loadHistory()` runs, the receipt message (appended server-side) renders as a normal assistant message.

- [ ] **Step 3: Compile-verify**

Xcode Cmd+B (app target — no CLI build available). Shared suite: `cd Home23Shared && swift test` stays green.

- [ ] **Step 4: Commit**

```bash
git add Home23/Sources/Core/Push/PushRouter.swift Home23/Sources/Features/Chat/ChatShellView.swift
git commit -m "feat(push): route async_work pushes to the origin conversation via chatId + workId"
```

---

### Task 14: `AsyncWorkService` + active-work strip + receipt sheet

**Files:**
- Create: `Home23/Sources/Core/Networking/AsyncWorkService.swift`
- Create: `Home23/Sources/Features/Chat/ActiveWorkStrip.swift`
- Modify: `Home23/Sources/Features/Chat/ChatView.swift` (mount strip between transcript and composer)

- [ ] **Step 1: Service**

```swift
// Home23/Sources/Core/Networking/AsyncWorkService.swift
import Foundation
import Home23Shared

/// Durable async-work surface on the selected agent's bridge (`/api/work`).
/// Mirrors WorkerAgentService's shape but bridge-scoped and bearer-authed.
struct AsyncWorkService {
    let client: APIClient

    func list(agent: AgentDescriptor, chatId: String? = nil, activeOnly: Bool = false) async throws -> [AsyncWorkRecordContract] {
        var query = [URLQueryItem]()
        if let chatId { query.append(URLQueryItem(name: "chatId", value: chatId)) }
        if activeOnly { query.append(URLQueryItem(name: "active", value: "1")) }
        let response: AsyncWorkListResponse = try await client.get(base: .selectedAgentBridge(agent), path: "/api/work", query: query)
        return response.work
    }

    func detail(agent: AgentDescriptor, workId: String) async throws -> AsyncWorkRecordContract {
        try await client.get(base: .selectedAgentBridge(agent), path: "/api/work/\(workId)")
    }

    func cancel(agent: AgentDescriptor, workId: String) async throws {
        struct CancelAck: Codable { let workId: String; let cancel: String }
        let _: CancelAck = try await client.post(base: .selectedAgentBridge(agent), path: "/api/work/\(workId)/cancel", body: EmptyBody())
    }
}
```

**Adapt to the real `APIClient` surface:** read `Home23/Sources/Core/Networking/APIClient.swift` and `WorkerAgentService.swift` first and use their exact request-building idioms (method names, base-resolution enum, empty-body convention) — the snippet above is the intended shape, not a blind paste. The base must resolve to the agent's **bridge** port with the bearer header, exactly like the eight chat endpoints asserted at `ChatViewModel.swift:18-27`.

- [ ] **Step 2: Strip + sheet**

```swift
// Home23/Sources/Features/Chat/ActiveWorkStrip.swift
import SwiftUI
import Home23Shared

/// Compact detached-work surface for the open conversation: one row per active
/// work item (label + status), pinned between transcript and composer. Not part
/// of the sticky turn HUD (whose height is contractually constant). Refreshes
/// on appear, on foreground, and on async-work push arrival.
struct ActiveWorkStrip: View {
    let agent: AgentDescriptor
    let chatId: String
    let service: AsyncWorkService

    @State private var work: [AsyncWorkRecordContract] = []
    @State private var selected: AsyncWorkRecordContract?
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        Group {
            if !work.isEmpty {
                VStack(spacing: 4) {
                    ForEach(work, id: \.workId) { item in
                        Button { selected = item } label: {
                            HStack(spacing: 8) {
                                ProgressView().controlSize(.mini)
                                Text(item.label).font(.footnote).lineLimit(1)
                                Spacer(minLength: 4)
                                Text(item.progressSummary ?? item.status)
                                    .font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                            }
                            .padding(.horizontal, 10).padding(.vertical, 6)
                            .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 8))
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 12).padding(.bottom, 4)
            }
        }
        .task { await refresh() }
        .onChange(of: scenePhase) { _, phase in if phase == .active { Task { await refresh() } } }
        .onReceive(NotificationCenter.default.publisher(for: .home23AsyncWorkArrived)) { _ in
            Task { await refresh() }
        }
        .sheet(item: $selected) { item in
            WorkDetailSheet(agent: agent, item: item, service: service) { await refresh() }
        }
    }

    private func refresh() async {
        work = (try? await service.list(agent: agent, chatId: chatId, activeOnly: true)) ?? work
    }
}

extension AsyncWorkRecordContract: Identifiable { public var id: String { workId } }

struct WorkDetailSheet: View {
    let agent: AgentDescriptor
    let item: AsyncWorkRecordContract
    let service: AsyncWorkService
    let onChange: () async -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var cancelling = false

    var body: some View {
        NavigationStack {
            List {
                LabeledContent("Work", value: item.workId)
                LabeledContent("Kind", value: item.kind)
                LabeledContent("Status", value: item.status)
                if let progress = item.progressSummary { LabeledContent("Progress", value: progress) }
                LabeledContent("Started", value: item.startedAt)
                if let verification = item.verification { LabeledContent("Verification", value: verification) }
                if let error = item.error { LabeledContent("Error", value: error) }
                Section {
                    Text("The receipt is delivered into this conversation when the work finishes.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                if item.isActive {
                    Section {
                        Button(role: .destructive) {
                            cancelling = true
                            Task {
                                try? await service.cancel(agent: agent, workId: item.workId)
                                await onChange()
                                dismiss()
                            }
                        } label: {
                            if cancelling { ProgressView() } else { Text("Cancel work") }
                        }
                    }
                }
            }
            .navigationTitle(item.label)
            .navigationBarTitleDisplayMode(.inline)
        }
    }
}
```

Mount in `ChatView.swift` directly above the composer (NOT inside the sticky-HUD `safeAreaInset` — its height is contractually constant per `CLAUDE.md:75`). Find the VStack seam between the transcript scroll view and the composer/control deck and insert:

```swift
            ActiveWorkStrip(agent: vm.agent, chatId: vm.chatId, service: AsyncWorkService(client: vm.apiClient))
```

**Adapt the accessor names** (`vm.agent`, `vm.chatId`, `vm.apiClient`) to `ChatViewModel`'s real exposed properties — read the VM's property list first; add a minimal computed accessor on the VM if the client isn't exposed.

- [ ] **Step 3: Verify**

- `cd Home23Shared && swift test` — green (contracts unchanged since Task 12).
- App target: Xcode Cmd+B.
- Live smoke (needs a running harness): from a chat, have Jerry `spawn_agent` or `coding_run`; confirm `GET http://<host>:5004/api/work?active=1` (bearer) lists it, the strip shows it, cancel works, and on completion exactly one push arrives whose tap opens the right conversation with the receipt visible.

- [ ] **Step 4: Commit**

```bash
git add Home23/Sources/Core/Networking/AsyncWorkService.swift Home23/Sources/Features/Chat/ActiveWorkStrip.swift Home23/Sources/Features/Chat/ChatView.swift
git commit -m "feat(chat): active-work strip + receipt sheet backed by /api/work"
```

---

## Final verification gate (both repos)

- [ ] Harness: `npm run build && npm test` — green (modulo the documented pre-existing `undici` env failures if `npm install` didn't clear them).
- [ ] Harness targeted: `node --import tsx --test tests/work/*.test.ts tests/routes/async-work.test.ts tests/agent/tools/*.test.ts tests/acp/*.test.ts` — green.
- [ ] iOS shared: `cd /Users/jtr/xCode_Builds/Home23/Home23Shared && swift test` — green.
- [ ] iOS app target: **jtr must Cmd+B in Xcode** (CLI builds broken on this Mac) before any device deploy.
- [ ] **No live-process restarts in this plan.** The live jerry/forrest harnesses keep running old code until jtr decides to restart (sacred persistence rules apply; harness-only restart does not touch engine brains, but the decision is jtr's).

## Explicitly out of scope (first slice)

- Dashboard/web chat surfaces for work records (`/api/work` is consumable there later).
- Review turns for sub-agent results (config scaffold exists, default off).
- Auth hardening for the pre-existing unauthenticated bridge routes (`/api/workers/*`, `/api/agency/*`, `/api/chat/media`, `/api/stop`) — flagged separately.
- Migrating `worker:*` runs or cron jobs onto the contract (the record shape already accommodates them via `kind` extension).
