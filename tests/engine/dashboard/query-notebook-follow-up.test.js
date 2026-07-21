import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  MAX_VERIFIED_CONTEXT_UTF16,
  IMMEDIATE_ANSWER_OMISSION_MARKER,
  vectors,
} = require('../../helpers/query-verified-follow-up-context-vectors.cjs');
const {
  renderVerifiedConversation,
  validateVerifiedConversationContext,
  takeLeadingUtf16,
  takeTrailingUtf16,
} = require('../../../shared/query/verified-follow-up-context.cjs');
const {
  normalizeVerifiedFollowUpRequest,
  buildVerifiedFollowUpContext,
  validateFollowUpLineage,
  projectFollowUpLineage,
} = require('../../../engine/src/dashboard/query-notebook-follow-up.js');

const operationId = (letter) => `brop_${letter.repeat(32)}`;
const resultVersion = (letter) => `qrv1_${letter.repeat(43)}`;
const ROOT_ID = operationId('R');
const PARENT_ID = operationId('P');
const CHILD_ID = operationId('C');
const ROOT_VERSION = resultVersion('R');
const PARENT_VERSION = resultVersion('P');
const CHILD_VERSION = resultVersion('C');

function rootRecord({
  operationType = 'query',
  id = ROOT_ID,
  version = ROOT_VERSION,
  query = 'First question',
  brainId = 'brain-jerry',
  overrides = {},
} = {}) {
  return {
    operationId: id,
    operationType,
    requesterAgent: 'jerry',
    target: { domain: 'brain', brainId, displayName: 'Jerry' },
    requestParameters: operationType === 'pgs'
      ? { query, pgsMode: 'fresh', pgsLevel: 'sample' }
      : { query, mode: 'full' },
    state: 'complete',
    notebookResultSummary: {
      version: 1,
      resultVersion: version,
      answerAvailable: true,
      coverage: null,
      continuation: null,
    },
    ...overrides,
  };
}

function followUpRecord({
  id = PARENT_ID,
  version = PARENT_VERSION,
  query = 'Second question',
  sourceId = ROOT_ID,
  sourceVersion = ROOT_VERSION,
  brainId = 'brain-jerry',
  overrides = {},
} = {}) {
  return rootRecord({
    id,
    version,
    query,
    brainId,
    overrides: {
      operationType: 'query',
      requestParameters: {
        kind: 'verifiedFollowUp',
        schemaVersion: 1,
        followUpFrom: { operationId: sourceId, resultVersion: sourceVersion },
        query,
        mode: 'dive',
        modelSelection: { provider: 'openai', model: 'gpt-5.2' },
        enableSynthesis: true,
        includeOutputs: true,
        includeThoughts: true,
        includeCoordinatorInsights: true,
        allowActions: false,
      },
      ...overrides,
    },
  });
}

function followUpRequest(overrides = {}) {
  return {
    kind: 'verifiedFollowUp',
    schemaVersion: 1,
    followUpFrom: { operationId: ROOT_ID, resultVersion: ROOT_VERSION },
    query: 'What changed after that?',
    mode: 'dive',
    modelSelection: { provider: 'openai', model: 'gpt-5.2' },
    enableSynthesis: true,
    includeOutputs: true,
    includeThoughts: true,
    includeCoordinatorInsights: true,
    allowActions: false,
    ...overrides,
  };
}

function assertNoUnpairedSurrogates(value) {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xD800 && unit <= 0xDBFF) {
      assert.ok(index + 1 < value.length, 'high surrogate must have a following code unit');
      const next = value.charCodeAt(index + 1);
      assert.ok(next >= 0xDC00 && next <= 0xDFFF, 'high surrogate must precede a low surrogate');
      index += 1;
    } else {
      assert.ok(unit < 0xDC00 || unit > 0xDFFF, 'low surrogate must follow a high surrogate');
    }
  }
}

test('shared golden vectors lock canonical renderer framing and UTF-16 counts', () => {
  for (const vector of [vectors.simple, vectors.exactBoundary, vectors.emoji]) {
    assert.equal(renderVerifiedConversation(vector.exchanges), vector.rendered);
    assert.equal(vector.rendered.length, vector.utf16);
  }
  assert.equal(IMMEDIATE_ANSWER_OMISSION_MARKER,
    '\n\n[... middle of immediate parent answer omitted by Home23 verified follow-up context budget ...]\n\n');
  assert.equal(MAX_VERIFIED_CONTEXT_UTF16, 20_000);
});

test('verified conversation validator accepts only stripped exact exchanges within budget', () => {
  const context = { version: 1, exchanges: vectors.simple.exchanges };
  assert.deepEqual(validateVerifiedConversationContext(context), {
    version: 1,
    exchanges: [
      { query: 'First question', answer: 'First answer' },
      { query: 'Second question', answer: 'Second answer' },
    ],
  });
  assert.deepEqual(validateVerifiedConversationContext({
    version: 1, exchanges: vectors.exactBoundary.exchanges,
  }), { version: 1, exchanges: vectors.exactBoundary.exchanges });

  for (const invalid of [
    { version: 1, exchanges: [], operationId: ROOT_ID },
    { version: 1, exchanges: [{ query: 'Q', answer: 'A', resultVersion: ROOT_VERSION }] },
    { version: 1, exchanges: [{ query: '', answer: 'A' }] },
    { version: 1, exchanges: [{ query: 'Q', answer: '' }] },
    { version: 1, exchanges: [{ query: 'Q', answer: 'a'.repeat(19_980) }] },
  ]) {
    assert.throws(() => validateVerifiedConversationContext(invalid));
  }
});

test('UTF-16 excerpt helpers never split surrogate pairs', () => {
  assert.equal(takeLeadingUtf16('A😀B', 2), 'A');
  assert.equal(takeLeadingUtf16('😀B', 1), '');
  assert.equal(takeLeadingUtf16('A😀B', 3), 'A😀');
  assert.equal(takeTrailingUtf16('A😀B', 2), 'B');
  assert.equal(takeTrailingUtf16('A😀', 1), '');
  assert.equal(takeTrailingUtf16('A😀B', 3), '😀B');
});

test('protected follow-up request normalization accepts only the exact Direct wire shape', () => {
  assert.deepEqual(normalizeVerifiedFollowUpRequest(followUpRequest()), followUpRequest());
  for (const mode of ['quick', 'full', 'expert', 'dive']) {
    assert.equal(normalizeVerifiedFollowUpRequest(followUpRequest({ mode })).mode, mode);
  }
  assert.equal(normalizeVerifiedFollowUpRequest(followUpRequest({ query: 'q'.repeat(12_000) })).query.length,
    12_000);

  for (const field of [
    'agent', 'brain', 'brainId', 'priorContext', 'verifiedConversationContext',
    'enablePGS', 'pgsMode', 'pgsLevel', 'pgsConfig', 'dryRun', 'validateOnly',
    'validation', 'answer', 'requestId',
  ]) {
    assert.throws(() => normalizeVerifiedFollowUpRequest({ ...followUpRequest(), [field]: true }), field);
  }
  for (const invalid of [
    followUpRequest({ kind: 'direct' }),
    followUpRequest({ schemaVersion: 2 }),
    followUpRequest({ query: '' }),
    followUpRequest({ query: 'q'.repeat(12_001) }),
    followUpRequest({ mode: 'grounded' }),
    followUpRequest({ allowActions: true }),
    followUpRequest({ enableSynthesis: 1 }),
    followUpRequest({ modelSelection: { provider: 'openai', model: 'gpt-5.2', fallback: true } }),
    followUpRequest({ modelSelection: { provider: '', model: 'gpt-5.2' } }),
    followUpRequest({ followUpFrom: { operationId: 'brop_bad', resultVersion: ROOT_VERSION } }),
    followUpRequest({ followUpFrom: { operationId: ROOT_ID, resultVersion: 'qrv1_bad' } }),
  ]) {
    assert.throws(() => normalizeVerifiedFollowUpRequest(invalid));
  }

  const hidden = followUpRequest();
  Object.defineProperty(hidden, 'answer', { value: 'hidden', enumerable: false });
  assert.throws(() => normalizeVerifiedFollowUpRequest(hidden), 'non-enumerable unknown key');
  const symbol = followUpRequest();
  symbol[Symbol('private')] = true;
  assert.throws(() => normalizeVerifiedFollowUpRequest(symbol), 'symbol key');
});

test('protected follow-up request normalization rejects whitespace-padded model pairs', () => {
  for (const modelSelection of [
    { provider: ' openai', model: 'gpt-5.2' },
    { provider: 'openai ', model: 'gpt-5.2' },
    { provider: 'openai', model: ' gpt-5.2' },
    { provider: 'openai', model: 'gpt-5.2 ' },
    { provider: '   ', model: 'gpt-5.2' },
    { provider: 'openai', model: '   ' },
  ]) {
    assert.throws(() => normalizeVerifiedFollowUpRequest(followUpRequest({ modelSelection })));
  }
});

test('Direct and PGS roots produce the same safe child authority shape', () => {
  for (const operationType of ['query', 'pgs']) {
    const built = buildVerifiedFollowUpContext({
      parentRecord: rootRecord({ operationType }),
      parentResult: { answer: 'First answer' },
      parentLineage: null,
      parentPrivateContext: null,
      maxPriorContextChars: MAX_VERIFIED_CONTEXT_UTF16,
    });
    assert.deepEqual(built.queryFollowUpLineage, {
      rootOperationId: ROOT_ID,
      parentOperationId: ROOT_ID,
      parentResultVersion: ROOT_VERSION,
      depth: 1,
      availableExchangeCount: 1,
      includedExchangeCount: 1,
      contextTruncated: false,
      sourceAnswerTruncated: false,
    });
    assert.deepEqual(built.privateContext, {
      version: 1,
      ...built.queryFollowUpLineage,
      exchanges: [{
        operationId: ROOT_ID,
        resultVersion: ROOT_VERSION,
        query: 'First question',
        answer: 'First answer',
      }],
    });
    assert.deepEqual(built.verifiedConversationContext, {
      version: 1,
      exchanges: [{ query: 'First question', answer: 'First answer' }],
    });
  }
});

test('grandchild context inherits older verified exchanges and emits them chronologically', () => {
  const child = buildVerifiedFollowUpContext({
    parentRecord: rootRecord(),
    parentResult: { answer: 'First answer' },
    parentLineage: null,
    parentPrivateContext: null,
    maxPriorContextChars: MAX_VERIFIED_CONTEXT_UTF16,
  });
  const grandchild = buildVerifiedFollowUpContext({
    parentRecord: followUpRecord(),
    parentResult: { answer: 'Second answer' },
    parentLineage: child.queryFollowUpLineage,
    parentPrivateContext: child.privateContext,
    maxPriorContextChars: MAX_VERIFIED_CONTEXT_UTF16,
  });
  assert.deepEqual(grandchild.queryFollowUpLineage, {
    rootOperationId: ROOT_ID,
    parentOperationId: PARENT_ID,
    parentResultVersion: PARENT_VERSION,
    depth: 2,
    availableExchangeCount: 2,
    includedExchangeCount: 2,
    contextTruncated: false,
    sourceAnswerTruncated: false,
  });
  assert.deepEqual(grandchild.verifiedConversationContext, {
    version: 1,
    exchanges: [
      { query: 'First question', answer: 'First answer' },
      { query: 'Second question', answer: 'Second answer' },
    ],
  });
  assert.equal(renderVerifiedConversation(grandchild.verifiedConversationContext.exchanges),
    vectors.simple.rendered);
  assert.equal(JSON.stringify(grandchild.verifiedConversationContext).includes('brop_'), false);
  assert.equal(JSON.stringify(grandchild.verifiedConversationContext).includes('qrv1_'), false);
  for (const forbidden of ['requesterAgent', 'jerry', 'brain-jerry', 'parentRecord']) {
    assert.equal(JSON.stringify(grandchild.verifiedConversationContext).includes(forbidden), false);
  }
});

test('grandchild context rejects malformed persisted protected parent requests', () => {
  const child = buildVerifiedFollowUpContext({
    parentRecord: rootRecord(),
    parentResult: { answer: 'First answer' },
    parentLineage: null,
    parentPrivateContext: null,
    maxPriorContextChars: MAX_VERIFIED_CONTEXT_UTF16,
  });
  const validParent = followUpRecord();
  const validRequest = validParent.requestParameters;
  const missingModelSelection = { ...validRequest };
  delete missingModelSelection.modelSelection;
  const malformedRequests = [
    { ...validRequest, allowActions: true },
    { ...validRequest, mode: 'grounded' },
    missingModelSelection,
    { ...validRequest, priorContext: { query: 'forged', answer: 'forged' } },
  ];
  for (const requestParameters of malformedRequests) {
    assert.throws(() => buildVerifiedFollowUpContext({
      parentRecord: { ...validParent, requestParameters },
      parentResult: { answer: 'Second answer' },
      parentLineage: child.queryFollowUpLineage,
      parentPrivateContext: child.privateContext,
      maxPriorContextChars: MAX_VERIFIED_CONTEXT_UTF16,
    }));
  }
});

test('packing starts with the immediate parent and selects older whole exchanges newest-first', () => {
  const oldest = { operationId: ROOT_ID, resultVersion: ROOT_VERSION, query: 'Q1', answer: 'o'.repeat(9_000) };
  const newest = { operationId: PARENT_ID, resultVersion: PARENT_VERSION, query: 'Q2', answer: 'n'.repeat(7_000) };
  const parentLineage = {
    rootOperationId: ROOT_ID,
    parentOperationId: PARENT_ID,
    parentResultVersion: PARENT_VERSION,
    depth: 2,
    availableExchangeCount: 2,
    includedExchangeCount: 2,
    contextTruncated: false,
    sourceAnswerTruncated: false,
  };
  const built = buildVerifiedFollowUpContext({
    parentRecord: followUpRecord({
      id: CHILD_ID, version: CHILD_VERSION, query: 'Q3', sourceId: PARENT_ID,
      sourceVersion: PARENT_VERSION,
    }),
    parentResult: { answer: 'i'.repeat(6_000) },
    parentLineage,
    parentPrivateContext: { version: 1, ...parentLineage, exchanges: [oldest, newest] },
    maxPriorContextChars: MAX_VERIFIED_CONTEXT_UTF16,
  });
  assert.deepEqual(built.privateContext.exchanges.map(({ operationId: id }) => id),
    [PARENT_ID, CHILD_ID]);
  assert.equal(built.privateContext.exchanges[0].answer, newest.answer);
  assert.equal(built.privateContext.exchanges[1].answer, 'i'.repeat(6_000));
  assert.equal(built.queryFollowUpLineage.availableExchangeCount, 3);
  assert.equal(built.queryFollowUpLineage.includedExchangeCount, 2);
  assert.equal(built.queryFollowUpLineage.contextTruncated, true);
  assert.ok(renderVerifiedConversation(built.verifiedConversationContext.exchanges).length
    <= MAX_VERIFIED_CONTEXT_UTF16);
});

test('exact 20,000-unit immediate context fits without truncation', () => {
  const built = buildVerifiedFollowUpContext({
    parentRecord: rootRecord({ query: 'Q' }),
    parentResult: { answer: vectors.exactBoundary.exchanges[0].answer },
    parentLineage: null,
    parentPrivateContext: null,
    maxPriorContextChars: MAX_VERIFIED_CONTEXT_UTF16,
  });
  assert.equal(renderVerifiedConversation(built.verifiedConversationContext.exchanges).length, 20_000);
  assert.equal(built.queryFollowUpLineage.sourceAnswerTruncated, false);
});

test('oversized immediate answers retain UTF-16-safe leading and trailing excerpts with exact marker', () => {
  const built = buildVerifiedFollowUpContext({
    parentRecord: rootRecord({ query: vectors.oversizedImmediate.query }),
    parentResult: { answer: vectors.oversizedImmediate.answer },
    parentLineage: null,
    parentPrivateContext: null,
    maxPriorContextChars: MAX_VERIFIED_CONTEXT_UTF16,
  });
  assert.equal(built.privateContext.exchanges[0].answer, vectors.oversizedImmediate.projectedAnswer);
  assert.equal(renderVerifiedConversation(built.verifiedConversationContext.exchanges),
    vectors.oversizedImmediate.rendered);
  assert.equal(vectors.oversizedImmediate.rendered.length, vectors.oversizedImmediate.utf16);
  assert.equal(built.queryFollowUpLineage.sourceAnswerTruncated, true);
  assert.equal(built.queryFollowUpLineage.contextTruncated, false);
  assert.equal(built.privateContext.exchanges[0].answer.includes(IMMEDIATE_ANSWER_OMISSION_MARKER), true);
  assertNoUnpairedSurrogates(built.privateContext.exchanges[0].answer);
});

test('lineage projection validates exact safe metadata and returns a detached copy', () => {
  const built = buildVerifiedFollowUpContext({
    parentRecord: rootRecord(),
    parentResult: { answer: 'First answer' },
    parentLineage: null,
    parentPrivateContext: null,
    maxPriorContextChars: MAX_VERIFIED_CONTEXT_UTF16,
  });
  const record = { queryFollowUpLineage: built.queryFollowUpLineage };
  assert.deepEqual(validateFollowUpLineage(record), built.queryFollowUpLineage);
  const projected = projectFollowUpLineage(record);
  assert.deepEqual(projected, built.queryFollowUpLineage);
  assert.notEqual(projected, built.queryFollowUpLineage);
  assert.equal(validateFollowUpLineage({ queryFollowUpLineage: null }), null);
  assert.equal(projectFollowUpLineage({}), null);
  assert.throws(() => validateFollowUpLineage({
    queryFollowUpLineage: { ...built.queryFollowUpLineage, operationId: CHILD_ID },
  }));
});

test('root and follow-up ancestry fail closed on missing pairs, mismatches, cycles, and invalid targets', () => {
  const root = rootRecord();
  const result = { answer: 'First answer' };
  assert.throws(() => buildVerifiedFollowUpContext({
    parentRecord: root, parentResult: result, parentLineage: null,
    parentPrivateContext: { version: 1 }, maxPriorContextChars: MAX_VERIFIED_CONTEXT_UTF16,
  }));
  assert.throws(() => buildVerifiedFollowUpContext({
    parentRecord: rootRecord({ overrides: { target: { domain: 'owned-run', brainId: 'brain-jerry' } } }),
    parentResult: result, parentLineage: null, parentPrivateContext: null,
    maxPriorContextChars: MAX_VERIFIED_CONTEXT_UTF16,
  }));

  const child = buildVerifiedFollowUpContext({
    parentRecord: root, parentResult: result, parentLineage: null,
    parentPrivateContext: null, maxPriorContextChars: MAX_VERIFIED_CONTEXT_UTF16,
  });
  const parent = followUpRecord();
  const base = {
    parentRecord: parent,
    parentResult: { answer: 'Second answer' },
    parentLineage: child.queryFollowUpLineage,
    parentPrivateContext: child.privateContext,
    maxPriorContextChars: MAX_VERIFIED_CONTEXT_UTF16,
  };
  assert.throws(() => buildVerifiedFollowUpContext({ ...base, parentPrivateContext: null }));
  assert.throws(() => buildVerifiedFollowUpContext({
    ...base,
    parentPrivateContext: { ...child.privateContext, depth: 2 },
  }));
  assert.throws(() => buildVerifiedFollowUpContext({
    ...base,
    parentPrivateContext: {
      ...child.privateContext,
      exchanges: [{ ...child.privateContext.exchanges[0], resultVersion: CHILD_VERSION }],
    },
  }));
  assert.throws(() => buildVerifiedFollowUpContext({
    ...base,
    parentRecord: followUpRecord({ id: ROOT_ID }),
  }), 'parent operation must not cycle into inherited identities');
  assert.throws(() => buildVerifiedFollowUpContext({
    ...base,
    parentRecord: followUpRecord({ sourceId: CHILD_ID }),
  }), 'durable follow-up reference must agree with inherited lineage');
});
