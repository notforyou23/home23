import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkCosmoActiveRun, compileBrainTool, launchTool, queryBrainTool } from '../../../src/agent/tools/research.js';
import type { ToolContext } from '../../../src/agent/types.js';

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    scheduler: null,
    ttsService: null,
    browser: null,
    projectRoot: '/fake',
    enginePort: 5002,
    agentName: 'jerry',
    cosmo23BaseUrl: 'http://localhost:43210',
    brainRoute: 'http://localhost:43210/api/brain/abc123',
    workspacePath: '/fake/instances/jerry/workspace',
    tempDir: '/tmp',
    contextManager: {
      getSystemPrompt: () => '',
      getPromptSourceInfo: () => ({ generatedAt: '', totalSections: 0, loadedFiles: [] }),
      invalidate: () => {},
    },
    subAgentTracker: { active: 0, maxConcurrent: 3, queue: [] },
    chatId: '',
    telegramAdapter: null,
    runAgentLoop: null,
    ...overrides,
  };
}

describe('research_launch', () => {
  it('sends runName + runRoot + owner derived from ctx.workspacePath and ctx.agentName', async () => {
    let capturedBody: any;
    (globalThis as any).fetch = async (url: any, init: any) => {
      const u = String(url);
      if (u.endsWith('/api/status')) {
        return { ok: true, json: async () => ({ running: false }) } as unknown as Response;
      }
      if (u.endsWith('/api/launch')) {
        capturedBody = JSON.parse(init.body);
        return {
          ok: true,
          json: async () => ({ success: true, runName: capturedBody.runName, brainId: 'b1', cycles: 10 }),
        } as unknown as Response;
      }
      return { ok: true, json: async () => ({}) } as unknown as Response;
    };

    await launchTool.execute({ topic: 'sauna HRV correlation' }, makeCtx());

    assert.match(capturedBody.runName, /^sauna-hrv-correlation-\d{14}$/);
    assert.equal(capturedBody.runRoot, '/fake/instances/jerry/workspace/research-runs/' + capturedBody.runName);
    assert.equal(capturedBody.owner, 'jerry');
    assert.equal(capturedBody.topic, 'sauna HRV correlation');
  });
});

describe('checkCosmoActiveRun', () => {
  it('uses explicit health.activeRun when available', async () => {
    (globalThis as any).fetch = async (url: any) => {
      assert.ok(String(url).endsWith('/api/status'));
      return {
        ok: true,
        json: async () => ({
          running: false,
          health: { activeRun: true, process: { count: 1 } },
          activeContext: {
            runName: 'run-health-contract',
            topic: 'status contracts',
            startedAt: '2026-04-24T15:00:00Z',
          },
          processStatus: { count: 0 },
        }),
      } as unknown as Response;
    };

    const active = await checkCosmoActiveRun(makeCtx());

    assert.equal(active?.runName, 'run-health-contract');
    assert.equal(active?.processCount, 1);
  });
});

describe('research_compile_brain agency assimilation', () => {
  it('emits a resident agency world-stream intake packet for compiled research output', async () => {
    const root = mkdtempSync(join(tmpdir(), 'home23-research-agency-'));
    const previousCwd = process.cwd();
    const previousAgent = process.env.HOME23_AGENT;
    const previousFetch = globalThis.fetch;
    let capturedAgencyBody: any = null;
    try {
      process.chdir(root);
      process.env.HOME23_AGENT = 'jerry';
      (globalThis as any).fetch = async (url: any, init: any = {}) => {
        const u = String(url);
        if (u === 'http://localhost:43210/api/brains/brain-agency') {
          return { ok: true, json: async () => ({ id: 'brain-agency' }) } as unknown as Response;
        }
        if (u === 'http://localhost:43210/api/brain/brain-agency/query') {
          return {
            ok: true,
            json: async () => ({
              response: 'Research finding: compiled COSMO output should become resident agency evidence, not just a markdown artifact. It proposes a watch/pursuit decision with receipts.',
            }),
          } as unknown as Response;
        }
        if (u === 'http://bridge.test/api/agency/world-stream') {
          capturedAgencyBody = JSON.parse(String(init.body || '{}'));
          return {
            ok: true,
            text: async () => JSON.stringify({ decision: { route: 'watch' }, pursuit: { id: 'ap_research' } }),
          } as unknown as Response;
        }
        throw new Error(`unexpected fetch ${u}`);
      };

      const result = await compileBrainTool.execute({ brainId: 'brain-agency' }, makeCtx({
        workerConnectorBaseUrl: 'http://bridge.test',
      }));

      assert.equal(result.is_error, undefined);
      assert.equal(capturedAgencyBody.source, 'cosmo.research');
      assert.equal(capturedAgencyBody.kind, 'research_summary');
      assert.match(capturedAgencyBody.summary, /Compiled COSMO research brain/);
      assert.match(capturedAgencyBody.desiredChangedFuture, /resident agency/);
      assert.deepEqual(capturedAgencyBody.evidence[0].type, 'research_compile');
      assert.match(result.content, /Agency intake: watch/);
    } finally {
      process.chdir(previousCwd);
      if (previousAgent === undefined) delete process.env.HOME23_AGENT;
      else process.env.HOME23_AGENT = previousAgent;
      (globalThis as any).fetch = previousFetch;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('research_query_brain agency assimilation', () => {
  it('emits a resident agency world-stream intake packet for direct research answers', async () => {
    const previousFetch = globalThis.fetch;
    let capturedAgencyBody: any = null;
    try {
      (globalThis as any).fetch = async (url: any, init: any = {}) => {
        const u = String(url);
        if (u === 'http://localhost:43210/api/brain/brain-query/query') {
          return {
            ok: true,
            json: async () => ({
              response: 'Research answer: the existing brain already contains a concrete repair path that should update resident attention rather than remain a chat-only answer.',
            }),
          } as unknown as Response;
        }
        if (u === 'http://bridge.test/api/agency/world-stream') {
          capturedAgencyBody = JSON.parse(String(init.body || '{}'));
          return {
            ok: true,
            text: async () => JSON.stringify({ decision: { route: 'pursue' }, pursuit: { id: 'ap_research_query' } }),
          } as unknown as Response;
        }
        throw new Error(`unexpected fetch ${u}`);
      };

      const result = await queryBrainTool.execute({
        brainId: 'brain-query',
        query: 'what should change now?',
      }, makeCtx({ workerConnectorBaseUrl: 'http://bridge.test' }));

      assert.equal(result.is_error, undefined);
      assert.equal(capturedAgencyBody.source, 'cosmo.research');
      assert.equal(capturedAgencyBody.kind, 'research_summary');
      assert.match(capturedAgencyBody.summary, /Queried COSMO research brain/);
      assert.match(capturedAgencyBody.nextMove, /triage research output/);
      assert.equal(capturedAgencyBody.evidence[0].type, 'research_query');
      assert.match(result.content, /Agency intake: pursue/);
    } finally {
      (globalThis as any).fetch = previousFetch;
    }
  });
});
