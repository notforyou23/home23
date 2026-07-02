/**
 * Shell tool — run any bash command on the machine.
 */

import { exec } from 'node:child_process';
import type { ToolDefinition, ToolContext, ToolResult } from '../types.js';

const DEFAULT_STDOUT_LIMIT = 8000;
const DEFAULT_STDERR_LIMIT = 4000;
const MIN_OUTPUT_LIMIT = 500;
const MAX_OUTPUT_LIMIT = 20_000;

function boundedLimit(value: unknown, fallback: number): number {
  const requested = Number(value);
  if (!Number.isFinite(requested) || requested <= 0) return fallback;
  return Math.max(MIN_OUTPUT_LIMIT, Math.min(MAX_OUTPUT_LIMIT, Math.floor(requested)));
}

function formatStream(label: 'STDOUT' | 'STDERR', text: string, limit: number): string | null {
  if (!text) return null;

  const parts = [`${label}:\n${text.slice(0, limit)}`];
  if (text.length > limit) {
    parts.push(
      `(${label.toLowerCase()} truncated at ${limit} chars; ${text.length} total chars. ` +
      'Rerun a narrower command such as rg/head/tail/stat/git diff --stat when you need more.)',
    );
  }
  return parts.join('\n\n');
}

export const shellTool: ToolDefinition = {
  name: 'shell',
  description: 'Run a bash command on the machine. Returns bounded stdout/stderr plus exit code. Prefer narrow commands (rg, head, tail, git diff --stat) before large dumps.',
  input_schema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The bash command to execute' },
      cwd: { type: 'string', description: 'Working directory (default: project root; pass an absolute path to run elsewhere)' },
      timeout_ms: { type: 'number', description: 'Timeout in milliseconds (default: 120000)' },
      max_output_chars: {
        type: 'number',
        description: `Maximum stdout chars returned to the model (${MIN_OUTPUT_LIMIT}-${MAX_OUTPUT_LIMIT}; default ${DEFAULT_STDOUT_LIMIT})`,
      },
      max_stderr_chars: {
        type: 'number',
        description: `Maximum stderr chars returned to the model (${MIN_OUTPUT_LIMIT}-${MAX_OUTPUT_LIMIT}; default ${DEFAULT_STDERR_LIMIT})`,
      },
    },
    required: ['command'],
  },

  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const command = input.command as string;
    const cwd = (input.cwd as string) || ctx.projectRoot;
    const timeoutMs = (input.timeout_ms as number) || 300_000;
    const stdoutLimit = boundedLimit(input.max_output_chars, DEFAULT_STDOUT_LIMIT);
    const stderrLimit = boundedLimit(input.max_stderr_chars, DEFAULT_STDERR_LIMIT);

    return new Promise((resolve) => {
      if (ctx.abortSignal?.aborted) {
        resolve({
          content: `Command aborted before start: ${String(ctx.abortSignal.reason ?? 'operator_stop')}`,
          is_error: true,
        });
        return;
      }

      const env = { ...process.env };
      if (env.PATH) {
        const extras: string[] = [];
        if (process.platform === 'darwin' && !env.PATH.includes('/opt/homebrew/bin')) {
          extras.push('/opt/homebrew/bin');
        }
        if (!env.PATH.includes('/usr/local/bin')) {
          extras.push('/usr/local/bin');
        }
        if (extras.length > 0) {
          env.PATH = `${extras.join(':')}:${env.PATH}`;
        }
      }
      exec(command, { cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024 * 10, env, signal: ctx.abortSignal }, (error, stdout, stderr) => {
        const execError = error as (Error & { code?: number; killed?: boolean; signal?: string }) | null;
        const aborted = Boolean(ctx.abortSignal?.aborted) || execError?.name === 'AbortError';
        const exitCode = aborted
          ? `ABORTED (${String(ctx.abortSignal?.reason ?? execError?.message ?? 'operator_stop')})`
          : execError?.killed
            ? `KILLED (signal: ${execError.signal ?? 'unknown'})`
            : (execError?.code ?? 0);
        const parts: string[] = [];

        const stdoutPart = formatStream('STDOUT', stdout, stdoutLimit);
        const stderrPart = formatStream('STDERR', stderr, stderrLimit);
        if (stdoutPart) parts.push(stdoutPart);
        if (stderrPart) parts.push(stderrPart);
        parts.push(`Exit code: ${exitCode}`);

        resolve({
          content: parts.join('\n\n'),
          is_error: exitCode !== 0 && exitCode !== '0',
        });
      });
    });
  },
};
