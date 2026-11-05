/**
 * Durable per-record store for async work. One JSON file per record under
 * instances/<agent>/async-work/. Same durability idiom as src/acp/job-store.ts:
 * atomic tmp+rename writes, corrupt records skipped (with a warning) on list.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AsyncWorkRecord } from './types.js';

export class WorkStore {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  recordPath(workId: string): string {
    return join(this.dir, `${workId}.json`);
  }

  write(record: AsyncWorkRecord): void {
    const path = this.recordPath(record.workId);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(record, null, 2));
    try {
      renameSync(tmp, path);
    } catch (err) {
      try { unlinkSync(tmp); } catch { /* best effort */ }
      throw err;
    }
  }

  read(workId: string): AsyncWorkRecord | undefined {
    const path = this.recordPath(workId);
    if (!existsSync(path)) return undefined;
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as AsyncWorkRecord;
    } catch {
      console.warn(`[work] corrupt record skipped: ${path}`);
      return undefined;
    }
  }

  update(workId: string, patch: Partial<AsyncWorkRecord>): AsyncWorkRecord | undefined {
    const current = this.read(workId);
    if (!current) return undefined;
    const next: AsyncWorkRecord = { ...current, ...patch, updatedAt: new Date().toISOString() };
    this.write(next);
    return next;
  }

  /** All records, newest startedAt first. Corrupt files are skipped. */
  list(): AsyncWorkRecord[] {
    const out: AsyncWorkRecord[] = [];
    for (const name of readdirSync(this.dir)) {
      if (!name.startsWith('aw_') || !name.endsWith('.json')) continue;
      const rec = this.read(name.slice(0, -'.json'.length));
      if (rec) out.push(rec);
    }
    return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.workId.localeCompare(a.workId));
  }
}
