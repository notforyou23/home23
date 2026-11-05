# OS-Engine Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the Home23 cognitive engine around a universal channel bus, verification gate, crystallization pipeline, closer, decay worker, role-integrity contract, neighbor protocol, and publish layer — turning the engine from an inward-pointed thought-miner into an OS-aware kernel that observes the world and itself through one primitive.

**Architecture:** The existing `engine/src/cognition/thinking-machine.js` four-phase loop (discover/deep-dive/connect/critique) is demoted to an inner cognitive subsystem wrapped by new OS-level primitives. A universal channel bus (`engine/src/channels/bus.js`) ingests six classes of signals (machine, OS, domain, build, work, neighbor), passes them through a verification gate (`src/agent/verification.ts`), and crystallizes verified observations into MemoryObjects via the existing `MemoryObjectStore`. A closer (`engine/src/cognition/closer.js`) enforces goal termination contracts + dedupe-before-spawn. A decay worker (`engine/src/cognition/decay-worker.js`) applies gentle weight reduction to warnings + stale transforms + unreferenced edges. A publish layer (`engine/src/publish/*`) materializes artifacts, signals, bridge-chat messages, and dashboard surfaces on declared cadences. The existing `src/workers/promoter.ts` verifier-gated pattern generalizes into the bus as its first consumer.

**Tech Stack:** Node.js ≥20 (ESM), TypeScript 5.7 (harness), plain JS (engine), `node:test` + `tsx` for tests, chokidar (fswatch), Anthropic SDK (LLM calls for verifier classification), PM2 (process lifecycle), existing `MemoryObjectStore` + confidence caps, existing live-problems registry.

**Design spec (read first):** `docs/design/STEP24-OS-ENGINE-REDESIGN.md`. Every task in this plan implements part of that spec — if a task seems ambiguous, the spec has the load-bearing context.

---

## Testing strategy

- **Engine tests (JS):** live under `tests/engine/...` using `node:test` + `node:assert`. Each test file added to the `test` script in `package.json`.
- **Harness tests (TS):** live under `tests/agent/...` already established, run via `tsx`.
- **Test philosophy:** TDD — test first, see it fail, implement minimal, see it pass, commit. Each channel's `parse()`, `verify()`, `crystallize()` are pure functions and easy to test. `source()` is mocked via fakeable adapters.
- **Integration tests:** `tests/engine/integration/*.test.js` exercise the bus + channel + crystallization end-to-end with an in-memory MemoryObjectStore.
- **No live-process tests in unit test files.** Live verification happens separately via dive-mode queries on jerry's brain after each phase lands.

## File structure (created by this plan)

### Engine (JS)
```
engine/src/channels/
  contract.js               # Channel interface + base classes + VerifiedObservation type
  bus.js                    # Universal channel bus (registration, scheduling, fan-in, back-pressure)
  base/
    poll-channel.js         # Base class for polled channels
    tail-channel.js         # Base class for JSONL-tail channels
    event-channel.js        # Base class for push-event channels
    watch-channel.js        # Base class for fs-watcher channels
  build/
    git-channel.js
    gh-channel.js
    fswatch-channel.js
  work/
    agenda-channel.js
    live-problems-channel.js
    goals-channel.js
    crons-channel.js
    heartbeat-channel.js
  domain/
    pressure-channel.js
    health-channel.js
    sauna-channel.js
    weather-channel.js
  machine/
    cpu-channel.js
    memory-channel.js
    disk-channel.js
    network-channel.js
    ports-channel.js
  os/
    pm2-channel.js
    cron-channel.js
    fswatch-home23-channel.js
    syslog-channel.js
  neighbor/
    neighbor-channel.js
  notify/
    notify-channel.js       # Wraps existing promoter flow as first bus consumer
engine/src/cognition/
  closer.js                 # Goal termination, dedupe-before-spawn, warning resolution
  decay-worker.js           # Warning/transform/edge decay
  role-schemas.js           # Role output schemas + enforcement
engine/src/publish/
  workspace-insights.js
  dream-log.js
  signals-publisher.js
  bridge-chat-publisher.js
  dashboard-publisher.js
  publish-ledger.js         # Cadence tracking + starvation detection
```

### Harness (TS)
```
src/agent/
  verification.ts           # VerificationFlag enum + type guards
  neighbor-state.ts         # Public state JSON generator + route
  observation-ingress.ts    # Harness-side bridge feeding bus from harness events
```

### Tests
```
tests/engine/
  channels/
    contract.test.js
    bus.test.js
    base/
      poll-channel.test.js
      tail-channel.test.js
      event-channel.test.js
      watch-channel.test.js
    build/*.test.js
    work/*.test.js
    domain/*.test.js
    machine/*.test.js
    os/*.test.js
    neighbor/neighbor-channel.test.js
    notify/notify-channel.test.js
  cognition/
    closer.test.js
    decay-worker.test.js
    role-schemas.test.js
  publish/*.test.js
  integration/
    bus-to-memory.test.js
    phase2-e2e.test.js
tests/agent/
  verification.test.ts
  neighbor-state.test.ts
  observation-ingress.test.ts
```

### Modified existing files
- `engine/src/cognition/thinking-machine.js` — wrap phases with observe/crystallize/close/publish; enforce role schemas
- `engine/src/cognition/discovery-engine.js` — external-candidate hook; new signals
- `engine/src/cognition/deep-dive.js` — observation-context hook
- `engine/src/cognition/critique.js` — verdict-required contract
- `engine/src/core/curator-cycle.js` — curator schema enforcement
- `src/agent/memory-objects.ts` — ingest path from bus; channel-class caps; receipts
- `src/workers/promoter.ts` — becomes a channel-bus consumer
- `src/sibling/protocol.ts` — adds public-state endpoint client
- `src/types.ts` — `HomeConfig.osEngine` block
- `src/home.ts` — passes osEngine config through
- `config/home.yaml` — osEngine defaults
- `engine/src/index.js` — boot registers bus + decay worker + closer + publisher
- `package.json` — test script includes new engine tests

---

## Phase 0 — Scaffolding (no behavior change)

Goal: land every new module as a no-op so subsequent phases only have to fill in logic, not wire up plumbing. Engine starts, nothing observable changes, CI passes.

### Task 0.1: Create VerificationFlag enum + type guards

**Files:**
- Create: `src/agent/verification.ts`
- Test: `tests/agent/verification.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/agent/verification.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  VerificationFlag,
  isVerifiedObservation,
  isZeroContext,
  isCollected,
} from '../../src/agent/verification.js';

test('VerificationFlag enum has the four required values', () => {
  assert.equal(VerificationFlag.COLLECTED, 'COLLECTED');
  assert.equal(VerificationFlag.UNCERTIFIED, 'UNCERTIFIED');
  assert.equal(VerificationFlag.ZERO_CONTEXT, 'ZERO_CONTEXT');
  assert.equal(VerificationFlag.UNKNOWN, 'UNKNOWN');
});

test('isVerifiedObservation recognizes a valid observation', () => {
  const obs = {
    channelId: 'build.git',
    sourceRef: 'commit:abc123',
    receivedAt: '2026-04-21T15:00:00Z',
    producedAt: '2026-04-21T15:00:00Z',
    flag: VerificationFlag.COLLECTED,
    confidence: 0.9,
    payload: { sha: 'abc123' },
  };
  assert.equal(isVerifiedObservation(obs), true);
});

test('isZeroContext distinguishes ZERO_CONTEXT from other flags', () => {
  assert.equal(isZeroContext({ flag: VerificationFlag.ZERO_CONTEXT } as any), true);
  assert.equal(isZeroContext({ flag: VerificationFlag.COLLECTED } as any), false);
});

test('isCollected only true for COLLECTED', () => {
  assert.equal(isCollected({ flag: VerificationFlag.COLLECTED } as any), true);
  assert.equal(isCollected({ flag: VerificationFlag.UNCERTIFIED } as any), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test tests/agent/verification.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement verification module**

```typescript
// src/agent/verification.ts
export enum VerificationFlag {
  COLLECTED = 'COLLECTED',
  UNCERTIFIED = 'UNCERTIFIED',
  ZERO_CONTEXT = 'ZERO_CONTEXT',
  UNKNOWN = 'UNKNOWN',
}

export interface VerifiedObservation<T = unknown> {
  channelId: string;
  sourceRef: string;
  receivedAt: string;
  producedAt: string;
  flag: VerificationFlag;
  confidence: number;
  payload: T;
  verifierId?: string;
}

export function isVerifiedObservation(x: unknown): x is VerifiedObservation {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.channelId === 'string' &&
    typeof o.sourceRef === 'string' &&
    typeof o.receivedAt === 'string' &&
    typeof o.producedAt === 'string' &&
    typeof o.confidence === 'number' &&
    typeof o.flag === 'string' &&
    (Object.values(VerificationFlag) as string[]).includes(o.flag as string)
  );
}

export function isZeroContext(obs: VerifiedObservation): boolean {
  return obs.flag === VerificationFlag.ZERO_CONTEXT;
}

export function isCollected(obs: VerifiedObservation): boolean {
  return obs.flag === VerificationFlag.COLLECTED;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test tests/agent/verification.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Add to package.json test script**

Modify `package.json` `scripts.test` — append ` tests/agent/verification.test.ts` to the existing list.

- [ ] **Step 6: Commit**

```bash
git add src/agent/verification.ts tests/agent/verification.test.ts package.json
git commit -m "feat(step24): VerificationFlag enum + type guards"
```

---

### Task 0.2: Create Channel contract and VerifiedObservation carrier

**Files:**
- Create: `engine/src/channels/contract.js`
- Test: `tests/engine/channels/contract.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// tests/engine/channels/contract.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ChannelClass,
  Channel,
  makeObservation,
  VERIFICATION_FLAGS,
} from '../../../engine/src/channels/contract.js';

test('ChannelClass enum lists the six classes', () => {
  assert.deepEqual(Object.keys(ChannelClass).sort(), [
    'BUILD', 'DOMAIN', 'MACHINE', 'NEIGHBOR', 'OS', 'WORK',
  ]);
});

test('VERIFICATION_FLAGS mirrors the harness enum', () => {
  assert.deepEqual(VERIFICATION_FLAGS.sort(), [
    'COLLECTED', 'UNCERTIFIED', 'UNKNOWN', 'ZERO_CONTEXT',
  ]);
});

test('makeObservation builds a well-formed record', () => {
  const obs = makeObservation({
    channelId: 'build.git',
    sourceRef: 'commit:deadbeef',
    payload: { sha: 'deadbeef' },
    flag: 'COLLECTED',
    confidence: 0.9,
    producedAt: '2026-04-21T15:00:00Z',
  });
  assert.equal(obs.channelId, 'build.git');
  assert.equal(obs.flag, 'COLLECTED');
  assert.ok(obs.receivedAt);
});

test('Channel abstract methods throw when not overridden', async () => {
  const c = new Channel({ id: 'x.y', class: ChannelClass.BUILD });
  await assert.rejects(() => c.source(), /not implemented/);
  assert.throws(() => c.parse({}), /not implemented/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/engine/channels/contract.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement contract module**

```javascript
// engine/src/channels/contract.js
'use strict';

export const ChannelClass = Object.freeze({
  MACHINE:  'machine',
  OS:       'os',
  DOMAIN:   'domain',
  BUILD:    'build',
  WORK:     'work',
  NEIGHBOR: 'neighbor',
});

export const VERIFICATION_FLAGS = Object.freeze([
  'COLLECTED', 'UNCERTIFIED', 'ZERO_CONTEXT', 'UNKNOWN',
]);

export function makeObservation({
  channelId,
  sourceRef,
  payload,
  flag,
  confidence,
  producedAt,
  verifierId,
}) {
  if (!VERIFICATION_FLAGS.includes(flag)) {
    throw new Error(`invalid verification flag: ${flag}`);
  }
  if (typeof confidence !== 'number' || confidence < 0 || confidence > 1) {
    throw new Error(`confidence must be 0..1, got ${confidence}`);
  }
  return {
    channelId,
    sourceRef,
    payload,
    flag,
    confidence,
    producedAt,
    receivedAt: new Date().toISOString(),
    verifierId: verifierId || null,
  };
}

export class Channel {
  constructor({ id, class: cls }) {
    if (!id) throw new Error('Channel requires id');
    if (!cls) throw new Error('Channel requires class');
    this.id = id;
    this.class = cls;
  }
  // Subclasses must override:
  async source() { throw new Error('Channel.source() not implemented'); }
  parse(_raw)    { throw new Error('Channel.parse() not implemented'); }
  verify(parsed, _ctx) { return { ...parsed, flag: 'COLLECTED', confidence: 0.9 }; }
  crystallize(_verified) { return null; }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/engine/channels/contract.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add engine/src/channels/contract.js tests/engine/channels/contract.test.js
git commit -m "feat(step24): channel contract + VerifiedObservation carrier"
```

---

### Task 0.3: Implement PollChannel base class

**Files:**
- Create: `engine/src/channels/base/poll-channel.js`
- Test: `tests/engine/channels/base/poll-channel.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// tests/engine/channels/base/poll-channel.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PollChannel } from '../../../../engine/src/channels/base/poll-channel.js';
import { ChannelClass } from '../../../../engine/src/channels/contract.js';

class FakePoll extends PollChannel {
  constructor() {
    super({ id: 'test.fake', class: ChannelClass.MACHINE, intervalMs: 10 });
    this.count = 0;
  }
  async poll() { this.count += 1; return [{ n: this.count }]; }
  parse(raw) { return { payload: raw, sourceRef: `n:${raw.n}`, producedAt: new Date().toISOString() }; }
}

test('PollChannel yields observations at configured interval', async () => {
  const ch = new FakePoll();
  const observed = [];
  const iter = ch.source();
  ch.start();
  const limit = 3;
  for await (const raw of iter) {
    observed.push(raw);
    if (observed.length >= limit) break;
  }
  ch.stop();
  assert.equal(observed.length, limit);
  assert.equal(observed[0].n, 1);
});

test('PollChannel stops yielding after stop()', async () => {
  const ch = new FakePoll();
  ch.start();
  ch.stop();
  const iter = ch.source();
  const result = await Promise.race([
    iter.next(),
    new Promise((r) => setTimeout(() => r({ done: true, value: undefined }), 50)),
  ]);
  assert.equal(result.done, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/engine/channels/base/poll-channel.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement PollChannel**

```javascript
// engine/src/channels/base/poll-channel.js
'use strict';

import { Channel } from '../contract.js';

export class PollChannel extends Channel {
  constructor({ id, class: cls, intervalMs }) {
    super({ id, class: cls });
    if (typeof intervalMs !== 'number' || intervalMs <= 0) {
      throw new Error(`PollChannel requires positive intervalMs, got ${intervalMs}`);
    }
    this.intervalMs = intervalMs;
    this._running = false;
    this._queue = [];
    this._waiters = [];
    this._timer = null;
  }

  start() {
    if (this._running) return;
    this._running = true;
    const tick = async () => {
      if (!this._running) return;
      try {
        const raws = await this.poll();
        for (const r of raws || []) this._enqueue(r);
      } catch (err) {
        this._enqueue({ __error: err.message });
      }
      if (this._running) {
        this._timer = setTimeout(tick, this.intervalMs);
      }
    };
    // First tick immediate; subsequent on interval
    this._timer = setTimeout(tick, 0);
  }

  stop() {
    this._running = false;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    // Resolve any pending waiters with done
    for (const w of this._waiters) w.resolve({ done: true, value: undefined });
    this._waiters = [];
  }

  _enqueue(raw) {
    if (this._waiters.length) {
      const w = this._waiters.shift();
      w.resolve({ done: false, value: raw });
    } else {
      this._queue.push(raw);
    }
  }

  async *source() {
    while (this._running || this._queue.length) {
      if (this._queue.length) {
        yield this._queue.shift();
        continue;
      }
      const next = await new Promise((resolve) => this._waiters.push({ resolve }));
      if (next.done) return;
      yield next.value;
    }
  }

  // Subclass contract:
  async poll() { throw new Error('PollChannel.poll() not implemented'); }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/engine/channels/base/poll-channel.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add engine/src/channels/base/poll-channel.js tests/engine/channels/base/poll-channel.test.js
git commit -m "feat(step24): PollChannel base class"
```

---

### Task 0.4: Implement TailChannel base class

**Files:**
- Create: `engine/src/channels/base/tail-channel.js`
- Test: `tests/engine/channels/base/tail-channel.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// tests/engine/channels/base/tail-channel.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TailChannel } from '../../../../engine/src/channels/base/tail-channel.js';
import { ChannelClass } from '../../../../engine/src/channels/contract.js';

class FakeTail extends TailChannel {
  constructor(path) {
    super({ id: 'test.tail', class: ChannelClass.WORK, path });
  }
  parseLine(line) {
    if (!line.trim()) return null;
    return { payload: JSON.parse(line), sourceRef: `line:${line.slice(0, 16)}`, producedAt: new Date().toISOString() };
  }
}

test('TailChannel emits each new JSONL line as an observation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tail-'));
  const path = join(dir, 'log.jsonl');
  writeFileSync(path, '');
  const ch = new FakeTail(path);
  ch.start();
  // Write two lines after starting
  appendFileSync(path, JSON.stringify({ a: 1 }) + '\n');
  appendFileSync(path, JSON.stringify({ a: 2 }) + '\n');
  const out = [];
  for await (const parsed of ch.source()) {
    out.push(parsed);
    if (out.length >= 2) break;
  }
  ch.stop();
  assert.equal(out.length, 2);
  assert.equal(out[0].payload.a, 1);
  assert.equal(out[1].payload.a, 2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/engine/channels/base/tail-channel.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement TailChannel**

```javascript
// engine/src/channels/base/tail-channel.js
'use strict';

import { createReadStream, statSync, watch, existsSync, openSync, closeSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { Channel } from '../contract.js';

export class TailChannel extends Channel {
  constructor({ id, class: cls, path, fromStart = false }) {
    super({ id, class: cls });
    if (!path) throw new Error('TailChannel requires path');
    this.path = path;
    this._running = false;
    this._position = fromStart ? 0 : null;
    this._queue = [];
    this._waiters = [];
    this._watcher = null;
  }

  async start() {
    if (this._running) return;
    this._running = true;
    if (!existsSync(this.path)) {
      // Touch file so watch works
      closeSync(openSync(this.path, 'a'));
    }
    if (this._position === null) {
      try { this._position = statSync(this.path).size; } catch { this._position = 0; }
    }
    this._watcher = watch(this.path, { persistent: false }, () => this._readIncrement());
    // Initial sweep if fromStart
    await this._readIncrement();
  }

  stop() {
    this._running = false;
    if (this._watcher) { this._watcher.close(); this._watcher = null; }
    for (const w of this._waiters) w.resolve({ done: true, value: undefined });
    this._waiters = [];
  }

  async _readIncrement() {
    if (!this._running) return;
    let size;
    try { size = statSync(this.path).size; } catch { return; }
    if (size <= this._position) return;
    await new Promise((resolve) => {
      const stream = createReadStream(this.path, { start: this._position, end: size - 1 });
      const rl = createInterface({ input: stream });
      rl.on('line', (line) => {
        const parsed = this.parseLine(line);
        if (parsed) this._enqueue(parsed);
      });
      rl.on('close', () => { this._position = size; resolve(); });
      rl.on('error', resolve);
    });
  }

  _enqueue(item) {
    if (this._waiters.length) {
      const w = this._waiters.shift();
      w.resolve({ done: false, value: item });
    } else {
      this._queue.push(item);
    }
  }

  async *source() {
    while (this._running || this._queue.length) {
      if (this._queue.length) { yield this._queue.shift(); continue; }
      const next = await new Promise((resolve) => this._waiters.push({ resolve }));
      if (next.done) return;
      yield next.value;
    }
  }

  parseLine(_line) { throw new Error('TailChannel.parseLine() not implemented'); }

  // TailChannel pre-parses; Channel.parse passthrough.
  parse(preParsed) { return preParsed; }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/engine/channels/base/tail-channel.test.js`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add engine/src/channels/base/tail-channel.js tests/engine/channels/base/tail-channel.test.js
git commit -m "feat(step24): TailChannel base class"
```

---

### Task 0.5: Implement WatchChannel base class

**Files:**
- Create: `engine/src/channels/base/watch-channel.js`
- Test: `tests/engine/channels/base/watch-channel.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// tests/engine/channels/base/watch-channel.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WatchChannel } from '../../../../engine/src/channels/base/watch-channel.js';
import { ChannelClass } from '../../../../engine/src/channels/contract.js';

class FakeWatch extends WatchChannel {
  constructor(dir) { super({ id: 'test.watch', class: ChannelClass.BUILD, paths: [dir] }); }
  parseEvent(evt) { return { payload: evt, sourceRef: `${evt.type}:${evt.path}`, producedAt: new Date().toISOString() }; }
}

test('WatchChannel emits events on file add', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'watch-'));
  const ch = new FakeWatch(dir);
  await ch.start();
  writeFileSync(join(dir, 'hello.txt'), 'x');
  const out = [];
  for await (const parsed of ch.source()) {
    out.push(parsed);
    if (out.length >= 1) break;
  }
  ch.stop();
  assert.ok(out.length >= 1);
  assert.ok(out[0].payload.path.endsWith('hello.txt'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/engine/channels/base/watch-channel.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement WatchChannel using chokidar**

```javascript
// engine/src/channels/base/watch-channel.js
'use strict';

import chokidar from 'chokidar';
import { Channel } from '../contract.js';

export class WatchChannel extends Channel {
  constructor({ id, class: cls, paths, ignored }) {
    super({ id, class: cls });
    if (!Array.isArray(paths) || paths.length === 0) {
      throw new Error('WatchChannel requires at least one path');
    }
    this.paths = paths;
    this.ignored = ignored || /(^|[/\\])\../;
    this._running = false;
    this._queue = [];
    this._waiters = [];
    this._watcher = null;
  }

  async start() {
    if (this._running) return;
    this._running = true;
    this._watcher = chokidar.watch(this.paths, { ignored: this.ignored, ignoreInitial: true, persistent: false });
    for (const type of ['add', 'change', 'unlink', 'addDir', 'unlinkDir']) {
      this._watcher.on(type, (path) => {
        const parsed = this.parseEvent({ type, path, ts: new Date().toISOString() });
        if (parsed) this._enqueue(parsed);
      });
    }
    await new Promise((r) => this._watcher.once('ready', r));
  }

  stop() {
    this._running = false;
    if (this._watcher) { this._watcher.close(); this._watcher = null; }
    for (const w of this._waiters) w.resolve({ done: true, value: undefined });
    this._waiters = [];
  }

  _enqueue(item) {
    if (this._waiters.length) {
      const w = this._waiters.shift();
      w.resolve({ done: false, value: item });
    } else {
      this._queue.push(item);
    }
  }

  async *source() {
    while (this._running || this._queue.length) {
      if (this._queue.length) { yield this._queue.shift(); continue; }
      const next = await new Promise((resolve) => this._waiters.push({ resolve }));
      if (next.done) return;
      yield next.value;
    }
  }

  parseEvent(_evt) { throw new Error('WatchChannel.parseEvent() not implemented'); }
  parse(preParsed) { return preParsed; }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/engine/channels/base/watch-channel.test.js`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add engine/src/channels/base/watch-channel.js tests/engine/channels/base/watch-channel.test.js
git commit -m "feat(step24): WatchChannel base class (chokidar)"
```

---

### Task 0.6: Implement the universal channel bus

**Files:**
- Create: `engine/src/channels/bus.js`
- Test: `tests/engine/channels/bus.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// tests/engine/channels/bus.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelBus } from '../../../engine/src/channels/bus.js';
import { PollChannel } from '../../../engine/src/channels/base/poll-channel.js';
import { ChannelClass, makeObservation } from '../../../engine/src/channels/contract.js';

class FakeChan extends PollChannel {
  constructor() { super({ id: 'fake.one', class: ChannelClass.MACHINE, intervalMs: 5 }); this.n = 0; }
  async poll() { this.n += 1; return [{ n: this.n }]; }
  parse(raw) { return { payload: raw, sourceRef: `n:${raw.n}`, producedAt: new Date().toISOString() }; }
  verify(parsed) { return makeObservation({
    channelId: this.id, sourceRef: parsed.sourceRef, payload: parsed.payload,
    flag: 'COLLECTED', confidence: 0.9, producedAt: parsed.producedAt,
  }); }
  crystallize() { return null; }
}

test('ChannelBus accepts registration and starts channels', async () => {
  const bus = new ChannelBus({ persistenceDir: null });
  const ch = new FakeChan();
  bus.register(ch);
  assert.equal(bus.channels.length, 1);
});

test('ChannelBus fans in observations across channels', async () => {
  const bus = new ChannelBus({ persistenceDir: null });
  bus.register(new FakeChan());
  const got = [];
  bus.on('observation', (obs) => { got.push(obs); if (got.length >= 3) bus.stop(); });
  await bus.start();
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(got.length >= 3);
  assert.equal(got[0].channelId, 'fake.one');
  assert.equal(got[0].flag, 'COLLECTED');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/engine/channels/bus.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement ChannelBus**

```javascript
// engine/src/channels/bus.js
'use strict';

import { EventEmitter } from 'node:events';
import { mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

export class ChannelBus extends EventEmitter {
  constructor({ persistenceDir, logger } = {}) {
    super();
    this.channels = [];
    this.persistenceDir = persistenceDir || null;
    this.logger = logger || console;
    this._running = false;
    this._pumps = new Map(); // channelId -> AsyncIterator
  }

  register(channel) {
    if (!channel || !channel.id) throw new Error('ChannelBus.register requires a channel with id');
    if (this.channels.find((c) => c.id === channel.id)) {
      throw new Error(`duplicate channel id: ${channel.id}`);
    }
    this.channels.push(channel);
  }

  async start() {
    if (this._running) return;
    this._running = true;
    if (this.persistenceDir) mkdirSync(this.persistenceDir, { recursive: true });
    for (const ch of this.channels) {
      if (typeof ch.start === 'function') await ch.start();
      this._pumpChannel(ch);
    }
  }

  async stop() {
    this._running = false;
    for (const ch of this.channels) {
      try { if (typeof ch.stop === 'function') await ch.stop(); } catch {}
    }
  }

  _pumpChannel(channel) {
    const iter = channel.source();
    this._pumps.set(channel.id, iter);
    (async () => {
      try {
        for await (const raw of iter) {
          if (!this._running) break;
          await this._handleRaw(channel, raw);
        }
      } catch (err) {
        this.logger.error?.(`[bus] channel ${channel.id} failed:`, err?.message || err);
      }
    })();
  }

  async _handleRaw(channel, raw) {
    try {
      const parsed = raw && raw.payload ? raw : channel.parse(raw);
      const obs = channel.verify(parsed, {});
      if (!obs || !obs.flag) return;
      this._persist(channel, obs);
      this.emit('observation', obs);
      const draft = channel.crystallize(obs);
      if (draft) this.emit('crystallize', { channel, observation: obs, draft });
    } catch (err) {
      this.logger.warn?.(`[bus] handle failed on ${channel.id}:`, err?.message || err);
    }
  }

  _persist(channel, obs) {
    if (!this.persistenceDir) return;
    const path = join(this.persistenceDir, `${channel.class}.${channel.id}.jsonl`);
    try { appendFileSync(path, JSON.stringify(obs) + '\n'); } catch (err) {
      this.logger.warn?.(`[bus] persist failed for ${channel.id}:`, err?.message || err);
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/engine/channels/bus.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add engine/src/channels/bus.js tests/engine/channels/bus.test.js
git commit -m "feat(step24): universal channel bus (register/start/fan-in/persist)"
```

---

### Task 0.7: Add HomeConfig.osEngine type + defaults

**Files:**
- Modify: `src/types.ts`
- Modify: `config/home.yaml`

- [ ] **Step 1: Locate the HomeConfig type**

Run: `grep -n "HomeConfig" src/types.ts | head -5`

Open `src/types.ts` and find the `HomeConfig` interface.

- [ ] **Step 2: Add OsEngineConfig type + optional field**

Append to `src/types.ts`:

```typescript
export interface OsEngineConfig {
  channels?: {
    machine?: { enabled?: boolean; polls?: Record<string, string> };
    os?: { enabled?: boolean; pm2?: { events?: boolean; poll?: string }; cron?: { events?: boolean }; fswatch?: { paths?: string[] } };
    domain?: { enabled?: boolean; readers?: Record<string, { path: string; tail?: boolean }> };
    build?: { enabled?: boolean; git?: { poll?: string; watch_branches?: string[] }; gh?: { pr_state?: boolean; poll?: string } };
    work?: { enabled?: boolean; readers?: Record<string, { path: string; tail?: boolean; poll?: string; watch?: boolean }> };
    neighbor?: { enabled?: boolean; poll?: string; peers?: 'auto' | string[] };
  };
  verification?: { flagRequired?: boolean; zeroContextAsLegal?: boolean };
  crystallization?: {
    backpressure?: { cyclesWithoutReceiptThreshold?: number };
    confidenceCaps?: Record<string, number>;
  };
  decay?: { worker?: { cadence?: string }; halfLife?: Record<string, string> };
  roleIntegrity?: { enforce?: boolean; rejectLogPath?: string };
  closer?: { terminationContractRequired?: boolean; dedupeBeforeSpawn?: boolean };
  publish?: {
    targets?: Record<string, { cadence?: string; path?: string; salience_threshold?: number }>;
    starvationFloor?: Record<string, string>;
  };
}
```

Add `osEngine?: OsEngineConfig;` to the `HomeConfig` interface.

- [ ] **Step 3: Add default block to `config/home.yaml`**

Append to `config/home.yaml` (respect existing indentation):

```yaml
osEngine:
  channels:
    machine:  { enabled: false }
    os:       { enabled: false }
    domain:   { enabled: false }
    build:    { enabled: false }
    work:     { enabled: false }
    neighbor: { enabled: false }
  verification:
    flagRequired: true
    zeroContextAsLegal: true
  crystallization:
    backpressure: { cyclesWithoutReceiptThreshold: 10 }
    confidenceCaps:
      sensor_primary: 0.95
      sensor_derived: 0.80
      build_event: 0.90
      work_event: 0.90
      neighbor_gossip: 0.70
      zero_context_audit: 0.20
  decay:
    worker: { cadence: 30m }
    halfLife:
      warning_node: 48h
      surreal_transform: 24h
      unfinished_goal_review: 72h
      unreferenced_edge: 30d
  roleIntegrity:
    enforce: false
    rejectLogPath: brain/role-integrity-violations.jsonl
  closer:
    terminationContractRequired: false
    dedupeBeforeSpawn: false
  publish:
    targets:
      workspace_insights: { cadence: 50cycles, path: workspace/insights/ }
      signals:            { cadence: on_verdict_keep }
      bridge_chat:        { salience_threshold: 0.75 }
      dashboard:          { cadence: 5m }
      dream_log:          { cadence: on_critic_keep, path: workspace/dreams/ }
    starvationFloor:
      workspace_insights: 6h
      dashboard: 15m
```

Note defaults: all channel classes, roleIntegrity enforcement, and closer contracts are OFF by default. They will be flipped ON in the phase that activates them.

- [ ] **Step 4: Build to verify TS compiles**

Run: `npm run build`
Expected: clean build.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts config/home.yaml
git commit -m "feat(step24): HomeConfig.osEngine types + default block (all off)"
```

---

### Task 0.8: Boot the empty bus from the engine

**Files:**
- Modify: `engine/src/index.js`
- Test: integration via pm2 restart + grep logs

- [ ] **Step 1: Locate the engine boot sequence**

Run: `grep -n "orchestrator\|start\|ChannelBus" engine/src/index.js | head -20`

- [ ] **Step 2: Import and instantiate the bus at boot**

In `engine/src/index.js`, near the top-level requires/imports, add:

```javascript
import { ChannelBus } from './channels/bus.js';
```

Near the place where other long-running subsystems are constructed (e.g. where `orchestrator` or `cognitionRunner` is started), add:

```javascript
const channelBusPersistenceDir = join(runtimeDir, 'channels');
const channelBus = new ChannelBus({ persistenceDir: channelBusPersistenceDir, logger });
// No channels registered in Phase 0 — bus is dormant by design.
await channelBus.start();
logger.info?.('[channels] bus started (no channels registered — Phase 0 scaffolding)');
```

Also wire bus stop into the existing shutdown handler:

```javascript
// In the existing graceful-shutdown path:
try { await channelBus.stop(); } catch (err) { logger.warn?.('[channels] stop failed:', err?.message); }
```

Export `channelBus` on the module-level context object so downstream code (thinking-machine, promoter) can grab it in later phases.

- [ ] **Step 3: Restart one agent and verify log line**

Run: `pm2 restart home23-jerry`
Then: `pm2 logs home23-jerry --lines 50 --nostream | grep channels`
Expected: a line containing `[channels] bus started`.

- [ ] **Step 4: Verify no regression**

Run: `pm2 logs home23-jerry --err --lines 50 --nostream`
Expected: no new errors since the restart.

- [ ] **Step 5: Commit**

```bash
git add engine/src/index.js
git commit -m "feat(step24): boot empty ChannelBus in engine (no channels yet)"
```

---

### Task 0.9: Scaffold closer, decay-worker, role-schemas (all no-ops)

**Files:**
- Create: `engine/src/cognition/closer.js`
- Create: `engine/src/cognition/decay-worker.js`
- Create: `engine/src/cognition/role-schemas.js`
- Test: `tests/engine/cognition/closer.test.js`
- Test: `tests/engine/cognition/decay-worker.test.js`
- Test: `tests/engine/cognition/role-schemas.test.js`

- [ ] **Step 1: Write the failing tests**

```javascript
// tests/engine/cognition/closer.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Closer } from '../../../engine/src/cognition/closer.js';
test('Closer constructs with dependencies and runs a no-op close', async () => {
  const c = new Closer({ memory: {}, goals: {}, logger: console, enabled: false });
  const r = await c.close();
  assert.deepEqual(r, { closed: [], deduped: [], resolved: [] });
});
```

```javascript
// tests/engine/cognition/decay-worker.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DecayWorker } from '../../../engine/src/cognition/decay-worker.js';
test('DecayWorker constructs and idles until enabled', async () => {
  const w = new DecayWorker({ memory: {}, logger: console, enabled: false });
  const r = await w.tick();
  assert.equal(r.decayed, 0);
});
```

```javascript
// tests/engine/cognition/role-schemas.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROLE_SCHEMAS, validateRoleOutput } from '../../../engine/src/cognition/role-schemas.js';
test('ROLE_SCHEMAS has entries for critic/discovery/deep_dive/connect/curator', () => {
  for (const role of ['critic', 'discovery', 'deep_dive', 'connect', 'curator']) {
    assert.ok(ROLE_SCHEMAS[role], `missing schema for ${role}`);
  }
});
test('validateRoleOutput passes everything in soft mode', () => {
  const r = validateRoleOutput('critic', { anything: true }, { strict: false });
  assert.equal(r.valid, true);
});
```

- [ ] **Step 2: Run tests — expect failures**

Run: `node --test tests/engine/cognition/closer.test.js tests/engine/cognition/decay-worker.test.js tests/engine/cognition/role-schemas.test.js`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement the three scaffolds**

```javascript
// engine/src/cognition/closer.js
'use strict';
export class Closer {
  constructor({ memory, goals, logger, enabled = false }) {
    this.memory = memory; this.goals = goals; this.logger = logger || console; this.enabled = enabled;
  }
  async close() {
    if (!this.enabled) return { closed: [], deduped: [], resolved: [] };
    // Real logic lands in Phase 7.
    return { closed: [], deduped: [], resolved: [] };
  }
  async dedupeBeforeSpawn(_goal) { if (!this.enabled) return null; return null; }
  async resolveWarning(_node)    { if (!this.enabled) return false; return false; }
}
```

```javascript
// engine/src/cognition/decay-worker.js
'use strict';
export class DecayWorker {
  constructor({ memory, logger, enabled = false, cadenceMs = 30 * 60 * 1000 }) {
    this.memory = memory; this.logger = logger || console; this.enabled = enabled; this.cadenceMs = cadenceMs;
    this._timer = null;
  }
  async tick() {
    if (!this.enabled) return { decayed: 0 };
    // Real logic lands in Phase 5.
    return { decayed: 0 };
  }
  start() {
    if (this._timer) return;
    const loop = async () => { try { await this.tick(); } catch (err) { this.logger.warn?.('[decay] tick failed:', err?.message); } this._timer = setTimeout(loop, this.cadenceMs); };
    this._timer = setTimeout(loop, this.cadenceMs);
  }
  stop() { if (this._timer) { clearTimeout(this._timer); this._timer = null; } }
}
```

```javascript
// engine/src/cognition/role-schemas.js
'use strict';

// Phase 6 fills these with real schemas + enforcement. Phase 0 scaffolds structure.
export const ROLE_SCHEMAS = Object.freeze({
  critic:    { required: ['claim', 'evidence_for', 'evidence_against', 'verdict'] },
  discovery: { required: ['candidate', 'signal_type', 'supporting_observations', 'novelty_score'] },
  deep_dive: { required: ['candidate', 'lineage', 'observations_consulted', 'proposed_edges', 'open_questions'] },
  connect:   { required: ['source_node', 'target_node', 'weight', 'supporting_observations'] },
  curator:   { required: ['surface', 'proposed_text', 'source_observations', 'confidence'] },
});

export function validateRoleOutput(role, output, { strict = false } = {}) {
  const schema = ROLE_SCHEMAS[role];
  if (!schema) return { valid: false, reason: `unknown role: ${role}` };
  if (!strict) return { valid: true, reason: 'soft-mode: always pass' };
  if (!output || typeof output !== 'object') return { valid: false, reason: 'output must be object' };
  const missing = schema.required.filter((k) => !(k in output));
  if (missing.length) return { valid: false, reason: `missing fields: ${missing.join(', ')}` };
  return { valid: true };
}
```

- [ ] **Step 4: Run tests — expect pass**

Run: `node --test tests/engine/cognition/closer.test.js tests/engine/cognition/decay-worker.test.js tests/engine/cognition/role-schemas.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Wire into engine boot (construct, don't activate)**

In `engine/src/index.js`, import and construct:

```javascript
import { Closer } from './cognition/closer.js';
import { DecayWorker } from './cognition/decay-worker.js';

const closer = new Closer({ memory, goals: goalSystem, logger, enabled: config.osEngine?.closer?.terminationContractRequired === true });
const decay = new DecayWorker({ memory, logger, enabled: false });
// Neither starts anything in Phase 0.
```

Expose both on the engine context object for future phases.

- [ ] **Step 6: Restart agent, verify clean boot**

Run: `pm2 restart home23-jerry && sleep 2 && pm2 logs home23-jerry --err --lines 30 --nostream`
Expected: no new errors.

- [ ] **Step 7: Commit**

```bash
git add engine/src/cognition/closer.js engine/src/cognition/decay-worker.js engine/src/cognition/role-schemas.js tests/engine/cognition/ engine/src/index.js
git commit -m "feat(step24): scaffold Closer, DecayWorker, role-schemas (no-ops)"
```

---

### Task 0.10: Add engine tests to the test script

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Update test script to include engine test directory**

Modify `package.json` scripts:

```json
"test": "node --import tsx --test --test-concurrency=1 tests/agent/brain-route-resolver.test.ts tests/agent/tools/brain.test.ts tests/agent/tools/research.test.ts tests/agent/verification.test.ts tests/dashboard/chat-state.test.ts && node --test --test-concurrency=1 'tests/engine/**/*.test.js'"
```

- [ ] **Step 2: Run full test suite**

Run: `npm test`
Expected: all tests pass (harness + engine).

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "chore(step24): include engine tests in npm test"
```

---

### Phase 0 verification

- [ ] `pm2 restart home23-jerry` — boots clean, log line `[channels] bus started` present.
- [ ] `npm test` — all green.
- [ ] No behavior change visible in jerry's dive-mode queries (bus has no channels; everything is a scaffold).

---


## Phase 1 — Promoter as first channel (bus contract proof)

Goal: port `src/workers/promoter.ts` behind the bus's `notify` channel. Functionally identical behavior, but proves the bus contract is compatible with verifier-gated ingest. No regressions in live-problems promotion.

### Task 1.1: Wrap existing notify-stream reader as a NotifyChannel

**Files:**
- Create: `engine/src/channels/notify/notify-channel.js`
- Test: `tests/engine/channels/notify/notify-channel.test.js`

- [ ] **Step 1: Identify the current NOTIFY source**

Run: `grep -n "notifications\.jsonl\|notify" src/workers/promoter.ts | head -20`

Note the exact file path the promoter drains. Typical: `instances/<agent>/brain/notifications.jsonl` (or similar).

- [ ] **Step 2: Write failing test**

```javascript
// tests/engine/channels/notify/notify-channel.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, appendFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NotifyChannel } from '../../../../engine/src/channels/notify/notify-channel.js';

test('NotifyChannel emits each new NOTIFY line as a parsed observation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'notify-'));
  const path = join(dir, 'notifications.jsonl');
  writeFileSync(path, '');
  const ch = new NotifyChannel({ path });
  await ch.start();
  appendFileSync(path, JSON.stringify({ kind: 'problem', summary: 'disk full', ts: '2026-04-21T00:00:00Z' }) + '\n');
  const out = [];
  for await (const obs of ch.source()) {
    const verified = ch.verify(obs);
    out.push(verified);
    if (out.length >= 1) break;
  }
  ch.stop();
  assert.equal(out.length, 1);
  assert.equal(out[0].channelId, 'notify.cognition');
  assert.equal(out[0].payload.summary, 'disk full');
  assert.ok(['COLLECTED', 'UNCERTIFIED'].includes(out[0].flag));
});
```

- [ ] **Step 3: Implement NotifyChannel**

```javascript
// engine/src/channels/notify/notify-channel.js
'use strict';

import { TailChannel } from '../base/tail-channel.js';
import { ChannelClass, makeObservation } from '../contract.js';

export class NotifyChannel extends TailChannel {
  constructor({ path, id = 'notify.cognition' }) {
    // Treat notify as WORK-class for priority (agent self-reported signals about its own work)
    super({ id, class: ChannelClass.WORK, path });
  }
  parseLine(line) {
    if (!line.trim()) return null;
    let obj;
    try { obj = JSON.parse(line); } catch { return null; }
    return {
      payload: obj,
      sourceRef: `notify:${obj.ts || ''}:${(obj.kind || '').slice(0, 16)}`,
      producedAt: obj.ts || new Date().toISOString(),
    };
  }
  verify(parsed) {
    return makeObservation({
      channelId: this.id,
      sourceRef: parsed.sourceRef,
      payload: parsed.payload,
      flag: 'UNCERTIFIED',   // NOTIFY events require promoter classification before promotion
      confidence: 0.5,
      producedAt: parsed.producedAt,
      verifierId: 'notify:basic',
    });
  }
  crystallize() { return null; } // Promoter decides; channel only emits
}
```

- [ ] **Step 4: Run test**

Run: `node --test tests/engine/channels/notify/notify-channel.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add engine/src/channels/notify/ tests/engine/channels/notify/
git commit -m "feat(step24): NotifyChannel wraps NOTIFY stream as bus channel"
```

---

### Task 1.2: Adapt promoter to consume from bus

**Files:**
- Modify: `src/workers/promoter.ts`
- Test: existing promoter tests (if any) + new integration test

- [ ] **Step 1: Identify promoter entry point**

Run: `grep -n "^export\|^async function\|class Promoter" src/workers/promoter.ts | head -10`

Find the function that currently loops over notify lines (likely `runPromoter()` or similar).

- [ ] **Step 2: Add a bus-consumer entry point**

Add to `src/workers/promoter.ts`:

```typescript
import type { VerifiedObservation } from '../agent/verification.js';

export async function consumeFromBus(
  obs: VerifiedObservation,
  deps: PromoterDeps,   // existing deps type
): Promise<PromoterOutcome> {
  // Reuse existing classification + verifier dry-run + promotion logic.
  // Where the old code read a raw notification object, now use obs.payload.
  return processNotification(obs.payload as NotifyRecord, deps);
}
```

The existing file-based `runPromoter()` loop stays as a fallback (for dev/test), but the primary path becomes bus-driven.

- [ ] **Step 3: Wire the engine to route bus `observation` events into the promoter**

In `engine/src/index.js`, after constructing `channelBus`:

```javascript
import { consumeFromBus as promoterConsume } from '../../src/workers/promoter.js'; // adjust import for compiled TS
channelBus.on('observation', async (obs) => {
  if (obs.channelId?.startsWith('notify.')) {
    try { await promoterConsume(obs, promoterDeps); }
    catch (err) { logger.warn?.('[promoter] consume failed:', err?.message); }
  }
});
```

- [ ] **Step 4: Register NotifyChannel at boot (when config opts in)**

```javascript
import { NotifyChannel } from './channels/notify/notify-channel.js';
if (config.osEngine?.channels?.work?.enabled !== false) {
  // Notify is always on — it represents the engine's own cognition NOTIFY stream.
  const notifyPath = join(runtimeDir, 'notifications.jsonl');
  channelBus.register(new NotifyChannel({ path: notifyPath }));
}
```

- [ ] **Step 5: Build + restart + verify parity**

```bash
npm run build
pm2 restart home23-jerry
pm2 logs home23-jerry --lines 50 --nostream | grep -E "promoter|notify|channels"
```

Expected: existing promoter log lines still appear; new `[channels] bus started` and notify-related lines coexist.

- [ ] **Step 6: Commit**

```bash
git add src/workers/promoter.ts engine/src/index.js
git commit -m "feat(step24): route NotifyChannel observations through promoter via bus"
```

---

### Task 1.3: Integration test — bus to promoter to live-problems

**Files:**
- Create: `tests/engine/integration/notify-through-bus.test.js`

- [ ] **Step 1: Write integration test**

```javascript
// tests/engine/integration/notify-through-bus.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChannelBus } from '../../../engine/src/channels/bus.js';
import { NotifyChannel } from '../../../engine/src/channels/notify/notify-channel.js';

test('Notify line written to disk reaches bus observers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'notify-int-'));
  const path = join(dir, 'notifications.jsonl');
  writeFileSync(path, '');
  const bus = new ChannelBus({ persistenceDir: dir });
  bus.register(new NotifyChannel({ path }));
  const got = [];
  bus.on('observation', (o) => got.push(o));
  await bus.start();
  appendFileSync(path, JSON.stringify({ kind: 'note', summary: 'hello', ts: '2026-04-21T00:00:00Z' }) + '\n');
  await new Promise((r) => setTimeout(r, 200));
  await bus.stop();
  assert.ok(got.length >= 1);
  assert.equal(got[0].payload.summary, 'hello');
  assert.equal(got[0].flag, 'UNCERTIFIED');
});
```

- [ ] **Step 2: Run and pass**

Run: `node --test tests/engine/integration/notify-through-bus.test.js`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/engine/integration/notify-through-bus.test.js
git commit -m "test(step24): integration notify line -> bus observer"
```

---

### Phase 1 verification

- [ ] Live-problems promotion still working (check `instances/jerry/brain/live-problems.json` gets new entries when cognition emits NOTIFY).
- [ ] No regression in existing promoter outcome distribution.
- [ ] `bus.start() / stop()` logged cleanly across pm2 restarts.

---


## Phase 2 — Build + Work channels (first OS-awareness proof-of-life)

Goal: the engine observes its own house. Build channels (git, gh, fswatch) and Work channels (agenda, live-problems, goals, crons, heartbeat) all feeding into the bus, verified, and crystallized into MemoryObjects. By end of this phase, jerry's dive-mode "Memory Nodes: 0" breaks within the first hour after restart.

### Task 2.1: Add channel-class confidence caps to MemoryObjectStore

**Files:**
- Modify: `src/agent/memory-objects.ts`
- Test: `tests/agent/memory-objects-caps.test.ts` (new)

- [ ] **Step 1: Locate existing CONFIDENCE_CAPS**

Run: `grep -n "CONFIDENCE_CAPS\|confidenceCap" src/agent/memory-objects.ts | head -10`

- [ ] **Step 2: Write failing test**

```typescript
// tests/agent/memory-objects-caps.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyChannelCap, CHANNEL_CAPS } from '../../src/agent/memory-objects.js';

test('CHANNEL_CAPS has entries per channel class/method', () => {
  for (const k of ['sensor_primary', 'sensor_derived', 'build_event', 'work_event', 'neighbor_gossip', 'zero_context_audit']) {
    assert.ok(typeof CHANNEL_CAPS[k] === 'number');
  }
});

test('applyChannelCap clamps confidence at the cap', () => {
  assert.equal(applyChannelCap('neighbor_gossip', 0.95), 0.70);
  assert.equal(applyChannelCap('build_event', 0.5), 0.5);
});
```

- [ ] **Step 3: Implement CHANNEL_CAPS + applyChannelCap**

In `src/agent/memory-objects.ts`, near existing caps:

```typescript
export const CHANNEL_CAPS: Record<string, number> = {
  sensor_primary:   0.95,
  sensor_derived:   0.80,
  build_event:      0.90,
  work_event:       0.90,
  neighbor_gossip:  0.70,
  zero_context_audit: 0.20,
};

export function applyChannelCap(method: string, confidence: number): number {
  const cap = CHANNEL_CAPS[method];
  if (cap === undefined) return confidence;
  return Math.min(confidence, cap);
}
```

- [ ] **Step 4: Run tests**

Run: `node --import tsx --test tests/agent/memory-objects-caps.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/memory-objects.ts tests/agent/memory-objects-caps.test.ts
git commit -m "feat(step24): CHANNEL_CAPS + applyChannelCap on MemoryObjectStore"
```

---

### Task 2.2: Add ingest-from-observation API to MemoryObjectStore

**Files:**
- Modify: `src/agent/memory-objects.ts`
- Test: `tests/agent/memory-objects-ingest.test.ts` (new)

- [ ] **Step 1: Write failing test**

```typescript
// tests/agent/memory-objects-ingest.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryObjectStore } from '../../src/agent/memory-objects.js';
import { VerificationFlag } from '../../src/agent/verification.js';

test('ingestObservation creates a memory object with channel-capped confidence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mos-'));
  const store = new MemoryObjectStore({ brainDir: dir });
  const written = await store.ingestObservation({
    channelId: 'build.git',
    sourceRef: 'commit:abc123',
    receivedAt: '2026-04-21T15:00:00Z',
    producedAt: '2026-04-21T15:00:00Z',
    flag: VerificationFlag.COLLECTED,
    confidence: 0.99,
    payload: { sha: 'abc123', subject: 'feat: test' },
  }, { method: 'build_event', type: 'observation', topic: 'git' });
  assert.ok(written.id);
  assert.equal(written.confidence, 0.9); // capped
  assert.equal(written.type, 'observation');
  assert.ok(written.provenance);
});

test('ingestObservation writes a crystallization receipt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mos-'));
  const store = new MemoryObjectStore({ brainDir: dir });
  await store.ingestObservation({
    channelId: 'work.agenda',
    sourceRef: 'ag-abc',
    receivedAt: '2026-04-21T15:00:00Z',
    producedAt: '2026-04-21T15:00:00Z',
    flag: VerificationFlag.COLLECTED,
    confidence: 0.9,
    payload: { content: 'test' },
  }, { method: 'work_event', type: 'observation', topic: 'agenda' });
  const receipts = store.listReceipts();
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].channelId, 'work.agenda');
});
```

- [ ] **Step 2: Implement ingest + receipt log**

In `src/agent/memory-objects.ts`:

```typescript
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { VerifiedObservation } from './verification.js';

export interface IngestOptions {
  method: string;
  type: 'observation' | 'insight' | 'procedure' | 'correction' | 'uncertainty_item';
  topic: string;
  tags?: string[];
}

// Extend the existing MemoryObjectStore class:
//   async ingestObservation(obs: VerifiedObservation, opts: IngestOptions): Promise<MemoryObject>
//   listReceipts(): CrystallizationReceipt[]
//
// Dedupe: {channelId, sourceRef, contentHash} collapse to update not new row.

export interface CrystallizationReceipt {
  at: string;
  channelId: string;
  memoryObjectId: string;
  flag: string;
  confidence: number;
}

// Implementation skeleton (add into existing class):
//   async ingestObservation(obs, opts) {
//     const confidence = applyChannelCap(opts.method, obs.confidence);
//     const existing = this._findByChannelAndSource(obs.channelId, obs.sourceRef);
//     let mo;
//     if (existing) {
//       mo = this._update(existing.id, { payload: obs.payload, confidence, updatedAt: obs.receivedAt });
//     } else {
//       mo = this._create({
//         type: opts.type, topic: opts.topic, tags: opts.tags || [],
//         payload: obs.payload, confidence, generation_method: opts.method,
//         provenance: { channelId: obs.channelId, sourceRef: obs.sourceRef, flag: obs.flag, verifierId: obs.verifierId },
//         createdAt: obs.receivedAt, updatedAt: obs.receivedAt,
//       });
//     }
//     this._writeReceipt({ at: new Date().toISOString(), channelId: obs.channelId, memoryObjectId: mo.id, flag: obs.flag, confidence });
//     return mo;
//   }
//   _writeReceipt(r) {
//     mkdirSync(this.brainDir, { recursive: true });
//     appendFileSync(join(this.brainDir, 'crystallization-receipts.jsonl'), JSON.stringify(r) + '\n');
//   }
//   listReceipts() { /* read JSONL, return array */ }
```

Fill in the actual implementation using the existing class internals.

- [ ] **Step 3: Run tests**

Run: `node --import tsx --test tests/agent/memory-objects-ingest.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/agent/memory-objects.ts tests/agent/memory-objects-ingest.test.ts
git commit -m "feat(step24): ingestObservation + crystallization receipts on MemoryObjectStore"
```

---

### Task 2.3: Wire bus `crystallize` events to MemoryObjectStore

**Files:**
- Modify: `engine/src/index.js`

- [ ] **Step 1: After bus construction, subscribe to `crystallize`**

```javascript
channelBus.on('crystallize', async ({ channel, observation, draft }) => {
  try {
    await memoryObjectStore.ingestObservation(observation, {
      method: draft.method || `${channel.class}_event`,
      type: draft.type || 'observation',
      topic: draft.topic || channel.class,
      tags: draft.tags || [channel.class, channel.id],
    });
  } catch (err) {
    logger.warn?.('[bus->memory] ingest failed:', err?.message);
  }
});
```

- [ ] **Step 2: Restart jerry + verify**

```bash
pm2 restart home23-jerry && sleep 3
pm2 logs home23-jerry --lines 20 --nostream | grep -E "bus->memory|crystallize"
```

Expected: no errors. (No channels crystallize yet — NotifyChannel has `crystallize: null`.)

- [ ] **Step 3: Commit**

```bash
git add engine/src/index.js
git commit -m "feat(step24): route bus crystallize events to MemoryObjectStore.ingestObservation"
```

---

### Task 2.4: Implement build/git-channel

**Files:**
- Create: `engine/src/channels/build/git-channel.js`
- Test: `tests/engine/channels/build/git-channel.test.js`

- [ ] **Step 1: Write failing test**

```javascript
// tests/engine/channels/build/git-channel.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitChannel } from '../../../../engine/src/channels/build/git-channel.js';

test('GitChannel parses git log output into commit observations', async () => {
  const ch = new GitChannel({ repoPath: process.cwd(), intervalMs: 10 });
  const sample = 'abc1234|2026-04-21T10:00:00Z|notforyou23|feat: add thing\ndef5678|2026-04-21T11:00:00Z|notforyou23|fix: bug';
  const parsed = ch._parseLogOutput(sample);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].sha, 'abc1234');
  assert.equal(parsed[0].subject, 'feat: add thing');
});

test('GitChannel crystallize produces a build_event draft for each commit', async () => {
  const ch = new GitChannel({ repoPath: process.cwd(), intervalMs: 10 });
  const verified = ch.verify({ payload: { sha: 'abc1234', subject: 'feat: test', author: 'x', committed_at: '2026-04-21T10:00:00Z' }, sourceRef: 'git:abc1234', producedAt: '2026-04-21T10:00:00Z' });
  const draft = ch.crystallize(verified);
  assert.ok(draft);
  assert.equal(draft.method, 'build_event');
  assert.equal(draft.type, 'observation');
  assert.equal(draft.topic, 'git');
});
```

- [ ] **Step 2: Implement GitChannel**

```javascript
// engine/src/channels/build/git-channel.js
'use strict';

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { PollChannel } from '../base/poll-channel.js';
import { ChannelClass, makeObservation } from '../contract.js';

const execP = promisify(exec);

export class GitChannel extends PollChannel {
  constructor({ repoPath, intervalMs = 60 * 1000, watchBranches = ['main'] }) {
    super({ id: 'build.git', class: ChannelClass.BUILD, intervalMs });
    this.repoPath = repoPath;
    this.watchBranches = watchBranches;
    this._lastSha = null;
  }
  async poll() {
    const fmt = '--pretty=format:%h|%cI|%an|%s';
    const range = this._lastSha ? `${this._lastSha}..HEAD` : '-20';
    let stdout;
    try {
      ({ stdout } = await execP(`git log ${fmt} ${range}`, { cwd: this.repoPath }));
    } catch {
      return [];
    }
    const entries = this._parseLogOutput(stdout);
    if (entries.length) this._lastSha = entries[0].sha;
    return entries;
  }
  _parseLogOutput(stdout) {
    const out = [];
    for (const line of (stdout || '').split('\n')) {
      const parts = line.split('|');
      if (parts.length < 4) continue;
      const [sha, committed_at, author, ...subjectParts] = parts;
      out.push({ sha, committed_at, author, subject: subjectParts.join('|') });
    }
    return out;
  }
  parse(raw) {
    return { payload: raw, sourceRef: `git:${raw.sha}`, producedAt: raw.committed_at };
  }
  verify(parsed) {
    return makeObservation({
      channelId: this.id, sourceRef: parsed.sourceRef, payload: parsed.payload,
      flag: 'COLLECTED', confidence: 0.95, producedAt: parsed.producedAt, verifierId: 'git:log',
    });
  }
  crystallize(obs) {
    return { method: 'build_event', type: 'observation', topic: 'git', tags: ['build', 'git', 'commit'] };
  }
}
```

- [ ] **Step 3: Run tests**

Run: `node --test tests/engine/channels/build/git-channel.test.js`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add engine/src/channels/build/git-channel.js tests/engine/channels/build/git-channel.test.js
git commit -m "feat(step24): GitChannel — polls git log, crystallizes commits"
```

---

### Task 2.5: Implement build/gh-channel

**Files:**
- Create: `engine/src/channels/build/gh-channel.js`
- Test: `tests/engine/channels/build/gh-channel.test.js`

- [ ] **Step 1: Write failing test**

```javascript
// tests/engine/channels/build/gh-channel.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GhChannel } from '../../../../engine/src/channels/build/gh-channel.js';

test('GhChannel parses gh pr list JSON into PR observations', async () => {
  const ch = new GhChannel({ intervalMs: 10, repo: 'owner/repo' });
  const sample = JSON.stringify([
    { number: 42, title: 'feat: x', state: 'OPEN', updatedAt: '2026-04-20T00:00:00Z', author: { login: 'me' } },
  ]);
  const parsed = ch._parsePrList(sample);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].number, 42);
});

test('GhChannel crystallize returns build_event draft', () => {
  const ch = new GhChannel({ intervalMs: 10, repo: 'owner/repo' });
  const v = ch.verify({ payload: { number: 42, title: 't', state: 'OPEN', updatedAt: '2026-04-20T00:00:00Z' }, sourceRef: 'gh:pr:42', producedAt: '2026-04-20T00:00:00Z' });
  const d = ch.crystallize(v);
  assert.equal(d.topic, 'pr');
});
```

- [ ] **Step 2: Implement GhChannel**

```javascript
// engine/src/channels/build/gh-channel.js
'use strict';

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { PollChannel } from '../base/poll-channel.js';
import { ChannelClass, makeObservation } from '../contract.js';

const execP = promisify(exec);

export class GhChannel extends PollChannel {
  constructor({ intervalMs = 5 * 60 * 1000, repo }) {
    super({ id: 'build.gh', class: ChannelClass.BUILD, intervalMs });
    this.repo = repo;
    this._seen = new Map(); // number -> updatedAt
  }
  async poll() {
    let stdout;
    try {
      ({ stdout } = await execP(`gh pr list --json number,title,state,updatedAt,author${this.repo ? ' --repo ' + this.repo : ''}`));
    } catch {
      return [];
    }
    const items = this._parsePrList(stdout);
    const out = [];
    for (const it of items) {
      const last = this._seen.get(it.number);
      if (last !== it.updatedAt) {
        this._seen.set(it.number, it.updatedAt);
        out.push(it);
      }
    }
    return out;
  }
  _parsePrList(stdout) {
    try { return JSON.parse(stdout); } catch { return []; }
  }
  parse(raw) {
    return { payload: raw, sourceRef: `gh:pr:${raw.number}:${raw.updatedAt}`, producedAt: raw.updatedAt };
  }
  verify(parsed) {
    return makeObservation({
      channelId: this.id, sourceRef: parsed.sourceRef, payload: parsed.payload,
      flag: 'COLLECTED', confidence: 0.9, producedAt: parsed.producedAt, verifierId: 'gh:pr-list',
    });
  }
  crystallize(obs) {
    return { method: 'build_event', type: 'observation', topic: 'pr', tags: ['build', 'gh', 'pr', obs.payload.state] };
  }
}
```

- [ ] **Step 3: Run tests + commit**

```bash
node --test tests/engine/channels/build/gh-channel.test.js
git add engine/src/channels/build/gh-channel.js tests/engine/channels/build/gh-channel.test.js
git commit -m "feat(step24): GhChannel — polls gh pr list, crystallizes PR state"
```

---

### Task 2.6: Implement build/fswatch-channel

**Files:**
- Create: `engine/src/channels/build/fswatch-channel.js`
- Test: `tests/engine/channels/build/fswatch-channel.test.js`

- [ ] **Step 1: Write failing test**

```javascript
// tests/engine/channels/build/fswatch-channel.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FsWatchChannel } from '../../../../engine/src/channels/build/fswatch-channel.js';

test('FsWatchChannel emits events on tracked-path changes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fswatch-'));
  const ch = new FsWatchChannel({ paths: [dir], id: 'build.fswatch.test' });
  await ch.start();
  writeFileSync(join(dir, 'foo.md'), 'hi');
  const out = [];
  for await (const p of ch.source()) { out.push(p); if (out.length >= 1) break; }
  ch.stop();
  assert.ok(out[0].payload.path.endsWith('foo.md'));
});

test('FsWatchChannel crystallize returns build_event for design-doc changes', () => {
  const ch = new FsWatchChannel({ paths: ['/x'], id: 'build.fswatch.design' });
  const v = ch.verify({ payload: { type: 'add', path: '/x/docs/design/STEP24.md', ts: '2026-04-21T00:00:00Z' }, sourceRef: 'fs:add:/x/docs/design/STEP24.md', producedAt: '2026-04-21T00:00:00Z' });
  const d = ch.crystallize(v);
  assert.ok(d);
  assert.ok(d.tags.includes('design-doc'));
});
```

- [ ] **Step 2: Implement FsWatchChannel**

```javascript
// engine/src/channels/build/fswatch-channel.js
'use strict';

import { WatchChannel } from '../base/watch-channel.js';
import { ChannelClass, makeObservation } from '../contract.js';

export class FsWatchChannel extends WatchChannel {
  constructor({ paths, id = 'build.fswatch' }) {
    super({ id, class: ChannelClass.BUILD, paths });
  }
  parseEvent(evt) {
    return { payload: evt, sourceRef: `fs:${evt.type}:${evt.path}`, producedAt: evt.ts };
  }
  verify(parsed) {
    return makeObservation({
      channelId: this.id, sourceRef: parsed.sourceRef, payload: parsed.payload,
      flag: 'COLLECTED', confidence: 0.9, producedAt: parsed.producedAt, verifierId: 'fs:watch',
    });
  }
  crystallize(obs) {
    const p = obs.payload.path || '';
    const tags = ['build', 'fswatch', obs.payload.type];
    if (p.includes('/docs/design/')) tags.push('design-doc');
    if (p.includes('/config/')) tags.push('config');
    if (p.includes('/engine/')) tags.push('engine');
    if (p.includes('/src/')) tags.push('harness');
    return { method: 'build_event', type: 'observation', topic: 'filesystem', tags };
  }
}
```

- [ ] **Step 3: Run tests + commit**

```bash
node --test tests/engine/channels/build/fswatch-channel.test.js
git add engine/src/channels/build/fswatch-channel.js tests/engine/channels/build/fswatch-channel.test.js
git commit -m "feat(step24): FsWatchChannel — chokidar wraps design/config/code paths"
```

---

### Task 2.7: Implement work/agenda-channel

**Files:**
- Create: `engine/src/channels/work/agenda-channel.js`
- Test: `tests/engine/channels/work/agenda-channel.test.js`

- [ ] **Step 1: Write failing test**

```javascript
// tests/engine/channels/work/agenda-channel.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgendaChannel } from '../../../../engine/src/channels/work/agenda-channel.js';

test('AgendaChannel parses an agenda.jsonl line with nested record', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agenda-'));
  const path = join(dir, 'agenda.jsonl');
  writeFileSync(path, '');
  const ch = new AgendaChannel({ path });
  await ch.start();
  const line = JSON.stringify({
    type: 'add', id: 'ag-1', record: { id: 'ag-1', content: 'Fix the thing', kind: 'decision', topicTags: ['build'], createdAt: '2026-04-21T00:00:00Z' }
  });
  appendFileSync(path, line + '\n');
  const out = [];
  for await (const p of ch.source()) { out.push(ch.verify(p)); if (out.length >= 1) break; }
  ch.stop();
  assert.equal(out[0].payload.id, 'ag-1');
  assert.equal(out[0].payload.kind, 'decision');
});
```

- [ ] **Step 2: Implement AgendaChannel**

```javascript
// engine/src/channels/work/agenda-channel.js
'use strict';

import { TailChannel } from '../base/tail-channel.js';
import { ChannelClass, makeObservation } from '../contract.js';

export class AgendaChannel extends TailChannel {
  constructor({ path, id = 'work.agenda' }) {
    super({ id, class: ChannelClass.WORK, path });
  }
  parseLine(line) {
    if (!line.trim()) return null;
    let obj;
    try { obj = JSON.parse(line); } catch { return null; }
    const record = obj.record || obj;
    return {
      payload: { id: record.id, type: obj.type || 'add', kind: record.kind, content: record.content, topicTags: record.topicTags || [], createdAt: record.createdAt },
      sourceRef: `agenda:${record.id}:${obj.type || 'add'}`,
      producedAt: record.createdAt || new Date().toISOString(),
    };
  }
  verify(parsed) {
    return makeObservation({
      channelId: this.id, sourceRef: parsed.sourceRef, payload: parsed.payload,
      flag: 'COLLECTED', confidence: 0.95, producedAt: parsed.producedAt, verifierId: 'agenda:tail',
    });
  }
  crystallize(obs) {
    return { method: 'work_event', type: 'observation', topic: 'agenda', tags: ['work', 'agenda', obs.payload.kind, ...(obs.payload.topicTags || [])] };
  }
}
```

- [ ] **Step 3: Run tests + commit**

```bash
node --test tests/engine/channels/work/agenda-channel.test.js
git add engine/src/channels/work/agenda-channel.js tests/engine/channels/work/agenda-channel.test.js
git commit -m "feat(step24): AgendaChannel — tails agenda.jsonl, crystallizes each record"
```

---

### Task 2.8: Implement work/live-problems-channel

**Files:**
- Create: `engine/src/channels/work/live-problems-channel.js`
- Test: `tests/engine/channels/work/live-problems-channel.test.js`

- [ ] **Step 1: Write failing test**

```javascript
// tests/engine/channels/work/live-problems-channel.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LiveProblemsChannel } from '../../../../engine/src/channels/work/live-problems-channel.js';

test('LiveProblemsChannel polls state and emits changed problems only', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lp-'));
  const path = join(dir, 'live-problems.json');
  writeFileSync(path, JSON.stringify({ problems: [{ id: 'p1', state: 'open', updatedAt: '2026-04-21T00:00:00Z' }] }));
  const ch = new LiveProblemsChannel({ path, intervalMs: 10 });
  const first = await ch.poll();
  assert.equal(first.length, 1);
  // Unchanged second poll -> no emissions
  const second = await ch.poll();
  assert.equal(second.length, 0);
  // Update file -> new emission
  writeFileSync(path, JSON.stringify({ problems: [{ id: 'p1', state: 'resolved', updatedAt: '2026-04-21T01:00:00Z' }] }));
  const third = await ch.poll();
  assert.equal(third.length, 1);
  assert.equal(third[0].state, 'resolved');
});
```

- [ ] **Step 2: Implement LiveProblemsChannel**

```javascript
// engine/src/channels/work/live-problems-channel.js
'use strict';

import { readFileSync, existsSync } from 'node:fs';
import { PollChannel } from '../base/poll-channel.js';
import { ChannelClass, makeObservation } from '../contract.js';

export class LiveProblemsChannel extends PollChannel {
  constructor({ path, intervalMs = 30 * 1000, id = 'work.live-problems' }) {
    super({ id, class: ChannelClass.WORK, intervalMs });
    this.path = path;
    this._seen = new Map(); // id -> updatedAt
  }
  async poll() {
    if (!existsSync(this.path)) return [];
    let data;
    try { data = JSON.parse(readFileSync(this.path, 'utf8')); } catch { return []; }
    const problems = Array.isArray(data?.problems) ? data.problems : [];
    const out = [];
    for (const p of problems) {
      const last = this._seen.get(p.id);
      if (last !== p.updatedAt) {
        this._seen.set(p.id, p.updatedAt);
        out.push(p);
      }
    }
    return out;
  }
  parse(raw) {
    return { payload: raw, sourceRef: `live-problem:${raw.id}:${raw.updatedAt}`, producedAt: raw.updatedAt || new Date().toISOString() };
  }
  verify(parsed) {
    return makeObservation({
      channelId: this.id, sourceRef: parsed.sourceRef, payload: parsed.payload,
      flag: 'COLLECTED', confidence: 0.9, producedAt: parsed.producedAt, verifierId: 'live-problems:poll',
    });
  }
  crystallize(obs) {
    return { method: 'work_event', type: 'observation', topic: 'live-problem', tags: ['work', 'live-problem', obs.payload.state] };
  }
}
```

- [ ] **Step 3: Run tests + commit**

```bash
node --test tests/engine/channels/work/live-problems-channel.test.js
git add engine/src/channels/work/live-problems-channel.js tests/engine/channels/work/live-problems-channel.test.js
git commit -m "feat(step24): LiveProblemsChannel — polls state, emits on change"
```

---

### Task 2.9: Implement work/goals-channel

**Files:**
- Create: `engine/src/channels/work/goals-channel.js`
- Test: `tests/engine/channels/work/goals-channel.test.js`

- [ ] **Step 1: Write failing test**

```javascript
// tests/engine/channels/work/goals-channel.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GoalsChannel } from '../../../../engine/src/channels/work/goals-channel.js';

test('GoalsChannel watches lifecycle state directories', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'goals-'));
  for (const sub of ['pending', 'assigned', 'complete', 'revoked', 'acks']) mkdirSync(join(dir, sub));
  const ch = new GoalsChannel({ goalsDir: dir });
  await ch.start();
  writeFileSync(join(dir, 'pending', 'g1.json'), JSON.stringify({ id: 'g1', title: 'test' }));
  const out = [];
  for await (const p of ch.source()) { out.push(p); if (out.length >= 1) break; }
  ch.stop();
  assert.ok(out[0].payload.state === 'pending');
  assert.equal(out[0].payload.goalId, 'g1');
});
```

- [ ] **Step 2: Implement GoalsChannel**

```javascript
// engine/src/channels/work/goals-channel.js
'use strict';

import { WatchChannel } from '../base/watch-channel.js';
import { ChannelClass, makeObservation } from '../contract.js';
import { basename, dirname } from 'node:path';

const LIFECYCLE = ['pending', 'assigned', 'acks', 'complete', 'revoked'];

export class GoalsChannel extends WatchChannel {
  constructor({ goalsDir, id = 'work.goals' }) {
    super({ id, class: ChannelClass.WORK, paths: LIFECYCLE.map((s) => `${goalsDir}/${s}`) });
    this.goalsDir = goalsDir;
  }
  parseEvent(evt) {
    const state = basename(dirname(evt.path));
    const goalId = basename(evt.path, '.json');
    return { payload: { state, goalId, eventType: evt.type, path: evt.path }, sourceRef: `goal:${goalId}:${state}:${evt.type}`, producedAt: evt.ts };
  }
  verify(parsed) {
    return makeObservation({
      channelId: this.id, sourceRef: parsed.sourceRef, payload: parsed.payload,
      flag: 'COLLECTED', confidence: 0.9, producedAt: parsed.producedAt, verifierId: 'goals:watch',
    });
  }
  crystallize(obs) {
    return { method: 'work_event', type: 'observation', topic: 'goal-lifecycle', tags: ['work', 'goal', obs.payload.state, obs.payload.eventType] };
  }
}
```

- [ ] **Step 3: Run tests + commit**

```bash
node --test tests/engine/channels/work/goals-channel.test.js
git add engine/src/channels/work/goals-channel.js tests/engine/channels/work/goals-channel.test.js
git commit -m "feat(step24): GoalsChannel — watches lifecycle dirs, emits state transitions"
```

---

### Task 2.10: Implement work/crons-channel

**Files:**
- Create: `engine/src/channels/work/crons-channel.js`
- Test: `tests/engine/channels/work/crons-channel.test.js`

- [ ] **Step 1: Write failing test**

```javascript
// tests/engine/channels/work/crons-channel.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CronsChannel } from '../../../../engine/src/channels/work/crons-channel.js';

test('CronsChannel polls cron-jobs.json and emits fire events', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crons-'));
  const path = join(dir, 'cron-jobs.json');
  writeFileSync(path, JSON.stringify({ jobs: [{ id: 'j1', lastFiredAt: '2026-04-21T00:00:00Z', schedule: '*/5 * * * *' }] }));
  const ch = new CronsChannel({ path, intervalMs: 10 });
  const first = await ch.poll();
  assert.equal(first.length, 1);
  // Same lastFiredAt -> no emit
  assert.equal((await ch.poll()).length, 0);
  // Update fire time
  writeFileSync(path, JSON.stringify({ jobs: [{ id: 'j1', lastFiredAt: '2026-04-21T00:05:00Z', schedule: '*/5 * * * *' }] }));
  const third = await ch.poll();
  assert.equal(third.length, 1);
});
```

- [ ] **Step 2: Implement CronsChannel**

```javascript
// engine/src/channels/work/crons-channel.js
'use strict';

import { readFileSync, existsSync } from 'node:fs';
import { PollChannel } from '../base/poll-channel.js';
import { ChannelClass, makeObservation } from '../contract.js';

export class CronsChannel extends PollChannel {
  constructor({ path, intervalMs = 60 * 1000, id = 'work.crons' }) {
    super({ id, class: ChannelClass.WORK, intervalMs });
    this.path = path;
    this._seen = new Map();
  }
  async poll() {
    if (!existsSync(this.path)) return [];
    let data;
    try { data = JSON.parse(readFileSync(this.path, 'utf8')); } catch { return []; }
    const jobs = Array.isArray(data?.jobs) ? data.jobs : [];
    const out = [];
    for (const j of jobs) {
      const last = this._seen.get(j.id);
      if (last !== j.lastFiredAt) {
        this._seen.set(j.id, j.lastFiredAt);
        if (last !== undefined) out.push(j);  // Don't emit on initial load
      }
    }
    return out;
  }
  parse(raw) {
    return { payload: raw, sourceRef: `cron:${raw.id}:${raw.lastFiredAt}`, producedAt: raw.lastFiredAt || new Date().toISOString() };
  }
  verify(parsed) {
    return makeObservation({
      channelId: this.id, sourceRef: parsed.sourceRef, payload: parsed.payload,
      flag: 'COLLECTED', confidence: 0.9, producedAt: parsed.producedAt, verifierId: 'crons:poll',
    });
  }
  crystallize(obs) {
    return { method: 'work_event', type: 'observation', topic: 'cron-fire', tags: ['work', 'cron', obs.payload.id] };
  }
}
```

- [ ] **Step 3: Run tests + commit**

```bash
node --test tests/engine/channels/work/crons-channel.test.js
git add engine/src/channels/work/crons-channel.js tests/engine/channels/work/crons-channel.test.js
git commit -m "feat(step24): CronsChannel — polls cron-jobs.json, emits fire transitions"
```

---

### Task 2.11: Implement work/heartbeat-channel

**Files:**
- Create: `engine/src/channels/work/heartbeat-channel.js`
- Test: `tests/engine/channels/work/heartbeat-channel.test.js`

Heartbeat emits a periodic observation about the engine's own liveness: cycle count, awake time, last sleep, last conversation. This is the engine observing itself at the lowest level.

- [ ] **Step 1: Write failing test**

```javascript
// tests/engine/channels/work/heartbeat-channel.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HeartbeatChannel } from '../../../../engine/src/channels/work/heartbeat-channel.js';

test('HeartbeatChannel poll returns a single observation per tick', async () => {
  const state = { cycleCount: 5, awakeForMs: 1234, lastSleptMs: null, lastConversationMs: null };
  const ch = new HeartbeatChannel({ getEngineState: () => state, intervalMs: 10 });
  const r = await ch.poll();
  assert.equal(r.length, 1);
  assert.equal(r[0].cycleCount, 5);
});

test('HeartbeatChannel crystallize is zero-context when nothing changed', () => {
  const ch = new HeartbeatChannel({ getEngineState: () => ({}), intervalMs: 10 });
  const v = ch.verify({ payload: { cycleCount: 1 }, sourceRef: 'hb:1', producedAt: '2026-04-21T00:00:00Z' });
  const d = ch.crystallize(v);
  assert.equal(d, null); // heartbeat informational-only by default
});
```

- [ ] **Step 2: Implement HeartbeatChannel**

```javascript
// engine/src/channels/work/heartbeat-channel.js
'use strict';

import { PollChannel } from '../base/poll-channel.js';
import { ChannelClass, makeObservation } from '../contract.js';

export class HeartbeatChannel extends PollChannel {
  constructor({ getEngineState, intervalMs = 60 * 1000, id = 'work.heartbeat' }) {
    super({ id, class: ChannelClass.WORK, intervalMs });
    this.getEngineState = getEngineState || (() => ({}));
    this._tick = 0;
  }
  async poll() {
    this._tick += 1;
    const state = this.getEngineState() || {};
    return [{ tick: this._tick, ...state, at: new Date().toISOString() }];
  }
  parse(raw) {
    return { payload: raw, sourceRef: `hb:${raw.tick}`, producedAt: raw.at };
  }
  verify(parsed) {
    return makeObservation({
      channelId: this.id, sourceRef: parsed.sourceRef, payload: parsed.payload,
      flag: 'COLLECTED', confidence: 0.9, producedAt: parsed.producedAt, verifierId: 'heartbeat',
    });
  }
  crystallize() { return null; } // informational-only; observable via bus log
}
```

- [ ] **Step 3: Run tests + commit**

```bash
node --test tests/engine/channels/work/heartbeat-channel.test.js
git add engine/src/channels/work/heartbeat-channel.js tests/engine/channels/work/heartbeat-channel.test.js
git commit -m "feat(step24): HeartbeatChannel — engine self-observation, informational"
```

---

### Task 2.12: Register build + work channels at engine boot

**Files:**
- Modify: `engine/src/index.js`
- Modify: `config/home.yaml` (flip `build.enabled` + `work.enabled` to `true`)

- [ ] **Step 1: Import channels and register**

In `engine/src/index.js`:

```javascript
import { GitChannel } from './channels/build/git-channel.js';
import { GhChannel } from './channels/build/gh-channel.js';
import { FsWatchChannel } from './channels/build/fswatch-channel.js';
import { AgendaChannel } from './channels/work/agenda-channel.js';
import { LiveProblemsChannel } from './channels/work/live-problems-channel.js';
import { GoalsChannel } from './channels/work/goals-channel.js';
import { CronsChannel } from './channels/work/crons-channel.js';
import { HeartbeatChannel } from './channels/work/heartbeat-channel.js';

// After bus construction, before start:
const buildCfg = config.osEngine?.channels?.build;
if (buildCfg?.enabled) {
  channelBus.register(new GitChannel({ repoPath: repoPath /* resolve from config */, intervalMs: 60_000 }));
  channelBus.register(new GhChannel({ intervalMs: 5 * 60_000, repo: buildCfg?.gh?.repo }));
  channelBus.register(new FsWatchChannel({ paths: [
    `${repoPath}/docs/design`,
    `${repoPath}/config`,
    `${repoPath}/engine/src`,
    `${repoPath}/src`,
  ]}));
}
const workCfg = config.osEngine?.channels?.work;
if (workCfg?.enabled) {
  channelBus.register(new AgendaChannel({ path: join(brainDir, 'agenda.jsonl') }));
  channelBus.register(new LiveProblemsChannel({ path: join(brainDir, 'live-problems.json') }));
  channelBus.register(new GoalsChannel({ goalsDir: join(brainDir, 'goals') }));
  channelBus.register(new CronsChannel({ path: join(conversationsDir, 'cron-jobs.json') }));
  channelBus.register(new HeartbeatChannel({ getEngineState: () => engineState.snapshot() }));
}
```

- [ ] **Step 2: Flip config defaults**

Edit `config/home.yaml` — change `build: { enabled: false }` to `build: { enabled: true }` and same for `work`.

- [ ] **Step 3: Build, restart, verify**

```bash
npm run build
pm2 restart home23-jerry
sleep 10
pm2 logs home23-jerry --lines 100 --nostream | grep -E "channels|crystallize|bus->memory"
```

Expected: boot lines naming each registered channel; after a few minutes, crystallize events flowing.

- [ ] **Step 4: Verify memory-objects receipts growing**

```bash
wc -l /Users/jtr/_JTR23_/release/home23/instances/jerry/brain/crystallization-receipts.jsonl
```

Expected: >0 lines, growing as work occurs (make a git commit, watch the count rise).

- [ ] **Step 5: Verify dive-mode breaks the Memory Nodes:0 signature**

Manually via dashboard or API:

```bash
# Run a jerry dive query and check the export header
ls -1t /Users/jtr/_JTR23_/release/home23/instances/jerry/brain/exports/markdown/ | head -1
grep "Memory Nodes" /Users/jtr/_JTR23_/release/home23/instances/jerry/brain/exports/markdown/<latest>.md
```

Expected: Memory Nodes: > 0 within one hour of restart.

- [ ] **Step 6: Commit**

```bash
git add engine/src/index.js config/home.yaml
git commit -m "feat(step24): register build + work channels; flip config defaults on"
```

---

### Task 2.13: Phase 2 end-to-end integration test

**Files:**
- Create: `tests/engine/integration/phase2-e2e.test.js`

- [ ] **Step 1: Write end-to-end test**

```javascript
// tests/engine/integration/phase2-e2e.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChannelBus } from '../../../engine/src/channels/bus.js';
import { AgendaChannel } from '../../../engine/src/channels/work/agenda-channel.js';
import { LiveProblemsChannel } from '../../../engine/src/channels/work/live-problems-channel.js';

test('agenda + live-problems observations fan into bus with correct flags', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'p2-'));
  const agendaPath = join(dir, 'agenda.jsonl');
  const lpPath = join(dir, 'live-problems.json');
  writeFileSync(agendaPath, '');
  writeFileSync(lpPath, JSON.stringify({ problems: [] }));

  const bus = new ChannelBus({ persistenceDir: join(dir, 'channels') });
  bus.register(new AgendaChannel({ path: agendaPath }));
  bus.register(new LiveProblemsChannel({ path: lpPath, intervalMs: 20 }));

  const obs = [];
  const drafts = [];
  bus.on('observation', (o) => obs.push(o));
  bus.on('crystallize', (d) => drafts.push(d));
  await bus.start();

  appendFileSync(agendaPath, JSON.stringify({ type: 'add', id: 'ag-1', record: { id: 'ag-1', content: 'x', kind: 'decision', createdAt: '2026-04-21T00:00:00Z' } }) + '\n');
  writeFileSync(lpPath, JSON.stringify({ problems: [{ id: 'p1', state: 'open', updatedAt: '2026-04-21T00:01:00Z' }] }));

  await new Promise((r) => setTimeout(r, 300));
  await bus.stop();

  assert.ok(obs.length >= 2);
  assert.ok(obs.every((o) => ['COLLECTED', 'UNCERTIFIED'].includes(o.flag)));
  assert.ok(drafts.length >= 2);
});
```

- [ ] **Step 2: Run + commit**

```bash
node --test tests/engine/integration/phase2-e2e.test.js
git add tests/engine/integration/phase2-e2e.test.js
git commit -m "test(step24): Phase 2 e2e — agenda + live-problems -> bus -> drafts"
```

---

### Phase 2 verification (live)

- [ ] `pm2 restart home23-jerry` — clean boot, all build + work channels registered.
- [ ] `wc -l instances/jerry/brain/crystallization-receipts.jsonl` — growing.
- [ ] Jerry dive-mode export shows `Memory Nodes: > 0` within 1h.
- [ ] Jerry's agenda entry "Investigate why health data stopped 2026-04-13" can be matched against agenda-channel-crystallized observations (evidence that the brain can now read its own live state).

---


## Phase 3 — Domain channels (sensor JSONL readers)

Goal: the three active-domain JSONL streams (`~/.pressure_log.jsonl`, `~/.health_log.jsonl`, `~/.sauna_usage_log.jsonl`) plus weather become bus channels. Pattern: each extends `TailChannel` or `PollChannel` with a stream-specific `parseLine`/`poll` + domain-appropriate crystallization tagging. Following the same structure as Phase 2 Tasks 2.7/2.8/2.10.

### Task 3.1: Implement domain/pressure-channel

**Files:**
- Create: `engine/src/channels/domain/pressure-channel.js`
- Test: `tests/engine/channels/domain/pressure-channel.test.js`

- [ ] **Step 1: Write failing test**

```javascript
// tests/engine/channels/domain/pressure-channel.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PressureChannel } from '../../../../engine/src/channels/domain/pressure-channel.js';

test('PressureChannel parses a pressure JSONL line', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'press-'));
  const path = join(dir, 'pressure.jsonl');
  writeFileSync(path, '');
  const ch = new PressureChannel({ path });
  await ch.start();
  appendFileSync(path, JSON.stringify({ ts: '2026-04-21T10:51:20-04:00', pressure_pa: 102284, pressure_inhg: 30.2, temp_c: 19.3, temp_f: 66.7 }) + '\n');
  const out = [];
  for await (const p of ch.source()) { out.push(ch.verify(p)); if (out.length >= 1) break; }
  ch.stop();
  assert.equal(out[0].payload.pressure_pa, 102284);
  assert.equal(out[0].flag, 'COLLECTED');
});
```

- [ ] **Step 2: Implement PressureChannel**

```javascript
// engine/src/channels/domain/pressure-channel.js
'use strict';
import { TailChannel } from '../base/tail-channel.js';
import { ChannelClass, makeObservation } from '../contract.js';

export class PressureChannel extends TailChannel {
  constructor({ path, id = 'domain.pressure' }) {
    super({ id, class: ChannelClass.DOMAIN, path });
  }
  parseLine(line) {
    if (!line.trim()) return null;
    let obj;
    try { obj = JSON.parse(line); } catch { return null; }
    if (!obj.ts || !obj.pressure_pa) return null;
    return { payload: obj, sourceRef: `pressure:${obj.ts}`, producedAt: obj.ts };
  }
  verify(parsed) {
    return makeObservation({
      channelId: this.id, sourceRef: parsed.sourceRef, payload: parsed.payload,
      flag: 'COLLECTED', confidence: 0.95, producedAt: parsed.producedAt, verifierId: 'pressure:bme280',
    });
  }
  crystallize(obs) {
    // Only crystallize on notable deltas — but Phase 3 keeps it simple: one per reading.
    // Phase 5 decay will prune redundancy.
    return { method: 'sensor_primary', type: 'observation', topic: 'pressure', tags: ['domain', 'pressure', 'bme280'] };
  }
}
```

- [ ] **Step 3: Run + commit**

```bash
node --test tests/engine/channels/domain/pressure-channel.test.js
git add engine/src/channels/domain/pressure-channel.js tests/engine/channels/domain/pressure-channel.test.js
git commit -m "feat(step24): PressureChannel — tails ~/.pressure_log.jsonl"
```

---

### Task 3.2: Implement domain/health-channel

**Files:**
- Create: `engine/src/channels/domain/health-channel.js`
- Test: `tests/engine/channels/domain/health-channel.test.js`

- [ ] **Step 1: Write failing test**

```javascript
// tests/engine/channels/domain/health-channel.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HealthChannel } from '../../../../engine/src/channels/domain/health-channel.js';

test('HealthChannel extracts HRV/RHR/sleep metrics from health log line', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'health-'));
  const path = join(dir, 'health.jsonl');
  writeFileSync(path, '');
  const ch = new HealthChannel({ path });
  await ch.start();
  const line = JSON.stringify({
    ts: '2026-04-21T14:50:52.649114+00:00',
    metrics: {
      heartRateVariability: { date: '2026-04-21', unit: 'ms', value: 28.53 },
      restingHeartRate: { date: '2026-04-21', unit: 'bpm', value: 58 },
      sleepTime: { date: '2026-04-21', unit: 'min', value: 502.99 },
      vo2Max: { date: '2026-04-20', unit: 'mL/kg/min', value: 31.04 },
    },
  });
  appendFileSync(path, line + '\n');
  const out = [];
  for await (const p of ch.source()) { out.push(ch.verify(p)); if (out.length >= 1) break; }
  ch.stop();
  assert.equal(out[0].payload.hrv, 28.53);
  assert.equal(out[0].payload.rhr, 58);
});
```

- [ ] **Step 2: Implement HealthChannel**

```javascript
// engine/src/channels/domain/health-channel.js
'use strict';
import { TailChannel } from '../base/tail-channel.js';
import { ChannelClass, makeObservation } from '../contract.js';

export class HealthChannel extends TailChannel {
  constructor({ path, id = 'domain.health' }) {
    super({ id, class: ChannelClass.DOMAIN, path });
  }
  parseLine(line) {
    if (!line.trim()) return null;
    let obj;
    try { obj = JSON.parse(line); } catch { return null; }
    const m = obj.metrics || {};
    const extract = (k) => m[k]?.value;
    const payload = {
      ts: obj.ts,
      hrv: extract('heartRateVariability'),
      rhr: extract('restingHeartRate'),
      sleepMin: extract('sleepTime'),
      vo2: extract('vo2Max'),
      wristTempF: extract('wristTemperature'),
      steps: extract('stepCount'),
      exerciseMin: extract('exerciseMinutes'),
    };
    return { payload, sourceRef: `health:${obj.ts}`, producedAt: obj.ts };
  }
  verify(parsed) {
    return makeObservation({
      channelId: this.id, sourceRef: parsed.sourceRef, payload: parsed.payload,
      flag: 'COLLECTED', confidence: 0.95, producedAt: parsed.producedAt, verifierId: 'health:kit-export',
    });
  }
  crystallize(obs) {
    return { method: 'sensor_primary', type: 'observation', topic: 'health', tags: ['domain', 'health', 'hrv', 'rhr', 'sleep'] };
  }
}
```

- [ ] **Step 3: Run + commit**

```bash
node --test tests/engine/channels/domain/health-channel.test.js
git add engine/src/channels/domain/health-channel.js tests/engine/channels/domain/health-channel.test.js
git commit -m "feat(step24): HealthChannel — extracts HRV/RHR/sleep/VO2 from health log"
```

---

### Task 3.3: Implement domain/sauna-channel

**Files:**
- Create: `engine/src/channels/domain/sauna-channel.js`
- Test: `tests/engine/channels/domain/sauna-channel.test.js`

- [ ] **Step 1: Write failing test**

```javascript
// tests/engine/channels/domain/sauna-channel.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SaunaChannel } from '../../../../engine/src/channels/domain/sauna-channel.js';

test('SaunaChannel emits state transition events', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sauna-'));
  const path = join(dir, 'sauna.jsonl');
  writeFileSync(path, '');
  const ch = new SaunaChannel({ path });
  await ch.start();
  appendFileSync(path, JSON.stringify({ event: 'start', ts: '2026-04-21T10:00:00Z', temp: 80, targetTemp: 190, status: 'On' }) + '\n');
  const out = [];
  for await (const p of ch.source()) { out.push(ch.verify(p)); if (out.length >= 1) break; }
  ch.stop();
  assert.equal(out[0].payload.event, 'start');
  assert.equal(out[0].payload.targetTemp, 190);
});
```

- [ ] **Step 2: Implement SaunaChannel**

```javascript
// engine/src/channels/domain/sauna-channel.js
'use strict';
import { TailChannel } from '../base/tail-channel.js';
import { ChannelClass, makeObservation } from '../contract.js';

export class SaunaChannel extends TailChannel {
  constructor({ path, id = 'domain.sauna' }) {
    super({ id, class: ChannelClass.DOMAIN, path });
  }
  parseLine(line) {
    if (!line.trim()) return null;
    let obj;
    try { obj = JSON.parse(line); } catch { return null; }
    if (!obj.event || !obj.ts) return null;
    return { payload: obj, sourceRef: `sauna:${obj.ts}:${obj.event}`, producedAt: obj.ts };
  }
  verify(parsed) {
    return makeObservation({
      channelId: this.id, sourceRef: parsed.sourceRef, payload: parsed.payload,
      flag: 'COLLECTED', confidence: 0.95, producedAt: parsed.producedAt, verifierId: 'sauna:huum-poll',
    });
  }
  crystallize(obs) {
    return { method: 'sensor_primary', type: 'observation', topic: 'sauna', tags: ['domain', 'sauna', obs.payload.event, obs.payload.status] };
  }
}
```

- [ ] **Step 3: Run + commit**

```bash
node --test tests/engine/channels/domain/sauna-channel.test.js
git add engine/src/channels/domain/sauna-channel.js tests/engine/channels/domain/sauna-channel.test.js
git commit -m "feat(step24): SaunaChannel — tails sauna usage log, emits state transitions"
```

---

### Task 3.4: Implement domain/weather-channel

**Files:**
- Create: `engine/src/channels/domain/weather-channel.js`
- Test: `tests/engine/channels/domain/weather-channel.test.js`

Weather source is the existing Ecowitt poller in `engine/src/core/sensors.js`. Wrap it as a PollChannel.

- [ ] **Step 1: Write failing test**

```javascript
// tests/engine/channels/domain/weather-channel.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WeatherChannel } from '../../../../engine/src/channels/domain/weather-channel.js';

test('WeatherChannel poll returns at most one observation when fetch succeeds', async () => {
  const ch = new WeatherChannel({ intervalMs: 10, fetchWeather: async () => ({ tempF: 66.7, humidity: 40, pressureInhg: 30.2, at: '2026-04-21T00:00:00Z' }) });
  const r = await ch.poll();
  assert.equal(r.length, 1);
  assert.equal(r[0].tempF, 66.7);
});

test('WeatherChannel poll returns ZERO_CONTEXT when fetch yields null', async () => {
  const ch = new WeatherChannel({ intervalMs: 10, fetchWeather: async () => null });
  const r = await ch.poll();
  assert.equal(r.length, 1);
  assert.equal(r[0].__zeroContext, true);
});
```

- [ ] **Step 2: Implement WeatherChannel**

```javascript
// engine/src/channels/domain/weather-channel.js
'use strict';
import { PollChannel } from '../base/poll-channel.js';
import { ChannelClass, makeObservation } from '../contract.js';

export class WeatherChannel extends PollChannel {
  constructor({ intervalMs = 5 * 60 * 1000, fetchWeather, id = 'domain.weather' }) {
    super({ id, class: ChannelClass.DOMAIN, intervalMs });
    this.fetchWeather = fetchWeather || (async () => null);
  }
  async poll() {
    try {
      const w = await this.fetchWeather();
      if (!w) return [{ __zeroContext: true, at: new Date().toISOString() }];
      return [w];
    } catch (err) {
      return [{ __error: err.message, at: new Date().toISOString() }];
    }
  }
  parse(raw) {
    return { payload: raw, sourceRef: raw.__zeroContext ? `weather:zero:${raw.at}` : `weather:${raw.at}`, producedAt: raw.at };
  }
  verify(parsed) {
    const flag = parsed.payload.__zeroContext ? 'ZERO_CONTEXT' : parsed.payload.__error ? 'UNKNOWN' : 'COLLECTED';
    const confidence = flag === 'COLLECTED' ? 0.9 : flag === 'ZERO_CONTEXT' ? 0.2 : 0.0;
    return makeObservation({
      channelId: this.id, sourceRef: parsed.sourceRef, payload: parsed.payload,
      flag, confidence, producedAt: parsed.producedAt, verifierId: 'weather:ecowitt',
    });
  }
  crystallize(obs) {
    if (obs.flag !== 'COLLECTED') return null;
    return { method: 'sensor_primary', type: 'observation', topic: 'weather', tags: ['domain', 'weather'] };
  }
}
```

- [ ] **Step 3: Run + commit**

```bash
node --test tests/engine/channels/domain/weather-channel.test.js
git add engine/src/channels/domain/weather-channel.js tests/engine/channels/domain/weather-channel.test.js
git commit -m "feat(step24): WeatherChannel — PollChannel with ZERO_CONTEXT handling"
```

---

### Task 3.5: Register domain channels at engine boot (opt-in per agent)

**Files:**
- Modify: `engine/src/index.js`
- Modify: per-agent `instances/<name>/config.yaml` for agents opting in (forrest, jerry)

- [ ] **Step 1: Wire registration conditional on per-agent config**

In `engine/src/index.js`, after work channels:

```javascript
import { PressureChannel } from './channels/domain/pressure-channel.js';
import { HealthChannel } from './channels/domain/health-channel.js';
import { SaunaChannel } from './channels/domain/sauna-channel.js';
import { WeatherChannel } from './channels/domain/weather-channel.js';
import { fetchWeatherObservation } from './core/sensors.js'; // existing Ecowitt poller; expose a function

const domainCfg = config.osEngine?.channels?.domain;
if (domainCfg?.enabled) {
  const readers = domainCfg.readers || {};
  if (readers.pressure) channelBus.register(new PressureChannel({ path: readers.pressure.path }));
  if (readers.health)   channelBus.register(new HealthChannel({ path: readers.health.path }));
  if (readers.sauna)    channelBus.register(new SaunaChannel({ path: readers.sauna.path }));
  if (readers.weather)  channelBus.register(new WeatherChannel({ fetchWeather: fetchWeatherObservation }));
}
```

- [ ] **Step 2: Add per-agent opt-in config**

In `instances/jerry/config.yaml` (and `instances/forrest/config.yaml`):

```yaml
osEngine:
  channels:
    domain:
      enabled: true
      readers:
        pressure: { path: /Users/jtr/.pressure_log.jsonl, tail: true }
        health:   { path: /Users/jtr/.health_log.jsonl, tail: true }
        sauna:    { path: /Users/jtr/.sauna_usage_log.jsonl, tail: true }
        weather:  { enabled: true }
```

- [ ] **Step 3: Build, restart, verify**

```bash
npm run build
pm2 restart home23-jerry home23-forrest
sleep 30
pm2 logs home23-jerry --lines 50 --nostream | grep -E "domain\.|crystallize"
```

Expected: pressure/health/sauna channel registrations logged; crystallization receipts growing when sensor writers fire.

- [ ] **Step 4: Commit**

```bash
git add engine/src/index.js instances/jerry/config.yaml instances/forrest/config.yaml
git commit -m "feat(step24): register domain channels per-agent opt-in"
```

---

### Phase 3 verification

- [ ] Jerry observes his own domain surfaces: dive-mode shows memory objects tagged `domain`, `pressure`, `health`, `sauna`.
- [ ] Forrest observes his (he's the health agent — this is his primary surface).
- [ ] Jerry's earlier agenda item "Investigate why health data stopped 2026-04-13" now matches fresh health observations (the pathology that motivated the spec: observably closed).

---

## Phase 4 — Machine + OS channels (self-observation at the OS layer)

Goal: the engine observes its own machine and OS state. Existing `engine/src/sensors/stock/*` pollers get ported to the bus. New OS channels expose pm2, cron, filesystem events on the home23 repo, and syslog.

### Task 4.1: Port machine/cpu-channel (wrap existing stock cpu sensor)

**Files:**
- Create: `engine/src/channels/machine/cpu-channel.js`
- Test: `tests/engine/channels/machine/cpu-channel.test.js`

- [ ] **Step 1: Write failing test**

```javascript
// tests/engine/channels/machine/cpu-channel.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CpuChannel } from '../../../../engine/src/channels/machine/cpu-channel.js';

test('CpuChannel poll uses injected sampler and emits one observation', async () => {
  const ch = new CpuChannel({ intervalMs: 10, sample: async () => ({ loadAvg: [0.5, 0.3, 0.2], percentBusy: 12.4, at: '2026-04-21T00:00:00Z' }) });
  const r = await ch.poll();
  assert.equal(r.length, 1);
  assert.equal(r[0].percentBusy, 12.4);
});
```

- [ ] **Step 2: Implement CpuChannel**

```javascript
// engine/src/channels/machine/cpu-channel.js
'use strict';
import os from 'node:os';
import { PollChannel } from '../base/poll-channel.js';
import { ChannelClass, makeObservation } from '../contract.js';

async function defaultSample() {
  return { loadAvg: os.loadavg(), cpuCount: os.cpus().length, uptimeSec: os.uptime(), at: new Date().toISOString() };
}

export class CpuChannel extends PollChannel {
  constructor({ intervalMs = 30 * 1000, sample = defaultSample, id = 'machine.cpu' }) {
    super({ id, class: ChannelClass.MACHINE, intervalMs });
    this.sample = sample;
  }
  async poll() { return [await this.sample()]; }
  parse(raw) { return { payload: raw, sourceRef: `cpu:${raw.at}`, producedAt: raw.at }; }
  verify(parsed) {
    return makeObservation({
      channelId: this.id, sourceRef: parsed.sourceRef, payload: parsed.payload,
      flag: 'COLLECTED', confidence: 0.95, producedAt: parsed.producedAt, verifierId: 'os:loadavg',
    });
  }
  crystallize(obs) {
    // Only crystallize notable deltas — Phase 5 decay handles redundancy. For now: load spikes.
    const load1 = Array.isArray(obs.payload.loadAvg) ? obs.payload.loadAvg[0] : null;
    if (load1 == null || load1 < 2.0) return null;
    return { method: 'sensor_primary', type: 'observation', topic: 'cpu', tags: ['machine', 'cpu', 'load-spike'] };
  }
}
```

- [ ] **Step 3: Run + commit**

```bash
node --test tests/engine/channels/machine/cpu-channel.test.js
git add engine/src/channels/machine/cpu-channel.js tests/engine/channels/machine/cpu-channel.test.js
git commit -m "feat(step24): CpuChannel — loadavg sampler, crystallize on spikes only"
```

---

### Task 4.2: Implement machine/memory-channel

**Files:**
- Create: `engine/src/channels/machine/memory-channel.js`
- Test: `tests/engine/channels/machine/memory-channel.test.js`

Same pattern as CpuChannel; sample `os.freemem()`/`os.totalmem()`. Crystallize only when freemem drops below a threshold (e.g., <10%).

- [ ] **Step 1: Write test**

```javascript
// tests/engine/channels/machine/memory-channel.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryChannel } from '../../../../engine/src/channels/machine/memory-channel.js';
test('MemoryChannel crystallizes only when freePct below threshold', () => {
  const ch = new MemoryChannel({ intervalMs: 10, lowFreePctThreshold: 10 });
  const high = ch.verify({ payload: { freePct: 50 }, sourceRef: 'mem:1', producedAt: '2026-04-21T00:00:00Z' });
  assert.equal(ch.crystallize(high), null);
  const low = ch.verify({ payload: { freePct: 5 }, sourceRef: 'mem:2', producedAt: '2026-04-21T00:00:00Z' });
  assert.ok(ch.crystallize(low));
});
```

- [ ] **Step 2: Implement**

```javascript
// engine/src/channels/machine/memory-channel.js
'use strict';
import os from 'node:os';
import { PollChannel } from '../base/poll-channel.js';
import { ChannelClass, makeObservation } from '../contract.js';

export class MemoryChannel extends PollChannel {
  constructor({ intervalMs = 30 * 1000, lowFreePctThreshold = 10, id = 'machine.memory' }) {
    super({ id, class: ChannelClass.MACHINE, intervalMs });
    this.lowFreePctThreshold = lowFreePctThreshold;
  }
  async poll() {
    const total = os.totalmem();
    const free = os.freemem();
    return [{ total, free, freePct: Math.round((free / total) * 1000) / 10, at: new Date().toISOString() }];
  }
  parse(raw) { return { payload: raw, sourceRef: `mem:${raw.at}`, producedAt: raw.at }; }
  verify(parsed) {
    return makeObservation({
      channelId: this.id, sourceRef: parsed.sourceRef, payload: parsed.payload,
      flag: 'COLLECTED', confidence: 0.95, producedAt: parsed.producedAt, verifierId: 'os:meminfo',
    });
  }
  crystallize(obs) {
    if (obs.payload.freePct == null) return null;
    if (obs.payload.freePct >= this.lowFreePctThreshold) return null;
    return { method: 'sensor_primary', type: 'observation', topic: 'memory', tags: ['machine', 'memory', 'low-free'] };
  }
}
```

- [ ] **Step 3: Run + commit**

```bash
node --test tests/engine/channels/machine/memory-channel.test.js
git add engine/src/channels/machine/memory-channel.js tests/engine/channels/machine/memory-channel.test.js
git commit -m "feat(step24): MemoryChannel — threshold-based crystallization"
```

---

### Task 4.3: Implement machine/disk-channel

**Files:**
- Create: `engine/src/channels/machine/disk-channel.js`
- Test: `tests/engine/channels/machine/disk-channel.test.js`

Use `df -kP /` via exec; parse; threshold crystallize at >85% full.

- [ ] **Step 1-3:** Follow pattern of memory-channel (TDD test + PollChannel implementation + crystallize only on low-space condition).

Key implementation:

```javascript
// engine/src/channels/machine/disk-channel.js
'use strict';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { PollChannel } from '../base/poll-channel.js';
import { ChannelClass, makeObservation } from '../contract.js';
const execP = promisify(exec);

export class DiskChannel extends PollChannel {
  constructor({ intervalMs = 5 * 60 * 1000, highUsagePctThreshold = 85, mount = '/', id = 'machine.disk' }) {
    super({ id, class: ChannelClass.MACHINE, intervalMs });
    this.highUsagePctThreshold = highUsagePctThreshold;
    this.mount = mount;
  }
  async poll() {
    try {
      const { stdout } = await execP(`df -kP ${this.mount}`);
      const parts = stdout.trim().split('\n').slice(-1)[0].split(/\s+/);
      const usagePct = parseInt(parts[4], 10);
      return [{ mount: this.mount, usagePct, at: new Date().toISOString() }];
    } catch { return []; }
  }
  parse(raw) { return { payload: raw, sourceRef: `disk:${raw.mount}:${raw.at}`, producedAt: raw.at }; }
  verify(parsed) {
    return makeObservation({
      channelId: this.id, sourceRef: parsed.sourceRef, payload: parsed.payload,
      flag: 'COLLECTED', confidence: 0.95, producedAt: parsed.producedAt, verifierId: 'df:posix',
    });
  }
  crystallize(obs) {
    if (obs.payload.usagePct < this.highUsagePctThreshold) return null;
    return { method: 'sensor_primary', type: 'observation', topic: 'disk', tags: ['machine', 'disk', 'high-usage'] };
  }
}
```

Commit: `git commit -m "feat(step24): DiskChannel — df-based, crystallize on high usage"`.

---

### Task 4.4: Implement os/pm2-channel

**Files:**
- Create: `engine/src/channels/os/pm2-channel.js`
- Test: `tests/engine/channels/os/pm2-channel.test.js`

Poll `pm2 jlist` via exec. Emit observations when a process state changes (online/stopped/errored/restart count delta).

- [ ] **Step 1: Write test**

```javascript
// tests/engine/channels/os/pm2-channel.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pm2Channel } from '../../../../engine/src/channels/os/pm2-channel.js';

test('Pm2Channel emits on process state transition', async () => {
  let list = [{ name: 'home23-jerry', pm2_env: { status: 'online', restart_time: 0 } }];
  const ch = new Pm2Channel({ intervalMs: 10, listProcesses: async () => list });
  // First poll seeds baseline — no emissions.
  assert.equal((await ch.poll()).length, 0);
  // Change state → emit
  list = [{ name: 'home23-jerry', pm2_env: { status: 'stopped', restart_time: 0 } }];
  const changed = await ch.poll();
  assert.equal(changed.length, 1);
  assert.equal(changed[0].name, 'home23-jerry');
  assert.equal(changed[0].status, 'stopped');
});
```

- [ ] **Step 2: Implement**

```javascript
// engine/src/channels/os/pm2-channel.js
'use strict';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { PollChannel } from '../base/poll-channel.js';
import { ChannelClass, makeObservation } from '../contract.js';
const execP = promisify(exec);

async function defaultList() {
  try {
    const { stdout } = await execP('pm2 jlist');
    return JSON.parse(stdout);
  } catch { return []; }
}

export class Pm2Channel extends PollChannel {
  constructor({ intervalMs = 30 * 1000, listProcesses = defaultList, id = 'os.pm2' }) {
    super({ id, class: ChannelClass.OS, intervalMs });
    this.listProcesses = listProcesses;
    this._seen = new Map(); // name -> { status, restartCount }
  }
  async poll() {
    const list = (await this.listProcesses()) || [];
    const out = [];
    for (const p of list) {
      const status = p.pm2_env?.status;
      const restartCount = p.pm2_env?.restart_time ?? 0;
      const prev = this._seen.get(p.name);
      if (prev === undefined) {
        this._seen.set(p.name, { status, restartCount });
        continue;
      }
      if (prev.status !== status || prev.restartCount !== restartCount) {
        this._seen.set(p.name, { status, restartCount });
        out.push({ name: p.name, status, restartCount, prevStatus: prev.status, prevRestartCount: prev.restartCount, at: new Date().toISOString() });
      }
    }
    return out;
  }
  parse(raw) { return { payload: raw, sourceRef: `pm2:${raw.name}:${raw.status}:${raw.restartCount}`, producedAt: raw.at }; }
  verify(parsed) {
    return makeObservation({
      channelId: this.id, sourceRef: parsed.sourceRef, payload: parsed.payload,
      flag: 'COLLECTED', confidence: 0.95, producedAt: parsed.producedAt, verifierId: 'pm2:jlist',
    });
  }
  crystallize(obs) {
    return { method: 'work_event', type: 'observation', topic: 'pm2-process', tags: ['os', 'pm2', obs.payload.status] };
  }
}
```

- [ ] **Step 3: Run + commit**

```bash
node --test tests/engine/channels/os/pm2-channel.test.js
git add engine/src/channels/os/pm2-channel.js tests/engine/channels/os/pm2-channel.test.js
git commit -m "feat(step24): Pm2Channel — polls pm2 jlist, emits state transitions"
```

---

### Task 4.5: Implement os/cron-channel + os/fswatch-home23-channel

Both follow patterns already established.

**`engine/src/channels/os/cron-channel.js`:** `PollChannel` + `crontab -l` every 5 min; emit only on crontab content diff; crystallize each change.

**`engine/src/channels/os/fswatch-home23-channel.js`:** `WatchChannel` on `engine/`, `src/`, `cli/`, `scripts/`; lighter than build/fswatch-channel (no design-doc tagging), informational-only most cases.

- [ ] **Step 1 (cron): TDD test + impl**

```javascript
// engine/src/channels/os/cron-channel.js
'use strict';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { PollChannel } from '../base/poll-channel.js';
import { ChannelClass, makeObservation } from '../contract.js';
const execP = promisify(exec);

export class CronChannel extends PollChannel {
  constructor({ intervalMs = 5 * 60 * 1000, id = 'os.cron' }) {
    super({ id, class: ChannelClass.OS, intervalMs });
    this._lastHash = null;
  }
  async poll() {
    let stdout = '';
    try { ({ stdout } = await execP('crontab -l')); } catch { stdout = ''; }
    const hash = createHash('sha1').update(stdout).digest('hex');
    if (this._lastHash === hash) return [];
    const prev = this._lastHash;
    this._lastHash = hash;
    return prev === null ? [] : [{ hash, content: stdout, at: new Date().toISOString() }];
  }
  parse(raw) { return { payload: raw, sourceRef: `cron:${raw.hash}`, producedAt: raw.at }; }
  verify(parsed) {
    return makeObservation({
      channelId: this.id, sourceRef: parsed.sourceRef, payload: parsed.payload,
      flag: 'COLLECTED', confidence: 0.95, producedAt: parsed.producedAt, verifierId: 'crontab:list',
    });
  }
  crystallize(obs) {
    return { method: 'work_event', type: 'observation', topic: 'cron-change', tags: ['os', 'cron', 'changed'] };
  }
}
```

- [ ] **Step 2 (fswatch-home23):** reuse `FsWatchChannel` pattern from Phase 2, just different paths.

```javascript
// engine/src/channels/os/fswatch-home23-channel.js
'use strict';
import { WatchChannel } from '../base/watch-channel.js';
import { ChannelClass, makeObservation } from '../contract.js';

export class FsWatchHome23Channel extends WatchChannel {
  constructor({ repoPath, id = 'os.fswatch-home23' }) {
    super({ id, class: ChannelClass.OS, paths: [`${repoPath}/engine`, `${repoPath}/src`, `${repoPath}/cli`, `${repoPath}/scripts`] });
  }
  parseEvent(evt) { return { payload: evt, sourceRef: `fs:home23:${evt.type}:${evt.path}`, producedAt: evt.ts }; }
  verify(parsed) {
    return makeObservation({
      channelId: this.id, sourceRef: parsed.sourceRef, payload: parsed.payload,
      flag: 'COLLECTED', confidence: 0.9, producedAt: parsed.producedAt, verifierId: 'fs:home23',
    });
  }
  crystallize(obs) { return null; } // Informational by default; build/fswatch-channel handles load-bearing paths.
}
```

- [ ] **Step 3: Commit both**

```bash
git add engine/src/channels/os/cron-channel.js engine/src/channels/os/fswatch-home23-channel.js tests/engine/channels/os/
git commit -m "feat(step24): CronChannel + FsWatchHome23Channel"
```

---

### Task 4.6: Register machine + OS channels at boot, flip config

**Files:**
- Modify: `engine/src/index.js`
- Modify: `config/home.yaml` — flip `machine.enabled: true` and `os.enabled: true`

- [ ] **Step 1: Register**

```javascript
import { CpuChannel } from './channels/machine/cpu-channel.js';
import { MemoryChannel } from './channels/machine/memory-channel.js';
import { DiskChannel } from './channels/machine/disk-channel.js';
import { Pm2Channel } from './channels/os/pm2-channel.js';
import { CronChannel } from './channels/os/cron-channel.js';
import { FsWatchHome23Channel } from './channels/os/fswatch-home23-channel.js';

if (config.osEngine?.channels?.machine?.enabled) {
  channelBus.register(new CpuChannel({}));
  channelBus.register(new MemoryChannel({}));
  channelBus.register(new DiskChannel({}));
}
if (config.osEngine?.channels?.os?.enabled) {
  channelBus.register(new Pm2Channel({}));
  channelBus.register(new CronChannel({}));
  channelBus.register(new FsWatchHome23Channel({ repoPath }));
}
```

- [ ] **Step 2: Flip config defaults on**

Edit `config/home.yaml` — set `machine.enabled: true` and `os.enabled: true`.

- [ ] **Step 3: Build, restart, verify**

```bash
npm run build
pm2 restart home23-jerry
pm2 logs home23-jerry --lines 50 --nostream | grep -E "machine|os\.|crystallize"
```

Expected: all channels registered, pm2 observations on any pm2 state change (cause one by restarting another agent).

- [ ] **Step 4: Commit**

```bash
git add engine/src/index.js config/home.yaml
git commit -m "feat(step24): register machine + OS channels; flip config on"
```

---

### Phase 4 verification

- [ ] After `pm2 restart home23-forrest`, jerry's bus emits an `os.pm2` observation within 30s (jerry sees forrest's restart).
- [ ] Dive-mode query mentions pm2 / cpu / cron observations.
- [ ] `instances/jerry/brain/channels/os.os.pm2.jsonl` growing.

---


## Phase 5 — Decay worker activation

Goal: warning-state nodes, surreal-transform nodes, unfinished goals, and unreferenced edges decay gently on a 30-min cadence. The "our brain isn't right" warning class observably decays within 48h. No data destroyed — weights reduced.

### Task 5.1: Add memory-object decay metadata + API

**Files:**
- Modify: `src/agent/memory-objects.ts`
- Test: `tests/agent/memory-objects-decay.test.ts` (new)

- [ ] **Step 1: Write failing test**

```typescript
// tests/agent/memory-objects-decay.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryObjectStore } from '../../src/agent/memory-objects.js';

test('applyDecay reduces confidence of warning-tagged objects by halfLife', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mos-decay-'));
  const store = new MemoryObjectStore({ brainDir: dir });
  const mo = await store.create({
    type: 'observation', topic: 'warning', tags: ['warning'],
    confidence: 0.8, payload: { summary: 'brain not right' },
    createdAt: new Date(Date.now() - 96 * 3600 * 1000).toISOString(), // 96h ago
  });
  const updated = await store.applyDecay({ now: Date.now(), rules: { warning: { halfLifeMs: 48 * 3600 * 1000 } } });
  assert.equal(updated.length, 1);
  const after = store.get(mo.id);
  // 96h elapsed with 48h half-life -> 2 half-lives -> 25% remaining => 0.8 * 0.25 = 0.2
  assert.ok(after.confidence < 0.3);
});
```

- [ ] **Step 2: Implement applyDecay on store**

```typescript
// src/agent/memory-objects.ts — add to class
export interface DecayRule { halfLifeMs: number }
export interface DecayRules { [tag: string]: DecayRule }

async applyDecay({ now = Date.now(), rules = {} as DecayRules }): Promise<MemoryObject[]> {
  const updated: MemoryObject[] = [];
  for (const mo of this.list()) {
    for (const tag of mo.tags || []) {
      const rule = rules[tag];
      if (!rule) continue;
      const age = now - Date.parse(mo.createdAt);
      if (age <= 0) continue;
      const halfLives = age / rule.halfLifeMs;
      const factor = Math.pow(0.5, halfLives);
      const decayed = mo.confidence * factor;
      if (decayed < mo.confidence - 0.01) {
        this._update(mo.id, { confidence: decayed, lastDecayedAt: new Date(now).toISOString() });
        updated.push(this.get(mo.id));
        break;
      }
    }
  }
  return updated;
}
```

- [ ] **Step 3: Run + commit**

```bash
node --import tsx --test tests/agent/memory-objects-decay.test.ts
git add src/agent/memory-objects.ts tests/agent/memory-objects-decay.test.ts
git commit -m "feat(step24): applyDecay on MemoryObjectStore with tag-based half-life rules"
```

---

### Task 5.2: Implement DecayWorker.tick real logic

**Files:**
- Modify: `engine/src/cognition/decay-worker.js`
- Modify: `tests/engine/cognition/decay-worker.test.js`

- [ ] **Step 1: Extend test**

```javascript
// tests/engine/cognition/decay-worker.test.js — replace earlier scaffold test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DecayWorker } from '../../../engine/src/cognition/decay-worker.js';

function fakeStore() {
  const decayed = [];
  return {
    applyDecay: async (opts) => { decayed.push(opts); return [{ id: 'm1' }]; },
    decayed,
  };
}

test('DecayWorker.tick runs applyDecay with configured halfLives', async () => {
  const store = fakeStore();
  const w = new DecayWorker({
    memory: store, enabled: true,
    halfLife: { warning_node: 48 * 3600 * 1000, surreal_transform: 24 * 3600 * 1000 },
  });
  const r = await w.tick();
  assert.equal(r.decayed, 1);
  assert.equal(store.decayed.length, 1);
  assert.ok(store.decayed[0].rules.warning);
});
```

- [ ] **Step 2: Implement**

```javascript
// engine/src/cognition/decay-worker.js — replace
'use strict';
export class DecayWorker {
  constructor({ memory, logger, enabled = false, cadenceMs = 30 * 60 * 1000, halfLife = {} }) {
    this.memory = memory; this.logger = logger || console; this.enabled = enabled;
    this.cadenceMs = cadenceMs; this.halfLife = halfLife;
    this._timer = null;
  }
  async tick() {
    if (!this.enabled || !this.memory?.applyDecay) return { decayed: 0 };
    const rules = {
      warning: { halfLifeMs: this.halfLife.warning_node || 48 * 3600 * 1000 },
      surreal_transform: { halfLifeMs: this.halfLife.surreal_transform || 24 * 3600 * 1000 },
      unfinished_goal: { halfLifeMs: this.halfLife.unfinished_goal_review || 72 * 3600 * 1000 },
    };
    const updated = await this.memory.applyDecay({ now: Date.now(), rules });
    if (updated.length) this.logger.info?.(`[decay] decayed ${updated.length} memory objects`);
    return { decayed: updated.length };
  }
  start() {
    if (this._timer) return;
    const loop = async () => { try { await this.tick(); } catch (err) { this.logger.warn?.('[decay] tick failed:', err?.message); } this._timer = setTimeout(loop, this.cadenceMs); };
    this._timer = setTimeout(loop, this.cadenceMs);
  }
  stop() { if (this._timer) { clearTimeout(this._timer); this._timer = null; } }
}
```

- [ ] **Step 3: Activate in engine boot**

In `engine/src/index.js`:

```javascript
const decay = new DecayWorker({
  memory: memoryObjectStore, logger, enabled: true,
  cadenceMs: parseDuration(config.osEngine?.decay?.worker?.cadence || '30m'),
  halfLife: {
    warning_node: parseDuration(config.osEngine?.decay?.halfLife?.warning_node || '48h'),
    surreal_transform: parseDuration(config.osEngine?.decay?.halfLife?.surreal_transform || '24h'),
    unfinished_goal_review: parseDuration(config.osEngine?.decay?.halfLife?.unfinished_goal_review || '72h'),
  },
});
decay.start();
```

Use a `parseDuration('48h')` helper (add if absent; standard: accepts `s`, `m`, `h`, `d`).

- [ ] **Step 4: Run + commit**

```bash
node --test tests/engine/cognition/decay-worker.test.js
npm run build
pm2 restart home23-jerry
pm2 logs home23-jerry --lines 30 --nostream | grep -i decay
git add engine/src/cognition/decay-worker.js engine/src/index.js tests/engine/cognition/decay-worker.test.js
git commit -m "feat(step24): DecayWorker active — warning/transform/unfinished-goal decay"
```

---

### Task 5.3: Tag warning + surreal-transform nodes correctly

**Files:**
- Modify: `engine/src/core/curator-cycle.js` (or wherever nodes are written)
- Modify: `engine/src/cognition/critique.js`

- [ ] **Step 1: Locate warning-node writers**

Run: `grep -n "warning\|isWarning" engine/src/core/curator-cycle.js engine/src/cognition/*.js | head -20`

- [ ] **Step 2: Ensure tags include `warning` for brain-warning nodes**

Wherever a node tagged as a self-warning is written, ensure its tags include the literal string `warning`. Similarly, critique outputs categorized as creative/surreal transformations should carry tag `surreal_transform`.

Add a small helper if needed:

```javascript
// engine/src/core/node-tags.js
export function ensureTags(tags, ...required) {
  const set = new Set(tags || []);
  for (const r of required) set.add(r);
  return Array.from(set);
}
```

- [ ] **Step 3: Commit**

```bash
git add engine/src/core/node-tags.js engine/src/core/curator-cycle.js engine/src/cognition/critique.js
git commit -m "feat(step24): tag warning + surreal-transform nodes for decay targeting"
```

---

### Phase 5 verification

- [ ] Run dive-mode query on jerry 24h after Phase 5 lands. Confidence on the "our brain isn't right" warning class should be visibly lower than baseline.
- [ ] `brain/memory-objects.json` shows `lastDecayedAt` timestamps populating.

---

## Phase 6 — Role integrity contract

Goal: critic outputs must carry a verdict. Curator must cite observations. Each role's outputs pass schema validation at the phase boundary, or get rejected + re-prompted. Soft-gate for 2 weeks, then strict.

### Task 6.1: Extend role-schemas.js with strict validation + re-prompt hints

**Files:**
- Modify: `engine/src/cognition/role-schemas.js`
- Test: extend `tests/engine/cognition/role-schemas.test.js`

- [ ] **Step 1: Write failing test**

```javascript
// tests/engine/cognition/role-schemas.test.js — add
import { validateRoleOutput } from '../../../engine/src/cognition/role-schemas.js';

test('critic strict rejects output missing verdict', () => {
  const r = validateRoleOutput('critic', { claim: 'x', evidence_for: [], evidence_against: [] }, { strict: true });
  assert.equal(r.valid, false);
  assert.match(r.reason, /missing fields.*verdict/);
});

test('critic strict accepts complete output', () => {
  const r = validateRoleOutput('critic', {
    claim: 'x', evidence_for: ['a'], evidence_against: ['b'], verdict: 'keep',
  }, { strict: true });
  assert.equal(r.valid, true);
});

test('critic strict rejects non-enum verdict', () => {
  const r = validateRoleOutput('critic', {
    claim: 'x', evidence_for: [], evidence_against: [], verdict: 'maybe',
  }, { strict: true });
  assert.equal(r.valid, false);
  assert.match(r.reason, /verdict/);
});
```

- [ ] **Step 2: Extend implementation**

```javascript
// engine/src/cognition/role-schemas.js — replace validateRoleOutput
export function validateRoleOutput(role, output, { strict = false } = {}) {
  const schema = ROLE_SCHEMAS[role];
  if (!schema) return { valid: false, reason: `unknown role: ${role}` };
  if (!strict) return { valid: true, reason: 'soft-mode: always pass' };
  if (!output || typeof output !== 'object') return { valid: false, reason: 'output must be object' };
  const missing = schema.required.filter((k) => !(k in output));
  if (missing.length) return { valid: false, reason: `missing fields: ${missing.join(', ')}` };

  // Role-specific constraints:
  if (role === 'critic' && !['keep', 'revise', 'discard'].includes(output.verdict)) {
    return { valid: false, reason: 'critic verdict must be keep|revise|discard' };
  }
  if (role === 'curator' && (!Array.isArray(output.source_observations) || output.source_observations.length === 0)) {
    return { valid: false, reason: 'curator must cite at least one source_observation' };
  }
  if (role === 'critic' && !Array.isArray(output.supporting_observations)) {
    return { valid: false, reason: 'critic supporting_observations must be an array' };
  }
  return { valid: true };
}
```

Also update `ROLE_SCHEMAS.critic.required` to include `supporting_observations`.

- [ ] **Step 3: Run + commit**

```bash
node --test tests/engine/cognition/role-schemas.test.js
git add engine/src/cognition/role-schemas.js tests/engine/cognition/role-schemas.test.js
git commit -m "feat(step24): strict role-schema validation with role-specific constraints"
```

---

### Task 6.2: Integrate schema enforcement into thinking-machine phase boundaries

**Files:**
- Modify: `engine/src/cognition/thinking-machine.js`
- Modify: `engine/src/cognition/critique.js`

- [ ] **Step 1: Locate each phase's output write-path**

Run: `grep -n "critique\|emit\|writeThought" engine/src/cognition/thinking-machine.js | head -20`

- [ ] **Step 2: Wrap each phase result with validation + violation log**

```javascript
// engine/src/cognition/thinking-machine.js — near phase execution
import { validateRoleOutput } from './role-schemas.js';
import { appendFileSync } from 'node:fs';

function enforceRoleOutput(role, output, { strict, rejectLogPath, logger }) {
  const r = validateRoleOutput(role, output, { strict });
  if (!r.valid && rejectLogPath) {
    try { appendFileSync(rejectLogPath, JSON.stringify({ role, reason: r.reason, output, at: new Date().toISOString() }) + '\n'); } catch {}
  }
  if (!r.valid && strict) {
    logger.warn?.(`[role-integrity] ${role} rejected: ${r.reason}`);
    return { accepted: false, reason: r.reason };
  }
  return { accepted: true };
}
```

Apply at each phase output site. In strict mode, rejected outputs either trigger a re-prompt (Phase 6 includes one re-prompt attempt) or the phase returns empty.

- [ ] **Step 3: Wire config flag**

```javascript
const strict = config.osEngine?.roleIntegrity?.enforce === true;
const rejectLogPath = join(brainDir, config.osEngine?.roleIntegrity?.rejectLogPath || 'role-integrity-violations.jsonl');
```

Default `enforce: false` (soft-gate) during the 2-week ramp. Flip to `true` after observation.

- [ ] **Step 4: Commit**

```bash
git add engine/src/cognition/thinking-machine.js engine/src/cognition/critique.js
git commit -m "feat(step24): enforce role-output schemas at phase boundaries (soft-gate default)"
```

---

### Task 6.3: Curator must cite observations

**Files:**
- Modify: `engine/src/core/curator-cycle.js`

- [ ] **Step 1: Locate curator output construction**

Run: `grep -n "proposed\|surface\|write" engine/src/core/curator-cycle.js | head -20`

- [ ] **Step 2: Require source_observations field on every write**

Where curator writes a surface, include a `source_observations` array with observation IDs. Wire through from the observation context passed in from the bus (`recent verified observations for the surface's domain`).

- [ ] **Step 3: Add the surface-level integration test**

```javascript
// tests/engine/cognition/curator-integration.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRoleOutput } from '../../../engine/src/cognition/role-schemas.js';

test('curator output that cites no observations is rejected in strict mode', () => {
  const r = validateRoleOutput('curator', {
    surface: 'TOPOLOGY.md', proposed_text: 'text', source_observations: [], confidence: 0.7,
  }, { strict: true });
  assert.equal(r.valid, false);
});
```

- [ ] **Step 4: Run + commit**

```bash
node --test tests/engine/cognition/curator-integration.test.js
git add engine/src/core/curator-cycle.js tests/engine/cognition/curator-integration.test.js
git commit -m "feat(step24): curator must cite source_observations on every surface write"
```

---

### Phase 6 verification

- [ ] After 1 week soft-gate: `brain/role-integrity-violations.jsonl` shows which roles produce out-of-schema outputs most often (expect critic to dominate early).
- [ ] Flip `roleIntegrity.enforce: true` in `config/home.yaml`.
- [ ] After another week: violation rate declines as the engine adapts its critique outputs via re-prompting; verdict-carrying critiques become the majority.

---

## Phase 7 — Closer activation (termination, dedupe, resolution)

Goal: goals have termination contracts. Dedupe-before-spawn active. Warnings resolve when their root observation flag changes.

### Task 7.1: Add termination contract to goal schema

**Files:**
- Modify: `engine/src/goals/intrinsic-goals.js`
- Test: `tests/engine/goals/termination.test.js` (new)

- [ ] **Step 1: Write failing test**

```javascript
// tests/engine/goals/termination.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IntrinsicGoalSystem } from '../../../engine/src/goals/intrinsic-goals.js';

test('createGoal rejects a goal without termination when contract required', () => {
  const sys = new IntrinsicGoalSystem({ requireTermination: true });
  assert.throws(
    () => sys.createGoal({ title: 'open-ended meditation' }),
    /termination contract required/,
  );
});

test('createGoal accepts a goal with valid termination', () => {
  const sys = new IntrinsicGoalSystem({ requireTermination: true });
  const g = sys.createGoal({ title: 'write report', termination: { deliverable: 'workspace/reports/x.md' } });
  assert.ok(g.id);
});
```

- [ ] **Step 2: Implement guard on createGoal**

```javascript
// engine/src/goals/intrinsic-goals.js — add to createGoal
if (this.requireTermination) {
  const t = goal.termination;
  const hasContract = t && (t.deliverable || t.answer || t.decision || t.expires_at);
  if (!hasContract) throw new Error(`termination contract required; goal "${goal.title}" has none`);
}
```

Expose `requireTermination` via constructor.

- [ ] **Step 3: Run + commit**

```bash
node --test tests/engine/goals/termination.test.js
git add engine/src/goals/intrinsic-goals.js tests/engine/goals/termination.test.js
git commit -m "feat(step24): goal termination contract required (flagged via config)"
```

---

### Task 7.2: Implement closer dedupe-before-spawn

**Files:**
- Modify: `engine/src/cognition/closer.js`

- [ ] **Step 1: Write failing test**

```javascript
// tests/engine/cognition/closer-dedupe.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Closer } from '../../../engine/src/cognition/closer.js';

test('dedupeBeforeSpawn returns existing memory when tags match', async () => {
  const memory = {
    findByTopicTags: ({ tags }) => tags.includes('iOS-shortcut') ? [{ id: 'm1', summary: 'resolved' }] : [],
  };
  const c = new Closer({ memory, goals: {}, enabled: true });
  const hit = await c.dedupeBeforeSpawn({ topicTags: ['iOS-shortcut'] });
  assert.ok(hit);
  assert.equal(hit.id, 'm1');
});

test('dedupeBeforeSpawn returns null when no match', async () => {
  const memory = { findByTopicTags: () => [] };
  const c = new Closer({ memory, goals: {}, enabled: true });
  const hit = await c.dedupeBeforeSpawn({ topicTags: ['never-seen'] });
  assert.equal(hit, null);
});
```

- [ ] **Step 2: Implement**

```javascript
// engine/src/cognition/closer.js — replace dedupeBeforeSpawn
async dedupeBeforeSpawn(goal) {
  if (!this.enabled) return null;
  const tags = goal?.topicTags || [];
  if (!tags.length) return null;
  const hits = this.memory?.findByTopicTags?.({ tags, flag: 'COLLECTED' }) || [];
  return hits.length ? hits[0] : null;
}
```

Add matching `findByTopicTags` to `MemoryObjectStore`.

- [ ] **Step 3: Wire closer into agent-dispatch path**

In wherever `IntrinsicGoalSystem.assignGoalToAgent` lives, consult `closer.dedupeBeforeSpawn(goal)` first. If a hit, auto-resolve against it.

- [ ] **Step 4: Run + commit**

```bash
node --test tests/engine/cognition/closer-dedupe.test.js
git add engine/src/cognition/closer.js src/agent/memory-objects.ts engine/src/goals/intrinsic-goals.js tests/engine/cognition/closer-dedupe.test.js
git commit -m "feat(step24): closer dedupe-before-spawn consults memory by topic tags"
```

---

### Task 7.3: Warning resolution on observation flag change

**Files:**
- Modify: `engine/src/cognition/closer.js`

- [ ] **Step 1: Write failing test**

```javascript
// tests/engine/cognition/closer-resolve.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Closer } from '../../../engine/src/cognition/closer.js';

test('resolveWarning returns true when current flag is COLLECTED', async () => {
  const memory = {
    findWarningsForChannel: () => [{ id: 'w1', channelId: 'domain.health', lastFlag: 'ZERO_CONTEXT' }],
    markResolved: async (id) => ({ id, resolved: true }),
  };
  const c = new Closer({ memory, goals: {}, enabled: true });
  const r = await c.resolveWarning({ channelId: 'domain.health', flag: 'COLLECTED' });
  assert.equal(r.resolved, 1);
});
```

- [ ] **Step 2: Implement**

```javascript
// engine/src/cognition/closer.js — replace resolveWarning
async resolveWarning({ channelId, flag }) {
  if (!this.enabled) return { resolved: 0 };
  if (flag !== 'COLLECTED') return { resolved: 0 };
  const warnings = this.memory?.findWarningsForChannel?.(channelId) || [];
  let n = 0;
  for (const w of warnings) {
    if (w.lastFlag !== 'COLLECTED') {
      await this.memory.markResolved?.(w.id);
      n += 1;
    }
  }
  return { resolved: n };
}
```

- [ ] **Step 3: Wire closer into bus observation pipeline**

In `engine/src/index.js`:

```javascript
channelBus.on('observation', async (obs) => {
  if (config.osEngine?.closer?.terminationContractRequired) {
    await closer.resolveWarning({ channelId: obs.channelId, flag: obs.flag });
  }
});
```

- [ ] **Step 4: Run + commit**

```bash
node --test tests/engine/cognition/closer-resolve.test.js
git add engine/src/cognition/closer.js src/agent/memory-objects.ts engine/src/index.js tests/engine/cognition/closer-resolve.test.js
git commit -m "feat(step24): closer resolves warnings when channel flag transitions to COLLECTED"
```

---

### Task 7.4: Flip closer + termination config on

**Files:**
- Modify: `config/home.yaml`

- [ ] **Step 1: Flip**

```yaml
osEngine:
  closer:
    terminationContractRequired: true
    dedupeBeforeSpawn: true
```

- [ ] **Step 2: Restart + verify**

```bash
npm run build
pm2 restart home23-jerry home23-forrest
pm2 logs home23-jerry --lines 30 --nostream | grep -iE "closer|termination|dedupe"
```

- [ ] **Step 3: Commit**

```bash
git add config/home.yaml
git commit -m "feat(step24): activate closer — termination + dedupe + resolve"
```

---

### Phase 7 verification

- [ ] Jerry's active-goal count stabilizes (new unfinishable goals rejected at creation; existing ones grandfathered).
- [ ] Jerry's "Investigate why health data stopped 2026-04-13" auto-resolves on next `domain.health` COLLECTED observation.
- [ ] `brain/goals/complete/` accumulates new entries.

---

## Phase 8 — Neighbor protocol extension

Goal: each agent publishes a minimal public-state JSON. Neighbor channel polls peers. Cross-agent dispatch hints via existing sibling `sendMessage`.

### Task 8.1: Implement neighbor-state.ts (TS, harness-side)

**Files:**
- Create: `src/agent/neighbor-state.ts`
- Test: `tests/agent/neighbor-state.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/agent/neighbor-state.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPublicState, type PublicStateDeps } from '../../src/agent/neighbor-state.js';

test('buildPublicState returns a well-formed record', async () => {
  const deps: PublicStateDeps = {
    agent: 'jerry',
    getActiveGoals: () => [{ id: 'g1', title: 't', termination: { deliverable: 'x' }, ageMs: 10 }],
    getRecentObservations: (n) => [{ channelId: 'build.git', sourceRef: 'git:abc', receivedAt: '2026-04-21T00:00:00Z', producedAt: '2026-04-21T00:00:00Z', flag: 'COLLECTED', confidence: 0.9, payload: {} }],
    getCurrentFocus: () => 'health + build',
    getDispatchState: () => 'idle',
    getLastMemoryWrite: () => '2026-04-21T00:00:00Z',
  };
  const st = await buildPublicState(deps, { recentCount: 1 });
  assert.equal(st.agent, 'jerry');
  assert.equal(st.activeGoals.length, 1);
  assert.equal(st.recentObservations.length, 1);
  assert.equal(st.dispatchState, 'idle');
  assert.ok(st.snapshotAt);
});
```

- [ ] **Step 2: Implement**

```typescript
// src/agent/neighbor-state.ts
import type { VerifiedObservation } from './verification.js';

export interface PublicStateDeps {
  agent: string;
  getActiveGoals: () => Array<{ id: string; title: string; termination: unknown; ageMs: number }>;
  getRecentObservations: (n: number) => VerifiedObservation[];
  getCurrentFocus: () => string;
  getDispatchState: () => 'idle' | 'cognizing' | 'dispatched';
  getLastMemoryWrite: () => string;
}

export interface PublicState {
  agent: string;
  activeGoals: Array<{ id: string; title: string; termination: unknown; ageMs: number }>;
  recentObservations: VerifiedObservation[];
  currentFocus: string;
  dispatchState: 'idle' | 'cognizing' | 'dispatched';
  lastMemoryWrite: string;
  snapshotAt: string;
}

export async function buildPublicState(deps: PublicStateDeps, { recentCount = 20 }: { recentCount?: number } = {}): Promise<PublicState> {
  return {
    agent: deps.agent,
    activeGoals: deps.getActiveGoals(),
    recentObservations: deps.getRecentObservations(recentCount),
    currentFocus: deps.getCurrentFocus(),
    dispatchState: deps.getDispatchState(),
    lastMemoryWrite: deps.getLastMemoryWrite(),
    snapshotAt: new Date().toISOString(),
  };
}
```

- [ ] **Step 3: Run + commit**

```bash
node --import tsx --test tests/agent/neighbor-state.test.ts
git add src/agent/neighbor-state.ts tests/agent/neighbor-state.test.ts
git commit -m "feat(step24): buildPublicState — neighbor-visible agent snapshot"
```

---

### Task 8.2: Expose GET /__state/public.json and refresh on cadence

**Files:**
- Modify: `engine/src/dashboard/server.js` (or whatever serves HTTP per-agent)
- Modify: `src/home.ts` (to pass harness deps through)

- [ ] **Step 1: Add route**

In the existing dashboard server:

```javascript
app.get('/__state/public.json', async (req, res) => {
  try {
    const st = await deps.getPublicState();
    res.type('application/json').send(JSON.stringify(st));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```

- [ ] **Step 2: Build public-state cache with 60s refresh**

```javascript
let publicStateCache = null;
let publicStateAt = 0;
async function getPublicStateCached() {
  const now = Date.now();
  if (!publicStateCache || now - publicStateAt > 60_000) {
    publicStateCache = await buildPublicStateFromHarness();
    publicStateAt = now;
  }
  return publicStateCache;
}
```

- [ ] **Step 3: Verify endpoint**

```bash
curl http://localhost:$(pm2 jlist | jq -r '.[] | select(.name=="home23-jerry-dash").pm2_env.PORT')/__state/public.json | jq '.agent'
```

Expected: `"jerry"`.

- [ ] **Step 4: Commit**

```bash
git add engine/src/dashboard/server.js src/home.ts
git commit -m "feat(step24): /__state/public.json with 60s cache"
```

---

### Task 8.3: Implement neighbor/neighbor-channel.js

**Files:**
- Create: `engine/src/channels/neighbor/neighbor-channel.js`
- Test: `tests/engine/channels/neighbor/neighbor-channel.test.js`

- [ ] **Step 1: Write failing test**

```javascript
// tests/engine/channels/neighbor/neighbor-channel.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NeighborChannel } from '../../../../engine/src/channels/neighbor/neighbor-channel.js';

test('NeighborChannel poll fetches peer public state and emits deltas', async () => {
  let calls = 0;
  const ch = new NeighborChannel({
    peerName: 'forrest', url: 'http://x/__state/public.json', intervalMs: 10,
    fetchState: async () => { calls += 1; return { agent: 'forrest', activeGoals: [{ id: 'g1' }], lastMemoryWrite: `t-${calls}`, snapshotAt: `s-${calls}` }; },
  });
  const first = await ch.poll();
  assert.equal(first.length, 1);
  // Same lastMemoryWrite -> no emission
  assert.equal((await ch.poll()).length, 0);
});
```

- [ ] **Step 2: Implement**

```javascript
// engine/src/channels/neighbor/neighbor-channel.js
'use strict';
import { PollChannel } from '../base/poll-channel.js';
import { ChannelClass, makeObservation } from '../contract.js';

async function defaultFetch(url) {
  try {
    const res = await fetch(url, { method: 'GET', headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

export class NeighborChannel extends PollChannel {
  constructor({ peerName, url, intervalMs = 3 * 60 * 1000, fetchState = () => defaultFetch(url) }) {
    super({ id: `neighbor.${peerName}`, class: ChannelClass.NEIGHBOR, intervalMs });
    this.peerName = peerName;
    this.url = url;
    this.fetchState = fetchState;
    this._lastKey = null;
  }
  async poll() {
    const st = await this.fetchState();
    if (!st) return [];
    const key = `${st.lastMemoryWrite}:${st.snapshotAt}`;
    if (key === this._lastKey) return [];
    this._lastKey = key;
    return [st];
  }
  parse(raw) { return { payload: raw, sourceRef: `neighbor:${raw.agent}:${raw.snapshotAt}`, producedAt: raw.snapshotAt }; }
  verify(parsed) {
    return makeObservation({
      channelId: this.id, sourceRef: parsed.sourceRef, payload: parsed.payload,
      flag: 'UNCERTIFIED', confidence: 0.7, producedAt: parsed.producedAt, verifierId: `neighbor:${this.peerName}`,
    });
  }
  crystallize(obs) {
    return { method: 'neighbor_gossip', type: 'observation', topic: 'neighbor-state', tags: ['neighbor', this.peerName, obs.payload.dispatchState] };
  }
}
```

- [ ] **Step 3: Run + commit**

```bash
node --test tests/engine/channels/neighbor/neighbor-channel.test.js
git add engine/src/channels/neighbor/neighbor-channel.js tests/engine/channels/neighbor/neighbor-channel.test.js
git commit -m "feat(step24): NeighborChannel — polls peer /__state/public.json"
```

---

### Task 8.4: Register neighbor channels from config

**Files:**
- Modify: `engine/src/index.js`
- Modify: `config/home.yaml` — flip neighbor.enabled: true

- [ ] **Step 1: Discover peers from home.yaml agent list**

```javascript
import { NeighborChannel } from './channels/neighbor/neighbor-channel.js';

const neighborCfg = config.osEngine?.channels?.neighbor;
if (neighborCfg?.enabled) {
  const peers = neighborCfg.peers === 'auto'
    ? (config.agents || []).filter((a) => a !== agentName)
    : (neighborCfg.peers || []);
  for (const peer of peers) {
    const port = resolveAgentDashboardPort(peer); // from ecosystem.config.cjs or home.yaml
    if (!port) continue;
    channelBus.register(new NeighborChannel({
      peerName: peer,
      url: `http://localhost:${port}/__state/public.json`,
      intervalMs: parseDuration(neighborCfg.poll || '3m'),
    }));
  }
}
```

- [ ] **Step 2: Flip config**

```yaml
osEngine:
  channels:
    neighbor:
      enabled: true
      poll: 3m
      peers: auto
```

- [ ] **Step 3: Restart + verify**

```bash
npm run build
pm2 restart home23-jerry home23-forrest
curl http://localhost:<jerry-dash>/__state/public.json
pm2 logs home23-jerry --lines 30 --nostream | grep -i neighbor
```

Expected: jerry polls forrest's public state and emits neighbor observations.

- [ ] **Step 4: Commit**

```bash
git add engine/src/index.js config/home.yaml
git commit -m "feat(step24): register neighbor channels, flip config on"
```

---

### Phase 8 verification

- [ ] Jerry dive-mode query cites a forrest-observed event tagged `neighbor.forrest` without being told.
- [ ] `GET /__state/public.json` returns well-formed state for each agent.
- [ ] neighbor channel persistence file growing: `instances/jerry/brain/channels/neighbor.neighbor.forrest.jsonl`.

---


## Phase 9 — Publish layer activation

Goal: workspace insights publisher on 50-cycle cadence, dream-log publisher on critic-keep verdict for creative outputs, bridge-chat publisher for high-salience observations, dashboard surface publishers replaced with observation-grounded writers. Starvation floors trigger flags when cadence slips.

### Task 9.1: Implement publish-ledger (cadence + starvation detection)

**Files:**
- Create: `engine/src/publish/publish-ledger.js`
- Test: `tests/engine/publish/publish-ledger.test.js`

- [ ] **Step 1: Write failing test**

```javascript
// tests/engine/publish/publish-ledger.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PublishLedger } from '../../../engine/src/publish/publish-ledger.js';

test('PublishLedger records publications and detects starvation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pl-'));
  const ledger = new PublishLedger({ path: join(dir, 'publish-ledger.jsonl'), starvationFloor: { workspace_insights: 6 * 3600 * 1000 } });
  await ledger.record({ target: 'workspace_insights', artifact: 'x.md', at: Date.now() - 7 * 3600 * 1000 });
  const starving = ledger.listStarving({ now: Date.now() });
  assert.ok(starving.includes('workspace_insights'));
  await ledger.record({ target: 'workspace_insights', artifact: 'y.md', at: Date.now() });
  assert.equal(ledger.listStarving({ now: Date.now() }).length, 0);
});
```

- [ ] **Step 2: Implement**

```javascript
// engine/src/publish/publish-ledger.js
'use strict';
import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class PublishLedger {
  constructor({ path, starvationFloor = {} }) {
    this.path = path;
    this.starvationFloor = starvationFloor; // target -> maxQuietMs
    this._entries = this._load();
  }
  _load() {
    if (!existsSync(this.path)) return [];
    try {
      return readFileSync(this.path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch { return []; }
  }
  async record({ target, artifact, at = Date.now() }) {
    mkdirSync(dirname(this.path), { recursive: true });
    const row = { target, artifact, at };
    this._entries.push(row);
    appendFileSync(this.path, JSON.stringify(row) + '\n');
  }
  lastAt(target) {
    for (let i = this._entries.length - 1; i >= 0; i -= 1) {
      if (this._entries[i].target === target) return this._entries[i].at;
    }
    return null;
  }
  listStarving({ now = Date.now() } = {}) {
    const starving = [];
    for (const [target, maxQuietMs] of Object.entries(this.starvationFloor)) {
      const last = this.lastAt(target);
      if (last === null || (now - last) > maxQuietMs) starving.push(target);
    }
    return starving;
  }
}
```

- [ ] **Step 3: Run + commit**

```bash
node --test tests/engine/publish/publish-ledger.test.js
git add engine/src/publish/publish-ledger.js tests/engine/publish/publish-ledger.test.js
git commit -m "feat(step24): PublishLedger — cadence tracking + starvation detection"
```

---

### Task 9.2: Implement workspace-insights publisher

**Files:**
- Create: `engine/src/publish/workspace-insights.js`
- Test: `tests/engine/publish/workspace-insights.test.js`

- [ ] **Step 1: Write failing test**

```javascript
// tests/engine/publish/workspace-insights.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceInsightsPublisher } from '../../../engine/src/publish/workspace-insights.js';

test('publish on every N cycles writes a dated artifact', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wi-'));
  const pub = new WorkspaceInsightsPublisher({
    outDir: dir,
    cadenceCycles: 2,
    selectCluster: () => ({ topic: 'health', observations: [{ sourceRef: 'x' }], summary: 'HRV trend' }),
    ledger: { record: async () => {} },
  });
  await pub.onCycle({ cycleIndex: 1 });
  assert.equal(readdirSync(dir).length, 0);
  await pub.onCycle({ cycleIndex: 2 });
  assert.equal(readdirSync(dir).length, 1);
});
```

- [ ] **Step 2: Implement**

```javascript
// engine/src/publish/workspace-insights.js
'use strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export class WorkspaceInsightsPublisher {
  constructor({ outDir, cadenceCycles = 50, selectCluster, ledger }) {
    this.outDir = outDir;
    this.cadenceCycles = cadenceCycles;
    this.selectCluster = selectCluster; // () => { topic, observations, summary }
    this.ledger = ledger;
  }
  async onCycle({ cycleIndex }) {
    if (cycleIndex % this.cadenceCycles !== 0) return null;
    const cluster = await this.selectCluster();
    if (!cluster) return null;
    mkdirSync(this.outDir, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    const slug = (cluster.topic || 'insight').replace(/[^a-z0-9-]+/gi, '-').toLowerCase();
    const path = join(this.outDir, `${date}-${slug}.md`);
    const body = [
      `# Insight — ${cluster.topic}`,
      '',
      `**Cycle:** ${cycleIndex}`,
      `**Generated:** ${new Date().toISOString()}`,
      '',
      '## Summary',
      cluster.summary || '',
      '',
      '## Source Observations',
      (cluster.observations || []).map((o) => `- ${o.sourceRef}`).join('\n'),
      '',
    ].join('\n');
    writeFileSync(path, body);
    await this.ledger.record({ target: 'workspace_insights', artifact: path });
    return path;
  }
}
```

- [ ] **Step 3: Run + commit**

```bash
node --test tests/engine/publish/workspace-insights.test.js
git add engine/src/publish/workspace-insights.js tests/engine/publish/workspace-insights.test.js
git commit -m "feat(step24): WorkspaceInsightsPublisher — 50-cycle artifact cadence"
```

---

### Task 9.3: Implement dream-log publisher (critic-keep gated)

**Files:**
- Create: `engine/src/publish/dream-log.js`
- Test: `tests/engine/publish/dream-log.test.js`

- [ ] **Step 1: Write failing test**

```javascript
// tests/engine/publish/dream-log.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DreamLogPublisher } from '../../../engine/src/publish/dream-log.js';

test('publishes only on critic-keep verdict for creative output', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dl-'));
  const pub = new DreamLogPublisher({ outDir: dir, ledger: { record: async () => {} } });
  await pub.onCriticVerdict({ role: 'critic', verdict: 'discard', output: { claim: 'x' }, creative: { text: 't' } });
  assert.equal(readdirSync(dir).length, 0);
  await pub.onCriticVerdict({ role: 'critic', verdict: 'keep', output: { claim: 'x' }, creative: { title: 'moon', text: 'poem' } });
  assert.equal(readdirSync(dir).length, 1);
});
```

- [ ] **Step 2: Implement**

```javascript
// engine/src/publish/dream-log.js
'use strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export class DreamLogPublisher {
  constructor({ outDir, ledger }) {
    this.outDir = outDir;
    this.ledger = ledger;
  }
  async onCriticVerdict({ verdict, creative }) {
    if (verdict !== 'keep' || !creative) return null;
    mkdirSync(this.outDir, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    const slug = (creative.title || 'dream').replace(/[^a-z0-9-]+/gi, '-').toLowerCase().slice(0, 40);
    const path = join(this.outDir, `${date}-${slug}.md`);
    const body = [`# ${creative.title || 'Dream'}`, '', creative.text || '', ''].join('\n');
    writeFileSync(path, body);
    await this.ledger.record({ target: 'dream_log', artifact: path });
    return path;
  }
}
```

- [ ] **Step 3: Run + commit**

```bash
node --test tests/engine/publish/dream-log.test.js
git add engine/src/publish/dream-log.js tests/engine/publish/dream-log.test.js
git commit -m "feat(step24): DreamLogPublisher — gated on critic-keep verdict"
```

---

### Task 9.4: Implement bridge-chat publisher (salience-threshold gated)

**Files:**
- Create: `engine/src/publish/bridge-chat-publisher.js`
- Test: `tests/engine/publish/bridge-chat-publisher.test.js`

- [ ] **Step 1: Write failing test**

```javascript
// tests/engine/publish/bridge-chat-publisher.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BridgeChatPublisher } from '../../../engine/src/publish/bridge-chat-publisher.js';

test('publishes only when salience >= threshold', async () => {
  const sent = [];
  const pub = new BridgeChatPublisher({ salienceThreshold: 0.75, sender: async (m) => sent.push(m), ledger: { record: async () => {} } });
  await pub.onObservation({ salience: 0.6, summary: 'small' });
  assert.equal(sent.length, 0);
  await pub.onObservation({ salience: 0.9, summary: 'big' });
  assert.equal(sent.length, 1);
});
```

- [ ] **Step 2: Implement**

```javascript
// engine/src/publish/bridge-chat-publisher.js
'use strict';
export class BridgeChatPublisher {
  constructor({ salienceThreshold = 0.75, sender, ledger }) {
    this.salienceThreshold = salienceThreshold;
    this.sender = sender;
    this.ledger = ledger;
  }
  async onObservation({ salience, summary, observation }) {
    if (typeof salience !== 'number' || salience < this.salienceThreshold) return null;
    await this.sender({ text: summary, observation });
    await this.ledger.record({ target: 'bridge_chat', artifact: `bridge:${new Date().toISOString()}` });
    return true;
  }
}
```

Salience computation is out-of-scope for Phase 9 implementation; a simple default uses `confidence * (novelty_boost)` from the channel. The publisher accepts pre-computed salience.

- [ ] **Step 3: Run + commit**

```bash
node --test tests/engine/publish/bridge-chat-publisher.test.js
git add engine/src/publish/bridge-chat-publisher.js tests/engine/publish/bridge-chat-publisher.test.js
git commit -m "feat(step24): BridgeChatPublisher — salience-threshold gated"
```

---

### Task 9.5: Wire publishers into engine loop

**Files:**
- Modify: `engine/src/index.js`
- Modify: `engine/src/cognition/thinking-machine.js`

- [ ] **Step 1: Construct publishers at boot**

```javascript
import { PublishLedger } from './publish/publish-ledger.js';
import { WorkspaceInsightsPublisher } from './publish/workspace-insights.js';
import { DreamLogPublisher } from './publish/dream-log.js';
import { BridgeChatPublisher } from './publish/bridge-chat-publisher.js';

const publishLedger = new PublishLedger({
  path: join(brainDir, 'publish-ledger.jsonl'),
  starvationFloor: {
    workspace_insights: parseDuration(config.osEngine?.publish?.starvationFloor?.workspace_insights || '6h'),
    dashboard: parseDuration(config.osEngine?.publish?.starvationFloor?.dashboard || '15m'),
  },
});

const workspaceInsights = new WorkspaceInsightsPublisher({
  outDir: join(workspacePath, 'insights'),
  cadenceCycles: parseCadenceCycles(config.osEngine?.publish?.targets?.workspace_insights?.cadence || '50cycles'),
  selectCluster: () => selectHighestConfidenceCluster(memoryObjectStore),
  ledger: publishLedger,
});

const dreamLog = new DreamLogPublisher({
  outDir: join(workspacePath, 'dreams'),
  ledger: publishLedger,
});

const bridgePublisher = new BridgeChatPublisher({
  salienceThreshold: config.osEngine?.publish?.targets?.bridge_chat?.salience_threshold ?? 0.75,
  sender: bridgeChatSender,   // existing bridge-chat send API
  ledger: publishLedger,
});
```

- [ ] **Step 2: Hook into cycle events**

```javascript
thinkingMachine.on('cycleComplete', async (evt) => {
  try { await workspaceInsights.onCycle({ cycleIndex: evt.cycleIndex }); }
  catch (err) { logger.warn?.('[publish] workspace-insights failed:', err?.message); }
});

thinkingMachine.on('criticVerdict', async (evt) => {
  try { await dreamLog.onCriticVerdict(evt); }
  catch (err) { logger.warn?.('[publish] dream-log failed:', err?.message); }
});

channelBus.on('observation', async (obs) => {
  const salience = computeSalience(obs, memoryObjectStore);
  const summary = `[${obs.channelId}] ${summarize(obs.payload)}`;
  try { await bridgePublisher.onObservation({ salience, summary, observation: obs }); }
  catch (err) { logger.warn?.('[publish] bridge-chat failed:', err?.message); }
});

// Starvation monitor every 5 min:
setInterval(() => {
  const starving = publishLedger.listStarving();
  if (starving.length) logger.warn?.(`[publish] starvation: ${starving.join(', ')}`);
}, 5 * 60 * 1000);
```

- [ ] **Step 3: Emit cycleComplete + criticVerdict events from thinking-machine**

In `engine/src/cognition/thinking-machine.js`, extend the existing EventEmitter-style emissions to include `cycleComplete` (with cycleIndex) and `criticVerdict` (with verdict + creative bundle if present).

- [ ] **Step 4: Commit**

```bash
git add engine/src/index.js engine/src/cognition/thinking-machine.js
git commit -m "feat(step24): wire publishers into engine cycle + bus events"
```

---

### Task 9.6: Dashboard surface publishers (replace free-form curator prose)

**Files:**
- Create: `engine/src/publish/dashboard-publisher.js`
- Modify: `engine/src/core/curator-cycle.js`

- [ ] **Step 1: Implement DashboardPublisher**

```javascript
// engine/src/publish/dashboard-publisher.js
'use strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export class DashboardPublisher {
  constructor({ workspacePath, ledger }) {
    this.workspacePath = workspacePath;
    this.ledger = ledger;
  }
  async writeSurface({ surface, proposed_text, source_observations, confidence }) {
    if (!Array.isArray(source_observations) || source_observations.length === 0) {
      throw new Error('dashboard surface requires source_observations');
    }
    const path = join(this.workspacePath, surface);
    const header = [
      `<!-- generated ${new Date().toISOString()} -->`,
      `<!-- sources: ${source_observations.join(', ')} -->`,
      `<!-- confidence: ${confidence} -->`,
      '',
    ].join('\n');
    writeFileSync(path, header + proposed_text);
    await this.ledger.record({ target: 'dashboard', artifact: path });
    return path;
  }
}
```

- [ ] **Step 2: Curator cycle uses DashboardPublisher**

In `engine/src/core/curator-cycle.js`, route curator surface writes through `DashboardPublisher.writeSurface`. Any curator output that fails `validateRoleOutput('curator', output, { strict: true })` is logged to `role-integrity-violations.jsonl` and dropped.

- [ ] **Step 3: Flip publish config on in home.yaml**

No config change needed — publish block already has targets enabled. Dashboard publisher is constructed unconditionally because `curator-cycle` already runs.

- [ ] **Step 4: Restart + verify**

```bash
npm run build
pm2 restart home23-jerry
pm2 logs home23-jerry --lines 50 --nostream | grep -iE "publish|curator|dashboard"
ls -la /Users/jtr/_JTR23_/release/home23/instances/jerry/brain/publish-ledger.jsonl
```

Expected: ledger growing; curator writes now carry source-observation headers.

- [ ] **Step 5: Commit**

```bash
git add engine/src/publish/dashboard-publisher.js engine/src/core/curator-cycle.js
git commit -m "feat(step24): DashboardPublisher — curator surface writes must cite observations"
```

---

### Phase 9 verification

- [ ] `workspace/insights/` grows by at least one artifact per 6h of engine uptime.
- [ ] `workspace/dreams/` populates when critic-keep fires on creative output.
- [ ] Bridge-chat receives messages only for high-salience observations (not noise).
- [ ] Dashboard surfaces (TOPOLOGY.md, RECENT.md, PROJECTS.md) carry source-observation headers.
- [ ] `publish-ledger.jsonl` shows all four target classes publishing.
- [ ] Starvation log line fires only when a target genuinely goes quiet beyond its floor.

---

## Post-migration: kill the old "surreal cycle 1181" regression

After all phases land and run for one week, jerry's dive-mode queries re-run:

- [ ] Memory Nodes: dive-mode reports >> 0.
- [ ] Role-integrity-violations tapering to near-zero.
- [ ] Active goal count: stabilizes at a curated handful, not 18.
- [ ] Cross-agent observations: jerry references forrest events without prompting.
- [ ] Publish cadence: all four target classes above their starvation floors.
- [ ] "Memory Nodes: 0 / Thoughts: NNNN" signature from 2026-04-21 no longer appears.

---

## Self-Review

### Spec coverage

- [x] OBSERVE — Phases 2, 3, 4 wire six channel classes (build, work, domain, machine, os, neighbor).
- [x] VERIFY — Task 0.1 + Task 0.2 + verify() in every channel; ZERO_CONTEXT legal (weather example).
- [x] CRYSTALLIZE — Tasks 2.1 (CHANNEL_CAPS), 2.2 (ingestObservation + receipts), 2.3 (bus -> memory wiring). Back-pressure ratchet is deferred — noted below.
- [x] COGNIZE (role integrity) — Phase 6.
- [x] CLOSE — Phase 7 (termination, dedupe, resolve).
- [x] NEIGHBOR — Phase 8.
- [x] PUBLISH — Phase 9.

### Gaps identified during self-review

**Gap 1: Back-pressure ratchet (spec §Crystallization Pipeline) is not yet implemented.** The spec says: "if N cycles pass without a receipt, next cycle is constrained to `crystallize`." Add this as Task 7.5 before Phase 7 verification.

#### Task 7.5: Back-pressure ratchet in thinking-machine

**Files:** Modify `engine/src/cognition/thinking-machine.js`

- [ ] **Step 1: Write failing test**

```javascript
// tests/engine/cognition/backpressure.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkBackpressure } from '../../../engine/src/cognition/thinking-machine.js';

test('checkBackpressure returns true when cyclesWithoutReceipt exceeds threshold', () => {
  assert.equal(checkBackpressure({ cyclesWithoutReceipt: 12, threshold: 10 }), true);
  assert.equal(checkBackpressure({ cyclesWithoutReceipt: 5, threshold: 10 }), false);
});
```

- [ ] **Step 2: Implement + wire**

In `thinking-machine.js`, export a pure `checkBackpressure` and use it each cycle: if true, skip discover/deep-dive/connect/critique and only run crystallize (bus observation drain). Reset counter on receipt write.

- [ ] **Step 3: Commit**

```bash
git add engine/src/cognition/thinking-machine.js tests/engine/cognition/backpressure.test.js
git commit -m "feat(step24): back-pressure ratchet — constrain cycle to crystallize after N quiet cycles"
```

**Gap 2: Discovery external-candidate hook (spec §The Inner Cognitive Subsystem)** — mentioned in Phase 6 scope implicitly but no explicit task. Add as Task 6.4.

#### Task 6.4: Discovery accepts external observations as candidates

**Files:** Modify `engine/src/cognition/discovery-engine.js`

- [ ] **Step 1: Write failing test**

```javascript
// tests/engine/cognition/discovery-external.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DiscoveryEngine } from '../../../engine/src/cognition/discovery-engine.js';

test('DiscoveryEngine accepts external observation candidates and includes them in selection', async () => {
  const de = new DiscoveryEngine({ /* minimal deps */ });
  de.injectObservation({ channelId: 'domain.pressure', sourceRef: 'x', flag: 'COLLECTED', confidence: 0.9, payload: { pressure_pa: 100000 } });
  const cand = await de.selectCandidate();
  assert.ok(cand);
  assert.equal(cand.source, 'observation');
});

test('observation-silence signal fires when a known channel goes quiet', async () => {
  const de = new DiscoveryEngine({ /* minimal deps */ });
  de.injectObservation({ channelId: 'domain.health', sourceRef: 'old', flag: 'COLLECTED', confidence: 0.9, payload: {}, producedAt: new Date(Date.now() - 25*3600*1000).toISOString() });
  const signals = de.computeSignals({ now: Date.now() });
  assert.ok(signals.find((s) => s.type === 'observation-silence' && s.channelId === 'domain.health'));
});
```

- [ ] **Step 2: Implement `injectObservation`, observation-pool, and `observation-silence`/`observation-delta`/`neighbor-divergence` signals**

Add to `DiscoveryEngine`:

```javascript
this._observationPool = [];
this._lastSeenByChannel = new Map();

injectObservation(obs) {
  this._observationPool.push(obs);
  if (this._observationPool.length > 200) this._observationPool.shift();
  this._lastSeenByChannel.set(obs.channelId, Date.now());
}

computeSignals({ now = Date.now() } = {}) {
  const signals = [...this._computeInternalSignals()];
  // observation-silence: any known channel quiet > 3h
  for (const [channelId, lastAt] of this._lastSeenByChannel) {
    if (now - lastAt > 3 * 3600 * 1000) {
      signals.push({ type: 'observation-silence', channelId, quietMs: now - lastAt });
    }
  }
  // observation-delta: channels with >3 new observations in last window
  const byChannel = new Map();
  for (const o of this._observationPool) {
    byChannel.set(o.channelId, (byChannel.get(o.channelId) || 0) + 1);
  }
  for (const [channelId, count] of byChannel) {
    if (count >= 3) signals.push({ type: 'observation-delta', channelId, count });
  }
  return signals;
}

async selectCandidate() {
  const signals = this.computeSignals();
  const deltaSignal = signals.find((s) => s.type === 'observation-delta');
  if (deltaSignal) {
    return { source: 'observation', channelId: deltaSignal.channelId, ...this._makeCandidateFromObservations(deltaSignal.channelId) };
  }
  return await this._selectInternalCandidate();
}
```

- [ ] **Step 3: Wire bus observations into DiscoveryEngine**

In `engine/src/index.js`:

```javascript
channelBus.on('observation', (obs) => discoveryEngine.injectObservation(obs));
```

- [ ] **Step 4: Commit**

```bash
git add engine/src/cognition/discovery-engine.js engine/src/index.js tests/engine/cognition/discovery-external.test.js
git commit -m "feat(step24): DiscoveryEngine accepts external observations; observation-silence/delta signals"
```

**Gap 3: `observation-ingress.ts` (harness-side bridge)** — listed in file-structure but no task. Address: this module's job is to feed *harness-side* events (bridge-chat messages, Telegram, dashboard chat user input) into the bus as channels. Optional for the primary proof-of-life; defer to a Phase 9.x follow-up task.

#### Task 9.7 (optional, post-bar): Harness observation-ingress

**Files:** Create `src/agent/observation-ingress.ts`

Scope: stand up a thin ingress that converts bridge-chat inbound messages into `channel: harness.bridge` verified observations. Skip if out of scope for the first pass — the bus already receives cognition NOTIFY via the notify channel, which covers the most important harness-to-engine path.

### Placeholder scan

Searched plan for `TBD`, `TODO`, `later`, `similar to task`, `add appropriate`, `implement later`, "Fill in":

- No `TBD` or `TODO` used.
- No "similar to task" shorthand.
- Task 4.3 (disk-channel) has code complete; description is shorter than Task 4.2 but code is full.
- Task 4.5 (cron + fswatch-home23) covers two channels in one task section. Both channels' full code is shown.
- Integration points like `computeSalience` and `selectHighestConfidenceCluster` are introduced by name in Task 9.5 — they need implementations too. Adding Task 9.8.

#### Task 9.8: Salience computation + cluster selection helpers

**Files:** Create `engine/src/publish/salience.js`, `engine/src/publish/cluster-selection.js`

- [ ] **Step 1: Write tests** (simple — high-confidence + recent + rare-channel => high salience)
- [ ] **Step 2: Implement**

```javascript
// engine/src/publish/salience.js
'use strict';
export function computeSalience(obs, memory) {
  const base = obs.confidence ?? 0.5;
  const isCollected = obs.flag === 'COLLECTED' ? 1 : obs.flag === 'UNCERTIFIED' ? 0.7 : 0.3;
  const ageMs = Date.now() - Date.parse(obs.receivedAt);
  const recency = Math.max(0, 1 - ageMs / (30 * 60 * 1000)); // 30-min window
  const rarity = memory?.channelRarity?.(obs.channelId) ?? 0.5;
  return Math.min(1, base * isCollected * (0.5 + 0.5 * recency) * (0.5 + 0.5 * rarity));
}
```

```javascript
// engine/src/publish/cluster-selection.js
'use strict';
export function selectHighestConfidenceCluster(memory) {
  const all = memory?.list?.() || [];
  if (!all.length) return null;
  const byTopic = new Map();
  for (const mo of all) {
    const t = mo.topic || 'uncategorized';
    if (!byTopic.has(t)) byTopic.set(t, { topic: t, observations: [], totalConfidence: 0 });
    const group = byTopic.get(t);
    group.observations.push(mo);
    group.totalConfidence += mo.confidence || 0;
  }
  const sorted = [...byTopic.values()].sort((a, b) => b.totalConfidence - a.totalConfidence);
  const top = sorted[0];
  if (!top) return null;
  return {
    topic: top.topic,
    observations: top.observations.slice(0, 10),
    summary: `Top cluster by confidence: ${top.topic} (${top.observations.length} observations, total confidence ${top.totalConfidence.toFixed(2)})`,
  };
}
```

- [ ] **Step 3: Commit**

```bash
git add engine/src/publish/salience.js engine/src/publish/cluster-selection.js tests/engine/publish/
git commit -m "feat(step24): salience + cluster-selection helpers for publishers"
```

### Type consistency check

- `VerificationFlag` enum declared in `src/agent/verification.ts` (TS) and the flag set repeated in `engine/src/channels/contract.js` (JS) — different languages, same literal set. Verified.
- `makeObservation()` used consistently across channel files.
- `MemoryObject` shape assumes a `topic` field and `tags` field — both referenced in ingestObservation, applyDecay, selectHighestConfidenceCluster, closer.dedupeBeforeSpawn. Consistent.
- `crystallize()` returns `{ method, type, topic, tags }` everywhere it returns non-null. Consistent.
- Publisher constructors all take `{ ledger }` with a `record()` method. Consistent.
- `parseDuration` referenced but not implemented — add utility:

#### Task 0.11: Add parseDuration utility

**Files:** Create `engine/src/util/parse-duration.js`, test `tests/engine/util/parse-duration.test.js`

- [ ] **Step 1: Write test**

```javascript
// tests/engine/util/parse-duration.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDuration } from '../../../engine/src/util/parse-duration.js';

test('parses 30m / 48h / 30d / 45s', () => {
  assert.equal(parseDuration('30s'), 30_000);
  assert.equal(parseDuration('30m'), 30 * 60_000);
  assert.equal(parseDuration('48h'), 48 * 3600_000);
  assert.equal(parseDuration('30d'), 30 * 86400_000);
});
test('returns 0 on invalid input', () => { assert.equal(parseDuration('bogus'), 0); });
```

- [ ] **Step 2: Implement**

```javascript
// engine/src/util/parse-duration.js
'use strict';
export function parseDuration(s) {
  const m = /^(\d+)\s*(s|m|h|d)$/i.exec(String(s).trim());
  if (!m) return 0;
  const n = parseInt(m[1], 10);
  const u = m[2].toLowerCase();
  const mult = { s: 1000, m: 60_000, h: 3600_000, d: 86400_000 }[u];
  return n * mult;
}
```

- [ ] **Step 3: Commit**

```bash
git add engine/src/util/parse-duration.js tests/engine/util/parse-duration.test.js
git commit -m "feat(step24): parseDuration utility for config durations"
```

Insert this task between Task 0.8 and Task 0.9 in the Phase 0 order.

#### Task 0.12: Add parseCadenceCycles utility

**Files:** Create `engine/src/util/parse-cadence.js`

```javascript
// engine/src/util/parse-cadence.js
'use strict';
export function parseCadenceCycles(s) {
  const m = /^(\d+)\s*cycles?$/i.exec(String(s).trim());
  return m ? parseInt(m[1], 10) : 50;
}
```

Add trivial test + commit.

### Final plan order (for the executor)

Recommended execution order:

1. Phase 0: Tasks 0.1 through 0.12 (scaffolding + utilities)
2. Phase 1: Tasks 1.1 through 1.3 (promoter-as-channel)
3. Phase 2: Tasks 2.1 through 2.13 (build + work, first proof-of-life)
4. Phase 3: Tasks 3.1 through 3.5 (domain channels)
5. Phase 4: Tasks 4.1 through 4.6 (machine + OS channels)
6. Phase 5: Tasks 5.1 through 5.3 (decay worker)
7. Phase 6: Tasks 6.1 through 6.4 (role integrity + discovery external hook)
8. Phase 7: Tasks 7.1 through 7.5 (closer + back-pressure ratchet)
9. Phase 8: Tasks 8.1 through 8.4 (neighbor)
10. Phase 9: Tasks 9.1 through 9.8 (publish + salience/cluster helpers + optional observation-ingress)

Each phase has its own verification checklist. Do not advance past a phase's verification until its boxes are checked.

---

## Open questions (defaulted in plan; revisit at implementation time)

All five open questions from `docs/design/STEP24-OS-ENGINE-REDESIGN.md` §Open Questions are honored with the spec's proposed defaults:

1. Channel-class priority under back-pressure — default: neighbor > domain > machine > os > build > work > notify.
2. Crystallization cadence — observation-count-based with cycle-count ceiling (implemented as `cyclesWithoutReceiptThreshold`).
3. Neighbor trust — `UNCERTIFIED` with confidence 0.7 + decay via `neighbor_gossip` cap.
4. Role-schema strictness — soft-gate for 2 weeks (Task 6.2 default), then flip `roleIntegrity.enforce: true`.
5. Dream-log outputs — crystallize as MemoryObjects with `creative_hypothesis` tag at confidence 0.4 (add to Task 9.3 as a follow-up when observed behavior justifies it).

---

