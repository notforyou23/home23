/**
 * Coding backend definitions (Step 29).
 *
 * Each backend knows how to find its CLI binary, build a headless argv for a
 * new or resumed session, and normalize one line of the CLI's stdout stream
 * into BridgeEvents. The bridge stays backend-agnostic: it spawns, tails, and
 * finalizes; everything CLI-specific lives here.
 *
 * Env policy (buildChildEnv): spawned CLIs inherit a scrubbed environment.
 * Home23's Anthropic tokens ARE forwarded on purpose — Home23 is the provider
 * authority (Step 21) and its ANTHROPIC_AUTH_TOKEN is auto-refreshed and
 * lineage-monitored, while the claude CLI's own keychain OAuth on this machine
 * is revoked. Everything else secret (OpenAI/xAI/Ollama keys, bot tokens,
 * encryption material) is stripped: codex uses its own ~/.codex/auth.json and
 * no coding CLI needs Home23's infrastructure secrets.
 */

import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { unprivilegedChildEnv } from '../security/child-process-env.js';
import type {
  BridgeConfig,
  BridgeEvent,
  CodingBackend,
  CodingBackendOptions,
} from './types.js';

const SUMMARY_MAX = 300;
const OTHER_RAW_MAX = 500;
const RESULT_TEXT_MAX = 4000;

// Secrets that must never reach a coding CLI child. Anthropic tokens are
// deliberately NOT here (see file-top comment). ANTHROPIC_BASE_URL is stripped
// because a nested Claude Code session may set it and misroute the child.
const STRIPPED_ENV_KEYS = [
  'OPENAI_API_KEY',
  'XAI_API_KEY',
  'OLLAMA_CLOUD_API_KEY',
  'TELEGRAM_BOT_TOKEN',
  'ENCRYPTION_KEY',
  'DATABASE_URL',
  'HOME23_BRIDGE_TOKEN',
  'ANTHROPIC_BASE_URL',
] as const;

function extraPathDirs(): string[] {
  return ['/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.local', 'bin')];
}

function bounded(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function oneLine(text: string, max: number): string {
  return bounded(text.replace(/\s*\n\s*/g, ' '), max);
}

function resolveOnPath(name: string): string | null {
  const dirs = [
    ...(process.env.PATH ?? '').split(':').filter(Boolean),
    ...extraPathDirs(),
  ];
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function resolveBinFrom(candidates: string[], configBin?: string): string | null {
  const all = configBin ? [configBin, ...candidates] : candidates;
  for (const candidate of all) {
    if (path.isAbsolute(candidate)) {
      if (existsSync(candidate)) return candidate;
      continue;
    }
    const found = resolveOnPath(candidate);
    if (found) return found;
  }
  return null;
}

function otherEvent(line: string): BridgeEvent {
  return { kind: 'other', raw: bounded(line, OTHER_RAW_MAX) };
}

// ─── claude-code ─────────────────────────────────────────────

function buildClaudeArgs(opts: CodingBackendOptions): string[] {
  const args = ['-p', '--output-format', 'stream-json', '--verbose'];
  if (opts.resumeSessionId) args.push('--resume', opts.resumeSessionId);
  else if (opts.newSessionId) args.push('--session-id', opts.newSessionId);
  if (opts.model) args.push('--model', opts.model);
  if (opts.effort) args.push('--effort', opts.effort);
  if (opts.permissionMode === 'bypassPermissions') {
    args.push('--dangerously-skip-permissions');
  } else if (opts.permissionMode === 'allowlist') {
    if (opts.allowedTools?.length) args.push('--allowedTools', opts.allowedTools.join(','));
    if (opts.disallowedTools?.length) args.push('--disallowedTools', opts.disallowedTools.join(','));
  } else {
    args.push('--permission-mode', opts.permissionMode);
  }
  if (opts.appendSystemPrompt) args.push('--append-system-prompt', opts.appendSystemPrompt);
  for (const dir of opts.addDirs ?? []) args.push('--add-dir', dir);
  if (opts.maxBudgetUsd !== undefined) args.push('--max-budget-usd', String(opts.maxBudgetUsd));
  if (opts.extraArgs?.length) args.push(...opts.extraArgs);
  args.push(opts.prompt);
  return args;
}

function parseClaudeEvents(line: string): BridgeEvent[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  let obj: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object') return [otherEvent(trimmed)];
    obj = parsed as Record<string, unknown>;
  } catch {
    return [otherEvent(trimmed)];
  }

  // Pre-init hook lines ({"type":"system","subtype":"hook_started"...}) are
  // normal in headless mode when user-level hooks exist; they fall through to
  // 'other' below without disturbing session detection.
  if (obj.type === 'system' && obj.subtype === 'init') {
    return [{
      kind: 'session',
      sessionId: String(obj.session_id ?? ''),
      model: typeof obj.model === 'string' ? obj.model : undefined,
    }];
  }

  if (obj.type === 'assistant') {
    const message = obj.message as Record<string, unknown> | undefined;
    const content = Array.isArray(message?.content) ? (message.content as unknown[]) : [];
    const events: BridgeEvent[] = [];
    for (const raw of content) {
      const block = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
      if (block.type === 'text' && typeof block.text === 'string' && block.text) {
        events.push({ kind: 'text', text: block.text });
      } else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking) {
        events.push({ kind: 'thinking', text: block.thinking });
      } else if (block.type === 'tool_use') {
        events.push({
          kind: 'tool_use',
          tool: String(block.name ?? 'unknown'),
          summary: oneLine(JSON.stringify(block.input ?? {}), SUMMARY_MAX),
        });
      }
    }
    return events.length ? events : [otherEvent(trimmed)];
  }

  if (obj.type === 'result') {
    // Trust is_error, not subtype — the live CLI emits subtype "success" with
    // is_error:true on auth failures.
    return [{
      kind: 'result',
      ok: !obj.is_error,
      text: typeof obj.result === 'string' ? bounded(obj.result, RESULT_TEXT_MAX) : '',
      costUsd: typeof obj.total_cost_usd === 'number' ? obj.total_cost_usd : undefined,
      numTurns: typeof obj.num_turns === 'number' ? obj.num_turns : undefined,
      durationMs: typeof obj.duration_ms === 'number' ? obj.duration_ms : undefined,
    }];
  }

  return [otherEvent(trimmed)];
}

const claudeCodeBackend: CodingBackend = {
  id: 'claude-code',
  binCandidates: ['claude', '/Users/jtr/.local/bin/claude'],
  supportsResume: true,
  resolveBin(configBin?: string): string | null {
    return resolveBinFrom(this.binCandidates, configBin);
  },
  buildArgs: buildClaudeArgs,
  parseEvents: parseClaudeEvents,
  parseEvent(line: string): BridgeEvent | null {
    return parseClaudeEvents(line)[0] ?? null;
  },
};

// ─── grok-build ──────────────────────────────────────────────

function buildGrokArgs(opts: CodingBackendOptions): string[] {
  // --single consumes the next argv token as its prompt, so keep the prompt
  // adjacent; placing flags between them makes Grok parse the first flag as text.
  const args = ['--single', opts.prompt];
  if (opts.resumeSessionId) args.push('--resume', opts.resumeSessionId);
  else if (opts.newSessionId) args.push('--session-id', opts.newSessionId);
  if (opts.model) args.push('--model', opts.model);
  if (opts.effort) args.push('--reasoning-effort', opts.effort);
  if (opts.permissionMode === 'bypassPermissions') {
    args.push('--always-approve');
  } else if (opts.permissionMode === 'allowlist') {
    for (const rule of opts.allowedTools ?? []) args.push('--allow', rule);
    for (const rule of opts.disallowedTools ?? []) args.push('--deny', rule);
  } else {
    args.push('--permission-mode', opts.permissionMode);
  }
  if (opts.appendSystemPrompt) args.push('--rules', opts.appendSystemPrompt);
  if (opts.extraArgs?.length) args.push(...opts.extraArgs);
  args.push('--output-format', 'streaming-json', '--no-alt-screen');
  return args;
}

function parseGrokEvents(line: string): BridgeEvent[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  let obj: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object') return [otherEvent(trimmed)];
    obj = parsed as Record<string, unknown>;
  } catch {
    return [otherEvent(trimmed)];
  }

  const type = String(obj.type ?? '');
  if (type === 'thought') {
    return typeof obj.data === 'string' && obj.data ? [{ kind: 'thinking', text: obj.data }] : [];
  }
  if (type === 'text') {
    return typeof obj.data === 'string' && obj.data ? [{ kind: 'text', text: obj.data }] : [];
  }
  if (type === 'tool_call') {
    return [{
      kind: 'tool_use',
      tool: String(obj.toolName ?? obj.title ?? 'unknown'),
      summary: oneLine(typeof obj.rawInput === 'string' ? obj.rawInput : JSON.stringify(obj.rawInput ?? {}), SUMMARY_MAX),
    }];
  }
  if (type === 'end') {
    const usage = (obj.usage && typeof obj.usage === 'object') ? obj.usage as Record<string, unknown> : {};
    return [
      ...(typeof obj.sessionId === 'string' && obj.sessionId ? [{ kind: 'session', sessionId: obj.sessionId } as BridgeEvent] : []),
      {
        kind: 'result',
        ok: String(obj.stopReason ?? '') !== 'error',
        text: '',
        costUsd: typeof obj.total_cost_usd === 'number' ? obj.total_cost_usd : undefined,
        numTurns: typeof obj.num_turns === 'number' ? obj.num_turns : undefined,
        durationMs: typeof obj.duration_ms === 'number' ? obj.duration_ms : undefined,
      },
    ];
  }
  return [otherEvent(trimmed)];
}

const grokBuildBackend: CodingBackend = {
  id: 'grok-build',
  binCandidates: ['grok', '/Users/jtr/.local/bin/grok'],
  supportsResume: true,
  resolveBin(configBin?: string): string | null {
    return resolveBinFrom(this.binCandidates, configBin);
  },
  buildArgs: buildGrokArgs,
  parseEvents: parseGrokEvents,
  parseEvent(line: string): BridgeEvent | null {
    return parseGrokEvents(line)[0] ?? null;
  },
};

// ─── codex ───────────────────────────────────────────────────

function buildCodexArgs(opts: CodingBackendOptions): string[] {
  // cwd comes from spawn(); never pass -C / --cd.
  const args = opts.resumeSessionId
    ? ['exec', 'resume', opts.resumeSessionId, '--json', '--skip-git-repo-check']
    : ['exec', '--json', '--skip-git-repo-check'];
  if (opts.sandbox) args.push('--sandbox', opts.sandbox);
  else if (opts.permissionMode === 'bypassPermissions') args.push('--dangerously-bypass-approvals-and-sandbox');
  else args.push('--full-auto');
  if (opts.model) args.push('--model', opts.model);
  if (opts.extraArgs?.length) args.push(...opts.extraArgs);
  args.push(opts.prompt);
  return args;
}

function codexItemType(item: Record<string, unknown>): string {
  // Codex has shipped both keys across versions; accept either.
  return String(item.item_type ?? item.type ?? '');
}

function parseCodexEvents(line: string): BridgeEvent[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  let obj: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object') return [otherEvent(trimmed)];
    obj = parsed as Record<string, unknown>;
  } catch {
    return [otherEvent(trimmed)];
  }

  if (obj.type === 'thread.started') {
    return [{ kind: 'session', sessionId: String(obj.thread_id ?? '') }];
  }

  if (obj.type === 'item.completed' && obj.item && typeof obj.item === 'object') {
    const item = obj.item as Record<string, unknown>;
    const itemType = codexItemType(item);
    if (itemType === 'agent_message') {
      return [{ kind: 'text', text: String(item.text ?? '') }];
    }
    if (itemType === 'command_execution') {
      return [{ kind: 'tool_use', tool: 'shell', summary: oneLine(String(item.command ?? ''), SUMMARY_MAX) }];
    }
    if (itemType === 'file_change') {
      const detail = item.changes ?? item.path ?? item.summary ?? item;
      return [{
        kind: 'tool_use',
        tool: 'file_change',
        summary: oneLine(typeof detail === 'string' ? detail : JSON.stringify(detail), SUMMARY_MAX),
      }];
    }
    if (itemType === 'reasoning') {
      return [{ kind: 'thinking', text: String(item.text ?? '') }];
    }
    return [otherEvent(trimmed)];
  }

  if (obj.type === 'turn.completed') {
    // The parser is stateless; the bridge fills text from the last 'text' event.
    return [{ kind: 'result', ok: true, text: '' }];
  }

  if (obj.type === 'turn.failed') {
    const error = obj.error;
    const message = typeof error === 'string'
      ? error
      : (error && typeof error === 'object' && typeof (error as Record<string, unknown>).message === 'string')
        ? String((error as Record<string, unknown>).message)
        : JSON.stringify(error ?? 'turn failed');
    return [{ kind: 'result', ok: false, text: bounded(message, RESULT_TEXT_MAX) }];
  }

  return [otherEvent(trimmed)];
}

const codexBackend: CodingBackend = {
  id: 'codex',
  binCandidates: ['codex'],
  supportsResume: true,
  resolveBin(configBin?: string): string | null {
    return resolveBinFrom(this.binCandidates, configBin);
  },
  buildArgs: buildCodexArgs,
  parseEvents: parseCodexEvents,
  parseEvent(line: string): BridgeEvent | null {
    return parseCodexEvents(line)[0] ?? null;
  },
};

// ─── Registry + child env ────────────────────────────────────

const BACKENDS: Record<string, CodingBackend> = {
  'grok-build': grokBuildBackend,
  'claude-code': claudeCodeBackend,
  codex: codexBackend,
};

export function getBackend(id: string): CodingBackend | undefined {
  return BACKENDS[id];
}

export function listBackendIds(): string[] {
  return Object.keys(BACKENDS);
}

export function buildChildEnv(config: BridgeConfig): NodeJS.ProcessEnv {
  const env = unprivilegedChildEnv();
  for (const key of STRIPPED_ENV_KEYS) delete env[key];
  for (const name of config.envPassthrough ?? []) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  const currentPath = env.PATH ?? '';
  const missing = extraPathDirs().filter(dir => !currentPath.includes(dir));
  if (missing.length > 0) {
    env.PATH = currentPath ? `${missing.join(':')}:${currentPath}` : missing.join(':');
  }
  env.CLAUDE_CODE_ENTRYPOINT = 'home23-bridge';
  return env;
}
