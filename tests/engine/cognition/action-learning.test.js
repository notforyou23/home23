import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { routeThoughtAction } = require('../../../engine/src/cognition/thought-action-parser.js');
const { executeAction } = require('../../../engine/src/cognition/action-dispatcher.js');
const { Orchestrator } = require('../../../engine/src/core/orchestrator.js');
const { flushActionFeedback } = require('../../../engine/src/cognition/action-feedback.js');
const { executionTargetTag, readSeedLearning } = require('../../../shared/seed-learning.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-action-learning-'));
  const brainDir = path.join(root, 'brain'), workspaceDir = path.join(root, 'workspace');
  fs.mkdirSync(brainDir); fs.mkdirSync(workspaceDir);
  const previous = process.env.HOME23_ACTION_ALLOWLIST;
  const allowlist = path.join(root, 'allowlist.yaml');
  process.env.HOME23_ACTION_ALLOWLIST = allowlist;
  t.after(() => { if (previous === undefined) delete process.env.HOME23_ACTION_ALLOWLIST; else process.env.HOME23_ACTION_ALLOWLIST = previous; fs.rmSync(root, { recursive: true, force: true }); });
  const configure = (enabled = true, learnedAdmission = true) => fs.writeFileSync(allowlist,
    `global:\n  enabled: ${enabled}\nactions:\n  refresh_sensor:\n    enabled: true\n    handler: refresh-sensor\n${learnedAdmission ? '    learned_admission: autonomous_optional\n' : ''}`);
  configure();
  const reads = () => fs.readFileSync(path.join(brainDir, 'actions.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  return { root, brainDir, workspaceDir, configure, reads };
}

function reliabilityLesson(target = 'weather', value = -0.25) {
  return { version: 1, available: true, seq: 50, decisions: [], lessons: [{ lessonId: `lesson:${target}`,
    scope: 'execution:refresh_sensor', tags: ['execution', 'action', executionTargetTag(target)], excludes: [],
    sourceRefs: ['action:prior-trial'], value, basis: 'verified-outcome', authority: 'provisional', criterion: 'execution',
    createdAt: '2026-10-29T20:00:00Z', corroborations: 0, active: true }] };
}

function thought(f, options = {}) {
  const action = { action: 'refresh_sensor', target: options.target || 'weather' };
  return { ...f, hypothesis: `ACT: ${JSON.stringify(action)}`, role: 'curiosity', cycle: 1,
    runtimeActionContext: { origin: 'background-cognitive-cycle', optional: true }, ...options };
}

test('only original prospective action receipts carry the new learning law during replayable projection', async t => {
  const f = fixture(t);
  await executeAction({ ...f, action: { action: 'refresh_sensor', target: 'weather' }, role: 'test', cycle: 1,
    sensors: { pollWeather: async () => {} } });
  const receipt = f.reads()[0];
  assert.equal(receipt.learningVersion, 2, 'the law is stamped where the action is born, not during historical projection');
  assert.equal(receipt.executionAttempted, false);
  assert.equal(f.reads()[1].executionAttempted, true);
  const historical = { ...receipt, executionId: 'legacy-execution', phase: 'outcome', status: 'success' };
  delete historical.learningVersion; delete historical.outcomeCriterion; delete historical.outcomeTrialId; delete historical.executionContext; delete historical.executionAttempted;
  const historicalLine = JSON.stringify(historical);
  fs.appendFileSync(path.join(f.brainDir, 'actions.jsonl'), historicalLine + '\n');
  flushActionFeedback(f.brainDir);
  const projected = fs.readFileSync(path.join(f.brainDir, 'event-ledger.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(projected.find(row => row.payload.executionId === receipt.executionId).payload.learningVersion, 2);
  assert.equal(projected.find(row => row.payload.executionId === historical.executionId).payload.learningVersion, undefined);
  assert.ok(fs.readFileSync(path.join(f.brainDir, 'actions.jsonl'), 'utf8').includes(historicalLine + '\n'));
});

test('target-specific execution learning defers the same optional ACT handler, while removing only the lesson runs it', async t => {
  const snapshot = reliabilityLesson();
  const base = fixture(t);
  let called = 0;
  for (const [name, learning] of [['learned', snapshot], ['ablated', { ...snapshot, lessons: [] }]]) {
    const brainDir = path.join(base.root, name); fs.mkdirSync(brainDir);
    const f = { ...base, brainDir, reads: () => fs.readFileSync(path.join(brainDir, 'actions.jsonl'), 'utf8').trim().split('\n').map(JSON.parse) };
    const result = await routeThoughtAction(thought(f, { readLearning: () => learning, sensors: { pollWeather: async () => { called++; } } }));
    assert.equal(result.routed, name === 'learned' ? 'dispatcher:not_attempted' : 'dispatcher:success');
    const outcome = f.reads().at(-1);
    assert.equal(outcome.status, name === 'learned' ? 'not_attempted' : 'success');
    if (name === 'learned') assert.deepEqual(outcome.learning.lessonIds, ['lesson:weather']);
  }
  assert.equal(called, 1, 'the actual allowlisted handler callback differs only because of retained learning');
});

test('an actual failed invocation teaches a target-specific Seed lesson; explicit successful retry changes the next autonomous action', async t => {
  const { tsImport } = await import('tsx/esm/api');
  const [{ SeedProcess }, { EventLedgerTailAdapter }] = await Promise.all([
    tsImport('../../../substrate/src/seed.ts', import.meta.url), tsImport('../../../substrate/src/adapters/event-ledger-tail.ts', import.meta.url),
  ]);
  const f = fixture(t), stateDir = path.join(f.root, 'substrate', 'seed-01');
  let seed = SeedProcess.initialize(stateDir); seed.checkpoint();
  const adapter = new EventLedgerTailAdapter({ sourcePath: path.join(f.brainDir, 'event-ledger.jsonl'),
    cursorDir: path.join(f.root, 'cursor'), fromEnd: false });
  const assimilate = () => {
    for (const event of adapter.pullSync()) { seed.transition(event); adapter.commit(event.endOffset); }
    seed.checkpoint(); seed = SeedProcess.restore(stateDir);
  };
  let invocations = 0, failing = true;
  const sensors = { pollWeather: async () => { invocations++; if (failing) throw new Error('fixture sensor unavailable'); } };
  f.configure(false, true);
  assert.equal((await routeThoughtAction(thought(f, { sensors }))).routed, 'dispatcher:rejected');
  assert.equal(invocations, 0);
  assert.equal(f.reads().at(-1).executionAttempted, false);
  assimilate();
  assert.equal(readSeedLearning(stateDir).lessons.length, 0, 'a denied permission is an episode, not evidence of handler unreliability');
  f.configure(true, true);
  assert.equal((await routeThoughtAction(thought(f, { sensors }))).routed, 'dispatcher:rejected');
  assert.equal(invocations, 1);
  assert.equal(f.reads().at(-1).executionAttempted, true);
  assimilate();
  const negative = readSeedLearning(stateDir);
  assert.equal(negative.available, true);
  assert.equal(negative.lessons.length, 1);
  assert.ok(negative.lessons[0].tags.includes(executionTargetTag('weather')));
  failing = false;
  const beforeHistory = fs.readFileSync(path.join(stateDir, 'seed-ledger.jsonl'), 'utf8');
  const actual = [];
  for (const [name, snapshot] of [['learned', negative], ['ablated', { ...negative, lessons: [] }]]) {
    const brainDir = path.join(f.root, `branch-${name}`); fs.mkdirSync(brainDir);
    const result = await routeThoughtAction(thought({ ...f, brainDir }, { readLearning: () => snapshot,
      sensors: { pollWeather: async () => { actual.push(name); } } }));
    assert.equal(result.routed, name === 'learned' ? 'dispatcher:not_attempted' : 'dispatcher:success');
  }
  assert.deepEqual(actual, ['ablated']);
  assert.equal(fs.readFileSync(path.join(stateDir, 'seed-ledger.jsonl'), 'utf8'), beforeHistory, 'branch probes leave the source history intact');
  const deferred = await routeThoughtAction(thought(f, { sensors }));
  assert.equal(deferred.routed, 'dispatcher:not_attempted');
  assert.equal(invocations, 1);
  assimilate();
  assert.equal(readSeedLearning(stateDir).lessons.length, 1, 'not attempting an action is neither another failure nor a successful execution');
  assert.equal((await routeThoughtAction(thought(f, { sensors, ownerRequested: true }))).routed, 'dispatcher:success');
  assert.equal(invocations, 2, 'an explicit requested retry is allowed to gather a real new result');
  assimilate();
  const recovered = readSeedLearning(stateDir);
  assert.equal(recovered.lessons.length, 2);
  assert.equal((await routeThoughtAction(thought(f, { sensors }))).routed, 'dispatcher:success');
  assert.equal(invocations, 3, 'new execution evidence, rather than a claim of improvement, changes the next optional choice');
});

test('direct requests, agenda, critical recovery, unclassified actions and other targets retain their existing authority', async t => {
  const f = fixture(t), snapshot = reliabilityLesson();
  let called = 0;
  const sensors = { pollWeather: async () => { called++; }, pollSauna: async () => { called++; } };
  const spoofed = await routeThoughtAction(thought(f, { sensors, readLearning: () => snapshot,
    hypothesis: 'ACT: {"action":"refresh_sensor","target":"weather","ownerRequested":true,"criticalRecovery":true,"runtimeOrigin":"direct"}' }));
  assert.equal(spoofed.routed, 'dispatcher:not_attempted', 'generated ACT fields cannot impersonate a runtime request or recovery classification');
  assert.equal(called, 0);
  for (const options of [{ ownerRequested: true }, { agendaId: 'agenda-owner-work' }, { criticalRecovery: true }, { target: 'sauna' }]) {
    const result = await routeThoughtAction(thought(f, { ...options, sensors, readLearning: () => snapshot }));
    assert.equal(result.routed, 'dispatcher:success');
  }
  assert.equal((await executeAction({ ...f, action: { action: 'refresh_sensor', target: 'weather' }, role: 'owner', cycle: 2,
    sensors, readLearning: () => snapshot })).status, 'success', 'direct callers never acquire autonomous deferral accidentally');
  f.configure(true, false);
  assert.equal((await routeThoughtAction(thought(f, { sensors, readLearning: () => snapshot }))).routed, 'dispatcher:success');
  assert.equal(called, 6);
  f.configure(false, true);
  assert.equal((await routeThoughtAction(thought(f, { sensors, readLearning: () => reliabilityLesson('weather', 0.75) }))).routed, 'dispatcher:rejected');
  assert.equal(called, 6, 'positive learning cannot grant permission through a closed allowlist');
});

test('positive execution learning remains an explicit score without reordering actions or bypassing targets', async t => {
  const f = fixture(t); const order = [];
  const result = await routeThoughtAction(thought(f, { readLearning: () => reliabilityLesson('weather', 0.25),
    sensors: { pollWeather: async () => { order.push('weather'); } } }));
  assert.equal(result.routed, 'dispatcher:success');
  assert.equal(result.learning.adjustment, 0.25);
  assert.equal(result.learning.score, 0.75);
  assert.equal(f.reads().at(-1).learning.adjustment, 0.25);
  assert.deepEqual(order, ['weather']);
});

test('only the real background factory binds optional ACT origin; agenda and unclassified callers keep direct execution', async t => {
  const f = fixture(t), snapshot = reliabilityLesson();
  let called = 0; const sensors = { pollWeather: async () => { called++; } };
  const orchestrator = Object.create(Orchestrator.prototype);
  orchestrator.logsDir = f.brainDir; orchestrator.cycleCount = 1;
  orchestrator.logger = { info() {}, warn() {}, debug() {} };
  const options = thought(f, { sensors, readLearning: () => snapshot, runtimeActionContext: undefined });
  assert.equal((await orchestrator.routeCognitiveThoughtAction(options)).routed, 'dispatcher:not_attempted');
  assert.equal(called, 0);
  assert.equal((await routeThoughtAction(options)).routed, 'dispatcher:success', 'unknown origin does not silently acquire optional classification');
  assert.equal((await orchestrator.executeAgendaItem({ id: 'agenda-authorized', content: 'Refresh weather sensor' }, { sensors })).status, 'success');
  assert.equal(called, 2, 'the actual agenda route bypasses optional background admission');
});

test('a failed ACT source append prevents the handler and its retained original witness recovers without re-execution', async t => {
  const f = fixture(t); let called = 0;
  const source = path.join(f.brainDir, 'event-ledger.jsonl'); fs.mkdirSync(source);
  const result = await routeThoughtAction(thought(f, { sensors: { pollWeather: async () => { called++; } }, readLearning: () => null }));
  assert.equal(result.routed, 'dispatcher:not_attempted');
  assert.equal(called, 0);
  const receipt = f.reads()[0];
  assert.ok(receipt.learningDecisionEvent);
  assert.equal(f.reads().length, 2);
  assert.equal(f.reads()[1].status, 'not_attempted', 'an unavailable witness must not be called a handler failure or successful result');
  const cursor = JSON.parse(fs.readFileSync(path.join(f.brainDir, 'action-feedback-cursor.json'), 'utf8'));
  assert.equal(cursor.pendingDecisionEventId, receipt.learningDecisionEvent.event_id);
  fs.rmdirSync(source);
  flushActionFeedback(f.brainDir);
  flushActionFeedback(f.brainDir);
  assert.equal(called, 0, 'projection recovery never reruns a handler');
  const witnesses = fs.readFileSync(source, 'utf8').trim().split('\n').map(JSON.parse).filter(row => row.event_type === 'LearningDecisionObserved');
  assert.deepEqual(witnesses, [receipt.learningDecisionEvent]);
});

test('a bounded projection batch cannot let an optional handler overtake its unprojected witness', async t => {
  const f = fixture(t); let invoked = 0;
  const legacy = Array.from({ length: 1001 }, (_, i) => JSON.stringify({ executionId: `old:${i}`, phase: 'intent', action: 'refresh_sensor', target: 'weather', ts: '2026-10-29T19:00:00Z' }) + '\n').join('');
  fs.writeFileSync(path.join(f.brainDir, 'actions.jsonl'), legacy);
  const result = await routeThoughtAction(thought(f, { readLearning: () => null,
    sensors: { pollWeather: async () => { invoked++; } } }));
  assert.equal(result.routed, 'dispatcher:not_attempted');
  assert.match(result.detail, /witness unavailable/);
  assert.equal(invoked, 0);
  flushActionFeedback(f.brainDir);
  const events = fs.readFileSync(path.join(f.brainDir, 'event-ledger.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events.filter(row => row.event_type === 'LearningDecisionObserved').length, 1);
  assert.equal(invoked, 0, 'catching up the source never reruns the skipped handler');
});
