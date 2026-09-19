import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { mkdtemp, mkdir, writeFile, appendFile, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConsoleCatalog } from '../../../src/coordination/console/catalog.js';
import { readConsoleAfter, readConsoleHistory, openConsoleRaw } from '../../../src/coordination/console/reader.js';
import { decodeConsoleCursor, encodeConsoleCursor } from '../../../src/coordination/console/cursor.js';
import type { ConsoleRoot, ResolvedConsoleSource } from '../../../src/coordination/console/types.js';

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(p => rm(p, { recursive: true, force: true }))); });

async function fixture(): Promise<{ dir: string; source: ResolvedConsoleSource; events: string; stderr: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'console-reader-')); temporary.push(dir);
  const root: ConsoleRoot = { id: 'resident:test', actor: { id: 'test', name: 'Test' }, jobsDir: path.join(dir, 'jobs'), workDir: path.join(dir, 'work'), historyDir: path.join(dir, 'history'), historyNamespace: 'test' };
  const jobDir = path.join(root.jobsDir, 'cj_test');
  await mkdir(jobDir, { recursive: true }); await mkdir(root.workDir); await mkdir(root.historyDir);
  await writeFile(path.join(jobDir, 'job.json'), JSON.stringify({ schema: 'home23.coding-job.v1', id: 'cj_test', backend: 'codex', status: 'running', startedAt: '2026-09-19T12:00:00Z' }));
  const events = path.join(jobDir, 'events.jsonl'), stderr = path.join(jobDir, 'stderr.log');
  await writeFile(events, ''); await writeFile(stderr, '');
  const catalog = new ConsoleCatalog([root]);
  const page = await catalog.list();
  return { dir, events, stderr, source: (await catalog.resolve(page.sources[0]!.id))! };
}

async function rawBody(source: ResolvedConsoleSource, id: string): Promise<Buffer> {
  const raw = await openConsoleRaw(source, id); const chunks: Buffer[] = [];
  for await (const chunk of raw.stream) chunks.push(Buffer.from(chunk));
  const body = Buffer.concat(chunks); assert.equal(body.length, raw.byteLength); return body;
}

test('append/reconnect preserves split UTF-8, incomplete lines, stderr and stable IDs', async () => {
  const { source, events, stderr } = await fixture();
  const first = '{"type":"item.started","text":"α🦊"}';
  const encoded = Buffer.from(first + '\n');
  await appendFile(events, encoded.subarray(0, encoded.length - 4));
  const waiting = await readConsoleAfter(source);
  assert.deepEqual(waiting.records, []); assert.equal(waiting.drained, false);
  await appendFile(events, encoded.subarray(encoded.length - 4));
  await appendFile(stderr, 'working');
  const appended = await readConsoleAfter(source, waiting.cursor);
  assert.equal(appended.records.length, 1); assert.equal(appended.records[0]!.raw, first);
  const replay = await readConsoleAfter(source, waiting.cursor);
  assert.equal(replay.records[0]!.id, appended.records[0]!.id);
  assert.deepEqual((await readConsoleAfter(source, appended.cursor)).records, []);
  for (const stream of source.streams) stream.writerClosed = true;
  const end = await readConsoleAfter(source, appended.cursor);
  assert.equal(end.records[0]!.raw, 'working'); assert.equal(end.records[0]!.partial, true); assert.equal(end.drained, true);
});

test('history is paginated and captures a resume boundary before a concurrent append', async () => {
  const { source, events } = await fixture();
  const lines = Array.from({ length: 9 }, (_, index) => JSON.stringify({ type: 'message', text: `line ${index}` }));
  await writeFile(events, lines.join('\n') + '\n');
  const page = await readConsoleHistory(source, { limit: 3 });
  assert.deepEqual(page.records.map(r => r.raw), lines.slice(6)); assert.equal(page.hasMore, true);
  await appendFile(events, '{"type":"message","text":"new"}\n');
  const live = await readConsoleAfter(source, page.resumeCursor);
  assert.deepEqual(live.records.map(r => JSON.parse(r.raw!).text), ['new']);
  const older = await readConsoleHistory(source, { limit: 3, before: page.beforeCursor! });
  assert.deepEqual(older.records.map(r => r.raw), lines.slice(3, 6));
  const oldest = await readConsoleHistory(source, { limit: 3, before: older.beforeCursor! });
  assert.deepEqual(oldest.records.map(r => r.raw), lines.slice(0, 3));
});

test('large escaped records, binary bytes and records crossing scan windows use exact raw bodies', async () => {
  const { source, events } = await fixture();
  const large = JSON.stringify({ type: 'item.completed', output: '\\"'.repeat(45000) });
  await writeFile(events, large + '\n');
  let cursor: string | undefined;
  let record;
  for (let i = 0; i < 40 && !record; i++) {
    const page = await readConsoleAfter(source, cursor, { maxScanBytes: 8192 }); cursor = page.cursor;
    record = page.records[0];
  }
  assert.ok(record); assert.equal(record.raw, null); assert.ok(record.rawUrl);
  assert.ok(Buffer.byteLength(JSON.stringify(record)) < 48 * 1024);
  assert.equal((await rawBody(source, record.id)).toString(), large);
  const binary = Buffer.from([0xff, 0x00, 0x80]); await appendFile(events, Buffer.concat([binary, Buffer.from('\n')]));
  const bin = (await readConsoleAfter(source, cursor)).records[0]!;
  assert.equal(bin.rawEncoding, 'binary'); assert.equal(bin.raw, null); assert.deepEqual(await rawBody(source, bin.id), binary);
  let before: string | undefined, recovered: string[] = [];
  for (let i = 0; i < 40; i++) {
    const page = await readConsoleHistory(source, { before, maxScanBytes: 8192 });
    recovered.push(...page.records.map(r => r.id));
    if (!page.hasMore) break;
    before = page.beforeCursor!;
  }
  assert.ok(recovered.includes(record.id)); assert.ok(recovered.includes(bin.id));
});

test('exact-turn filters exclude stored prompts and raw handles cannot bypass that filter', async () => {
  const { source, dir } = await fixture();
  const file = path.join(dir, 'history', 'journal.jsonl');
  const lines = [
    JSON.stringify({ role: 'user', content: 'private prompt', turn_id: 't_child' }),
    JSON.stringify({ type: 'event', turn_id: 't_parent', seq: 1, ts: '2026-09-19T12:00:00Z', kind: 'tool_result', data: { text: 'parent private result' } }),
    JSON.stringify({ type: 'event', turn_id: 't_child', seq: 2, ts: '2026-09-19T12:00:01Z', kind: 'tool_result', data: { exactResult: 'child result' } }),
  ];
  await writeFile(file, lines.join('\n') + '\n');
  source.streams = [{ id: 'journal', path: file, allowedRoot: path.dirname(file), format: 'home23-turn', turnId: 't_child', writerClosed: true }];
  const page = await readConsoleAfter(source);
  assert.equal(page.records.length, 1); assert.equal(page.records[0]!.raw, lines[2]);
  const decoded = decodeConsoleCursor<unknown[]>(page.records[0]!.id.slice(3));
  decoded[3] = Buffer.byteLength(lines[0]! + '\n'); decoded[4] = Number(decoded[3]) + Buffer.byteLength(lines[1]!);
  await assert.rejects(openConsoleRaw(source, `cr_${encodeConsoleCursor(decoded)}`), /invalid_record/);
  decoded[3] = 0; decoded[4] = Buffer.byteLength(lines[0]!);
  await assert.rejects(openConsoleRaw(source, `cr_${encodeConsoleCursor(decoded)}`), /invalid_record/);
});

test('replacement invalidates raw handles and reports a resumable reset; incomplete capture ends honestly', async () => {
  const { source, events } = await fixture();
  await writeFile(events, '{"type":"old"}\n');
  const before = await readConsoleAfter(source);
  await rename(events, `${events}.old`); await writeFile(events, '{"type":"new"}\n');
  const after = await readConsoleAfter(source, before.cursor);
  assert.equal(after.gaps[0]!.reason, 'source_reset'); assert.equal(after.records[0]!.kind, 'new');
  await assert.rejects(openConsoleRaw(source, before.records[0]!.id), /record_gone/);
  await assert.rejects(readConsoleAfter(source, '%%%'), /invalid_cursor/);
  source.streams = [{ ...source.streams[0]!, captureIncomplete: true }];
  const ended = await readConsoleAfter(source, after.cursor);
  assert.equal(ended.drained, true); assert.ok(ended.gaps.some(g => g.reason === 'capture_incomplete'));
});

test('a busy events stream cannot starve stderr and forwarded records retain verified child identity', async () => {
  const { source, events, stderr } = await fixture();
  await writeFile(events, Array.from({ length: 10 }, () => '{"type":"busy"}\n').join(''));
  await writeFile(stderr, 'diagnostic\n');
  const first = await readConsoleAfter(source, undefined, { limit: 1 });
  await appendFile(events, '{"type":"still_busy"}\n');
  const second = await readConsoleAfter(source, first.cursor, { limit: 1 });
  assert.equal(second.records[0]!.stream, 'stderr'); assert.equal(second.records[0]!.raw, 'diagnostic');
  source.forwardedSources = { aw_child: 'cs_child' };
  await writeFile(events, JSON.stringify({ type: 'event', turn_id: 't_parent', seq: 1, kind: 'subagent_progress', data: { subagentId: 'aw_child', activity: { type: 'tool_start' } } }) + '\n');
  const mapped = await readConsoleAfter(source);
  assert.equal(mapped.records[0]!.forwardedFromSourceId, 'cs_child');
});
