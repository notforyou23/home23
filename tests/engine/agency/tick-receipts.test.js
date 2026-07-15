// AgencyKernel#tick() selects one resident pursuit and asks AgencyEditor to
// evaluate it. Before this fix, tick() unconditionally wrote a
// home23.agency.scratch.v1 note ("Resident tick selected one pursuit and
// chose ${editor.action}.") and a home23.agency.receipt.v1 record for
// EVERY tick, before it even looked at what editor.action was.
//
// AgencyEditor's default verdict -- 'allow' / action: 'advance_one_step',
// reason: 'pursuit_has_no_editor_block' -- means the pursuit passed every
// editor check and just continues unchanged. No pursuit state was mutated,
// no consequence was recorded. That is a loop ticking, not an event, and
// it does not need a receipt.
//
// The other three editor actions (kill_stale_thread,
// demote_ornamental_dashboard_panel, require_consequence) each go on,
// further down in tick(), to mutate pursuit state (store.updatePursuit) or
// record an explicit consequence (store.appendConsequence). Those are real
// and must still be recorded.
//
// residentTickIsRecordWorthy(editorAction) is the pure gate: false only
// for 'advance_one_step', true for everything else -- a blacklist, not an
// allowlist, so a future editor action this function has never seen
// defaults to being recorded rather than silently dropped.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AgencyKernel, residentTickIsRecordWorthy } from '../../../engine/src/agency/resident-kernel.js';

function readJsonl(path) {
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function brainDir() {
  const dir = mkdtempSync(join(tmpdir(), 'home23-agency-tick-'));
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeKernel(dir) {
  return new AgencyKernel({
    brainDir: dir,
    agentName: 'jerry',
    config: { enabled: true, mode: 'dry_run', charter: { attention: { maxActivePursuits: 5, maxWatchItems: 20 } } },
  });
}

// ---------------------------------------------------------------------------
// residentTickIsRecordWorthy() -- the pure decision function
// ---------------------------------------------------------------------------

test('residentTickIsRecordWorthy: advance_one_step (the no-op default verdict) is not record-worthy', () => {
  assert.equal(residentTickIsRecordWorthy('advance_one_step'), false);
});

test('residentTickIsRecordWorthy: the three real editor actions are record-worthy', () => {
  assert.equal(residentTickIsRecordWorthy('kill_stale_thread'), true);
  assert.equal(residentTickIsRecordWorthy('demote_ornamental_dashboard_panel'), true);
  assert.equal(residentTickIsRecordWorthy('require_consequence'), true);
});

test('residentTickIsRecordWorthy: an unknown future action defaults to record-worthy (blacklist, not allowlist)', () => {
  assert.equal(residentTickIsRecordWorthy('some_action_this_function_has_never_seen'), true);
});

// ---------------------------------------------------------------------------
// AgencyKernel#tick() -- the gated writes
// ---------------------------------------------------------------------------

test('a tick that takes no action writes no scratch and no receipt', async () => {
  const dir = brainDir();
  const kernel = makeKernel(dir);

  const intake = await kernel.intake({
    source: 'chat',
    kind: 'operator_request',
    summary: 'Investigate a benign recurring pursuit with no editor block whatsoever.',
    evidence: [{ type: 'chat', ref: 'msg-benign' }],
    authorityLevel: 'L2',
    desiredChangedFuture: 'A concrete, verifiable next step gets taken.',
  });
  assert.equal(intake.decision.route, 'pursue', 'sanity: pursuit must be selectable by tick()');

  const tick = await kernel.tick({ reason: 'test-no-op-tick', now: '2026-07-15T12:00:00.000Z' });

  // Sanity: this really is the no-op editor branch under test.
  assert.equal(tick.selected.pursuitId, intake.pursuit.id);
  assert.equal(tick.editor.action, 'advance_one_step');
  assert.equal(tick.editor.verdict, 'allow');

  const agencyDir = join(dir, 'agency');
  // Both files are pre-touched empty by PursuitStore's constructor, so
  // existence alone proves nothing -- assert on content instead.
  const scratch = readJsonl(join(agencyDir, 'scratch.jsonl')).filter((r) => r.pursuitId === intake.pursuit.id || r.kind === 'resident_tick');
  const receipts = readJsonl(join(agencyDir, 'receipts.jsonl')).filter((r) => r.event === 'resident_tick');

  assert.equal(scratch.length, 0, 'a no-op tick must not write a resident_tick scratch note');
  assert.equal(receipts.length, 0, 'a no-op tick must not write a resident_tick receipt');

  // The cheap next-action write is untouched -- it still records what the
  // resident intends to do next, just without the heavier audit trail.
  assert.equal(tick.nextAction.kind, 'advance_one_step');
  assert.equal(tick.state.nextAction.kind, 'advance_one_step');
});

test('a tick that does act (editor vetoes and requires consequence) still records scratch and receipt', async () => {
  const dir = brainDir();
  const kernel = makeKernel(dir);

  const intake = await kernel.intake({
    source: 'newsletter',
    kind: 'newsletter_draft',
    summary: 'This newsletter repeats that Home23 becomes real by noticing feedback loops.',
    evidence: [{ type: 'draft', ref: 'from-the-inside-thermal' }],
    desiredChangedFuture: 'Newsletter must cite lived system change or be rejected.',
  });

  const tick = await kernel.tick({ reason: 'test-real-tick', now: '2026-07-15T12:05:00.000Z' });

  assert.equal(tick.selected.pursuitId, intake.pursuit.id);
  assert.equal(tick.editor.verdict, 'veto');
  assert.equal(tick.editor.action, 'require_consequence');

  const agencyDir = join(dir, 'agency');
  const scratch = readJsonl(join(agencyDir, 'scratch.jsonl'));
  const receipts = readJsonl(join(agencyDir, 'receipts.jsonl'));
  const consequences = readJsonl(join(agencyDir, 'consequences.jsonl'));

  assert.equal(scratch.some((row) => row.kind === 'resident_tick' && row.pursuitId === intake.pursuit.id), true);
  assert.equal(receipts.some((row) => row.event === 'resident_tick' && row.pursuitId === intake.pursuit.id), true);
  assert.equal(consequences.some((row) => row.changeType === 'explicit_no_change' && row.pursuitId === intake.pursuit.id), true);
});
