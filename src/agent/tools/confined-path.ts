import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import {
  lstat,
  open,
  realpath,
} from 'node:fs/promises';
import path from 'node:path';

export interface StableFileSnapshot {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
}

export interface StableFileRead {
  path: string;
  bytes: Buffer;
  sha256: string;
  snapshot: StableFileSnapshot;
}

function snapshot(stat: BigIntStats): StableFileSnapshot {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
  };
}

function snapshotsEqual(left: StableFileSnapshot, right: StableFileSnapshot): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs;
}

export async function readStableFileNoFollow(filePath: string): Promise<StableFileRead> {
  const beforePath = await lstat(filePath, { bigint: true });
  if (beforePath.isSymbolicLink()) throw new Error(`Refusing symlink file: ${filePath}`);
  if (!beforePath.isFile()) throw new Error(`Expected regular file: ${filePath}`);
  const handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = snapshot(await handle.stat({ bigint: true }));
    if (beforePath.dev !== before.dev || beforePath.ino !== before.ino) {
      throw new Error(`Stable-file identity changed before open: ${filePath}`);
    }
    const bytes = await handle.readFile();
    const after = snapshot(await handle.stat({ bigint: true }));
    if (!snapshotsEqual(before, after) || BigInt(bytes.byteLength) !== before.size) {
      throw new Error(`Stable-file drift while reading: ${filePath}`);
    }
    const afterPath = await lstat(filePath, { bigint: true });
    if (afterPath.isSymbolicLink()
      || afterPath.dev !== after.dev
      || afterPath.ino !== after.ino
      || afterPath.size !== after.size
      || afterPath.mtimeNs !== after.mtimeNs) {
      throw new Error(`Stable-file path drift after read: ${filePath}`);
    }
    return {
      path: filePath,
      bytes,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      snapshot: after,
    };
  } finally {
    await handle.close();
  }
}

function assertConfinedRelative(reference: string, label: string): string[] {
  if (typeof reference !== 'string' || reference.length === 0) {
    throw new Error(`${label} must be a non-empty relative path`);
  }
  if (path.isAbsolute(reference) || path.posix.isAbsolute(reference) || path.win32.isAbsolute(reference)) {
    throw new Error(`${label} must be relative`);
  }
  if (reference.includes('\\') || reference.includes('\0') || /^[a-z][a-z0-9+.-]*:/i.test(reference)) {
    throw new Error(`${label} must be a confined relative path`);
  }
  const parts = reference.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error(`${label} would escape its confined root`);
  }
  return parts;
}

async function assertNoSymlinkComponents(root: string, parts: readonly string[]): Promise<string> {
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) throw new Error(`Refusing symlink path component: ${current}`);
  }
  return current;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export interface ResolveConfinedPromptInput {
  workerRoot: string;
  promptRootAliases: Readonly<Record<string, string>>;
  promptRoots: readonly string[];
  path: string;
}

export interface ResolvedConfinedPrompt {
  path: string;
  relativePath: string;
  rootAlias: string;
  sha256: string;
  bytes: Buffer;
}

export async function resolveConfinedPromptStable(
  input: ResolveConfinedPromptInput,
): Promise<ResolvedConfinedPrompt> {
  if (input.promptRoots.length === 0) throw new Error('At least one prompt root alias is required');
  const workerRoot = await realpath(input.workerRoot);
  const referenceParts = assertConfinedRelative(input.path, 'Prompt path');
  const matches: ResolvedConfinedPrompt[] = [];

  for (const alias of input.promptRoots) {
    if (!Object.hasOwn(input.promptRootAliases, alias)) {
      throw new Error(`Unknown closed prompt root alias: ${alias}`);
    }
    const aliasValue = input.promptRootAliases[alias];
    if (typeof aliasValue !== 'string') throw new Error(`Invalid prompt root alias: ${alias}`);
    const aliasParts = assertConfinedRelative(aliasValue, `Prompt root alias ${alias}`);
    const rootCandidate = await assertNoSymlinkComponents(workerRoot, aliasParts);
    const promptRoot = await realpath(rootCandidate);
    if (!isWithin(workerRoot, promptRoot) || promptRoot === workerRoot) {
      throw new Error(`Prompt root alias ${alias} must resolve beneath and distinct from workerRoot`);
    }
    let candidate: string;
    try {
      candidate = await assertNoSymlinkComponents(promptRoot, referenceParts);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') continue;
      throw error;
    }
    const resolved = await realpath(candidate);
    if (!isWithin(promptRoot, resolved)) throw new Error(`Prompt path escapes root alias ${alias}`);
    const stable = await readStableFileNoFollow(resolved);
    matches.push({
      path: resolved,
      relativePath: input.path,
      rootAlias: alias,
      sha256: stable.sha256,
      bytes: stable.bytes,
    });
  }

  if (matches.length === 0) throw new Error(`Prompt file not found in configured prompt roots: ${input.path}`);
  if (matches.length > 1) throw new Error(`Prompt file is ambiguous across configured roots: ${input.path}`);
  return matches[0]!;
}

export interface ResolveDeclaredPathOptions {
  allowMissingLeaf?: boolean;
  rejectSymlinkComponents?: boolean;
  requireAbsolute?: boolean;
}

export async function resolveDeclaredPathSafely(
  declaredPath: string,
  options: ResolveDeclaredPathOptions = {},
): Promise<string> {
  if (typeof declaredPath !== 'string' || declaredPath.length === 0 || declaredPath.includes('\0')) {
    throw new Error('Declared path must be a non-empty path string');
  }
  if ((options.requireAbsolute ?? true) && !path.isAbsolute(declaredPath)) {
    throw new Error(`Declared path must be absolute: ${declaredPath}`);
  }
  const normalized = path.resolve(declaredPath);
  const volumeMatch = normalized.match(/^\/Volumes\/([^/]+)(?:\/|$)/);
  if (volumeMatch) {
    const volumeRoot = path.join('/Volumes', volumeMatch[1]!);
    try {
      const volumeStat = await lstat(volumeRoot);
      if (volumeStat.isSymbolicLink() || !volumeStat.isDirectory()) {
        throw new Error(`Declared volume is not a real directory: ${volumeRoot}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`Declared volume is unavailable: ${volumeRoot}`);
      }
      throw error;
    }
  }

  const parsed = path.parse(normalized);
  const parts = normalized.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]!;
    const next = path.join(current, part);
    try {
      const stat = await lstat(next);
      if ((options.rejectSymlinkComponents ?? true) && stat.isSymbolicLink()) {
        throw new Error(`Declared path contains a symlink component: ${next}`);
      }
      if (index < parts.length - 1 && !stat.isDirectory()) {
        throw new Error(`Declared path ancestor is not a directory: ${next}`);
      }
      current = next;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT'
        && options.allowMissingLeaf === true
        && index === parts.length - 1) {
        const parent = await realpath(current);
        return path.join(parent, part);
      }
      throw error;
    }
  }
  return realpath(current);
}
