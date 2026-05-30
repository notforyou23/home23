import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { planConsolidationBacklogCompost } = require('../../../engine/src/memory/consolidation-backlog.js');

test('consolidation backlog compost dry-run reports exact single-summary source groups', () => {
  const memory = {
    nodes: new Map([
      ['s1', { id: 's1', tag: 'consolidated', consolidatedAt: '2026-05-01T00:00:00.000Z', concept: '[CONSOLIDATED] safe summary' }],
      ['a', { id: 'a', tag: 'workspace', consolidatedAt: '2026-05-01T00:00:00.000Z', concept: 'source a' }],
      ['b', { id: 'b', tag: 'reasoning', consolidatedAt: '2026-05-01T00:00:00.000Z', concept: 'source b' }],
      ['m1', { id: 'm1', tag: 'consolidated', consolidatedAt: '2026-05-02T00:00:00.000Z', concept: '[CONSOLIDATED] first summary' }],
      ['m2', { id: 'm2', tag: 'consolidated', consolidatedAt: '2026-05-02T00:00:00.000Z', concept: '[CONSOLIDATED] second summary' }],
      ['c', { id: 'c', tag: 'workspace', consolidatedAt: '2026-05-02T00:00:00.000Z', concept: 'ambiguous source' }],
      ['o', { id: 'o', tag: 'workspace', consolidatedAt: '2026-05-03T00:00:00.000Z', concept: 'orphan source' }],
      ['plain', { id: 'plain', tag: 'workspace', concept: 'not consolidated' }],
    ]),
  };

  const plan = planConsolidationBacklogCompost(memory);

  assert.equal(plan.mode, 'dry-run');
  assert.equal(plan.totalGroups, 3);
  assert.equal(plan.summaryNodes, 3);
  assert.equal(plan.sourceNodes, 4);
  assert.equal(plan.removableGroups, 1);
  assert.equal(plan.removableSourceNodes, 2);
  assert.equal(plan.ambiguousGroups, 1);
  assert.equal(plan.ambiguousSourceNodes, 1);
  assert.equal(plan.orphanSourceGroups, 1);
  assert.equal(plan.orphanSourceNodes, 1);
  assert.deepEqual(plan.groups.map(group => group.consolidatedAt), ['2026-05-01T00:00:00.000Z']);
  assert.deepEqual(plan.groups[0].summaryIds, ['s1']);
  assert.deepEqual(plan.groups[0].sourceIds, ['a', 'b']);
  assert.deepEqual(plan.groups[0].sourceTagCounts, { workspace: 1, reasoning: 1 });
});

test('consolidation backlog compost dry-run can limit group output without changing totals', () => {
  const memory = {
    nodes: new Map([
      ['s1', { id: 's1', tag: 'consolidated', consolidatedAt: 't1' }],
      ['a', { id: 'a', tag: 'workspace', consolidatedAt: 't1' }],
      ['s2', { id: 's2', tag: 'consolidated', consolidatedAt: 't2' }],
      ['b', { id: 'b', tag: 'workspace', consolidatedAt: 't2' }],
    ]),
  };

  const plan = planConsolidationBacklogCompost(memory, { groupLimit: 1 });

  assert.equal(plan.removableGroups, 2);
  assert.equal(plan.removableSourceNodes, 2);
  assert.equal(plan.groups.length, 1);
  assert.equal(plan.outputLimited, true);
});
