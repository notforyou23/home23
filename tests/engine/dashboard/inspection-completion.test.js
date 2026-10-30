import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const express = require('express');
const { receiveLiveProblemFixRecipe } = require('../../../engine/src/dashboard/server.js');
const { prepareAgendaInspection } = require('../../../engine/src/cognition/agenda-learning.js');
const { LiveProblemStore } = require('../../../engine/src/live-problems/store.js');
const logger = { info() {}, warn() {}, error() {} };

test('the production completion HTTP handler authenticates native inspection evidence, preserves it, and is idempotent', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inspection-callback-http-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const brainDir = path.join(root, 'brain'), conversationsDir = path.join(root, 'conversations');
  fs.mkdirSync(brainDir); fs.mkdirSync(conversationsDir); fs.mkdirSync(path.join(root, 'config'));
  const token = 'fixture-existing-bridge-token-at-least-thirty-two-characters';
  fs.writeFileSync(path.join(root, 'config', 'secrets.yaml'), `bridge:\n  token: ${token}\n`);
  const intent = { schema: 'home23.bounded-agenda-intent.v1', operation: 'verify', targetRef: 'memory:briefing',
    question: 'Does the existing fishing briefing run on weekends?', expectedEvidence: 'The actual current schedule of the existing briefing.',
    stopCondition: 'Report the observed schedule or unavailable evidence; make no changes.', evidenceRefs: ['memory:briefing'] };
  const prepared = prepareAgendaInspection({ brainDir, conversationsDir, agentName: 'fixture', problemId: 'agenda_callback', agendaId: 'callback', intent });
  const store = new LiveProblemStore({ brainDir, logger });
  store.upsert({ id: 'agenda_callback', problemKind: 'agenda_handoff', seedOrigin: 'agenda', inspection: intent,
    inspectionEvidenceRefs: intent.evidenceRefs, inspectionExecution: { executionId: prepared.receipt.executionId, receipt: prepared.receipt },
    handoff: { status: 'pending', startedAt: prepared.receipt.ts }, verifier: { type: 'fix_recipe_recorded', args: { problemId: 'agenda_callback' } } });
  store.recordDispatch('agenda_callback', { turnId: 'native-handler-turn' });
  const file = path.join(conversationsDir, 'fixture__inspection_agenda_callback.jsonl');
  const native = () => fs.writeFileSync(file, [
    { type: 'turn', chat_id: 'inspection:agenda_callback', turn_id: 'native-handler-turn', status: 'pending', started_at: prepared.receipt.ts },
    { type: 'turn', chat_id: 'inspection:agenda_callback', turn_id: 'native-handler-turn', status: 'complete', ended_at: new Date().toISOString() },
  ].map(row => JSON.stringify(row) + '\n').join(''));
  const loadLiveProblems = () => JSON.parse(fs.readFileSync(store.filePath, 'utf8'));
  const server = { getHome23AgentContext: () => ({ agentName: 'fixture', home23Root: root, runtimeDir: brainDir }) };
  const services = { liveProblemTarget: () => 'fixture', loadLiveProblems,
    saveLiveProblems: data => fs.writeFileSync(store.filePath, JSON.stringify(data)),
    normalizeDispatchOutcome: value => ['fixed', 'failed', 'blocked', 'unknown'].includes(value) ? value : null,
    normalizeVerifierStatus: value => ['pass', 'fail', 'unknown'].includes(value) ? value : null };
  const app = express(); app.use(express.json());
  app.post('/api/live-problems/:id/fix-recipe', (req, res) => receiveLiveProblemFixRecipe(server, req, res, services));
  const listener = app.listen(0, '127.0.0.1'); await new Promise(resolve => listener.once('listening', resolve));
  t.after(() => new Promise(resolve => listener.close(resolve)));
  const url = `http://127.0.0.1:${listener.address().port}/api/live-problems/agenda_callback/fix-recipe`;
  const body = { summary: 'Observed the existing schedule; made no changes.', turnId: 'native-handler-turn',
    inspectionExecutionId: prepared.receipt.executionId, inspectionCompletionSource: 'agent-loop-terminal', executionStatus: 'completed',
    dispatchOutcome: 'fixed', verifierStatus: 'pass', reportedDispatchOutcome: 'fixed', reportedVerifierStatus: 'pass' };
  const post = (payload = body, authorization = `Bearer ${token}`) => fetch(url, { method: 'POST',
    headers: { 'content-type': 'application/json', authorization }, body: JSON.stringify(payload) });
  assert.equal((await post()).status, 409, 'the authenticated callback is insufficient without native completion');
  native();
  assert.equal((await post(body, '')).status, 409);
  assert.equal((await post(body, 'Bearer forged')).status, 409);
  assert.equal((await post({ ...body, turnId: 'stale-turn' })).status, 409);
  assert.equal((await post({ ...body, inspectionExecutionId: 'other-execution' })).status, 409);
  assert.equal((await post({ ...body, executionStatus: 'failed' })).status, 409, 'a report cannot contradict native completion');
  const response = await post(); assert.equal(response.status, 200);
  const recipe = (await response.json()).fixRecipe;
  assert.equal(recipe.inspectionExecutionId, prepared.receipt.executionId);
  assert.equal(recipe.executionStatus, 'completed');
  assert.equal(recipe.dispatchOutcome, 'unknown', 'inspection does not claim a repair');
  assert.equal(recipe.verifierStatus, 'unknown');
  assert.equal(recipe.reportedDispatchOutcome, 'fixed', 'model claims remain explicitly reported');
  assert.match(recipe.inspectionTerminalDigest, /^[a-f0-9]{64}$/);
  assert.equal((await post()).status, 200);
  assert.equal(loadLiveProblems().problems[0].fixRecipeHistory.length, 1, 'same native terminal retry is idempotent');
  store.reloadIfChanged();
  assert.equal(store.get('agenda_callback').handoff.outcome, 'inspection_completed');
  const outcomes = fs.readFileSync(path.join(brainDir, 'actions.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter(row => row.phase === 'outcome');
  assert.equal(outcomes.length, 1); assert.equal(outcomes[0].status, 'success');
});
