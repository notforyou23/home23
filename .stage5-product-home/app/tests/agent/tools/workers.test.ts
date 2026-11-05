import assert from 'node:assert/strict';
import { test } from 'node:test';
import { workerListTool, workerRunTool } from '../../../src/agent/tools/workers.js';
import type { ToolContext } from '../../../src/agent/types.js';

function ctx(fetchImpl: typeof fetch): ToolContext {
  return {
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
      getSystemPrompt: () => '',
      getPromptSourceInfo: () => ({ generatedAt: '', totalSections: 0, loadedFiles: [] }),
      invalidate: () => undefined
    },
    subAgentTracker: { active: 0, maxConcurrent: 1, queue: [] },
    chatId: 'test',
    telegramAdapter: null,
    runAgentLoop: null,
    workerConnectorBaseUrl: 'http://worker.test',
    fetch: fetchImpl
  };
}

test('worker_list calls connector', async () => {
  const fakeFetch = async (url: string | URL | Request) => {
    assert.equal(String(url), 'http://worker.test/api/workers');
    return new Response(JSON.stringify({ workers: [{ name: 'systems', ownerAgent: 'jerry' }] }), { status: 200 });
  };
  const result = await workerListTool.execute({}, ctx(fakeFetch as typeof fetch));
  assert.match(result.content, /systems/);
});

test('worker_run posts prompt to connector', async () => {
  const fakeFetch = async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(url), 'http://worker.test/api/workers/systems/runs');
    assert.equal(init?.method, 'POST');
    assert.match(String(init?.body), /check host/);
    return new Response(JSON.stringify({ runId: 'wr_1', receipt: { status: 'no_change', verifierStatus: 'pass', summary: 'checked' } }), { status: 200 });
  };
  const result = await workerRunTool.execute({ worker: 'systems', prompt: 'check host' }, ctx(fakeFetch as typeof fetch));
  assert.match(result.content, /wr_1/);
  assert.match(result.content, /checked/);
});
