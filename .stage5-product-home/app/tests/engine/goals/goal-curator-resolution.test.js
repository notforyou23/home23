import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { GoalCurator } = require('../../../engine/src/goals/goal-curator.js');
const {
  createMemoryAuthorityResolver,
  isVerifiedMemoryClosure,
  projectMemoryRelations,
} = require('../../../shared/memory-authority.cjs');
const {
  verifyMemoryAuthorityAttestation,
} = require('../../../shared/memory-authority-attestation.cjs');

const AUTHORITY_KEY = '7'.repeat(64);
const priorAuthorityKey = process.env.HOME23_MEMORY_AUTHORITY_ATTESTATION_KEY;
process.env.HOME23_MEMORY_AUTHORITY_ATTESTATION_KEY = AUTHORITY_KEY;
test.after(() => {
  if (priorAuthorityKey === undefined) delete process.env.HOME23_MEMORY_AUTHORITY_ATTESTATION_KEY;
  else process.env.HOME23_MEMORY_AUTHORITY_ATTESTATION_KEY = priorAuthorityKey;
});

function makeCurator() {
  const writes = [];
  const memory = { async addNode(value) { writes.push(value); return { ...value }; } };
  const goals = { goals: new Map() };
  const logger = { info() {}, warn() {}, error() {}, debug() {} };
  return { curator: new GoalCurator(goals, memory, logger, {}), writes };
}

test('completion emits a bounded resolution receipt even when narrative summary generation has no output', async () => {
  const { curator, writes } = makeCurator();
  const goal = {
    id: 'g1', description: 'Repair brain endpoint', progress: 1, pursuitCount: 3, completionNotes: '',
    incidentId: 'brain-fetch', sourceRefs: ['probe:brain-fetch'], source: 'mcp_action_queue',
  };
  curator.goalNarratives.set(goal.id, {
    goalId: goal.id, birth: { cycle: 2, initialDescription: goal.description }, events: [], deliverables: [], status: 'active',
  });
  curator.generateCompletionSummary = async () => '';

  await curator.onGoalCompleted({ type: 'completed', goalId: goal.id, goal, cycle: 8 });

  assert.equal(writes.length, 1);
  assert.equal(writes[0].type, 'goal_resolution');
  assert.equal(writes[0].status, 'completed');
  assert.equal(writes[0].metadata.goalId, goal.id);
  assert.equal(writes[0].metadata.supersedes_goal_id, goal.id);
  assert.equal(writes[0].metadata.relatedIncidentId, 'brain-fetch');
  assert.equal(Object.hasOwn(writes[0].metadata, 'incidentId'), false);
  assert.deepEqual(writes[0].metadata.supporting_refs, ['probe:brain-fetch']);
  assert.match(writes[0].metadata.receipt_identity, /^goal-curator:/);
  assert.ok(writes[0].metadata.closure_proof_refs.some(ref => ref.startsWith('worker-receipt:goal-curator:')));
  assert.equal(writes[0].metadata.provenance.authorityClass, 'worker_receipt');
  assert.equal(writes[0].metadata.provenance.retrievalDomain, 'closed_incidents');
  assert.ok(writes[0].asserted_at);
  assert.equal(verifyMemoryAuthorityAttestation(writes[0], AUTHORITY_KEY), true);
  assert.equal(isVerifiedMemoryClosure(writes[0]), true);
  assert.equal(goal.resolutionNodeId, writes[0].id);
  assert.deepEqual(projectMemoryRelations(writes[0]).refs.filter(ref => /^(?:goal|incident):/.test(ref)), [
    'goal:g1',
  ]);
});

test('goal completion and automatic archive cannot close a related incident', async () => {
  for (const type of ['completed', 'archived']) {
    const { curator, writes } = makeCurator();
    const goal = {
      id: `goal-${type}`,
      description: 'Track but do not manufacture incident closure',
      incidentId: 'brain-route',
      source: 'query_interface',
      ...(type === 'archived' ? { archiveReason: 'stale goal' } : { completionNotes: 'goal lifecycle ended' }),
    };
    await curator.handleEvent({ type, goalId: goal.id, goal, cycle: 12 });
    const alarm = {
      id: `alarm-${type}`,
      concept: 'Brain route is still failing.',
      status: 'open',
      metadata: { incidentId: 'brain-route' },
    };
    const remaining = createMemoryAuthorityResolver({
      intent: 'current_state',
      authorityCandidates: [alarm, writes[0]],
    }).apply([alarm, writes[0]]);
    assert.equal(remaining.some(node => node.id === alarm.id), true, type);
    assert.equal(projectMemoryRelations(writes[0]).refs.includes('incident:brain-route'), false, type);
  }
});

test('archive emits a resolution receipt without requiring a completion narrative', async () => {
  const { curator, writes } = makeCurator();
  const goal = { id: 'g2', description: 'Retire stale incident', archiveReason: 'superseded by live proof', progress: 0.5, pursuitCount: 1, source: 'mcp_action_queue' };
  curator.goalNarratives.set(goal.id, {
    goalId: goal.id, birth: { cycle: 1, initialDescription: goal.description }, events: [], deliverables: [], status: 'active',
  });

  await curator.onGoalArchived({ type: 'archived', goalId: goal.id, goal, cycle: 9 });

  assert.equal(writes.length, 1);
  assert.equal(writes[0].status, 'archived');
  assert.match(writes[0].concept, /superseded by live proof/);
});

test('completion and archive still emit receipts when the curator has no narrative record', async () => {
  const completed = makeCurator();
  const completedGoal = { id: 'g3', description: 'Close untracked goal', progress: 1, pursuitCount: 1, source: 'mcp_action_queue' };
  await completed.curator.onGoalCompleted({
    type: 'completed', goalId: completedGoal.id, goal: completedGoal, cycle: 10,
  });
  assert.equal(completed.writes.length, 1);
  assert.equal(completed.writes[0].status, 'completed');

  const archived = makeCurator();
  const archivedGoal = { id: 'g4', description: 'Archive untracked goal', archiveReason: 'obsolete', source: 'query_interface' };
  await archived.curator.onGoalArchived({
    type: 'archived', goalId: archivedGoal.id, goal: archivedGoal, cycle: 11,
  });
  assert.equal(archived.writes.length, 1);
  assert.equal(archived.writes[0].status, 'archived');
});

// ---------------------------------------------------------------------------
// Source gate: goal_resolution nodes are a permanent memory record
// (confidence_decay: 1, never decays). Almost every goal in this system is
// machine-initiated (dream, sleep analysis, guided-mode startup missions,
// meta-coordinator gap detection, topic queue, recursive planner, LLM
// thought-action create_goal). Resolving one of those is the goal machinery
// finishing its own bookkeeping -- "a loop ticked", not an event jtr asked
// for. Only goals sourced from the MCP action queue or the dashboard query
// interface are structurally provable as jtr-requested; those still get a
// permanent resolution receipt on completion/archive.
// ---------------------------------------------------------------------------

test('machine-initiated goal completion writes no resolution receipt', async () => {
  const machineSources = [
    undefined,
    'guided_planner',
    'guided_task_phase',
    'dream_gpt5',
    'sleep_analysis_gpt5',
    'meta_coordinator_strategic',
    'topic_queue',
    'recursive_planner',
    'notice_pass',
    'agent:analyst',
    'external',
    { origin: 'unknown', label: 'manual' },
  ];

  for (const source of machineSources) {
    const { curator, writes } = makeCurator();
    const goal = {
      id: 'goal_guided_research_1784162676410',
      description: 'Investigate current best practices for layered agent memory',
      progress: 1,
      pursuitCount: 1,
      source,
    };
    await curator.onGoalCompleted({ type: 'completed', goalId: goal.id, goal, cycle: 3 });
    assert.equal(writes.length, 0, `expected no receipt for source ${JSON.stringify(source)}`);
  }
});

test('machine-initiated goal archive writes no resolution receipt', async () => {
  const { curator, writes } = makeCurator();
  const goal = {
    id: 'goal_4',
    description: 'Create a concrete research deliverable documenting best practices for layered agent memory',
    archiveReason: 'stale',
    source: 'guided_task_phase',
  };
  await curator.onGoalArchived({ type: 'archived', goalId: goal.id, goal, cycle: 4 });
  assert.equal(writes.length, 0);
});

test('user-requested goal completion via MCP action queue writes a resolution receipt', async () => {
  const { curator, writes } = makeCurator();
  const goal = {
    id: 'goal_9', description: 'Set up a nightly backup of the vault', progress: 1, pursuitCount: 2,
    source: 'mcp_action_queue',
  };
  await curator.onGoalCompleted({ type: 'completed', goalId: goal.id, goal, cycle: 5 });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].status, 'completed');
});

test('user-requested goal completion via dashboard query interface writes a resolution receipt', async () => {
  const { curator, writes } = makeCurator();
  const goal = {
    id: 'goal_10', description: 'Track down the missing invoice', progress: 1, pursuitCount: 1,
    source: { origin: 'query_interface', label: 'query_interface' },
  };
  await curator.onGoalCompleted({ type: 'completed', goalId: goal.id, goal, cycle: 6 });
  assert.equal(writes.length, 1);
});
