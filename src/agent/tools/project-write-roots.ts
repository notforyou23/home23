import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, resolve, join } from 'node:path';
import { canonicalizeFilePath, isWithinFileRoot } from './restricted-files.js';

/** Compiled, absolute file-tool grants. Denials apply before every allow root. */
export interface ProjectWriteRoot {
  readonly path: string;
  readonly deny: readonly string[];
}

/** Invalid owner configuration is a startup error, never an implicit grant. */
export function compileProjectWriteRoots(files: unknown, instanceDir: string): readonly ProjectWriteRoot[] {
  const invalid = (reason: string): never => { throw new Error(`Invalid files.projectWriteRoots: ${reason}`); };
  if (files === undefined) return [];
  if (!files || typeof files !== 'object' || Array.isArray(files)) invalid('files must be an object');
  const configured = (files as { projectWriteRoots?: unknown }).projectWriteRoots;
  if (configured === undefined) return [];
  if (!Array.isArray(configured)) return invalid('must be an array');
  if (!configured.length) return [];
  const instance = realpathSync(instanceDir);
  const projects = join(instance, 'projects');
  const relativePath = (value: unknown): string => {
    if (typeof value !== 'string' || !value.trim() || /[\0\r\n]/u.test(value) || isAbsolute(value)) {
      return invalid('paths must be non-empty paths relative to the resident instance');
    }
    return resolve(instance, value);
  };
  return Object.freeze(configured.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) invalid('each root must be an object');
    const root = entry as { path?: unknown; deny?: unknown };
    const path = relativePath(root.path);
    if (!isWithinFileRoot(projects, path)) invalid(`root must be inside this resident's projects: ${path}`);
    try {
      if (realpathSync(path) !== path || !statSync(path).isDirectory()) {
        invalid(`root must be an existing directory without symlink components: ${path}`);
      }
    } catch (error) {
      invalid(error instanceof Error ? error.message : String(error));
    }
    if (root.deny !== undefined && !Array.isArray(root.deny)) invalid('deny must be an array');
    const deny = ((root.deny ?? []) as unknown[]).map(value => {
      const denied = relativePath(value);
      if (!isWithinFileRoot(path, denied)) invalid(`deny path must be inside its project root: ${denied}`);
      // Validate missing suffixes too; canonical targets are checked again at write time.
      canonicalizeFilePath(denied, true);
      return denied;
    });
    return Object.freeze({ path, deny: Object.freeze(deny) });
  }));
}

export function projectWriteRootsPrompt(roots: readonly ProjectWriteRoot[] | undefined): string {
  if (!roots?.length) return '';
  const deny = roots.flatMap(root => root.deny);
  return `File tools may also write these resident project roots using absolute paths: ${roots.map(root => root.path).join(', ')}; denied paths: ${deny.length ? deny.join(', ') : '(none)'}. Relative instances/... paths are refused; tracked source remains protected.`;
}
