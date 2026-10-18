/**
 * Identity tools — read and update the agent's own identity files.
 */

import { inspectIdentitySource, preserveIdentitySource } from '../identity-maintenance.js';
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolDefinition, ToolContext, ToolResult } from '../types.js';

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

    const filePath = join((ctx.personalWorkspacePath ?? ctx.workspacePath), file);

    try {
      const preserved = preserveIdentitySource((ctx.personalWorkspacePath ?? ctx.workspacePath), file);
      if (mode === 'append') {
        appendFileSync(filePath, '\n' + content);
      } else {
        writeFileSync(filePath, content);
      }

      // Invalidate context cache so system prompt rebuilds with new content
      ctx.contextManager.invalidate();

      const audit = inspectIdentitySource((ctx.personalWorkspacePath ?? ctx.workspacePath), file);
      return { content: `Updated ${file} (${mode}).` + ('maintenanceNeeded' in audit && audit.maintenanceNeeded
        ? ' This file exceeds its active-context target. Consolidate current guidance and move historical detail to an indexed archive, preserving source and exact references; do not drop owner instructions or append another duplicate correction.' : ''),
        metadata: { preserved, audit } };
    } catch (err) {
      return { content: `Error updating ${file}: ${err instanceof Error ? err.message : String(err)}`, is_error: true };
    }
  },
};

export const selfReadTool: ToolDefinition = {
  name: 'self_read',
  description: 'Read the complete current contents of an identity file. The displayed page may continue: follow its exact self_read call to recover the rest. When available, task_context retains the original requested text.',
  input_schema: {
    type: 'object',
    properties: {
      file: { type: 'string', description: 'Filename (e.g., MEMORY.md, LEARNINGS.md, SOUL.md, MISSION.md, HEARTBEAT.md, TODO.md)' },
      offset: { type: 'integer', minimum: 0, description: 'Absolute UTF-16 character offset to start from (default 0; use the exact offset from a self_read continuation)' },
      limit: { type: 'integer', minimum: 1, description: 'Optional requested page size in UTF-16 characters; a surrogate pair stays whole. Omit to read through the end. The displayed page may be smaller and supplies its exact continuation.' },
    },
    required: ['file'],
  },

  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const file = input.file;
    if (typeof file !== 'string' || !file) return { content: 'Provide a nonempty identity filename.', is_error: true };
    const filePath = join((ctx.personalWorkspacePath ?? ctx.workspacePath), file);

    if (!existsSync(filePath)) {
      return { content: `File not found: ${file}`, is_error: true };
    }

    try {
      const content = readFileSync(filePath, 'utf-8');
      const index = (value: unknown, name: string, minimum: number, fallback: number): number => {
        if (value === undefined) return fallback;
        if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
          throw new TypeError(`${name} must be an integer greater than or equal to ${minimum}.`);
        }
        return value;
      };
      const offset = Math.min(content.length, index(input.offset, 'offset', 0, 0));
      const limit = input.limit === undefined ? undefined : index(input.limit, 'limit', 1, content.length);
      let end = limit === undefined ? content.length : Math.min(content.length, offset + limit);
      // A page is a source excerpt, not half a Unicode code point. Including
      // the paired low surrogate keeps even a one-character page advancing.
      if (end < content.length && /[\uD800-\uDBFF]/.test(content[end - 1] ?? '') && /[\uDC00-\uDFFF]/.test(content[end] ?? '')) end++;
      return {
        // Retain the complete requested original before display formatting.
        // The shared formatter owns the actual visible end and continuation;
        // a tool-level clipping marker must never skip undisplayed source.
        content: content.slice(offset, end),
        fileRead: { path: filePath, offsetChars: offset, totalChars: content.length,
          continuation: { toolName: 'self_read', file, ...(limit === undefined ? {} : { limit }) } },
      };
    } catch (err) {
      return { content: `Error reading ${file}: ${err instanceof Error ? err.message : String(err)}`, is_error: true };
    }
  },
};
