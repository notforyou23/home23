import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { shellTool } from '../../../src/agent/tools/shell.js';
import type { ToolContext } from '../../../src/agent/types.js';

function testContext(cwd: string): ToolContext {
  return {
    scheduler: null,
    ttsService: null,
    browser: null,
    projectRoot: cwd,
    enginePort: 5001,
    agentName: 'test-agent',
    cosmo23BaseUrl: 'http://localhost:43210',
    brainRoute: null,
    workspacePath: cwd,
    tempDir: cwd,
    contextManager: {
      getSystemPrompt: () => '',
      getPromptSourceInfo: () => ({
        generatedAt: new Date(0).toISOString(),
        totalSections: 0,
        loadedFiles: [],
      }),
      invalidate: () => {},
    },
    subAgentTracker: { active: 0, maxConcurrent: 0, queue: [] },
    chatId: 'test-chat',
    telegramAdapter: null,
    runAgentLoop: null,
  };
}

test('shell tool caps stdout with an explicit truncation note', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'home23-shell-test-'));
  const result = await shellTool.execute(
    {
      command: "node -e \"process.stdout.write('x'.repeat(2000))\"",
      cwd,
      max_output_chars: 500,
    },
    testContext(cwd),
  );

  assert.equal(result.is_error, false);
  assert.match(result.content, /^STDOUT:\n/);
  assert.match(result.content, /stdout truncated at 500 chars; 2000 total chars/);
  assert.match(result.content, /Exit code: 0/);
  assert.ok(result.content.length < 900);
});

test('shell tool caps stderr independently from stdout', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'home23-shell-test-'));
  const result = await shellTool.execute(
    {
      command: "node -e \"process.stderr.write('e'.repeat(1600)); process.exit(2)\"",
      cwd,
      max_stderr_chars: 500,
    },
    testContext(cwd),
  );

  assert.equal(result.is_error, true);
  assert.match(result.content, /^STDERR:\n/);
  assert.match(result.content, /stderr truncated at 500 chars; 1600 total chars/);
  assert.match(result.content, /Exit code: 2/);
  assert.ok(result.content.length < 900);
});

test('shell tool stops a running command when the turn abort signal fires', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'home23-shell-test-'));
  const ac = new AbortController();
  const start = Date.now();

  const resultPromise = shellTool.execute(
    {
      command: "node -e \"setInterval(() => {}, 1000)\"",
      cwd,
      timeout_ms: 1000,
    },
    { ...testContext(cwd), abortSignal: ac.signal },
  );

  setTimeout(() => ac.abort(new Error('operator_stop')), 30);
  const result = await resultPromise;
  const elapsedMs = Date.now() - start;

  assert.equal(result.is_error, true);
  assert.ok(elapsedMs < 500, `expected abort before shell timeout, elapsed=${elapsedMs}ms`);
  assert.match(result.content, /operator_stop|AbortError|SIGTERM|aborted/i);
});
