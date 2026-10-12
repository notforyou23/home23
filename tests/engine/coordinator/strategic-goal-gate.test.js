import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
process.env.OPENAI_API_KEY ||= 'test-key';
const { StrategicGoalGate } = require('../../../engine/src/coordinator/strategic-goal-gate.js');
const { MetaCoordinator } = require('../../../engine/src/coordinator/meta-coordinator.js');
const { IntrinsicGoalSystem } = require('../../../engine/src/goals/intrinsic-goals.js');
const yaml = require('js-yaml');

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const NOW = Date.parse('2026-10-12T15:00:00.000Z');
const ORIGINAL = 'Investigate basalt sediment samples collected along the northern river bank.';
const SIMILAR = 'Investigate the northern river bank basalt sediment samples.';
const WORK = [
  'Research seasonal bird migration routes across the Atlantic coast.',
  'Analyze volcanic mineral chemistry using the supplied laboratory samples.',
  'Write a report comparing household energy use over winter months.',
  'Investigate acoustic insulation performance in the garden workshop.',
  'Document the flowering cycle of native woodland plants.',
];
const LIVE_EXAMPLES = [
  'Prepare one owner-facing request listing all nine notes, the proposed template.',
  'Include the nine-note scope and pilot in the single canonical owner request.',
  'Ask the owner in the canonical request to identify authorized pointer text, destinations.',
  'Propose a specific byte threshold and below-threshold consequence, label both pending owner approval.',
  'Merge relevant verification, threshold, comparison, and follow-up details into one decision record.',
  'Pause duplicate requests, identify the outstanding approval or evidence gap.',
  'Ask the decision-maker to approve the target, scope, and verification method first.',
];

function recordingLogger() {
  const infos = [];
  const errors = [];
  return {
    infos,
    errors,
    info(message, fields) { infos.push({ message, fields }); },
    error(message, fields) { errors.push({ message, fields }); },
    warn() {},
    debug() {},
  };
}

function store({ active = [], completed = [], archived = [] } = {}) {
  return { export: () => ({ active: active.map(goal => [goal.id, goal]), completed, archived }) };
}

function goal(id, description = ORIGINAL, extra = {}) {
  return { id, description, source: 'meta_coordinator_strategic', created: NOW, ...extra };
}

function gateFixture(overrides = {}, extraCoordinator = {}) {
  const logger = recordingLogger();
  let clock = NOW;
  const gate = new StrategicGoalGate({
    blockedGoalTopics: [],
    strategicGoalGate: { metaLoopEnabled: false, rateLimitEnabled: false, ...overrides },
    ...extraCoordinator,
  }, logger, { now: () => clock });
  return { gate, logger, advance(ms) { clock += ms; } };
}

function evaluate(gate, description, goalsSystem = store(), review = gate.beginReview('test'), options) {
  return gate.evaluate({ description }, goalsSystem, review, options);
}

test('near-duplicate active goals block rediscovery regardless of their creation age or source', () => {
  const { gate } = gateFixture();
  const existing = goal('active-original', ORIGINAL, { created: NOW - 90 * DAY, source: 'mcp' });
  const decision = evaluate(gate, SIMILAR.toUpperCase(), store({ active: [existing] }));
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'duplicate-of');
  assert.equal(decision.goalId, existing.id);
  assert.ok(decision.score >= 0.5);
});

test('token containment catches expanded descriptions and gate inspection leaves history unchanged', () => {
  const { gate } = gateFixture();
  const existing = goal('containment-original', ORIGINAL);
  const goals = store({ active: [existing] });
  const before = JSON.stringify(goals.export());
  const decision = evaluate(gate, `${ORIGINAL} Include detailed chemical findings and ecological comparisons.`, goals);
  assert.equal(decision.allowed, false);
  assert.equal(decision.score, 1);
  assert.equal(JSON.stringify(goals.export()), before);
});

for (const status of ['completed', 'archived']) {
  test(`near-duplicate ${status} goals block within the default 14-day window`, () => {
    const { gate } = gateFixture();
    const existing = goal(`${status}-recent`, ORIGINAL, {
      status,
      created: NOW - 90 * DAY,
      [`${status}At`]: new Date(NOW - 13 * DAY).toISOString(),
      archiveReason: 'review topic finished',
    });
    const decision = evaluate(gate, SIMILAR, store({ [status]: [existing] }));
    assert.equal(decision.allowed, false);
    assert.equal(decision.goalId, existing.id);
  });

  test(`near-duplicate ${status} goals outside the time window do not block`, () => {
    const { gate } = gateFixture();
    const existing = goal(`${status}-old`, ORIGINAL, {
      status,
      created: NOW - 20 * DAY,
      [`${status}At`]: NOW - 15 * DAY,
      archiveReason: 'review topic finished',
    });
    assert.equal(evaluate(gate, SIMILAR, store({ [status]: [existing] })).allowed, true);
  });
}

test('terminal goals use creation time when a terminal timestamp is unavailable', () => {
  const { gate } = gateFixture();
  const recent = goal('missing-terminal-time', ORIGINAL, { status: 'archived', created: NOW - DAY });
  assert.equal(evaluate(gate, SIMILAR, store({ archived: [recent] })).allowed, false);
});

test('terminal goals without any timestamp remain blocked because their age cannot be established', () => {
  const { gate } = gateFixture();
  const legacy = goal('legacy-no-time', ORIGINAL, { status: 'archived', created: undefined });
  assert.equal(evaluate(gate, SIMILAR, store({ archived: [legacy] })).allowed, false);
});

test('owner archives permanently block similar goals, case-insensitively', () => {
  const { gate } = gateFixture();
  const existing = goal('owner-closed', ORIGINAL, {
    status: 'archived',
    created: NOW - 100 * DAY,
    archivedAt: NOW - 90 * DAY,
    archiveReason: 'OwNeR: topic stale/closed (2026-07-11)',
  });
  const decision = evaluate(gate, SIMILAR, store({ archived: [existing] }));
  assert.equal(decision.allowed, false);
  assert.equal(decision.goalId, existing.id);
});

test('owner closure still blocks when lexical deduplication is individually disabled', () => {
  const { gate } = gateFixture({ dedupeEnabled: false });
  const existing = goal('owner-topic', ORIGINAL, {
    status: 'archived', archivedAt: NOW - 90 * DAY, archiveReason: 'owner: closed',
  });
  const decision = evaluate(gate, SIMILAR, store({ archived: [existing] }));
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'blocked-topic');
});

test('ordinary archived reasons do not become permanent owner closures', () => {
  const { gate } = gateFixture();
  const existing = goal('ordinary-archive', ORIGINAL, {
    status: 'archived', archivedAt: NOW - 90 * DAY, archiveReason: 'review: owner feedback discussed',
  });
  assert.equal(evaluate(gate, SIMILAR, store({ archived: [existing] })).allowed, true);
});

test('configured topic phrases block normalized keyword sets', () => {
  const { gate } = gateFixture({ dedupeEnabled: false }, { blockedGoalTopics: ['basalt sediment samples'] });
  const decision = evaluate(gate, ORIGINAL);
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'blocked-topic');
  assert.equal(decision.topic, 'basalt sediment samples');
  assert.equal(evaluate(gate, WORK[0]).allowed, true);
});

for (const [index, description] of LIVE_EXAMPLES.entries()) {
  test(`seeded blocked families match live example ${index + 1} with other gates disabled`, () => {
    const logger = recordingLogger();
    const gate = new StrategicGoalGate({ strategicGoalGate: {
      dedupeEnabled: false, ownerClosedEnabled: false, metaLoopEnabled: false, rateLimitEnabled: false,
    } }, logger, { now: () => NOW });
    const decision = evaluate(gate, description);
    assert.equal(decision.allowed, false, description);
    assert.equal(decision.reason, 'blocked-topic');
  });
}

test('seeded blocked topics retain ordinary work mentioning notes, approval data, or technical thresholds', () => {
  const gate = new StrategicGoalGate({ strategicGoalGate: {
    dedupeEnabled: false, metaLoopEnabled: false, rateLimitEnabled: false,
  } }, recordingLogger(), { now: () => NOW });
  for (const description of [
    'Compare compression byte thresholds against measured archive performance.',
    'Research how regulatory approval affects regional housing construction.',
    'Summarize nine field notes describing woodland bird migration.',
    'Inspect the project scope and record laboratory verification results.',
  ]) assert.equal(evaluate(gate, description).allowed, true, description);
});

test('meta-loop goals require an actual pending owner request object', () => {
  const { gate } = gateFixture({ metaLoopEnabled: true });
  for (const description of LIVE_EXAMPLES.slice(3)) {
    const decision = evaluate(gate, description);
    assert.equal(decision.allowed, false, description);
    assert.equal(decision.reason, 'meta-loop');
  }
  for (const pendingOwnerRequests of [
    [], [null], ['owner approval is pending'],
    [{ questionId: 'resolved', kind: 'operator_question', status: 'closed', audience: 'operator' }],
    [{ questionId: 'resident-only', kind: 'operator_question', status: 'open', audience: 'resident' }],
    [{ candidateId: 'historical-authority', kind: 'authority_request', status: 'open', audience: 'operator' }],
  ]) {
    assert.equal(evaluate(gate, 'Ask the owner to approve the workshop inspection scope.', store(),
      gate.beginReview('invalid-request'), { pendingOwnerRequests }).allowed, false);
  }
  const decision = evaluate(gate, 'Ask the owner to approve the workshop inspection scope.', store(),
    gate.beginReview('pending-request'), {
      pendingOwnerRequests: [{ questionId: 'owner-request-1', kind: 'operator_question', status: 'open', audience: 'operator' }],
    });
  assert.equal(decision.allowed, true);
});

test('meta-loop guard preserves ordinary research and goal-oriented technical work', () => {
  const { gate } = gateFixture({ metaLoopEnabled: true });
  for (const description of [
    WORK[0],
    'Analyze approval ratings in the supplied public survey dataset.',
    'Merge botanical measurements into a field observation dataset.',
    'Investigate duplicate image files in the supplied sample archive.',
    'Measure byte counts and verify compression thresholds in the laboratory benchmark.',
    'Request the owner-authorized database log samples for the compression investigation.',
    'Inspect the owner-approved backups and request missing log samples.',
    'Implement the compression fix already approved by the owner and request benchmark results.',
  ]) assert.equal(evaluate(gate, description).allowed, true, description);
});

test('meta-loop guard recognizes owner-first approval conditions', () => {
  const { gate } = gateFixture({ metaLoopEnabled: true });
  for (const description of [
    'The owner needs to approve the workshop inspection scope.',
    'Owner approval is pending before the coastal wildlife survey can begin.',
  ]) assert.equal(evaluate(gate, description).reason, 'meta-loop', description);
});

test('pending requests do not bypass duplicates or explicitly blocked topics', () => {
  const { gate } = gateFixture({ metaLoopEnabled: true }, { blockedGoalTopics: ['workshop inspection scope'] });
  const options = { pendingOwnerRequests: [{ questionId: 'request-1', kind: 'operator_question', audience: 'operator', status: 'open' }] };
  assert.equal(evaluate(gate, ORIGINAL, store({ active: [goal('existing')] }),
    gate.beginReview('duplicate'), options).reason, 'duplicate-of');
  assert.equal(evaluate(gate, 'Ask the owner to approve the workshop inspection scope.', store(),
    gate.beginReview('blocked'), options).reason, 'blocked-topic');
});

test('default per-review rate limit permits two successful creations across shared calls', () => {
  const { gate } = gateFixture({ rateLimitEnabled: true });
  const review = gate.beginReview('cycle-100');
  for (let i = 0; i < 2; i++) {
    assert.equal(evaluate(gate, WORK[i], store(), review).allowed, true);
    gate.recordCreated(goal(`created-${i}`, WORK[i]), review);
  }
  const decision = evaluate(gate, WORK[2], store(), review);
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'rate-limit');
  assert.equal(decision.limit, 'per-review');
});

test('rate limits count successful writes, not candidates accepted by the gate', () => {
  const { gate } = gateFixture({ rateLimitEnabled: true, maxPerReview: 1 });
  const review = gate.beginReview('failed-write');
  assert.equal(evaluate(gate, WORK[0], store(), review).allowed, true);
  assert.equal(evaluate(gate, WORK[1], store(), review).allowed, true);
  gate.recordCreated(goal('successful', WORK[1]), review);
  assert.equal(evaluate(gate, WORK[2], store(), review).reason, 'rate-limit');
});

test('default rolling-hour rate limit spans review contexts and expires after an hour', () => {
  const { gate, advance } = gateFixture({ rateLimitEnabled: true });
  for (let batch = 0; batch < 2; batch++) {
    const review = gate.beginReview(`review-${batch}`);
    for (let i = 0; i < 2; i++) {
      const index = batch * 2 + i;
      assert.equal(evaluate(gate, WORK[index], store(), review).allowed, true);
      gate.recordCreated(goal(`hourly-${index}`, WORK[index]), review);
    }
  }
  const decision = evaluate(gate, WORK[4]);
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'rate-limit');
  assert.equal(decision.limit, 'per-hour');
  advance(HOUR + 1);
  assert.equal(evaluate(gate, WORK[4]).allowed, true);
});

test('rolling-hour limit includes persisted strategic creations but excludes other goal sources', () => {
  const { gate } = gateFixture({ rateLimitEnabled: true });
  const created = WORK.slice(0, 4).map((description, index) => goal(`persisted-${index}`, description, {
    created: NOW - 5 * 60 * 1000,
  }));
  const persisted = store({ active: created.slice(0, 2), completed: [created[2]], archived: [created[3]] });
  assert.equal(evaluate(gate, WORK[4], persisted).reason, 'rate-limit');
  const otherSources = store({ active: created.map(item => ({ ...item, source: 'mcp' })) });
  assert.equal(evaluate(gate, WORK[4], otherSources).allowed, true);
});

test('dedupe threshold and lookback days are configurable', () => {
  const { gate: strict } = gateFixture({ similarityThreshold: 1 });
  const short = 'Research woodland bird migration routes.';
  const partial = 'Research woodland bird migration routes and compare coastal nesting habitats.';
  // Jaccard is below 1; containment remains 1, so use partially overlapping token sets.
  const candidate = 'Research woodland bird migration patterns near coastal nesting habitats.';
  assert.equal(evaluate(strict, candidate, store({ active: [goal('strict', short)] })).allowed, true);
  const { gate: lenient } = gateFixture({ similarityThreshold: 0.3 });
  assert.equal(evaluate(lenient, candidate, store({ active: [goal('lenient', short)] })).allowed, false);
  const { gate: shortWindow } = gateFixture({ lookbackDays: 1 });
  const existing = goal('two-days', partial, { archivedAt: NOW - 2 * DAY, status: 'archived' });
  assert.equal(evaluate(shortWindow, partial, store({ archived: [existing] })).allowed, true);
});

test('topic similarity threshold controls partial keyword matches', () => {
  const topics = { blockedGoalTopics: ['basalt sediment samples laboratory'] };
  const description = 'Analyze basalt sediment samples mineral chemistry.';
  const { gate: strict } = gateFixture({ topicSimilarityThreshold: 0.9 }, topics);
  assert.equal(evaluate(strict, description).allowed, true);
  const { gate: lenient } = gateFixture({ topicSimilarityThreshold: 0.5 }, topics);
  assert.equal(evaluate(lenient, description).reason, 'blocked-topic');
});

test('individual toggles disable only their corresponding gates', () => {
  const existing = goal('owner-archive', ORIGINAL, {
    status: 'archived', archivedAt: NOW - 90 * DAY, archiveReason: 'owner: closed',
  });
  const { gate } = gateFixture({ dedupeEnabled: false, ownerClosedEnabled: false, blockedTopicsEnabled: false });
  assert.equal(evaluate(gate, ORIGINAL, store({ archived: [existing] })).allowed, true);
  const { gate: metaDisabled } = gateFixture({ metaLoopEnabled: false });
  assert.equal(evaluate(metaDisabled, LIVE_EXAMPLES[6]).allowed, true);
  const { gate: ratesDisabled } = gateFixture({ rateLimitEnabled: false, maxPerReview: 0, maxPerHour: 0 });
  assert.equal(evaluate(ratesDisabled, WORK[0]).allowed, true);
});

test('explicit empty blockedGoalTopics clears the seeded families', () => {
  const { gate } = gateFixture({ dedupeEnabled: false });
  for (const description of LIVE_EXAMPLES) assert.equal(evaluate(gate, description).allowed, true);
});

test('disabled configuration bypasses duplicate, owner-closed, topic, meta-loop, and rate gates', () => {
  const { gate } = gateFixture({ enabled: false, metaLoopEnabled: true, rateLimitEnabled: true, maxPerReview: 0, maxPerHour: 0 }, {
    blockedGoalTopics: ['basalt sediment samples'],
  });
  const review = gate.beginReview('disabled');
  const archived = goal('closed', ORIGINAL, { archivedAt: NOW - 90 * DAY, archiveReason: 'owner: closed' });
  assert.equal(evaluate(gate, ORIGINAL, store({ archived: [archived] }), review).allowed, true);
  assert.equal(evaluate(gate, LIVE_EXAMPLES[6], store(), review).allowed, true);
  for (let i = 0; i < WORK.length; i++) {
    assert.equal(evaluate(gate, WORK[i], store(), review).allowed, true);
    gate.recordCreated(goal(`disabled-${i}`, WORK[i]), review);
  }
});

test('suppressed candidates log once with a reason and reviews log created and suppressed totals', () => {
  const { gate, logger } = gateFixture({ metaLoopEnabled: true }, { blockedGoalTopics: ['volcanic mineral chemistry'] });
  const review = gate.beginReview('logging-review');
  evaluate(gate, SIMILAR, store({ active: [goal('existing-log')] }), review);
  evaluate(gate, WORK[1], store(), review);
  evaluate(gate, LIVE_EXAMPLES[6], store(), review);
  assert.equal(evaluate(gate, WORK[0], store(), review).allowed, true);
  gate.recordCreated(goal('created-log', WORK[0]), review);
  gate.finishReview(review);
  const suppressions = logger.infos.filter(row => row.message.startsWith('Strategic goal suppressed: '));
  assert.equal(suppressions.length, 3);
  assert.match(suppressions[0].message, /duplicate-of.*existing-log.*score/i);
  assert.match(suppressions[1].message, /blocked-topic/);
  assert.match(suppressions[2].message, /meta-loop/);
  const summary = logger.infos.filter(row => row.message === 'Strategic goal gate review summary');
  assert.equal(summary.length, 1);
  assert.equal(summary[0].fields.reviewId, 'logging-review');
  assert.equal(summary[0].fields.attempted, 4);
  assert.equal(summary[0].fields.created, 1);
  assert.equal(summary[0].fields.suppressed, 3);
  assert.equal(summary[0].fields.enabled, true);
  assert.equal(summary[0].fields.reasons['duplicate-of'], 1);
  assert.equal(summary[0].fields.reasons['blocked-topic'], 1);
  assert.equal(summary[0].fields.reasons['meta-loop'], 1);
});

function coordinatorFixture(t, coordinatorConfig = {}, fullConfig = {}) {
  const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-strategic-gate-'));
  t.after(() => fs.rmSync(logsDir, { recursive: true, force: true }));
  const logger = recordingLogger();
  const config = {
    logsDir,
    goals: { maxGoals: 30, doneWhen: { autoSynthesizeLegacy: true } },
    roleSystem: {},
    cluster: {},
    coordinator: { blockedGoalTopics: [], ...coordinatorConfig },
    ...fullConfig,
  };
  const coordinator = new MetaCoordinator(config, logger);
  coordinator.parseExecutionHintsWithContract = () => null;
  const goals = new IntrinsicGoalSystem(config, logger);
  return { coordinator, goals, logger, config };
}

function spec(description) {
  return { description, agentType: 'research', priority: 0.9, urgency: 'high', rationale: 'A concrete research deliverable is missing.' };
}

test('coordinator applies deduplication before writing real strategic goals and preserves other sources', async (t) => {
  const { coordinator, goals, logger } = coordinatorFixture(t);
  const existing = goals.addGoal({ description: ORIGINAL, source: 'mcp' });
  const injected = await coordinator.injectUrgentGoals([spec(SIMILAR), spec(WORK[0])], goals);
  assert.equal(injected.length, 1);
  assert.equal(injected[0].description, WORK[0]);
  assert.equal(injected[0].source.label, 'meta_coordinator_strategic');
  assert.equal(injected[0].metadata.gapDriven, true);
  assert.equal(goals.getGoal(existing.id).source.label, 'mcp');
  assert.equal(goals.getGoals().length, 2);
  const other = goals.addGoal({ description: SIMILAR, source: 'mcp' });
  assert.ok(other, 'the new lexical gate must not affect direct non-strategic goal creation');
  assert.equal(logger.infos.filter(row => row.message.startsWith('Strategic goal suppressed: ')).length, 1);
});

test('coordinator checks same-batch duplicates and counts successful writes toward the per-review limit', async (t) => {
  const { coordinator, goals, logger } = coordinatorFixture(t);
  const injected = await coordinator.injectUrgentGoals([
    spec(ORIGINAL), spec(SIMILAR), spec(WORK[0]), spec(WORK[1]),
  ], goals);
  assert.deepEqual(injected.map(item => item.description), [ORIGINAL, WORK[0]]);
  assert.equal(goals.getGoals().length, 2);
  const suppressions = logger.infos.filter(row => row.message.startsWith('Strategic goal suppressed: '));
  assert.equal(suppressions.length, 2);
  assert.match(suppressions[0].message, /duplicate-of/);
  assert.match(suppressions[1].message, /rate-limit per-review/);
});

test('coordinator reads pending operator obligations and treats an unavailable store as no request', async (t) => {
  let reads = 0;
  const { coordinator, goals } = coordinatorFixture(t, {}, {
    _osEngine: { agencyKernel: { deriveObligations() {
      reads++;
      return [{ obligationId: 'pending-q', questionId: 'pending-question', kind: 'operator_question', status: 'open', audience: 'operator', reason: 'Approve workshop inspection scope.' }];
    } } },
  });
  const description = 'Ask the owner to approve the workshop inspection scope.';
  const injected = await coordinator.injectUrgentGoals([spec(description)], goals);
  assert.equal(reads > 0, true);
  assert.equal(injected.length, 1);
  coordinator.fullConfig._osEngine.agencyKernel.deriveObligations = () => { throw new Error('request store unavailable'); };
  const blocked = await coordinator.injectUrgentGoals([spec('Ask the owner to approve the household solar survey.')], goals);
  assert.equal(blocked.length, 0);
});

function agencySnapshot(root, kernel) {
  const files = fs.readdirSync(root, { recursive: true })
    .filter(relative => fs.statSync(path.join(root, relative)).isFile())
    .sort()
    .map(relative => {
      const file = path.join(root, relative);
      const stat = fs.statSync(file);
      return { relative, bytes: fs.readFileSync(file).toString('base64'), mtimeMs: stat.mtimeMs };
    });
  return { files, state: kernel.store.readState() };
}

test('real agency question resolution removes the meta-loop exception without writing agency state or ledgers', async (t) => {
  const { AgencyKernel } = await import('../../../engine/src/agency/resident-kernel.js');
  const { coordinator, goals, logger, config } = coordinatorFixture(t, {
    strategicGoalGate: { dedupeEnabled: false, rateLimitEnabled: false },
  });
  const brainDir = path.join(config.logsDir, 'isolated-agency-brain');
  const kernel = new AgencyKernel({ brainDir, initializeState: false, logger });
  coordinator.fullConfig._osEngine = { agencyKernel: kernel };
  kernel.store.appendReceipt({
    schema: 'home23.agency.receipt.v1',
    at: '2026-10-12T14:00:00.000Z',
    event: 'jtr_question_raised',
    questionId: 'question-workshop-scope',
    question: 'May the workshop inspection proceed?',
    authorityLevel: 'L3',
  });
  const beforePendingRead = agencySnapshot(brainDir, kernel);
  const pending = coordinator.getPendingOwnerRequests();
  assert.equal(pending.some(item => item.questionId === 'question-workshop-scope'), true);
  assert.deepEqual(agencySnapshot(brainDir, kernel), beforePendingRead);
  const accepted = await coordinator.injectUrgentGoals([
    spec('Ask the owner to approve the workshop inspection scope.'),
  ], goals);
  assert.equal(accepted.length, 1);
  assert.deepEqual(agencySnapshot(brainDir, kernel), beforePendingRead);

  kernel.store.appendReceipt({
    schema: 'home23.agency.receipt.v1',
    at: '2026-10-12T14:05:00.000Z',
    event: 'jtr_question_resolved',
    questionId: 'question-workshop-scope',
    status: 'resolved',
    reason: 'Owner approved the workshop inspection.',
  });
  const beforeResolvedRead = agencySnapshot(brainDir, kernel);
  assert.equal(kernel.questions().questions.some(item => item.id === 'question-workshop-scope'), true,
    'historical questions retain the raised receipt after resolution');
  assert.equal(kernel.deriveObligations().some(item => item.questionId === 'question-workshop-scope'), false);
  assert.deepEqual(coordinator.getPendingOwnerRequests(), []);
  assert.deepEqual(agencySnapshot(brainDir, kernel), beforeResolvedRead);
  const rejected = await coordinator.injectUrgentGoals([
    spec('Ask the owner to approve the coastal wildlife survey.'),
  ], goals);
  assert.equal(rejected.length, 0);
  assert.equal(goals.getGoals().length, 1);
  const suppressions = logger.infos.filter(row => row.message.startsWith('Strategic goal suppressed: '));
  assert.equal(suppressions.length, 1);
  assert.equal(suppressions[0].fields.reason, 'meta-loop');
  assert.deepEqual(agencySnapshot(brainDir, kernel), beforeResolvedRead);
});

test('disabled coordinator gate retains existing goal validation while passing otherwise blocked work', async (t) => {
  const { coordinator, goals } = coordinatorFixture(t, { strategicGoalGate: { enabled: false } });
  const injected = await coordinator.injectUrgentGoals([spec(LIVE_EXAMPLES[6]), spec(WORK[0])], goals);
  assert.equal(injected.length, 2);
  assert.deepEqual(injected.map(item => item.description), [LIVE_EXAMPLES[6], WORK[0]]);
  const rejected = await coordinator.injectUrgentGoals([spec('tiny')], goals);
  assert.equal(rejected.length, 0, 'IntrinsicGoalSystem validation still applies');
});

test('one conductReview shares limits and summary across urgent goals and curated insights', async (t) => {
  const { coordinator, goals, logger } = coordinatorFixture(t, {
    planReview: { enabled: false },
    insightCuration: { enabled: false },
  });
  coordinator.lastReviewCycle = 1;
  coordinator.analyzeCognitiveWork = async () => ({ content: 'Current cognition.' });
  coordinator.evaluateGoals = async () => ({ content: 'Current portfolio.', prioritizedGoals: [] });
  coordinator.analyzeAgentResults = async () => ({ agentCount: 0, insights: [], findings: [] });
  coordinator.auditDeliverables = async () => ({ totalFiles: 0, gaps: [] });
  coordinator.analyzeMemory = async () => ({ content: 'Current memory.' });
  coordinator.assessSystemHealth = () => ({ cognitiveState: { curiosity: 1, mood: 1, energy: 1 } });
  coordinator.makeStrategicDecisions = async () => ({ urgentGoals: [spec(WORK[0]), spec(WORK[1])], prioritizedGoals: [], strategicDirectives: [] });
  coordinator.generateReport = async () => ({ summary: {} });
  coordinator.saveReport = async () => {};
  coordinator.saveContext = async () => {};
  coordinator.findInsightsReports = async () => ['fixture-insights.md'];
  coordinator.insightsParser = {
    parseReport: async () => ({ alignments: [{}] }),
    filterHighPriority: rows => rows,
    convertAlignmentsToGoalSpecs: () => [spec(WORK[2])],
  };
  coordinator.deduplicateInsightGoals = rows => rows;
  const result = await coordinator.conductReview({
    cycleCount: 51, journal: [], goals: goals.export(), goalsSystem: goals,
    memory: { nodes: [], edges: [] }, cognitiveState: {}, roles: {},
  });
  assert.ok(result, JSON.stringify(logger.errors));
  assert.equal(goals.getGoals().length, 2);
  assert.equal(goals.getGoals().some(item => item.description === WORK[2]), false);
  const summary = logger.infos.filter(row => row.message === 'Strategic goal gate review summary');
  assert.equal(summary.length, 1);
  assert.equal(summary[0].fields.attempted, 3);
  assert.equal(summary[0].fields.created, 2);
  assert.equal(summary[0].fields.suppressed, 1);
});

test('strategic tracking keeps accepted goals aligned after an earlier specification is suppressed', async (t) => {
  const { coordinator, goals } = coordinatorFixture(t, {
    planReview: { enabled: false }, insightCuration: { enabled: false },
  });
  goals.addGoal({ description: ORIGINAL, source: 'mcp' });
  coordinator.analyzeCognitiveWork = async () => ({});
  coordinator.evaluateGoals = async () => ({ prioritizedGoals: [] });
  coordinator.analyzeAgentResults = async () => ({ agentCount: 0, insights: [], findings: [] });
  coordinator.auditDeliverables = async () => ({ totalFiles: 0, gaps: [] });
  coordinator.analyzeMemory = async () => ({});
  coordinator.assessSystemHealth = () => ({ cognitiveState: {} });
  coordinator.makeStrategicDecisions = async () => ({ urgentGoals: [spec(SIMILAR), spec(WORK[0])], prioritizedGoals: [], strategicDirectives: [] });
  coordinator.generateReport = async () => ({});
  coordinator.saveReport = async () => {};
  coordinator.saveContext = async () => {};
  const result = await coordinator.conductReview({
    cycleCount: 50, journal: [], goals: goals.export(), goalsSystem: goals,
    memory: { nodes: [], edges: [] }, cognitiveState: {}, roles: {},
  });
  assert.ok(result);
  const created = goals.getGoals().find(item => item.source?.label === 'meta_coordinator_strategic');
  assert.ok(created);
  assert.equal(coordinator.strategicTracker.strategicGoals.get(created.id).spec.description, WORK[0]);
});

test('strategic tracking matches actual agent type and rationale when duplicate descriptions include a prefiltered spec', async (t) => {
  const { coordinator, goals } = coordinatorFixture(t);
  const candidates = [
    { ...spec(WORK[0]), agentType: 'code_execution', priority: 0.7, rationale: 'Run the obsolete validation script.' },
    { ...spec(WORK[0]), agentType: 'research', priority: 0.9, rationale: 'Collect sourced bird migration research.' },
  ];
  const created = await coordinator.injectUrgentGoals(candidates, goals);
  assert.equal(created.length, 1);
  assert.equal(created[0].metadata.agentTypeHint, 'research');
  coordinator.strategicTracker.registerUrgentGoals(100, candidates, created);
  const tracked = coordinator.strategicTracker.strategicGoals.get(created[0].id);
  assert.equal(tracked.spec.description, WORK[0]);
  assert.equal(tracked.spec.agentType, 'research');
  assert.equal(tracked.spec.rationale, 'Collect sourced bird migration research.');
  assert.equal(tracked.spec.priority, 0.9);
});

test('strategic tracking retains urgent and insight registrations from the same review cycle', async (t) => {
  const { coordinator, goals } = coordinatorFixture(t);
  const urgentSpecs = [spec(WORK[0])];
  const insightSpecs = [{ ...spec(WORK[1]), rationale: 'A curator identified a missing mineral chemistry report.' }];
  const urgent = await coordinator.injectUrgentGoals(urgentSpecs, goals);
  const insights = await coordinator.injectUrgentGoals(insightSpecs, goals);
  coordinator.strategicTracker.registerUrgentGoals(100, urgentSpecs, urgent);
  coordinator.strategicTracker.registerUrgentGoals(100, insightSpecs, insights);
  assert.deepEqual([...coordinator.strategicTracker.reviewCycles.get(100)].sort(),
    [urgent[0].id, insights[0].id].sort());
  assert.equal(coordinator.strategicTracker.generateFollowUpReport(100).goalsTracked, 2);
  assert.equal(coordinator.strategicTracker.strategicGoals.get(urgent[0].id).spec.rationale, urgentSpecs[0].rationale);
  assert.equal(coordinator.strategicTracker.strategicGoals.get(insights[0].id).spec.rationale, insightSpecs[0].rationale);
});

test('shared YAML defaults are enabled and seed both closed-topic families', () => {
  const base = yaml.load(fs.readFileSync(new URL('../../../configs/base-engine.yaml', import.meta.url), 'utf8'));
  assert.equal(base.coordinator.strategicGoalGate.enabled, true);
  assert.equal(base.coordinator.strategicGoalGate.similarityThreshold, 0.5);
  assert.equal(base.coordinator.strategicGoalGate.lookbackDays, 14);
  assert.equal(base.coordinator.strategicGoalGate.maxPerReview, 2);
  assert.equal(base.coordinator.strategicGoalGate.maxPerHour, 4);
  const gate = new StrategicGoalGate(base.coordinator, recordingLogger(), { now: () => NOW });
  for (const description of [LIVE_EXAMPLES[0], LIVE_EXAMPLES[3]]) {
    assert.equal(evaluate(gate, description).reason, 'blocked-topic');
  }
});
