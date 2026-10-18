import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentLoop } from '../../src/agent/loop.js';
import { ConversationHistory } from '../../src/agent/history.js';
import { CompactionManager } from '../../src/agent/compaction.js';
import { createHash } from 'node:crypto';
import { buildBootstrapBlock } from '../../src/agent/session-bootstrap.js';
import { readFileTool } from '../../src/agent/tools/files.js';

async function runTurn(agent: AgentLoop, chatId: string, text: string) {
  const abortController = new AbortController();
  return agent.run(chatId, text, undefined, undefined, undefined, {
    turnId: `fixture-${Math.random()}`, abortController, signal: abortController.signal,
    brainOperations: { async searchContext() { return { results: [], sourceEvidence: { sourceHealth: 'healthy', matchOutcome: 'no_matches' } }; } } as never,
    onOperationActivity() {},
  });
}

test('UTF-8 bootstrap preview keeps beginning and latest correction with exact recoverable omitted interval', async t => {
  const root = mkdtempSync(join(tmpdir(), 'bootstrap-preview-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const content = '  # Workspace map\n' + '😀é日本語 historical observation\r\n'.repeat(40) + '\nOwner correction: finish the existing assignment.\n';
  const path = join(root, 'PLAYBOOK.md');
  writeFileSync(path, content);
  const block = buildBootstrapBlock(root, { bootstrap: { reads: ['PLAYBOOK.md'], maxBytesPerFile: 200 } })!;
  assert.match(block, /# Workspace map/);
  assert.match(block, /Owner correction: finish the existing assignment/);
  assert.match(block, /PARTIAL workspace preview/);
  assert.match(block, new RegExp(`sha256=${createHash('sha256').update(content).digest('hex')}`));
  const recovery = JSON.parse(block.match(/Recover with read_file\((\{[^\n]+?\})\)/)![1]!);
  const shownBytes = Number(block.match(/preview: (\d+) of/)![1]);
  assert.ok(shownBytes <= 200);
  assert.equal(recovery.path, path);
  assert.ok(recovery.offset_chars > 0);
  assert.ok(recovery.offset_chars + recovery.limit_chars < content.length);
  const result = await readFileTool.execute(recovery, { workspacePath: root, projectRoot: root } as never);
  assert.equal(result.is_error, undefined);
  assert.equal(result.content, content.slice(recovery.offset_chars, recovery.offset_chars + recovery.limit_chars));
  assert.equal(content.slice(0, recovery.offset_chars) + result.content + content.slice(recovery.offset_chars + recovery.limit_chars), content);
  assert.doesNotMatch(block, /\ufffd/);
});

test('tiny preview budgets never split UTF-8 or UTF-16 characters and do not silently discard the middle', async t => {
  const root = mkdtempSync(join(tmpdir(), 'bootstrap-unicode-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const content = '😀é本'.repeat(50);
  writeFileSync(join(root, 'NOW.md'), content);
  for (let budget = 0; budget < 50; budget++) {
    const block = buildBootstrapBlock(root, { bootstrap: { reads: ['NOW.md'], maxBytesPerFile: budget } })!;
    assert.doesNotMatch(block, /\ufffd/);
    const recovery = JSON.parse(block.match(/Recover with read_file\((\{[^\n]+?\})\)/)![1]!);
    assert.ok(Number(block.match(/preview: (\d+) of/)![1]) <= budget);
    const omitted = content.slice(recovery.offset_chars, recovery.offset_chars + recovery.limit_chars);
    assert.ok(omitted.length > 0);
    assert.ok(!/^[\udc00-\udfff]|[\ud800-\udbff]$/.test(omitted), 'exact offsets do not split a surrogate pair');
  }
});

test('complete source preserves exact whitespace, repeated paths inject once and missing sources are disclosed', t => {
  const root = mkdtempSync(join(tmpdir(), 'bootstrap-source-list-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const content = '  # Current map\nVerbatim details.\n\n';
  writeFileSync(join(root, 'NOW.md'), content);
  const block = buildBootstrapBlock(root, { bootstrap: { reads: ['NOW.md', './NOW.md', 'absent.md'] } })!;
  assert.ok(block.includes(content));
  assert.equal((block.match(/— NOW.md —/g) ?? []).length, 1);
  assert.doesNotMatch(block, /PARTIAL workspace preview/);
  assert.match(block, /Workspace context unavailable: .*absent.md.*ENOENT/);
  assert.match(block, /No contents from this source were supplied/);
});

for (const provider of ['openai', 'openai-codex', 'anthropic'] as const) {
  test(`bootstrap reaches ${provider} on consecutive, reloaded and idle turns without entering history`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'bootstrap-continuity-'));
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    const historyPath = join(root, 'history');
    const requests: Record<string, any>[] = [];
    const priorFetch = globalThis.fetch;
    const priorKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'test-key';
    t.after(() => {
      globalThis.fetch = priorFetch;
      if (priorKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = priorKey;
      rmSync(root, { recursive: true, force: true });
    });
    globalThis.fetch = (async (url, init) => {
      if (/localhost|127\.0\.0\.1/.test(String(url))) return new Response('{}', { status: 503 });
      const body = JSON.parse(String(init?.body));
      requests.push(body);
      if (provider === 'openai-codex') return new Response([
        'data: {"type":"response.output_text.delta","delta":"ack"}\n\n',
        'data: {"type":"response.completed","response":{"status":"completed"}}\n\n',
      ].join(''), { headers: { 'content-type': 'text/event-stream' } });
      return Response.json({ choices: [{ message: { role: 'assistant', content: 'ack' } }] });
    }) as typeof fetch;
    const makeAgent = (history: ConversationHistory, sessionGapMs = 30 * 60 * 1000) => {
      const agent = new AgentLoop({
        apiKey: 'test-key', model: provider === 'anthropic' ? 'claude-test' : 'gpt-test', provider,
        maxTokens: 128, history, sessionGapMs,
        registry: { getAnthropicTools: () => [], getOpenAITools: () => [], get: () => undefined } as never,
        contextManager: { getSystemPrompt: () => 'Stable test identity.', getPromptSourceInfo: () => ({ loadedFiles: [] }) } as never,
        toolContext: { brainOperations: { withActivityHandler() { return this; } } } as never,
        workspacePath: workspace, situationalAwareness: { bootstrap: { reads: ['NOW.md'] } },
      });
      if (provider === 'openai-codex') (agent as any).codexCredentialsProvider = async () => ({ accessToken: 'test', accountId: 'test' });
      if (provider === 'anthropic') (agent as any).client = { messages: { stream(request: Record<string, any>) {
        requests.push(structuredClone(request));
        return {
          async *[Symbol.asyncIterator]() {},
          async finalMessage() { return { id: 'test', type: 'message', role: 'assistant', model: 'claude-test',
            content: [{ type: 'text', text: 'ack' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }; },
        };
      } } };
      return agent;
    };
    let history = new ConversationHistory(historyPath, 400000, 'test');
    let agent = makeAgent(history);
    for (let turn = 1; turn <= 4; turn++) {
      if (turn >= 3) {
        history = new ConversationHistory(historyPath, 400000, 'test');
        agent = makeAgent(history, turn === 4 ? -1 : undefined);
      }
      const current = `WORKSPACE-MAP-CURRENT-${turn}`;
      writeFileSync(join(workspace, 'NOW.md'), current);
      const result = await runTurn(agent, 'bootstrap-chat', `Owner request ${turn}.`);
      assert.equal(result.text, 'ack');
      const request = requests.at(-1)!;
      const system = provider === 'openai-codex' ? request.instructions
        : provider === 'anthropic' ? request.system.map((block: any) => block.text).join('\n')
          : request.messages[0].content;
      assert.match(system, new RegExp(current), `turn ${turn} receives the current source`);
      assert.equal((system.match(/\[SESSION BOOTSTRAP\]/g) ?? []).length, 1);
      if (turn > 1) assert.doesNotMatch(system, new RegExp(`WORKSPACE-MAP-CURRENT-${turn - 1}`));
      const persisted = JSON.stringify(history.loadRaw('bootstrap-chat'));
      assert.doesNotMatch(persisted, /WORKSPACE-MAP-CURRENT|SESSION BOOTSTRAP/);
      assert.match(persisted, new RegExp(`Owner request ${turn}`));
    }
    assert.equal(requests.length, 4);
    assert.equal(history.load('bootstrap-chat').filter(record => 'type' in record && record.type === 'session_boundary').length, 2);
  });
}

test('a reloaded compacted conversation still receives refreshed bootstrap with recoverable original history', async t => {
  const root = mkdtempSync(join(tmpdir(), 'bootstrap-checkpoint-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const historyPath = join(root, 'history');
  let history = new ConversationHistory(historyPath, 26000, 'test');
  for (let index = 0; index < 12; index++) history.append('checkpoint-chat', [
    { role: 'user', content: `ORIGINAL-OWNER-SCOPE-${index}: ${'Retain the evidence. '.repeat(200)}` },
    { role: 'assistant', content: 'Work remains unfinished.' },
  ]);
  const priorFetch = globalThis.fetch;
  const priorKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key';
  t.after(() => {
    globalThis.fetch = priorFetch;
    if (priorKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = priorKey;
    rmSync(root, { recursive: true, force: true });
  });
  const requests: any[][] = [];
  let summaries = 0;
  globalThis.fetch = (async (url, init) => {
    if (/localhost|127\.0\.0\.1/.test(String(url))) return new Response('{}', { status: 503 });
    const body = JSON.parse(String(init?.body));
    if (String(body.messages?.[0]?.content).startsWith('Summarize conversation evidence')) {
      summaries++;
      return Response.json({ choices: [{ message: { content: 'Owner scope is unchanged. Work remains unfinished.' } }] });
    }
    requests.push(body.messages);
    return Response.json({ choices: [{ message: { role: 'assistant', content: 'ack' } }] });
  }) as typeof fetch;
  const makeAgent = () => new AgentLoop({
    apiKey: 'test-key', model: 'gpt-test', provider: 'openai', maxTokens: 128, history,
    registry: { getAnthropicTools: () => [], getOpenAITools: () => [], get: () => undefined } as never,
    contextManager: { getSystemPrompt: () => 'Stable identity.', getPromptSourceInfo: () => ({ loadedFiles: [] }) } as never,
    toolContext: { brainOperations: { withActivityHandler() { return this; } } } as never,
    workspacePath: workspace, situationalAwareness: { bootstrap: { reads: ['NOW.md'] } },
    compaction: new CompactionManager({ client: {} as never, memory: {} as never, history, provider: 'openai', model: 'gpt-test', apiKey: 'test-key',
      config: { reserveChars: 1000, maxSummaryChars: 1000, keepRecentMessages: 2 } }),
  });
  writeFileSync(join(workspace, 'NOW.md'), 'MAP-BEFORE-CHECKPOINT');
  await runTurn(makeAgent(), 'checkpoint-chat', 'Continue this assignment.');
  assert.ok(summaries > 0, 'the actual compaction provider path executed');
  assert.match(requests[0]![0].content, /MAP-BEFORE-CHECKPOINT/);
  history = new ConversationHistory(historyPath, 26000, 'test');
  writeFileSync(join(workspace, 'NOW.md'), 'MAP-AFTER-RELOAD');
  await runTurn(makeAgent(), 'checkpoint-chat', 'Continue after reload.');
  assert.match(requests.at(-1)![0].content, /MAP-AFTER-RELOAD/);
  assert.doesNotMatch(requests.at(-1)![0].content, /MAP-BEFORE-CHECKPOINT/);
  assert.match(JSON.stringify(history.loadRaw('checkpoint-chat')), /ORIGINAL-OWNER-SCOPE-0/);
  assert.doesNotMatch(JSON.stringify(history.loadRaw('checkpoint-chat')), /MAP-AFTER-RELOAD|MAP-BEFORE-CHECKPOINT/);
});
