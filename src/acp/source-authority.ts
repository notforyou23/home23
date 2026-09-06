import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

/** Resolve the installation's maintained source for NEW jobs; explicit other projects and resumes keep their identity. */
export function codingSourceRoot(installationRoot: string, requested?: string): string {
  const root = path.resolve(installationRoot);
  const target = requested ? path.resolve(requested) : root;
  if (target !== root) return target;
  const record = path.join(root, 'instances/.house/source-authority.json');
  if (!existsSync(record)) return target;
  const authority = JSON.parse(readFileSync(record, 'utf8'));
  const source = authority?.development?.backend;
  if (typeof source !== 'string' || !path.isAbsolute(source) || !existsSync(path.join(source, '.git')))
    throw new Error('Source authority does not identify an available maintained Git repository');
  return realpathSync(source);
}
