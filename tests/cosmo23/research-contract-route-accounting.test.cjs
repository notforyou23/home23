const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

if (!process.env.OPENAI_API_KEY) {
  process.env.OPENAI_API_KEY = 'sk-test-dummy-key-for-unit-tests';
}

const {
  evaluateResearchEvidence,
} = require('../../cosmo23/engine/src/core/research-contract.js');
const {
  DataAcquisitionAgent,
} = require('../../cosmo23/engine/src/agents/data-acquisition-agent.js');

const ARCHIVE_ROUTES = [
  'archive.advancedsearch',
  'archive.metadata',
  'archive.reviews',
];

function contractFor(sourceProviderHints) {
  return {
    required: true,
    mode: 'source_acquisition',
    minSuccessfulSources: 1,
    requiredEvidence: ['successful_source_contact'],
    sourceProviderHints,
  };
}

function evaluateSources(sourceProviderHints, sourceAttempts) {
  return evaluateResearchEvidence(contractFor(sourceProviderHints), {
    sourcesContacted: sourceAttempts.length,
    successfulSources: sourceAttempts.filter(
      (source) => !source.error && Number(source.status) >= 200 && Number(source.status) < 400,
    ).length,
    sourceAttempts,
  });
}

function makeAgent(
  sourceProviderHints = ARCHIVE_ROUTES,
  logsDir = path.join(os.tmpdir(), `cosmo-route-accounting-${process.pid}`),
) {
  return new DataAcquisitionAgent(
    {
      goalId: 'route-accounting-test',
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
    {
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
  );
}

test('log_source exposes optional route attribution and persists it in both receipts', () => {
  const agent = makeAgent();
  const logSource = agent.getToolSchema().find((tool) => tool.function.name === 'log_source');

  assert.ok(logSource);
  assert.equal(logSource.function.parameters.additionalProperties, false);
  assert.equal(logSource.function.parameters.properties.route.type, 'string');
  assert.deepEqual(logSource.function.parameters.required, ['url', 'status']);

  agent._logSource({
    url: 'https://archive.org/advancedsearch.php?q=grateful+dead',
    status: 200,
    route: 'archive.advancedsearch',
  });
  agent._logSource({
    url: 'https://example.com/route-remains-optional',
    status: 204,
  });

  assert.equal(agent.acquisitionManifest.sources[0].route, 'archive.advancedsearch');
  assert.equal(agent._crawlLog[0].route, 'archive.advancedsearch');
  assert.equal(Object.hasOwn(agent.acquisitionManifest.sources[1], 'route'), false);
  assert.equal(Object.hasOwn(agent._crawlLog[1], 'route'), false);
});

test('data-acquisition prompt names the exact required source route IDs', () => {
  const knowledge = makeAgent().getDomainKnowledge();

  for (const route of ARCHIVE_ROUTES) {
    assert.match(knowledge, new RegExp(route.replace('.', '\\.')));
  }
  assert.match(knowledge, /MUST pass that exact route ID in `route`/);
});

test('measured Archive fetch receipts satisfy only the requested canonical routes they contacted', () => {
  const result = evaluateSources(ARCHIVE_ROUTES, [
    {
      url: 'https://archive.org/advancedsearch.php?q=title%3A%28Garcia%29&output=json',
      status: 200,
      bytes: 0,
      error: null,
      provenance: 'measured',
      fetchReceiptId: 'fetch:advancedsearch',
    },
    {
      url: 'https://archive.org/metadata/garciaamericanli0000jack',
      status: 200,
      bytes: 0,
      error: null,
      provenance: 'measured',
      fetchReceiptId: 'fetch:metadata',
    },
  ]);

  assert.equal(result.passed, true);
  assert.equal(result.reasonCode, 'source_evidence_present');
  assert.deepEqual(result.evidence.attemptedRoutes, ARCHIVE_ROUTES);
  assert.deepEqual(result.evidence.failedRoutes, []);
});

test('data-acquisition accomplishment evaluates the manifest source receipts', async (t) => {
  const logsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cosmo-route-assessment-'));
  t.after(() => fs.rm(logsDir, { recursive: true, force: true }));
  const agent = makeAgent(ARCHIVE_ROUTES, logsDir);
  await agent.onStart();
  agent.executeBash = async (command) => {
    const outputMatch = command.match(/\s-o\s+"([^"]+)"/);
    await fs.writeFile(outputMatch[1], '{"measured":true}');
    return {
      stdout: '200',
      stderr: '',
      exitCode: 0,
      timedOut: false,
      blocked: false,
      duration: 1,
    };
  };

  for (const url of [
    'https://archive.org/advancedsearch.php?q=Garcia&output=json',
    'https://archive.org/metadata/garciaamericanli0000jack',
  ]) {
    await agent.httpFetch(url);
    agent._logSource({ url, status: 200 });
  }

  const assessment = agent.assessAccomplishment({ metadata: {} }, []);

  assert.equal(assessment.accomplished, true);
  assert.equal(assessment.metrics.researchContractReason, 'source_evidence_present');
});

test('an agent that contacted nothing still fails required route accounting', () => {
  const result = evaluateSources(ARCHIVE_ROUTES, []);

  assert.equal(result.passed, false);
  assert.equal(result.reasonCode, 'missing_required_source_routes');
  assert.deepEqual(result.evidence.attemptedRoutes, []);
  assert.deepEqual(result.evidence.missingRequiredRoutes, ARCHIVE_ROUTES);
});

test('matching URLs with HTTP or recorded errors classify as failed routes', () => {
  const cases = [
    {
      label: 'HTTP 500',
      source: {
        url: 'https://archive.org/advancedsearch.php?q=Garcia&output=json',
        status: 500,
        bytes: 0,
        error: null,
        provenance: 'measured',
        fetchReceiptId: 'fetch:http-500',
      },
    },
    {
      label: 'recorded error',
      source: {
        url: 'https://archive.org/advancedsearch.php?q=Garcia&output=json',
        status: 200,
        bytes: 0,
        error: 'response parse failed',
        provenance: 'measured',
        fetchReceiptId: 'fetch:recorded-error',
      },
    },
    {
      label: 'explicit route with HTTP 500',
      source: {
        route: 'archive.advancedsearch',
        url: 'https://archive.org/advancedsearch.php?q=Garcia&output=json',
        status: 500,
        bytes: 0,
        error: null,
        provenance: 'measured',
        fetchReceiptId: 'fetch:explicit-http-500',
      },
    },
    {
      label: 'explicit route with recorded error',
      source: {
        route: 'archive.advancedsearch',
        url: 'https://archive.org/advancedsearch.php?q=Garcia&output=json',
        status: 200,
        bytes: 0,
        error: 'response parse failed',
        provenance: 'measured',
        fetchReceiptId: 'fetch:explicit-recorded-error',
      },
    },
  ];

  for (const { label, source } of cases) {
    const result = evaluateSources(['archive.advancedsearch'], [source]);
    assert.equal(result.passed, false, label);
    assert.equal(result.reasonCode, 'required_source_route_failed', label);
    assert.deepEqual(result.evidence.attemptedRoutes, ['archive.advancedsearch'], label);
    assert.deepEqual(result.evidence.failedRoutes, ['archive.advancedsearch'], label);
  }
});

test('a matching URL is not credited when its route was not requested', () => {
  const result = evaluateSources(['crossref.works'], [
    {
      url: 'https://archive.org/advancedsearch.php?q=Garcia&output=json',
      status: 200,
      bytes: 100,
      error: null,
      provenance: 'measured',
      fetchReceiptId: 'fetch:not-requested',
    },
  ]);

  assert.equal(result.passed, false);
  assert.equal(result.reasonCode, 'missing_required_source_routes');
  assert.deepEqual(result.evidence.attemptedRoutes, []);
  assert.deepEqual(result.evidence.missingRequiredRoutes, ['crossref.works']);
});

test('a bare matching URL without an outcome is not a real route attempt', () => {
  const result = evaluateSources(['archive.advancedsearch'], [
    {
      url: 'https://archive.org/advancedsearch.php?q=Garcia&output=json',
      provenance: 'measured',
      fetchReceiptId: 'fetch:no-outcome',
    },
  ]);

  assert.equal(result.passed, false);
  assert.equal(result.reasonCode, 'missing_required_source_routes');
  assert.deepEqual(result.evidence.attemptedRoutes, []);
});

test('an explicit route wins over URL inference', () => {
  const result = evaluateSources(['archive.advancedsearch'], [
    {
      route: 'crossref.works',
      url: 'https://archive.org/advancedsearch.php?q=Garcia&output=json',
      status: 200,
      bytes: 100,
      error: null,
      provenance: 'measured',
      fetchReceiptId: 'fetch:explicit-route',
    },
  ]);

  assert.equal(result.passed, false);
  assert.equal(result.reasonCode, 'missing_required_source_routes');
  assert.deepEqual(result.evidence.attemptedRoutes, ['crossref.works']);
  assert.deepEqual(result.evidence.missingRequiredRoutes, ['archive.advancedsearch']);
});
