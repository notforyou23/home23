import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { brainQueryTool, brainQueryExportTool } from '../../../src/agent/tools/brain.js';
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
