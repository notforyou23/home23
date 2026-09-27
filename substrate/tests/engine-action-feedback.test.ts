import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventLedgerTailAdapter } from '../src/adapters/event-ledger-tail.js';
import { SeedProcess } from '../src/seed.js';

const require = createRequire(import.meta.url);
const { executeAction } = require('../../engine/src/cognition/action-dispatcher.js');
const { flushActionFeedback } = require('../../engine/src/cognition/action-feedback.js');
const { EventLedger } = require('../../engine/src/core/event-ledger.js');
const { Orchestrator } = require('../../engine/src/core/orchestrator.js');
const { MotorCortex } = require('../../engine/src/cognition/motor-cortex.js');
const { AgendaStore } = require('../../engine/src/cognition/agenda-store.js');
const { LiveProblemStore } = require('../../engine/src/live-problems/store.js');
const { isExternalEvidenceRef } = require('../../shared/prediction-feedback.cjs');
const logger = { info() {}, warn() {}, error() {} };

function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'home23-action-feedback-'));
  const brainDir = join(dir, 'brain');
  const workspaceDir = join(dir, 'workspace');
  mkdirSync(brainDir); mkdirSync(workspaceDir);
  const allowlist = join(dir, 'allowlist.yaml');
  const previous = process.env['HOME23_ACTION_ALLOWLIST'];
  process.env['HOME23_ACTION_ALLOWLIST'] = allowlist;
  t.after(() => {
    if (previous === undefined) delete process.env['HOME23_ACTION_ALLOWLIST'];
    else process.env['HOME23_ACTION_ALLOWLIST'] = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  const configure = (dryRun = false) => writeFileSync(allowlist,
    `global:\n  enabled: true\nactions:\n  write_note:\n    enabled: true\n    handler: write-note\n    dry_run: ${dryRun}\n`);
  configure();
  const adapter = new EventLedgerTailAdapter({
    sourcePath: join(brainDir, 'event-ledger.jsonl'), cursorDir: join(dir, 'cursor'), fromEnd: false,
  });
  return { dir, brainDir, workspaceDir, configure, adapter };
}

test('real action writes a note, then its receipted result enters Seed with execution and verification distinct', async t => {
  const f = fixture(t);
  const result = await executeAction({
    ...f, action: { action: 'write_note', target: 'inquiry.md', body: 'An unresolved connection between rhythm and memory.' },
    role: 'curiosity', cycle: 1, agendaId: 'agenda-inquiry', logger,
  });
  assert.equal(result.status, 'success');
  assert.equal(readFileSync(join(f.workspaceDir, 'notes/inquiry.md'), 'utf8'), 'An unresolved connection between rhythm and memory.\n');
  const events = f.adapter.pullSync();
  assert.equal(events.length, 2);
  assert.equal(events[0]?.category, 'observation');
  const outcome = events[1]!;
  assert.equal(outcome.category, 'consequence');
  assert.equal(outcome.payload['status'], 'completed');
  assert.equal(outcome.payload['declaredStatus'], 'success');
  assert.equal(outcome.payload['verificationStatus'], 'unknown');
  assert.equal(outcome.payload['taskOutcomeVerified'], false);
  assert.equal(outcome.payload['agendaId'], 'agenda-inquiry');
  assert.match(String(outcome.payload['head']), /task outcome unverified.*wrote notes\/inquiry.md/);
  const receiptLine = readFileSync(join(f.brainDir, 'actions.jsonl'), 'utf8').trim().split('\n')[1]!;
  assert.deepEqual(outcome.payload['evidenceRefs'], [`actions.jsonl#sha256=${createHash('sha256').update(receiptLine).digest('hex')}`]);
  const seed = SeedProcess.initialize(join(f.dir, 'seed'));
  for (const event of events) { seed.transition(event); f.adapter.commit(event.endOffset); }
  const refs = seed.getState().cellIds.flatMap(id => seed.getCell(id)!.realityRefs);
  assert.ok(refs.some(ref => ref.refId === outcome.eventId && ref.sourceRef === outcome.sourceRef && /wrote notes\/inquiry.md/.test(ref.head || '')));
  const outcomeRef = refs.find(ref => ref.refId === outcome.eventId)!;
  assert.equal(outcomeRef.executionOutcome?.receiptEventId, outcome.eventId);
  assert.deepEqual(outcomeRef.executionOutcome?.evidenceRefs, outcome.payload['evidenceRefs']);
  assert.equal(outcomeRef.executionOutcome?.verificationStatus, 'unknown');
  assert.equal(isExternalEvidenceRef(outcomeRef), true);
  assert.equal(isExternalEvidenceRef({ ...outcomeRef, executionOutcome: undefined }), false);
  assert.deepEqual(f.adapter.pullSync(), [], 'receipted source cursor prevents repeat admission');
});

test('rejected and simulated actions feed different honest results; neither can masquerade as completion', async t => {
  const f = fixture(t);
  const rejected = await executeAction({ ...f, action: { action: 'write_note', target: '../escape.md', body: 'must not write' }, role: 'test', cycle: 1 });
  assert.equal(rejected.status, 'rejected');
  f.configure(true);
  const simulated = await executeAction({ ...f, action: { action: 'write_note', target: 'dry.md', body: 'must not write' }, role: 'test', cycle: 2 });
  assert.equal(simulated.status, 'dry_run');
  assert.equal(existsSync(join(f.workspaceDir, 'notes/dry.md')), false);
  const outcomes = f.adapter.pullSync().filter(event => event.payload['event_type'] === 'ExecutionOutcomeObserved');
  assert.deepEqual(outcomes.map(event => [event.category, event.payload['status'], event.payload['taskOutcomeVerified']]), [
    ['correction', 'rejected', false], ['interpretation', 'simulated', false],
  ]);
  assert.match(String(outcomes[0]?.payload['head']), /invalid or missing note name/);
  assert.match(String(outcomes[1]?.payload['head']), /handler not invoked/);
});

test('production thinking factory and agenda router carry queued vs dispatched into the Seed mapper', async t => {
  const f = fixture(t);
  const orchestrator = Object.create(Orchestrator.prototype);
  orchestrator.logger = logger;
  orchestrator.logsDir = f.brainDir;
  orchestrator.cycleCount = 1;
  const agendaStore = new AgendaStore({ brainDir: f.brainDir, logger });
  const store = new LiveProblemStore({ brainDir: f.brainDir, logger });
  let dispatch = false;
  orchestrator.liveProblems = {
    store, processNow: async (id: string) => ({ ...store.get(id), ...(dispatch ? { dispatchedTurnId: 'turn-real-accepted' } : {}) }),
  };
  const machine = orchestrator.createThinkingMachine({
    unifiedClient: {}, memory: {}, discoveryEngine: { pop: () => [] }, logger,
    config: {
      eventLedger: new EventLedger(f.brainDir), agendaStore,
      motorCortex: new MotorCortex({
        logger, agendaStore,
        canAct: (item: unknown) => orchestrator.isBoundedOperationalAgendaItem(item),
        executeAgendaItem: (item: unknown, opts: unknown) => orchestrator.executeAgendaItem(item, opts),
      }),
    },
  });
  machine.deepDive = { think: async () => ({ text: 'This is an operational question grounded in a concrete missing file update.', referencedNodes: [], usage: {} }) };
  machine.pgsAdapter = { getStats: () => ({}), connect: async () => ({ available: false, perspectives: [], candidateEdges: [], connectionNotes: [], usage: {} }) };
  machine.critique = { evaluate: async () => ({
    verdict: 'keep', confidence: 0.9, gaps: [], rationale: 'bounded inquiry',
    agendaCandidates: [{ content: dispatch ? 'Check localhost:50523 status endpoint for a missing HTTP response.' : 'Investigate why RECENT.md has not regenerated in 9 days.', kind: 'question', topicTags: ['ops'] }],
  }) };
  await machine._runCycle({ signal: 'ops-anomaly', score: 0.9, rationale: 'missing update' });
  dispatch = true;
  await machine._runCycle({ signal: 'ops-anomaly', score: 0.9, rationale: 'different missing update' });
  const routed = f.adapter.pullSync().filter(event => event.payload['event_type'] === 'MotorActionRouted');
  assert.deepEqual(routed.map(event => [event.category, event.payload['status'], event.payload['taskOutcomeVerified']]), [
    ['observation', 'queued', false], ['observation', 'dispatched', false],
  ]);
  assert.match(String(routed[0]?.payload['head']), /no dispatch confirmed/);
  assert.match(String(routed[1]?.payload['head']), /execution result pending/);
  assert.equal(store.all().every((problem: { handoff: { status: string } }) => problem.handoff.status === 'pending'), true);
});

test('malformed execution envelopes cannot inherit consequence from their event type', t => {
  const f = fixture(t);
  new EventLedger(f.brainDir).record('ExecutionOutcomeObserved', 'test', { status: 'completed', head: 'untyped claim of success' });
  assert.equal(f.adapter.pullSync()[0]?.category, 'observation');
});

test('event ledger failure leaves action outcome recoverable; replay never re-executes the handler', async t => {
  const f = fixture(t);
  const ledgerPath = join(f.brainDir, 'event-ledger.jsonl');
  mkdirSync(ledgerPath); // force both intent and outcome projection appends to fail
  const result = await executeAction({ ...f, action: { action: 'write_note', target: 'only-once.md', body: 'Executed exactly once.' }, role: 'test', cycle: 1 });
  assert.equal(result.status, 'success');
  assert.equal(readFileSync(join(f.workspaceDir, 'notes/only-once.md'), 'utf8'), 'Executed exactly once.\n');
  const receipts = readFileSync(join(f.brainDir, 'actions.jsonl'), 'utf8');
  assert.equal(receipts.trim().split('\n').length, 2);
  rmSync(ledgerPath, { recursive: true });
  // Production heartbeat/startup recovery entrypoint, not dispatcher re-entry.
  const restored = Object.create(Orchestrator.prototype);
  restored.logsDir = f.brainDir; restored.logger = logger;
  await restored.retryCognitionFeedback();
  const events = f.adapter.pullSync();
  assert.deepEqual(events.map(event => event.payload['status']), ['intent', 'completed']);
  assert.equal(readFileSync(join(f.brainDir, 'actions.jsonl'), 'utf8'), receipts);
  assert.equal(flushActionFeedback(f.brainDir).projected, 0);
  assert.equal(readFileSync(ledgerPath, 'utf8').trim().split('\n').length, 2);
});
