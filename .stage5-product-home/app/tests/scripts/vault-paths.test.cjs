'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyOrigin, isExcluded, TYPES } = require('../../scripts/vault/vault-paths.cjs');

// [input, expected] — the whole routing contract on one screen.
const FIXTURES = [
  // positive: each type reachable from a real path
  ['/Users/jtr/_JTR23_/cosmo-home/runs/jtr/inputs/voice/voice-2026-03-04T03-24-06-127Z.md', 'voice'],
  ['/Users/jtr/_JTR23_/cosmo-home_2.3/voice/voice-2026-02-01.md', 'voice'],
  ['/Users/jtr/_JTR23_/release/home23/instances/jerry/workspace/jtr/2026-03-23-0331-persistent-agent-team-built.md', 'sessions'],
  ['/Users/jtr/life/areas/x/sessions/s.md', 'sessions'],
  ['/Users/jtr/life/areas/jtr_antrhopic_archive/conversations.json', 'conversations'],
  ['/Users/jtr/life/areas/jerry_garcia/outputs/notes.md', 'research'],
  ['/Users/jtr/life/feed/MRI Report.pdf', 'health'],
  ['/Users/jtr/life/areas/refs/paper.bib', 'reading'],
  ['/Users/jtr/life/feed/article.md', 'reading'],
  ['/Users/jtr/_JTR23_/cosmo-home/some/unknown/thing.md', 'notes'],
  ['/Users/jtr/.openclaw/agents/claude/abc123.md', 'notes'],

  // NEGATIVE: bare words are topics, not provenance. These are the cases that
  // separate this implementation from a naive substring match.
  ['/Users/jtr/_JTR23_/cosmo-home/engine/scripts/monitor-health.sh', 'notes'],
  ['/Users/jtr/_JTR23_/cosmo-home/engine/src/cluster/health-monitor.js', 'notes'],
  ['/Users/jtr/.openclaw/workspace/state/node-health-imac.json', 'notes'],
  ['/Users/jtr/life/notes/my-voice-memo.md', 'notes'],
  ['/Users/jtr/life/notes/01J9x2mriQ4.md', 'notes'],

  // PRECEDENCE: research outranks health -- a musician's health research is
  // research, and must not defect out of its corpus on a filename word.
  ['/Users/jtr/life/areas/jerry_garcia/outputs/jerry_garcia_health_report.md', 'research'],
  ['/Users/jtr/life/areas/jerry_garcia/outputs/research/health_timeline_1986_1995_draft.md', 'research'],

  // jtr's ruling: runs/*/inputs are REAL sessions, from any agent
  ['/Users/jtr/_JTR23_/cosmo-home/runs/terrapin/inputs/session-2026-03-05-abc.md', 'sessions'],
  ['/Users/jtr/_JTR23_/cosmo-home/runs/jtr/inputs/Garcia_Digital_Workflow_Painter_vs_Photoshop_Report.md', 'sessions'],
  // ...but voice still wins inside runs/jtr/inputs/voice/
  ['/Users/jtr/_JTR23_/cosmo-home/runs/jtr/inputs/voice/voice-2026-03-04T03-24-06-127Z.md', 'voice'],
  // jtr's ruling: COSMObrains outputs are research, not exhaust
  ['/Users/jtr/.openclaw/workspace/COSMObrains/BigMerge_01_23/outputs/code-creation/agent_1767921533633_k.md', 'research'],
  // real intellectual work
  ['/Users/jtr/.openclaw/workspace/curriculum/systems-epistemology-curriculum.md', 'research'],
  // atomizer output is reachable (Task 4 writes YYYY-MM-DD-slug-id.md atoms).
  // First entry is a REAL filename from the live vault, not a guessed shape.
  ['/Users/jtr/vault/conversations/2024-08-27-accurate-solar-system-simulation-8a00448f.md', 'conversations'],
  ['/Users/jtr/vault/conversations/2026-03-01-turtles-all-the-way-down-11111111.md', 'conversations'],
  // The atomizer emits `undated-*` when created_at is missing. It MUST keep
  // emitting them (refusing would be silent loss), so routing must accept them.
  ['/Users/jtr/vault/conversations/undated-untitled-noid.md', 'conversations'],
  // full-uuid collision-resolution shape (the atomizer promotes to full uuid on conflict)
  ['/Users/jtr/vault/conversations/2026-03-01-turtles-11111111-2222-3333-4444-555555555555.md', 'conversations'],
  // runtime state dirs named conversations/ are NOT conversations
  ['/Users/jtr/_JTR23_/release/home23/instances/jerry/conversations/telegram-offset.json', 'notes'],
  ['/Users/jtr/_JTR23_/release/home23/instances/jerry/conversations/cron-jobs.json', 'notes'],
  // engine/runtime's 6 real files are NOT excluded
  ['/Users/jtr/_JTR23_/cosmo-home/engine/runtime/guided-plan.md', 'notes'],
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

const EXCLUDED = [
  '/Users/jtr/_JTR23_/cosmo-home/engine/runtime/coordinator/review_1497.md',
  '/Users/jtr/.openclaw/workspace/persist/20260509T044739-scheduled-sync-state.md',
  '/Users/jtr/.openclaw/workspace/memory/reflection-2025-03-03.md',
  // Timer-written telemetry snapshot, rewritten on a cron.
  '/Users/jtr/.openclaw/workspace/heartbeat/PI_STATUS.md',
];
const NOT_EXCLUDED = [
  '/Users/jtr/_JTR23_/cosmo-home/engine/runtime/guided-plan.md',
  '/Users/jtr/.openclaw/workspace/curriculum/systems-epistemology-curriculum.md',
  '/Users/jtr/_JTR23_/cosmo-home/runs/terrapin/inputs/session-2026-03-05-abc.md',
];

// Every one of these is a REAL, hand-written document on the owner's disk
// that a basename-based heartbeat rule (/(HEARTBEAT|PI_STATUS|STATUS)\.md$/)
// would have silently dropped. Measured on the real corpus: that pattern
// matches 30 files, of which 29 are genuine content and exactly ONE is timer
// exhaust. These are pinned so the exclusion can never widen back into them.
const REAL_STATUS_DOCUMENTS = [
  // 9.5KB hand-written launch report, with deployment steps and file paths.
  '/Users/jtr/.openclaw/workspace/projects/jerry-garcia-deep-dive/STATUS.md',
  // Hand-written archive/planning note for a migration.
  '/Users/jtr/_JTR23_/cosmo-home_2.3/projects/coz-migration/STATUS.md',
  // Real subagent deliverables report.
  '/Users/jtr/.openclaw/workspace/cosmo-doc-brain/STATUS.md',
  // Per-agent identity/status documents.
  '/Users/jtr/_JTR23_/cosmo-home_2.3/workspace/agents/sentinel/STATUS.md',
  '/Users/jtr/_JTR23_/cosmo-home_2.3/workspace/agents/tick/HEARTBEAT.md',
  // 17KB accumulating work tracker: records that things HAPPENED (newsletter
  // published, blocker resolved) -- the opposite of "nothing happened".
  '/Users/jtr/.openclaw/workspace/HEARTBEAT.md',
  '/Users/jtr/_JTR23_/cosmo-home_2.3/workspace/HEARTBEAT.md',
];

test('excludes records-that-nothing-happened, keeps real material in the same trees', () => {
  for (const p of EXCLUDED) assert.equal(isExcluded(p), true, `${p} should be excluded`);
  for (const p of NOT_EXCLUDED) assert.equal(isExcluded(p), false, `${p} must NOT be excluded`);
});

test('the heartbeat exclusion is anchored to the timer directory, never to STATUS/HEARTBEAT basenames', () => {
  // The narrow rule must take the one telemetry file...
  assert.equal(isExcluded('/Users/jtr/.openclaw/workspace/heartbeat/PI_STATUS.md'), true);
  // ...and anything else that cron drops in that same directory.
  assert.equal(isExcluded('/Users/jtr/.openclaw/workspace/heartbeat/NODE_STATUS.md'), true);
  // ...while leaving every real hand-written status document alone.
  for (const p of REAL_STATUS_DOCUMENTS) {
    assert.equal(isExcluded(p), false, `${p} is real content and must NOT be excluded`);
  }
});

test('isExcluded rejects non-absolute paths loudly, like classifyOrigin', () => {
  assert.throws(() => isExcluded('workspace/memory/x.md'), TypeError);
  assert.throws(() => isExcluded(undefined), TypeError);
  assert.throws(() => isExcluded(null), TypeError);
  assert.throws(() => isExcluded(''), TypeError);
  assert.throws(() => isExcluded(42), TypeError);
});
