import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { SynthesisAgent } = require('../../../engine/src/agents/synthesis-agent.js');

test('gatherPhaseArtifacts admits only artifacts whose goalId is explicitly scoped', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'home23-synthesis-scope-'));
  const outputsDir = path.join(tmp, 'outputs', 'document-creation');
  const allowedDir = path.join(outputsDir, 'agent_allowed');
  const unrelatedDir = path.join(outputsDir, 'agent_guitar_chord');
  await fs.mkdir(allowedDir, { recursive: true });
  await fs.mkdir(unrelatedDir, { recursive: true });
  const allowedPath = path.join(allowedDir, 'validation.md');
  const unrelatedPath = path.join(unrelatedDir, 'guitar-chord-harness.md');
  await fs.writeFile(allowedPath, '# Scoped validation\n', 'utf8');
  await fs.writeFile(unrelatedPath, '# Guitar chord harness\n', 'utf8');
  await fs.writeFile(path.join(allowedDir, 'manifest.json'), JSON.stringify({
    goalId: 'goal_validation',
    files: [{ path: allowedPath }],
  }), 'utf8');
  await fs.writeFile(path.join(unrelatedDir, 'manifest.json'), JSON.stringify({
    goalId: 'goal_guitar_chord',
    files: [{ path: unrelatedPath }],
  }), 'utf8');

  const agent = Object.create(SynthesisAgent.prototype);
  Object.assign(agent, {
    mission: { metadata: { inputGoalIds: ['goal_validation'] } },
    config: { logsDir: tmp },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  });

  const artifacts = await agent.gatherPhaseArtifacts();
  assert.deepEqual(artifacts.map((artifact) => artifact.path), [allowedPath]);
  assert.equal(artifacts.some((artifact) => artifact.path.includes('guitar-chord')), false);
});

test('gatherPhaseArtifacts rejects a scoped manifest that points outside its producer directory', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'home23-synthesis-ownership-'));
  const outputsDir = path.join(tmp, 'outputs', 'document-creation');
  const producerDir = path.join(outputsDir, 'agent_home23');
  const unrelatedDir = path.join(outputsDir, 'agent_guitar_chord');
  await fs.mkdir(producerDir, { recursive: true });
  await fs.mkdir(unrelatedDir, { recursive: true });
  const producerPath = path.join(producerDir, 'deployment.md');
  const unrelatedPath = path.join(unrelatedDir, 'guitar-chord-harness.md');
  await fs.writeFile(producerPath, '# Home23 deployment\n', 'utf8');
  await fs.writeFile(unrelatedPath, '# Guitar chord harness\n', 'utf8');
  await fs.writeFile(path.join(producerDir, 'manifest.json'), JSON.stringify({
    goalId: 'goal_home23',
    files: [
      { path: producerPath },
      { path: unrelatedPath },
    ],
  }), 'utf8');

  const warnings = [];
  const agent = Object.create(SynthesisAgent.prototype);
  Object.assign(agent, {
    mission: { metadata: { inputGoalIds: ['goal_home23'] } },
    config: { logsDir: tmp },
    logger: { info() {}, warn(...args) { warnings.push(args); }, error() {}, debug() {} },
  });

  const artifacts = await agent.gatherPhaseArtifacts();
  assert.deepEqual(artifacts.map((artifact) => artifact.path), [producerPath]);
  assert.equal(warnings.some(([message]) => message.includes('outside its producing agent directory')), true);
});

test('gatherPhaseArtifacts refuses canonical assembly without input goal scope', async () => {
  const agent = Object.create(SynthesisAgent.prototype);
  Object.assign(agent, {
    mission: { metadata: {} },
    config: { logsDir: '/tmp/unused' },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  });

  await assert.rejects(
    () => agent.gatherPhaseArtifacts(),
    /requires metadata\.inputGoalIds/
  );
});

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
