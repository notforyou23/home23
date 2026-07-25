/**
 * Restricted file tools — root-confined read/write/list for constrained agents.
 *
 * Built for the ShakedownJerry proposer (Task 7 of
 * docs/superpowers/plans/2026-07-25-shakedown-jerry-proposer.md): the standard
 * files.ts tools pass absolute paths through unconfined, so a proposer must get
 * these instead. Every path is symlink-resolved BEFORE the prefix check (the
 * 2026-07-25 write audit found a live symlink from a worktree into the repo),
 * deny rules are checked before allow rules, and write roots are separate from
 * read roots.
 *
 * This module grants nothing by itself — confinement only holds if the agent
 * receives ONLY these tools. Registry wiring happens separately.
 */

import { mkdirSync, readdirSync, statSync, writeFileSync, renameSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { ToolDefinition, ToolContext, ToolResult } from '../types.js';

export interface RestrictedFileToolsConfig {
  /** Roots readable (realpaths computed at factory time). Write roots are implicitly readable. */
  readRoots: readonly string[];
  /** Roots writable. Keep narrow: worker workspace + the approval queue file's directory. */
  writeRoots: readonly string[];
  /** Resolved paths under these are always refused, even inside an allowed root. */
  denyPaths: readonly string[];
  /** Max bytes returned by a read (default 64k) and accepted by a write (default 512k). */
  maxReadBytes?: number;
  maxWriteBytes?: number;
}

interface CompiledRoots {
  read: string[];
  write: string[];
  deny: string[];
  maxReadBytes: number;
  maxWriteBytes: number;
}

function isWithin(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function compileRoots(config: RestrictedFileToolsConfig): CompiledRoots {
  const real = (p: string) => {
    const resolved = path.resolve(p);
    if (!existsSync(resolved)) throw new Error(`Restricted tools root does not exist: ${resolved}`);
    // realpath the root itself: targets are symlink-resolved before the prefix
    // check, so roots must be compared in the same canonical space (e.g. macOS
    // /var -> /private/var).
    const canonical = realpathSync(resolved);
    return statSync(canonical).isDirectory() ? canonical : path.dirname(canonical);
  };
  const write = config.writeRoots.map(real);
  const read = [...config.readRoots.map(real), ...write];
  if (read.length === 0) throw new Error('Restricted tools require at least one read root');
  // Deny paths may not exist yet; realpath where possible, resolve otherwise.
  const deny = config.denyPaths.map((p) => {
    const resolved = path.resolve(p);
    try { return realpathSync(resolved); } catch { return resolved; }
  });
  return {
    read, write, deny,
    maxReadBytes: config.maxReadBytes ?? 64_000,
    maxWriteBytes: config.maxWriteBytes ?? 512_000,
  };
}

/**
 * Canonicalize a declared path so the prefix check runs in realpath space.
 * Symlinks anywhere in the path are RESOLVED (not rejected) — an escape link
 * resolves to its real target, which then fails the prefix check against the
 * realpathed roots. For writes, missing trailing components are allowed: the
 * deepest existing ancestor is realpathed and the (nonexistent, therefore
 * symlink-free) remainder is rejoined.
 */
function canonicalize(declared: string, allowMissingSuffix: boolean): string {
  if (!declared || declared.includes('\0')) throw new Error('path must be a non-empty string');
  const normalized = path.resolve(declared);
  try {
    return realpathSync(normalized);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !allowMissingSuffix) throw error;
  }
  let ancestor = normalized;
  const missing: string[] = [];
  while (!existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error(`no existing ancestor for ${normalized}`);
    missing.unshift(path.basename(ancestor));
    ancestor = parent;
  }
  return path.join(realpathSync(ancestor), ...missing);
}

async function authorize(
  declared: string, roots: CompiledRoots, mode: 'read' | 'write',
): Promise<{ ok: true; path: string } | { ok: false; reason: string }> {
  let resolved: string;
  try {
    resolved = canonicalize(declared, mode === 'write');
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  for (const d of roots.deny) {
    if (isWithin(d, resolved)) return { ok: false, reason: `denied path: ${resolved} is under ${d}` };
  }
  const allowed = mode === 'write' ? roots.write : roots.read;
  if (!allowed.some((root) => isWithin(root, resolved))) {
    return { ok: false, reason: `outside ${mode} roots: ${resolved}` };
  }
  return { ok: true, path: resolved };
}

export function createRestrictedFileTools(config: RestrictedFileToolsConfig): ToolDefinition[] {
  const roots = compileRoots(config);

  const readTool: ToolDefinition = {
    name: 'read_file',
    description: `Read a file. Access is confined to: ${roots.read.join(', ')}. Absolute paths only; symlinks are refused.`,
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path within an allowed root' },
        offset: { type: 'number', description: 'Line to start from (0-based)' },
        limit: { type: 'number', description: 'Max lines to return' },
      },
      required: ['path'],
    },
    async execute(input: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
      const auth = await authorize(String(input.path ?? ''), roots, 'read');
      if (!auth.ok) return { content: `read refused: ${auth.reason}`, is_error: true };
      try {
        const content = readFileSync(auth.path, 'utf-8');
        let lines = content.split('\n');
        const offset = Number(input.offset) || 0;
        if (offset > 0) lines = lines.slice(offset);
        if (input.limit) lines = lines.slice(0, Number(input.limit));
        const out = lines.join('\n');
        if (out.length > roots.maxReadBytes) {
          return { content: out.slice(0, roots.maxReadBytes) + `\n(truncated at ${roots.maxReadBytes} bytes)` };
        }
        return { content: out };
      } catch (error) {
        return { content: `read failed: ${error instanceof Error ? error.message : String(error)}`, is_error: true };
      }
    },
  };

  const writeTool: ToolDefinition = {
    name: 'write_file',
    description: `Create or overwrite a file. Writes are confined to: ${roots.write.join(', ')}. Atomic (tmp+rename).`,
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path within a writable root' },
        content: { type: 'string', description: 'Full file content' },
      },
      required: ['path', 'content'],
    },
    async execute(input: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
      const auth = await authorize(String(input.path ?? ''), roots, 'write');
      if (!auth.ok) return { content: `write refused: ${auth.reason}`, is_error: true };
      const body = String(input.content ?? '');
      if (Buffer.byteLength(body) > roots.maxWriteBytes) {
        return { content: `write refused: ${Buffer.byteLength(body)} bytes exceeds ${roots.maxWriteBytes}`, is_error: true };
      }
      try {
        mkdirSync(path.dirname(auth.path), { recursive: true });
        const tmp = `${auth.path}.tmp-${process.pid}`;
        writeFileSync(tmp, body);
        renameSync(tmp, auth.path);
        return { content: `wrote ${Buffer.byteLength(body)} bytes to ${auth.path}` };
      } catch (error) {
        return { content: `write failed: ${error instanceof Error ? error.message : String(error)}`, is_error: true };
      }
    },
  };

  const listTool: ToolDefinition = {
    name: 'list_files',
    description: `List a directory (non-recursive). Confined to: ${roots.read.join(', ')}.`,
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Absolute directory path within an allowed root' } },
      required: ['path'],
    },
    async execute(input: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
      const auth = await authorize(String(input.path ?? ''), roots, 'read');
      if (!auth.ok) return { content: `list refused: ${auth.reason}`, is_error: true };
      try {
        const entries = readdirSync(auth.path).slice(0, 500)
          .map((name) => {
            const s = statSync(path.join(auth.path, name));
            return `${s.isDirectory() ? 'd' : '-'} ${String(s.size).padStart(10)} ${name}`;
          });
        return { content: entries.join('\n') || '(empty)' };
      } catch (error) {
        return { content: `list failed: ${error instanceof Error ? error.message : String(error)}`, is_error: true };
      }
    },
  };

  return [readTool, writeTool, listTool];
}
