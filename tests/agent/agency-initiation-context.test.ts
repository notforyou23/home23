import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { buildAgencyContextSection } from '../../src/agent/context-assembly.js';

const require = createRequire(import.meta.url);
const { ResidentInitiationDriver, readResidentInitiationContext } = require('../../engine/src/agency/resident-initiation.js');

function fixture(t: { after(fn: () => void): void }, baseline = false, state = 'running') {
  const root = mkdtempSync(join(tmpdir(), 'agency-initiation-context-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const brainDir = join(root, 'instances', 'jerry', 'brain');
  const agencyDir = join(brainDir, 'agency');
  mkdirSync(agencyDir, { recursive: true });
  const pursuit = {
    id: 'ap_owner_search', status: 'active', kind: 'resident_initiative', purpose: 'exploration', scope: 'private_research',
    authorityLevel: 'L1', title: 'Owner family search',
    nextMove: 'Inspect the supplied owner family search records and save a sourced private finding.',
    stopCondition: 'A sourced finding or a specific unanswered question is recorded.', evidence: ['memory:family-search'],
  };
  const rows = baseline ? [pursuit] : [];
  const kernel = { agentName: 'jerry', config: { enabled: true, mode: 'live' },
    authority: { evaluate: () => ({ allowed: true, level: 'L1' }) },
    editor: { evaluate: () => ({ verdict: 'allow', action: 'advance_one_step' }) },
    store: { listPursuits: () => rows, getPursuit: () => pursuit, appendReceipt: () => {} } };
  const driver = new ResidentInitiationDriver({ kernel, brainDir, isPrimaryResident: () => true,
    now: () => 1_000_000, sendInitiation: async (request: { initiationId: string }) => ({ initiationId: request.initiationId, state, workId: 'work-original' }) });
  driver.initialize();
  if (!baseline) rows.push(pursuit);
  const statePath = join(agencyDir, 'resident-initiation.json');
  const persistPlanning = () => {
    writeFileSync(join(agencyDir, 'pursuits.jsonl'), JSON.stringify({ type: 'created', pursuit }) + '\n');
    writeFileSync(join(agencyDir, 'state.json'), JSON.stringify({ schema: 'home23.agency.state.v1', agent: 'jerry', mode: 'live',
      attention: { currentPursuitId: pursuit.id, queueDepth: 1, activePursuits: 1 },
      nextAction: { kind: 'advance_one_step', pursuitId: pursuit.id, reason: 'An old planning decision.' } }));
  };
  persistPlanning();
  return { root, brainDir, agencyDir, pursuit, driver, statePath, persistPlanning };
}

for (const state of ['queued', 'leased', 'running', 'cancelling']) test(`context preserves an actual ${state} admission separately from its stored plan`, async t => {
  const f = fixture(t, false, state);
  await f.driver.consume({ selected: { pursuitId: f.pursuit.id } });
  const before = readFileSync(f.statePath, 'utf8');
  const section = buildAgencyContextSection(f.root, 'jerry');
  assert.match(section, new RegExp(`execution=${state}`));
  assert.match(section, /Work=work-original/);
  assert.match(section, /planning record, not an execution receipt/);
  assert.doesNotMatch(section, /initiative=dormant/);
  assert.equal(readFileSync(f.statePath, 'utf8'), before, 'projection does not mutate execution state');
});

for (const state of ['succeeded', 'failed', 'cancelled', 'withdrawn']) test(`context does not revive a ${state} initiative through stored focus or advance_one_step`, async t => {
  const f = fixture(t, false, state === 'withdrawn' ? 'cancelled' : state);
  await f.driver.consume({ selected: { pursuitId: f.pursuit.id } });
  if (state === 'withdrawn') {
    const saved = JSON.parse(readFileSync(f.statePath, 'utf8'));
    saved.admissions[Object.keys(saved.admissions)[0]].state = 'withdrawn';
    writeFileSync(f.statePath, JSON.stringify(saved));
  }
  // The planner can retain its generic move after execution settled. The
  // canonical responsibility identity still binds the original admission.
  f.pursuit.nextMove = 'advance_one_step';
  f.persistPlanning();
  const originals = [f.statePath, join(f.agencyDir, 'pursuits.jsonl'), join(f.agencyDir, 'state.json')]
    .map(path => [path, readFileSync(path, 'utf8')] as const);
  const section = buildAgencyContextSection(f.root, 'jerry');
  assert.match(section, /Current pursuit: none executing from stored focus ap_owner_search \(settled\)/);
  assert.match(section, /Next autonomous action: none; stored action for ap_owner_search is dormant \(settled\)/);
  assert.match(section, /Dormant initiatives \(not currently executing\)/);
  assert.match(section, new RegExp(`execution=${state}`));
  assert.match(section, /stored pursuit retained, not a completion claim/);
  assert.doesNotMatch(section, /next_move=advance_one_step/);
  if (state === 'succeeded') assert.match(section, /executor finished; objective verification is not established/);
  if (state === 'failed') assert.match(section, /executor settled; objective verification is not established/);
  for (const [path, before] of originals) assert.equal(readFileSync(path, 'utf8'), before);
});

test('an unchanged forward baseline is dormant without claiming that work ran or its objective completed', t => {
  const f = fixture(t, true);
  const projection = readResidentInitiationContext(f.statePath, 'jerry').project(f.pursuit);
  assert.equal(projection.dormant, f.driver.isDormant(f.pursuit));
  assert.equal(projection.dormancyReason, 'baseline');
  const section = buildAgencyContextSection(f.root, 'jerry');
  assert.match(section, /initiative=dormant \(baseline\)/);
  assert.match(section, /execution=not_admitted \(no matching resident initiation admission\)/);
  assert.doesNotMatch(section, /execution=succeeded/);
});

test('genuinely new sourced evidence does not inherit a settled older responsibility', async t => {
  const f = fixture(t, false, 'succeeded');
  await f.driver.consume({ selected: { pursuitId: f.pursuit.id } });
  f.pursuit.evidence = ['memory:new-family-record'];
  f.persistPlanning();
  assert.equal(f.driver.isDormant(f.pursuit), false);
  const section = buildAgencyContextSection(f.root, 'jerry');
  assert.match(section, /execution=not_admitted/);
  assert.doesNotMatch(section, /initiative=dormant/);
  assert.doesNotMatch(section, /execution=succeeded/);
});

for (const availability of ['missing', 'unreadable', 'invalid', 'wrong_resident']) test(`context treats ${availability} initiation state as unknown, preserving stored plans`, t => {
  const f = fixture(t);
  if (availability === 'missing') unlinkSync(f.statePath);
  if (availability === 'unreadable') writeFileSync(f.statePath, '{torn');
  if (availability === 'invalid') writeFileSync(f.statePath, JSON.stringify({ schema: 'home23.resident-initiation.v1', agentName: 'jerry', admissions: {} }));
  if (availability === 'wrong_resident') {
    const saved = JSON.parse(readFileSync(f.statePath, 'utf8')); saved.agentName = 'forrest';
    writeFileSync(f.statePath, JSON.stringify(saved));
  }
  const section = buildAgencyContextSection(f.root, 'jerry');
  assert.match(section, /Owner family search/);
  assert.match(section, /execution=unknown \(resident initiation state (missing|unreadable)\)/);
  assert.match(section, /A plan is not evidence of running work/);
  assert.doesNotMatch(section, /initiative=dormant/);
  assert.doesNotMatch(section, /execution=succeeded/);
});
