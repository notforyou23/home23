import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  codingRunTool,
  codingContinueTool,
  codingStatusTool,
  codingResultTool,
  codingCancelTool,
  codingJobsTool,
  codingBackendsTool,
} from '../../../src/agent/tools/coding.js';
import type { ToolContext, CodingBridgeRef } from '../../../src/agent/types.js';
import type { BridgeEvent, CodingJobRecord, CodingJobReceipt } from '../../../src/acp/types.js';

function makeJob(overrides: Partial<CodingJobRecord> = {}): CodingJobRecord {
  return {
    schema: 'home23.coding-job.v1',
    id: 'cj_20260805T120000_abcd',
    backend: 'claude-code',
    status: 'running',
    prompt: 'fix the flaky scheduler test',
    cwd: '/tmp/home23/.home23-worktrees/fix-sched',
    requestedCwd: '/tmp/home23',
    startedAt: '2026-08-05T12:00:00.000Z',
    isolation: 'worktree',
    ...overrides,
  };
}

function makeReceipt(overrides: Partial<CodingJobReceipt> = {}): CodingJobReceipt {
  return {
    schema: 'home23.coding-receipt.v1',
    jobId: 'cj_20260805T120000_abcd',
    backend: 'claude-code',
    status: 'completed',
    startedAt: '2026-08-05T12:00:00.000Z',
    finishedAt: '2026-08-05T12:05:00.000Z',
    durationMs: 300_000,
    costUsd: 0.42,
    numTurns: 7,
    resultTail: 'Fixed the race in scheduler tick. All tests green.',
    eventsCount: 22,
    toolUseCount: 9,
    ...overrides,
  };
}

interface FakeBridge extends CodingBridgeRef {
  calls: Array<{ method: string; args: unknown[] }>;
}

function makeFakeBridge(opts: {
  job?: CodingJobRecord;
  waited?: CodingJobRecord;
  receipt?: CodingJobReceipt;
  events?: BridgeEvent[];
  jobs?: CodingJobRecord[];
} = {}): FakeBridge {
  const job = opts.job ?? makeJob();
  const bridge: FakeBridge = {
    calls: [],
    async startJob(startOpts) {
      bridge.calls.push({ method: 'startJob', args: [startOpts] });
      return job;
    },
    getJob(id) {
      bridge.calls.push({ method: 'getJob', args: [id] });
      return job.id === id ? job : undefined;
    },
    listJobs(filter) {
      bridge.calls.push({ method: 'listJobs', args: [filter] });
      return opts.jobs ?? [job];
    },
    getReceipt(id) {
      bridge.calls.push({ method: 'getReceipt', args: [id] });
      return opts.receipt;
    },
    readEventsTail(id, maxEvents) {
      bridge.calls.push({ method: 'readEventsTail', args: [id, maxEvents] });
      return opts.events ?? [];
    },
    async cancelJob(id) {
      bridge.calls.push({ method: 'cancelJob', args: [id] });
      return { ...job, status: 'cancelled' };
    },
    async waitForJob(id, timeoutMs) {
      bridge.calls.push({ method: 'waitForJob', args: [id, timeoutMs] });
      return opts.waited ?? job;
    },
    listBackends() {
      bridge.calls.push({ method: 'listBackends', args: [] });
      return [
        { id: 'claude-code', available: true, bin: '/usr/local/bin/claude', defaultModel: 'claude-sonnet-4-7' },
        { id: 'codex', available: false, bin: null },
      ];
    },
  };
  return bridge;
}

function ctx(codingBridge: CodingBridgeRef | null): ToolContext {
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
    chatId: '12345',
    telegramAdapter: null,
    codingBridge,
    runAgentLoop: null,
  } as unknown as ToolContext;
}

test('every coding tool errors cleanly when the bridge is missing', async () => {
  const missing = ctx(null);
  for (const tool of [codingRunTool, codingContinueTool, codingStatusTool, codingResultTool, codingCancelTool, codingJobsTool, codingBackendsTool]) {
    const result = await tool.execute({ prompt: 'x', job_id: 'y' }, missing);
    assert.equal(result.is_error, true, `${tool.name} should error without a bridge`);
    assert.match(result.content, /Coding bridge unavailable/);
  }
});

test('coding_run immediate return passes args through and tags requestedBy with chatId', async () => {
  const bridge = makeFakeBridge();
  const result = await codingRunTool.execute({
    prompt: 'fix the flaky scheduler test',
    label: 'sched-fix',
    model: 'claude-opus-4-8',
    isolation: 'worktree',
    max_budget_usd: 5,
    allowed_tools: ['Bash', 'Edit'],
  }, ctx(bridge));

  assert.notEqual(result.is_error, true);
  const start = bridge.calls.find(c => c.method === 'startJob');
  assert.ok(start, 'startJob was called');
  const args = start!.args[0] as Record<string, unknown>;
  assert.equal(args.prompt, 'fix the flaky scheduler test');
  assert.equal(args.label, 'sched-fix');
  assert.equal(args.model, 'claude-opus-4-8');
  assert.equal(args.isolation, 'worktree');
  assert.equal(args.maxBudgetUsd, 5);
  assert.deepEqual(args.allowedTools, ['Bash', 'Edit']);
  assert.equal(args.requestedBy, '12345');
  assert.match(result.content, /cj_20260805T120000_abcd/);
  assert.match(result.content, /results will be delivered when complete/i);
  assert.equal(bridge.calls.some(c => c.method === 'waitForJob'), false);
});

test('coding_run with wait_seconds reaching terminal returns the receipt summary', async () => {
  const receipt = makeReceipt({
    worktree: { repoRoot: '/tmp/home23', path: '/tmp/home23/.home23-worktrees/fix-sched', branch: 'home23-agent/fix-sched', baseCommit: 'abc123def4567890' },
    diffStat: ' 2 files changed, 14 insertions(+)',
  });
  const bridge = makeFakeBridge({ waited: makeJob({ status: 'completed' }), receipt });
  const result = await codingRunTool.execute({ prompt: 'fix it', wait_seconds: 30 }, ctx(bridge));

  const wait = bridge.calls.find(c => c.method === 'waitForJob');
  assert.ok(wait, 'waitForJob was called');
  assert.equal(wait!.args[1], 30_000);
  assert.match(result.content, /completed/);
  assert.match(result.content, /300s/);
  assert.match(result.content, /\$0\.4200/);
  assert.match(result.content, /All tests green/);
  assert.match(result.content, /home23-agent\/fix-sched/);
});

test('coding_run with wait_seconds still running reports job id and hand-off', async () => {
  const bridge = makeFakeBridge({ waited: makeJob({ status: 'running' }) });
  const result = await codingRunTool.execute({ prompt: 'fix it', wait_seconds: 5 }, ctx(bridge));
  assert.match(result.content, /still running/);
  assert.match(result.content, /cj_20260805T120000_abcd/);
});

test('coding_continue errors when the job has no resumable session', async () => {
  const bridge = makeFakeBridge({ job: makeJob({ sessionId: undefined }) });
  const result = await codingContinueTool.execute({ job_id: 'cj_20260805T120000_abcd', prompt: 'now add tests' }, ctx(bridge));
  assert.equal(result.is_error, true);
  assert.match(result.content, /no resumable backend session/);
  assert.equal(bridge.calls.some(c => c.method === 'startJob'), false);
});

test('coding_continue resumes in the SAME cwd with isolation none', async () => {
  const bridge = makeFakeBridge({
    job: makeJob({ status: 'completed', sessionId: 'sess-42', label: 'sched-fix', model: 'claude-opus-4-8' }),
  });
  const result = await codingContinueTool.execute({ job_id: 'cj_20260805T120000_abcd', prompt: 'now add tests' }, ctx(bridge));

  assert.notEqual(result.is_error, true);
  const start = bridge.calls.find(c => c.method === 'startJob');
  assert.ok(start, 'startJob was called');
  const args = start!.args[0] as Record<string, unknown>;
  assert.equal(args.backend, 'claude-code');
  assert.equal(args.prompt, 'now add tests');
  assert.equal(args.cwd, '/tmp/home23/.home23-worktrees/fix-sched');
  assert.equal(args.isolation, 'none');
  assert.equal(args.resumeSessionId, 'sess-42');
  assert.equal(args.resumedFromJobId, 'cj_20260805T120000_abcd');
  assert.equal(args.label, 'sched-fix');
  assert.equal(args.model, 'claude-opus-4-8');
  assert.equal(args.requestedBy, '12345');
});

test('coding_status renders the job summary and events tail', async () => {
  const events: BridgeEvent[] = [
    { kind: 'session', sessionId: 'sess-42', model: 'claude-opus-4-8' },
    { kind: 'tool_use', tool: 'Bash', summary: 'npm test' },
    { kind: 'text', text: 'The scheduler race is in tick().' },
    { kind: 'result', ok: true, text: 'done', costUsd: 0.1, numTurns: 3 },
  ];
  const bridge = makeFakeBridge({ events });
  const result = await codingStatusTool.execute({ job_id: 'cj_20260805T120000_abcd' }, ctx(bridge));

  const tail = bridge.calls.find(c => c.method === 'readEventsTail');
  assert.ok(tail, 'readEventsTail was called');
  assert.equal(tail!.args[1], 15);
  assert.match(result.content, /Status: running/);
  assert.match(result.content, /session sess-42/);
  assert.match(result.content, /tool Bash: npm test/);
  assert.match(result.content, /scheduler race/);
  assert.match(result.content, /result ok=true/);
});

test('coding_result reports unfinished jobs with status and tail', async () => {
  const bridge = makeFakeBridge({ events: [{ kind: 'text', text: 'working on it' }] });
  const result = await codingResultTool.execute({ job_id: 'cj_20260805T120000_abcd' }, ctx(bridge));
  assert.match(result.content, /not finished — status running/);
  assert.match(result.content, /working on it/);
});

test('coding_result renders the finished receipt with worktree merge instructions', async () => {
  const receipt = makeReceipt({
    worktree: { repoRoot: '/tmp/home23', path: '/tmp/home23/.home23-worktrees/fix-sched', branch: 'home23-agent/fix-sched', baseCommit: 'abc123def4567890' },
    diffStat: ' 2 files changed, 14 insertions(+)',
  });
  const bridge = makeFakeBridge({ receipt });
  const result = await codingResultTool.execute({ job_id: 'cj_20260805T120000_abcd' }, ctx(bridge));

  assert.match(result.content, /All tests green/);
  assert.match(result.content, /2 files changed/);
  assert.match(result.content, /git -C \/tmp\/home23 merge home23-agent\/fix-sched/);
  assert.match(result.content, /worktree remove/);
});

test('coding_result renders checkpoint rollback instructions', async () => {
  const receipt = makeReceipt({
    checkpoint: { repoRoot: '/tmp/home23', headCommit: 'abc123def4567890', stashCommit: 'fedcba9876543210', dirty: true },
  });
  const bridge = makeFakeBridge({ receipt });
  const result = await codingResultTool.execute({ job_id: 'cj_20260805T120000_abcd' }, ctx(bridge));
  assert.match(result.content, /git stash apply|stash apply fedcba9876543210/);
  assert.match(result.content, /pre-job dirty state/);
});

test('coding_cancel cancels and reports the resulting status', async () => {
  const bridge = makeFakeBridge({ job: makeJob({ sessionId: 'sess-42' }) });
  const result = await codingCancelTool.execute({ job_id: 'cj_20260805T120000_abcd' }, ctx(bridge));
  assert.match(result.content, /cancelled/);
  assert.match(result.content, /sess-42/);
  assert.ok(bridge.calls.some(c => c.method === 'cancelJob'));
});

test('coding_jobs lists jobs compactly with shortened cwd', async () => {
  const bridge = makeFakeBridge({
    jobs: [
      makeJob({ id: 'cj_a', label: 'sched-fix', cwd: '/tmp/home23/.home23-worktrees/fix-sched' }),
      makeJob({ id: 'cj_b', status: 'completed', cwd: '/elsewhere/project' }),
    ],
  });
  const result = await codingJobsTool.execute({ limit: 5 }, ctx(bridge));

  const list = bridge.calls.find(c => c.method === 'listJobs');
  assert.ok(list, 'listJobs was called');
  assert.deepEqual(list!.args[0], { status: undefined, limit: 5 });
  assert.match(result.content, /cj_a \[running\] claude-code "sched-fix"/);
  assert.match(result.content, /\.\/\.home23-worktrees\/fix-sched/);
  assert.match(result.content, /cj_b \[completed\]/);
});

test('coding_backends lists availability and explains the default backend', async () => {
  const bridge = makeFakeBridge();
  const result = await codingBackendsTool.execute({}, ctx(bridge));
  assert.match(result.content, /claude-code: available \(\/usr\/local\/bin\/claude\)/);
  assert.match(result.content, /default model claude-sonnet-4-7/);
  assert.match(result.content, /codex: NOT AVAILABLE/);
  assert.match(result.content, /acp\.defaultAgent/);
  assert.match(result.content, /codex requires the Codex CLI/i);
});
