import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { brainQueryTool, brainQueryExportTool, brainStatusTool } from '../../../src/agent/tools/brain.js';
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

describe('brain_query', () => {
  it('defaults omitted agent queries to quick mode and the catalog query model', async () => {
    let capturedBody: any;
    (globalThis as any).fetch = async (_url: any, init: any) => {
      capturedBody = JSON.parse(init.body);
      return { ok: true, json: async () => ({ answer: 'ok' }) } as unknown as Response;
    };

    await brainQueryTool.execute({ query: 'q' }, makeCtx());

    assert.equal(Object.hasOwn(capturedBody, 'model'), false);
    assert.equal(capturedBody.mode, 'quick');
    assert.equal(capturedBody.enableSynthesis, false);
    assert.equal(capturedBody.includeOutputs, false);
    assert.equal(capturedBody.includeThoughts, false);
    assert.equal(capturedBody.includeCoordinatorInsights, false);
    assert.equal(capturedBody.exportFormat, null);
  });

  it('sends the dashboard tab payload shape to ${brainRoute}/query', async () => {
    let capturedUrl = '';
    let capturedBody: any;
    (globalThis as any).fetch = async (url: any, init: any) => {
      capturedUrl = String(url);
      capturedBody = JSON.parse(init.body);
      return {
        ok: true,
        json: async () => ({ answer: 'ok', evidence: [], metadata: { mode: 'full' } }),
      } as unknown as Response;
    };

    await brainQueryTool.execute(
      { query: 'what is the sauna state?', mode: 'expert', enablePGS: true, pgsConfig: { sweepFraction: 0.25 } },
      makeCtx(),
    );

    assert.equal(capturedUrl, 'http://localhost:43210/api/brain/abc123/query');
    assert.equal(capturedBody.query, 'what is the sauna state?');
    assert.equal(capturedBody.mode, 'expert');
    assert.equal(capturedBody.enablePGS, true);
    assert.deepEqual(capturedBody.pgsConfig, { sweepFraction: 0.25 });
    assert.equal(capturedBody.pgsFullSweep, false);
  });

  it('derives pgsFullSweep=true when sweepFraction >= 1.0', async () => {
    let capturedBody: any;
    (globalThis as any).fetch = async (_url: any, init: any) => {
      capturedBody = JSON.parse(init.body);
      return { ok: true, json: async () => ({ answer: 'ok' }) } as unknown as Response;
    };
    await brainQueryTool.execute(
      { query: 'q', enablePGS: true, pgsConfig: { sweepFraction: 1.0 } },
      makeCtx(),
    );
    assert.equal(capturedBody.pgsFullSweep, true);
  });

  it('uses pgsSynthModel as the PGS synthesis model', async () => {
    let capturedBody: any;
    (globalThis as any).fetch = async (_url: any, init: any) => {
      capturedBody = JSON.parse(init.body);
      return { ok: true, json: async () => ({ answer: 'ok' }) } as unknown as Response;
    };
    await brainQueryTool.execute(
      { query: 'q', model: 'gpt-5.2', enablePGS: true, pgsSynthModel: 'grok-4.5' },
      makeCtx(),
    );
    assert.equal(capturedBody.model, 'grok-4.5');
  });

  it('returns timeout context instead of the raw abort message', async () => {
    (globalThis as any).fetch = async () => {
      const err = new Error('The operation was aborted due to timeout');
      (err as Error & { name: string }).name = 'TimeoutError';
      throw err;
    };

    const result = await brainQueryTool.execute({ query: 'q' }, makeCtx());

    assert.equal(result.is_error, true);
    assert.match(result.content, /brain_query timed out after 120s/);
    assert.match(result.content, /model=catalog-default/);
    assert.match(result.content, /mode=quick/);
    assert.match(result.content, /PGS=false/);
  });

  it('passes priorContext through for follow-up queries', async () => {
    let capturedBody: any;
    (globalThis as any).fetch = async (_url: any, init: any) => {
      capturedBody = JSON.parse(init.body);
      return { ok: true, json: async () => ({ answer: 'ok' }) } as unknown as Response;
    };
    await brainQueryTool.execute(
      { query: 'follow-up', priorContext: { query: 'prior', answer: 'prior answer' } },
      makeCtx(),
    );
    assert.deepEqual(capturedBody.priorContext, { query: 'prior', answer: 'prior answer' });
  });

  it('returns source, PGS, export path, and raw metadata provenance', async () => {
    (globalThis as any).fetch = async () => {
      return {
        ok: true,
        json: async () => ({
          answer: 'ok',
          exportedTo: '/fake/exports/query.md',
          metadata: {
            model: 'grok-4.5',
            mode: 'pgs',
            sources: { memoryNodes: 44, thoughts: 0, edges: 88 },
            pgs: {
              successfulSweeps: 7,
              sweptPartitions: 10,
              failedSweeps: 3,
              totalPartitions: 82,
              sweepModel: 'claude-sonnet-4-6',
              synthesisModel: 'grok-4.5',
            },
          },
        }),
      } as unknown as Response;
    };

    const result = await brainQueryTool.execute(
      { query: 'q', enablePGS: true, pgsConfig: { sweepFraction: 0.25 } },
      makeCtx(),
    );

    assert.match(result.content, /sources=44 memory nodes, 0 thoughts, 88 edges/);
    assert.match(result.content, /PGS=7 successful\/10 swept, 3 failed, 82 total partitions/);
    assert.match(result.content, /exportedTo=\/fake\/exports\/query\.md/);
    assert.match(result.content, /metadata: .*"sources":\{"memoryNodes":44/);
  });

  it('returns is_error when brainRoute is null', async () => {
    const result = await brainQueryTool.execute({ query: 'q' }, makeCtx({ brainRoute: null }));
    assert.equal(result.is_error, true);
    assert.match(result.content, /not registered in cosmo23/);
  });
});

describe('brain_query_export', () => {
  it('POSTs to ${brainRoute}/export-query with the dashboard tab payload', async () => {
    let capturedUrl = '';
    let capturedBody: any;
    (globalThis as any).fetch = async (url: any, init: any) => {
      capturedUrl = String(url);
      capturedBody = JSON.parse(init.body);
      return { ok: true, json: async () => ({ exportedTo: '/fake/exports/q.md' }) } as unknown as Response;
    };
    await brainQueryExportTool.execute(
      { query: 'q', answer: 'a', format: 'markdown', metadata: { mode: 'full' } },
      makeCtx(),
    );
    assert.equal(capturedUrl, 'http://localhost:43210/api/brain/abc123/export-query');
    assert.equal(capturedBody.query, 'q');
    assert.equal(capturedBody.answer, 'a');
    assert.equal(capturedBody.format, 'markdown');
    assert.deepEqual(capturedBody.metadata, { mode: 'full' });
  });
});

describe('brain_status', () => {
  it('uses /api/memory for graph counts instead of the projection-lite /api/state memory summary', async () => {
    const calledUrls: string[] = [];
    (globalThis as any).fetch = async (url: any) => {
      calledUrls.push(String(url));
      if (String(url).endsWith('/api/state')) {
        return {
          ok: true,
          json: async () => ({
            cycleCount: 6296,
            thoughtCount: 7505,
            oscillatorMode: 'focus',
            projection: true,
            memory: { nodes: 47825, edges: 0, clusters: 0 },
          }),
        } as unknown as Response;
      }
      if (String(url).endsWith('/api/memory')) {
        return {
          ok: true,
          json: async () => ({
            nodes: [
              { id: 'a', cluster: 0 },
              { id: 'b', cluster: 0 },
              { id: 'c', cluster: 1 },
              { id: 'd' },
            ],
            edges: [{ source: 'a', target: 'b' }, { source: 'b', target: 'c' }],
          }),
        } as unknown as Response;
      }
      throw new Error(`unexpected url ${url}`);
    };

    const result = await brainStatusTool.execute({}, makeCtx());
    const status = JSON.parse(result.content);

    assert.deepEqual(calledUrls, [
      'http://localhost:5002/api/state',
      'http://localhost:5002/api/memory',
    ]);
    assert.equal(status.memory.nodes, 4);
    assert.equal(status.memory.edges, 2);
    assert.equal(status.memory.clusters, 3);
    assert.equal(status.memory.detectedClusters, 2);
    assert.equal(status.memory.unclusteredNodes, 1);
    assert.equal(status.memory.source, '/api/memory');
    assert.deepEqual(status.stateProjectionMemory, { nodes: 47825, edges: 0, clusters: 0 });
  });
});
