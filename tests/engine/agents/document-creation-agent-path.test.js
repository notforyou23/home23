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

test('saveDocument fallback writes capabilities outputs to the resolved absolute path', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'home23-doc-agent-fallback-'));
  const calls = [];
  process.env.OPENAI_API_KEY ||= 'test-key';

  const agent = new DocumentCreationAgent({
    goalId: 'goal_doc',
    description: 'Write a report.',
  }, { logsDir: dir }, { info() {}, warn() {}, error() {}, debug() {} });

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
      content: '# Report\n\nA concrete output.',
      metadata: {},
    }, {
      type: 'report',
      format: 'markdown',
      audience: 'operator',
      purpose: 'report',
      requirements: [],
    });

    assert.equal(saved.filePath.startsWith(path.join(dir, 'outputs', 'document-creation')), true);
    assert.equal(saved.deliverablePath, saved.filePath);
    assert.equal(calls.length, 2);
    assert.equal(calls[0], saved.filePath);
    assert.equal(calls[1], saved.metadataPath);
    assert.equal(await fs.readFile(saved.filePath, 'utf8'), '# Report\n\nA concrete output.');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('force-output document missions bypass claim intake and emit deliverables', async () => {
  process.env.OPENAI_API_KEY ||= 'test-key';
  const agent = new DocumentCreationAgent({
    goalId: 'goal_force',
    triggerSource: 'force_output',
    spawningReason: 'force_output_back_pressure',
    metadata: { forceOutput: true },
    description: 'Produce outputs/digest-6427.md. Synthesize these findings from recent memory.',
    deliverable: {
      location: '@outputs/',
      filename: 'digest-6427.md',
      type: 'report',
      format: 'markdown',
    },
  }, { logsDir: os.tmpdir() }, { info() {}, warn() {}, error() {}, debug() {} });

  let generated = false;
  agent.memory = { nodes: new Map([[1, { concept: 'finding' }], [2, { concept: 'finding' }], [3, { concept: 'finding' }]]) };
  agent.documentManager = { initialize: async () => {}, setCapabilities() {} };
  agent.loadDefaultTemplates = async () => {};
  agent.queryMemoryForKnowledge = async () => [];
  agent.parseDocumentRequirements = async () => ({
    type: 'report',
    format: 'markdown',
    audience: 'operator',
    purpose: 'digest',
    requirements: [],
  });
  agent.generateDocument = async () => {
    generated = true;
    return { title: 'Digest', content: '# Digest\n\nCycle-backed finding.' };
  };
  agent.formatDocument = async (document) => document;
  agent.saveDocument = async () => ({
    title: 'Digest',
    filePath: path.join(os.tmpdir(), 'digest-6427.md'),
    deliverablePath: path.join(os.tmpdir(), 'digest-6427.md'),
    metadataPath: null,
    format: 'markdown',
    wordCount: 42,
    createdAt: new Date().toISOString(),
  });
  agent.addDocumentToMemory = async () => {};
  agent.triggerQualityAssurance = async () => {};
  agent.writeCompletionMarker = async () => {};

  const result = await agent.execute();

  assert.equal(generated, true);
  assert.equal(result.success, true);
  assert.equal(agent.results.some((entry) => entry.type === 'deliverable'), true);
});

test('technical specification document missions bypass claim intake and emit deliverables', async () => {
  process.env.OPENAI_API_KEY ||= 'test-key';
  const agent = new DocumentCreationAgent({
    goalId: 'goal_spec',
    triggerSource: 'orchestrator',
    spawningReason: 'goal_execution',
    description: 'Create a comprehensive specification document on platform selection criteria that explicitly incorporates failure mode sensitivity, tailored for the Home23 AI operating system context. The document should include at least five key selection criteria, each with a failure mode analysis table, and be structured as a formal specification suitable for technical stakeholders.',
  }, { logsDir: os.tmpdir() }, { info() {}, warn() {}, error() {}, debug() {} });

  let generated = false;
  agent.memory = { nodes: new Map([[1, { concept: 'selection criterion' }], [2, { concept: 'failure mode' }], [3, { concept: 'technical stakeholder' }]]) };
  agent.documentManager = { initialize: async () => {}, setCapabilities() {} };
  agent.loadDefaultTemplates = async () => {};
  agent.queryMemoryForKnowledge = async () => [];
  agent.parseDocumentRequirements = async () => ({
    type: 'specification',
    format: 'markdown',
    audience: 'technical_stakeholders',
    purpose: 'selection_criteria',
    requirements: [],
  });
  agent.generateDocument = async () => {
    generated = true;
    return { title: 'Platform Selection Criteria', content: '# Platform Selection Criteria\n\nFailure mode sensitive criteria.' };
  };
  agent.formatDocument = async (document) => document;
  agent.saveDocument = async () => ({
    title: 'Platform Selection Criteria',
    filePath: path.join(os.tmpdir(), 'platform-selection-criteria.md'),
    deliverablePath: path.join(os.tmpdir(), 'platform-selection-criteria.md'),
    metadataPath: null,
    format: 'markdown',
    wordCount: 42,
    createdAt: new Date().toISOString(),
  });
  agent.addDocumentToMemory = async () => {};
  agent.triggerQualityAssurance = async () => {};
  agent.writeCompletionMarker = async () => {};

  const result = await agent.execute();

  assert.equal(generated, true);
  assert.equal(result.success, true);
  assert.equal(agent.results.some((entry) => entry.type === 'deliverable'), true);
});
