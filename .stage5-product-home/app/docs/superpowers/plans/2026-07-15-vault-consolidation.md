# Vault Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate jtr's 51,831 documents (567 MB) from five scattered locations into one vault, with content-hash dedup and full provenance, so a later rebuild can produce a brain where every node traces to a file.

**Architecture:** A copy-only consolidator walks source roots, hashes every document, routes it to a type folder derived mechanically from its origin path, and records origin + hash + type in a `vault-manifest.json`. Identical content (same SHA256) is stored once with multiple recorded origins. Collections (JSON arrays of items) are first exploded by an atomizer into one markdown file per item before consolidation. Nothing is moved or deleted; originals stay in place for a later, separate archive step.

**Tech Stack:** Node.js CommonJS (`.cjs`, matching `scripts/audit-brain-provenance.cjs`), `node:test` + `node:assert/strict`, `node:crypto` for SHA256, `node:fs`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-15-brain-vault-decontamination-design.md` (§4.0, §4.1d, §4.1e)

---

## Global Constraints

- **Copy only. Never move, never delete.** Originals remain untouched. Archiving to an external volume is a separate, later, explicit action (jtr, 2026-07-15).
- **Dedup is content-hash exact match only.** Identical SHA256 → store once, record every origin. Never near-duplicate matching — a lightly-edited variant is a different document.
- **Every vault file records its origin.** Provenance is the point; a file without a recorded origin is a bug.
- **Type folders are derived mechanically from the origin path.** No human filing, ever. If a rule can't classify a file, it goes to `notes/` — never to a "decide later" bucket.
- **This plan touches no live system.** No engine changes, no PM2, no brain writes. The engine keeps running throughout.
- **The atomizer must never compile.** It emits files; the feeder ingests them later. If an atomizer can't parse a collection, it leaves the original alone and reports it — per spec §4.1c-1, a compiler handed thin input fabricates.
- TDD for every behaviour change. Run the focused test before broader verification.

## Measured Baseline (2026-07-15)

```
                    docs      size     currently ingested
cosmo-home        28,962   335.1 MB      1,531  ( 3%)
cosmo-home_2.3     7,808   118.1 MB        364  ( 2%)
.openclaw         12,061    81.9 MB          0  ( 0%)
workspace/jtr      2,204    20.7 MB          0  ( 0%)   ← watched, never ingested
life                 796    11.4 MB        794  (99.7%)
────────────────────────────────────────────────
TOTAL             51,831   567.2 MB      2,689  ( 5%)
```

Counting `.md`/`.txt`/`.pdf`. **The consolidator also takes `.bib` (967 bibliography files), so its
walker sees 52,798 documents.** Both numbers are correct and count different sets — Task 9 asserts
the 52,798 figure.

Disk free: 23 GB. Payload: 0.55 GB. Headroom is not a concern.

**For context on why this project exists:** jtr's entire written record is **567 MB / 51,831
documents**, of which the brain has read **5%**. The brain itself is 1.2 GB and 143,479 nodes —
**more than twice the size of everything jtr has ever written** — and is ~71% machine narrative and
~35% npm package metadata (spec §1.1, §1.14, and the §7 tracing results).

## File Structure

- `scripts/vault/vault-paths.cjs` — vault root resolution + type routing rules. One responsibility: given an origin path, return a type folder.
- `scripts/vault/vault-manifest.cjs` — read/write/merge `vault-manifest.json`. One responsibility: provenance records.
- `scripts/vault/hash-index.cjs` — SHA256 content index for dedup. One responsibility: "have I seen this content?"
- `scripts/vault/atomize-claude-archive.cjs` — Claude `conversations.json` → N markdown files. Standalone, runnable, testable.
- `scripts/vault/consolidate.cjs` — the walker/copier CLI that composes the above.
- `tests/scripts/vault-paths.test.cjs`, `vault-manifest.test.cjs`, `vault-hash-index.test.cjs`, `vault-atomize-claude.test.cjs`, `vault-consolidate.test.cjs`

Split by responsibility, each file small enough to hold in context. `consolidate.cjs` composes; it contains no routing or hashing logic of its own.

---

### Task 1: Type routing rules

**Files:**
- Create: `scripts/vault/vault-paths.cjs`
- Test: `tests/scripts/vault-paths.test.cjs`

- [ ] **Step 1: Write the failing test**

```javascript
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyOrigin, TYPES } = require('../../scripts/vault/vault-paths.cjs');

// [input, expected] -- the whole routing contract on one screen. This doubles as
// the precedence documentation for the next person.
const FIXTURES = [
  // positive: every type reachable from a real path
  ['/Users/jtr/_JTR23_/cosmo-home/runs/jtr/inputs/voice/voice-2026-03-04T03-24-06-127Z.md', 'voice'],
  ['/Users/jtr/_JTR23_/cosmo-home_2.3/voice/voice-2026-02-01.md', 'voice'],
  ['/Users/jtr/_JTR23_/release/home23/instances/jerry/workspace/jtr/2026-03-23-0331-persistent-agent-team-built.md', 'sessions'],
  ['/Users/jtr/life/areas/x/sessions/s.md', 'sessions'],
  ['/Users/jtr/life/vault/conversations/2026-03-01-turtles.md', 'conversations'],
  ['/Users/jtr/life/areas/jtr_antrhopic_archive/conversations.json', 'conversations'],
  ['/Users/jtr/life/areas/jerry_garcia/outputs/notes.md', 'research'],
  ['/Users/jtr/life/feed/MRI Report.pdf', 'health'],
  ['/Users/jtr/life/areas/refs/paper.bib', 'reading'],
  ['/Users/jtr/life/feed/article.md', 'reading'],
  ['/Users/jtr/_JTR23_/cosmo-home/some/unknown/thing.md', 'notes'],
  ['/Users/jtr/.openclaw/agents/claude/abc123.md', 'notes'],

  // NEGATIVE: bare words are topics, not provenance. These are the cases that
  // separate this implementation from a naive substring match -- the 6 original
  // happy-path tests passed against one, which is how the health bug shipped.
  ['/Users/jtr/_JTR23_/cosmo-home/engine/scripts/monitor-health.sh', 'notes'],
  ['/Users/jtr/_JTR23_/cosmo-home/engine/src/cluster/health-monitor.js', 'notes'],
  ['/Users/jtr/.openclaw/workspace/state/node-health-imac.json', 'notes'],
  ['/Users/jtr/life/notes/my-voice-memo.md', 'notes'],
  ['/Users/jtr/life/notes/01J9x2mriQ4.md', 'notes'],

  // PRECEDENCE: research outranks health. A musician's health research is
  // research, and must not defect out of its corpus on a filename word.
  ['/Users/jtr/life/areas/jerry_garcia/outputs/jerry_garcia_health_report.md', 'research'],
  ['/Users/jtr/life/areas/jerry_garcia/outputs/research/health_timeline_1986_1995_draft.md', 'research'],
];

test('routing contract', () => {
  for (const [input, expected] of FIXTURES) {
    assert.equal(classifyOrigin(input), expected, `${input} should route to ${expected}`);
  }
});

test('every declared TYPE is reachable -- an unreachable type is a 0-byte dir forever', () => {
  const reached = new Set(FIXTURES.map(([i]) => classifyOrigin(i)));
  assert.deepEqual(TYPES.filter((t) => !reached.has(t)), []);
});

test('routing is total -- never returns a type the vault has no folder for', () => {
  for (const [input] of FIXTURES) {
    assert.ok(TYPES.includes(classifyOrigin(input)), `${input} produced a type not in TYPES`);
  }
});

test('rejects non-absolute paths loudly rather than silently filing them to notes', () => {
  assert.throws(() => classifyOrigin('voice/v.md'), TypeError);
  assert.throws(() => classifyOrigin(undefined), TypeError);
  assert.throws(() => classifyOrigin(null), TypeError);
  assert.throws(() => classifyOrigin(''), TypeError);
  assert.throws(() => classifyOrigin(42), TypeError);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/scripts/vault-paths.test.cjs`
Expected: FAIL — `Cannot find module '../../scripts/vault/vault-paths.cjs'`

- [ ] **Step 3: Write minimal implementation**

```javascript
'use strict';

// Type is derived MECHANICALLY from the origin path. Provenance is a fact;
// meaning is a judgment and lives in frontmatter tags, never in folders.
//
// Precedence: MOST SPECIFIC PROVENANCE WINS.
//   1. capture-mechanism dirs (voice/)   - how it was recorded
//   2. agent-session dirs                - what produced it
//   3. named-project dirs                - what body of work it belongs to
//   4. drop-zone / sensitive dirs        - where jtr filed it
//   5. extension rules                   - last-resort format signals
// A rule may only match a PATH SEGMENT (delimited by /) or a FILE EXTENSION.
// Never match a bare word: words are topics, and topics are judgments.
const RULES = [
  [/\/voice\//i, 'voice'],
  [/\/workspace\/jtr\//i, 'sessions'],
  [/\/sessions\//i, 'sessions'],
  [/\/conversations\//i, 'conversations'],
  [/(anthropic|antrhopic)_archive\/.*conversations\.json$/i, 'conversations'],
  [/\/(jerry_garcia|trail-running|research-runs|research)\//i, 'research'],
  [/\/(health|\.health_log)\//i, 'health'],
  [/\/feed\/.*\.(pdf|jpg|jpeg|png|heic)$/i, 'health'],
  [/\.bib$/i, 'reading'],
  [/\/(feed|reading|refs)\//i, 'reading'],
];

// NOTE: '_archive' intentionally absent. The oversized artifacts it was meant to
// hold (chat.html, checkpoint-15880.json) are not document extensions and never
// reach this function. Plan 3 (archive + rebuild) owns them.
const TYPES = ['voice', 'sessions', 'conversations', 'research', 'health', 'reading', 'notes'];

function classifyOrigin(originPath) {
  // Do NOT coerce. Every rule is anchored on '/', so a relative path would
  // silently route EVERY file to notes -- a silent total misroute, which is the
  // exact defect class this project exists to eliminate.
  if (typeof originPath !== 'string' || !originPath.startsWith('/')) {
    throw new TypeError(`classifyOrigin requires an absolute path, got: ${JSON.stringify(originPath)}`);
  }
  for (const [re, type] of RULES) {
    if (re.test(originPath)) return type;
  }
  return 'notes';
}

module.exports = { classifyOrigin, TYPES };
```

> **Why these rules look the way they do.** A first draft used `/(MRI|health|\.health_log)/i` — an
> unanchored substring match. Verified against 274,258 real files: **73 routed to `health/` and
> exactly 1 was a medical record.** It captured `monitor-health.sh`, `health-monitor.js`,
> `node-health-imac.json`, `jerry_garcia_health_report.md` (research about a musician), and
> `01J9x2mriQ4.md` (a nanoid containing "mri"). The most privacy-sensitive folder in the vault would
> have been 98.6% noise with jtr's real MRI buried in it.
>
> The same draft lumped `conversations` into the `sessions` rule, making the `conversations` type
> **unreachable — no input could produce it.** `TYPES` seeds the vault skeleton, so it would have
> shipped an empty `conversations/` dir forever: **the 0-byte `entities/` failure this whole project
> diagnoses, reproduced in its own remedy.** And `jtr_antrhopic_archive/conversations.json` — the
> densest artifact in the corpus — routed to `notes`. (`antrhopic` is a real typo in the real path;
> match it literally, do not "fix" it.)
>
> Hence the hard rule: **path segments and file extensions only, never bare words.**

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/scripts/vault-paths.test.cjs`
Expected: PASS — 4 tests (a fixture table of 19 routes, plus reachability, totality, and input-contract invariants)

- [ ] **Step 5: Commit**

```bash
git add scripts/vault/vault-paths.cjs tests/scripts/vault-paths.test.cjs
git commit -m "feat(vault): mechanical type routing from origin path"
```

---

### Task 2: Content-hash index for dedup

**Files:**
- Create: `scripts/vault/hash-index.cjs`
- Test: `tests/scripts/vault-hash-index.test.cjs`

- [ ] **Step 1: Write the failing test**

```javascript
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { hashFile, HashIndex } = require('../../scripts/vault/hash-index.cjs');

function tmpfile(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-hash-'));
  const p = path.join(dir, 'f.md');
  fs.writeFileSync(p, content);
  return p;
}

test('hashFile is stable and content-addressed', () => {
  const a = tmpfile('hello jtr');
  const b = tmpfile('hello jtr');
  assert.equal(hashFile(a), hashFile(b));
  assert.match(hashFile(a), /^[0-9a-f]{64}$/);
});

test('different content hashes differently', () => {
  assert.notEqual(hashFile(tmpfile('a')), hashFile(tmpfile('b')));
});

test('index reports first-seen vs duplicate, and records every origin', () => {
  const idx = new HashIndex();
  const h = 'a'.repeat(64);   // must be a real sha256 hex digest -- non-hashes are rejected
  assert.equal(idx.recordSighting(h, '/origin/one.md').firstSighting, true);
  assert.equal(idx.recordSighting(h, '/origin/two.md').firstSighting, false);
  assert.deepEqual(idx.origins(h), ['/origin/one.md', '/origin/two.md']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/scripts/vault-hash-index.test.cjs`
Expected: FAIL — `Cannot find module '../../scripts/vault/hash-index.cjs'`

- [ ] **Step 3: Write minimal implementation**

See the committed module for the final implementation. The API is
`{ hashFile, HashIndex }` with `recordSighting(hash, origin) -> { firstSighting }`,
a read-only `has(hash)`, `seed(hash, originPaths)`, `origins(hash)` (returns a copy),
and `hashes()`.

> **Why the API looks like this** — three defects were found by review and verified against
> the real module, all of them silent-loss modes:
>
> 1. **`seen()` accepted a non-hash as a key.** `Map` takes `undefined`/`null`. A manifest entry
>    missing `sha256` bucketed unrelated documents together; the second call returned "duplicate", so
>    **the walker skipped the copy.** Now `recordSighting`/`has`/`seed` all reject anything that is
>    not a lowercase sha256 hex digest — including uppercase, which otherwise split one content
>    across two buckets and copied it twice.
> 2. **The tests passed against a weakened implementation.** Reverting the `origins()` copy and
>    wrapping `hashFile` in `try/catch { return null }` — a plausible "don't crash the 39k-file
>    walk" hardening — kept all 3 tests green. Composed: 5 unreadable documents all hash to `null`,
>    share one bucket, **1 is copied and the manifest asserts the other 4 are duplicates of it.**
>    `hashFile`'s throw-on-error contract is load-bearing and is now pinned by a test.
> 3. **`seen()` took exactly one origin, so seeding had no correct form.**
>    `seen(entry.sha256, entry.origins[0])` discarded `origins[1..n]`, so every "idempotent" re-run
>    silently erased provenance the first run captured. Hence `seed(hash, originPaths)`.
>
> And the verb was renamed: **`seen()` was a query verb that writes.** Any caller that "just checks"
> — a defensive call in a log line, a second check in another branch — appended a phantom origin and
> flipped the answer to "duplicate". `recordSighting` announces the write; `has()` is the read-only
> question. This is the Task 1 lesson repeating: tests that pass against a naive implementation are
> how the critical bug shipped.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/scripts/vault-hash-index.test.cjs`
Expected: PASS — 3 tests

- [ ] **Step 5: Commit**

```bash
git add scripts/vault/hash-index.cjs tests/scripts/vault-hash-index.test.cjs
git commit -m "feat(vault): content-hash dedup index with multi-origin provenance"
```

---

### Task 3: Vault manifest (provenance records)

**Files:**
- Create: `scripts/vault/vault-manifest.cjs`
- Test: `tests/scripts/vault-manifest.test.cjs`

- [ ] **Step 1: Write the failing test**

```javascript
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { VaultManifest, MANIFEST_SCHEMA } = require('../../scripts/vault/vault-manifest.cjs');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vault-manifest-'));
}

test('records a document with origin, hash, and type', () => {
  const m = new VaultManifest(path.join(tmpdir(), 'vault-manifest.json'));
  const SHA_A = 'a'.repeat(64);   // real digests: HashIndex.seed() rejects anything else,
  const SHA_Z = 'f'.repeat(64);   // and Task 5 seeds the index straight from this manifest.
  m.record({ vaultPath: 'voice/voice-2026-03-04.md', sha256: SHA_A, type: 'voice', origins: ['/src/voice-2026-03-04.md'], bytes: 120 });
  const e = m.get('voice/voice-2026-03-04.md');
  assert.equal(e.sha256, SHA_A);
  assert.equal(e.type, 'voice');
  assert.deepEqual(e.origins, ['/src/voice-2026-03-04.md']);
});

test('a deduped document accumulates multiple origins', () => {
  const m = new VaultManifest(path.join(tmpdir(), 'vault-manifest.json'));
  const SHA_A = 'a'.repeat(64);
  m.record({ vaultPath: 'voice/v.md', sha256: SHA_A, type: 'voice', origins: ['/a/v.md'], bytes: 10 });
  m.record({ vaultPath: 'voice/v.md', sha256: SHA_A, type: 'voice', origins: ['/b/v.md'], bytes: 10 });
  assert.deepEqual(m.get('voice/v.md').origins, ['/a/v.md', '/b/v.md']);
});

test('round-trips through disk with schema', () => {
  const p = path.join(tmpdir(), 'vault-manifest.json');
  const m = new VaultManifest(p);
  const SHA_Z = 'f'.repeat(64);
  m.record({ vaultPath: 'notes/n.md', sha256: SHA_Z, type: 'notes', origins: ['/o/n.md'], bytes: 5 });
  m.save();
  const loaded = new VaultManifest(p);
  assert.equal(loaded.get('notes/n.md').sha256, SHA_Z);
  assert.equal(JSON.parse(fs.readFileSync(p, 'utf8')).schema, MANIFEST_SCHEMA);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/scripts/vault-manifest.test.cjs`
Expected: FAIL — `Cannot find module '../../scripts/vault/vault-manifest.cjs'`

- [ ] **Step 3: Write minimal implementation**

```javascript
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MANIFEST_SCHEMA = 'home23.vault-manifest.v1';

class VaultManifest {
  constructor(manifestPath) {
    this.path = manifestPath;
    this.entries = {};
    if (fs.existsSync(manifestPath)) {
      const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      this.entries = raw.entries || {};
    }
  }

  // A vault file always records where it came from. A file without a
  // recorded origin is a bug -- provenance is the entire point of the vault.
  record({ vaultPath, sha256, type, origins, bytes }) {
    const existing = this.entries[vaultPath];
    if (existing) {
      for (const o of origins) {
        if (!existing.origins.includes(o)) existing.origins.push(o);
      }
      return existing;
    }
    this.entries[vaultPath] = {
      sha256,
      type,
      origins: [...origins],
      bytes,
      consolidatedAt: new Date().toISOString(),
    };
    return this.entries[vaultPath];
  }

  get(vaultPath) {
    return this.entries[vaultPath];
  }

  save() {
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    const body = { schema: MANIFEST_SCHEMA, savedAt: new Date().toISOString(), entries: this.entries };
    fs.writeFileSync(this.path, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
  }
}

module.exports = { VaultManifest, MANIFEST_SCHEMA };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/scripts/vault-manifest.test.cjs`
Expected: PASS — 3 tests

- [ ] **Step 5: Commit**

```bash
git add scripts/vault/vault-manifest.cjs tests/scripts/vault-manifest.test.cjs
git commit -m "feat(vault): vault manifest with multi-origin provenance records"
```

---

### Task 4: Claude archive atomizer — the first deliverable

**Files:**
- Create: `scripts/vault/atomize-claude-archive.cjs`
- Test: `tests/scripts/vault-atomize-claude.test.cjs`

This is the cheap proof of the atomizer design (spec §4.1e-1). Source:
`/Users/jtr/life/areas/jtr_antrhopic_archive/conversations.json` — 46.7 MB, **250 conversations,
4,722 messages, currently 0 nodes.** Each item already carries `uuid`, `name`, `summary`,
`created_at`, `chat_messages` — it is already a vault note.

- [ ] **Step 1: Write the failing test**

```javascript
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { atomizeClaudeArchive, conversationToMarkdown } = require('../../scripts/vault/atomize-claude-archive.cjs');

const FIXTURE = [{
  uuid: '11111111-2222-3333-4444-555555555555',
  name: 'Turtles All the Way Down',
  summary: 'A conversation about infinite recursion.',
  created_at: '2026-03-01T10:00:00Z',
  updated_at: '2026-03-01T11:00:00Z',
  chat_messages: [
    { sender: 'human', text: 'What is at the bottom?' },
    { sender: 'assistant', text: 'Turtles.' },
  ],
}];

function tmpArchive(data) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-arch-'));
  const p = path.join(dir, 'conversations.json');
  fs.writeFileSync(p, JSON.stringify(data));
  return { archive: p, out: path.join(dir, 'out') };
}

test('emits one markdown file per conversation, named by uuid for idempotency', () => {
  const { archive, out } = tmpArchive(FIXTURE);
  const result = atomizeClaudeArchive({ archivePath: archive, outDir: out });
  assert.equal(result.written, 1);
  const files = fs.readdirSync(out);
  assert.deepEqual(files, ['2026-03-01-turtles-all-the-way-down-11111111.md']);
});

test('markdown carries frontmatter with provenance and pre-written summary', () => {
  const md = conversationToMarkdown(FIXTURE[0]);
  assert.match(md, /^---\n/);
  assert.match(md, /uuid: 11111111-2222-3333-4444-555555555555/);
  assert.match(md, /created_at: '2026-03-01T10:00:00Z'/);
  assert.match(md, /source: claude-archive/);
  assert.match(md, /# Turtles All the Way Down/);
  assert.match(md, /A conversation about infinite recursion\./);
  assert.match(md, /\*\*human:\*\*\n\nWhat is at the bottom\?/);
  assert.match(md, /\*\*assistant:\*\*\n\nTurtles\./);
});

test('is idempotent -- rerunning writes identical content', () => {
  const { archive, out } = tmpArchive(FIXTURE);
  atomizeClaudeArchive({ archivePath: archive, outDir: out });
  const first = fs.readFileSync(path.join(out, fs.readdirSync(out)[0]), 'utf8');
  atomizeClaudeArchive({ archivePath: archive, outDir: out });
  const second = fs.readFileSync(path.join(out, fs.readdirSync(out)[0]), 'utf8');
  assert.equal(first, second);
});

test('a conversation with no messages is skipped, not fabricated', () => {
  const { archive, out } = tmpArchive([{ uuid: 'aaaa', name: 'Empty', created_at: '2026-01-01T00:00:00Z', chat_messages: [] }]);
  const result = atomizeClaudeArchive({ archivePath: archive, outDir: out });
  assert.equal(result.written, 0);
  assert.equal(result.skippedEmpty, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/scripts/vault-atomize-claude.test.cjs`
Expected: FAIL — `Cannot find module '../../scripts/vault/atomize-claude-archive.cjs'`

- [ ] **Step 3: Write minimal implementation**

```javascript
'use strict';

const fs = require('node:fs');
const path = require('node:path');

function slugify(text) {
  return String(text || 'untitled')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'untitled';
}

function conversationFilename(convo) {
  const date = String(convo.created_at || '').slice(0, 10) || 'undated';
  const shortId = String(convo.uuid || '').split('-')[0] || 'noid';
  return `${date}-${slugify(convo.name)}-${shortId}.md`;
}

// Frontmatter carries MEANING (tags) and PROVENANCE (uuid, date, source).
// Folders carry type only. See spec §4.0a.
function conversationToMarkdown(convo) {
  const messages = Array.isArray(convo.chat_messages) ? convo.chat_messages : [];
  const front = [
    '---',
    `uuid: ${convo.uuid || ''}`,
    `title: ${JSON.stringify(String(convo.name || 'Untitled'))}`,
    `created_at: '${convo.created_at || ''}'`,
    `updated_at: '${convo.updated_at || convo.created_at || ''}'`,
    'source: claude-archive',
    'type: conversation',
    `message_count: ${messages.length}`,
    'tags: []',
    '---',
    '',
  ].join('\n');

  const body = [`# ${convo.name || 'Untitled'}`, ''];
  if (convo.summary) body.push(convo.summary, '');
  for (const m of messages) {
    const who = m.sender || m.role || 'unknown';
    const text = m.text || m.content || '';
    body.push(`**${who}:**`, '', String(text), '');
  }
  return `${front}${body.join('\n')}`;
}

// Emits files ONLY. Never compiles, never calls an LLM. A collection the
// atomizer cannot parse is left alone and reported -- per spec §4.1c-1, a
// compiler handed thin input fabricates rather than failing.
function atomizeClaudeArchive({ archivePath, outDir }) {
  const raw = JSON.parse(fs.readFileSync(archivePath, 'utf8'));
  if (!Array.isArray(raw)) {
    throw new Error(`claude archive must be a JSON array, got ${typeof raw}`);
  }
  fs.mkdirSync(outDir, { recursive: true });
  let written = 0;
  let skippedEmpty = 0;
  for (const convo of raw) {
    const messages = Array.isArray(convo.chat_messages) ? convo.chat_messages : [];
    if (messages.length === 0) {
      skippedEmpty += 1;
      continue;
    }
    const target = path.join(outDir, conversationFilename(convo));
    fs.writeFileSync(target, conversationToMarkdown(convo), 'utf8');
    written += 1;
  }
  return { written, skippedEmpty, total: raw.length };
}

module.exports = { atomizeClaudeArchive, conversationToMarkdown, conversationFilename };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/scripts/vault-atomize-claude.test.cjs`
Expected: PASS — 4 tests

- [ ] **Step 5: Run against the real archive (read-only source, temp output)**

```bash
node -e "
const { atomizeClaudeArchive } = require('./scripts/vault/atomize-claude-archive.cjs');
const out = '/private/tmp/claude-501/-Users-jtr--JTR23--release-home23/0b58b33b-d35a-4f13-89bd-aeafe24bdab8/scratchpad/claude-atomized';
console.log(atomizeClaudeArchive({
  archivePath: '/Users/jtr/life/areas/jtr_antrhopic_archive/conversations.json',
  outDir: out,
}));
"
```

Expected: `{ written: 250, skippedEmpty: 0, total: 250 }` (or `written + skippedEmpty === 250`)

**Acceptance (spec §4.1e-1):** 250 files emitted. Spot-check three by eye — each has frontmatter,
a title, the pre-written summary, and readable dialogue. **If this fails, it fails cheap, and it
tells us the atomizer design is wrong before a rebuild depends on it.**

- [ ] **Step 6: Commit**

```bash
git add scripts/vault/atomize-claude-archive.cjs tests/scripts/vault-atomize-claude.test.cjs
git commit -m "feat(vault): Claude archive atomizer -- 250 conversations to markdown"
```

---

### Task 5: The consolidator

**Files:**
- Create: `scripts/vault/consolidate.cjs`
- Test: `tests/scripts/vault-consolidate.test.cjs`

- [ ] **Step 1: Write the failing test**

```javascript
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { consolidate } = require('../../scripts/vault/consolidate.cjs');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-consol-'));
  const srcA = path.join(root, 'srcA', 'voice');
  const srcB = path.join(root, 'srcB', 'voice');
  fs.mkdirSync(srcA, { recursive: true });
  fs.mkdirSync(srcB, { recursive: true });
  fs.writeFileSync(path.join(srcA, 'v1.md'), 'same content');
  fs.writeFileSync(path.join(srcB, 'v1.md'), 'same content');
  fs.writeFileSync(path.join(srcA, 'v2.md'), 'different content');
  return { root, sources: [path.join(root, 'srcA'), path.join(root, 'srcB')], vault: path.join(root, 'vault') };
}

test('copies documents into type folders and never mutates the source', () => {
  const { sources, vault } = fixture();
  const r = consolidate({ sources, vaultRoot: vault });
  assert.ok(fs.existsSync(path.join(vault, 'voice', 'v2.md')));
  assert.equal(fs.readFileSync(path.join(sources[0], 'voice', 'v2.md'), 'utf8'), 'different content');
  assert.equal(r.copied, 2);
});

test('identical content is stored once with both origins recorded', () => {
  const { sources, vault } = fixture();
  const r = consolidate({ sources, vaultRoot: vault });
  assert.equal(r.deduped, 1);
  const manifest = JSON.parse(fs.readFileSync(path.join(vault, 'vault-manifest.json'), 'utf8'));
  const entry = Object.values(manifest.entries).find((e) => e.origins.length === 2);
  assert.equal(entry.origins.length, 2);
});

test('is idempotent -- a second run copies nothing new', () => {
  const { sources, vault } = fixture();
  consolidate({ sources, vaultRoot: vault });
  const second = consolidate({ sources, vaultRoot: vault });
  assert.equal(second.copied, 0);
});

test('skips excluded trees', () => {
  const { root, sources, vault } = fixture();
  const nm = path.join(sources[0], 'node_modules', 'pkg');
  fs.mkdirSync(nm, { recursive: true });
  fs.writeFileSync(path.join(nm, 'README.md'), 'npm garbage');
  const r = consolidate({ sources, vaultRoot: vault });
  assert.equal(fs.existsSync(path.join(vault, 'notes', 'README.md')), false);
  assert.equal(r.skippedExcluded >= 1, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/scripts/vault-consolidate.test.cjs`
Expected: FAIL — `Cannot find module '../../scripts/vault/consolidate.cjs'`

- [ ] **Step 3: Write minimal implementation**

```javascript
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { classifyOrigin } = require('./vault-paths.cjs');
const { hashFile, HashIndex } = require('./hash-index.cjs');
const { VaultManifest } = require('./vault-manifest.cjs');

const DOC_EXT = new Set(['.md', '.txt', '.pdf', '.bib']);
// 'venv' and 'site-packages' added after a real-corpus scan found 89 files under
// /venv/ and 103 under site-packages reaching the vault as Python package READMEs.
const EXCLUDE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.venv', 'venv', 'site-packages', '__pycache__']);

function* walk(root, stats) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (e.isDirectory()) {
      if (EXCLUDE_DIRS.has(e.name)) {
        stats.skippedExcluded += 1;
        continue;
      }
      yield* walk(full, stats);
    } else if (e.isFile()) {
      if (e.name.startsWith('.')) continue;
      if (!DOC_EXT.has(path.extname(e.name).toLowerCase())) continue;
      yield full;
    }
  }
}

// COPY ONLY. Never moves, never deletes. Originals stay put; archiving is a
// separate, later, explicit action (jtr, 2026-07-15).
function consolidate({ sources, vaultRoot }) {
  const stats = { copied: 0, deduped: 0, skippedExcluded: 0, scanned: 0 };
  const manifest = new VaultManifest(path.join(vaultRoot, 'vault-manifest.json'));
  const index = new HashIndex();
  const vaultPathByHash = new Map();

  // Seed from the existing manifest so reruns are idempotent.
  // MUST use seed(), not recordSighting(): recordSighting takes ONE origin, so
  // seeding through it would drop origins[1..n] and every "idempotent" re-run
  // would silently destroy provenance the first run correctly captured --
  // across thousands of entries (cosmo-home / cosmo-home_2.3 share 3,361 paths).
  for (const [vaultPath, entry] of Object.entries(manifest.entries)) {
    index.seed(entry.sha256, entry.origins);
    vaultPathByHash.set(entry.sha256, vaultPath);
  }

  for (const source of sources) {
    for (const origin of walk(source, stats)) {
      stats.scanned += 1;
      const sha256 = hashFile(origin);
      const type = classifyOrigin(origin);

      if (!index.recordSighting(sha256, origin).firstSighting) {
        stats.deduped += 1;
        const vaultPath = vaultPathByHash.get(sha256);
        if (vaultPath) manifest.record({ vaultPath, sha256, type, origins: [origin], bytes: fs.statSync(origin).size });
        continue;
      }

      const vaultPath = path.join(type, path.basename(origin));
      const target = path.join(vaultRoot, vaultPath);
      vaultPathByHash.set(sha256, vaultPath);

      if (!fs.existsSync(target)) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(origin, target);
        stats.copied += 1;
      }
      manifest.record({ vaultPath, sha256, type, origins: [origin], bytes: fs.statSync(origin).size });
    }
  }

  manifest.save();
  return stats;
}

module.exports = { consolidate };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/scripts/vault-consolidate.test.cjs`
Expected: PASS — 4 tests

- [ ] **Step 5: Commit**

```bash
git add scripts/vault/consolidate.cjs tests/scripts/vault-consolidate.test.cjs
git commit -m "feat(vault): copy-only consolidator with dedup and provenance"
```

---

### Task 6: Filename collision safety

**Files:**
- Modify: `scripts/vault/consolidate.cjs`
- Test: `tests/scripts/vault-consolidate.test.cjs`

Two different documents can share a basename (`README.md` exists everywhere). Task 5 would
silently keep the first and drop the second — **a silent loss, which is the exact defect class this
whole project exists to eliminate** (spec §4.1c).

- [ ] **Step 1: Write the failing test**

Append to `tests/scripts/vault-consolidate.test.cjs`:

```javascript
test('different content with the same basename never overwrites or silently drops', () => {
  const { sources, vault } = fixture();
  fs.writeFileSync(path.join(sources[1], 'voice', 'v2.md'), 'DIFFERENT content, same name');
  const r = consolidate({ sources, vaultRoot: vault });
  assert.equal(r.copied, 3);
  const files = fs.readdirSync(path.join(vault, 'voice')).sort();
  assert.equal(files.length, 3);
  const bodies = files.map((f) => fs.readFileSync(path.join(vault, 'voice', f), 'utf8')).sort();
  assert.deepEqual(bodies, ['DIFFERENT content, same name', 'different content', 'same content']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/scripts/vault-consolidate.test.cjs`
Expected: FAIL — `copied` is 2, not 3; the second `v2.md` was dropped

- [ ] **Step 3: Write minimal implementation**

In `scripts/vault/consolidate.cjs`, replace the `const vaultPath = path.join(type, path.basename(origin));`
line and the copy block with:

```javascript
      const vaultPath = path.join(type, uniqueName(vaultRoot, type, origin, sha256));
      const target = path.join(vaultRoot, vaultPath);
      vaultPathByHash.set(sha256, vaultPath);

      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(origin, target);
      stats.copied += 1;
```

And add above `consolidate`:

```javascript
// Same basename + different content must never collide. Suffix with a short
// content hash: deterministic, so reruns are still idempotent.
function uniqueName(vaultRoot, type, origin, sha256) {
  const base = path.basename(origin);
  const candidate = path.join(vaultRoot, type, base);
  if (!fs.existsSync(candidate)) return base;
  if (hashFile(candidate) === sha256) return base;
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  return `${stem}-${sha256.slice(0, 8)}${ext}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/scripts/vault-consolidate.test.cjs`
Expected: PASS — 5 tests

- [ ] **Step 5: Commit**

```bash
git add scripts/vault/consolidate.cjs tests/scripts/vault-consolidate.test.cjs
git commit -m "fix(vault): never silently drop same-name different-content documents"
```

---

### Task 7: Coverage report — prove nothing was missed

**Files:**
- Create: `scripts/vault/coverage-report.cjs`
- Test: `tests/scripts/vault-coverage.test.cjs`

Per spec §4.1c, a document that is silently absent is the core defect. The consolidator must be
able to prove that every source document is either in the vault or explicitly accounted for.

- [ ] **Step 1: Write the failing test**

```javascript
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { consolidate } = require('../../scripts/vault/consolidate.cjs');
const { coverageReport } = require('../../scripts/vault/coverage-report.cjs');

test('every source document is accounted for in the vault manifest', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-cov-'));
  const src = path.join(root, 'src', 'voice');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, 'a.md'), 'aaa');
  fs.writeFileSync(path.join(src, 'b.md'), 'bbb');
  const vault = path.join(root, 'vault');
  consolidate({ sources: [path.join(root, 'src')], vaultRoot: vault });

  const rep = coverageReport({ sources: [path.join(root, 'src')], vaultRoot: vault });
  assert.equal(rep.sourceDocs, 2);
  assert.equal(rep.accountedFor, 2);
  assert.deepEqual(rep.missing, []);
});

test('an unconsolidated document is reported as missing, not ignored', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-cov2-'));
  const src = path.join(root, 'src', 'voice');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, 'a.md'), 'aaa');
  const vault = path.join(root, 'vault');
  consolidate({ sources: [path.join(root, 'src')], vaultRoot: vault });
  fs.writeFileSync(path.join(src, 'late.md'), 'arrived after consolidation');

  const rep = coverageReport({ sources: [path.join(root, 'src')], vaultRoot: vault });
  assert.equal(rep.missing.length, 1);
  assert.match(rep.missing[0], /late\.md$/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/scripts/vault-coverage.test.cjs`
Expected: FAIL — `Cannot find module '../../scripts/vault/coverage-report.cjs'`

- [ ] **Step 3: Write minimal implementation**

```javascript
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { hashFile } = require('./hash-index.cjs');
const { VaultManifest } = require('./vault-manifest.cjs');

const DOC_EXT = new Set(['.md', '.txt', '.pdf', '.bib']);
// 'venv' and 'site-packages' added after a real-corpus scan found 89 files under
// /venv/ and 103 under site-packages reaching the vault as Python package READMEs.
const EXCLUDE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.venv', 'venv', 'site-packages', '__pycache__']);

function* walk(root) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (e.isDirectory()) {
      if (EXCLUDE_DIRS.has(e.name)) continue;
      yield* walk(full);
    } else if (e.isFile()) {
      if (e.name.startsWith('.')) continue;
      if (!DOC_EXT.has(path.extname(e.name).toLowerCase())) continue;
      yield full;
    }
  }
}

// "Nothing missed" must be CHECKABLE, not hoped for (spec §4.1c).
function coverageReport({ sources, vaultRoot }) {
  const manifest = new VaultManifest(path.join(vaultRoot, 'vault-manifest.json'));
  const knownOrigins = new Set();
  const knownHashes = new Set();
  for (const entry of Object.values(manifest.entries)) {
    knownHashes.add(entry.sha256);
    for (const o of entry.origins) knownOrigins.add(o);
  }

  let sourceDocs = 0;
  let accountedFor = 0;
  const missing = [];
  for (const source of sources) {
    for (const origin of walk(source)) {
      sourceDocs += 1;
      if (knownOrigins.has(origin) || knownHashes.has(hashFile(origin))) {
        accountedFor += 1;
      } else {
        missing.push(origin);
      }
    }
  }
  return { sourceDocs, accountedFor, missing, vaultFiles: Object.keys(manifest.entries).length };
}

module.exports = { coverageReport };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/scripts/vault-coverage.test.cjs`
Expected: PASS — 2 tests

- [ ] **Step 5: Commit**

```bash
git add scripts/vault/coverage-report.cjs tests/scripts/vault-coverage.test.cjs
git commit -m "feat(vault): coverage report -- prove no source document is silently absent"
```

---

### Task 8: Wire the CLI and add npm scripts

**Files:**
- Modify: `scripts/vault/consolidate.cjs` (append CLI)
- Modify: `package.json`

- [ ] **Step 1: Append the CLI to `scripts/vault/consolidate.cjs`**

```javascript
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { args[key] = next; i += 1; } else { args[key] = true; }
  }
  return args;
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!args.vault) throw new Error('--vault is required');
  if (!args.source) throw new Error('--source is required (repeatable via comma-separated list)');
  const sources = String(args.source).split(',').map((s) => path.resolve(s.trim()));
  const stats = consolidate({ sources, vaultRoot: path.resolve(args.vault) });
  process.stdout.write(`${JSON.stringify(stats, null, 2)}\n`);
  return stats;
}

module.exports = { consolidate, main };

if (require.main === module) {
  main().catch((err) => { process.stderr.write(`${err.stack}\n`); process.exit(1); });
}
```

- [ ] **Step 2: Add npm scripts to `package.json`**

In the `scripts` block, add:

```json
    "vault:consolidate": "node scripts/vault/consolidate.cjs",
    "vault:coverage": "node -e \"console.log(JSON.stringify(require('./scripts/vault/coverage-report.cjs').coverageReport({sources: process.env.VAULT_SOURCES.split(','), vaultRoot: process.env.VAULT_ROOT}), null, 2))\"",
    "test:vault": "node --test tests/scripts/vault-paths.test.cjs tests/scripts/vault-hash-index.test.cjs tests/scripts/vault-manifest.test.cjs tests/scripts/vault-atomize-claude.test.cjs tests/scripts/vault-consolidate.test.cjs tests/scripts/vault-coverage.test.cjs",
```

- [ ] **Step 3: Run the full vault suite**

Run: `npm run test:vault`
Expected: PASS — all 20 tests across 6 files

- [ ] **Step 4: Commit**

```bash
git add scripts/vault/consolidate.cjs package.json
git commit -m "feat(vault): consolidator CLI and npm scripts"
```

---

### Task 9: Dry consolidation into a scratch vault (verification, not production)

**Files:**
- None modified. This is a verification step.

**Do not write into `/Users/jtr/life/` yet.** Prove the numbers first.

- [ ] **Step 1: Atomize the Claude archive into the scratch vault**

```bash
SCRATCH=/private/tmp/claude-501/-Users-jtr--JTR23--release-home23/0b58b33b-d35a-4f13-89bd-aeafe24bdab8/scratchpad/vault-dry
node -e "
const { atomizeClaudeArchive } = require('./scripts/vault/atomize-claude-archive.cjs');
console.log(atomizeClaudeArchive({
  archivePath: '/Users/jtr/life/areas/jtr_antrhopic_archive/conversations.json',
  outDir: process.env.SCRATCH + '/conversations',
}));
"
```

Expected: `written + skippedEmpty === 250`

- [ ] **Step 2: Consolidate all five sources into the scratch vault**

```bash
npm run vault:consolidate -- \
  --vault $SCRATCH \
  --source "/Users/jtr/_JTR23_/cosmo-home,/Users/jtr/_JTR23_/cosmo-home_2.3,/Users/jtr/.openclaw,/Users/jtr/_JTR23_/release/home23/instances/jerry/workspace/jtr,/Users/jtr/life"
```

Expected:
```json
{ "scanned": 52798, "copied": <copied+deduped must equal scanned>, "deduped": <n>, "skippedExcluded": <n> }
```

**Check 1 — `scanned` must be 52,798.** Measured 2026-07-15 across the five sources. This is
**967 higher than the 567 MB baseline's 51,831**, because the baseline counted `.md`/`.txt`/`.pdf`
while `DOC_EXT` also includes `.bib` (bibliographies are real reading material and belong in the
vault). Both numbers are correct; they count different sets.

**Check 2 — `copied + deduped` must equal `scanned`.** Every scanned document is either copied or
recognised as an exact duplicate. If the two do not sum, documents are being dropped silently —
**stop immediately.** That is the precise defect this project exists to eliminate (spec §4.1c).

If `scanned` is materially lower than 52,798, the walker is dropping documents. Stop and find out why.

- [ ] **Step 3: Run the coverage report — this is the acceptance gate**

```bash
VAULT_ROOT=$SCRATCH VAULT_SOURCES="/Users/jtr/_JTR23_/cosmo-home,/Users/jtr/_JTR23_/cosmo-home_2.3,/Users/jtr/.openclaw,/Users/jtr/_JTR23_/release/home23/instances/jerry/workspace/jtr,/Users/jtr/life" npm run vault:coverage
```

Expected: `missing: []` and `accountedFor === sourceDocs`

**If `missing` is non-empty, the plan has failed its own core test** (spec §4.1c: nothing may be
silently absent). Do not proceed. Investigate each missing file.

- [ ] **Step 4: Verify originals are untouched**

```bash
find /Users/jtr/_JTR23_/cosmo-home -type f -name "*.md" -not -path "*/node_modules/*" | wc -l
```

Expected: `28962` — unchanged. **The consolidator copies; it must never mutate a source.**

- [ ] **Step 5: Eyeball three atomized conversations**

```bash
ls $SCRATCH/conversations | head -3
head -25 "$SCRATCH/conversations/$(ls $SCRATCH/conversations | head -1)"
```

Expected: frontmatter with `uuid`/`created_at`/`source: claude-archive`, a title, the pre-written
summary, then readable dialogue.

- [ ] **Step 6: Report the numbers to jtr before any production write**

Report: scanned, copied, deduped, missing, and the per-type file counts:

```bash
for d in voice sessions conversations research health reading notes; do
  printf "%-16s %s\n" "$d" "$(ls $SCRATCH/$d 2>/dev/null | wc -l)"
done
```

**STOP HERE.** Production consolidation into `/Users/jtr/life/` requires jtr's review of these
numbers. The vault location is his call (spec §4.0b — he is agnostic; `/Users/jtr/life/` is a
default, not a decision).

---

## What This Plan Does NOT Do

- **No engine changes.** No `addNode` doors, no decay config, no GC, no `state_snapshot` removal.
  That is plan 2 (door fixes), and it must land before any rebuild.
- **No rebuild.** No manifest deletion, no reingest, no archive of the old brain. That is plan 3,
  and it depends on plans 1 and 2 both being complete.
- **No deletion of anything, anywhere.** Originals stay. Archiving to an external volume
  (Althea / Bertha / Casey Jones) is a later explicit action.
- **No ChatGPT atomizer.** `chat.html` (471 MB, currently 1 fabricated node) needs a
  `<script>`-block extractor. It is a fast-follow once the Claude atomizer proves the design.
- **No frontmatter tag backfill.** The atomizer writes `tags: []`. Populating meaning-tags across
  51,831 documents is deferred — spec §4.0a says let the compiler's existing key-concept extraction
  propose them free during the rebuild, and only pay for a dedicated pass if that proves insufficient.
- **No live connectors.** Calendar, email, home/tesla devices are out of scope entirely (spec §1.15).

## Known Gaps — carry these into the ChatGPT atomizer and plan 3

Recorded from the final whole-implementation review and the real 33,129-document run. **None of these
affect the live vault at `/Users/jtr/vault/`** — all were caught before or dodged by the chosen paths.

1. **`renderContentBlock`'s `tool_use` / `tool_result` / `thinking` branches are dead code on the
   Claude archive.** Every real message carrying those block types *also* has non-empty top-level
   `text`, so the fallback never fires against real data. Synthetic tests cover it; **reality does
   not.** The ChatGPT export is ~10× larger with a different shape and will lean on exactly that path.
   **Treat those branches as unverified.** The `[object Object]` bug lived there and was only found by
   reading real messages — not by any test.
2. **80 files in the vault already contain `[object Object]`** — 73 in `notes/`, 6 in `sessions/`, 1 in
   `research/`, **zero in `conversations/`.** This is *pre-existing damage* in cosmo-home / .openclaw /
   jerry-workspace, faithfully copied forward. The same bug class the atomizer nearly shipped,
   **already committed years ago by the previous systems.** Out of scope for a copy-only tool, but it
   means the corpus itself carries old wounds that a rebuild will ingest verbatim.
3. **`health/AUTO DRIVER LICENSE.pdf`** is typed `health` because it lives in `life/feed/` and the rule
   is `/feed/*.pdf → health`. A licence is a sensitive ID document, so the private folder is not a
   harmful home — but it is not health data, and a human skimming `health/` will notice immediately.
4. **3 of 246 atomized conversations are genuine empty shells** — verified against the raw JSON (every
   message has `text: ""`, no content blocks, no attachments). Real aborted sessions, faithfully
   rendered, not an atomizer failure. So it is **243 real conversations**, not 246.
5. **`.openclaw` is a live, Syncthing-backed directory, not a static archive.** Two files mutated
   mid-run (pid 1072). Provably not this tool — the only writes ever target the vault or the manifest,
   and both files were `.json`/`.tmp`, outside `DOC_EXT`. **Any future run against it will show
   background drift that is not ours.** Worth knowing before archiving it to external storage.
6. **No content-quality check exists at scale.** Coverage proves every source document has a recorded
   origin and every vault file matches its hash. **Nothing certifies that what got copied is good
   prose rather than garbage** — only two files were hand-read. For ~39k documents that is true of any
   tool, but it must be named rather than assumed: **the vault is proven complete, not proven good.**

**The process lesson, recorded because it produced the worst bug in this plan:** Task 4's implementer
correctly flagged the atomizer's collision risk and was told it was Task 6's job. **Task 6 shipped and
hardened only `consolidate.cjs`. Nobody came back.** Seven per-task reviews all missed it because it
lived at a seam no task owned. A deferral without an owner is a silent loss of its own.

## Follow-On Plans

1. **Plan 2 — Door fixes** (engine, live system): the ~23 `addNode` sites, the `state_snapshot`
   writer, decay `exemptTags`, the GC provenance rewrite, the yield check, the catalog rule, the two
   dream dice rolls. **Must precede any rebuild** — spec §5.
2. **Plan 3 — Archive + rebuild**: archive the old brain, delete the ingestion manifest, reingest
   from the vault, verify every node traces to a file. **The only irreversible phase.**
3. **Retrieval spec** (separate design doc): `context-assembly` on PGS, the grounding/citation chain,
   partition quality. Spec §8.

**Note for plan 2's author:** `scripts/audit-brain-provenance.cjs` already exists and does node-level
authority/domain classification with `missingEvidence`, a guarded apply path, backup receipts, and CAS
pinning. It scans all 143,479 nodes and currently reports the top-200 most-activated nodes as
**100% `narrative`**. Plan 2 should use it, not rebuild it.
