'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  RESEARCH_COMPILE_MAX_OUTPUT_BYTES,
  createResearchCompileProviderAdapter,
} = require('../../cosmo23/server/lib/research-compile-provider-adapter');
const {
  requireCompleteProviderResult,
} = require('../../cosmo23/lib/provider-completion');

function complete(content = '# Compiled\n\nEvidence.', {
  provider = 'beta',
  model = 'shared-model',
} = {}) {
  return {
    status: 'complete',
    content,
    terminalReceived: true,
    finishReason: 'stop',
    error: null,
    provider,
    model,
  };
}

function harness(overrides = {}) {
  const events = [];
  const providerCalls = [];
  const writes = [];
  const clients = {
    alpha: {
      providerId: 'alpha',
      async generate(input) {
        providerCalls.push(['alpha', input]);
        return complete('wrong provider');
      },
    },
    beta: {
      providerId: 'beta',
      async generate(input) {
        providerCalls.push(['beta', input]);
        input.onProviderActivity?.({ type: 'token', at: '2025-07-10T00:00:00.000Z' });
        input.onProviderActivity?.({ type: 'token', at: '2027-07-10T00:00:00.000Z' });
        input.onProviderActivity?.({ type: 'token', at: 'not-a-time' });
        input.onProviderActivity?.({ type: 'x'.repeat(200), at: '2'.repeat(65) });
        return complete();
      },
    },
    ...overrides.clients,
  };
  const compile = createResearchCompileProviderAdapter({
    resolveConfiguredPair: overrides.resolveConfiguredPair
      || (() => ({ provider: 'beta', model: 'shared-model' })),
    getExactProviderClient: overrides.getExactProviderClient
      || ((provider) => clients[provider]),
    requireCompleteProviderResult,
    getModelCapabilities: overrides.getModelCapabilities
      || (() => ({ maxOutputTokens: 4096, providerStallMs: 900_000 })),
  });
  const controller = overrides.controller || new AbortController();
  const context = {
    operationId: 'brop_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef',
    operationType: 'research_compile',
    requesterAgent: 'jerry',
    parameters: { kind: 'section', section: 'goal', sectionId: 'goal-1', focus: 'proof' },
    signal: controller.signal,
    sourcePin: {
      getEvidence() {
        return { sourceType: 'native', cutoffRevision: 41, canonicalRoot: '/brain' };
      },
    },
    reportEvent(event) {
      events.push(structuredClone(event));
    },
    ...overrides.context,
  };
  const writer = overrides.writer || {
    async writeAtomic(basename, bytes) {
      writes.push([basename, Buffer.from(bytes)]);
      return { relativePath: `research/${basename}`, bytes: bytes.length };
    },
  };
  return { clients, compile, context, controller, events, providerCalls, writer, writes };
}

function request(h) {
  return {
    context: h.context,
    sectionContent: { nodes: [{ id: 'n1', content: 'verified fact' }], edges: [] },
    sectionSelection: { kind: 'section', section: 'goal', sectionId: 'goal-1' },
    sourceEvidence: h.context.sourcePin.getEvidence(),
    writer: h.writer,
  };
}

test('uses only the exact configured provider/model and publishes through the writer capability', async () => {
  const h = harness();
  const result = await h.compile(request(h));
  assert.equal(result.state, 'complete');
  assert.equal(result.result.provider, 'beta');
  assert.equal(result.result.model, 'shared-model');
  assert.equal(result.result.relativePath.startsWith('research/research-compile-'), true);
  assert.equal(h.providerCalls.length, 1);
  assert.equal(h.providerCalls[0][0], 'beta');
  assert.equal(h.providerCalls[0][1].provider, 'beta');
  assert.equal(h.providerCalls[0][1].model, 'shared-model');
  assert.equal(h.providerCalls[0][1].maxOutputTokens, 4096);
  assert.equal(h.providerCalls[0][1].maxOutputBytes, RESEARCH_COMPILE_MAX_OUTPUT_BYTES);
  assert.equal(h.writes.length, 1);
  assert.match(h.writes[0][0], /^research-compile-[a-f0-9]{24}\.md$/);
  assert.equal(h.writes[0][1].toString('utf8'), '# Compiled\n\nEvidence.');
});

test('research compile exact byte boundary publishes and one byte over never reaches the writer', async () => {
  const exactContent = 'x'.repeat(RESEARCH_COMPILE_MAX_OUTPUT_BYTES);
  const exact = harness({
    clients: {
      beta: {
        providerId: 'beta',
        async generate(input) {
          exact.providerCalls.push(['beta', input]);
          assert.equal(input.maxOutputBytes, RESEARCH_COMPILE_MAX_OUTPUT_BYTES);
          return complete(exactContent);
        },
      },
    },
  });
  const published = await exact.compile(request(exact));
  assert.equal(published.state, 'complete');
  assert.equal(exact.writes.length, 1);
  assert.equal(exact.writes[0][1].length, RESEARCH_COMPILE_MAX_OUTPUT_BYTES);

  const over = harness({
    clients: {
      beta: {
        providerId: 'beta',
        async generate(input) {
          over.providerCalls.push(['beta', input]);
          return complete('x'.repeat(input.maxOutputBytes + 1));
        },
      },
    },
  });
  await assert.rejects(over.compile(request(over)), {
    code: 'result_too_large', retryable: false,
  });
  assert.equal(over.providerCalls.length, 1);
  assert.equal(over.writes.length, 0);
  assert.equal(over.events.at(-1).outcome, 'failed');
});

test('emits authoritative selected/activity/terminal events without trusting child timestamps', async () => {
  const h = harness();
  await h.compile(request(h));
  assert.deepEqual(h.events.map((event) => event.type), [
    'provider_selected',
    'provider_activity',
    'provider_activity',
    'provider_activity',
    'provider_activity',
    'provider_call_terminal',
  ]);
  for (const event of h.events) {
    assert.equal(event.phase, 'research_compile');
    assert.equal(event.providerCallId, 'research_compile');
    assert.equal(event.provider, 'beta');
    assert.equal(event.model, 'shared-model');
    assert.equal(Object.hasOwn(event, 'at'), false);
  }
  assert.equal(h.events[0].providerStallMs, 900_000);
  assert.equal(h.events[1].providerEventAt, '2025-07-10T00:00:00.000Z');
  assert.equal(h.events[2].providerEventAt, '2027-07-10T00:00:00.000Z');
  assert.equal(Object.hasOwn(h.events[3], 'providerEventAt'), false);
  assert.equal(Object.hasOwn(h.events[4], 'providerEventAt'), false);
  assert.equal(Object.hasOwn(h.events[4], 'providerEventType'), false);
  assert.equal(h.events.at(-1).outcome, 'complete');
});

test('provider failure emits failed terminal and never writes output', async () => {
  const h = harness({
    clients: {
      beta: {
        providerId: 'beta',
        async generate() {
          throw Object.assign(new Error('offline'), { code: 'provider_unavailable' });
        },
      },
    },
  });
  await assert.rejects(h.compile(request(h)), { code: 'provider_unavailable' });
  assert.equal(h.writes.length, 0);
  assert.deepEqual(h.events.map((event) => event.type), [
    'provider_selected', 'provider_call_terminal',
  ]);
  assert.equal(h.events.at(-1).outcome, 'failed');
});

test('cancellation is forwarded and emits cancelled terminal without output', async () => {
  const controller = new AbortController();
  const h = harness({
    controller,
    clients: {
      beta: {
        providerId: 'beta',
        async generate(input) {
          controller.abort(Object.assign(new Error('cancelled'), {
            code: 'operation_cancelled', retryable: false,
          }));
          input.signal.throwIfAborted();
        },
      },
    },
  });
  await assert.rejects(h.compile(request(h)), { code: 'operation_cancelled' });
  assert.equal(h.writes.length, 0);
  assert.equal(h.events.at(-1).outcome, 'cancelled');
});

test('incomplete completion and output boundary failures never claim success', async () => {
  const incomplete = harness({
    clients: {
      beta: {
        providerId: 'beta',
        async generate() {
          return { status: 'partial', content: 'truncated', finishReason: 'length' };
        },
      },
    },
  });
  await assert.rejects(incomplete.compile(request(incomplete)), { code: 'provider_incomplete' });
  assert.equal(incomplete.writes.length, 0);
  assert.equal(incomplete.events.at(-1).outcome, 'failed');

  const boundary = harness({
    writer: {
      async writeAtomic() {
        throw Object.assign(new Error('swapped'), { code: 'output_boundary_changed' });
      },
    },
  });
  await assert.rejects(boundary.compile(request(boundary)), { code: 'output_boundary_changed' });
  assert.equal(boundary.events.at(-1).outcome, 'failed');
});

test('rejects caller provider/output authority and mismatched provider clients', async () => {
  const caller = harness({
    context: {
      parameters: { kind: 'brain', provider: 'alpha' },
    },
  });
  await assert.rejects(caller.compile(request(caller)), { code: 'provider_model_mismatch' });
  assert.equal(caller.providerCalls.length, 0);
  assert.equal(caller.writes.length, 0);

  const mismatch = harness({
    getExactProviderClient: () => ({ providerId: 'alpha', async generate() {} }),
  });
  await assert.rejects(mismatch.compile(request(mismatch)), { code: 'provider_model_mismatch' });
  assert.equal(mismatch.events.length, 0);
  assert.equal(mismatch.writes.length, 0);

  const completionMismatch = harness({
    clients: {
      beta: {
        providerId: 'beta',
        async generate() {
          return complete('wrong model', { model: 'other-model' });
        },
      },
    },
  });
  await assert.rejects(completionMismatch.compile(request(completionMismatch)), {
    code: 'provider_model_mismatch',
  });
  assert.equal(completionMismatch.writes.length, 0);
});
