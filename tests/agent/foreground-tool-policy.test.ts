import assert from 'node:assert/strict';
import { test } from 'node:test';
import { executeAndFormatTool } from '../../src/agent/tool-result.js';
import {
  FOREGROUND_SHELL_MAX_TIMEOUT_MS,
  applyForegroundToolPolicy,
} from '../../src/agent/foreground-tool-policy.js';

const foreground = { chatId: 'ios_chat', turnRuntime: { turnId: 't_1' } };

test('foreground coding and spawn_agent require a distinct canonical Working Thread', () => {
  const coding = applyForegroundToolPolicy('coding_run', { prompt: 'build it', wait_seconds: 120 }, foreground);
  assert.equal(coding.action, 'require_work');
  assert.equal(coding.request?.tool, 'coding_run');
  assert.match(coding.request?.executionInstruction ?? '', /"prompt":"build it"/);
  assert.match(coding.request?.executionInstruction ?? '', /"wait_seconds":120/);

  const spawn = applyForegroundToolPolicy('spawn_agent', { task: 'deep work', mode: 'joined' }, foreground);
  assert.equal(spawn.action, 'require_work');
  assert.equal(spawn.request?.tool, 'spawn_agent');

  const shell = applyForegroundToolPolicy('shell', { command: 'sleep 30', timeout_ms: 300_000 }, foreground);
  assert.equal(shell.action, 'handoff');
  assert.equal(shell.input.timeout_ms, FOREGROUND_SHELL_MAX_TIMEOUT_MS);
});

test('every promoted long-tool family preserves complete JSON intent; unjoined durable operations fail closed', () => {
  const promotable = [
    ['skills_run', {skillId:'care',action:'run'}],
    ['bot_invoke',{botId:'helper',prompt:'help'}],
    ['worker_run', { worker: 'systems', prompt: 'check' }],
    ['generate_image', { prompt: 'image' }],
    ['generate_music', { prompt: 'song' }],
    ['tts', { text: 'hello' }],
    ['coding_run', { prompt: 'build', cwd: '/repo', backend: 'codex' }],
    ['spawn_agent', { task: 'audit', mode: 'detached', tools: ['web'] }],
    ['brain_query_export', { query: 'q', answer: 'a', format: 'markdown' }],
  ] as const;
  for (const [name, args] of promotable) {
    const decision = applyForegroundToolPolicy(name, args, foreground);
    assert.equal(decision.action, 'require_work', name);
    assert.equal((decision.request?.executionInstruction ?? '').includes(JSON.stringify(args)), true, name);
  }


});

test('joined workers, media, cron and skills detach', () => {
  const decision = applyForegroundToolPolicy('worker_run', { worker: 'systems', prompt: 'check' }, foreground);
  assert.equal(decision.action, 'require_work');
  assert.equal(applyForegroundToolPolicy('generate_image', { prompt: 'home' }, foreground).action, 'require_work');
  assert.equal(applyForegroundToolPolicy('cron_run', { job_id: 'cron_daily' }, foreground).action, 'require_work');
  assert.equal(applyForegroundToolPolicy('skills_run', { skillId: 'care', action: 'run' }, foreground).action, 'require_work');
});

test('ordinary coordination Works are speaking turns while canonical Working Threads may use long tools', () => {
  const speaking = applyForegroundToolPolicy(
    'worker_run',
    { worker: 'systems', prompt: 'check' },
    { chatId: 'coordination:ch:w1', turnRuntime: { coordinationOrigin: { kind: 'coordination' } } as never },
  );
  assert.equal(speaking.action, 'require_work');

  const working = applyForegroundToolPolicy(
    'worker_run',
    { worker: 'systems', prompt: 'check' },
    {
      chatId: 'coordination:ch:w2',
      coordinationWorkDestination: { parentWorkId: 'wrk_w2' } as never,
      turnRuntime: { coordinationOrigin: { kind: 'coordination' } } as never,
    },
  );
  assert.equal(working.action, 'permit');
});

test('executeAndFormatTool requests a canonical detach only for a joinable long tool', async () => {
  const requests: unknown[] = [];
  let executed = 0;
  const rendered = await executeAndFormatTool({
    registry: {
      execute: async () => {
        executed += 1;
        return { content: 'should not run' };
      },
    } as never,
    name: 'coding_run',
    toolCallId: 'call-1',
    input: { worker: 'systems', prompt: 'check' },
    context: {
      chatId: 'ios_chat',
      turnRuntime: { turnId: 't_fg' },
      onForegroundDetachRequired: (request) => requests.push(request),
    } as never,
    modelLimit: 4000,
    eventLimit: 4000,
  });
  assert.equal(executed, 0);
  assert.equal(rendered.success, false);
  assert.match(rendered.result.content, /was not started/);
  assert.match(rendered.result.content, /must become durable Work/);
  assert.match(rendered.result.content, /[Dd]o not claim this assignment exists as Work/);
  assert.doesNotMatch(rendered.result.content, /Detach is not wired yet/);
  assert.match(rendered.result.content, /already active/);
  assert.doesNotMatch(rendered.result.content, /being treated as background Work/);
  assert.equal((requests[0] as { tool: string }).tool, 'coding_run');
});

test('executeAndFormatTool does not start coding until canonical Working Thread promotion succeeds', async () => {
  let captured: Record<string, unknown> | null = null;
  const rendered = await executeAndFormatTool({
    registry: {
      execute: async (_name: string, input: Record<string, unknown>) => {
        captured = input;
        return { content: 'started job' };
      },
    } as never,
    name: 'coding_run',
    toolCallId: 'call-2',
    input: { prompt: 'build it', wait_seconds: 90 },
    context: { chatId: 'ios_chat', turnRuntime: { turnId: 't_fg' } } as never,
    modelLimit: 4000,
    eventLimit: 4000,
  });
  assert.equal(rendered.success, false);
  assert.equal(captured, null);
  assert.match(rendered.result.content, /was not started/);
});


test('long real-shaped spawn assignment survives strict signed admission without changing selected arguments', async () => {
  const { parseForegroundDetachmentRequest } = await import('../../src/coordination-adapter/foreground-detachment-contract.js');
  const parentOrigin = { kind: 'coordination' as const, workId: 'wrk_parent', attemptId: 'att_parent',
    leaseId: 'lse_parent', holderPrincipalId: 'bot_jerry', holderInstanceId: 'home23-jerry-harness',
    authorityReference: 'resident:jerry', fencingToken: 1, channelId: 'chn_origin',
    originMessageId: 'msg_origin', roundId: null };
  for (const task of [
    'Using only this supplied fictional scenario, prepare an approximately 900-word reliability review with eight concrete failure cases and a short conclusion: a household assistant accepts a long assignment, keeps conversation available, saves progress, survives relaunch, supports cancellation, and returns one final result. Analyze duplicate delivery, lost acknowledgments, restart, cancellation races, simultaneous assignments, resident isolation, and stale UI.',
    '家庭の状態を確認してください。'.repeat(30),
    'Review 🏠 household reliability and 🧪 cancellation. '.repeat(20),
    'a'.repeat(280),
    'a'.repeat(281),
  ]) {
    const args = { task, label: 'Working Thread check', mode: 'joined', tool_grants: [], isolated: true, model: '', effort: 'medium' };
    let admitted: ReturnType<typeof parseForegroundDetachmentRequest> | undefined;
    const rendered = await executeAndFormatTool({
      registry: { execute: async () => assert.fail('speaking turn must never run the selected invocation') } as never,
      name: 'spawn_agent', toolCallId: 'call_long_assignment', input: args,
      context: { chatId: 'coordination:origin', turnRuntime: { turnId: 'speaking', coordinationOrigin: parentOrigin },
        onForegroundDetachRequired: async (request: import('../../src/agent/foreground-tool-policy.js').ForegroundDetachRequest) => {
          admitted = parseForegroundDetachmentRequest({ parentOrigin: request.parentOrigin, residentSlug: 'jerry',
            invocationId: request.invocationId, toolName: request.tool, canonicalArgs: request.canonicalArgs,
            executionInstruction: request.executionInstruction, title: request.assignmentLabel, summary: request.assignmentLabel,
            recoveryPolicy: 'safe_before_start' });
          return { created: true, handle: { workId: 'wrk_child' } };
        },
      } as never, modelLimit: 4000, eventLimit: 4000,
    });
    assert.equal(rendered.success, true);
    assert.ok(admitted);
    assert.ok(Buffer.byteLength(admitted.title, 'utf8') <= 280);
    assert.equal(Buffer.from(admitted.title, 'utf8').toString('utf8'), admitted.title);
    assert.deepEqual(admitted.canonicalArgs, args);
    assert.equal(admitted.executionInstruction.includes(JSON.stringify(args)), true);
  }
});

test('incompatible isolated:false is refused before immutable Working Thread admission', async () => {
  const canonical = { chatId: 'coordination:channel:parent', turnRuntime: { coordinationOrigin: { kind: 'coordination' } } };
  for (const mode of ['joined', 'detached', undefined]) {
    const args = { task: 'Review the supplied fictional scenario.', tool_grants: [], isolated: false, ...(mode ? { mode } : {}) };
    const snapshot = JSON.stringify(args);
    let admissions = 0;
    let executions = 0;
    const rendered = await executeAndFormatTool({
      registry: { execute: async () => { executions++; return { content: 'unexpected' }; } } as never,
      name: 'spawn_agent', toolCallId: 'call_invalid_isolation', input: args,
      context: { ...canonical, onForegroundDetachRequired: async () => { admissions++; return { created: true }; } } as never,
      modelLimit: 4000, eventLimit: 4000,
    });
    assert.equal(rendered.success, false);
    assert.match(rendered.modelContent, /isolated:true or omit isolated/);
    assert.equal(admissions, 0);
    assert.equal(executions, 0);
    assert.equal(JSON.stringify(args), snapshot);
  }
  assert.equal(applyForegroundToolPolicy('spawn_agent', { task: 'review', mode: 'joined', isolated: false }, foreground).action, 'refuse');
  for (const mode of ['detached', undefined]) {
    const args = { task: 'review', isolated: false, ...(mode ? { mode } : {}) };
    const decision = applyForegroundToolPolicy('spawn_agent', args, foreground);
    assert.equal(decision.action, 'require_work');
    assert.equal(decision.input, args);
  }
});

test('corrected canonical specialist selections preserve exact arguments for admission', async () => {
  for (const isolated of [true, undefined]) {
    const args = { task: 'Review the supplied fictional scenario.', mode: 'joined', tool_grants: [], ...(isolated === undefined ? {} : { isolated }) };
    let admitted: import('../../src/agent/foreground-tool-policy.js').ForegroundDetachRequest | undefined;
    const rendered = await executeAndFormatTool({
      registry: { execute: async () => assert.fail('foreground must not execute') } as never,
      name: 'spawn_agent', toolCallId: 'call_corrected_isolation', input: args,
      context: { chatId: 'coordination:channel:parent', turnRuntime: { coordinationOrigin: { kind: 'coordination' } },
        onForegroundDetachRequired: async (request: import('../../src/agent/foreground-tool-policy.js').ForegroundDetachRequest) => { admitted = request; return { created: true, handle: { workId: 'wrk_child' } }; },
      } as never,
      modelLimit: 4000, eventLimit: 4000,
    });
    assert.equal(rendered.success, true);
    assert.deepEqual(admitted?.canonicalArgs, args);
    assert.ok(admitted?.executionInstruction?.includes(JSON.stringify(args)));
  }
});
