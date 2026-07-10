import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  executeAndFormatTool,
  recoverableExcerpt,
} from '../../src/agent/tool-result.js';

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

test('provider branches cannot bypass centralized tool result execution', () => {
  const source = readFileSync(new URL('../../src/agent/loop.ts', import.meta.url), 'utf8');
  assert.equal((source.match(/registry\.execute\(/g) || []).length, 0);
  assert.equal((source.match(/\.execute\(input, runContext\)/g) || []).length, 0);
  assert.ok((source.match(/executeAndFormatTool\(/g) || []).length >= 4);
  assert.doesNotMatch(source, /tool_result[^\n]+success:\s*true/);
});
