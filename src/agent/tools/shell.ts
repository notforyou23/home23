/**
 * Shell tool — run any bash command on the machine.
 */

import { exec } from 'node:child_process';
import type { ToolDefinition, ToolContext, ToolResult } from '../types.js';

export const shellTool: ToolDefinition = {
  name: 'shell',
  description: 'Run a bash command on the machine. Returns stdout, stderr, and exit code. Use for system administration, git, npm, scripts, etc.',
  input_schema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The bash command to execute' },
      cwd: { type: 'string', description: 'Working directory (default: project root; pass an absolute path to run elsewhere)' },
      timeout_ms: { type: 'number', description: 'Timeout in milliseconds (default: 120000)' },
    },
    required: ['command'],
  },

  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const command = input.command as string;
    const cwd = (input.cwd as string) || ctx.projectRoot;
    const timeoutMs = (input.timeout_ms as number) || 300_000;

    return new Promise((resolve) => {
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
      exec(command, { cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024 * 10, env }, (error, stdout, stderr) => {
        const execError = error as (Error & { code?: number; killed?: boolean; signal?: string }) | null;
        const exitCode = execError?.killed ? `KILLED (signal: ${execError.signal ?? 'unknown'})` : (execError?.code ?? 0);
        const parts: string[] = [];

        if (stdout) parts.push(`STDOUT:\n${stdout.slice(0, 8000)}`);
        if (stderr) parts.push(`STDERR:\n${stderr.slice(0, 4000)}`);
        parts.push(`Exit code: ${exitCode}`);

        if (stdout.length > 8000) parts.push(`(stdout truncated, ${stdout.length} total chars)`);

        resolve({
          content: parts.join('\n\n'),
          is_error: exitCode !== 0 && exitCode !== '0',
        });
      });
    });
  },
};
