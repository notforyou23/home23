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
    const maxResults = (input.max_results as number) || 50;
    const globArg = fileGlob ? `--glob ${JSON.stringify(fileGlob)}` : '';
    const includeArg = fileGlob ? `--include=${JSON.stringify(fileGlob)}` : '';
    const cmd = `rg -n --max-count ${maxResults} ${globArg} -- ${JSON.stringify(pattern)} ${JSON.stringify(searchPath)} 2>/dev/null || grep -rn ${JSON.stringify(pattern)} ${JSON.stringify(searchPath)} ${includeArg} 2>/dev/null | head -${maxResults}`;
    return new Promise((resolve) => {
      exec(cmd, { maxBuffer: 1024 * 1024, timeout: 30_000 }, (_error, stdout) => {
        if (!stdout.trim()) resolve({ content: 'No matches found.' });
        else resolve({ content: stdout.slice(0, 6000) });
      });
    });
  },
};
