/**
 * File tools — read, write, edit, list, search files.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { exec } from 'node:child_process';
import type { ToolDefinition, ToolContext, ToolResult } from '../types.js';

export const readFileTool: ToolDefinition = {
  name: 'read_file',
  description: 'Read the contents of a file. Supports offset/limit for large files.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute path to the file' },
      offset: { type: 'number', description: 'Line number to start from (0-based)' },
      limit: { type: 'number', description: 'Max lines to return' },
    },
    required: ['path'],
  },
  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const path = input.path as string;
    const offset = (input.offset as number) || 0;
    const limit = input.limit as number | undefined;
    if (!existsSync(path)) return { content: `File not found: ${path}`, is_error: true };
    try {
      const content = readFileSync(path, 'utf-8');
      let lines = content.split('\n');
      if (offset > 0) lines = lines.slice(offset);
      if (limit) lines = lines.slice(0, limit);
      const result = lines.join('\n');
      if (result.length > 8000) {
        return { content: result.slice(0, 8000) + `\n\n(truncated, ${content.length} total chars, ${content.split('\n').length} total lines)` };
      }
      return { content: result };
    } catch (err) {
      return { content: `Error reading ${path}: ${err instanceof Error ? err.message : String(err)}`, is_error: true };
    }
  },
};

export const writeFileTool: ToolDefinition = {
  name: 'write_file',
  description: 'Create or overwrite a file. Creates parent directories if needed.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute path to the file' },
      content: { type: 'string', description: 'Content to write' },
    },
    required: ['path', 'content'],
  },
  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const path = input.path as string;
    const content = input.content as string;
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
      return { content: `Wrote ${content.length} chars to ${path}` };
    } catch (err) {
      return { content: `Error writing ${path}: ${err instanceof Error ? err.message : String(err)}`, is_error: true };
    }
  },
};

export const editFileTool: ToolDefinition = {
  name: 'edit_file',
  description: 'Replace a string in an existing file. The old_string must appear exactly once (or use replace_all).',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute path to the file' },
      old_string: { type: 'string', description: 'The exact text to find and replace' },
      new_string: { type: 'string', description: 'The replacement text' },
      replace_all: { type: 'boolean', description: 'Replace all occurrences (default: false)' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const path = input.path as string;
    const oldStr = input.old_string as string;
    const newStr = input.new_string as string;
    const replaceAll = (input.replace_all as boolean) || false;
    if (!existsSync(path)) return { content: `File not found: ${path}`, is_error: true };
    try {
      let content = readFileSync(path, 'utf-8');
      if (!replaceAll) {
        const count = content.split(oldStr).length - 1;
        if (count === 0) return { content: `old_string not found in ${path}`, is_error: true };
        if (count > 1) return { content: `old_string found ${count} times — must be unique (or use replace_all)`, is_error: true };
        content = content.replace(oldStr, newStr);
      } else {
        content = content.replaceAll(oldStr, newStr);
      }
      writeFileSync(path, content);
      return { content: `Edited ${path}` };
    } catch (err) {
      return { content: `Error editing ${path}: ${err instanceof Error ? err.message : String(err)}`, is_error: true };
    }
  },
};

export const listFilesTool: ToolDefinition = {
  name: 'list_files',
  description: 'List files matching a glob pattern. Returns file paths.',
  input_schema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern (e.g., "src/**/*.ts", "*.json")' },
      cwd: { type: 'string', description: 'Base directory (default: project root)' },
    },
    required: ['pattern'],
  },
  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const pattern = input.pattern as string;
    const cwd = (input.cwd as string) || ctx.projectRoot;
    // Use rg --files which properly supports ** recursive globs (find -path does not)
    const cmd = `rg --files --glob ${JSON.stringify(pattern)} ${JSON.stringify(cwd)} 2>/dev/null | head -200`;
    return new Promise((resolve) => {
      exec(cmd, { timeout: 15_000, maxBuffer: 1024 * 512 }, (_error, stdout) => {
        const files = stdout.trim().split('\n').filter(Boolean);
        if (files.length === 0) resolve({ content: 'No files matched.' });
        else resolve({ content: files.join('\n') + (files.length >= 200 ? '\n(truncated at 200)' : '') });
      });
    });
  },
};

export const searchFilesTool: ToolDefinition = {
  name: 'search_files',
  description: 'Search file contents using ripgrep or grep. Returns matching lines with paths and line numbers.',
  input_schema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regex pattern to search for' },
      path: { type: 'string', description: 'Directory or file to search (default: project root)' },
      glob: { type: 'string', description: 'File glob filter (e.g., "*.ts")' },
      max_results: { type: 'number', description: 'Max matching lines (default: 50)' },
    },
    required: ['pattern'],
  },
  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const pattern = input.pattern as string;
    const searchPath = (input.path as string) || ctx.projectRoot;
    const fileGlob = input.glob as string | undefined;
    const maxResults = Math.max(1, Math.min(500, Number(input.max_results) || 50));

    // Use rg if available, else fall back to grep. Each branch is a separate
    // pipeline with its OWN `head -N` — previously the shell precedence
    // `rg ... || grep ... | head -N` meant head only capped the fallback,
    // and rg could blow past exec's maxBuffer, making the callback fire
    // with empty stdout and the agent seeing a silent "No matches found".
    //
    // We also intentionally DO NOT swallow stderr — if rg fails (bad regex,
    // permission issues) we surface the message so the agent can correct
    // itself instead of retrying variants of the same broken search.
    const globRg = fileGlob ? `--glob ${JSON.stringify(fileGlob)}` : '';
    const includeGrep = fileGlob ? `--include=${JSON.stringify(fileGlob)}` : '';
    const rgCmd = `rg -n --max-count ${maxResults} ${globRg} -- ${JSON.stringify(pattern)} ${JSON.stringify(searchPath)} | head -${maxResults}`;
    const grepCmd = `grep -rn ${JSON.stringify(pattern)} ${JSON.stringify(searchPath)} ${includeGrep} | head -${maxResults}`;
    // `{ rg; } || { grep; }` runs rg's pipeline; only if rg exits non-zero does grep run.
    // `head` exiting early (SIGPIPE once it has N lines) counts as rg exit ≠ 0 too, but
    // in that case stdout already contains N matches so the fallback is a no-op.
    const cmd = `{ ${rgCmd}; } || { ${grepCmd}; }`;

    return new Promise((resolve) => {
      exec(cmd, { maxBuffer: 1024 * 1024, timeout: 30_000, shell: '/bin/bash' }, (error, stdout, stderr) => {
        const execError = error as (Error & { code?: string | number; killed?: boolean; signal?: string }) | null;

        // exec returns an error when the command times out or the shell
        // exits non-zero. For our pipeline a non-zero exit usually just
        // means "no matches". Distinguish real failures (timeout, spawn
        // errors, ENOBUFS) from grep's "no matches" (exit 1 with empty
        // stdout) so we can surface the former.
        if (execError && !('code' in execError && typeof execError.code === 'number')) {
          const errMsg = String(execError.code || execError.message || 'unknown');
          resolve({
            content: `search_files failed: ${errMsg}${stderr ? `\n\nSTDERR:\n${stderr.slice(0, 800)}` : ''}`,
            is_error: true,
          });
          return;
        }

        const out = stdout.trim();
        if (!out) {
          const tail = stderr.trim();
          resolve({
            content: tail
              ? `No matches found. (stderr: ${tail.slice(0, 400)})`
              : 'No matches found.',
          });
          return;
        }
        resolve({ content: out.slice(0, 6000) });
      });
    });
  },
};
