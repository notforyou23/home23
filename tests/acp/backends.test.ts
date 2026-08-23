import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { buildChildEnv, getBackend, listBackendIds } from '../../src/acp/backends.js';
import type { BridgeConfig, CodingBackendOptions } from '../../src/acp/types.js';

const grok = getBackend('grok-build')!;
const claude = getBackend('claude-code')!;
const codex = getBackend('codex')!;
const cursor = getBackend('cursor')!;

function baseOpts(overrides: Partial<CodingBackendOptions> = {}): CodingBackendOptions {
  return {
    prompt: 'fix the bug',
    cwd: '/tmp/work',
    permissionMode: 'bypassPermissions',
    ...overrides,
  };
}

function config(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    enabled: true,
    defaultAgent: 'claude-code',
    allowedAgents: ['claude-code', 'codex'],
    permissionMode: 'bypassPermissions',
    ...overrides,
  };
}

test('registry exposes all built-in backends and Grok first', () => {
  assert.deepEqual(listBackendIds(), ['grok-build', 'claude-code', 'codex', 'cursor']);
  assert.equal(grok.supportsResume, true);
  assert.equal(claude.supportsResume, true);
  assert.equal(codex.supportsResume, true);
  assert.equal(cursor.supportsResume, true);
});

test('grok-build argv maps headless permissions, model, effort, and prompt', () => {
  const args = grok.buildArgs(baseOpts({
    newSessionId: 'uuid-1',
    model: 'grok-4.6-build',
    effort: 'high',
    appendSystemPrompt: 'be terse',
  }));
  assert.deepEqual(args, [
    '--single', 'fix the bug', '--session-id', 'uuid-1',
    '--model', 'grok-4.6-build',
    '--reasoning-effort', 'high',
    '--always-approve', '--rules', 'be terse',
    '--output-format', 'streaming-json', '--no-alt-screen',
  ]);
});

test('grok-build parses streaming text, tool calls, and terminal session metadata', () => {
  assert.deepEqual(grok.parseEvents?.('{"type":"text","data":"hello"}'), [{ kind: 'text', text: 'hello' }]);
  assert.equal(grok.parseEvents?.('{"type":"tool_call","toolName":"run_terminal_command","rawInput":{"command":"pwd"}}')[0]?.kind, 'tool_use');
  const end = grok.parseEvents?.('{"type":"end","stopReason":"end_turn","sessionId":"sess-1","total_cost_usd":0.1,"num_turns":2}') ?? [];
  assert.equal(end[0]?.kind, 'session');
  assert.equal(end[1]?.kind, 'result');
});

test('grok-build turns streaming error messages into failed terminal results', () => {
  const events = grok.parseEvents?.('{"type":"error","message":"402 Payment Required: usage balance exhausted"}') ?? [];
  assert.deepEqual(events, [{
    kind: 'result',
    ok: false,
    text: '402 Payment Required: usage balance exhausted',
    costUsd: undefined,
    numTurns: undefined,
    durationMs: undefined,
  }]);
});

test('claude-code argv for a new job with session id, model, effort, budget', () => {
  const args = claude.buildArgs(baseOpts({
    newSessionId: 'uuid-1',
    model: 'opus',
    effort: 'high',
    maxBudgetUsd: 5,
  }));
  assert.deepEqual(args, [
    '-p', '--output-format', 'stream-json', '--verbose',
    '--session-id', 'uuid-1',
    '--model', 'opus',
    '--effort', 'high',
    '--dangerously-skip-permissions',
    '--max-budget-usd', '5',
    'fix the bug',
  ]);
});

test('claude-code resume uses --resume and never --session-id', () => {
  const args = claude.buildArgs(baseOpts({ resumeSessionId: 'sess-9', newSessionId: 'ignored' }));
  assert.ok(args.includes('--resume'));
  assert.equal(args[args.indexOf('--resume') + 1], 'sess-9');
  assert.equal(args.includes('--session-id'), false);
  assert.equal(args[args.length - 1], 'fix the bug');
});

test('claude-code allowlist mode drops the bypass flag and passes tool lists', () => {
  const args = claude.buildArgs(baseOpts({
    permissionMode: 'allowlist',
    allowedTools: ['Bash(git:*)', 'Edit'],
    disallowedTools: ['WebFetch'],
  }));
  assert.equal(args.includes('--dangerously-skip-permissions'), false);
  assert.equal(args[args.indexOf('--allowedTools') + 1], 'Bash(git:*),Edit');
  assert.equal(args[args.indexOf('--disallowedTools') + 1], 'WebFetch');
});

test('claude-code passes unknown permission modes through as --permission-mode', () => {
  const args = claude.buildArgs(baseOpts({ permissionMode: 'plan' }));
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'plan');
  assert.equal(args.includes('--dangerously-skip-permissions'), false);
});

test('claude-code appends system prompt, add-dirs, extraArgs before the final prompt', () => {
  const args = claude.buildArgs(baseOpts({
    appendSystemPrompt: 'be terse',
    addDirs: ['/a', '/b'],
    extraArgs: ['--fallback-model', 'sonnet'],
  }));
  assert.equal(args[args.indexOf('--append-system-prompt') + 1], 'be terse');
  assert.deepEqual(args.filter(a => a === '--add-dir').length, 2);
  const fallbackIdx = args.indexOf('--fallback-model');
  assert.ok(fallbackIdx > -1 && fallbackIdx < args.length - 1);
  assert.equal(args[args.length - 1], 'fix the bug');
});

test('codex argv for a new job bypasses sandbox by default and keeps prompt last', () => {
  const args = codex.buildArgs(baseOpts({ model: 'gpt-5' }));
  assert.deepEqual(args, [
    'exec', '--json', '--skip-git-repo-check',
    '--dangerously-bypass-approvals-and-sandbox',
    '--model', 'gpt-5',
    'fix the bug',
  ]);
});

test('codex allowlist mode falls back to --full-auto; sandbox config overrides both', () => {
  const fullAuto = codex.buildArgs(baseOpts({ permissionMode: 'allowlist' }));
  assert.ok(fullAuto.includes('--full-auto'));
  assert.equal(fullAuto.includes('--dangerously-bypass-approvals-and-sandbox'), false);

  const sandboxed = codex.buildArgs(baseOpts({ sandbox: 'danger-full-access' }));
  assert.equal(sandboxed[sandboxed.indexOf('--sandbox') + 1], 'danger-full-access');
  assert.equal(sandboxed.includes('--dangerously-bypass-approvals-and-sandbox'), false);
  assert.equal(sandboxed.includes('--full-auto'), false);
});

test('codex resume argv starts with exec resume <sessionId>', () => {
  const args = codex.buildArgs(baseOpts({ resumeSessionId: 'thread-1' }));
  assert.deepEqual(args.slice(0, 3), ['exec', 'resume', 'thread-1']);
  assert.ok(args.includes('--json'));
  assert.equal(args[args.length - 1], 'fix the bug');
});

test('claude-code parseEvents handles init, mixed assistant blocks, and result', () => {
  const init = claude.parseEvents!(JSON.stringify({
    type: 'system', subtype: 'init', session_id: 'sess-1', model: 'claude-x',
  }));
  assert.deepEqual(init, [{ kind: 'session', sessionId: 'sess-1', model: 'claude-x' }]);

  const mixed = claude.parseEvents!(JSON.stringify({
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: 'Looking at the file' },
        { type: 'tool_use', name: 'Bash', input: { command: 'ls -la' } },
      ],
    },
  }));
  assert.equal(mixed.length, 2);
  assert.deepEqual(mixed[0], { kind: 'text', text: 'Looking at the file' });
  assert.equal(mixed[1]!.kind, 'tool_use');
  assert.equal((mixed[1] as { tool: string }).tool, 'Bash');
  assert.match((mixed[1] as { summary: string }).summary, /ls -la/);

  // parseEvent stays a first-event wrapper.
  const first = claude.parseEvent(JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'hi' }] },
  }));
  assert.deepEqual(first, { kind: 'text', text: 'hi' });

  const result = claude.parseEvents!(JSON.stringify({
    type: 'result', subtype: 'success', is_error: false, result: 'done',
    total_cost_usd: 0.027, num_turns: 1, duration_ms: 900,
  }));
  assert.deepEqual(result, [{
    kind: 'result', ok: true, text: 'done', costUsd: 0.027, numTurns: 1, durationMs: 900,
  }]);
});

test('claude-code parseEvents trusts is_error over subtype and tolerates pre-init hook lines', () => {
  // Live CLI 2.1.159 emitted subtype "success" with is_error:true on an auth failure.
  const failed = claude.parseEvents!(JSON.stringify({
    type: 'result', subtype: 'success', is_error: true, result: 'auth failed',
  }));
  assert.equal((failed[0] as { ok: boolean }).ok, false);

  // User-level hooks fire before init in headless mode; they must not break parsing.
  for (const subtype of ['hook_started', 'hook_response']) {
    const events = claude.parseEvents!(JSON.stringify({ type: 'system', subtype, hook: 'x' }));
    assert.equal(events.length, 1);
    assert.equal(events[0]!.kind, 'other');
  }

  assert.deepEqual(claude.parseEvents!(''), []);
  assert.equal(claude.parseEvent(''), null);
  const junk = claude.parseEvents!('not json at all');
  assert.equal(junk[0]!.kind, 'other');
});

test('claude-code tool_use summaries are one-line and bounded to 300 chars', () => {
  const events = claude.parseEvents!(JSON.stringify({
    type: 'assistant',
    message: {
      content: [{ type: 'tool_use', name: 'Write', input: { content: `a\nb\n${'x'.repeat(500)}` } }],
    },
  }));
  const summary = (events[0] as { summary: string }).summary;
  assert.equal(summary.includes('\n'), false);
  assert.ok(summary.length <= 300);
});

test('codex parseEvents handles thread, items, completion, and failure', () => {
  const started = codex.parseEvents!(JSON.stringify({ type: 'thread.started', thread_id: 'th-1' }));
  assert.deepEqual(started, [{ kind: 'session', sessionId: 'th-1' }]);

  const message = codex.parseEvents!(JSON.stringify({
    type: 'item.completed', item: { item_type: 'agent_message', text: 'Patched it' },
  }));
  assert.deepEqual(message, [{ kind: 'text', text: 'Patched it' }]);

  // Accept both item_type and type keys.
  const commandAlt = codex.parseEvents!(JSON.stringify({
    type: 'item.completed', item: { type: 'command_execution', command: 'npm test' },
  }));
  assert.deepEqual(commandAlt, [{ kind: 'tool_use', tool: 'shell', summary: 'npm test' }]);

  const fileChange = codex.parseEvents!(JSON.stringify({
    type: 'item.completed', item: { item_type: 'file_change', changes: [{ path: 'a.ts' }] },
  }));
  assert.equal((fileChange[0] as { tool: string }).tool, 'file_change');
  assert.match((fileChange[0] as { summary: string }).summary, /a\.ts/);

  const reasoning = codex.parseEvents!(JSON.stringify({
    type: 'item.completed', item: { item_type: 'reasoning', text: 'thinking about it' },
  }));
  assert.deepEqual(reasoning, [{ kind: 'thinking', text: 'thinking about it' }]);

  // Stateless parser: completion carries no text; the bridge fills it from the last text event.
  const completed = codex.parseEvents!(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10 } }));
  assert.deepEqual(completed, [{ kind: 'result', ok: true, text: '' }]);

  const failed = codex.parseEvents!(JSON.stringify({
    type: 'turn.failed', error: { message: 'model overloaded' },
  }));
  assert.deepEqual(failed, [{ kind: 'result', ok: false, text: 'model overloaded' }]);

  const unknown = codex.parseEvents!(JSON.stringify({ type: 'something.else' }));
  assert.equal(unknown[0]!.kind, 'other');
});

// ─── cursor ──────────────────────────────────────────────────
//
// Shapes below are transcribed from a live cursor-agent 2026.08.11-e8db854 run
// (`-p --output-format stream-json --trust --force --model auto`).

test('cursor resolves cursor-agent only, never the cursor editor launcher', () => {
  assert.deepEqual(cursor.binCandidates, ['cursor-agent', '/Users/jtr/.local/bin/cursor-agent']);
  // /usr/local/bin/cursor is the Cursor editor's VS Code GUI launcher and
  // accepts none of the headless flags; it must not be a fallback candidate.
  assert.equal(cursor.binCandidates.includes('cursor'), false);
  assert.equal(cursor.resolveBin(process.execPath), process.execPath);
  assert.equal(cursor.resolveBin('/nonexistent/cursor-agent-xyz'), cursor.resolveBin());
  const resolved = cursor.resolveBin();
  if (resolved !== null) assert.ok(path.isAbsolute(resolved));
});

test('cursor argv is headless stream-json with --trust and prompt last', () => {
  const args = cursor.buildArgs(baseOpts({ model: 'auto' }));
  assert.deepEqual(args, [
    '-p', '--output-format', 'stream-json', '--trust',
    '--model', 'auto',
    '--force',
    'fix the bug',
  ]);
});

test('cursor never emits --session-id and pre-generated ids are ignored', () => {
  // Cursor has no --session-id flag; the bridge must not pre-generate one and
  // the builder must not smuggle it in if one is passed anyway.
  const args = cursor.buildArgs(baseOpts({ newSessionId: 'uuid-1' }));
  assert.equal(args.includes('--session-id'), false);
  assert.equal(args.includes('uuid-1'), false);
  assert.equal(args.includes('--resume'), false);
});

test('cursor resume passes --resume <chatId> and keeps the prompt last', () => {
  const args = cursor.buildArgs(baseOpts({ resumeSessionId: 'c33647ce-8083', newSessionId: 'ignored' }));
  assert.equal(args[args.indexOf('--resume') + 1], 'c33647ce-8083');
  assert.equal(args.includes('--session-id'), false);
  assert.equal(args.includes('ignored'), false);
  assert.equal(args[args.length - 1], 'fix the bug');
});

test('cursor withholds --force outside bypass and invents no allow/deny or effort flags', () => {
  const gated = cursor.buildArgs(baseOpts({
    permissionMode: 'allowlist',
    allowedTools: ['Bash(git:*)'],
    disallowedTools: ['WebFetch'],
    effort: 'high',
    maxBudgetUsd: 5,
    appendSystemPrompt: 'be terse',
  }));
  assert.equal(gated.includes('--force'), false);
  assert.equal(gated.includes('--yolo'), false);
  for (const unsupported of ['--allow', '--deny', '--allowedTools', '--disallowedTools',
    '--effort', '--reasoning-effort', '--max-budget-usd', '--append-system-prompt']) {
    assert.equal(gated.includes(unsupported), false, `unsupported flag leaked: ${unsupported}`);
  }
  assert.deepEqual(gated, ['-p', '--output-format', 'stream-json', '--trust', 'fix the bug']);

  // plan/ask are real cursor modes and map straight through.
  assert.equal(cursor.buildArgs(baseOpts({ permissionMode: 'plan' })).join(' ').includes('--mode plan'), true);
  assert.equal(cursor.buildArgs(baseOpts({ permissionMode: 'ask' })).join(' ').includes('--mode ask'), true);
});

test('cursor passes repeated --add-dir and extraArgs before the final prompt', () => {
  const args = cursor.buildArgs(baseOpts({
    addDirs: ['/a', '/b'],
    extraArgs: ['--approve-mcps'],
  }));
  assert.equal(args.filter(a => a === '--add-dir').length, 2);
  assert.equal(args[args.indexOf('/a') - 1], '--add-dir');
  const extraIdx = args.indexOf('--approve-mcps');
  assert.ok(extraIdx > -1 && extraIdx < args.length - 1);
  assert.equal(args[args.length - 1], 'fix the bug');
  // cwd comes from spawn(); never --workspace.
  assert.equal(args.includes('--workspace'), false);
});

test('cursor parses init, thinking deltas, assistant text, and shell tool calls', () => {
  const init = cursor.parseEvents!(JSON.stringify({
    type: 'system', subtype: 'init', apiKeySource: 'login',
    session_id: 'c33647ce-8083-463d-b464-6581e2455ff5', model: 'Auto', permissionMode: 'default',
  }));
  assert.deepEqual(init, [{
    kind: 'session', sessionId: 'c33647ce-8083-463d-b464-6581e2455ff5', model: 'Auto',
  }]);

  assert.deepEqual(
    cursor.parseEvents!(JSON.stringify({ type: 'thinking', subtype: 'delta', text: 'Running cat f.txt to' })),
    [{ kind: 'thinking', text: 'Running cat f.txt to' }],
  );
  // The bare 'completed' terminator carries no text and must not emit noise.
  assert.deepEqual(cursor.parseEvents!(JSON.stringify({ type: 'thinking', subtype: 'completed' })), []);

  assert.deepEqual(
    cursor.parseEvents!(JSON.stringify({
      type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'The contents are hi' }] },
    })),
    [{ kind: 'text', text: 'The contents are hi' }],
  );

  const toolStarted = cursor.parseEvents!(JSON.stringify({
    type: 'tool_call', subtype: 'started', call_id: 'tool_1ec6',
    tool_call: {
      shellToolCall: {
        args: { command: 'cat f.txt', workingDirectory: '/private/tmp/cursorprobe' },
        description: 'Read contents of f.txt',
      },
    },
  }));
  assert.deepEqual(toolStarted, [{ kind: 'tool_use', tool: 'shell', summary: 'cat f.txt' }]);

  // 'completed' repeats the same call plus its result; reporting it again
  // would double the receipt's tool count.
  assert.deepEqual(cursor.parseEvents!(JSON.stringify({
    type: 'tool_call', subtype: 'completed', call_id: 'tool_1ec6',
    tool_call: { shellToolCall: { args: { command: 'cat f.txt' }, result: { success: { exitCode: 0 } } } },
  })), []);

  // Non-shell calls fall back to the description when there is no command.
  const readCall = cursor.parseEvents!(JSON.stringify({
    type: 'tool_call', subtype: 'started',
    tool_call: { readToolCall: { args: { path: 'a.ts' }, description: 'Read a.ts' } },
  }));
  assert.deepEqual(readCall, [{ kind: 'tool_use', tool: 'read', summary: 'Read a.ts' }]);
});

test('cursor tool_use summaries are one-line and bounded to 300 chars', () => {
  const events = cursor.parseEvents!(JSON.stringify({
    type: 'tool_call', subtype: 'started',
    tool_call: { shellToolCall: { args: { command: `echo a\nb\n${'x'.repeat(500)}` } } },
  }));
  const summary = (events[0] as { summary: string }).summary;
  assert.equal(summary.includes('\n'), false);
  assert.ok(summary.length <= 300);
});

test('cursor success result blanks its text so the bridge tail is not doubled', () => {
  // The live result line repeats the final assistant message verbatim; the
  // bridge falls back to its tracked lastText when result.text is empty.
  const result = cursor.parseEvents!(JSON.stringify({
    type: 'result', subtype: 'success', duration_ms: 4630, duration_api_ms: 4630,
    is_error: false, result: 'The contents are hi',
    session_id: 'c33647ce', usage: { inputTokens: 14495, outputTokens: 184 },
  }));
  assert.deepEqual(result, [{
    kind: 'result', ok: true, text: '', costUsd: undefined, numTurns: undefined, durationMs: 4630,
  }]);
});

test('cursor failures produce failed results that keep their message', () => {
  const flagged = cursor.parseEvents!(JSON.stringify({
    type: 'result', subtype: 'success', is_error: true, result: 'auth failed', duration_ms: 12,
  }));
  assert.deepEqual(flagged, [{
    kind: 'result', ok: false, text: 'auth failed', costUsd: undefined, numTurns: undefined, durationMs: 12,
  }]);

  const errorSubtype = cursor.parseEvents!(JSON.stringify({
    type: 'result', subtype: 'error_during_execution', result: '',
  }));
  assert.equal((errorSubtype[0] as { ok: boolean }).ok, false);
  assert.equal((errorSubtype[0] as { text: string }).text, 'error_during_execution');

  const typed = cursor.parseEvents!(JSON.stringify({ type: 'error', message: 'rate limit exceeded' }));
  assert.deepEqual(typed, [{ kind: 'result', ok: false, text: 'rate limit exceeded' }]);
});

test('cursor tolerates user echo lines, blank lines, and non-JSON output', () => {
  const echo = cursor.parseEvents!(JSON.stringify({
    type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'fix the bug' }] },
  }));
  assert.equal(echo[0]!.kind, 'other');

  assert.deepEqual(cursor.parseEvents!(''), []);
  assert.equal(cursor.parseEvent(''), null);
  // A bad --model makes the CLI print plain text, not JSON.
  assert.equal(cursor.parseEvents!('Cannot use this model: nope')[0]!.kind, 'other');

  // parseEvent stays a first-event wrapper.
  assert.deepEqual(
    cursor.parseEvent(JSON.stringify({ type: 'thinking', subtype: 'delta', text: 'hm' })),
    { kind: 'thinking', text: 'hm' },
  );
});

test('resolveBin honors an existing absolute config bin and falls back to candidates otherwise', () => {
  // An existing absolute config bin wins verbatim.
  assert.equal(claude.resolveBin(process.execPath), process.execPath);
  // A missing config bin falls back to the candidate list.
  assert.equal(claude.resolveBin('/nonexistent/claude-xyz'), claude.resolveBin());
  assert.equal(codex.resolveBin('also-not-a-real-binary-name-xyz'), codex.resolveBin());
  const resolved = claude.resolveBin();
  if (resolved !== null) assert.ok(path.isAbsolute(resolved));
});

test('buildChildEnv keeps Anthropic auth, strips other secrets, honors passthrough, augments PATH', (t) => {
  const saved: Record<string, string | undefined> = {};
  const set = (key: string, value: string) => {
    saved[key] = process.env[key];
    process.env[key] = value;
  };
  set('ANTHROPIC_AUTH_TOKEN', 'anthropic-token-keep');
  set('ANTHROPIC_API_KEY', 'anthropic-key-keep');
  set('ANTHROPIC_BASE_URL', 'http://localhost:9999');
  set('OPENAI_API_KEY', 'openai-strip');
  set('XAI_API_KEY', 'xai-strip');
  set('OLLAMA_CLOUD_API_KEY', 'ollama-strip');
  set('TELEGRAM_BOT_TOKEN', 'tg-strip');
  set('ENCRYPTION_KEY', 'enc-strip');
  set('DATABASE_URL', 'db-strip');
  set('HOME23_BRIDGE_TOKEN', 'bridge-strip');
  set('HOME23_BRAIN_OPERATIONS_CAPABILITY_KEY', 'priv-strip');
  set('USER', process.env.USER ?? 'testuser');
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const env = buildChildEnv(config({ envPassthrough: ['OPENAI_API_KEY'] }));

  // Home23 is the provider authority: its Anthropic tokens are the CLI's auth.
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'anthropic-token-keep');
  assert.equal(env.ANTHROPIC_API_KEY, 'anthropic-key-keep');
  assert.equal(Object.hasOwn(env, 'ANTHROPIC_BASE_URL'), false);
  assert.equal(Object.hasOwn(env, 'XAI_API_KEY'), false);
  assert.equal(Object.hasOwn(env, 'OLLAMA_CLOUD_API_KEY'), false);
  assert.equal(Object.hasOwn(env, 'TELEGRAM_BOT_TOKEN'), false);
  assert.equal(Object.hasOwn(env, 'ENCRYPTION_KEY'), false);
  assert.equal(Object.hasOwn(env, 'DATABASE_URL'), false);
  assert.equal(Object.hasOwn(env, 'HOME23_BRIDGE_TOKEN'), false);
  assert.equal(Object.hasOwn(env, 'HOME23_BRAIN_OPERATIONS_CAPABILITY_KEY'), false);
  // envPassthrough re-adds on top of the strip list.
  assert.equal(env.OPENAI_API_KEY, 'openai-strip');
  // macOS keychain fallback needs USER.
  assert.equal(env.USER, process.env.USER);
  assert.equal(env.HOME, process.env.HOME);
  assert.equal(env.CLAUDE_CODE_ENTRYPOINT, 'home23-bridge');
  for (const dir of ['/opt/homebrew/bin', '/usr/local/bin', '.local/bin']) {
    assert.ok(env.PATH?.includes(dir), `PATH missing ${dir}: ${env.PATH}`);
  }
});
