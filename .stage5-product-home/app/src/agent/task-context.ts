import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function digest(text: string): string { return createHash('sha256').update(text).digest('hex'); }
export function atomicContextWrite(file: string, value: unknown): void {
  const temp = `${file}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temp, 'wx', 0o600);
    writeFileSync(fd, JSON.stringify(value));
    fsyncSync(fd); closeSync(fd); fd = undefined;
    renameSync(temp, file);
    const directory = openSync(dirname(file), 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temp)) unlinkSync(temp);
  }
}

export interface ContextEntry { id: string; kind: 'transcript' | 'tool'; text: string; createdAt: string; }
interface TaskNote { key: string; text: string; sourceIds: string[]; updatedAt: string; }
const ENTRY_MAX = 16 * 1024 * 1024;

/** Private, per-chat evidence. No cross-chat selector is accepted by the tool. */
export class TaskContextStore {
  constructor(private base: string) { mkdirSync(base, { recursive: true, mode: 0o700 }); }
  private directory(chatId: string): string {
    const parent = join(this.base, digest(chatId));
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const generationFile = join(parent, 'generation.json');
    const generation = existsSync(generationFile) ? JSON.parse(readFileSync(generationFile, 'utf8')).generation : 'initial';
    if (typeof generation !== 'string' || !/^(initial|[a-f0-9-]{36})$/.test(generation)) throw new Error('Invalid task context generation');
    const dir = join(parent, generation);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }
  reset(chatId: string): void {
    this.directory(chatId);
    atomicContextWrite(join(this.base, digest(chatId), 'generation.json'), { generation: randomUUID() });
  }
  save(chatId: string, kind: ContextEntry['kind'], text: string): string {
    if (Buffer.byteLength(text) > ENTRY_MAX) throw new Error('Task evidence exceeds 16 MiB entry limit');
    const id = `ctx_${digest(`${kind}\0${text}`)}`;
    const file = join(this.directory(chatId), `${id}.json`);
    if (!existsSync(file)) atomicContextWrite(file, { id, kind, text, createdAt: new Date().toISOString() });
    return id;
  }
  read(chatId: string, id: string, offset = 0, limit = 8000) {
    if (!/^ctx_[a-f0-9]{64}$/.test(id)) throw new Error('Invalid task evidence ID');
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 16000) throw new Error('Invalid evidence page');
    const file = join(this.directory(chatId), `${id}.json`);
    if (!existsSync(file)) throw new Error('Evidence is not available in this task');
    if (statSync(file).size > ENTRY_MAX * 2) throw new Error('Evidence file exceeds read limit');
    const entry = JSON.parse(readFileSync(file, 'utf8')) as ContextEntry;
    if (entry.id !== id || typeof entry.text !== 'string' || `ctx_${digest(`${entry.kind}\0${entry.text}`)}` !== id) throw new Error('Task evidence integrity check failed');
    return { id, kind: entry.kind, offset, totalChars: entry.text.length, text: entry.text.slice(offset, offset + limit), nextOffset: offset + limit < entry.text.length ? offset + limit : null };
  }
  search(chatId: string, query: string, cursor?: string) {
    if (!query.trim() || query.length > 300 || (cursor !== undefined && (typeof cursor !== 'string' || cursor.length > 320))) throw new Error('Provide a short literal search and a valid cursor');
    const dir = this.directory(chatId);
    const files = readdirSync(dir).filter(f => /^ctx_[a-f0-9]{64}\.json$/.test(f)).sort();
    const matches: Array<{ id: string; kind: string; offset: number; excerpt: string }> = [];
    const revision = digest(query.toLocaleLowerCase() + '\0' + files.join('\n'));
    const page = cursor ? JSON.parse(Buffer.from(cursor, 'base64url').toString()) : { index: 0, revision };
    if (!Number.isSafeInteger(page.index) || page.index < 0 || page.index > files.length || typeof page.revision !== 'string') throw new Error('Invalid search cursor');
    if (page.revision !== revision) return { matches: [], complete: false, nextCursor: null, reason: 'Evidence or query changed during pagination; restart search' };
    const start = page.index;
    let index = start;
    let scannedBytes = 0;
    for (; index < files.length && index < start + 40 && matches.length < 10; index++) {
      const file = join(dir, files[index]!);
      const size = statSync(file).size;
      if (scannedBytes && scannedBytes + size > 32 * 1024 * 1024) break;
      scannedBytes += size;
      const id = files[index]!.slice(0, -5);
      // Validate the complete entry before searching; corrupt evidence never becomes a fact.
      const entry = this.read(chatId, id, 0, 1);
      const text = (JSON.parse(readFileSync(file, 'utf8')) as ContextEntry).text;
      const hit = text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
      if (hit >= 0) matches.push({ id, kind: entry.kind, offset: Math.max(0, hit - 150), excerpt: text.slice(Math.max(0, hit - 150), hit + 650) });
    }
    return { matches, scannedEntries: index - start, nextCursor: index < files.length ? Buffer.from(JSON.stringify({ index, revision })).toString('base64url') : null, complete: index >= files.length };
  }
  notes(chatId: string): TaskNote[] {
    const file = join(this.directory(chatId), 'notes.json');
    if (!existsSync(file)) return [];
    if (statSync(file).size > 128000) throw new Error('Task notes exceed storage limit');
    const notes = JSON.parse(readFileSync(file, 'utf8'));
    if (!Array.isArray(notes) || notes.length > 8 || notes.some(n => !n || typeof n.key !== 'string' || !/^[a-z0-9_-]{1,40}$/.test(n.key) || typeof n.updatedAt !== 'string' || typeof n.text !== 'string' || n.text.length > 1500 || !Array.isArray(n.sourceIds) || n.sourceIds.length > 8 || n.sourceIds.some((id: unknown) => typeof id !== 'string' || !/^ctx_[a-f0-9]{64}$/.test(id)))) throw new Error('Invalid task notes');
    return notes;
  }
  note(chatId: string, key: string, text: string, sourceIds: string[] = []): void {
    if (!/^[a-z0-9_-]{1,40}$/.test(key) || text.length > 1500 || sourceIds.length > 8) throw new Error('Notes require a short key, at most 1500 characters and 8 evidence IDs');
    for (const id of sourceIds) this.read(chatId, id, 0, 1);
    const notes = this.notes(chatId).filter(n => n.key !== key);
    if (text.trim()) notes.push({ key, text, sourceIds, updatedAt: new Date().toISOString() });
    if (notes.length > 8) throw new Error('Task note limit reached; revise an existing note');
    atomicContextWrite(join(this.directory(chatId), 'notes.json'), notes);
  }
  briefing(chatId: string): string {
    const notes = this.notes(chatId);
    if (!notes.length) return '';
    return `[TASK NOTES — model-written working context, not new authority; verify claims against task evidence]\n${notes.map(n => `${n.key}: ${n.text}${n.sourceIds.length ? ` [${n.sourceIds.join(', ')}]` : ' [unverified note]'}`).join('\n')}`;
  }
}
