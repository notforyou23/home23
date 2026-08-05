import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { buildChildEnv, getBackend, listBackendIds } from '../../src/acp/backends.js';
import type { BridgeConfig, CodingBackendOptions } from '../../src/acp/types.js';

const claude = getBackend('claude-code')!;
const codex = getBackend('codex')!;

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

test('registry exposes both built-in backends', () => {
  assert.deepEqual(listBackendIds().sort(), ['claude-code', 'codex']);
  assert.equal(claude.supportsResume, true);
  assert.equal(codex.supportsResume, true);
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
