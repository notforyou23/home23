import { existsSync, readFileSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { resolveBudget } from './identity-budget.js';

export function inspectIdentitySource(workspace: string, filename: string) {
  const file = join(workspace, filename);
  if (!existsSync(file)) return { filename, missing: true };
  const content = readFileSync(file, 'utf8');
  const { budget } = resolveBudget(filename);
  return { filename, characters: content.trim().length, target: budget,
    maintenanceNeeded: content.trim().length > budget,
    modifiedAt: statSync(file).mtime.toISOString(),
    sha256: createHash('sha256').update(content).digest('hex'),
    headings: [...content.matchAll(/^#{1,6} (.+)$/gm)].map(match => match[1]),
    loading: 'complete; target is advisory, not a truncation limit' };
}

/** Content-addressed original retained before an identity update; repeated versions are deduplicated. */
export function preserveIdentitySource(workspace: string, filename: string): string | null {
  const file = join(workspace, filename);
  if (!existsSync(file)) return null;
  const content = readFileSync(file);
  const digest = createHash('sha256').update(content).digest('hex');
  const folder = join(workspace, 'identity-history');
  mkdirSync(folder, { recursive: true });
  const archive = join(folder, digest + '.txt');
  if (!existsSync(archive)) writeFileSync(archive, content, { flag: 'wx', mode: 0o600 });
  return archive;
}
