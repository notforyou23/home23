import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  executeAndFormatTool,
  operationToolResult,
  projectBrainToolEventMetadata,
  recoverableExcerpt,
} from '../../src/agent/tool-result.js';
import { makeBrainOperationRecord } from '../helpers/brain-operation-record.js';

test('is_error always produces an unsuccessful tool event', async () => {
  const events: Array<Record<string, unknown>> = [];
  const registry = {
    execute: async () => ({ content: 'provider failed', is_error: true }),
  };
  const rendered = await executeAndFormatTool({
    registry: registry as never,
    name: 'brain_query',
    input: {},
    context: {} as never,
    onEvent: event => events.push(event as unknown as Record<string, unknown>),
    modelLimit: 4000,
    eventLimit: 4000,
  });
  assert.equal(rendered.success, false);
  assert.equal(rendered.result.is_error, true);
  assert.equal(events[0]?.success, false);
});

test('brain tool events retain bounded durable identity without private metadata', async () => {
  const events: Array<Record<string, unknown>> = [];
  const registry = { execute: async () => ({
    content: 'Started in the background',
    resultHandle: 'brres_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    metadata: {
      operationId: 'brop_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      operationType: 'pgs',
      state: 'running',
      attachmentState: 'detached',
      classification: 'detached',
      pgs: { successfulSweeps: 3, pendingWorkUnits: 7, token: 'must-not-escape' },
      sourceEvidence: {
        sourceHealth: 'healthy', currentRevision: 42, path: '/Users/jtr/private',
      },
      token: 'must-not-escape',
      path: '/Users/jtr/private',
    },
  }) };

  await executeAndFormatTool({
    registry: registry as never,
    name: 'brain_query',
    input: {},
    context: {} as never,
    onEvent: event => events.push(event as unknown as Record<string, unknown>),
    modelLimit: 4_000,
    eventLimit: 4_000,
  });

  assert.deepEqual(events[0], {
    type: 'tool_result',
    tool: 'brain_query',
    result: 'Started in the background',
    success: true,
    resultHandle: 'brres_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    toolMetadata: {
      operationId: 'brop_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      operationType: 'pgs',
      state: 'running',
      attachmentState: 'detached',
      classification: 'detached',
      pgs: { successfulSweeps: 3, pendingWorkUnits: 7 },
      sourceEvidence: { sourceHealth: 'healthy', currentRevision: 42 },
    },
  });
  assert.ok(Buffer.byteLength(JSON.stringify(events[0]?.toolMetadata)) <= 32 * 1024);
});

test('structured event metadata is omitted for non-brain tools and malformed identifiers', async () => {
  for (const [name, operationId] of [
    ['shell', 'brop_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
    ['brain_query', 'op-not-canonical'],
  ] as const) {
    const events: Array<Record<string, unknown>> = [];
    const registry = { execute: async () => ({
      content: 'ok',
      resultHandle: 'not-a-result-handle',
      metadata: { operationId, state: 'complete', token: 'private' },
    }) };
    await executeAndFormatTool({
      registry: registry as never,
      name,
      input: {},
      context: {} as never,
      onEvent: event => events.push(event as unknown as Record<string, unknown>),
      modelLimit: 4_000,
      eventLimit: 4_000,
    });
    assert.equal(Object.hasOwn(events[0]!, 'toolMetadata'), false);
    assert.equal(Object.hasOwn(events[0]!, 'resultHandle'), false);
  }
});

test('typed brain failures remain unsuccessful and retain bounded typed failure metadata', async () => {
  const events: Array<Record<string, unknown>> = [];
  const registry = { execute: async () => ({
    content: 'operation failed',
    is_error: true,
    metadata: {
      operationId: 'brop_cccccccccccccccccccccccccccccccc',
      operationType: 'query',
      state: 'failed',
      classification: 'failed',
      error: { code: 'provider_timeout', message: 'Provider did not finish', retryable: true },
    },
  }) };
  await executeAndFormatTool({
    registry: registry as never,
    name: 'brain_query', input: {}, context: {} as never,
    onEvent: event => events.push(event as unknown as Record<string, unknown>),
    modelLimit: 4_000, eventLimit: 4_000,
  });
  assert.equal(events[0]?.success, false);
  assert.deepEqual((events[0]?.toolMetadata as Record<string, unknown>)?.error, {
    code: 'provider_timeout', message: 'Provider did not finish', retryable: true,
  });
});

test('operation renderer supplies operation type and attachment state to the event projection', () => {
  const operation = makeBrainOperationRecord({
    operationId: 'brop_dddddddddddddddddddddddddddddddd',
    operationType: 'pgs',
    state: 'running',
  });
  operation.attachmentState = 'detached';
  const projected = projectBrainToolEventMetadata('brain_query', operationToolResult(operation));
  assert.deepEqual(projected.toolMetadata, {
    operationId: 'brop_dddddddddddddddddddddddddddddddd',
    operationType: 'pgs',
    state: 'running',
    attachmentState: 'detached',
    classification: 'running',
  });
});

test('shortened brain output names truncation and the full result handle', async () => {
  const registry = { execute: async () => ({
    content: 'x'.repeat(1000),
    resultHandle: 'brres_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    metadata: { operationId: 'op-42' },
  }) };
  const rendered = await executeAndFormatTool({
    registry: registry as never,
    name: 'brain_query',
    input: {},
    context: {} as never,
    modelLimit: 160,
    eventLimit: 180,
  });
  assert.match(rendered.modelContent, /OUTPUT TRUNCATED/);
  assert.match(rendered.modelContent, /brres_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/);
  assert.equal(rendered.modelContent.length, 160);
  assert.equal(rendered.eventContent.length, 180);
  assert.equal(rendered.success, true);
});

test('display limits are strict finite safe integers and too-small recoverable markers fail closed', async () => {
  let registryCalls = 0;
  const registry = { execute: async () => {
    registryCalls += 1;
    return {
      content: '😀'.repeat(200),
      resultHandle: 'brres_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      metadata: { operationId: 'op-limit' },
    };
  } };
  for (const value of [NaN, Infinity, 1.5, -1, 20]) {
    await assert.rejects(executeAndFormatTool({
      registry: registry as never,
      name: 'brain_query',
      input: {},
      context: {} as never,
      onEvent: () => {},
      modelLimit: value,
      eventLimit: 180,
    }), /display_limit_invalid|recoverable_marker_too_large/);
  }
  assert.equal(registryCalls, 0, 'invalid display contracts fail before tool side effects');

  const rendered = await executeAndFormatTool({
    registry: registry as never,
    name: 'brain_query',
    input: {},
    context: {} as never,
    onEvent: () => {},
    modelLimit: 160,
    eventLimit: 180,
  });
  assert.equal(rendered.modelContent.length, 160);
  assert.equal(rendered.eventContent.length, 180);
  assert.match(rendered.modelContent, /OUTPUT TRUNCATED/);
  assert.match(rendered.eventContent, /op-limit/);
  assert.equal(/[\uD800-\uDBFF]$/.test(rendered.modelContent), false);
});

test('recoverable excerpt leaves short output byte-for-byte unchanged', () => {
  assert.equal(recoverableExcerpt('short answer', 128, {}), 'short answer');
});

test('complete operation display preserves non-answer result fields such as requester output paths', () => {
  const rendered = operationToolResult({
    ...makeBrainOperationRecord({
      operationId: 'op-output-path',
      state: 'complete',
      result: { answer: 'compiled section', path: 'workspace/research/section.md', bytes: 42 },
    }),
    attachmentState: 'closed',
  });
  assert.match(rendered.content, /compiled section/);
  assert.match(rendered.content, /workspace\/research\/section\.md/);
  assert.match(rendered.content, /"bytes":42/);
});

test('provider branches cannot bypass centralized tool result execution', () => {
  const source = readFileSync(new URL('../../src/agent/loop.ts', import.meta.url), 'utf8');
  assert.equal((source.match(/registry\.execute\(/g) || []).length, 0);
  assert.equal((source.match(/\.execute\(input, runContext\)/g) || []).length, 0);
  assert.ok((source.match(/executeAndFormatTool\(/g) || []).length >= 4);
  assert.doesNotMatch(source, /tool_result[^\n]+success:\s*true/);
});
