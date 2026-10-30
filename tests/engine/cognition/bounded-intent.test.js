import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Critique } = require('../../../engine/src/cognition/critique.js');
const { AgendaStore } = require('../../../engine/src/cognition/agenda-store.js');
const { MotorCortex } = require('../../../engine/src/cognition/motor-cortex.js');
const { Orchestrator } = require('../../../engine/src/core/orchestrator.js');
const { LiveProblemStore } = require('../../../engine/src/live-problems/store.js');
const { executionTargetTag } = require('../../../shared/seed-learning.cjs');
const { readInspectionTerminal, validInspectionCompletion } = require('../../../engine/src/cognition/agenda-learning.js');
const logger = { info() {}, warn() {}, error() {} };
const refs = ['conversation:owner-briefing', 'node:daily-briefing', 'runtime:process-snapshot'];

function candidate(overrides = {}) {
  return {
    content: 'Verify the local fishing briefing runs every day, including Saturday and Sunday.',
    kind: 'idea', topicTags: ['local-fishing'],
    boundedIntent: {
      schema: 'home23.bounded-agenda-intent.v1', operation: 'verify',
      targetRef: 'node:daily-briefing',
      question: 'Does the existing morning briefing run on all seven days?',
      expectedEvidence: 'The actual enabled schedule and next-run metadata for the existing briefing.',
      stopCondition: 'Report the observed schedule or unavailable evidence; make no changes.',
      evidenceRefs: refs,
    },
    ...overrides,
  };
}

function parsed(item, evidenceRefs = refs) {
  const critique = new Critique({ unifiedClient: {}, logger });
  return critique._parseVerdict(JSON.stringify({ verdict: 'keep', confidence: 0.9,
    rationale: 'A bounded check of the owner\'s current request.', agendaCandidates: [item] }), {},
  { outreachEvidenceRefs: evidenceRefs });
}

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-bounded-agenda-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, agendaStore: new AgendaStore({ brainDir: dir, logger }),
    problemStore: new LiveProblemStore({ brainDir: dir, logger }) };
}

test('critic retains a grounded bounded verification about the owner\'s briefing without machine keywords', () => {
  const expected = candidate();
  const verdict = parsed(expected);
  assert.equal(verdict.agendaCandidates.length, 1);
  assert.deepEqual(verdict.agendaCandidates[0].boundedIntent, expected.boundedIntent);
});

test('a same-scope typed agenda merge preserves its refreshed evidence through append-only replay', t => {
  const f = fixture(t), firstRefs = ['node:daily-briefing', 'conversation:first'], nextRefs = ['node:daily-briefing', 'conversation:next'];
  const first = candidate(); first.boundedIntent = { ...first.boundedIntent, evidenceRefs: firstRefs };
  const original = f.agendaStore.add(parsed(first, firstRefs).agendaCandidates[0]);
  const next = candidate(); next.boundedIntent = { ...next.boundedIntent, evidenceRefs: nextRefs };
  const merged = f.agendaStore.add(parsed(next, nextRefs).agendaCandidates[0]);
  assert.equal(merged.id, original.id); assert.deepEqual(merged.boundedIntent.evidenceRefs, nextRefs);
  const restored = new AgendaStore({ brainDir: f.dir, logger }).get(original.id);
  assert.deepEqual(restored.boundedIntent, merged.boundedIntent);
  assert.deepEqual(restored.intentEvidenceRefs, nextRefs);
});

test('a structured inspection passes critic, motor, persistence and the actual diagnostic handoff boundary', async t => {
  const f = fixture(t);
  const item = candidate({ content: 'Capture a complete bounded CPU/process snapshot and report the observed evidence.' });
  item.boundedIntent = { ...item.boundedIntent, operation: 'inspect', targetRef: 'runtime:process-snapshot',
    question: 'Which running processes account for current CPU and memory use?',
    expectedEvidence: 'A timestamped bounded process snapshot; no configuration changes.' };
  const verdict = parsed(item);
  assert.equal(verdict.agendaCandidates.length, 1);
  const orchestrator = Object.create(Orchestrator.prototype);
  orchestrator.logger = logger;
  orchestrator.logsDir = f.dir;
  orchestrator.liveProblems = { store: f.problemStore,
    processNow: async id => ({ ...f.problemStore.get(id), dispatchedTurnId: 'actual-inspection-turn' }) };
  const motor = new MotorCortex({ logger, agendaStore: f.agendaStore,
    canAct: rec => orchestrator.isBoundedOperationalAgendaItem(rec),
    executeAgendaItem: (rec, opts) => orchestrator.executeAgendaItem(rec, opts) });
  const plan = motor.compileMotorIntents({ finalVerdict: verdict, evidenceRefs: refs });
  assert.equal(plan.accepted.length, 1);
  const record = f.agendaStore.add({ ...plan.accepted[0], intentEvidenceRefs: refs,
    sourceSignal: 'novelty', sourceCycleSessionId: 'bounded-inspection-cycle' });
  assert.ok(record, 'the agenda store must not apply a different machine-keyword policy');
  assert.deepEqual(record.boundedIntent, item.boundedIntent);
  const restored = new AgendaStore({ brainDir: f.dir, logger });
  assert.deepEqual(restored.get(record.id).boundedIntent, item.boundedIntent);
  const routed = await motor.actOnAgendaItem(record, { cycleSessionId: 'bounded-inspection-cycle' });
  assert.equal(routed.status, 'dispatched');
  const problem = f.problemStore.get(routed.action.problemId);
  assert.deepEqual(problem.inspection, item.boundedIntent);
  assert.deepEqual(problem.inspectionEvidenceRefs, refs);
  assert.equal(problem.handoff.status, 'pending', 'dispatch is not a completed inspection');
});

test('only the runtime optional inspection path consumes target-specific execution learning before dispatch', async t => {
  const f = fixture(t);
  const parsedItem = parsed(candidate()).agendaCandidates[0];
  assert.ok(parsedItem);
  const target = 'verify:node:daily-briefing';
  const snapshot = { available: true, version: 1, seq: 10, decisions: [], lessons: [{
    lessonId: 'lesson:earlier-inspection', scope: 'execution:diagnose_agenda',
    tags: ['execution', 'action', executionTargetTag(target)], excludes: [], sourceRefs: ['action:earlier'],
    value: -0.25, criterion: 'execution', authority: 'provisional', basis: 'verified-outcome', active: true,
  }] };
  let dispatches = 0;
  const orchestrator = Object.create(Orchestrator.prototype);
  orchestrator.logsDir = f.dir; orchestrator.logger = logger;
  orchestrator.liveProblems = { store: f.problemStore,
    processNow: async id => { dispatches++; return { ...f.problemStore.get(id), dispatchedTurnId: 'inspection-run' }; } };
  const result = await orchestrator.executeAgendaItem({ ...parsedItem, id: 'optional-inspection' },
    { autonomousOptional: true, readLearning: () => snapshot });
  assert.equal(result.status, 'not_attempted');
  assert.equal(dispatches, 0, 'a known unreliable optional inspection must not dispatch');
  assert.deepEqual(result.learning.lessonIds, ['lesson:earlier-inspection']);
  const direct = await orchestrator.executeAgendaItem({ ...parsedItem, id: 'owner-inspection' },
    { actor: 'owner', readLearning: () => snapshot });
  assert.equal(direct.turnId, 'inspection-run');
  assert.equal(dispatches, 1, 'an explicit owner request remains owed');
});

test('typed intent cannot invent evidence or downgrade into the legacy privileged diagnostic path', () => {
  const good = candidate();
  for (const boundedIntent of [
    { ...good.boundedIntent, evidenceRefs: ['invented:owner-authority'] },
    { ...good.boundedIntent, operation: 'restart' },
    { ...good.boundedIntent, authority: 'owner-approved' },
    { ...good.boundedIntent, stopCondition: '' },
    null,
  ]) {
    const verdict = parsed({ ...good, content: 'Fix the API endpoint and restart its process.', boundedIntent });
    assert.deepEqual(verdict.agendaCandidates, [], 'malformed typed intent must not fall through to legacy keyword matching');
  }
});

test('an explicit empty agenda remains silence, not a manufactured task or execution failure', () => {
  const motor = new MotorCortex({ logger, canAct: () => true });
  const plan = motor.compileMotorIntents({ thoughtText: 'Capture a CPU snapshot. Verify the briefing schedule.',
    finalVerdict: { agendaCandidates: [], raw: JSON.stringify({ verdict: 'keep', agendaCandidates: [] }) }, evidenceRefs: refs });
  assert.deepEqual(plan.accepted, []);
  assert.equal(plan.decisions[0].status, 'no_action');
  assert.equal(plan.decisions[0].routingVersion, 2);
  assert.equal(plan.decisions[0].reasonCode, 'no_bounded_intent');
});

test('fresh critic and compiler output cannot omit the inspection envelope to obtain legacy authority', () => {
  const oldShape = { content: 'Fix the API endpoint and restart its process.', kind: 'idea' };
  assert.deepEqual(parsed(oldShape).agendaCandidates, []);
  const motor = new MotorCortex({ canAct: () => true, logger });
  for (const finalVerdict of [{ agendaCandidates: [oldShape] }, { raw: JSON.stringify({ agendaCandidates: [oldShape] }) }, {}]) {
    const plan = motor.compileMotorIntents({ finalVerdict, thoughtText: 'Fix the API endpoint and restart its process.' });
    assert.deepEqual(plan.accepted, [], 'prose and omitted envelopes do not grant old diagnostic authority');
  }
});

test('the real thinking factory supplies stable source refs through critique generation, storage and dispatch', async t => {
  const f = fixture(t), events = [], prompts = [];
  const [{ AgentLoop }, { ConversationHistory }, { ToolRegistry }, { resolveDiagnosticInspection }] = await Promise.all([
    import('../../../src/agent/loop.ts'), import('../../../src/agent/history.ts'),
    import('../../../src/agent/tools/index.ts'), import('../../../src/agent/diagnostic-inspection.ts'),
  ]);
  const conversationsDir = path.join(f.dir, 'conversations'), workspacePath = path.join(f.dir, 'workspace');
  fs.mkdirSync(conversationsDir); fs.mkdirSync(workspacePath);
  const previousFetch = globalThis.fetch, previousKey = process.env.XAI_API_KEY, previousRoot = process.env.HOME23_ROOT;
  process.env.XAI_API_KEY = 'fixture-key'; process.env.HOME23_ROOT = f.dir;
  t.after(() => { globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.XAI_API_KEY; else process.env.XAI_API_KEY = previousKey;
    if (previousRoot === undefined) delete process.env.HOME23_ROOT; else process.env.HOME23_ROOT = previousRoot; });
  let providerRequests = 0, reads = 0, completion;
  const registry = new ToolRegistry();
  registry.register({ name: 'cron_list', description: 'Read the existing fixture schedules.', input_schema: { type: 'object' },
    async execute() { assert.fail('the generic registry definition must not execute for an inspection'); } });
  globalThis.fetch = async () => {
    providerRequests++;
    const output = providerRequests === 1
      ? [{ type: 'response.output_item.done', item: { type: 'function_call', call_id: 'inspection-read', name: 'cron_list', arguments: '{}' } }]
      : [{ type: 'response.output_text.delta', delta: 'The observed schedule includes Saturday and Sunday. No changes made.' }];
    output.push({ type: 'response.completed', response: { status: 'completed' } });
    return new Response(output.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''),
      { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const agent = new AgentLoop({ apiKey: 'fixture-key', model: 'grok-fixture', provider: 'xai', registry,
    history: new ConversationHistory(conversationsDir, 100000, 'fixture'),
    contextManager: { getSystemPrompt: () => 'fixture', getPromptSourceInfo: () => ({ loadedFiles: [] }) },
    toolContext: { brainOperations: { withActivityHandler() { return this; } }, scheduler: { getJobs() {
      reads++; return [{ id: 'daily-fishing-briefing', name: 'Daily local fishing briefing', enabled: true,
        schedule: { kind: 'cron', expr: '15 7 * * *' }, payload: { kind: 'agentTurn' }, state: { nextRunAtMs: Date.now() + 3600000, consecutiveErrors: 0 } }];
    } } }, workspacePath });
  const orchestrator = Object.create(Orchestrator.prototype);
  orchestrator.logsDir = f.dir; orchestrator.logger = logger;
  orchestrator.conversationSalience = { getRecentContext: () => 'Owner: Does my local fishing briefing run on weekends?',
    getRecentEntries: () => [{ source: 'seed_contact', eventId: 'message:actual-owner-question' }] };
  orchestrator.liveProblems = { store: f.problemStore, processNow: async id => {
    const problem = f.problemStore.get(id);
    const inspection = resolveDiagnosticInspection(problem, { registry, instanceDir: f.dir, workspacePath });
    const started = await agent.runWithTurn(`inspection:${problem.id}`, inspection.mission,
      { ...inspection.turnOptions, registry: inspection.registry });
    f.problemStore.recordDispatch(id, { turnId: started.turnId }); completion = started.response;
    return f.problemStore.get(id);
  } };
  const stableRef = 'memory:daily-briefing';
  const item = candidate();
  item.boundedIntent = { ...item.boundedIntent, targetRef: stableRef, evidenceRefs: [stableRef] };
  const graph = { nodes: new Map([['daily-briefing', { id: 'daily-briefing', concept: 'An existing daily local fishing briefing should include weekends.' }]]), edges: new Map(), clusters: new Map() };
  const machine = orchestrator.createThinkingMachine({ logger, memory: graph, discoveryEngine: { pop: () => [] },
    unifiedClient: { generate: async input => { prompts.push(input); return { content: input.component === 'critique'
      ? JSON.stringify({ verdict: 'keep', confidence: 0.95, gaps: [], rationale: 'Inspect the existing briefing schedule.', agendaCandidates: [item] })
      : 'The remembered fishing briefing and the current weekend question justify checking its actual schedule, without changing it.' }; } },
    config: { agendaStore: f.agendaStore, eventLedger: { record: (type, session, payload) => events.push({ type, payload }) },
      motorCortex: new MotorCortex({ logger, canAct: item => orchestrator.isBoundedOperationalAgendaItem(item),
        executeAgendaItem: (item, opts) => orchestrator.executeAgendaItem(item, { ...opts, agentName: 'fixture', conversationsDir }) }) } });
  machine.pgsAdapter = { connect: async () => ({ available: false, perspectives: [], candidateEdges: [], usage: {} }) };
  await machine._runCycle({ signal: 'exploration', nodeIds: ['daily-briefing'], score: 0.9, rationale: 'Inspect a remembered briefing in light of the actual question.' });
  const prompt = prompts.find(row => row.component === 'critique');
  assert.match(prompt.messages[0].content, /memory:daily-briefing/);
  assert.match(prompt.messages[0].content, /message:actual-owner-question/);
  const created = events.find(row => row.type === 'AgendaCandidateCreated');
  assert.ok(created, 'actual generated critique must reach the agenda store');
  const stored = f.agendaStore.get(created.payload.agendaId);
  assert.equal(stored.boundedIntent.targetRef, stableRef);
  assert.ok(stored.intentEvidenceRefs.includes(stableRef));
  assert.equal(events.find(row => row.type === 'MotorActionRouted').payload.status, 'dispatched');
  const result = await completion;
  assert.equal(result.terminalStatus, 'complete'); assert.equal(reads, 1); assert.equal(providerRequests, 2);
  assert.equal(f.problemStore.reloadIfChanged(), true);
  const problem = f.problemStore.get(`agenda_${stored.id}`);
  assert.equal(problem.handoff.outcome, 'inspection_completed');
  assert.equal(readInspectionTerminal(problem).status, 'success');
  const outcomes = fs.readFileSync(path.join(f.dir, 'actions.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter(row => row.phase === 'outcome');
  assert.equal(outcomes.length, 1); assert.equal(outcomes[0].status, 'success');
  assert.deepEqual(parsed(item, []).agendaCandidates, [], 'missing runtime sources stay honestly unavailable');
});

async function dispatchedFixture(t, suffix = 'native') {
  const f = fixture(t);
  const conversationsDir = path.join(f.dir, 'conversations'); fs.mkdirSync(conversationsDir);
  const item = { ...parsed(candidate()).agendaCandidates[0], id: suffix };
  const orchestrator = Object.create(Orchestrator.prototype);
  orchestrator.logsDir = f.dir; orchestrator.logger = logger;
  let calls = 0;
  orchestrator.liveProblems = { store: f.problemStore, processNow: async id => {
    calls++;
    f.problemStore.upsert({ id, dispatchedTurnId: `native-turn-${calls}`, dispatchedAt: new Date().toISOString() });
    return f.problemStore.get(id);
  } };
  const options = { autonomousOptional: true, agentName: 'fixture', conversationsDir, readLearning: () => null };
  const result = await orchestrator.executeAgendaItem(item, options);
  const problem = f.problemStore.get(result.problemId);
  const native = (status, events = [], turnId = result.turnId) => {
    const chatId = `inspection:${problem.id}`;
    const endedAt = new Date().toISOString();
    const records = [{ type: 'turn', turn_id: turnId, chat_id: chatId, status: 'pending',
      started_at: problem.inspectionExecution.receipt.ts }, ...events,
    { type: 'turn', turn_id: turnId, chat_id: chatId, status, ended_at: endedAt }];
    const file = path.join(conversationsDir, `fixture__${chatId.replace(/[^a-zA-Z0-9_-]/g, '_')}.jsonl`);
    fs.writeFileSync(file, records.map(row => JSON.stringify(row) + '\n').join(''));
    return file;
  };
  return { ...f, orchestrator, options, item, problem, result, native, calls: () => calls };
}

test('canonical capability refusals and actual timeout are execution failures, not successful inspections', async t => {
  const f = await dispatchedFixture(t);
  f.native('complete', [{ type: 'event', turn_id: f.result.turnId, seq: 1, kind: 'tool_result',
    data: { success: false, exactResult: JSON.stringify({ code: 'inspection_authority_refused', tool: 'shell' }) } }]);
  assert.equal(readInspectionTerminal(f.problem).status, 'failed', 'native tool events have no chat_id field');
  f.native('complete', [{ type: 'event', turn_id: f.result.turnId, seq: 1, kind: 'tool_result',
    data: { success: true, exactResult: 'Source code mentions inspection_authority_refused as a literal.' } }]);
  assert.equal(readInspectionTerminal(f.problem).status, 'success', 'reading the refusal marker as evidence is not a runtime refusal');
  f.native('timeout');
  assert.equal(readInspectionTerminal(f.problem).status, 'failed');
});

test('a native completion is recovered by the regular tick even when no callback changed the problem file', async t => {
  const f = await dispatchedFixture(t, 'lost-callback');
  assert.equal(f.problemStore.reloadIfChanged(), false);
  f.native('complete');
  assert.equal(f.problemStore.reloadIfChanged(), true);
  assert.equal(f.problemStore.get(f.problem.id).handoff.outcome, 'inspection_completed');
});

test('inspection dispatch requires durable provenance and never replays an already terminal inspection', async t => {
  const f = fixture(t), item = { ...parsed(candidate()).agendaCandidates[0], id: 'durable' };
  const orchestrator = Object.create(Orchestrator.prototype);
  orchestrator.logsDir = f.dir; orchestrator.logger = logger;
  let calls = 0;
  orchestrator.liveProblems = { store: f.problemStore, processNow: async () => { calls++; return null; } };
  f.problemStore.save = () => {};
  await assert.rejects(orchestrator.executeAgendaItem(item), /durable inspection/);
  assert.equal(calls, 0);
  const done = await dispatchedFixture(t, 'done'); done.native('complete'); done.problemStore.reloadIfChanged();
  const before = done.calls();
  const again = await done.orchestrator.executeAgendaItem(done.item, done.options);
  assert.equal(again.status, 'not_attempted'); assert.equal(done.calls(), before);
});

test('reported, wrong-turn and symlinked completions cannot replace the native inspection receipt', async t => {
  const f = await dispatchedFixture(t, 'forged');
  f.problem.fixRecipe = { turnId: f.result.turnId, inspectionExecutionId: f.problem.inspectionExecution.executionId,
    executionStatus: 'completed', inspectionCompletionSource: 'agent-loop-terminal' };
  assert.equal(readInspectionTerminal(f.problem), null, 'a forged callback without a native journal is not evidence');
  f.native('complete', [], 'another-turn');
  assert.equal(readInspectionTerminal(f.problem), null);
  const file = f.native('complete');
  const other = path.join(f.dir, 'other.jsonl'); fs.renameSync(file, other); fs.symlinkSync(other, file);
  assert.equal(readInspectionTerminal(f.problem), null, 'a substituted journal path is refused');
});

test('inspection completion transport requires the existing bridge authority and exact native execution', async t => {
  const f = await dispatchedFixture(t, 'callback'); f.native('complete');
  const payload = { turnId: f.result.turnId, inspectionExecutionId: f.problem.inspectionExecution.executionId,
    executionStatus: 'completed', inspectionCompletionSource: 'agent-loop-terminal' };
  const expectedToken = 'fixture-private-bridge-token-long-enough';
  assert.equal(validInspectionCompletion(f.problem, payload, { expectedToken }), false);
  assert.equal(validInspectionCompletion(f.problem, payload, { expectedToken, authorization: 'Bearer forged' }), false);
  assert.equal(validInspectionCompletion(f.problem, { ...payload, turnId: 'stale-turn' },
    { expectedToken, authorization: `Bearer ${expectedToken}` }), false);
  assert.equal(validInspectionCompletion(f.problem, { ...payload, inspectionExecutionId: 'different-execution' },
    { expectedToken, authorization: `Bearer ${expectedToken}` }), false);
  assert.equal(validInspectionCompletion(f.problem, payload, { expectedToken, authorization: `Bearer ${expectedToken}` }), true);
});

test('actual native execution outcomes teach the same optional diagnostic consumer across Seed restore', async t => {
  const { tsImport } = await import('tsx/esm/api');
  const [{ SeedProcess }, { EventLedgerTailAdapter }] = await Promise.all([
    tsImport('../../../substrate/src/seed.ts', import.meta.url),
    tsImport('../../../substrate/src/adapters/event-ledger-tail.ts', import.meta.url),
  ]);
  const { readSeedLearning } = require('../../../shared/seed-learning.cjs');
  const f = await dispatchedFixture(t, 'learned-native');
  const stateDir = path.join(f.dir, 'seed');
  let seed = SeedProcess.initialize(stateDir); seed.checkpoint();
  const adapter = new EventLedgerTailAdapter({ sourcePath: path.join(f.dir, 'event-ledger.jsonl'),
    cursorDir: path.join(f.dir, 'cursor'), fromEnd: false });
  const assimilate = () => {
    for (const event of adapter.pullSync()) { seed.transition(event); adapter.commit(event.endOffset); }
    seed.checkpoint(); seed = SeedProcess.restore(stateDir);
  };
  assimilate();
  assert.equal(readSeedLearning(stateDir).lessons.length, 0, 'queued/dispatched is not an outcome');
  f.native('error');
  f.problemStore.load();
  assimilate();
  const negative = readSeedLearning(stateDir);
  assert.equal(negative.lessons.length, 1);
  assert.equal(negative.lessons[0].scope, 'execution:diagnose_agenda');
  assert.equal(negative.lessons[0].value, -0.25);
  assert.equal(f.problemStore.get(f.problem.id).handoff.outcome, 'inspection_failed');
  const beforeCalls = f.calls();
  const blocked = await f.orchestrator.executeAgendaItem({ ...f.item, id: 'next-optional' },
    { ...f.options, readLearning: () => readSeedLearning(stateDir) });
  assert.equal(blocked.status, 'not_attempted');
  assert.equal(f.calls(), beforeCalls);
  assimilate();
  assert.equal(readSeedLearning(stateDir).lessons.length, 1, 'non-attempt adds no negative teaching');
  const retry = await f.orchestrator.executeAgendaItem({ ...f.item, id: 'owner-retry' },
    { ...f.options, actor: 'owner', readLearning: () => readSeedLearning(stateDir) });
  assert.ok(retry.turnId);
  const retryProblem = f.problemStore.get(retry.problemId);
  const chatId = `inspection:${retry.problemId}`;
  const file = path.join(f.options.conversationsDir, `fixture__${chatId.replace(/[^a-zA-Z0-9_-]/g, '_')}.jsonl`);
  fs.writeFileSync(file, [
    { type: 'turn', turn_id: retry.turnId, chat_id: chatId, status: 'pending', started_at: retryProblem.inspectionExecution.receipt.ts },
    { type: 'turn', turn_id: retry.turnId, chat_id: chatId, status: 'complete', ended_at: new Date().toISOString() },
  ].map(row => JSON.stringify(row) + '\n').join(''));
  f.problemStore.load(); f.problemStore.load();
  assimilate();
  assert.equal(readSeedLearning(stateDir).lessons.length, 2, 'duplicate terminal read cannot mint another lesson');
  const recovered = await f.orchestrator.executeAgendaItem({ ...f.item, id: 'recovered-optional' },
    { ...f.options, readLearning: () => readSeedLearning(stateDir) });
  assert.ok(recovered.turnId, 'new successful execution evidence changes the next optional dispatch');
});
