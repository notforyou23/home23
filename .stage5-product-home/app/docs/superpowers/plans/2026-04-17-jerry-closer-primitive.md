# Jerry Closer Primitive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every goal in jerry's engine carries a verifiable `doneWhen` criterion that replaces self-reported progress. Gate rejects goals without one. Migration purges the 11 audit-tumor goals and retrofits the rest.

**Architecture:** New `done-when.js` verifier module with a primitive dispatch table (`file_exists`, `memory_node_tagged`, `judged`, etc.). `addGoal()` gate validates presence + non-vagueness. `goal.progress` becomes computed = `satisfiedCriteria / totalCriteria`. One-shot migration runs at engine startup gated by `goals.schemaVersion < 1`.

**Tech Stack:** Node.js 18+, Mocha + Chai for tests, existing `UnifiedClient` for LLM judge calls, existing `PathResolver` for path safety.

**Spec:** `docs/superpowers/specs/2026-04-17-jerry-closer-primitive-design.md`

---

## File Structure

**Created:**
- `engine/src/goals/done-when.js` — primitive dispatch + aggregate `checkDoneWhen`
- `engine/src/goals/done-when-gate.js` — schema validation + vagueness filter
- `engine/src/goals/migrations/2026-04-17-done-when.js` — migration planner + applier
- `engine/tests/unit/done-when.test.js`
- `engine/tests/unit/done-when-gate.test.js`
- `engine/tests/unit/done-when-migration.test.js`

**Modified:**
- `engine/src/goals/intrinsic-goals.js` — `addGoal()` gate, progress computation in rotation loop
- `engine/src/goals/goal-curator.js` — LLM prompts require `doneWhen` in output
- `engine/src/goals/goal-capture.js` — same
- `engine/src/core/orchestrator.js` — migration invocation at startup
- `configs/base-engine.yaml` — `goals.doneWhen.*` config block

**Untouched for this PR (explicit):**
- Critic role (separate PR)
- Dedup-before-spawn (separate PR)
- Dashboard tile (engine-logs only in this PR; tile is a follow-up)

---

## Conventions for all tasks

- Test framework: Mocha + Chai (`const { expect } = require('chai')`). Pattern matches `engine/tests/unit/path-resolver.test.js`.
- Tests run via `npx mocha engine/tests/unit/<file>.test.js --timeout 10000` from the repo root, or `npm run test:unit` from `engine/`.
- Every task ends with a `git add <files> && git commit` step. One task = one commit on the working branch.
- Commit messages: `feat(goals): ...` for features, `test(goals): ...` if test-only, `refactor(goals): ...` when only restructuring.
- DO NOT use `--no-verify` on commits.
- Paths are resolved absolute from the repo root `/Users/jtr/_JTR23_/release/home23/`.

---

## Task 1: Primitive verifiers (non-LLM)

**Files:**
- Create: `engine/src/goals/done-when.js`
- Create: `engine/tests/unit/done-when.test.js`

This task lands five deterministic primitives with no external dependencies beyond `fs`, `path`, and a memory map passed in via `env`. No LLM yet.

- [ ] **Step 1: Write the failing tests for five primitives**

Create `engine/tests/unit/done-when.test.js`:

```js
/**
 * done-when.js primitive tests.
 * Each primitive is a pure function given an env object.
 * LLM-based `judged` primitive is tested separately in Task 2.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { expect } = require('chai');
const { checkCriterion } = require('../../src/goals/done-when');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'done-when-'));
}

function mkNode(id, concept, tag) {
  return { id, concept, tag, created: new Date().toISOString() };
}

function makeEnv({ outputsDir, brainDir, nodes = [] } = {}) {
  const memory = { nodes: new Map(nodes.map(n => [n.id, n])) };
  return {
    memory,
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    outputsDir: outputsDir || tmpDir(),
    brainDir: brainDir || tmpDir(),
  };
}

describe('done-when primitives', () => {
  describe('file_exists', () => {
    it('passes when file exists under outputsDir', async () => {
      const env = makeEnv();
      fs.writeFileSync(path.join(env.outputsDir, 'foo.md'), 'x');
      const result = await checkCriterion({ type: 'file_exists', path: 'foo.md' }, env);
      expect(result.passed).to.equal(true);
    });

    it('fails when file missing', async () => {
      const env = makeEnv();
      const result = await checkCriterion({ type: 'file_exists', path: 'missing.md' }, env);
      expect(result.passed).to.equal(false);
    });

    it('rejects path escaping outputsDir', async () => {
      const env = makeEnv();
      const result = await checkCriterion({ type: 'file_exists', path: '../../etc/passwd' }, env);
      expect(result.passed).to.equal(false);
      expect(result.note).to.match(/outside/i);
    });
  });

  describe('file_created_after', () => {
    it('passes when mtime > since', async () => {
      const env = makeEnv();
      const f = path.join(env.outputsDir, 'fresh.md');
      fs.writeFileSync(f, 'x');
      const since = Date.now() - 60_000;
      const result = await checkCriterion({ type: 'file_created_after', path: 'fresh.md', since }, env);
      expect(result.passed).to.equal(true);
    });

    it('fails when mtime <= since', async () => {
      const env = makeEnv();
      const f = path.join(env.outputsDir, 'old.md');
      fs.writeFileSync(f, 'x');
      const since = Date.now() + 60_000;
      const result = await checkCriterion({ type: 'file_created_after', path: 'old.md', since }, env);
      expect(result.passed).to.equal(false);
    });
  });

  describe('memory_node_tagged', () => {
    it('passes when any node has the tag (case-insensitive)', async () => {
      const env = makeEnv({ nodes: [mkNode(1, 'x', 'Resolved:Dashboard')] });
      const result = await checkCriterion({ type: 'memory_node_tagged', tag: 'resolved:dashboard' }, env);
      expect(result.passed).to.equal(true);
    });

    it('fails when no node has the tag', async () => {
      const env = makeEnv({ nodes: [mkNode(1, 'x', 'other')] });
      const result = await checkCriterion({ type: 'memory_node_tagged', tag: 'resolved:dashboard' }, env);
      expect(result.passed).to.equal(false);
    });
  });

  describe('memory_node_matches', () => {
    it('passes when a node concept matches regex', async () => {
      const env = makeEnv({ nodes: [mkNode(1, 'Ion channel comparative study', 't')] });
      const result = await checkCriterion({ type: 'memory_node_matches', regex: 'ion channel.*comparative' }, env);
      expect(result.passed).to.equal(true);
    });

    it('fails when no node concept matches regex', async () => {
      const env = makeEnv({ nodes: [mkNode(1, 'unrelated', 't')] });
      const result = await checkCriterion({ type: 'memory_node_matches', regex: 'ion channel' }, env);
      expect(result.passed).to.equal(false);
    });
  });

  describe('output_count_since', () => {
    it('passes when enough files have mtime > since', async () => {
      const env = makeEnv();
      fs.writeFileSync(path.join(env.outputsDir, 'a.md'), 'x');
      fs.writeFileSync(path.join(env.outputsDir, 'b.md'), 'x');
      const since = Date.now() - 60_000;
      const result = await checkCriterion(
        { type: 'output_count_since', dir: '.', since, gte: 2 }, env);
      expect(result.passed).to.equal(true);
    });

    it('fails when not enough recent files', async () => {
      const env = makeEnv();
      fs.writeFileSync(path.join(env.outputsDir, 'a.md'), 'x');
      const since = Date.now() - 60_000;
      const result = await checkCriterion(
        { type: 'output_count_since', dir: '.', since, gte: 3 }, env);
      expect(result.passed).to.equal(false);
    });
  });

  describe('unknown type', () => {
    it('returns passed=false with a note', async () => {
      const env = makeEnv();
      const result = await checkCriterion({ type: 'not_a_real_type' }, env);
      expect(result.passed).to.equal(false);
      expect(result.note).to.match(/unknown/i);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/jtr/_JTR23_/release/home23 && npx mocha engine/tests/unit/done-when.test.js --timeout 10000`

Expected: all tests fail with "Cannot find module '../../src/goals/done-when'".

- [ ] **Step 3: Implement the primitive dispatcher**

Create `engine/src/goals/done-when.js`:

```js
/**
 * done-when.js — goal-completion verifier.
 *
 * Every goal carries a `doneWhen.criteria` array. Each criterion is a
 * concrete, checkable condition. This module dispatches each criterion to
 * a primitive handler and returns whether it passed.
 *
 * Non-LLM primitives (this file) are synchronous-ish and cheap. The
 * LLM-based `judged` primitive lives alongside but has its own caching
 * contract.
 *
 * env shape:
 *   { memory, logger, outputsDir, brainDir, llmClient? }
 */

const fs = require('fs');
const path = require('path');

function resolveSafe(baseDir, relPath) {
  const full = path.resolve(baseDir, relPath);
  const rel = path.relative(baseDir, full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return null; // escaped outside baseDir
  }
  return full;
}

async function checkFileExists(crit, env) {
  const resolved = resolveSafe(env.outputsDir, crit.path);
  if (!resolved) return { passed: false, note: 'path outside outputsDir' };
  return { passed: fs.existsSync(resolved), note: resolved };
}

async function checkFileCreatedAfter(crit, env) {
  const resolved = resolveSafe(env.outputsDir, crit.path);
  if (!resolved) return { passed: false, note: 'path outside outputsDir' };
  if (!fs.existsSync(resolved)) return { passed: false, note: 'missing' };
  const stat = fs.statSync(resolved);
  const since = typeof crit.since === 'string' ? Date.parse(crit.since) : Number(crit.since);
  return { passed: stat.mtimeMs > since, note: `mtime=${stat.mtimeMs} since=${since}` };
}

async function checkMemoryNodeTagged(crit, env) {
  const tag = String(crit.tag || '').toLowerCase();
  if (!tag) return { passed: false, note: 'empty tag' };
  if (!env.memory?.nodes) return { passed: false, note: 'no memory' };
  for (const node of env.memory.nodes.values()) {
    if (String(node.tag || '').toLowerCase() === tag) {
      return { passed: true, note: `node id=${node.id}` };
    }
  }
  return { passed: false, note: 'no matching node' };
}

async function checkMemoryNodeMatches(crit, env) {
  if (!crit.regex) return { passed: false, note: 'no regex' };
  if (!env.memory?.nodes) return { passed: false, note: 'no memory' };
  let re;
  try { re = new RegExp(crit.regex, 'i'); }
  catch (err) { return { passed: false, note: `bad regex: ${err.message}` }; }
  for (const node of env.memory.nodes.values()) {
    if (re.test(node.concept || '')) {
      return { passed: true, note: `node id=${node.id}` };
    }
  }
  return { passed: false, note: 'no matching concept' };
}

async function checkOutputCountSince(crit, env) {
  const baseDir = crit.dir === '.' || !crit.dir ? env.outputsDir
    : resolveSafe(env.outputsDir, crit.dir);
  if (!baseDir) return { passed: false, note: 'dir outside outputsDir' };
  if (!fs.existsSync(baseDir)) return { passed: false, note: 'dir missing' };
  const since = typeof crit.since === 'string' ? Date.parse(crit.since) : Number(crit.since);
  const gte = Number(crit.gte) || 1;
  let count = 0;
  for (const name of fs.readdirSync(baseDir)) {
    const full = path.join(baseDir, name);
    const st = fs.statSync(full);
    if (st.isFile() && st.mtimeMs > since) count++;
  }
  return { passed: count >= gte, note: `count=${count} gte=${gte}` };
}

const DISPATCH = {
  file_exists: checkFileExists,
  file_created_after: checkFileCreatedAfter,
  memory_node_tagged: checkMemoryNodeTagged,
  memory_node_matches: checkMemoryNodeMatches,
  output_count_since: checkOutputCountSince,
  // judged: added in Task 2
};

async function checkCriterion(crit, env) {
  const handler = DISPATCH[crit?.type];
  if (!handler) return { passed: false, note: `unknown type: ${crit?.type}` };
  try {
    return await handler(crit, env);
  } catch (err) {
    return { passed: false, note: `handler error: ${err.message}` };
  }
}

module.exports = { checkCriterion, DISPATCH };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/jtr/_JTR23_/release/home23 && npx mocha engine/tests/unit/done-when.test.js --timeout 10000`

Expected: 12 passing (primitive tests, incl. unknown-type fallback).

- [ ] **Step 5: Commit**

```bash
git add engine/src/goals/done-when.js engine/tests/unit/done-when.test.js
git commit -m "feat(goals): add doneWhen primitive verifiers (file/memory/output)

Introduces engine/src/goals/done-when.js with 5 deterministic primitives:
file_exists, file_created_after, memory_node_tagged, memory_node_matches,
output_count_since. Each uses PathResolver-style containment. LLM-backed
judged primitive follows in the next commit."
```

---

## Task 2: Judge primitive + caching

**Files:**
- Modify: `engine/src/goals/done-when.js` (add `judged` handler)
- Modify: `engine/tests/unit/done-when.test.js` (add judge tests)

- [ ] **Step 1: Write failing tests for judged primitive**

Append to `engine/tests/unit/done-when.test.js` (before the closing of the main `describe`):

```js
  describe('judged', () => {
    function mockLlm(verdict, reason = 'ok') {
      return {
        calls: [],
        async chat({ messages }) {
          this.calls.push(messages);
          return { content: JSON.stringify({ verdict, reason }) };
        }
      };
    }

    it('calls LLM when judgedVerdict is null, caches the result', async () => {
      const env = makeEnv();
      env.llmClient = mockLlm('pass');
      const crit = {
        type: 'judged',
        criterion: 'An output file exists with at least 3 examples.',
        judgeModel: 'gpt-5-mini',
        judgedAt: null,
        judgedVerdict: null
      };
      const r1 = await checkCriterion(crit, env);
      expect(r1.passed).to.equal(true);
      expect(env.llmClient.calls).to.have.length(1);
      expect(crit.judgedVerdict).to.equal('pass');
      expect(crit.judgedAt).to.be.a('number');

      // Second call within TTL → no new LLM call
      const r2 = await checkCriterion(crit, env);
      expect(r2.passed).to.equal(true);
      expect(env.llmClient.calls).to.have.length(1);
    });

    it('treats fail verdict as passed=false', async () => {
      const env = makeEnv();
      env.llmClient = mockLlm('fail', 'missing examples');
      const crit = {
        type: 'judged',
        criterion: 'An output file exists with at least 3 examples.',
        judgedAt: null,
        judgedVerdict: null
      };
      const r = await checkCriterion(crit, env);
      expect(r.passed).to.equal(false);
      expect(r.note).to.match(/fail/i);
    });

    it('re-runs LLM after TTL elapses', async () => {
      const env = makeEnv();
      env.llmClient = mockLlm('pass');
      const crit = {
        type: 'judged',
        criterion: 'An output file exists with at least 3 examples.',
        judgedAt: Date.now() - 25 * 60 * 60 * 1000, // 25h ago, > 24h TTL
        judgedVerdict: 'pass'
      };
      const r = await checkCriterion(crit, env);
      expect(env.llmClient.calls).to.have.length(1);
      expect(r.passed).to.equal(true);
    });

    it('handles malformed LLM output as fail with a note', async () => {
      const env = makeEnv();
      env.llmClient = {
        async chat() { return { content: 'not json' }; }
      };
      const crit = { type: 'judged', criterion: 'anything at all, concrete enough', judgedAt: null, judgedVerdict: null };
      const r = await checkCriterion(crit, env);
      expect(r.passed).to.equal(false);
      expect(r.note).to.match(/parse|invalid/i);
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/jtr/_JTR23_/release/home23 && npx mocha engine/tests/unit/done-when.test.js --grep judged --timeout 10000`

Expected: 4 failing (judge not implemented).

- [ ] **Step 3: Implement the judged primitive**

Edit `engine/src/goals/done-when.js`. At the top, add the constant:

```js
const JUDGE_TTL_MS = 24 * 60 * 60 * 1000;
```

Before the `DISPATCH` declaration, add:

```js
async function checkJudged(crit, env) {
  const cachedValid = crit.judgedVerdict && crit.judgedAt
    && (Date.now() - Number(crit.judgedAt) < JUDGE_TTL_MS);
  if (cachedValid) {
    return {
      passed: crit.judgedVerdict === 'pass',
      note: `cached verdict=${crit.judgedVerdict}`,
      judgedAt: crit.judgedAt,
    };
  }
  if (!env.llmClient) {
    return { passed: false, note: 'no llmClient available' };
  }
  const prompt = [
    { role: 'system', content:
      'You are a strict verifier. Given a goal success criterion, decide whether the criterion is currently satisfied by observable artifacts in the environment. Return ONLY JSON: {"verdict":"pass"|"fail","reason":"<one sentence>"}.' },
    { role: 'user', content:
      `Criterion: ${crit.criterion}\n\nRespond with JSON only.` }
  ];
  let verdict, reason;
  try {
    const resp = await env.llmClient.chat({
      model: crit.judgeModel || 'gpt-5-mini',
      messages: prompt,
      max_completion_tokens: 200,
      temperature: 0.1,
    });
    const parsed = JSON.parse((resp.content || '').trim());
    verdict = parsed.verdict;
    reason = parsed.reason;
  } catch (err) {
    return { passed: false, note: `judge parse error: ${err.message}` };
  }
  if (verdict !== 'pass' && verdict !== 'fail') {
    return { passed: false, note: `judge invalid verdict: ${verdict}` };
  }
  crit.judgedAt = Date.now();
  crit.judgedVerdict = verdict;
  return {
    passed: verdict === 'pass',
    note: `verdict=${verdict} reason=${reason}`,
    judgedAt: crit.judgedAt,
  };
}
```

Add `judged: checkJudged,` to the `DISPATCH` table.

Export `JUDGE_TTL_MS`:

```js
module.exports = { checkCriterion, DISPATCH, JUDGE_TTL_MS };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/jtr/_JTR23_/release/home23 && npx mocha engine/tests/unit/done-when.test.js --timeout 10000`

Expected: 16 passing (12 primitive + 4 judge).

- [ ] **Step 5: Commit**

```bash
git add engine/src/goals/done-when.js engine/tests/unit/done-when.test.js
git commit -m "feat(goals): add LLM judge primitive with 24h cache

Adds 'judged' criterion type backed by gpt-5-mini (configurable per
criterion). Mutates crit.judgedAt/judgedVerdict in place so the goal
carries its own cache. TTL 24h, re-judges when elapsed."
```

---

## Task 3: `checkDoneWhen` aggregate + progress math

**Files:**
- Modify: `engine/src/goals/done-when.js` (add aggregate)
- Modify: `engine/tests/unit/done-when.test.js` (add aggregate tests)

- [ ] **Step 1: Write failing tests for aggregate**

Append to `engine/tests/unit/done-when.test.js`:

```js
describe('checkDoneWhen aggregate', () => {
  const { checkDoneWhen } = require('../../src/goals/done-when');

  it('computes satisfied/total across multiple criteria', async () => {
    const env = makeEnv();
    fs.writeFileSync(path.join(env.outputsDir, 'a.md'), 'x');
    const goal = {
      id: 'g1',
      doneWhen: {
        version: 1,
        criteria: [
          { type: 'file_exists', path: 'a.md' },
          { type: 'file_exists', path: 'b.md' } // missing
        ]
      }
    };
    const r = await checkDoneWhen(goal, env);
    expect(r.satisfied).to.equal(1);
    expect(r.total).to.equal(2);
    expect(r.details).to.have.length(2);
    expect(r.details[0].passed).to.equal(true);
    expect(r.details[1].passed).to.equal(false);
  });

  it('handles empty criteria as 0/0 (caller decides semantics)', async () => {
    const env = makeEnv();
    const goal = { id: 'g1', doneWhen: { version: 1, criteria: [] } };
    const r = await checkDoneWhen(goal, env);
    expect(r.satisfied).to.equal(0);
    expect(r.total).to.equal(0);
  });

  it('handles missing doneWhen as 0/0', async () => {
    const env = makeEnv();
    const goal = { id: 'g1' };
    const r = await checkDoneWhen(goal, env);
    expect(r.satisfied).to.equal(0);
    expect(r.total).to.equal(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/jtr/_JTR23_/release/home23 && npx mocha engine/tests/unit/done-when.test.js --grep aggregate --timeout 10000`

Expected: 3 failing (checkDoneWhen undefined).

- [ ] **Step 3: Implement the aggregate**

Edit `engine/src/goals/done-when.js`. Before `module.exports`:

```js
async function checkDoneWhen(goal, env) {
  const criteria = goal?.doneWhen?.criteria;
  if (!Array.isArray(criteria) || criteria.length === 0) {
    return { satisfied: 0, total: 0, details: [] };
  }
  const details = [];
  let satisfied = 0;
  for (const crit of criteria) {
    const r = await checkCriterion(crit, env);
    details.push({ type: crit.type, passed: !!r.passed, note: r.note, judgedAt: r.judgedAt });
    if (r.passed) satisfied++;
  }
  return { satisfied, total: criteria.length, details };
}
```

Update exports:

```js
module.exports = { checkCriterion, checkDoneWhen, DISPATCH, JUDGE_TTL_MS };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/jtr/_JTR23_/release/home23 && npx mocha engine/tests/unit/done-when.test.js --timeout 10000`

Expected: 19 passing.

- [ ] **Step 5: Commit**

```bash
git add engine/src/goals/done-when.js engine/tests/unit/done-when.test.js
git commit -m "feat(goals): add checkDoneWhen aggregate returning satisfied/total

The rotation loop will call this per goal to compute progress as
satisfied/total. Missing or empty doneWhen returns 0/0; caller decides
what that means (archiveGoal or ignore)."
```

---

## Task 4: Vagueness filter + gate validation

**Files:**
- Create: `engine/src/goals/done-when-gate.js`
- Create: `engine/tests/unit/done-when-gate.test.js`

- [ ] **Step 1: Write failing tests for gate**

Create `engine/tests/unit/done-when-gate.test.js`:

```js
const { expect } = require('chai');
const { validateDoneWhen, DEFAULT_VAGUENESS_CONFIG } = require('../../src/goals/done-when-gate');

describe('done-when-gate', () => {
  const knownTypes = ['file_exists', 'file_created_after', 'memory_node_tagged',
                      'memory_node_matches', 'output_count_since', 'judged'];

  it('accepts a well-formed doneWhen with a file_exists criterion', () => {
    const r = validateDoneWhen({
      version: 1,
      criteria: [{ type: 'file_exists', path: 'outputs/x.md' }]
    }, { knownTypes });
    expect(r.valid).to.equal(true);
  });

  it('rejects missing doneWhen', () => {
    const r = validateDoneWhen(undefined, { knownTypes });
    expect(r.valid).to.equal(false);
    expect(r.reason).to.match(/missing/i);
  });

  it('rejects empty criteria array', () => {
    const r = validateDoneWhen({ version: 1, criteria: [] }, { knownTypes });
    expect(r.valid).to.equal(false);
    expect(r.reason).to.match(/empty/i);
  });

  it('rejects unknown criterion type', () => {
    const r = validateDoneWhen({
      version: 1,
      criteria: [{ type: 'astrology_says_yes' }]
    }, { knownTypes });
    expect(r.valid).to.equal(false);
    expect(r.reason).to.match(/unknown/i);
  });

  it('rejects judged criterion shorter than min length', () => {
    const r = validateDoneWhen({
      version: 1,
      criteria: [{ type: 'judged', criterion: 'too short' }]
    }, { knownTypes, ...DEFAULT_VAGUENESS_CONFIG });
    expect(r.valid).to.equal(false);
    expect(r.reason).to.match(/short|vague/i);
  });

  it('rejects judged criterion with no concreteness anchor', () => {
    const r = validateDoneWhen({
      version: 1,
      criteria: [{ type: 'judged',
        criterion: 'deep thinking happens across many dimensions of thought' }]
    }, { knownTypes, ...DEFAULT_VAGUENESS_CONFIG });
    expect(r.valid).to.equal(false);
    expect(r.reason).to.match(/anchor|vague/i);
  });

  it('accepts judged criterion with an anchor keyword', () => {
    const r = validateDoneWhen({
      version: 1,
      criteria: [{ type: 'judged',
        criterion: 'An output file exists containing at least three concrete examples tied to sensor readings.' }]
    }, { knownTypes, ...DEFAULT_VAGUENESS_CONFIG });
    expect(r.valid).to.equal(true);
  });

  it('rejects file_exists without a path', () => {
    const r = validateDoneWhen({
      version: 1,
      criteria: [{ type: 'file_exists' }]
    }, { knownTypes });
    expect(r.valid).to.equal(false);
    expect(r.reason).to.match(/path/i);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/jtr/_JTR23_/release/home23 && npx mocha engine/tests/unit/done-when-gate.test.js --timeout 10000`

Expected: 8 failing (module missing).

- [ ] **Step 3: Implement the gate**

Create `engine/src/goals/done-when-gate.js`:

```js
/**
 * done-when-gate.js — validates a doneWhen block at goal creation.
 * Rejects missing, empty, unknown-type, or vague criteria.
 */

const DEFAULT_VAGUENESS_CONFIG = {
  minCriterionLength: 40,
  vaguenessAnchors: [
    'file', 'output', 'memory', 'node', 'count', 'exists',
    'at least', 'contains', 'written', 'published', 'produced',
    'delivered', 'ships', 'emits'
  ]
};

const REQUIRED_FIELDS = {
  file_exists: ['path'],
  file_created_after: ['path', 'since'],
  memory_node_tagged: ['tag'],
  memory_node_matches: ['regex'],
  output_count_since: ['since', 'gte'],
  judged: ['criterion'],
};

function validateDoneWhen(dw, opts = {}) {
  const knownTypes = opts.knownTypes || Object.keys(REQUIRED_FIELDS);
  const minLen = opts.minCriterionLength ?? DEFAULT_VAGUENESS_CONFIG.minCriterionLength;
  const anchors = opts.vaguenessAnchors || DEFAULT_VAGUENESS_CONFIG.vaguenessAnchors;

  if (!dw || typeof dw !== 'object') {
    return { valid: false, reason: 'missing doneWhen' };
  }
  if (!Array.isArray(dw.criteria)) {
    return { valid: false, reason: 'missing doneWhen.criteria array' };
  }
  if (dw.criteria.length === 0) {
    return { valid: false, reason: 'empty doneWhen.criteria' };
  }

  for (let i = 0; i < dw.criteria.length; i++) {
    const c = dw.criteria[i];
    if (!c || typeof c !== 'object') {
      return { valid: false, reason: `criterion[${i}] is not an object` };
    }
    if (!knownTypes.includes(c.type)) {
      return { valid: false, reason: `criterion[${i}] unknown type: ${c.type}` };
    }
    const required = REQUIRED_FIELDS[c.type] || [];
    for (const field of required) {
      if (c[field] === undefined || c[field] === null || c[field] === '') {
        return { valid: false, reason: `criterion[${i}] (${c.type}) missing field: ${field}` };
      }
    }
    if (c.type === 'judged') {
      const s = String(c.criterion);
      if (s.length < minLen) {
        return { valid: false, reason: `criterion[${i}] judged text too short (<${minLen} chars) — too vague` };
      }
      const lower = s.toLowerCase();
      const hasAnchor = anchors.some(a => lower.includes(a));
      if (!hasAnchor) {
        return { valid: false, reason: `criterion[${i}] judged text has no concreteness anchor — too vague` };
      }
    }
  }
  return { valid: true };
}

module.exports = { validateDoneWhen, DEFAULT_VAGUENESS_CONFIG, REQUIRED_FIELDS };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/jtr/_JTR23_/release/home23 && npx mocha engine/tests/unit/done-when-gate.test.js --timeout 10000`

Expected: 8 passing.

- [ ] **Step 5: Commit**

```bash
git add engine/src/goals/done-when-gate.js engine/tests/unit/done-when-gate.test.js
git commit -m "feat(goals): validate doneWhen shape + vagueness filter

Gate validator rejects missing/empty doneWhen, unknown primitive types,
missing required fields, and free-text judged criteria that are shorter
than 40 chars or lack a concreteness anchor (file/output/memory/etc.).
Anchors + min length configurable; defaults match the spec."
```

---

## Task 5: Wire the gate into `addGoal()`

**Files:**
- Modify: `engine/src/goals/intrinsic-goals.js` (around line 320, `addGoal`)
- Modify: `engine/tests/unit/intrinsic-goals-gate.test.js` (new, targeted)

- [ ] **Step 1: Write failing test for the gate**

Create `engine/tests/unit/intrinsic-goals-gate.test.js`:

```js
const { expect } = require('chai');
const { IntrinsicGoalSystem } = require('../../src/goals/intrinsic-goals');

function mkSystem(opts = {}) {
  const logger = {
    warnCalls: [], infoCalls: [],
    debug: () => {}, info(...a) { this.infoCalls.push(a); },
    warn(...a) { this.warnCalls.push(a); }, error: () => {}
  };
  const config = {
    goals: { maxGoals: 100, doneWhen: opts.doneWhenCfg || {} },
    roleSystem: {}
  };
  return new IntrinsicGoalSystem(config, logger);
}

describe('addGoal gate (doneWhen required)', () => {
  it('rejects a goal with no doneWhen', () => {
    const sys = mkSystem();
    const goal = sys.addGoal({ description: 'Design an evidence taxonomy schema' });
    expect(goal).to.equal(null);
    expect(sys.logger.warnCalls.length).to.be.greaterThan(0);
    const msg = sys.logger.warnCalls.map(c => JSON.stringify(c)).join(' ');
    expect(msg).to.match(/doneWhen/i);
  });

  it('accepts a goal with a valid file_exists doneWhen', () => {
    const sys = mkSystem();
    const goal = sys.addGoal({
      description: 'Produce the correlation view sketch',
      doneWhen: {
        version: 1,
        criteria: [{ type: 'file_exists', path: 'correlation-view.md' }]
      }
    });
    expect(goal).to.not.equal(null);
    expect(goal.doneWhen).to.be.an('object');
    expect(goal.progress).to.equal(0);
  });

  it('rejects a vague judged criterion', () => {
    const sys = mkSystem();
    const goal = sys.addGoal({
      description: 'Think deeply about the void',
      doneWhen: { version: 1, criteria: [{ type: 'judged', criterion: 'it is done' }] }
    });
    expect(goal).to.equal(null);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/jtr/_JTR23_/release/home23 && npx mocha engine/tests/unit/intrinsic-goals-gate.test.js --timeout 10000`

Expected: 3 failing (gate not wired; first test probably passes once doneWhen is required, but the others fail).

- [ ] **Step 3: Modify `addGoal()` to run the gate**

Edit `engine/src/goals/intrinsic-goals.js`. Near the top, add after existing requires:

```js
const { validateDoneWhen } = require('./done-when-gate');
```

Inside `addGoal(goalData)`, immediately after the `validateGoalData(goalData)` rejection block (around line 329), insert:

```js
    // doneWhen gate: every goal must declare a concrete termination criterion.
    const dwCfg = this.config?.doneWhen || {};
    const dwResult = validateDoneWhen(goalData?.doneWhen, dwCfg);
    if (!dwResult.valid) {
      this.logger?.warn('⚠️  Rejected goal without valid doneWhen', {
        reason: dwResult.reason,
        description: (goalData?.description || '').slice(0, 80)
      });
      return null;
    }
```

In the `goal = { ... }` literal, attach `doneWhen`:

```js
const goal = {
  id: `goal_${this.nextGoalId++}`,
  description: goalData.description,
  // ... existing fields unchanged ...
  doneWhen: goalData.doneWhen,
  source: {
    origin: (goalData.source && goalData.source.origin) || 'unknown',
    ...(typeof goalData.source === 'object' ? goalData.source : { label: goalData.source })
  },
};
```

(If `goalData.source` was previously a string, preserve under `source.label` for back-compat — the `source` field in existing code is a string. The upsertExternalGoal path should be updated to pass `{ origin: 'external' }`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/jtr/_JTR23_/release/home23 && npx mocha engine/tests/unit/intrinsic-goals-gate.test.js --timeout 10000`

Expected: 3 passing.

Also re-run the existing tests to catch regressions:

Run: `cd /Users/jtr/_JTR23_/release/home23 && npx mocha engine/tests/unit/intrinsic-goals-cluster.test.js --timeout 10000`

If any pre-existing test constructs a goal without `doneWhen`, update it to include a minimal `{ version: 1, criteria: [{ type: 'file_exists', path: 'stub.md' }] }`. Note that test as "updated to comply with gate" in the commit message.

- [ ] **Step 5: Commit**

```bash
git add engine/src/goals/intrinsic-goals.js engine/tests/unit/intrinsic-goals-gate.test.js
git commit -m "feat(goals): gate addGoal on doneWhen presence + validity

Every new goal now requires a validated doneWhen block. Rejection at
the gate is the primary mechanism preventing audit-tumor regrowth; if
the LLM can't articulate a concrete termination criterion, the goal
doesn't exist. Existing tests updated to comply."
```

---

## Task 6: Compute `progress` from `doneWhen`; drop self-report

**Files:**
- Modify: `engine/src/goals/intrinsic-goals.js` (rotation loop; pursuit/progress writers)
- Modify: `engine/tests/unit/intrinsic-goals-gate.test.js` (add progress tests)

- [ ] **Step 1: Write failing tests**

Append to `engine/tests/unit/intrinsic-goals-gate.test.js`:

```js
describe('progress computed from doneWhen', () => {
  const path = require('path');
  const fs = require('fs');
  const os = require('os');

  it('flips to completed when all criteria satisfied', async () => {
    const sys = mkSystem();
    const outputsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'closer-'));
    sys.setDoneWhenEnv({ outputsDir, memory: { nodes: new Map() } });

    const goal = sys.addGoal({
      description: 'Write the correlation view sketch',
      doneWhen: { version: 1, criteria: [{ type: 'file_exists', path: 'correlation.md' }] }
    });
    expect(goal).to.not.equal(null);
    expect(goal.progress).to.equal(0);

    fs.writeFileSync(path.join(outputsDir, 'correlation.md'), '# ok');
    await sys.refreshProgressFromDoneWhen();

    const g = sys.getGoal(goal.id);
    expect(g.progress).to.equal(1);
    expect(g.status).to.equal('completed');
  });

  it('latches completed — verifier does not revert after file deleted', async () => {
    const sys = mkSystem();
    const outputsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'closer-'));
    sys.setDoneWhenEnv({ outputsDir, memory: { nodes: new Map() } });
    const goal = sys.addGoal({
      description: 'Write the correlation view sketch',
      doneWhen: { version: 1, criteria: [{ type: 'file_exists', path: 'x.md' }] }
    });
    const f = path.join(outputsDir, 'x.md');
    fs.writeFileSync(f, 'x');
    await sys.refreshProgressFromDoneWhen();
    expect(sys.getGoal(goal.id).status).to.equal('completed');
    fs.unlinkSync(f);
    await sys.refreshProgressFromDoneWhen();
    expect(sys.getGoal(goal.id).status).to.equal('completed'); // still
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/jtr/_JTR23_/release/home23 && npx mocha engine/tests/unit/intrinsic-goals-gate.test.js --grep "progress computed" --timeout 10000`

Expected: 2 failing (methods not implemented).

- [ ] **Step 3: Implement progress-from-doneWhen**

Edit `engine/src/goals/intrinsic-goals.js`. Near the top:

```js
const { checkDoneWhen } = require('./done-when');
```

Inside the `IntrinsicGoalSystem` class, add methods:

```js
  setDoneWhenEnv(env) {
    this.doneWhenEnv = env;
  }

  getGoal(id) {
    return this.goals.get(id);
  }

  async refreshProgressFromDoneWhen() {
    if (!this.doneWhenEnv) {
      this.logger?.debug?.('[closer] no doneWhen env, skipping refresh');
      return { refreshed: 0 };
    }
    let refreshed = 0;
    for (const goal of this.goals.values()) {
      if (goal.status === 'completed' || goal.status === 'archived') continue;
      if (!goal.doneWhen) continue;
      const r = await checkDoneWhen(goal, this.doneWhenEnv);
      const prev = goal.progress;
      goal.progress = r.total > 0 ? r.satisfied / r.total : 0;
      if (goal.progress === 1 && goal.status !== 'completed') {
        this.completeGoal(goal.id, 'doneWhen satisfied');
      }
      refreshed++;
      if (goal.progress !== prev) {
        this.logger?.info?.('[closer] goal progress updated', {
          id: goal.id, prev, next: goal.progress, satisfied: r.satisfied, total: r.total
        });
      }
    }
    return { refreshed };
  }
```

Next — remove or gate any code in this file that self-writes `goal.progress = ...` outside of `refreshProgressFromDoneWhen()` and the rotation's auto-archive/auto-complete lines. Grep within the file for `\.progress\s*=` and inspect each site. Leave the rotation-loop site that reads progress (around line 1513) alone — the rotation still gets to decide archiving — but don't let any agent-facing method mutate `progress` directly. If any such writer exists, replace with a no-op + a deprecation log:

```js
// Deprecated: progress is now computed from doneWhen by refreshProgressFromDoneWhen().
// setGoalProgress(id, val) { /* no-op */ }
```

Hook into the rotation: update the rotation entry point (the function that calls the maxPursuits / stale / etc. checks — `performGoalRotation` or similar, grep for `satisfactionThreshold`) so that at its top it awaits `refreshProgressFromDoneWhen()`. If that function is synchronous, convert to async and update its callers.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/jtr/_JTR23_/release/home23 && npx mocha engine/tests/unit/intrinsic-goals-gate.test.js --timeout 10000`

Expected: 5 passing (3 gate + 2 progress).

- [ ] **Step 5: Commit**

```bash
git add engine/src/goals/intrinsic-goals.js engine/tests/unit/intrinsic-goals-gate.test.js
git commit -m "feat(goals): compute progress from doneWhen; latch on completion

goal.progress becomes satisfiedCount/totalCriteria, computed by
refreshProgressFromDoneWhen() each rotation. Once status=completed,
verifier does not revert. Self-report writes to progress are removed."
```

---

## Task 7: Migration planner (dry-run only)

**Files:**
- Create: `engine/src/goals/migrations/2026-04-17-done-when.js`
- Create: `engine/tests/unit/done-when-migration.test.js`

- [ ] **Step 1: Write failing tests for the planner**

Create `engine/tests/unit/done-when-migration.test.js`:

```js
const { expect } = require('chai');
const { planMigration, AUDIT_TUMOR_PATTERNS } =
  require('../../src/goals/migrations/2026-04-17-done-when');

function mkGoals(list) {
  const goals = new Map();
  list.forEach((g, i) => goals.set(`goal_${i + 1}`, { id: `goal_${i + 1}`, status: 'active', ...g }));
  return goals;
}

describe('migration planner', () => {
  it('marks audit-tumor goals for archive', () => {
    const goals = mkGoals([
      { description: 'Design a verified output evidence schema with five columns' },
      { description: 'Draft a canonical taxonomy schema for agent outputs' }
    ]);
    const plan = planMigration(goals);
    expect(plan.archive).to.have.length(2);
    expect(plan.archive[0].reason).to.equal('audit-tumor-purge-2026-04-17');
  });

  it('marks philosophical-koan goals for archive with no-concrete reason', () => {
    const goals = mkGoals([
      { description: 'What strange loop have you walked today?' },
      { description: 'Phenomenology of liminal pauses in thought' }
    ]);
    const plan = planMigration(goals);
    expect(plan.archive).to.have.length(2);
    expect(plan.archive[0].reason).to.equal('no-concrete-done-when');
  });

  it('preserves goal 6 (CRDT) with a retrofit plan', () => {
    const goals = mkGoals([
      { description: 'Cross-Layer CRDT Unification of protocol predicates, version history, and belief revision' }
    ]);
    const plan = planMigration(goals);
    expect(plan.retrofit).to.have.length(1);
    expect(plan.retrofit[0].doneWhen.criteria).to.have.length.greaterThan(0);
  });

  it('falls through to llm-retrofit for uncategorized goals', () => {
    const goals = mkGoals([
      { description: 'Study ion channel cognitive capacity across species' }
    ]);
    const plan = planMigration(goals);
    expect(plan.llmRetrofit).to.have.length(1);
  });

  it('skips completed and archived goals', () => {
    const goals = mkGoals([
      { description: 'Design a canonical taxonomy schema', status: 'completed' },
      { description: 'What strange loop', status: 'archived' }
    ]);
    const plan = planMigration(goals);
    expect(plan.archive).to.have.length(0);
    expect(plan.retrofit).to.have.length(0);
    expect(plan.llmRetrofit).to.have.length(0);
    expect(plan.skipped).to.have.length(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/jtr/_JTR23_/release/home23 && mkdir -p engine/src/goals/migrations && npx mocha engine/tests/unit/done-when-migration.test.js --timeout 10000`

Expected: 5 failing (module missing).

- [ ] **Step 3: Implement the planner**

Create `engine/src/goals/migrations/2026-04-17-done-when.js`:

```js
/**
 * Migration: attach doneWhen to every goal, purge audit-tumor.
 * Schema version 0 → 1.
 *
 * planMigration(goalsMap) — returns a plan object without applying.
 * applyMigration(plan, goalsSystem) — performs the plan. See Task 8.
 */

const AUDIT_TUMOR_PATTERNS = [
  /verified output evidence schema/i,
  /state snapshot capture at handoff/i,
  /modify audit script to enumerate/i,
  /four.column evidence table/i,
  /map agent internal state variables/i,
  /data integrity feedback loop/i,
  /checkpoint receipt schema/i,
  /canonical taxonomy schema/i,
  /enforcement boundary for incomplete cycles/i,
  /audit schema with four parallel/i,
  /audit conclusions treating zero as negative evidence/i,
];

const KOAN_PATTERNS = [
  /what strange loop/i,
  /liminal pauses/i,
  /metaphysics of named days/i,
  /spoon that remembers/i,
  /artifacts.*alternative identities/i,
  /human temporal perception/i,
];

const CRDT_PATTERN = /cross.layer crdt unification|crdt.*belief revision|crdt unification/i;

function matchAny(desc, patterns) {
  return patterns.some(re => re.test(desc || ''));
}

function crdtDoneWhen() {
  return {
    version: 1,
    criteria: [
      { type: 'file_exists', path: 'crdt-unification-sketch.md' },
      {
        type: 'judged',
        criterion: 'The file outputs/crdt-unification-sketch.md contains sections on protocol predicates, version history, and belief revision, with at least one worked example linking them.',
        judgeModel: 'gpt-5-mini',
        judgedAt: null, judgedVerdict: null
      }
    ]
  };
}

function planMigration(goalsMap) {
  const plan = { archive: [], retrofit: [], llmRetrofit: [], skipped: [] };
  for (const goal of goalsMap.values()) {
    if (goal.status && goal.status !== 'active') {
      plan.skipped.push({ id: goal.id, reason: `status=${goal.status}` });
      continue;
    }
    const desc = goal.description || '';
    if (matchAny(desc, AUDIT_TUMOR_PATTERNS)) {
      plan.archive.push({ id: goal.id, reason: 'audit-tumor-purge-2026-04-17', description: desc });
      continue;
    }
    if (matchAny(desc, KOAN_PATTERNS)) {
      plan.archive.push({ id: goal.id, reason: 'no-concrete-done-when', description: desc });
      continue;
    }
    if (CRDT_PATTERN.test(desc)) {
      plan.retrofit.push({ id: goal.id, doneWhen: crdtDoneWhen(), description: desc });
      continue;
    }
    plan.llmRetrofit.push({ id: goal.id, description: desc });
  }
  return plan;
}

module.exports = {
  planMigration,
  AUDIT_TUMOR_PATTERNS,
  KOAN_PATTERNS,
  CRDT_PATTERN,
  crdtDoneWhen,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/jtr/_JTR23_/release/home23 && npx mocha engine/tests/unit/done-when-migration.test.js --timeout 10000`

Expected: 5 passing.

- [ ] **Step 5: Commit**

```bash
git add engine/src/goals/migrations/2026-04-17-done-when.js engine/tests/unit/done-when-migration.test.js
git commit -m "feat(goals): migration planner for doneWhen schema v0→v1

Matches goals by description against audit-tumor + philosophical-koan
pattern sets. Produces an archive/retrofit/llmRetrofit plan without
applying. Apply-mode lands in the next commit."
```

---

## Task 8: Migration applier + receipts

**Files:**
- Modify: `engine/src/goals/migrations/2026-04-17-done-when.js`
- Modify: `engine/tests/unit/done-when-migration.test.js`

- [ ] **Step 1: Write failing test for applier**

Append to `engine/tests/unit/done-when-migration.test.js`:

```js
describe('migration applier', () => {
  const { applyMigration } = require('../../src/goals/migrations/2026-04-17-done-when');

  function fakeSystem() {
    const archived = [];
    const retrofitted = [];
    return {
      archiveGoal(id, reason) { archived.push({ id, reason }); return true; },
      _applyRetrofit(id, dw) { retrofitted.push({ id, dw }); return true; },
      _archived: archived,
      _retrofitted: retrofitted,
    };
  }

  it('applies archive and retrofit actions; skips llmRetrofit when no llmClient', async () => {
    const sys = fakeSystem();
    const plan = {
      archive: [{ id: 'g1', reason: 'audit-tumor-purge-2026-04-17' }],
      retrofit: [{ id: 'g6', doneWhen: { version: 1, criteria: [{ type: 'file_exists', path: 'x.md' }] } }],
      llmRetrofit: [{ id: 'g99', description: 'pending' }],
      skipped: []
    };
    const receipt = await applyMigration(plan, sys, {});
    expect(sys._archived).to.have.length(1);
    expect(sys._retrofitted).to.have.length(1);
    expect(receipt.applied.archive).to.equal(1);
    expect(receipt.applied.retrofit).to.equal(1);
    expect(receipt.applied.llmRetrofit).to.equal(0);
    expect(receipt.deferred.llmRetrofit).to.equal(1);
  });

  it('calls llmClient per llmRetrofit goal and archives when LLM declines', async () => {
    const sys = fakeSystem();
    const llmClient = {
      async chat({ messages }) {
        const userText = messages.find(m => m.role === 'user').content;
        if (userText.includes('pending')) return { content: JSON.stringify({ decline: true, reason: 'no concrete termination' }) };
        return { content: JSON.stringify({ doneWhen: { version: 1, criteria: [{ type: 'file_exists', path: 'x.md' }] } }) };
      }
    };
    const plan = {
      archive: [], retrofit: [],
      llmRetrofit: [
        { id: 'g99', description: 'pending forever' },
        { id: 'g100', description: 'ship the sketch' }
      ],
      skipped: []
    };
    const receipt = await applyMigration(plan, sys, { llmClient });
    expect(sys._archived.find(a => a.id === 'g99')).to.exist;
    expect(sys._retrofitted.find(r => r.id === 'g100')).to.exist;
    expect(receipt.applied.llmRetrofit).to.equal(1);
    expect(receipt.applied.archive).to.equal(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/jtr/_JTR23_/release/home23 && npx mocha engine/tests/unit/done-when-migration.test.js --grep applier --timeout 10000`

Expected: 2 failing.

- [ ] **Step 3: Implement applier + `_applyRetrofit` in intrinsic-goals**

Append to `engine/src/goals/migrations/2026-04-17-done-when.js`:

```js
const { validateDoneWhen } = require('../done-when-gate');

async function askLlmForDoneWhen(description, llmClient) {
  const prompt = [
    { role: 'system', content:
      'You produce a concrete, verifiable termination criterion for an AI-system research goal. Output ONLY JSON — either {"doneWhen": {"version": 1, "criteria": [ ... ]}} or {"decline": true, "reason": "<one sentence>"}. Allowed criterion types: file_exists, file_created_after, memory_node_tagged, memory_node_matches, output_count_since, judged. Prefer file_exists in outputs/. If the goal is too vague to have a concrete output, decline.' },
    { role: 'user', content: `Goal: ${description}\n\nRespond with JSON only.` }
  ];
  const resp = await llmClient.chat({
    model: 'gpt-5-mini', messages: prompt, max_completion_tokens: 400, temperature: 0.2
  });
  try {
    const parsed = JSON.parse((resp.content || '').trim());
    return parsed;
  } catch (err) {
    return { decline: true, reason: `parse error: ${err.message}` };
  }
}

async function applyMigration(plan, goalsSystem, opts = {}) {
  const receipt = {
    startedAt: new Date().toISOString(),
    applied: { archive: 0, retrofit: 0, llmRetrofit: 0 },
    deferred: { llmRetrofit: 0 },
    actions: []
  };

  for (const a of plan.archive) {
    goalsSystem.archiveGoal(a.id, a.reason);
    receipt.applied.archive++;
    receipt.actions.push({ action: 'archive', ...a });
  }

  for (const r of plan.retrofit) {
    goalsSystem._applyRetrofit(r.id, r.doneWhen);
    receipt.applied.retrofit++;
    receipt.actions.push({ action: 'retrofit', id: r.id });
  }

  for (const item of plan.llmRetrofit) {
    if (!opts.llmClient) {
      receipt.deferred.llmRetrofit++;
      receipt.actions.push({ action: 'defer', id: item.id, reason: 'no llmClient' });
      continue;
    }
    const reply = await askLlmForDoneWhen(item.description, opts.llmClient);
    if (reply?.decline || !reply?.doneWhen) {
      goalsSystem.archiveGoal(item.id, `no-concrete-done-when (llm-decline: ${reply?.reason || 'unknown'})`);
      receipt.applied.archive++;
      receipt.actions.push({ action: 'archive-llm-decline', id: item.id, reason: reply?.reason });
      continue;
    }
    const v = validateDoneWhen(reply.doneWhen);
    if (!v.valid) {
      goalsSystem.archiveGoal(item.id, `no-concrete-done-when (llm-invalid: ${v.reason})`);
      receipt.applied.archive++;
      receipt.actions.push({ action: 'archive-llm-invalid', id: item.id, reason: v.reason });
      continue;
    }
    goalsSystem._applyRetrofit(item.id, reply.doneWhen);
    receipt.applied.llmRetrofit++;
    receipt.actions.push({ action: 'llm-retrofit', id: item.id });
  }

  receipt.finishedAt = new Date().toISOString();
  return receipt;
}

module.exports.applyMigration = applyMigration;
module.exports.askLlmForDoneWhen = askLlmForDoneWhen;
```

Add `_applyRetrofit` to `IntrinsicGoalSystem` in `engine/src/goals/intrinsic-goals.js`:

```js
  _applyRetrofit(goalId, doneWhen) {
    const g = this.goals.get(goalId);
    if (!g) return false;
    g.doneWhen = doneWhen;
    g.progress = 0;
    this.logger?.info?.('[migration] retrofit doneWhen', { id: goalId });
    return true;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/jtr/_JTR23_/release/home23 && npx mocha engine/tests/unit/done-when-migration.test.js --timeout 10000`

Expected: 7 passing.

- [ ] **Step 5: Commit**

```bash
git add engine/src/goals/migrations/2026-04-17-done-when.js engine/src/goals/intrinsic-goals.js engine/tests/unit/done-when-migration.test.js
git commit -m "feat(goals): migration applier — archive, retrofit, llm-retrofit, receipts

Applies a plan produced by planMigration(). LLM-retrofit pathway asks
gpt-5-mini to generate a concrete doneWhen or decline; declined goals
get archived with no-concrete-done-when. Returns a receipt enumerating
every action."
```

---

## Task 9: Startup migration hook

**Files:**
- Modify: `engine/src/core/orchestrator.js` (after `loadState()` completes in `initialize()`)

- [ ] **Step 1: Read the spec for the startup flow**

Re-read these portions of `docs/superpowers/specs/2026-04-17-jerry-closer-primitive-design.md`:
- "One-shot migration" section
- "Rollout" section

Key constraints:
- Dry-run is default. Apply only when `HOME23_APPLY_MIGRATION=1`.
- Writes dry-run JSON to `brain/migrations/2026-04-17-done-when-dryrun.json`.
- Writes apply receipt to `brain/migrations/2026-04-17-done-when-applied.json`.
- Triggers a coherent brain backup before apply (using `maybeBackup` with `force: true`).
- Bumps `goals.schemaVersion` to 1 only after apply succeeds. Idempotent on restart.

- [ ] **Step 2: Add migration hook to orchestrator**

Edit `engine/src/core/orchestrator.js`. Find the `initialize()` method. After the `await this.loadState()` block (which is now the only unconditional loadState call per the 2026-04-17 checkpoint-recovery fix), insert this block (before telemetry initialization):

```js
    // ── doneWhen migration (schema v0 → v1) ──
    try {
      const { planMigration, applyMigration } = require('../goals/migrations/2026-04-17-done-when');
      const fs = require('fs');
      const path = require('path');
      const migDir = path.join(this.logsDir, 'migrations');
      fs.mkdirSync(migDir, { recursive: true });
      const currentVer = this.goals.getSchemaVersion?.() ?? 0;
      if (currentVer < 1) {
        const plan = planMigration(this.goals.goals);
        const dryPath = path.join(migDir, '2026-04-17-done-when-dryrun.json');
        fs.writeFileSync(dryPath, JSON.stringify(plan, null, 2));
        this.logger?.info?.('[closer-migration] dry-run written', {
          path: dryPath,
          archive: plan.archive.length,
          retrofit: plan.retrofit.length,
          llmRetrofit: plan.llmRetrofit.length,
          skipped: plan.skipped.length,
        });
        if (process.env.HOME23_APPLY_MIGRATION === '1') {
          // Coherent brain backup before applying.
          try {
            const { maybeBackup } = require('./brain-backups');
            await maybeBackup(this.logsDir, {
              intervalHours: 0, retention: 10, logger: this.logger, force: true,
            });
          } catch (err) {
            this.logger?.warn?.('[closer-migration] backup failed, continuing', { error: err.message });
          }
          const receipt = await applyMigration(plan, this.goals, { llmClient: this.memorySummarizer || this.gpt5 });
          const recPath = path.join(migDir, '2026-04-17-done-when-applied.json');
          fs.writeFileSync(recPath, JSON.stringify(receipt, null, 2));
          this.goals.setSchemaVersion?.(1);
          this.logger?.info?.('[closer-migration] applied', {
            path: recPath,
            applied: receipt.applied,
            deferred: receipt.deferred,
          });
        } else {
          this.logger?.info?.('[closer-migration] dry-run only; set HOME23_APPLY_MIGRATION=1 to apply');
        }
      }
    } catch (err) {
      this.logger?.error?.('[closer-migration] failed', { error: err.message, stack: err.stack });
      // Non-fatal: continue booting.
    }
```

Add `getSchemaVersion` / `setSchemaVersion` to `IntrinsicGoalSystem`:

```js
  getSchemaVersion() { return this.schemaVersion || 0; }
  setSchemaVersion(v) { this.schemaVersion = v; }
```

And include `schemaVersion` in the `export()`/`import()` pair so it persists via state.json.gz. (Grep for `export()` / `import()` in `intrinsic-goals.js` — they already exist around the goal-completed-goals serialization. Add `schemaVersion: this.schemaVersion || 0` to the exported object and `this.schemaVersion = state.schemaVersion || 0` to import.)

- [ ] **Step 3: Also wire `setDoneWhenEnv`**

Right after the migration block above, call:

```js
    this.goals.setDoneWhenEnv({
      memory: this.memory,
      logger: this.logger,
      outputsDir: path.join(this.logsDir, 'outputs'),
      brainDir: this.logsDir,
      llmClient: this.gpt5,  // same unified client used elsewhere
    });
```

(The exact property names — `this.memory`, `this.gpt5` — should match existing properties on `this`. Grep orchestrator.js if unsure.)

- [ ] **Step 4: Manual verification**

Run: `cd /Users/jtr/_JTR23_/release/home23 && node -e "require('./engine/src/goals/migrations/2026-04-17-done-when')"`

Expected: loads without error.

- [ ] **Step 5: Commit**

```bash
git add engine/src/core/orchestrator.js engine/src/goals/intrinsic-goals.js
git commit -m "feat(engine): run doneWhen migration at startup; wire verifier env

Dry-run is default (writes brain/migrations/*-dryrun.json). Set
HOME23_APPLY_MIGRATION=1 to apply. Pre-apply brain backup reuses the
existing maybeBackup helper with force:true. Idempotent by
goals.schemaVersion which persists via export/import."
```

---

## Task 10: Update LLM prompts (goal-curator + goal-capture) to require `doneWhen`

**Files:**
- Modify: `engine/src/goals/goal-curator.js`
- Modify: `engine/src/goals/goal-capture.js`
- Modify: `configs/base-engine.yaml`

- [ ] **Step 1: Locate the LLM prompts that produce goals**

Run:

```bash
grep -nE "description.*uncertainty|JSON.*goal|produce a goal|new goal.*JSON" engine/src/goals/goal-curator.js engine/src/goals/goal-capture.js | head
```

Both files use LLM prompts to ask the model to emit goal objects. Find the prompt template (likely a template literal or a config field in base-engine.yaml).

- [ ] **Step 2: Update the goal-curator prompt template**

For each prompt that instructs the LLM to output a goal JSON object, add to the instructions:

> You MUST include a `doneWhen` object with a `version: 1` and a non-empty `criteria` array. Allowed criterion types: `file_exists` (with `path`), `file_created_after` (with `path` + `since`), `memory_node_tagged` (with `tag`), `memory_node_matches` (with `regex`), `output_count_since` (with `dir`, `since`, `gte`), `judged` (with `criterion` — a concrete verifiable sentence that includes one of: file, output, memory, node, count, exists, at least, contains, written, published, produced, delivered, ships, emits). If you cannot express a concrete termination, do NOT emit the goal.

Add this language verbatim into both `goal-curator.js` and `goal-capture.js` wherever goal JSON schemas are defined or prompts are assembled.

- [ ] **Step 3: Update any JSON schema definitions**

Some paths use JSON Schema / structured-output mode. For those, add:

```js
doneWhen: {
  type: 'object',
  required: ['version', 'criteria'],
  properties: {
    version: { type: 'integer', enum: [1] },
    criteria: {
      type: 'array', minItems: 1,
      items: {
        type: 'object',
        required: ['type'],
        properties: {
          type: { enum: ['file_exists', 'file_created_after', 'memory_node_tagged',
                         'memory_node_matches', 'output_count_since', 'judged'] },
          path: { type: 'string' }, tag: { type: 'string' }, regex: { type: 'string' },
          dir: { type: 'string' }, since: {}, gte: { type: 'integer' },
          criterion: { type: 'string', minLength: 40 },
          judgeModel: { type: 'string' }
        }
      }
    }
  }
}
```

Merge this into whichever goal-output schema exists in `engine/src/schemas/structured-outputs.js` (if present) and the corresponding `required` arrays. If no schema exists there, add `doneWhen` as a required field in the goal-producing prompt alone.

- [ ] **Step 4: Add config block to base-engine.yaml**

Edit `configs/base-engine.yaml`. Inside the `goals:` section, add:

```yaml
  doneWhen:
    minCriterionLength: 40
    judgeModel: gpt-5-mini
    judgeTTLMs: 86400000
    vaguenessAnchors:
      - file
      - output
      - memory
      - node
      - count
      - exists
      - at least
      - contains
      - written
      - published
      - produced
      - delivered
      - ships
      - emits
```

These are the same defaults as `DEFAULT_VAGUENESS_CONFIG` — this block is for explicit, operator-visible configuration. `IntrinsicGoalSystem` reads these via `this.config.doneWhen` in the gate call (Task 5).

- [ ] **Step 5: Commit**

```bash
git add engine/src/goals/goal-curator.js engine/src/goals/goal-capture.js engine/src/schemas/structured-outputs.js configs/base-engine.yaml
git commit -m "feat(goals): LLM goal-producing prompts must emit doneWhen

goal-curator and goal-capture prompts now require a valid doneWhen
block in every goal JSON. Structured-output schemas updated to make
doneWhen a required field. base-engine.yaml carries the operator-
visible config (min length, anchors, judge model + TTL)."
```

---

## Task 11: Observability — per-cycle closer-status log line

**Files:**
- Modify: `engine/src/core/orchestrator.js` (cognitive cycle — where per-cycle telemetry is logged)
- Modify: `engine/src/goals/intrinsic-goals.js` (add `getCloserStatus()` helper)

- [ ] **Step 1: Add `getCloserStatus()` helper**

In `engine/src/goals/intrinsic-goals.js`, append:

```js
  getCloserStatus() {
    const now = Date.now();
    const JUDGE_TTL_MS = 24 * 60 * 60 * 1000;
    let activeTotal = 0, withDoneWhen = 0, dueForJudgeRecheck = 0, stalled = 0;
    for (const g of this.goals.values()) {
      if (g.status !== 'active' && g.status !== undefined) continue;
      activeTotal++;
      if (g.doneWhen?.criteria?.length) withDoneWhen++;
      for (const c of (g.doneWhen?.criteria || [])) {
        if (c.type === 'judged' && (!c.judgedAt || (now - Number(c.judgedAt) > JUDGE_TTL_MS))) {
          dueForJudgeRecheck++;
          break;
        }
      }
      if (g.pursuitCount >= 3 && (g.progress || 0) < 0.01) stalled++;
    }
    return {
      activeTotal, withDoneWhen, dueForJudgeRecheck, stalled,
      rejectedAtGateLast24h: this._rejectedAtGateCount24h || 0,
      completedViaDoneWhenLast24h: this._completedViaDoneWhenCount24h || 0,
      archivedViaMigration: this._archivedViaMigrationCount || 0,
    };
  }
```

Also increment the counters in the appropriate sites:
- In `addGoal()` gate rejection branch: `this._rejectedAtGateCount24h = (this._rejectedAtGateCount24h || 0) + 1;`
- In `completeGoal()` when called with the reason `'doneWhen satisfied'`: increment `_completedViaDoneWhenCount24h`.
- In `archiveGoal()` when the reason string begins with `audit-tumor-purge-` or `no-concrete-done-when`: increment `_archivedViaMigrationCount`.

A simple daily rollover: at the top of `getCloserStatus()`, check `this._counterDay !== new Date().toISOString().slice(0, 10)` — if so, reset the 24h counters.

- [ ] **Step 2: Log the status once per cycle**

In `engine/src/core/orchestrator.js`, find the cycle-completion log line (`✓ Cycle completed in Nms`). Immediately after it, add:

```js
      try {
        const closer = this.goals.getCloserStatus?.();
        if (closer) {
          this.logger?.info?.('[closer-status]', closer);
        }
      } catch (err) {
        this.logger?.warn?.('[closer-status] failed', { error: err.message });
      }
```

- [ ] **Step 3: Smoke test**

Start jerry's engine locally (`pm2 restart home23-jerry`) and tail the log for `[closer-status]`:

```bash
grep "closer-status" instances/jerry/logs/engine-out.log | tail -5
```

Expected: one entry per cycle with the counter object.

- [ ] **Step 4: Commit**

```bash
git add engine/src/goals/intrinsic-goals.js engine/src/core/orchestrator.js
git commit -m "feat(goals): emit per-cycle closer-status metrics

Logs activeTotal / withDoneWhen / dueForJudgeRecheck / stalled /
rejectedAtGateLast24h / completedViaDoneWhenLast24h / archivedViaMigration
at INFO after every cycle. This is the primary signal for watching the
closer actually close during the first 24h after migration."
```

---

## Task 12: End-to-end dry-run verification against jerry's brain

**Files:** no code — verification only

- [ ] **Step 1: Ensure uncommitted orchestrator fix from 2026-04-17 is preserved**

The orchestrator.js patch that always calls `loadState()` after crash-recovery is still uncommitted in the working tree. Confirm it's present:

```bash
cd /Users/jtr/_JTR23_/release/home23 && git diff engine/src/core/orchestrator.js | head -40
```

Expected: unified diff showing the "always call loadState" block. If not present, STOP and re-apply that patch first. It is not part of this PR but we need its behavior during verification.

- [ ] **Step 2: Run the full unit-test suite**

Run: `cd /Users/jtr/_JTR23_/release/home23/engine && npm run test:unit`

Expected: all pass, including the 30+ new tests from Tasks 1–10.

- [ ] **Step 3: Dry-run against jerry**

Back up jerry's brain files defensively first:

```bash
BACKUP=/tmp/jerry-closer-preflight-$(date +%Y%m%d-%H%M%S) && mkdir -p "$BACKUP" && \
  cp /Users/jtr/_JTR23_/release/home23/instances/jerry/brain/memory-nodes.jsonl.gz "$BACKUP"/ && \
  cp /Users/jtr/_JTR23_/release/home23/instances/jerry/brain/memory-edges.jsonl.gz "$BACKUP"/ && \
  cp /Users/jtr/_JTR23_/release/home23/instances/jerry/brain/state.json.gz "$BACKUP"/ && \
  cp /Users/jtr/_JTR23_/release/home23/instances/jerry/brain/brain-snapshot.json "$BACKUP"/ && \
  echo "Backed up to $BACKUP"
```

Restart jerry WITHOUT the apply flag:

```bash
pm2 restart home23-jerry
```

Wait 20 seconds. Read the dry-run plan:

```bash
cat /Users/jtr/_JTR23_/release/home23/instances/jerry/brain/migrations/2026-04-17-done-when-dryrun.json
```

Expected: 11 entries in `archive` with `reason: audit-tumor-purge-2026-04-17`. Entries in `retrofit` (goal 6 — CRDT). Zero or more in `llmRetrofit`. Zero or more in `skipped`.

- [ ] **Step 4: Jtr reviews the plan**

Present the plan JSON to jtr for review. Checkpoint: wait for explicit approval before applying. If jtr requests changes to pattern lists, edit `AUDIT_TUMOR_PATTERNS` / `KOAN_PATTERNS` / `CRDT_PATTERN` in the migration module, re-run unit tests, restart jerry, re-review dry-run.

- [ ] **Step 5: Apply**

```bash
HOME23_APPLY_MIGRATION=1 pm2 restart home23-jerry --update-env
```

Wait 30s. Verify:

```bash
cat /Users/jtr/_JTR23_/release/home23/instances/jerry/brain/migrations/2026-04-17-done-when-applied.json
grep "\[closer-status\]" /Users/jtr/_JTR23_/release/home23/instances/jerry/logs/engine-out.log | tail -3
```

Expected:
- Apply receipt present with `applied.archive >= 11`, `applied.retrofit >= 1`, `applied.llmRetrofit + deferred.llmRetrofit` accounting for the remaining goals.
- `[closer-status]` log line shows `withDoneWhen === activeTotal` — no active goal lacks a `doneWhen`.

- [ ] **Step 6: Observe 24h**

No code step. Jtr watches the `[closer-status]` log line and the dashboard (if hooked in a follow-up PR). Key signals:
- `rejectedAtGateLast24h` > 0 — new audit-style goals are being attempted and rejected.
- `completedViaDoneWhenLast24h` > 0 — at least one goal closes naturally.
- No regression in thought/cycle cadence.

If audit-tumor regrows through a non-pattern-matched concept (e.g. "evidence pipeline"), add a new pattern to `AUDIT_TUMOR_PATTERNS` in a follow-up PR with a fresh migration (`2026-04-18-done-when.js`).

- [ ] **Step 7: Final commit (tag)**

Once observation window passes and behavior is healthy:

```bash
git tag v0.3.0-closer-primitive
```

No code change. Tag marks the baseline before subsequent closer work (critic repair, dedup-before-spawn, escalation rethink) lands.

---

## Self-review — spec coverage

| Spec requirement | Implemented in |
|-----------------|----------------|
| `doneWhen` schema with version + criteria | Task 1 (tests), Task 5 (stored on goal) |
| 6 primitive types (file_exists, file_created_after, memory_node_tagged, memory_node_matches, output_count_since, judged) | Tasks 1–2 |
| Judge cached per-criterion, 24h TTL, `gpt-5-mini` | Task 2 |
| `checkDoneWhen` aggregate returns satisfied/total/details | Task 3 |
| Gate at `addGoal` rejects missing/empty/vague | Tasks 4 + 5 |
| `progress` = computed (no self-report) | Task 6 |
| Latching on completed | Task 6 |
| Migration planner (dry-run) + applier | Tasks 7 + 8 |
| One-shot at startup, guarded by schemaVersion + env var | Task 9 |
| Coherent brain backup before apply | Task 9 (via `maybeBackup` with `force: true`) |
| `source.origin` recorded on goals | Task 5 |
| LLM prompts require `doneWhen` | Task 10 |
| Config block in base-engine.yaml | Task 10 |
| Observability (engine log line) | Task 11 |
| End-to-end verification against jerry | Task 12 |
| Audit-tumor pattern list (11 descriptions) | Task 7 |
| Retrofit for goal 6 (CRDT) | Task 7 |
| Koan archive for philosophical goals | Task 7 |
| LLM-retrofit fallback for uncategorized | Task 8 |

All spec requirements covered. No placeholders in any step; every code-bearing step has the actual code. Type/method names consistent across tasks (`checkCriterion`, `checkDoneWhen`, `validateDoneWhen`, `planMigration`, `applyMigration`, `_applyRetrofit`, `refreshProgressFromDoneWhen`, `getCloserStatus`, `setDoneWhenEnv`, `getSchemaVersion`/`setSchemaVersion`).
