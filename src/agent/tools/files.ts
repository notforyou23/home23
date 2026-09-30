/**
 * File tools — read, write, edit, list, search files.
 */

import {
  readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync, statSync, accessSync,
  constants as fsConstants, promises as fsPromises, type Dirent,
} from 'node:fs';
import { basename, dirname, resolve, relative, isAbsolute, delimiter, join, sep } from 'node:path';
import { exec } from 'node:child_process';
import type { ToolDefinition, ToolContext, ToolResult } from '../types.js';
import { unprivilegedChildEnv } from '../../security/child-process-env.js';
import { refuseResidentWrite } from './tracked-source-guard.js';
import { clipToolOutput } from './clip-output.js';
import { canonicalizeFilePath, isWithinFileRoot } from './restricted-files.js';
import type { ProjectWriteRoot } from './project-write-roots.js';
import {
  refuseReadOutsideRoots,
  resolveShellFsAuthority,
} from './shell-fs-authority.js';

function authorityFor(ctx: ToolContext) {
  return ctx.shellFsAuthority ?? resolveShellFsAuthority(null, {
    projectRoot: ctx.projectRoot,
    instanceDir: ctx.instanceDir,
  });
}


export const WORKSPACE_ESCAPE_REFUSED = 'workspace_escape_refused';

/**
 * Resolve a tool path against the resident workspace.
 *
 * Models often pass `workspace/...` even when `ctx.workspacePath` already ends
 * in `.../workspace`. Strip that redundant first segment (literal `workspace`
 * or the basename of workspacePath) before joining so we do not double-join.
 * Absolute paths (and `~` paths) pass through unchanged.
 */
export function resolvePath(inputPath: string, workspacePath: string): string {
  if (inputPath.startsWith('/')) return inputPath;
  if (inputPath.startsWith('~')) return inputPath; // let shell expand
  const normalized = inputPath.replace(/\\/g, '/');
  const firstSeg = normalized.split('/')[0] ?? '';
  const wsBase = basename(resolve(workspacePath));
  let relativeInput = normalized;
  if (firstSeg === 'workspace' || (firstSeg.length > 0 && firstSeg === wsBase)) {
    relativeInput = normalized.slice(firstSeg.length).replace(/^\/+/, '');
  }
  return resolve(workspacePath, relativeInput);
}

/**
 * Refuse mutating file-tool paths that escape the resident workspace.
 * Shared by write_file / edit_file (and ready for delete/move).
 */
export function refuseWorkspaceEscape(
  targetPath: string,
  workspacePath: string,
  options: { allowMissingLeaf?: boolean; projectWriteRoots?: readonly ProjectWriteRoot[]; inputPath?: string } = {},
): ToolResult | null {
  if (!targetPath) {
    return {
      content: 'write refused: path must be a non-empty string',
      is_error: true,
      metadata: { code: WORKSPACE_ESCAPE_REFUSED },
    };
  }
  if (!workspacePath) {
    return {
      content: 'write refused: workspace path is not configured',
      is_error: true,
      metadata: { code: WORKSPACE_ESCAPE_REFUSED },
    };
  }

  let workspaceRoot: string;
  try {
    const resolvedWs = resolve(workspacePath);
    workspaceRoot = existsSync(resolvedWs) ? realpathSync(resolvedWs) : resolvedWs;
  } catch (error) {
    return {
      content: `write refused: invalid workspace: ${error instanceof Error ? error.message : String(error)}`,
      is_error: true,
      metadata: { code: WORKSPACE_ESCAPE_REFUSED },
    };
  }

  let canonical: string;
  try {
    canonical = canonicalizeFilePath(targetPath, options.allowMissingLeaf ?? true);
  } catch (error) {
    return {
      content: `write refused: ${error instanceof Error ? error.message : String(error)}`,
      is_error: true,
      metadata: { code: WORKSPACE_ESCAPE_REFUSED },
    };
  }

  const projects = options.projectWriteRoots ?? [];
  const roots = [workspaceRoot, ...projects.map(root => root.path)];
  const refuse = (reason: string): ToolResult => ({
    content: `write refused: ${reason}; allowed roots: ${roots.join(', ')}`,
    is_error: true,
    metadata: { code: WORKSPACE_ESCAPE_REFUSED },
  });
  if (projects.length) {
    if (options.inputPath !== undefined && !isAbsolute(options.inputPath)) {
      const first = options.inputPath.replace(/\\/g, '/').split('/').find(segment => segment && segment !== '.');
      const resolvedFirst = relative(resolve(workspacePath), resolve(targetPath)).split(sep)[0];
      if (first === 'instances' || resolvedFirst === 'instances') {
        return refuse('relative instances/... paths would create a shadow tree; use an absolute project path');
      }
    }
    try {
      // Revalidate grants and deny aliases at write time, before any allow rule.
      for (const root of projects) {
        if (realpathSync(root.path) !== root.path || !statSync(root.path).isDirectory()) {
          return refuse(`project root changed or is a symlink: ${root.path}`);
        }
        for (const denied of root.deny) {
          if (isWithinFileRoot(denied, resolve(targetPath)) ||
              isWithinFileRoot(canonicalizeFilePath(denied, true), canonical)) {
            return refuse(`denied project path: ${denied}`);
          }
        }
      }
    } catch (error) {
      return refuse(`invalid project write roots: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!roots.some(root => isWithinFileRoot(root, canonical))) {
    return {
      content: projects.length ? `write refused: path escapes allowed roots (${roots.join(', ')}): ${canonical}`
        : `write refused: path escapes workspace (${workspaceRoot}): ${canonical}`,
      is_error: true,
      metadata: { code: WORKSPACE_ESCAPE_REFUSED },
    };
  }
  return null;
}

export const readFileTool: ToolDefinition = {
  name: 'read_file',
  description: 'Read the contents of a file. Supports offset/limit for large files. Path can be absolute or relative to your workspace.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the file (absolute, or relative to your workspace)' },
      offset: { type: 'number', description: 'Line number to start from (0-based)' },
      limit: { type: 'number', description: 'Max lines to return' },
    },
    required: ['path'],
  },
  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const path = resolvePath(input.path as string, ctx.workspacePath);
    const outside = refuseReadOutsideRoots(path, authorityFor(ctx));
    if (outside) return outside;
    const offset = (input.offset as number) || 0;
    const limit = input.limit as number | undefined;
    if (!existsSync(path)) return { content: `File not found: ${path}`, is_error: true };
    try {
      const content = readFileSync(path, 'utf-8');
      let lines = content.split('\n');
      if (offset > 0) lines = lines.slice(offset);
      if (limit) lines = lines.slice(0, limit);
      const result = lines.join('\n');
      const nextOffset = offset + lines.length;
      const totalLines = content.split('\n').length;
      const recovery = limit
        ? `Continue with read_file path=${JSON.stringify(path)} offset=${nextOffset} limit=${limit}.`
        : `Continue with read_file path=${JSON.stringify(path)} offset=${nextOffset} limit=80.`;
      const clipped = clipToolOutput(
        result,
        `${recovery} File has ${totalLines} lines / ${content.length} chars.`,
      );
      return { content: clipped };
    } catch (err) {
      return { content: `Error reading ${path}: ${err instanceof Error ? err.message : String(err)}`, is_error: true };
    }
  },
};

export const writeFileTool: ToolDefinition = {
  name: 'write_file',
  description: 'Create or overwrite a file inside your workspace or explicitly granted resident project roots, respecting denied paths. Creates parent directories if needed. Paths can be absolute or relative to your workspace; use absolute paths for project roots. Tracked repo source is refused.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the file (absolute under workspace or a granted project root, or relative to workspace)' },
      content: { type: 'string', description: 'Content to write' },
    },
    required: ['path', 'content'],
  },
  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const path = resolvePath(input.path as string, ctx.workspacePath);
    const escaped = refuseWorkspaceEscape(path, ctx.workspacePath, {
      allowMissingLeaf: true, projectWriteRoots: ctx.projectWriteRoots, inputPath: input.path as string,
    });
    if (escaped) return escaped;
    const refused = refuseResidentWrite(path, ctx.projectRoot, ctx.instanceDir);
    if (refused) return refused;
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
  description: 'Replace a string in an existing file inside your workspace or explicitly granted resident project roots, respecting denied paths. The old_string must appear exactly once (or use replace_all). Use absolute paths for project roots. Tracked repo source is refused.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the file (absolute under workspace or a granted project root, or relative to workspace)' },
      old_string: { type: 'string', description: 'The exact text to find and replace' },
      new_string: { type: 'string', description: 'The replacement text' },
      replace_all: { type: 'boolean', description: 'Replace all occurrences (default: false)' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const path = resolvePath(input.path as string, ctx.workspacePath);
    const escaped = refuseWorkspaceEscape(path, ctx.workspacePath, {
      allowMissingLeaf: false, projectWriteRoots: ctx.projectWriteRoots, inputPath: input.path as string,
    });
    if (escaped) return escaped;
    const refused = refuseResidentWrite(path, ctx.projectRoot, ctx.instanceDir);
    if (refused) return refused;
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

// The Home23 Host's product PATH omits Homebrew, so an owner-installed ripgrep
// is only found by looking at the usual install locations after PATH.
const OWNER_RIPGREP_CANDIDATES = ['/opt/homebrew/bin/rg', '/usr/local/bin/rg', '/opt/local/bin/rg'];
// Trees the no-ripgrep fallbacks skip so they stay fast on a whole home.
const FALLBACK_SKIP_DIRS = ['.git', 'node_modules'];
const LIST_LIMIT = 200;

/** Quote a value as a single POSIX shell word: nothing inside is expanded. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The first executable `rg` on PATH, else at an owner-install location, else null. */
export function resolveRipgrep(
  pathEnv: string = unprivilegedChildEnv().PATH ?? '',
  candidates: readonly string[] = OWNER_RIPGREP_CANDIDATES,
): string | null {
  const onPath = pathEnv.split(delimiter).filter(Boolean).map((dir) => join(dir, 'rg'));
  for (const candidate of [...onPath, ...candidates]) {
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // absent or not executable
    }
  }
  return null;
}

/**
 * The search_files pipeline. Without ripgrep it uses grep's extended regex (so
 * rg-style `a|b` alternation still matches), skipping binary files and
 * FALLBACK_SKIP_DIRS. Each branch caps its own output with `head`.
 */
export function buildSearchCommand(
  rgPath: string | null,
  pattern: string,
  searchPath: string,
  fileGlob: string | undefined,
  maxResults: number,
): string {
  if (rgPath) {
    const glob = fileGlob ? ` --glob ${shellQuote(fileGlob)}` : '';
    return `${shellQuote(rgPath)} -n --max-count ${maxResults}${glob} -- ${shellQuote(pattern)} ${shellQuote(searchPath)} | head -${maxResults}`;
  }
  const include = fileGlob ? ` --include=${shellQuote(fileGlob)}` : '';
  const skip = FALLBACK_SKIP_DIRS.map((dir) => ` --exclude-dir=${dir}`).join('');
  return `grep -rnIE${skip}${include} -- ${shellQuote(pattern)} ${shellQuote(searchPath)} | head -${maxResults}`;
}

/**
 * list_files without ripgrep. Like `rg --files --glob`, a pattern without '/'
 * matches file names at any depth, only files under `cwd` are listed (a '../'
 * or absolute pattern cannot reach past the granted folder), FALLBACK_SKIP_DIRS
 * are skipped, and listing stops at `limit` paths.
 */
export async function listFilesWithGlob(pattern: string, cwd: string, limit: number): Promise<string[]> {
  const files: string[] = [];
  const skipped = (entry: Dirent | string) => FALLBACK_SKIP_DIRS.includes(typeof entry === 'string' ? basename(entry) : entry.name);
  for await (const entry of fsPromises.glob(pattern.includes('/') ? pattern : `**/${pattern}`, {
    cwd,
    withFileTypes: true,
    exclude: skipped,
  })) {
    if (!entry.isFile()) continue;
    const within = relative(cwd, entry.parentPath);
    if (within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) continue;
    if (within.split(sep).some((segment) => FALLBACK_SKIP_DIRS.includes(segment))) continue;
    files.push(join(entry.parentPath, entry.name));
    if (files.length >= limit) break;
  }
  return files;
}

function listingResult(files: string[]): ToolResult {
  if (files.length === 0) return { content: 'No files matched.' };
  const listed = files.join('\n') + (files.length >= LIST_LIMIT ? `\n(truncated at ${LIST_LIMIT} paths)` : '');
  return {
    content: clipToolOutput(
      listed,
      `Narrow the glob or cwd; ${files.length} path(s) matched. This listing may be incomplete.`,
    ),
  };
}

export const listFilesTool: ToolDefinition = {
  name: 'list_files',
  description: 'List files matching a glob pattern inside granted filesystem roots (default: Home23 install + instance). Returns file paths. Defaults to your workspace.',
  input_schema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern (e.g., "src/**/*.ts", "*.json")' },
      cwd: { type: 'string', description: 'Base directory (default: your workspace)' },
    },
    required: ['pattern'],
  },
  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const pattern = input.pattern as string;
    const cwd = (input.cwd as string) || ctx.workspacePath;
    const outside = refuseReadOutsideRoots(cwd, authorityFor(ctx));
    if (outside) return outside;
    const rg = resolveRipgrep();
    if (!rg) {
      try {
        return listingResult(await listFilesWithGlob(pattern, cwd, LIST_LIMIT));
      } catch (err) {
        return { content: `list_files failed: ${err instanceof Error ? err.message : String(err)}`, is_error: true };
      }
    }
    // rg --files supports ** recursive globs (find -path does not). rg matches
    // a glob containing '/' against paths relative to its working directory,
    // not a root argument, so run it inside cwd and make the results absolute.
    const cmd = `${shellQuote(rg)} --files --glob ${shellQuote(pattern)} 2>/dev/null | head -${LIST_LIMIT}`;
    return new Promise((resolvePromise) => {
      exec(cmd, {
        cwd,
        timeout: 15_000,
        maxBuffer: 1024 * 512,
        env: unprivilegedChildEnv(),
      }, (_error, stdout) => {
        resolvePromise(listingResult(stdout.trim().split('\n').filter(Boolean).map((file) => join(cwd, file))));
      });
    });
  },
};

export const searchFilesTool: ToolDefinition = {
  name: 'search_files',
  description: 'Search file contents using ripgrep or grep inside granted filesystem roots (default: Home23 install + instance). Returns matching lines with paths and line numbers. Defaults to your workspace.',
  input_schema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regex pattern to search for' },
      path: { type: 'string', description: 'Directory or file to search (default: your workspace)' },
      glob: { type: 'string', description: 'File glob filter (e.g., "*.ts")' },
      max_results: { type: 'number', description: 'Max matching lines (default: 50)' },
    },
    required: ['pattern'],
  },
  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const pattern = input.pattern as string;
    const searchPath = (input.path as string) || ctx.workspacePath;
    const outside = refuseReadOutsideRoots(searchPath, authorityFor(ctx));
    if (outside) return outside;
    const fileGlob = input.glob as string | undefined;
    const maxResults = Math.max(1, Math.min(500, Number(input.max_results) || 50));

    // Choose the tool up front. A pipeline's status is `head`'s, so the old
    // `{ rg … | head; } || { grep …; }` never fell back when rg was missing
    // from PATH (as under the Host) and every search came back "No matches".
    //
    // We also intentionally DO NOT swallow stderr — if the search fails (bad
    // regex, permission issues) we surface the message so the agent can correct
    // itself instead of retrying variants of the same broken search.
    const cmd = buildSearchCommand(resolveRipgrep(), pattern, searchPath, fileGlob, maxResults);

    return new Promise((resolvePromise) => {
      exec(cmd, {
        maxBuffer: 1024 * 1024,
        timeout: 30_000,
        shell: '/bin/bash',
        env: unprivilegedChildEnv(),
      }, (error, stdout, stderr) => {
        const execError = error as (Error & { code?: string | number; killed?: boolean; signal?: string }) | null;

        // exec returns an error when the command times out or the shell
        // exits non-zero. For our pipeline a non-zero exit usually just
        // means "no matches". Distinguish real failures (timeout, spawn
        // errors, ENOBUFS) from grep's "no matches" (exit 1 with empty
        // stdout) so we can surface the former.
        if (execError && !('code' in execError && typeof execError.code === 'number')) {
          const errMsg = String(execError.code || execError.message || 'unknown');
          resolvePromise({
            content: `search_files failed: ${errMsg}${stderr ? `\n\nSTDERR:\n${stderr.slice(0, 800)}` : ''}`,
            is_error: true,
          });
          return;
        }

        const out = stdout.trim();
        if (!out) {
          const tail = stderr.trim();
          resolvePromise({
            content: tail
              ? `No matches found. (stderr: ${tail.slice(0, 400)})`
              : 'No matches found.',
          });
          return;
        }
        resolvePromise({
          content: clipToolOutput(
            out,
            `Raise max_results or narrow glob/path. Showing a clipped page of matches, not the full set.`,
          ),
        });
      });
    });
  },
};
