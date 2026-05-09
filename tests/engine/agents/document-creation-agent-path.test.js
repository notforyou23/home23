import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { DocumentCreationAgent } = require('../../../engine/src/agents/document-creation-agent.js');

test('saveDocument writes PathResolver deliverables through capabilities using absolute paths', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'home23-doc-agent-path-'));
  const outputPath = path.join(dir, 'outputs', 'digest-1.md');
  const calls = [];
  process.env.OPENAI_API_KEY ||= 'test-key';

  const agent = new DocumentCreationAgent({
    goalId: 'goal_force',
    description: 'Produce outputs/digest-1.md',
    deliverable: {
      location: '@outputs/',
      filename: 'digest-1.md',
      type: 'report',
      format: 'markdown',
    },
  }, { logsDir: dir }, { info() {}, warn() {}, error() {}, debug() {} });

  agent.pathResolver = {
    getDeliverablePath() {
      return {
        fullPath: outputPath,
        relativePath: path.relative(process.cwd(), outputPath),
        directory: path.dirname(outputPath),
        filename: 'digest-1.md',
        isAccessible: false,
        logicalLocation: '@outputs/',
      };
    },
  };
  agent.capabilities = {
    async writeFile(logicalPath, content) {
      calls.push(logicalPath);
      assert.equal(path.isAbsolute(logicalPath), true);
      await fs.mkdir(path.dirname(logicalPath), { recursive: true });
      await fs.writeFile(logicalPath, content, 'utf8');
      return { success: true, path: logicalPath };
    },
  };

  try {
    const saved = await agent.saveDocument({
      title: 'Generated report',
      content: '# Digest\n\nA concrete output.',
      metadata: {},
    }, {
      type: 'report',
      format: 'markdown',
      audience: 'operator',
      purpose: 'digest',
      requirements: [],
    });

    assert.equal(saved.filePath, outputPath);
    assert.equal(saved.deliverablePath, outputPath);
    assert.equal(calls.length, 2);
    assert.equal(calls[0], outputPath);
    assert.equal(calls[1], path.join(dir, 'outputs', 'digest-1_metadata.json'));
    assert.equal(await fs.readFile(outputPath, 'utf8'), '# Digest\n\nA concrete output.');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
