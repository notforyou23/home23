import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentLoop } from '../../src/agent/loop.js';
import { ConversationHistory } from '../../src/agent/history.js';
import { createTrackedAgentRunner } from '../../src/agent/turn-entrypoint.js';
import { createSeededToolRegistry } from '../../src/agent/tools/index.js';
import { spawnAgentTool } from '../../src/agent/tools/subagent.js';
import type { ToolContext, ToolDefinition } from '../../src/agent/types.js';
import { WorkRegistry } from '../../src/work/registry.js';
import { WorkStore } from '../../src/work/work-store.js';
import { requestAsyncWorkCancel } from '../../src/work/cancel.js';

for (const { cancel, resident } of [{ cancel: false, resident: false }, { cancel: true, resident: false }, { cancel: false, resident: true }]) test(`production tracked delegation: resident=${resident}, cancellation=${cancel}`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'h23-delegation-'));
  const workspace = join(root, 'worker');
  mkdirSync(workspace);
  const history = new ConversationHistory(join(root, 'history'), 400_000, 'harness-test');
  const workRegistry = new WorkRegistry({ store: new WorkStore(join(root, 'work')), agent: 'harness-test' });
  const originalFetch = globalThis.fetch;
  const priorKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key';
  const probes: ToolContext[] = [];
  const terminal: string[] = [];
  const requests: any[] = [];
  let entered!: () => void;
  const probeEntered = new Promise<void>(resolve => { entered = resolve; });
  const probe: ToolDefinition = {
    name: 'scope_probe', description: 'Record actual tool context',
    input_schema: { type: 'object', properties: {} },
    async execute(_input, ctx) {
      probes.push(ctx);
      entered();
      if (cancel) await new Promise<void>(resolve => {
        if (ctx.abortSignal?.aborted) resolve();
        else ctx.abortSignal?.addEventListener('abort', () => resolve(), { once: true });
      });
      return { content: 'scope checked' };
    },
  };
  const scoped = createSeededToolRegistry([spawnAgentTool, probe]);
  const forbidden: ToolDefinition = { ...probe, name: 'resident_only', execute: async () => { throw new Error('resident tool leaked'); } };
  const toolContext = {
    agentName: 'harness-test', chatId: 'ios_harness', workspacePath: root,
    brainOperations: { withActivityHandler() { return this; } },
    subAgentTracker: { active: 0, maxConcurrent: 3, queue: [] },
    conversationHistory: history, workRegistry,
    onWorkTerminal: (id: string) => { terminal.push(id); },
    turnRuntime: null,
  } as unknown as ToolContext;
  const agent = new AgentLoop({
    apiKey: 'test-key', model: 'gpt-5.5', provider: 'openai',
    registry: resident ? scoped : createSeededToolRegistry([forbidden]),
    contextManager: { getSystemPrompt: () => 'RESIDENT_BACKGROUND_MUST_NOT_LEAK', getPromptSourceInfo: () => ({ loadedFiles: [] }) } as never,
    history, toolContext, workspacePath: root,
  });
  toolContext.runAgentLoop = createTrackedAgentRunner(agent);
  try {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
      if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return new Response('{}', { status: 503 });
      const body = JSON.parse(String(init?.body));
      requests.push(body);
      const messages = body.messages as any[];
      const task = messages.find(m => m.role === 'user')?.content;
      const hasTool = messages.some(m => m.role === 'tool');
      if (hasTool) return Response.json({ choices: [{ message: { role: 'assistant', content: 'done' } }] });
      const name = task === 'parent task' ? 'spawn_agent' : 'scope_probe';
      const args = name === 'spawn_agent' ? { task: 'child task' } : {};
      return Response.json({ choices: [{ message: { role: 'assistant', content: null,
        tool_calls: [{ id: `call-${requests.length}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
      } }] });
    }) as typeof fetch;
    const parent = workRegistry.create({ kind: 'subagent', originChatId: 'ios_harness', label: 'parent', resultHandle: { type: 'subagent_chat', chatId: 'worker:parent' } });
    const result = resident
      ? await (await agent.runWithTurn('worker:parent', 'parent task', { parentWorkId: parent.workId })).response
      : await toolContext.runAgentLoop('WORKER_SCOPED_PROMPT', 'parent task', [], {
      ...toolContext, chatId: 'worker:parent', workspacePath: workspace, parentWorkId: parent.workId,
    }, { registry: scoped });
    assert.equal(result.text, 'done');
    await Promise.race([probeEntered, new Promise((_, reject) => setTimeout(() => reject(new Error('probe did not run')), 5000).unref())]);
    const child = workRegistry.list().find(w => w.parentWorkId === parent.workId)!;
    assert.ok(child, 'actual nested delegation must preserve parent linkage');
    assert.equal(child.originChatId, 'ios_harness');
    assert.equal(child.taskBrief, 'child task');
    assert.equal(probes[0].parentWorkId, child.workId);
    assert.equal(probes[0].workspacePath, resident ? root : workspace);
    assert.equal(probes[0].turnRuntime?.registry, scoped);
    if (cancel) {
      const outcome = requestAsyncWorkCancel({ registry: workRegistry, cancelCodingJob: async () => {}, stopChat: id => agent.stop(id).stopped }, child.workId);
      assert.equal(outcome.status, 'accepted');
    }
    const deadline = Date.now() + 5000;
    while (!terminal.includes(child.workId) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(terminal, [child.workId]);
    assert.equal(workRegistry.get(child.workId)?.status, cancel ? 'cancelled' : 'completed');
    for (const body of requests) {
      assert.deepEqual(body.tools.map((t: any) => t.function.name).sort(), ['scope_probe', 'spawn_agent']);
      if (!resident) {
        assert.match(JSON.stringify(body.messages), /WORKER_SCOPED_PROMPT/);
        assert.doesNotMatch(JSON.stringify(body.messages), /RESIDENT_BACKGROUND_MUST_NOT_LEAK/);
      }
    }
  } finally {
    for (const ctx of probes) agent.stop(ctx.chatId);
    globalThis.fetch = originalFetch;
    if (priorKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = priorKey;
    rmSync(root, { recursive: true, force: true });
  }
});
