import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { SynthesisAgent } = require('../../../engine/src/agents/synthesis-agent.js');

test('writeFinalDeliverable writes capability output to the announced absolute path', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'home23-synthesis-'));
  const writes = [];
  const agent = Object.create(SynthesisAgent.prototype);
  Object.assign(agent, {
    mission: {
      goalId: null,
      taskId: 'task:synthesis_final',
      spawnCycle: 1,
      metadata: { isFinalSynthesis: true },
    },
    config: { logsDir: tmp },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    agentId: 'agent_path_test',
  });
  agent.capabilities = {
    async writeFile(filePath, content) {
      writes.push(filePath);
      assert.equal(path.isAbsolute(filePath), true);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, content, 'utf8');
      return { success: true };
    },
  };

  const outputPath = await agent.writeFinalDeliverable('# Final\n', {
    type: 'markdown',
    filename: 'ai-os-research.md',
    location: '@outputs/',
  });

  assert.equal(outputPath, path.join(tmp, 'outputs', 'synthesis', 'agent_path_test', 'ai-os-research.md'));
  assert.equal(await fs.readFile(outputPath, 'utf8'), '# Final\n');
  assert.equal(await fs.readFile(path.join(path.dirname(outputPath), 'manifest.json'), 'utf8').then(Boolean), true);
  assert.equal(writes.includes(outputPath), true);
  assert.equal(writes.includes(path.join(path.dirname(outputPath), 'manifest.json')), true);
});
