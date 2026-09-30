import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentLoop } from '../../src/agent/loop.js';
import { ConversationHistory } from '../../src/agent/history.js';
import { createSeededToolRegistry } from '../../src/agent/tools/index.js';
import { writeFileTool } from '../../src/agent/tools/files.js';
import { compileProjectWriteRoots } from '../../src/agent/tools/project-write-roots.js';
import { createTrackedAgentRunner } from '../../src/agent/turn-entrypoint.js';
import type { ToolContext } from '../../src/agent/types.js';

for (const mode of ['direct', 'group', 'delegated', 'delegated-empty-prompt'] as const) {
  test(`${mode} turn gets only its own authorized file roots`, async t => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'home23-loop-roots-')));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const instance = join(root, 'instances/scout');
    const workspace = join(instance, 'workspace');
    const projects = join(instance, 'projects');
    const shared = join(root, 'instances/.house/projects/topic/workspace');
    for (const dir of [workspace, projects, shared]) mkdirSync(dir, { recursive: true });
    const grant = compileProjectWriteRoots({ projectWriteRoots: [{ path: 'projects' }] }, instance);
    const target = join(projects, 'STATE.json');
    const seen: ToolContext[] = [];
    const registry = createSeededToolRegistry([{ ...writeFileTool, execute: async (input, ctx) => {
      seen.push(ctx); return writeFileTool.execute(input, ctx);
    } }]);
    let projectReads = 0;
    const toolContext = { workspacePath: workspace, projectRoot: root, instanceDir: instance, projectWriteRoots: grant,
      brainOperations: { withActivityHandler() { return this; } }, turnRuntime: null,
      coordinationChannelOperation: async ({ args }) => { if (args.operation !== 'project_context') return {}; projectReads++; return { available: true, channelId: 'topic', title: 'Topic',
        purpose: 'Shared project', workspacePath: shared, documents: [] }; } } as unknown as ToolContext;
    const agent = new AgentLoop({ apiKey: 'fixture', model: 'gpt-5.5', provider: 'openai', registry,
      contextManager: { getSystemPrompt: () => 'Test resident.', getPromptSourceInfo: () => ({ loadedFiles: [] }) } as never,
      history: new ConversationHistory(join(root, 'conversations'), 400_000, 'scout'), toolContext, workspacePath: workspace });
    const priorFetch = globalThis.fetch; const priorKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'fixture';
    t.after(() => { globalThis.fetch = priorFetch;
      if (priorKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = priorKey; });
    const prompts: string[] = []; let calls = 0;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
      if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return new Response('{}', { status: 503 });
      const request = JSON.parse(String(init?.body));
      prompts.push(request.messages.filter((message: any) => message.role === 'system').map((message: any) => message.content).join('\n'));
      if (++calls === 1) return Response.json({ choices: [{ message: { role: 'assistant', content: null,
        tool_calls: [{ id: 'write-state', type: 'function', function: { name: 'write_file',
          arguments: JSON.stringify({ path: target, content: 'saved' }) } }] } }] });
      return Response.json({ choices: [{ message: { role: 'assistant', content: 'done' } }] });
    }) as typeof fetch;
    const delegated = mode.startsWith('delegated');
    if (delegated) {
      await createTrackedAgentRunner(agent)(mode === 'delegated' ? 'Delegated instructions.' : '', 'Save state', [writeFileTool],
        { ...toolContext, chatId: 'child' }, { registry });
    } else {
      const run = await agent.runWithTurn(mode, 'Save state', mode === 'group' ? { coordinationOrigin: {
        kind: 'coordination', workId: 'work-fixture', attemptId: 'attempt-fixture', leaseId: 'lease-fixture',
        holderPrincipalId: 'scout', holderInstanceId: 'scout-1', authorityReference: 'resident:scout', fencingToken: 1,
        channelId: 'topic', originMessageId: null, roundId: null } } : {});
      await run.response;
    }
    assert.equal(seen.length, 1);
    assert.equal(seen[0].workspacePath, mode === 'group' ? shared : workspace);
    assert.equal(seen[0].projectWriteRoots, delegated ? undefined : grant);
    assert.equal(existsSync(target), !delegated);
    assert.equal(projectReads, mode === 'group' ? 1 : 0);
    assert.equal(prompts[0].includes('File tools may also write these resident project roots'), !delegated);
  });
}
