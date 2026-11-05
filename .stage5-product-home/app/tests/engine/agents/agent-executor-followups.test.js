import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AgentExecutor } = require('../../../engine/src/agents/agent-executor');

function makeExecutor({ coordinator = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-agent-followups-'));
  const added = [];
  const logs = [];
  const executor = new AgentExecutor(
    {
      memory: { embed: async () => null },
      goals: {
        async addGoal(goal) {
          added.push(goal);
          return `goal_${added.length}`;
        },
        archivedGoals: [],
        completedGoals: [],
      },
      pathResolver: null,
    },
    {
      logsDir: dir,
      coordinator,
      frontierGate: { enabled: false },
    },
    {
      info: (...args) => logs.push(['info', ...args]),
      warn: (...args) => logs.push(['warn', ...args]),
      error: (...args) => logs.push(['error', ...args]),
      debug: (...args) => logs.push(['debug', ...args]),
    }
  );

  return { executor, added, logs, dir };
}

test('regular agent synthesis follow-ups create bounded durable goals', async () => {
  const { executor, added, dir } = makeExecutor();
  executor.registry.agents.set('agent_regular', {
    mission: {
      triggerSource: 'meta_coordinator',
      metadata: {},
    },
  });

  await executor.createFollowUpGoals([
    {
      type: 'synthesis',
      followUp: [
        'Investigate a concrete operator issue with a clear next verification step.',
        'Review a second concrete issue with a clear next verification step.',
        'Check a third concrete issue with a clear next verification step.',
        'This fourth direction should not become a goal because the cap is three.',
      ],
    },
  ], 'agent_regular');

  assert.equal(added.length, 3);
  assert.equal(added[0].source, 'follow_up_from_agent_regular');
  assert.equal(added[0].parentAgent, 'agent_regular');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('thought-action investigation follow-ups do not create durable goals by default', async () => {
  const { executor, added, logs, dir } = makeExecutor();
  executor.registry.agents.set('agent_thought', {
    mission: {
      triggerSource: 'thought_action_investigate',
      metadata: { source: 'thought_action_parser' },
    },
  });

  await executor.createFollowUpGoals([
    {
      type: 'synthesis',
      followUp: [
        'Explore alternative explanations for an internal RECENT.md cycle gap.',
        'Analyze documentation history for this internal runtime question.',
      ],
    },
  ], 'agent_thought');

  assert.equal(added.length, 0);
  assert.ok(logs.some(entry => entry[1] === 'Skipping durable follow-up goals for ephemeral investigation agent'));

  fs.rmSync(dir, { recursive: true, force: true });
});

test('thought-action investigation follow-ups can be explicitly enabled', async () => {
  const { executor, added, dir } = makeExecutor({
    coordinator: { allowThoughtActionFollowUpGoals: true },
  });
  executor.registry.agents.set('agent_thought_enabled', {
    mission: {
      triggerSource: 'thought_action_investigate',
      metadata: { source: 'thought_action_parser' },
    },
  });

  await executor.createFollowUpGoals([
    {
      type: 'synthesis',
      followUp: [
        'Produce a concrete follow-up goal when this experimental setting is enabled.',
      ],
    },
  ], 'agent_thought_enabled');

  assert.equal(added.length, 1);
  assert.equal(added[0].source, 'follow_up_from_agent_thought_enabled');

  fs.rmSync(dir, { recursive: true, force: true });
});
