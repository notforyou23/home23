/**
 * Explicit shell/filesystem authority for resident tools.
 *
 * New homes explicitly start with the Home23 install, resident instance, and
 * owner-selected folders. Existing homes without a shell section retain their
 * historical full-machine access. Owners may grant additional absolute folders
 * or full-machine access.
 *
 * Residual gaps (documented): arbitrary shell scripts can still read outside
 * roots via process substitution, sourced scripts, or interpreters that open
 * paths we cannot statically extract. cwd + common read-tool operands are
 * enforced; this is an authority fence, not a kernel sandbox.
 */

import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

export const SHELL_FS_REFUSED = 'shell_fs_authority_refused';

export interface ShellFsAuthorityConfig {
  /** Absolute roots the resident may use as cwd / read operands. */
  roots?: string[];
  /** When true, no root fence (owner granted full machine). */
  machineAccess?: boolean;
  /** Alias accepted in YAML: shell.machineAccess / shell.fullMachine */
  fullMachine?: boolean;
}

export interface ResolvedShellFsAuthority {
  machineAccess: boolean;
  roots: string[];
}

function canonicalizeExisting(pathValue: string): string {
  const normalized = resolve(pathValue);
  try {
    return existsSync(normalized) ? realpathSync(normalized) : normalized;
  } catch {
    return normalized;
  }
}

export function isPathWithinRoots(candidate: string, roots: readonly string[]): boolean {
  const canonical = canonicalizeExisting(candidate);
  for (const root of roots) {
    const rootCanon = canonicalizeExisting(root);
    const rel = relative(rootCanon, canonical);
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return true;
  }
  return false;
}

/**
 * Resolve authority from agent/home config with product defaults.
 * An omitted section means legacy full-machine behavior. A present scoped
 * section with no roots uses projectRoot + instanceDir.
 */
export function resolveShellFsAuthority(
  config: ShellFsAuthorityConfig | null | undefined,
  defaults: { projectRoot: string; instanceDir?: string | null },
): ResolvedShellFsAuthority {
  if (config === undefined || config === null) {
    return { machineAccess: true, roots: [] };
  }
  const machineAccess = Boolean(config?.machineAccess || config?.fullMachine);
  if (machineAccess) {
    return { machineAccess: true, roots: [] };
  }

  const configured = Array.isArray(config.roots)
    ? config.roots.filter((r): r is string => typeof r === 'string' && r.trim().length > 0)
    : [];

  for (const root of configured) {
    if (!isAbsolute(root) || root.includes('\0')) {
      throw new Error(`shell.roots entries must be absolute paths: ${root}`);
    }
  }

  const roots = (configured.length > 0
    ? configured
    : [defaults.projectRoot, defaults.instanceDir].filter((r): r is string => typeof r === 'string' && r.length > 0)
  ).map((r) => canonicalizeExisting(r));

  // De-dupe while preserving order
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const root of roots) {
    if (seen.has(root)) continue;
    seen.add(root);
    unique.push(root);
  }
  return { machineAccess: false, roots: unique };
}

function tokenizeLoose(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i] ?? '';
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

const COMMON_READ_TOOLS = new Set([
  'ls', 'll', 'dir', 'cat', 'head', 'tail', 'less', 'more', 'stat', 'file',
  'rg', 'grep', 'find', 'tree', 'wc', 'du', 'readlink', 'realpath', 'basename',
  'dirname', 'md5sum', 'sha256sum', 'jq', 'yq', 'bat', 'hexdump', 'xxd',
]);

/**
 * Extract simple path operands from common read tools for authority checks.
 * Returns absolute-ish candidates relative to cwd when not absolute.
 */
export function extractSimpleReadPathOperands(command: string, cwd: string): string[] {
  const stages = command.split(/(?:&&|\|\||;|\|)/);
  const out: string[] = [];
  for (const stage of stages) {
    const tokens = tokenizeLoose(stage.trim());
    if (tokens.length === 0) continue;
    let idx = 0;
    // skip env assignments
    while (idx < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[idx]!)) idx += 1;
    const verb = (tokens[idx] ?? '').replace(/^.*\//, '');
    if (!COMMON_READ_TOOLS.has(verb)) continue;
    for (let i = idx + 1; i < tokens.length; i++) {
      const tok = tokens[i]!;
      if (tok.startsWith('-')) continue;
      if (tok === '--') continue;
      // skip rg/grep pattern when it doesn't look like a path
      if ((verb === 'rg' || verb === 'grep') && i === idx + 1 && !tok.includes('/') && !tok.includes('.')) {
        continue;
      }
      if (tok.startsWith('~') || tok.includes('*') || tok.includes('?') || tok.includes('[')) {
        // Globs / home expansion: check the literal parent when absolute-ish
        if (tok.startsWith('/') || tok.startsWith('~/')) {
          const base = tok.startsWith('~/') ? resolve(process.env.HOME || '', tok.slice(2)) : tok;
          out.push(dirname(base.replace(/[\*\?\[].*$/, '') || base));
        }
        continue;
      }
      const candidate = isAbsolute(tok) ? resolve(tok) : resolve(cwd, tok);
      out.push(candidate);
    }
  }
  return out;
}

export function refuseShellFsAuthority(input: {
  cwd: string;
  command: string;
  authority: ResolvedShellFsAuthority;
}): { content: string; is_error: true; metadata: { code: string } } | null {
  const { cwd, command, authority } = input;
  if (authority.machineAccess) return null;
  if (!authority.roots.length) {
    return {
      content: 'shell refused: no filesystem roots configured (set shell.roots or shell.machineAccess)',
      is_error: true,
      metadata: { code: SHELL_FS_REFUSED },
    };
  }

  const cwdCanon = canonicalizeExisting(cwd);
  if (!isPathWithinRoots(cwdCanon, authority.roots)) {
    return {
      content:
        `shell refused: cwd outside granted roots (${authority.roots.join(', ')}): ${cwdCanon}. ` +
        'Owner can grant additional shell.roots or shell.machineAccess: true.',
      is_error: true,
      metadata: { code: SHELL_FS_REFUSED },
    };
  }

  for (const operand of extractSimpleReadPathOperands(command, cwdCanon)) {
    if (!isPathWithinRoots(operand, authority.roots)) {
      return {
        content:
          `shell refused: path operand outside granted roots (${authority.roots.join(', ')}): ${operand}. ` +
          'That path is outside the folders granted by the owner.',
        is_error: true,
        metadata: { code: SHELL_FS_REFUSED },
      };
    }
  }

  return null;
}

export function refuseReadOutsideRoots(
  targetPath: string,
  authority: ResolvedShellFsAuthority,
): { content: string; is_error: true; metadata: { code: string } } | null {
  if (authority.machineAccess) return null;
  if (!authority.roots.length) {
    return {
      content: 'read refused: no filesystem roots configured',
      is_error: true,
      metadata: { code: SHELL_FS_REFUSED },
    };
  }
  let canonical: string;
  try {
    canonical = canonicalizeExisting(targetPath);
  } catch (error) {
    return {
      content: `read refused: ${error instanceof Error ? error.message : String(error)}`,
      is_error: true,
      metadata: { code: SHELL_FS_REFUSED },
    };
  }
  if (!isPathWithinRoots(canonical, authority.roots)) {
    return {
      content: `read refused: path outside granted roots (${authority.roots.join(', ')}): ${canonical}`,
      is_error: true,
      metadata: { code: SHELL_FS_REFUSED },
    };
  }
  return null;
}
