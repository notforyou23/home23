/**
 * Identity tools — read and update the agent's own identity files.
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolDefinition, ToolContext, ToolResult } from '../types.js';
import { clipToolOutput } from './clip-output.js';

export const selfUpdateTool: ToolDefinition = {
  name: 'self_update',
  description: 'Update any file in the workspace directory. Use "append" mode to add to the file, or "replace" to overwrite the entire file.',
  input_schema: {
    type: 'object',
    properties: {
      file: { type: 'string', description: 'Filename relative to workspace (e.g., SOUL.md, MEMORY.md, LEARNINGS.md, HEARTBEAT.md, MISSION.md, TODO.md, AGENTS.md, or any other workspace file)' },
      mode: { type: 'string', enum: ['append', 'replace'], description: 'append: add to end of file. replace: overwrite entire file.' },
      content: { type: 'string', description: 'Content to write' },
    },
    required: ['file', 'mode', 'content'],
  },

  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const file = input.file as string;
    const mode = input.mode as string;
    const content = input.content as string;

    if (file.includes('..') || file.startsWith('/')) {
      return { content: `Invalid file path: ${file}. Must be relative to workspace.`, is_error: true };
    }

    const filePath = join(ctx.workspacePath, file);

    try {
      if (mode === 'append') {
        appendFileSync(filePath, '\n' + content);
      } else {
        writeFileSync(filePath, content);
      }

      // Invalidate context cache so system prompt rebuilds with new content
      ctx.contextManager.invalidate();

      return { content: `Updated ${file} (${mode})` };
    } catch (err) {
      return { content: `Error updating ${file}: ${err instanceof Error ? err.message : String(err)}`, is_error: true };
    }
  },
};

export const selfReadTool: ToolDefinition = {
  name: 'self_read',
  description: 'Read the current contents of an identity file for introspection.',
  input_schema: {
    type: 'object',
    properties: {
      file: { type: 'string', description: 'Filename (e.g., MEMORY.md, LEARNINGS.md, SOUL.md, MISSION.md, HEARTBEAT.md, TODO.md)' },
      offset: { type: 'number', description: 'Character offset to start from (use the offset from an OUTPUT TRUNCATED marker)' },
      limit: { type: 'number', description: 'Max characters to return (default 3800)' },
    },
    required: ['file'],
  },

  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const file = input.file as string;
    const filePath = join(ctx.workspacePath, file);

    if (!existsSync(filePath)) {
      return { content: `File not found: ${file}`, is_error: true };
    }

    try {
      const content = readFileSync(filePath, 'utf-8');
      const offset = Math.max(0, Number(input.offset) || 0);
      const limit = Math.max(200, Math.min(Number(input.limit) || 3800, 8000));
      const slice = content.slice(offset, offset + limit);
      const next = offset + slice.length;
      const recovery = next < content.length
        ? `Continue with self_read file=${JSON.stringify(file)} offset=${next} limit=${limit}.`
        : 'This is the last page.';
      return {
        content: clipToolOutput(
          slice,
          `${recovery} File is ${content.length} chars. Started at offset ${offset}.`,
        ),
      };
    } catch (err) {
      return { content: `Error reading ${file}: ${err instanceof Error ? err.message : String(err)}`, is_error: true };
    }
  },
};
