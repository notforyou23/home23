import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AgentExecutor } = require('../../../engine/src/agents/agent-executor');

class FakeAgent extends EventEmitter {
  constructor(mission) {
    super();
    this.mission = mission;
    this.agentId = 'agent-test-1';
    this.agentType = mission.agentType;
    this.status = 'initialized';
    this.startTime = new Date();
    this.endTime = null;
    this.results = [];
    this.errors = [];
  }

  async run() {
    this.status = 'completed';
    this.endTime = new Date();
    this.emit('complete');
    return {
      agentId: this.agentId,
      agentType: this.agentType,
      mission: this.mission,
      status: 'completed',
      duration: 0,
      durationFormatted: '0s',
      results: [],
    };
  }
}

test('agent spawn records goal pursuit in evaluation metrics', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-agent-executor-'));
  const pursued = [];
  const spawned = [];
  const goal = { id: 'goal_1', pursuitCount: 0 };

  const executor = new AgentExecutor(
    {
      memory: { embed: async () => null },
      goals: {
        getGoal: () => goal,
        upsertExternalGoal: () => goal,
        archivedGoals: [],
        completedGoals: [],
      },
      pathResolver: null,
    },
    {
      logsDir: dir,
      coordinator: { maxConcurrent: 2 },
      frontierGate: { enabled: false },
    },
    {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
    {
      trackAgentSpawned: (...args) => spawned.push(args),
      trackGoalPursued: (...args) => pursued.push(args),
      trackAgentCompleted: () => {},
      trackAgentFailed: () => {},
    }
  );

  await executor.initialize();
  executor.registerAgentType('analysis', FakeAgent);

  const agentId = await executor.spawnAgent({
    missionId: 'mission_1',
    agentType: 'analysis',
    goalId: 'goal_1',
    description: 'Analyze the live goal execution path.',
    spawnCycle: 42,
    triggerSource: 'orchestrator',
  });

  assert.equal(agentId, 'agent-test-1');
  assert.equal(spawned.length, 1);
  assert.deepEqual(pursued, [['goal_1', 'analysis', 'agent-test-1']]);

  fs.rmSync(dir, { recursive: true, force: true });
});
