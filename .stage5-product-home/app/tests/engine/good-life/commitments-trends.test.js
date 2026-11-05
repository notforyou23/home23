import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { GoodLifeCommitments } = require('../../../engine/src/good-life/commitments.js');
const { GoodLifeTrends } = require('../../../engine/src/good-life/trends.js');

function evaluation() {
  return {
    evaluatedAt: '2026-05-01T15:00:00.000Z',
    lanes: {
      viability: { status: 'healthy', reasons: [] },
      continuity: { status: 'strained', reasons: ['agenda backlog'] },
      usefulness: { status: 'watch', reasons: ['prove output'] },
      development: { status: 'healthy', reasons: [] },
      coherence: { status: 'healthy', reasons: [] },
      friction: { status: 'strained', reasons: ['maintenance ratio'] },
      recovery: { status: 'critical', reasons: ['crash recovery'] },
    },
    policy: { mode: 'recover' },
    evidence: {
      liveProblems: { open: 0 },
      goals: { open: 16 },
      agenda: { pending: 118 },
      publish: { lastUsefulOutputAt: '2026-05-01T14:59:00.000Z' },
      actions: { maintenanceRatio: 0.35 },
    },
  };
}

test('Good Life commitments persist lane-backed durable commitments', () => {
  const dir = mkdtempSync(join(tmpdir(), 'home23-good-life-commitments-'));
  const store = new GoodLifeCommitments({ brainDir: dir });
  const doc = store.update(evaluation());

  assert.equal(doc.schema, 'home23.good-life.commitments.v1');
  assert.ok(doc.commitments.find(c => c.id === 'useful-output'));
  assert.ok(doc.commitments.find(c => c.id === 'recovery').active);
  assert.match(readFileSync(join(dir, 'good-life-commitments.json'), 'utf8'), /useful-output/);
});

test('Good Life trends persist per-lane trends without a scalar score', () => {
  const dir = mkdtempSync(join(tmpdir(), 'home23-good-life-trends-'));
  const trends = new GoodLifeTrends({ brainDir: dir });
  const row = trends.append(evaluation());
  const current = JSON.parse(readFileSync(join(dir, 'good-life-trends-current.json'), 'utf8'));

  assert.equal(row.policy, 'recover');
  assert.equal(row.lanes.recovery, 'critical');
  assert.equal(current.window.lanes.recovery.critical, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(row, 'score'), false);
});
