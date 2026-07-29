const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

if (!process.env.OPENAI_API_KEY) {
  process.env.OPENAI_API_KEY = 'sk-test-dummy-key-for-unit-tests';
}

const {
  DataAcquisitionAgent,
} = require('../../cosmo23/engine/src/agents/data-acquisition-agent.js');
const {
  AgentExecutor,
} = require('../../cosmo23/engine/src/agents/agent-executor.js');
const {
  evaluateResearchEvidence,
} = require('../../cosmo23/engine/src/core/research-contract.js');

const logger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

function contractFor(sourceProviderHints = ['archive.advancedsearch']) {
  return {
    required: true,
    mode: 'source_acquisition',
    minSuccessfulSources: 1,
    requiredEvidence: ['successful_source_contact'],
    sourceProviderHints,
  };
}

function makeAgent(logsDir, sourceProviderHints = ['archive.advancedsearch']) {
  return new DataAcquisitionAgent(
    {
      goalId: 'acquisition-provenance-integrity',
      agentType: 'dataacquisition',
      description: 'Acquire the required Archive.org sources.',
      metadata: {
        researchContract: contractFor(sourceProviderHints),
      },
    },
    {
      logsDir,
      architecture: {
        memory: {
          embedding: {
            model: 'text-embedding-3-small',
            dimensions: 512,
          },
        },
      },
    },
    logger,
  );
}

function installCurlResult(agent, body, status = 200) {
  agent.executeBash = async (command) => {
    const outputMatch = command.match(/\s-o\s+"([^"]+)"/);
    if (outputMatch) {
      await fs.writeFile(outputMatch[1], body);
      return {
        stdout: String(status),
        stderr: '',
        exitCode: 0,
        timedOut: false,
        blocked: false,
        duration: 1,
      };
    }
    return {
      stdout: `${body.toString('utf8')}\n__HTTP_STATUS__${status}`,
      stderr: '',
      exitCode: 0,
      timedOut: false,
      blocked: false,
      duration: 1,
    };
  };
}

test('httpFetch measures the exact response and persists it under its content hash', async (t) => {
  const logsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cosmo-fetch-receipt-'));
  const body = Buffer.from('measured response body\n', 'utf8');
  const sha256 = crypto.createHash('sha256').update(body).digest('hex');
  const url = 'https://archive.org/advancedsearch.php?q=garcia';
  const agent = makeAgent(logsDir);

  t.after(async () => {
    await fs.rm(logsDir, { recursive: true, force: true });
  });

  await agent.onStart();
  installCurlResult(agent, body);
  const result = await agent.httpFetch(url);
  const receipts = agent.getMeasuredFetchReceipts();

  assert.equal(result.status, 200);
  assert.equal(result.body, body.toString('utf8'));
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].url, url);
  assert.equal(receipts[0].method, 'GET');
  assert.equal(receipts[0].status, 200);
  assert.equal(receipts[0].bytes, body.length);
  assert.equal(receipts[0].sha256, sha256);
  assert.match(receipts[0].timestamp, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(receipts[0].path, path.join('raw', sha256));

  const persisted = await fs.readFile(path.join(agent.getOutputDir(), receipts[0].path));
  assert.equal(persisted.length, receipts[0].bytes);
  assert.equal(crypto.createHash('sha256').update(persisted).digest('hex'), receipts[0].sha256);

  const receiptLog = await fs.readFile(
    path.join(agent.getOutputDir(), 'fetch-receipts.jsonl'),
    'utf8',
  );
  assert.deepEqual(JSON.parse(receiptLog.trim()), receipts[0]);
});

test('log_source reconciles to measured fetch values and leaves unfetched claims asserted', async (t) => {
  const logsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cosmo-source-reconcile-'));
  const body = Buffer.from('archive result', 'utf8');
  const sha256 = crypto.createHash('sha256').update(body).digest('hex');
  const url = 'https://archive.org/advancedsearch.php?q=garcia';
  const agent = makeAgent(logsDir);

  t.after(async () => {
    await fs.rm(logsDir, { recursive: true, force: true });
  });

  await agent.onStart();
  installCurlResult(agent, body);
  await agent.httpFetch(url);
  agent._logSource({
    url,
    route: 'archive.advancedsearch',
    status: 599,
    bytes: 999999,
    content_hash: 'model-asserted-hash',
  });
  agent._logSource({
    url: 'https://archive.org/metadata/not-fetched',
    route: 'archive.metadata',
    status: 200,
    bytes: 8192,
  });

  const [measured, asserted] = agent.acquisitionManifest.sources;
  assert.equal(measured.provenance, 'measured');
  assert.equal(measured.status, 200);
  assert.equal(measured.bytes, body.length);
  assert.equal(measured.contentHash, sha256);
  assert.ok(measured.fetchReceiptId);
  assert.equal(asserted.provenance, 'asserted');
  assert.equal(asserted.status, 200);
  assert.equal(asserted.bytes, 8192);

  const assessment = agent.assessAccomplishment({ metadata: {} }, []);
  assert.equal(assessment.accomplished, true);
  assert.equal(assessment.metrics.successfulSources, 1);
  assert.equal(assessment.metrics.assertedSources, 1);
});

test('asserted log_source entries cannot earn required route credit', () => {
  const fabricated = [
    {
      url: 'https://archive.org/advancedsearch.php?q=garcia',
      route: 'archive.advancedsearch',
      status: 200,
      bytes: 4096,
      provenance: 'asserted',
    },
  ];
  const result = evaluateResearchEvidence(contractFor(), {
    sourcesContacted: fabricated.length,
    successfulSources: fabricated.length,
    sourceAttempts: fabricated,
  });

  assert.equal(result.passed, false);
  assert.equal(result.reasonCode, 'missing_required_source_routes');
  assert.deepEqual(result.evidence.attemptedRoutes, []);
  assert.deepEqual(result.evidence.missingRequiredRoutes, ['archive.advancedsearch']);
});

test('mutating persisted raw content after log_source reconciliation revokes its credit', async (t) => {
  const logsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cosmo-source-tamper-'));
  const body = Buffer.from('original measured body', 'utf8');
  const url = 'https://archive.org/advancedsearch.php?q=garcia';
  const agent = makeAgent(logsDir);
  t.after(() => fs.rm(logsDir, { recursive: true, force: true }));

  await agent.onStart();
  installCurlResult(agent, body);
  await agent.httpFetch(url);
  agent._logSource({
    url,
    route: 'archive.advancedsearch',
    status: 200,
    bytes: body.length,
  });

  const source = agent.acquisitionManifest.sources[0];
  await fs.writeFile(path.join(agent.getOutputDir(), source.rawPath), 'tampered');

  const assessment = agent.assessAccomplishment({ metadata: {} }, []);
  assert.equal(assessment.accomplished, false);
  assert.equal(assessment.metrics.successfulSources, 0);
  assert.equal(assessment.metrics.assertedSources, 1);
  assert.equal(assessment.metrics.researchContractReason, 'missing_required_source_routes');
});

test('completion discovery counts bounded nested raw and extracted files', async (t) => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cosmo-recursive-output-'));
  t.after(() => fs.rm(outputDir, { recursive: true, force: true }));

  await fs.mkdir(path.join(outputDir, 'raw'), { recursive: true });
  await fs.mkdir(path.join(outputDir, 'extracted'), { recursive: true });
  await fs.writeFile(
    path.join(outputDir, 'extracted', 'biographical-sources.json'),
    Buffer.alloc(24172, 1),
  );
  await fs.writeFile(
    path.join(outputDir, 'extracted', 'biographical-source-manifest.md'),
    Buffer.alloc(8392, 2),
  );

  const executor = Object.create(AgentExecutor.prototype);
  executor.logger = logger;
  executor.capabilities = null;
  await executor.ensureManifestAndCompletion(outputDir, {
    agentId: 'agent-recursive-discovery',
    agentType: 'dataacquisition',
    mission: { goalId: 'recursive-discovery' },
    taskId: 'task:recursive-discovery',
  });

  const completion = JSON.parse(
    await fs.readFile(path.join(outputDir, '.complete'), 'utf8'),
  );
  const manifest = JSON.parse(
    await fs.readFile(path.join(outputDir, 'manifest.json'), 'utf8'),
  );

  assert.equal(completion.fileCount, 2);
  assert.equal(completion.totalSize, 24172 + 8392);
  assert.deepEqual(
    manifest.files.map((file) => file.path).sort(),
    [
      path.join('extracted', 'biographical-source-manifest.md'),
      path.join('extracted', 'biographical-sources.json'),
    ],
  );
});
