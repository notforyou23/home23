import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentLoop } from '../../src/agent/loop.js';
import { ConversationHistory } from '../../src/agent/history.js';
import { CompactionManager } from '../../src/agent/compaction.js';
import { createSeededToolRegistry } from '../../src/agent/tools/index.js';
import { taskContextTool } from '../../src/agent/tools/task-context.js';
import { steerQueue } from '../../src/agent/steer-queue.js';

for (const scenario of ['checkpoint', 'tool-growth', 'interruption', 'overhead'] as const) {
  test(`actual AgentLoop context management: ${scenario}`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'context-loop-'));
    mkdirSync(join(root, 'workspace'));
    const history = new ConversationHistory(join(root, 'history'), scenario === 'overhead' ? 1000 : 26000, 'test');
    const chatId = `context-${scenario}`;
    if (scenario === 'checkpoint') {
      for (let i = 0; i < 12; i++) history.append(chatId, [
        { role: 'user', content: `Original instruction ${i}: do not deploy. ${'evidence '.repeat(450)}` },
        { role: 'assistant', content: `Observed ${i}; unfinished.` },
      ]);
    }
    history.taskContext.note(chatId, 'next', 'Keep the no-deployment constraint; check the final result.');
    const compaction = new CompactionManager({ client: {} as never, memory: {} as never, history,
      provider: 'openai', model: 'gpt-5.5', apiKey: 'test-key',
      config: { reserveChars: 1000, maxSummaryChars: 1000, keepRecentMessages: 2 },
    });
    let executions = 0;
    const registry = createSeededToolRegistry([taskContextTool, {
      name: 'large_evidence', description: 'Return a long result', input_schema: { type: 'object', properties: {} },
      async execute() {
        executions++;
        if (scenario === 'interruption') steerQueue.enqueue(chatId, `Stop and retain this correction: ${'protected '.repeat(4000)}`);
        return { content: `receipt-${executions}: ${'payload '.repeat(2000)} END-EXACT-${executions}` };
      },
    }]);
    const agent = new AgentLoop({ apiKey: 'test-key', model: 'gpt-5.5', provider: 'openai', maxTokens: 256,
      registry, history, compaction,
      contextManager: { getSystemPrompt: () => 'Test context continuity.', getPromptSourceInfo: () => ({ loadedFiles: [] }) } as never,
      toolContext: { brainOperations: { withActivityHandler() { return this; } }, turnRuntime: null } as never,
      workspacePath: join(root, 'workspace'),
    });
    const previousFetch = globalThis.fetch;
    const previousKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'test-key';
    t.after(() => {
      globalThis.fetch = previousFetch;
      if (previousKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previousKey;
      rmSync(root, { recursive: true, force: true });
    });
    const requests: any[][] = [];
    let summaries = 0;
    let requestedRead = false;
    globalThis.fetch = (async (url, init) => {
      if (/localhost|127\.0\.0\.1/.test(String(url))) return new Response('{}', { status: 503 });
      const body = JSON.parse(String(init?.body));
      if (String(body.messages?.[0]?.content).startsWith('Summarize conversation evidence')) {
        summaries++;
        return Response.json({ choices: [{ message: { content: 'User authorized local verification only. Do not deploy. Work remains unfinished.' } }] });
      }
      requests.push(body.messages);
      if (scenario === 'tool-growth' && executions < 9 || scenario === 'interruption' && executions === 0) {
        return Response.json({ choices: [{ message: { role: 'assistant', content: null,
          tool_calls: [{ id: `call-${executions}`, type: 'function', function: { name: 'large_evidence', arguments: '{}' } }],
        } }] });
      }
      if (scenario === 'tool-growth' && !requestedRead) {
        requestedRead = true;
        const id = history.taskContext.search(chatId, 'END-EXACT-1').matches[0]!.id;
        return Response.json({ choices: [{ message: { role: 'assistant', content: null,
          tool_calls: [{ id: 'call-retrieve', type: 'function', function: { name: 'task_context', arguments: JSON.stringify({ action: 'read', id, offset: 9000, limit: 8000 }) } }],
        } }] });
      }
      if (scenario === 'tool-growth') {
        const retrieved = JSON.parse(body.messages.at(-1).content);
        assert.match(retrieved.text, /END-EXACT-1/);
        assert.equal(retrieved.nextOffset, null, 'retrieval JSON and its continuation marker must not be display-clipped');
      }
      return Response.json({ choices: [{ message: { role: 'assistant', content: 'done' } }] });
    }) as typeof fetch;
    if (scenario === 'interruption' || scenario === 'overhead') {
      await assert.rejects(agent.run(chatId, 'CURRENT-REQUEST: verify locally, do not deploy.'), /Context|context/);
      assert.equal(requests.length, scenario === 'overhead' ? 0 : 1);
      if (scenario === 'interruption') {
        assert.equal(executions, 1);
        assert.match(JSON.stringify(history.load(chatId)), /receipt-1/);
        assert.match(JSON.stringify(history.load(chatId)), /Turn interrupted/);
        assert.equal(history.load(chatId).filter((m: any) => String(m.content).includes('CURRENT-REQUEST')).length, 1);
      }
      return;
    }
    const result = await agent.run(chatId, 'CURRENT-REQUEST: verify locally, do not deploy.');
    assert.equal(result.text, 'done');
    assert.equal(history.load(chatId).filter((m: any) => String(m.content).includes('CURRENT-REQUEST')).length, 1);
    assert.match(JSON.stringify(requests[0]), /Keep the no-deployment constraint/);
    if (scenario === 'checkpoint') {
      assert.ok(summaries > 0);
      assert.ok(JSON.stringify(history.loadRaw(chatId)).includes('Original instruction 0'));
      assert.ok(history.taskContext.search(chatId, 'Original instruction 0').matches.length);
      assert.ok(JSON.stringify(requests[0]).length < 26000);
    } else {
      assert.equal(executions, 9);
      assert.ok(requests.some(items => JSON.stringify(items).includes('Earlier completed tool exchange')));
      for (const items of requests) {
        const calls = items.flatMap(item => item.tool_calls ?? []).map(call => call.id);
        const results = items.filter(item => item.role === 'tool').map(item => item.tool_call_id);
        assert.deepEqual(calls, results, 'all retained calls have their matching outputs');
        assert.match(JSON.stringify(items), /CURRENT-REQUEST/);
      }
      const found = history.taskContext.search(chatId, 'END-EXACT-1').matches;
      assert.ok(found.length, 'full tool result survives clipping and window relief');
      const entry = history.taskContext.read(chatId, found[0]!.id, found[0]!.offset);
      assert.match(entry.text, /END-EXACT-1/);
    }
  });
}

for (const failure of ['arrival', 'abort'] as const) {
  test(`summary cannot commit after ${failure}`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'context-race-'));
    const history = new ConversationHistory(root, 400000, 'test');
    history.append('race', [{ role: 'user', content: 'Initial scope. '.repeat(1000) }, { role: 'assistant', content: 'Planned.' },
      { role: 'user', content: 'Current scope.' }, { role: 'assistant', content: 'Working.' }]);
    const controller = new AbortController();
    const compaction = new CompactionManager({ client: {} as never, memory: {} as never, history,
      provider: 'openai', model: 'gpt-5.5', apiKey: 'test-key', config: { keepRecentMessages: 2, maxSummaryChars: 1000 },
    });
    const previousFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = previousFetch; rmSync(root, { recursive: true, force: true }); });
    globalThis.fetch = (async () => {
      if (failure === 'arrival') history.append('race', [{ role: 'user', content: 'Stop: the scope has changed.' }]);
      else controller.abort(new Error('operator stopped summarization'));
      return Response.json({ choices: [{ message: { content: 'Short checkpoint.' } }] });
    }) as typeof fetch;
    await assert.rejects(compaction.compact('race', history.load('race'), undefined, undefined, controller.signal), /changed during compaction|operator stopped/);
    assert.match(JSON.stringify(history.load('race')), /Initial scope/);
    assert.doesNotMatch(JSON.stringify(history.load('race')), /Short checkpoint/);
    if (failure === 'arrival') assert.match(JSON.stringify(history.load('race')), /Stop: the scope has changed/);
  });
}
