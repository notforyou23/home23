const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sourcePath = path.join(process.cwd(), 'engine/src/dashboard/home23-query.js');
const source = fs.readFileSync(sourcePath, 'utf8');

function loadContractHelpers(document = undefined) {
  const context = vm.createContext({
    console,
    document,
    window: { location: { hostname: 'localhost' } },
  });
  vm.runInContext(`${source}\n;globalThis.__queryTest = {
    buildFacadeQueryRequest,
    buildFacadeExportRequest,
    decodeModelPair,
    encodeModelPair,
    queryFacadeEndpoint,
    queryResultFromFacadePayload,
    isDetachedFacadePayload,
    parseTargetPartitionIds: typeof parseTargetPartitionIds === 'function' ? parseTargetPartitionIds : null,
    buildPgsPartitionsRequest: typeof buildPgsPartitionsRequest === 'function' ? buildPgsPartitionsRequest : null,
    historyItemForQueryResult: typeof historyItemForQueryResult === 'function' ? historyItemForQueryResult : null,
    buildPGSCoverageHTML: typeof buildPGSCoverageHTML === 'function' ? buildPGSCoverageHTML : null,
    brainOperationEndpoint: typeof brainOperationEndpoint === 'function' ? brainOperationEndpoint : null,
    nextPGSLevel: typeof nextPGSLevel === 'function' ? nextPGSLevel : null,
    isPGSContinuable: typeof isPGSContinuable === 'function' ? isPGSContinuable : null,
    queryOptionsSummaryText: typeof queryOptionsSummaryText === 'function' ? queryOptionsSummaryText : null,
    populateQueryModels: typeof populateQueryModels === 'function' ? populateQueryModels : null,
  };`, context, { filename: 'home23-query.js' });
  return context.__queryTest;
}

const operationId = `brop_${'q'.repeat(32)}`;
const resultHandle = `brres_${'r'.repeat(32)}`;
const canonicalBrainId = `brain-${'b'.repeat(16)}`;
const exactPairs = {
  pgsSweep: { provider: 'minimax', model: 'MiniMax-M3' },
  pgsSynth: { provider: 'anthropic', model: 'claude-sonnet-4-7' },
};

test('visible non-streaming Query starts durable work asynchronously', () => {
  assert.match(source, /Prefer:\s*['"]respond-async['"]/);
});

function pgsRequest(overrides = {}) {
  return {
    agent: 'jerry',
    brainId: canonicalBrainId,
    query: 'what changed',
    enablePGS: true,
    pgsMode: 'fresh',
    pgsLevel: 'sample',
    ...exactPairs,
    ...overrides,
  };
}

test('visible Query client builds an exact direct facade request', () => {
  const { buildFacadeQueryRequest, decodeModelPair, encodeModelPair } = loadContractHelpers();
  const openAi = encodeModelPair({ provider: 'openai', model: 'gpt-5.5' });
  const codex = encodeModelPair({ provider: 'openai-codex', model: 'gpt-5.5' });
  assert.notEqual(openAi, codex, 'duplicate model IDs retain distinct provider selections');

  assert.deepEqual(
    JSON.parse(JSON.stringify(buildFacadeQueryRequest({
      agent: 'jerry',
      brainId: canonicalBrainId,
      query: 'what changed',
      mode: 'full',
      enablePGS: false,
      priorContext: { query: 'before', answer: 'earlier answer' },
      modelSelection: decodeModelPair(codex),
      enableSynthesis: true,
      includeOutputs: true,
      includeThoughts: true,
      includeCoordinatorInsights: true,
      allowActions: false,
    }))),
    {
      agent: 'jerry',
      brainId: canonicalBrainId,
      query: 'what changed',
      mode: 'full',
      enablePGS: false,
      modelSelection: { provider: 'openai-codex', model: 'gpt-5.5' },
      enableSynthesis: true,
      includeOutputs: true,
      includeThoughts: true,
      includeCoordinatorInsights: true,
      allowActions: false,
      priorContext: { query: 'before', answer: 'earlier answer' },
    },
  );
});

test('visible Query client refuses model-only default fallback when the exact pair is unavailable', () => {
  const selects = new Map();
  const makeSelect = () => ({
    options: [],
    appendChild(group) { this.options.push(...group.children); },
    set innerHTML(_value) { this.options = []; },
  });
  for (const id of ['qt-model', 'qt-pgs-sweep-model', 'qt-pgs-synth-model']) {
    selects.set(id, makeSelect());
  }
  const document = {
    getElementById(id) { return selects.get(id) || null; },
    createElement(kind) {
      if (kind === 'optgroup') {
        return { children: [], appendChild(option) { this.children.push(option); } };
      }
      return { value: '', textContent: '', dataset: {} };
    },
  };
  const { populateQueryModels } = loadContractHelpers(document);
  assert.equal(typeof populateQueryModels, 'function');
  assert.throws(() => populateQueryModels({
    models: [{ id: 'gpt-5.5', provider: 'openai', name: 'GPT 5.5' }],
    defaults: {
      model: 'gpt-5.5', provider: 'openai-codex',
      pgsSweepModel: 'gpt-5.5', pgsSweepProvider: 'openai',
      pgsSynthModel: 'gpt-5.5', pgsSynthProvider: 'openai',
    },
  }), (error) => error?.code === 'query_model_configuration_invalid');
});

test('visible Query client sends named PGS levels and only mode-dependent fields', () => {
  const { buildFacadeQueryRequest } = loadContractHelpers();
  const fixtures = [
    [pgsRequest({ pgsMode: 'fresh', pgsLevel: 'skim' }), {
      pgsMode: 'fresh', pgsLevel: 'skim',
    }],
    [pgsRequest({
      pgsMode: 'continue', pgsLevel: 'deep', continueFromOperationId: operationId,
    }), {
      pgsMode: 'continue', pgsLevel: 'deep', continueFromOperationId: operationId,
    }],
    [pgsRequest({
      pgsMode: 'targeted', pgsLevel: 'sample', targetPartitionIds: ['c-one', 'h-two'],
    }), {
      pgsMode: 'targeted', pgsLevel: 'sample', targetPartitionIds: ['c-one', 'h-two'],
    }],
    [pgsRequest({
      pgsMode: 'targeted', pgsLevel: 'full', continueFromOperationId: operationId,
      targetPartitionIds: ['c-one', 'h-two'],
    }), {
      pgsMode: 'targeted', pgsLevel: 'full', continueFromOperationId: operationId,
      targetPartitionIds: ['c-one', 'h-two'],
    }],
  ];

  for (const [input, expectedModeFields] of fixtures) {
    const request = JSON.parse(JSON.stringify(buildFacadeQueryRequest(input)));
    assert.deepEqual(request, {
      agent: 'jerry',
      brainId: canonicalBrainId,
      query: 'what changed',
      enablePGS: true,
      ...expectedModeFields,
      ...exactPairs,
    });
    assert.equal(Object.hasOwn(request, 'pgsConfig'), false, 'client never sends a raw fraction');
  }
});

test('visible Query client refuses invalid PGS mode, level, continuation, and target combinations', () => {
  const { buildFacadeQueryRequest } = loadContractHelpers();
  const invalid = [
    pgsRequest({ pgsMode: 'full' }),
    pgsRequest({ pgsLevel: 'quarter' }),
    pgsRequest({ continueFromOperationId: operationId }),
    pgsRequest({ targetPartitionIds: ['c-one'] }),
    pgsRequest({ pgsMode: 'continue' }),
    pgsRequest({ pgsMode: 'continue', continueFromOperationId: operationId, targetPartitionIds: ['c-one'] }),
    pgsRequest({ pgsMode: 'targeted' }),
    pgsRequest({ priorContext: { query: 'before', answer: 'after' } }),
    pgsRequest({ mode: 'full' }),
  ];
  for (const request of invalid) {
    assert.throws(() => buildFacadeQueryRequest(request), /PGS|partition|operation|Direct Query/i);
  }
});

test('targeted partition entry is canonical, deduplicated, and bounded', () => {
  const { parseTargetPartitionIds, buildPgsPartitionsRequest } = loadContractHelpers();
  assert.equal(typeof parseTargetPartitionIds, 'function');
  assert.deepEqual(
    JSON.parse(JSON.stringify(parseTargetPartitionIds(' c-one, h-two\nc-one '))),
    ['c-one', 'h-two'],
  );
  assert.throws(() => parseTargetPartitionIds('one'), /partition/i);
  assert.throws(
    () => parseTargetPartitionIds(Array.from({ length: 257 }, (_, index) => `c-${index}`).join(',')),
    /256/,
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(buildPgsPartitionsRequest({ agent: 'jerry', brainId: canonicalBrainId }))),
    { agent: 'jerry', brainId: canonicalBrainId },
  );
});

test('visible Query client retains operation, result, and PGS session identity in history', () => {
  const {
    buildFacadeExportRequest,
    queryFacadeEndpoint,
    queryResultFromFacadePayload,
    isDetachedFacadePayload,
    historyItemForQueryResult,
    isPGSContinuable,
  } = loadContractHelpers();
  assert.equal(typeof historyItemForQueryResult, 'function');
  const payload = {
    ok: true,
    operationId,
    state: 'partial',
    attachmentState: 'closed',
    detached: false,
    resultHandle,
    result: {
      query: 'what changed',
      answer: 'durable answer',
      metadata: { pgs: {
        coverageLevel: 'sample',
        sessionId: `pgss_${'s'.repeat(32)}`,
        sourceOperationId: operationId,
        continuableUntil: '2026-07-13T12:00:00.000Z',
        canContinue: true,
      } },
    },
  };
  const result = queryResultFromFacadePayload(payload, 'fallback query');
  const history = historyItemForQueryResult(result);

  assert.equal(history.operationId, operationId);
  assert.equal(history.resultHandle, resultHandle);
  assert.equal(history.pgsSessionId, `pgss_${'s'.repeat(32)}`);
  assert.equal(history.continuableUntil, '2026-07-13T12:00:00.000Z');
  assert.equal(history.canContinue, true);
  assert.equal(isPGSContinuable(history, Date.parse('2026-07-12T12:00:00.000Z')), true);
  assert.deepEqual(
    JSON.parse(JSON.stringify(buildFacadeExportRequest(history, 'markdown', 'jerry'))),
    { agent: 'jerry', operationId, resultHandle, format: 'markdown' },
  );
  assert.equal(queryFacadeEndpoint({ endpoints: { stream: '/home23/api/query/stream' } }, 'stream', 'jerry'), '/home23/api/query/stream?agent=jerry');
  assert.equal(isDetachedFacadePayload({ detached: true, attachmentState: 'detached', operationId }), true);
});

test('PGS coverage renderer distinguishes requested scope, global coverage, and reused work', () => {
  const { buildPGSCoverageHTML } = loadContractHelpers();
  assert.equal(typeof buildPGSCoverageHTML, 'function');
  const html = buildPGSCoverageHTML({
    coverageLevel: 'sample',
    coverageFraction: 0.25,
    scopeWorkUnits: 25,
    scopeSuccessfulWorkUnits: 23,
    scopePendingWorkUnits: 2,
    scopeComplete: false,
    globalWorkUnits: 100,
    globalCoveredWorkUnits: 23,
    globalPendingWorkUnits: 77,
    fullCoverage: false,
    reusedWorkUnits: 20,
    newWorkUnits: 3,
    targetPartitionIds: ['c-one'],
    sessionId: `pgss_${'s'.repeat(32)}`,
    continuableUntil: '2026-07-13T12:00:00.000Z',
  }, { operationId });

  assert.match(html, /Sample \(25%\)/);
  assert.match(html, /Requested scope: 23\/25 complete; 2 pending/);
  assert.match(html, /Global coverage: 23\/100; 77 pending/);
  assert.match(html, /This operation: 20 reused; 3 new/);
  assert.match(html, /Target partitions: c-one/);
  assert.match(html, new RegExp(operationId));
  assert.doesNotMatch(html, /100% coverage/);
  assert.match(buildPGSCoverageHTML({
    coverageLevel: 'full', coverageFraction: 1, scopeWorkUnits: 100,
    scopeSuccessfulWorkUnits: 100, scopePendingWorkUnits: 0, scopeComplete: true,
    globalWorkUnits: 100, globalCoveredWorkUnits: 100, globalPendingWorkUnits: 0,
    fullCoverage: true, reusedWorkUnits: 50, newWorkUnits: 50,
  }, { operationId }), /Full graph coverage: complete/);
});

test('durable operation routes and next-level continuation are deterministic', () => {
  const { brainOperationEndpoint, nextPGSLevel, isPGSContinuable } = loadContractHelpers();
  assert.equal(typeof brainOperationEndpoint, 'function');
  assert.equal(typeof nextPGSLevel, 'function');
  assert.equal(brainOperationEndpoint(operationId), `/home23/api/brain-operations/${operationId}`);
  assert.equal(brainOperationEndpoint(operationId, 'events'), `/home23/api/brain-operations/${operationId}/events`);
  assert.equal(brainOperationEndpoint(operationId, 'result'), `/home23/api/brain-operations/${operationId}/result`);
  assert.equal(brainOperationEndpoint(operationId, 'cancel'), `/home23/api/brain-operations/${operationId}/cancel`);
  assert.equal(nextPGSLevel('skim'), 'sample');
  assert.equal(nextPGSLevel('sample'), 'deep');
  assert.equal(nextPGSLevel('deep'), 'full');
  assert.equal(nextPGSLevel('full'), 'full');
  assert.equal(typeof isPGSContinuable, 'function');
  assert.equal(isPGSContinuable({ metadata: { pgs: { canContinue: true } } }, Date.parse('2026-07-12T12:00:00.000Z')), true);
  assert.equal(isPGSContinuable({ metadata: { pgs: { canContinue: false } } }, Date.parse('2026-07-12T12:00:00.000Z')), false);
  assert.equal(isPGSContinuable({
    metadata: { pgs: {
      canContinue: true,
      continuableUntil: '2026-07-12T11:59:59.000Z',
    } },
  }, Date.parse('2026-07-12T12:00:00.000Z')), false);
});

test('visible Query controls expose approved PGS modes, named levels, and durable actions', () => {
  assert.match(source, /Show live progress/);
  assert.match(source, /<option value="fresh"[^>]*>/);
  assert.match(source, /<option value="continue"[^>]*>/);
  assert.match(source, /<option value="targeted"[^>]*>/);
  for (const level of ['skim', 'sample', 'deep', 'full']) {
    assert.match(source, new RegExp(`data-level="${level}"`));
  }
  assert.match(source, /id="qt-pgs-continue-operation"/);
  assert.match(source, /id="qt-pgs-targets"/);
  for (const action of ['Continue', 'Reattach', 'Cancel', 'Start Fresh']) {
    assert.match(source, new RegExp(`>${action}<`));
  }
  assert.doesNotMatch(source, /pgsConfig\s*:/);
  assert.doesNotMatch(source, /100% coverage\)<\/span>/);
});

test('visible Query labels protected exports as workspace exports rather than brain mutation', () => {
  assert.match(source, />💾 Export to Workspace</);
  assert.doesNotMatch(source, /Save to Brain/);
  assert.match(source, /function exportToWorkspace\(/);
});

test('PGS options summary does not present the unrelated Direct Query mode or model', () => {
  const { queryOptionsSummaryText } = loadContractHelpers();
  assert.equal(typeof queryOptionsSummaryText, 'function');
  const pgs = queryOptionsSummaryText({
    enablePGS: true,
    directMode: 'full',
    directModel: 'gpt-5.5',
    pgsLevel: 'sample',
    pgsMode: 'continue',
    pgsSweep: 'MiniMax-M3',
    pgsSynth: 'claude-sonnet-4-7',
  });
  assert.equal(pgs, 'PGS Sample (25%) · continue · MiniMax-M3 → claude-sonnet-4-7');
  assert.doesNotMatch(pgs, /Full mode|gpt-5\.5/);
  assert.equal(queryOptionsSummaryText({
    enablePGS: false,
    directMode: 'full',
    directModel: 'gpt-5.5',
  }), 'Full mode · gpt-5.5');
});

test('visible Query client no longer contains direct COSMO query, catalog, or export fetches', () => {
  assert.doesNotMatch(source, /fetch\(`\$\{QT_COSMO_BASE\}\//);
  assert.doesNotMatch(source, /buildBrainApiPath\('\/export-query'\)/);
  assert.doesNotMatch(source, /\$\{brainRoute\}\/query/);
});

test('legacy Query export has one handler and its caller uses that handler payload', () => {
  const serverSource = fs.readFileSync(
    path.join(process.cwd(), 'engine/src/dashboard/server.js'),
    'utf8',
  );
  const legacyQuerySource = fs.readFileSync(
    path.join(process.cwd(), 'engine/src/dashboard/query.html'),
    'utf8',
  );
  assert.equal((serverSource.match(/this\.app\.post\('\/api\/query\/export'/g) || []).length, 1);
  assert.match(legacyQuerySource, /runName:\s*currentRun/);
  assert.match(legacyQuerySource, /result:\s*currentAnswer/);
  assert.doesNotMatch(legacyQuerySource, /answer:\s*currentAnswer\.answer/);
});
