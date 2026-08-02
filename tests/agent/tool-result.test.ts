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
        retrievalMode: 'semantic-ann-delta-overlay',
        indexCoverage: {
          complete: true, indexedRevision: 40, currentRevision: 42,
          coveredThroughRevision: 42, deltaRecords: 2, distinctChangedNodes: 1,
          route: 'ann-plus-delta', completeness: 'complete', path: '/Users/jtr/private',
        },
        stageTimingsMs: { sourceOpen: 1.25, response: 4.5, path: '/Users/jtr/private' },
        authoritySummary: {
          total: 1,
          authorityClasses: { verified_current_state: 1 },
          retrievalDomains: { current_ops: 1 },
          sourceChain: {
            withEvidence: 1, withoutEvidence: 0, referenceCounts: { evidence: 1 },
          },
          requiresFreshVerification: 0,
          path: '/Users/jtr/private',
        },
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
      sourceEvidence: {
        sourceHealth: 'healthy', currentRevision: 42,
        retrievalMode: 'semantic-ann-delta-overlay',
        indexCoverage: {
          complete: true, indexedRevision: 40, currentRevision: 42,
          coveredThroughRevision: 42, deltaRecords: 2, distinctChangedNodes: 1,
          route: 'ann-plus-delta', completeness: 'complete',
        },
        stageTimingsMs: { sourceOpen: 1.25, response: 4.5 },
        authoritySummary: {
          total: 1,
          authorityClasses: { verified_current_state: 1 },
          retrievalDomains: { current_ops: 1 },
          sourceChain: {
            withEvidence: 1, withoutEvidence: 0, referenceCounts: { evidence: 1 },
          },
          requiresFreshVerification: 0,
        },
      },
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

// ── an empty 'complete' is a failure wearing a success label (2026-08-02) ──
// Recovered from codex/brain-agent-task5 (dc2e6a13). A query/pgs run that
// reaches state 'complete' with no answer text used to render as a successful
// empty result: the caller saw green and nothing else. It now fails closed.

test('a query that completes with no answer text is reported as an error, not success', () => {
  for (const operationType of ['query', 'pgs'] as const) {
    const rendered = operationToolResult({
      ...makeBrainOperationRecord({
        operationId: `op-empty-${operationType}`,
        state: 'complete',
        result: { answer: '   ' },
      }),
      operationType,
      attachmentState: 'closed',
    });
    assert.equal(rendered.is_error, true, `${operationType} must fail closed`);
    assert.match(rendered.content, /invalid_complete_result/);
    assert.equal(rendered.metadata?.classification, 'invalid_complete_result');
  }
});

test('a query that completes WITH an answer is still a success', () => {
  const rendered = operationToolResult({
    ...makeBrainOperationRecord({
      operationId: 'op-real-answer',
      state: 'complete',
      result: { answer: 'a real answer' },
    }),
    operationType: 'query',
    attachmentState: 'closed',
  });
  assert.notEqual(rendered.is_error, true);
  assert.match(rendered.content, /a real answer/);
});

test('provider branches cannot bypass centralized tool result execution', () => {
  const source = readFileSync(new URL('../../src/agent/loop.ts', import.meta.url), 'utf8');
  assert.equal((source.match(/registry\.execute\(/g) || []).length, 0);
  assert.equal((source.match(/\.execute\(input, runContext\)/g) || []).length, 0);
  assert.ok((source.match(/executeAndFormatTool\(/g) || []).length >= 4);
  assert.doesNotMatch(source, /tool_result[^\n]+success:\s*true/);
});

// ── recoverable excerpts must teach paging (2026-07-20) ───────────────
// jerry's 26k-char consciousness answer was fully stored while the display
// cap re-clipped every fetch at the same 4,000 chars: the old marker named
// the operation but not how to get the rest. At production limits the
// marker now spells out the exact brain_status paging call; at tiny limits
// it degrades to the compact locator so small displays keep working.

test('at production limits the truncation marker spells out the paging call', () => {
  const content = 'a'.repeat(26_185);
  const excerpt = recoverableExcerpt(content, 4000, {
    operationId: 'brop_EybSxmo77gQWHb3odPB_sKjjzYTqJsGh',
    resultHandle: null,
  });
  assert.ok(excerpt.length <= 4000);
  const match = excerpt.match(/\[OUTPUT TRUNCATED: chars 0-(\d+) of 26185; continue with brain_status \{"action":"result","operationId":"brop_EybSxmo77gQWHb3odPB_sKjjzYTqJsGh","offset":(\d+)\}\]$/);
  assert.ok(match, `marker must teach the exact paging call, got tail: ${excerpt.slice(-220)}`);
  assert.equal(match![1], match![2], 'shown-end and next offset must agree');
  const shownEnd = Number(match![1]);
  assert.ok(shownEnd > 3000 && shownEnd < 4000, 'each page must make real progress');
});

test('paging a sliced result carries the offset through the marker math', () => {
  const total = 26_185;
  const offset = 3_800;
  const remainder = 'b'.repeat(total - offset);
  const excerpt = recoverableExcerpt(remainder, 4000, {
    operationId: 'brop_EybSxmo77gQWHb3odPB_sKjjzYTqJsGh',
    resultHandle: null,
    contentOffset: offset,
  });
  const match = excerpt.match(/chars 3800-(\d+) of 26185;.*"offset":(\d+)\}\]$/);
  assert.ok(match, `marker must window from the base offset, got tail: ${excerpt.slice(-220)}`);
  assert.equal(match![1], match![2]);
  assert.ok(Number(match![1]) > offset, 'next offset must advance past the base');
});

test('repeated paging terminates and covers the full content', () => {
  const content = Array.from({ length: 26_000 }, (_, i) => String.fromCharCode(97 + (i % 26))).join('');
  let offset = 0;
  let reconstructed = '';
  for (let page = 0; page < 40; page += 1) {
    const remainder = content.slice(offset);
    const excerpt = recoverableExcerpt(remainder, 4000, {
      operationId: 'brop_EybSxmo77gQWHb3odPB_sKjjzYTqJsGh',
      contentOffset: offset,
    });
    const match = excerpt.match(/"offset":(\d+)\}\]$/);
    if (!match) {
      reconstructed += excerpt; // final page arrives whole
      offset = content.length;
      break;
    }
    const next = Number(match[1]);
    reconstructed += excerpt.slice(0, excerpt.indexOf('\n\n[OUTPUT TRUNCATED'));
    assert.ok(next > offset, 'every page must advance');
    offset = next;
  }
  assert.equal(offset, content.length, 'paging must reach the end');
  assert.equal(reconstructed, content, 'concatenated pages must equal the original');
});

test('tiny display limits fall back to the compact locator instead of failing', () => {
  const excerpt = recoverableExcerpt('x'.repeat(1000), 160, {
    operationId: 'brop_EybSxmo77gQWHb3odPB_sKjjzYTqJsGh',
    resultHandle: 'brres_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  });
  assert.equal(excerpt.length, 160);
  assert.match(excerpt, /OUTPUT TRUNCATED; full result: handle=/);
  assert.equal(/"offset"/.test(excerpt), false, 'no paging promise it cannot keep');
});
