const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { BaseAgent } = require('../../cosmo23/engine/src/agents/base-agent');
const { AgentExecutor } = require('../../cosmo23/engine/src/agents/agent-executor');

function assess({ metadata = {}, results = [], persistedFiles = 0 } = {}) {
  const agent = Object.create(BaseAgent.prototype);
  agent._persistedOutputFiles = persistedFiles;
  agent.logger = { info() {}, warn() {}, error() {}, debug() {} };
  return agent.assessAccomplishment({ metadata }, results);
}

/** Write n real files and return their paths, so "persisted" can be verified. */
function writeRealFiles(t, n) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'output-truth-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return Array.from({ length: n }, (_, i) => {
    const filePath = path.join(dir, `artifact-${i}.md`);
    fs.writeFileSync(filePath, `artifact ${i}`);
    return { path: filePath, filename: `artifact-${i}.md` };
  });
}

function makeQaExecutor() {
  const executor = Object.create(AgentExecutor.prototype);
  executor.config = {};
  executor.logger = {
    info() {},
    warn() {},
    error() {},
    debug() {},
  };
  return executor;
}

test('output files that exist on disk count as persisted output', (t) => {
  const outputFiles = writeRealFiles(t, 10);
  const result = assess({
    metadata: {
      artifactsCreated: 10,
      filesCreated: 10,
      persistedOutputFiles: 10,
      outputFiles,
    },
    results: [{ type: 'finding', content: 'measured finding' }],
  });

  assert.equal(result.accomplished, true);
  assert.equal(result.metrics.persistedFiles, 10);
});

// The gate must MEASURE, not believe. This is the forensics audit's
// projection/authority failure in miniature: an agent asserting it wrote ten
// files, with nothing on disk behind the claim.
test('a file count with no files behind it is not persisted output', (t) => {
  const outputFiles = writeRealFiles(t, 1);
  const missing = [
    ...outputFiles,
    { path: path.join(os.tmpdir(), 'output-truth-never-written', 'ghost.md'), filename: 'ghost.md' },
    { path: path.join(os.tmpdir(), 'output-truth-never-written', 'ghost2.md'), filename: 'ghost2.md' },
  ];

  const result = assess({
    metadata: {
      artifactsCreated: 3,
      filesCreated: 3,
      persistedOutputFiles: 3, // the claim
      outputFiles: missing,    // only 1 of 3 is real
    },
    results: [{ type: 'finding', content: 'partially fabricated output' }],
  });

  assert.equal(result.metrics.persistedFiles, 1, 'only the file that exists is counted');
  assert.equal(result.accomplished, true, 'one real artifact still clears the bar');
});

test('a fully fabricated file list fails the gate outright', (t) => {
  const ghostDir = path.join(os.tmpdir(), 'output-truth-never-written');
  const result = assess({
    metadata: {
      artifactsCreated: 5,
      filesCreated: 5,
      persistedOutputFiles: 5, // asserted...
      outputFiles: [
        { path: path.join(ghostDir, 'a.md') },
        { path: path.join(ghostDir, 'b.md') },
      ], // ...but nothing is on disk
    },
    results: [{ type: 'finding', content: 'claimed but unwritten' }],
  });

  assert.equal(result.metrics.persistedFiles, 0);
  assert.equal(result.accomplished, false);
  assert.match(result.reason, /persisted 0 files/);
});

test('metadata file claims without persistedOutputFiles remain unaccomplished', () => {
  const result = assess({
    metadata: { artifactsCreated: 10, filesCreated: 10 },
    results: [{ type: 'finding', content: 'unverified finding' }],
  });

  assert.equal(result.accomplished, false);
  assert.match(result.reason, /persisted 0 files/);
});

test('QA rejects completed_unproductive results before heuristic scoring', async () => {
  const result = await makeQaExecutor().qualityAssuranceCheck({
    agentId: 'agent_bad',
    agentType: 'ResearchAgent',
    mission: {},
    status: 'completed_unproductive',
    accomplishment: { accomplished: false, reason: 'persisted 0 files' },
    results: [{ type: 'finding', content: 'memory-only claim' }],
  });

  assert.equal(result.shouldIntegrate, false);
  assert.equal(result.confidence, 0);
  assert.equal(result.reason, 'persisted 0 files');
});

test('QA rejects empty completed results instead of auto-integrating them', async () => {
  const result = await makeQaExecutor().qualityAssuranceCheck({
    agentId: 'agent_empty',
    agentType: 'ResearchAgent',
    mission: {},
    status: 'completed',
    accomplishment: { accomplished: true },
    results: [],
  });

  assert.equal(result.shouldIntegrate, false);
  assert.equal(result.confidence, 0);
  assert.equal(result.reason, 'Agent produced no findings or insights');
});
