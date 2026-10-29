import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENCY_MEANING_ANCHORS, assembleContext, buildAgencyContextSection } from '../../src/agent/context-assembly.js';
import { EventLedger } from '../../src/agent/event-ledger.js';
import { resetSemanticMatchCache } from '../../src/substrate/semantic-match.js';
import { applyLearningFeedback, emptyLearningState, recordLearningDecision } from '../../shared/seed-learning.cjs';
import type { LearningDecision, LearningSnapshot } from '../../shared/seed-learning.cjs';
import type { AssemblyResult, EventEnvelope } from '../../src/types.js';

const question = 'What interesting directions are drawing your attention right now?';
const observedAt = '2026-10-29T21:00:00.000Z';

function fixture(t: { after(fn: () => void): void }) {
  resetSemanticMatchCache();
  const root = mkdtempSync(join(tmpdir(), 'agency-status-learning-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspacePath = join(root, 'instances', 'resident', 'workspace');
  const brainDir = join(root, 'instances', 'resident', 'brain');
  const agencyDir = join(brainDir, 'agency');
  const seedDir = join(root, 'seed');
  mkdirSync(workspacePath, { recursive: true });
  mkdirSync(agencyDir, { recursive: true });
  mkdirSync(seedDir);
  const statePath = join(agencyDir, 'state.json');
  const pursuitsPath = join(agencyDir, 'pursuits.jsonl');
  writeFileSync(statePath, JSON.stringify({ schema: 'home23.agency.state.v1', agent: 'resident', mode: 'dry_run',
    attention: { currentPursuitId: 'p_music', queueDepth: 42 },
    nextAction: { kind: 'inspect', pursuitId: 'p_music', reason: 'Find a sourced passage.' },
    organs: { clock: { kind: 'scheduler', commandSurface: 'scheduler tools' } },
    governance: { promptContracts: { research: { promptText: 'Preserve source references.' } } },
  }));
  writeFileSync(pursuitsPath, JSON.stringify({ type: 'created', pursuit: {
    id: 'p_music', status: 'active', title: 'Explore the transition into a Dead jam', authorityLevel: 'L1',
    nextMove: 'Listen to one passage and identify the turning point.',
    desiredChangedFuture: 'Understand how the band makes room for a new musical direction.',
  } }) + '\n');
  const original = [statePath, pursuitsPath].map(path => [path, readFileSync(path, 'utf8')] as const);
  let learning: LearningSnapshot = { version: 1, available: true, decisions: [], lessons: [] };
  const embedded: string[] = [];
  const config = { workspacePath, brainDir, substrateStateDir: seedDir, enginePort: 0, sessionId: 'personal-context',
    signal: new AbortController().signal,
    contextSearch: async () => ({ results: [], sourceEvidence: { sourceHealth: 'healthy', matchOutcome: 'no_match' } }),
    semanticEmbed: (text: string) => { embedded.push(text); return Array.from({ length: 16 }, (_, i) => i === 0 ? 1 : 0); },
    readLearning: () => learning,
  };
  return { root, brainDir, config, original, embedded,
    setLearning(snapshot: LearningSnapshot) { learning = snapshot; } };
}

function decisionFor(result: AssemblyResult, surface: string): EventEnvelope {
  const event = result.events.find(event => event.event_type === 'LearningDecisionObserved'
    && (event.payload.sourceRefs as string[]).includes(`surface:${surface}`));
  assert.ok(event, `missing actual decision for ${surface}`);
  return event;
}

function delivery(result: AssemblyResult) {
  const receipt = result.events.find(event => event.event_type === 'RetrievalExecuted');
  assert.ok(receipt);
  return receipt;
}

function taughtSnapshot(decision: LearningDecision): LearningSnapshot {
  const recorded = recordLearningDecision(emptyLearningState(), { ...decision, observedAt });
  assert.equal(recorded.applied, true);
  const taught = applyLearningFeedback(recorded.state, {
    schema: 'home23.learning-feedback.v1', decisionId: decision.decisionId, scope: decision.scope,
    direction: 'attenuate', tags: decision.tags, excludes: ['requested'],
    evidenceRefs: ['owner:machine-status-correction'], basis: 'owner-feedback', standing: true,
  }, { feedbackId: 'owner:machine-status-correction', observedAt, ownerAuthenticated: true });
  assert.equal(taught.applied, true, taught.reason);
  return { version: 1, available: true, decisions: taught.state.decisions, lessons: taught.state.lessons };
}

test('status-only owner teaching changes actual delivery without suppressing meaningful pursuit context', async t => {
  const f = fixture(t);
  const ledger = new EventLedger(f.brainDir);
  const before = await assembleContext(question, 'personal-context', [], f.config, ledger);
  assert.ok(before.surfacesLoaded.includes('AGENCY_STATUS'));
  assert.ok(before.surfacesLoaded.includes('AGENCY'));
  assert.match(before.block, /Stored planning queue depth: 42/);
  assert.match(before.block, /Explore the transition into a Dead jam/);
  const status = decisionFor(before, 'AGENCY_STATUS');
  const pursuits = decisionFor(before, 'AGENCY');
  assert.deepEqual(status.payload.tags, ['operational', 'agency', 'agency_status', 'automatic']);
  assert.deepEqual(pursuits.payload.tags, ['operational', 'agency', 'agency_pursuits', 'automatic']);
  for (const event of [status, pursuits]) {
    assert.equal(event.payload.choice, 'admit');
    assert.equal(event.payload.relevant, true);
    assert.equal(event.payload.explicit, false);
  }
  assert.deepEqual(f.embedded.filter(text => text.startsWith('AGENCY')),
    [`AGENCY: ${AGENCY_MEANING_ANCHORS.join(', ')}`], 'both components reuse the exact previous relevance anchor');
  assert.equal((status.payload.behavior as { component: string }).component, 'routine-operational-status');
  assert.equal((pursuits.payload.behavior as { component: string }).component, 'pursuit-context');
  const beforeReceipt = delivery(before);
  const observedIds = before.events.filter(event => event.event_type === 'LearningDecisionObserved').map(event => event.event_id);
  assert.deepEqual(beforeReceipt.payload.learningDecisionIds, observedIds);
  const raw = readFileSync(join(f.brainDir, 'event-ledger.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(raw.filter(event => observedIds.includes(event.event_id)).length, observedIds.length,
    'delivery references each exact durable decision once');

  const snapshot = taughtSnapshot(status.payload as unknown as LearningDecision);
  f.setLearning(snapshot);
  const after = await assembleContext(question, 'personal-context', [], f.config, ledger);
  const afterStatus = decisionFor(after, 'AGENCY_STATUS');
  const afterPursuits = decisionFor(after, 'AGENCY');
  assert.equal(afterStatus.payload.choice, 'omit');
  assert.equal(afterStatus.payload.relevant, true);
  assert.equal(afterStatus.payload.explicit, false);
  assert.deepEqual((afterStatus.payload.learning as { lessonIds: string[] }).lessonIds, [snapshot.lessons[0].lessonId]);
  assert.equal(afterPursuits.payload.choice, 'admit');
  assert.deepEqual((afterPursuits.payload.learning as { lessonIds: string[] }).lessonIds, []);
  assert.ok(!after.surfacesLoaded.includes('AGENCY_STATUS'));
  assert.ok(after.surfacesLoaded.includes('AGENCY'));
  assert.doesNotMatch(after.block, /Stored planning queue depth|Mode: dry_run|Body organs:|Prompt contracts:/);
  assert.match(after.block, /Explore the transition into a Dead jam/);
  assert.match(after.block, /do not establish that work is running or that an objective is verified/);
  const afterReceipt = delivery(after);
  assert.ok((afterReceipt.payload.learningDecisionIds as string[]).includes(afterStatus.event_id));
  assert.ok(!(afterReceipt.payload.surface_delivery as Array<{ surface: string }>).some(row => row.surface === 'AGENCY_STATUS'));
  assert.ok((afterReceipt.payload.surface_delivery as Array<{ surface: string; delivered_chars: number }>).some(row => row.surface === 'AGENCY' && row.delivered_chars > 0));

  f.setLearning({ ...snapshot, lessons: [] });
  const control = await assembleContext(question, 'personal-context', [], f.config);
  assert.ok(control.surfacesLoaded.includes('AGENCY_STATUS'), 'removing only the lesson restores otherwise eligible status');
  assert.match(control.block, /Stored planning queue depth: 42/);
  for (const [path, bytes] of f.original) assert.equal(readFileSync(path, 'utf8'), bytes);
});

test('a direct agency request still delivers status and pursuits after status-only teaching', async t => {
  const f = fixture(t);
  const before = await assembleContext(question, 'personal-context', [], f.config);
  f.setLearning(taughtSnapshot(decisionFor(before, 'AGENCY_STATUS').payload as unknown as LearningDecision));
  const requested = await assembleContext('Show the agency pursuit and next move.', 'personal-context', [], f.config);
  const choice = decisionFor(requested, 'AGENCY_STATUS');
  assert.equal(choice.payload.explicit, true);
  assert.equal(choice.payload.choice, 'admit');
  assert.ok(requested.surfacesLoaded.includes('AGENCY_STATUS'));
  assert.ok(requested.surfacesLoaded.includes('AGENCY'));
  assert.match(requested.block, /Stored planning queue depth: 42/);
  assert.match(requested.block, /Explore the transition into a Dead jam/);
});

test('legacy broad agency lessons retain their applicability to both new component choices', async t => {
  const f = fixture(t);
  f.setLearning(taughtSnapshot({ schema: 'home23.learning-decision.v1', decisionId: 'context:legacy-bundled-agency',
    scope: 'foreground.context', criterion: 'owner-value', tags: ['operational', 'agency', 'automatic'],
    sourceRefs: ['surface:AGENCY'] }));
  const result = await assembleContext(question, 'personal-context', [], f.config);
  assert.equal(decisionFor(result, 'AGENCY_STATUS').payload.choice, 'omit');
  assert.equal(decisionFor(result, 'AGENCY').payload.choice, 'omit');
  assert.ok(!result.surfacesLoaded.includes('AGENCY_STATUS'));
  assert.ok(!result.surfacesLoaded.includes('AGENCY'));
});

test('failed durable decisions cannot be cited as successful delivery witnesses', async t => {
  const f = fixture(t);
  mkdirSync(join(f.brainDir, 'event-ledger.jsonl'));
  const ledger = new EventLedger(f.brainDir);
  const failed = await assembleContext(question, 'personal-context', [], f.config, ledger);
  assert.equal(failed.events.filter(event => event.event_type === 'LearningDecisionObserved').length, 0);
  assert.equal(failed.events.filter(event => event.event_type === 'LearningDecisionProjectionDeferred').length, 3);
  assert.deepEqual(delivery(failed).payload.learningDecisionIds, []);
  assert.ok(!failed.surfacesLoaded.includes('AGENCY_STATUS'));
  assert.ok(!failed.surfacesLoaded.includes('AGENCY'));
  const requested = await assembleContext('Show the agency pursuit and next move.', 'personal-context', [], f.config, ledger);
  assert.ok(requested.surfacesLoaded.includes('AGENCY_STATUS'), 'requested information remains available');
  assert.deepEqual(delivery(requested).payload.learningDecisionIds, [], 'a requested fallback cannot manufacture a recorded decision');
});

test('the existing full agency renderer retains status, pursuit detail and execution safeguards', t => {
  const f = fixture(t);
  const full = buildAgencyContextSection(f.root, 'resident');
  assert.match(full, /Mode: dry_run/);
  assert.match(full, /Stored planning queue depth: 42/);
  assert.match(full, /Body organs:/);
  assert.match(full, /Prompt contracts:/);
  assert.match(full, /Explore the transition into a Dead jam/);
  assert.match(full, /execution=unknown/);
  assert.match(full, /planning record, not an execution receipt/);
});
