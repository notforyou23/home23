import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnAgentTool } from '../../../src/agent/tools/subagent.js';
import type { ToolContext, AgentResponse } from '../../../src/agent/types.js';

interface Captured {
  ctx: ToolContext | null;
  options: unknown;
  appends: Array<{ chatId: string; records: unknown[] }>;
  delivered: Promise<void>;
}

function makeCtx(parentChatId: string): { ctx: ToolContext; captured: Captured } {
  let resolveDelivered!: () => void;
  const captured: Captured = {
    ctx: null,
    options: undefined,
    appends: [],
    delivered: new Promise<void>((resolve) => { resolveDelivered = resolve; }),
  };

  const response: AgentResponse = { text: 'sub result', model: 'test', toolCallCount: 0, durationMs: 1 };

  const ctx = {
    scheduler: null,
    ttsService: null,
    browser: null,
    projectRoot: '/tmp/home23',
    enginePort: 5001,
    agentName: 'jerry',
    cosmo23BaseUrl: 'http://localhost:43210',
    brainRoute: null,
    workspacePath: '/tmp/home23/instances/jerry/workspace',
    tempDir: '/tmp/home23/.tmp',
    contextManager: {
      getSystemPrompt: () => 'system prompt',
      getPromptSourceInfo: () => ({ generatedAt: '', totalSections: 0, loadedFiles: [] }),
      invalidate: () => undefined
    },
    subAgentTracker: { active: 0, maxConcurrent: 3, queue: [] },
    chatId: parentChatId,
    telegramAdapter: null,
    runAgentLoop: async (_sys: string, _msg: string, _tools: unknown[], subCtx: ToolContext, options?: unknown) => {
      captured.ctx = subCtx;
      captured.options = options;
      return response;
    },
    conversationHistory: {
      append(chatId: string, records: unknown[]) {
        captured.appends.push({ chatId, records });
        resolveDelivered();
      },
    },
  } as unknown as ToolContext;

  return { ctx, captured };
}

test('spawn_agent isolates the sub-agent under a subagent: chat id while delivery targets the parent', async () => {
  const { ctx, captured } = makeCtx('parent-chat');
  const result = await spawnAgentTool.execute({ task: 'audit the scheduler' }, ctx);
  assert.match(result.content, /Sub-agent spawned/);

  await captured.delivered;

  assert.ok(captured.ctx, 'runAgentLoop received a ctx');
  const subChatId = captured.ctx!.chatId;
  assert.ok(subChatId.startsWith('subagent:parent-chat:'), `sub chat id has the subagent prefix (got ${subChatId})`);
  assert.notEqual(subChatId, 'parent-chat');
  assert.match(subChatId, /^subagent:parent-chat:[0-9a-f]{4}$/);

  assert.equal(captured.appends.length, 1, 'exactly one history append');
  assert.equal(captured.appends[0].chatId, 'parent-chat', 'history append targets the parent chat id');
  const record = captured.appends[0].records[0] as { role: string; content: string };
  assert.equal(record.role, 'assistant');
  assert.match(record.content, /Sub-agent complete/);
  assert.match(record.content, /sub result/);
});

test('spawn_agent isolated:false preserves the legacy shared-chat behavior', async () => {
  const { ctx, captured } = makeCtx('parent-chat');
  const result = await spawnAgentTool.execute({ task: 'quick check', isolated: false }, ctx);
  assert.match(result.content, /Sub-agent spawned/);

  await captured.delivered;

  assert.equal(captured.ctx!.chatId, 'parent-chat', 'sub-agent runs under the parent chat id');
  assert.equal(captured.appends[0].chatId, 'parent-chat');
});

test('spawn_agent threads a model override through to the loop runner', async () => {
  const { ctx, captured } = makeCtx('parent-chat');
  await spawnAgentTool.execute({ task: 'model check', model: 'claude-opus-4-8' }, ctx);
  await captured.delivered;

  assert.deepEqual(captured.options, { modelOverride: { model: 'claude-opus-4-8' } });
});

test('spawn_agent passes no options when no model is requested', async () => {
  const { ctx, captured } = makeCtx('parent-chat');
  await spawnAgentTool.execute({ task: 'no model' }, ctx);
  await captured.delivered;

  assert.equal(captured.options, undefined);
});
