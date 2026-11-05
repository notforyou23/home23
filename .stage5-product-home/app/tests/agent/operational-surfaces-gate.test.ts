/**
 * AGENCY / WORKERS load gate — 2026-08-11 greeting failure follow-up.
 *
 * These operational surfaces used to ride every turn at 0.98 / 0.9 salience.
 * A social turn then inherited the resident-agency brief (pursuits,
 * Chronesthesia next-moves) and let it steer the greeting. K2 is law:
 * first-turn wake-up stays; later turns earn admission by cues or meaning.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  AGENCY_MEANING_ANCHORS,
  WORKER_MEANING_ANCHORS,
  assembleContext,
  shouldLoadOperationalSurface,
} from '../../src/agent/context-assembly.js';

const emptySearch = async () => ({
  results: [],
  sourceEvidence: { sourceHealth: 'healthy', matchOutcome: 'no_match' },
});

const cueSearch = async () => ({
  results: [{ concept: 'dashboard publish loop', similarity: 0.82, tag: 'ops' }],
  sourceEvidence: { sourceHealth: 'healthy', matchOutcome: 'matches' },
});

function agentInstall(): { root: string; workspacePath: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'home23-ops-gate-'));
  const workspacePath = path.join(root, 'instances', 'jerry', 'workspace');
  const agencyDir = path.join(root, 'instances', 'jerry', 'brain', 'agency');
  const workersDir = path.join(root, 'instances', 'workers', 'systems');
  mkdirSync(workspacePath, { recursive: true });
  mkdirSync(agencyDir, { recursive: true });
  mkdirSync(workersDir, { recursive: true });
  mkdirSync(path.join(root, 'instances', 'jerry', 'brain'), { recursive: true });

  writeFileSync(path.join(agencyDir, 'state.json'), JSON.stringify({
    schema: 'home23.agency.state.v1',
    agent: 'jerry',
    mode: 'dry_run',
    attention: { currentPursuitId: 'ap_chrono', queueDepth: 2, activePursuits: 1, maxActivePursuits: 3 },
  }));
  writeFileSync(path.join(agencyDir, 'pursuits.jsonl'), `${JSON.stringify({
    type: 'created',
    pursuit: {
      id: 'ap_chrono',
      status: 'active',
      title: 'Chronesthesia II Applied Unit 3',
      authorityLevel: 'L2',
      nextMove: 'advance_one_step',
      desiredChangedFuture: 'Applied Unit 3 is finished with a receipt.',
    },
  })}\n`);
  writeFileSync(path.join(workersDir, 'worker.yaml'), [
    'kind: worker',
    'name: systems',
    'ownerAgent: jerry',
    'class: ops',
    'purpose: Diagnose host issues.',
    'visibleTo:',
    '  - jerry',
  ].join('\n'));
  writeFileSync(path.join(root, 'instances', 'jerry', 'brain', 'worker-runs.jsonl'), `${JSON.stringify({
    runId: 'wr_ops_1',
    worker: 'systems',
    status: 'no_change',
    verifierStatus: 'pass',
    summary: 'Checked host signal.',
  })}\n`);

  return { root, workspacePath };
}

async function assemble(
  workspacePath: string,
  userText: string,
  recentTurns: Array<{ role: string; content: string }>,
  opts: {
    contextSearch?: typeof emptySearch;
    semanticEmbed?: (t: string) => number[] | null;
  } = {},
) {
  return assembleContext(
    userText,
    'chat-ops',
    recentTurns,
    {
      workspacePath,
      brainDir: path.join(workspacePath, '..', 'brain'),
      enginePort: 5002,
      sessionId: 'chat-ops',
      signal: new AbortController().signal,
      brainSearchTimeoutMs: 1000,
      contextSearch: opts.contextSearch ?? emptySearch,
      semanticEmbed: opts.semanticEmbed ?? (() => null),
    },
  );
}

// ─── Unit: shouldLoadOperationalSurface ─────────────────────────────────────

test('operational gate: first turn always admits (wake-up)', () => {
  assert.equal(shouldLoadOperationalSurface({
    isFirstTurn: true,
    degraded: false,
    brainCueCount: 0,
    triggerCount: 0,
    turnText: 'Evening. What\'s good',
    matchText: 'Evening. What\'s good',
    label: 'AGENCY',
    anchors: AGENCY_MEANING_ANCHORS,
    semanticEmbed: () => null,
  }), true);
});

test('operational gate: a mid-session social turn with no cues stays silent', () => {
  assert.equal(shouldLoadOperationalSurface({
    isFirstTurn: false,
    degraded: false,
    brainCueCount: 0,
    triggerCount: 0,
    turnText: 'Evening jerry. What\'s good',
    matchText: 'Evening jerry. What\'s good prior hello',
    label: 'AGENCY',
    anchors: AGENCY_MEANING_ANCHORS,
    semanticEmbed: () => null,
  }), false);
});

test('operational gate: brain cues or trigger matches admit without meaning', () => {
  assert.equal(shouldLoadOperationalSurface({
    isFirstTurn: false,
    degraded: false,
    brainCueCount: 1,
    triggerCount: 0,
    turnText: 'ok',
    matchText: 'ok',
    label: 'AGENCY',
    anchors: AGENCY_MEANING_ANCHORS,
  }), true);
  assert.equal(shouldLoadOperationalSurface({
    isFirstTurn: false,
    degraded: false,
    brainCueCount: 0,
    triggerCount: 1,
    turnText: 'ok',
    matchText: 'ok',
    label: 'WORKERS',
    anchors: WORKER_MEANING_ANCHORS,
  }), true);
});

test('operational gate: substring meaning earns mid-session admission (degraded embedder)', () => {
  assert.equal(shouldLoadOperationalSurface({
    isFirstTurn: false,
    degraded: false,
    brainCueCount: 0,
    triggerCount: 0,
    turnText: 'what is your current pursuit next move?',
    matchText: 'what is your current pursuit next move?',
    label: 'AGENCY',
    anchors: AGENCY_MEANING_ANCHORS,
    semanticEmbed: () => null,
  }), true);
  assert.equal(shouldLoadOperationalSurface({
    isFirstTurn: false,
    degraded: false,
    brainCueCount: 0,
    triggerCount: 0,
    turnText: 'any worker receipt from systems today?',
    matchText: 'any worker receipt from systems today?',
    label: 'WORKERS',
    anchors: WORKER_MEANING_ANCHORS,
    semanticEmbed: () => null,
  }), true);
});

test('operational gate: semantic meaning fires without a keyword substring', () => {
  const DIM = 16;
  const axis = (i: number) => {
    const v = new Array<number>(DIM).fill(0);
    v[i] = 1;
    return v;
  };
  const embed = (text: string): number[] | null => {
    if (/AGENCY:|line of work|standing aims/i.test(text)) return axis(0);
    if (/weather|sunset/i.test(text)) return axis(7);
    return null;
  };
  assert.equal(shouldLoadOperationalSurface({
    isFirstTurn: false,
    degraded: false,
    brainCueCount: 0,
    triggerCount: 0,
    turnText: 'remind me what standing aims you are advancing right now as a line of work',
    matchText: 'remind me what standing aims you are advancing right now as a line of work',
    label: 'AGENCY',
    anchors: AGENCY_MEANING_ANCHORS,
    semanticEmbed: embed,
  }), true);
  assert.equal(shouldLoadOperationalSurface({
    isFirstTurn: false,
    degraded: false,
    brainCueCount: 0,
    triggerCount: 0,
    turnText: 'how is the weather looking for the sunset tonight around here',
    matchText: 'how is the weather looking for the sunset tonight around here',
    label: 'AGENCY',
    anchors: AGENCY_MEANING_ANCHORS,
    semanticEmbed: embed,
  }), false);
});

// ─── Integration: assembleContext ───────────────────────────────────────────

test('assembleContext: first turn still wakes with AGENCY + WORKERS', async () => {
  const { root, workspacePath } = agentInstall();
  try {
    const result = await assemble(workspacePath, 'Evening. What\'s good', []);
    assert.ok(result.surfacesLoaded.includes('AGENCY'), `surfaces=${result.surfacesLoaded.join(',')}`);
    assert.ok(result.surfacesLoaded.includes('WORKERS'), `surfaces=${result.surfacesLoaded.join(',')}`);
    assert.match(result.block, /Chronesthesia II Applied Unit 3/);
    assert.match(result.block, /systems/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('assembleContext: mid-session greeting does not load AGENCY or WORKERS', async () => {
  const { root, workspacePath } = agentInstall();
  try {
    const result = await assemble(
      workspacePath,
      'Evening jerry. What\'s good',
      [{ role: 'user', content: 'earlier hello' }, { role: 'assistant', content: 'hey' }],
    );
    assert.ok(!result.surfacesLoaded.includes('AGENCY'), 'AGENCY must stay silent on a social turn');
    assert.ok(!result.surfacesLoaded.includes('WORKERS'), 'WORKERS must stay silent on a social turn');
    assert.doesNotMatch(result.block, /Chronesthesia II Applied Unit 3/);
    assert.doesNotMatch(result.block, /Resident Agency/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('assembleContext: mid-session pursuit question loads AGENCY by meaning', async () => {
  const { root, workspacePath } = agentInstall();
  try {
    const result = await assemble(
      workspacePath,
      'What is your current pursuit and next move?',
      [{ role: 'user', content: 'earlier hello' }],
    );
    assert.ok(result.surfacesLoaded.includes('AGENCY'));
    assert.match(result.block, /Chronesthesia II Applied Unit 3/);
    assert.ok(!result.surfacesLoaded.includes('WORKERS'), 'unrelated WORKERS stays silent');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('assembleContext: mid-session brain cues still admit the operational spine', async () => {
  const { root, workspacePath } = agentInstall();
  try {
    const result = await assemble(
      workspacePath,
      'ok continue',
      [{ role: 'user', content: 'earlier' }],
      { contextSearch: cueSearch },
    );
    assert.ok(result.surfacesLoaded.includes('AGENCY'));
    assert.ok(result.surfacesLoaded.includes('WORKERS'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
