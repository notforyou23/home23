import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
process.env.OPENAI_API_KEY ||= 'test-key';
const { MetaCoordinator } = require('../../../engine/src/coordinator/meta-coordinator.js');

const logger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

test('MetaCoordinator stores context under the agent-local logs directory', () => {
  const logsDir = path.join(os.tmpdir(), `home23-coordinator-${Date.now()}`);
  const coordinator = new MetaCoordinator({ logsDir, coordinator: { enabled: true } }, logger);

  assert.equal(coordinator.coordinatorDir, path.join(logsDir, 'coordinator'));
});

test('MetaCoordinator preserves claim intake for goal-driven document missions', async () => {
  const logsDir = path.join(os.tmpdir(), `home23-coordinator-${Date.now()}`);
  const coordinator = new MetaCoordinator({ logsDir, coordinator: { enabled: true } }, logger);
  coordinator.gpt5 = {
    async generateWithRetry() {
      return {
        content: JSON.stringify({
          agentType: 'document_creation',
          description: 'Create a structured checkpoint report comparing normal and osteoporotic bone demineralization rates.',
          successCriteria: ['Save a sourced checkpoint report.'],
          maxDurationMinutes: 15,
          rationale: 'The goal requires a concrete report deliverable.'
        })
      };
    }
  };

  const goal = {
    id: 'goal_doc',
    description: 'Create a structured document synthesizing comparative demineralization rates of normal vs. osteoporotic bone into a checkpoint report.',
    priority: 0.9,
    progress: 0,
    metadata: {
      agentTypeHint: 'document_creation'
    }
  };

  const mission = await coordinator.createMissionSpec(goal, 7137);

  assert.equal(mission.agentType, 'document_creation');
  assert.match(mission.intake.claimText, /comparative demineralization rates/);
  assert.equal(mission.metadata.claimText, mission.intake.claimText);
  assert.equal(mission.metadata.intakeSource, 'goal_description');
});
