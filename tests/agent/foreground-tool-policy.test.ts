import assert from 'node:assert/strict';
import { test } from 'node:test';
import { executeAndFormatTool } from '../../src/agent/tool-result.js';
import {
  FOREGROUND_SHELL_MAX_TIMEOUT_MS,
  applyForegroundToolPolicy,
} from '../../src/agent/foreground-tool-policy.js';

const foreground = { chatId: 'ios_chat', turnRuntime: { turnId: 't_1' } };

test('foreground coding and spawn_agent hand off before they can hold the speaking turn', () => {
  const coding = applyForegroundToolPolicy('coding_run', { prompt: 'build it', wait_seconds: 120 }, foreground);
  assert.equal(coding.action, 'handoff');
  assert.equal(coding.input.wait_seconds, 0);

  const spawn = applyForegroundToolPolicy('spawn_agent', { task: 'deep work', mode: 'joined' }, foreground);
  assert.equal(spawn.action, 'handoff');
  assert.equal(spawn.input.mode, 'detached');

  const shell = applyForegroundToolPolicy('shell', { command: 'sleep 30', timeout_ms: 300_000 }, foreground);
  assert.equal(shell.action, 'handoff');
  assert.equal(shell.input.timeout_ms, FOREGROUND_SHELL_MAX_TIMEOUT_MS);
});

test('foreground worker_run is refused until Lane 2 creates Work', () => {
  const decision = applyForegroundToolPolicy('worker_run', { worker: 'systems', prompt: 'check' }, foreground);
  assert.equal(decision.action, 'require_work');
  assert.equal(decision.request?.tool, 'worker_run');
});

test('Work / coordination turns are not bound by the speaking-turn tool policy', () => {
  const decision = applyForegroundToolPolicy(
    'worker_run',
    { worker: 'systems', prompt: 'check' },
    { chatId: 'coordination:ch:w1', turnRuntime: { coordinationOrigin: { kind: 'coordination' } } as never },
  );
  assert.equal(decision.action, 'permit');
});

test('executeAndFormatTool refuses worker_run in the foreground and records the detach hook', async () => {
  const requests: unknown[] = [];
  let executed = 0;
  const rendered = await executeAndFormatTool({
    registry: {
      execute: async () => {
        executed += 1;
        return { content: 'should not run' };
      },
    } as never,
    name: 'worker_run',
    toolCallId: 'call-1',
    input: { worker: 'systems', prompt: 'check' },
    context: {
      chatId: 'ios_chat',
      turnRuntime: { turnId: 't_fg' },
      onForegroundDetachRequired: (request) => requests.push(request),
    } as never,
    modelLimit: 4000,
    eventLimit: 4000,
  });
  assert.equal(executed, 0);
  assert.equal(rendered.success, false);
  assert.match(rendered.result.content, /was not started/);
  assert.match(rendered.result.content, /must become durable Work/);
  assert.match(rendered.result.content, /[Dd]o not claim this assignment exists as Work/);
  assert.doesNotMatch(rendered.result.content, /Detach is not wired yet/);
  assert.match(rendered.result.content, /already active/);
  assert.doesNotMatch(rendered.result.content, /being treated as background Work/);
  assert.equal((requests[0] as { tool: string }).tool, 'worker_run');
});

test('executeAndFormatTool forces coding wait_seconds to 0 in the foreground', async () => {
  let captured: Record<string, unknown> | null = null;
  const rendered = await executeAndFormatTool({
    registry: {
      execute: async (_name: string, input: Record<string, unknown>) => {
        captured = input;
        return { content: 'started job' };
      },
    } as never,
    name: 'coding_run',
    toolCallId: 'call-2',
    input: { prompt: 'build it', wait_seconds: 90 },
    context: { chatId: 'ios_chat', turnRuntime: { turnId: 't_fg' } } as never,
    modelLimit: 4000,
    eventLimit: 4000,
  });
  assert.equal(rendered.success, true);
  assert.equal(captured?.wait_seconds, 0);
});
