import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { mkdtemp, mkdir, writeFile, appendFile, rm, symlink, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ConsoleCatalog, consoleHistoryPath } from '../../../src/coordination/console/catalog.js';
import { consoleSourceId } from '../../../src/coordination/console/cursor.js';
import type { ConsoleRoot } from '../../../src/coordination/console/types.js';
import { ConsoleService } from '../../../src/coordination/console/service.js';
import { createCoordinationApplication, disabledCoordinationFeatureFlags } from '../../../src/coordination/app/application.js';
import { createCoordinationHttpServer } from '../../../src/coordination/http/index.js';

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(p => rm(p, { recursive: true, force: true }))); });

async function fixture(id = 'resident:test'): Promise<ConsoleRoot> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'console-catalog-')); temporary.push(dir);
  const root: ConsoleRoot = { id, actor: { id: 'actor', name: 'Actor' }, jobsDir: path.join(dir, 'jobs'), workDir: path.join(dir, 'work'), historyDir: path.join(dir, 'history'), historyNamespace: id, executionOutputDir: path.join(dir, 'execution-output') };
  await Promise.all([root.jobsDir, root.workDir, root.historyDir, root.executionOutputDir!].map(p => mkdir(p)));
  return root;
}
async function work(root: ConsoleRoot, id: string, resultHandle: unknown, fields: Record<string, unknown> = {}) {
  const data = { schema: 'home23.async-work.v1', workId: id, kind: 'subagent', label: id, status: 'running', startedAt: '2026-09-19T12:00:00Z', originChatId: 'parent', resultHandle, ...fields };
  await writeFile(path.join(root.workDir, `${id}.json`), JSON.stringify(data));
}
function turn(id: string, chat: string, fields: Record<string, unknown> = {}) {
  return JSON.stringify({ type: 'turn', turn_id: id, chat_id: chat, status: 'pending', started_at: '2026-09-19T12:00:00Z', ...fields }) + '\n';
}

test('resident/helper jobs exist before Work linkage and missing output preserves successful history', async () => {
  const resident = await fixture(), helper = await fixture('helper:bot');
  for (const root of [resident, helper]) {
    await mkdir(path.join(root.jobsDir, 'cj_new'));
    await writeFile(path.join(root.jobsDir, 'cj_new', 'job.json'), JSON.stringify({ schema: 'home23.coding-job.v1', id: 'cj_new', backend: 'codex', status: 'running', startedAt: '2026-09-19T12:01:00Z' }));
    await writeFile(path.join(root.jobsDir, 'cj_new', 'events.jsonl'), '{"type":"item.started"}\n');
  }
  await work(resident, 'aw_old', { type: 'coding_job', jobId: 'cj_old' }, { kind: 'coding', status: 'completed', finishedAt: '2026-09-19T12:01:00Z', parentWorkId: 'wrk_root' });
  const catalog = new ConsoleCatalog([resident, helper]);
  const page = await catalog.list(); assert.equal(page.sources.length, 3);
  const fresh = page.sources.filter(s => s.executionId === 'cj_new');
  assert.equal(new Set(fresh.map(s => s.id)).size, 2); assert.ok(fresh.every(s => s.harnessWorkId === null));
  const old = page.sources.find(s => s.harnessWorkId === 'aw_old')!;
  assert.equal(old.state, 'completed'); assert.equal(old.output.availability, 'unavailable'); assert.equal(old.workId, 'wrk_root');
  assert.equal((await catalog.list({ state: 'active' })).sources.length, 2);
});

test('shared chat is never bound by recency; durable provenance binds exact turns and immediate parentage', async () => {
  const root = await fixture();
  await work(root, 'aw_parent', { type: 'subagent_chat', chatId: 'shared', turnId: 't_parent' });
  await work(root, 'aw_child', { type: 'subagent_chat', chatId: 'shared' });
  await work(root, 'aw_ambiguous', { type: 'subagent_chat', chatId: 'shared' });
  const file = consoleHistoryPath(root, 'shared');
  await writeFile(file, turn('t_parent', 'shared', { delegation_origin: { harnessWorkId: 'aw_parent', parentChatId: 'origin' } })
    + turn('t_child', 'shared', { delegation_origin: { harnessWorkId: 'aw_child', parentChatId: 'shared', parentTurnId: 't_parent' } }));
  const catalog = new ConsoleCatalog([root], { cacheMs: 0 });
  const page = await catalog.list();
  const parent = page.sources.find(s => s.harnessWorkId === 'aw_parent')!, child = page.sources.find(s => s.harnessWorkId === 'aw_child')!, ambiguous = page.sources.find(s => s.harnessWorkId === 'aw_ambiguous')!;
  assert.equal(child.executionId, 't_child'); assert.equal(child.parentSourceId, parent.id);
  assert.equal(ambiguous.executionId, null); assert.equal(ambiguous.output.reason, 'ambiguous_identity'); assert.ok(ambiguous.actions.every(a => !a.available));
  const stable = child.id;
  await work(root, 'aw_child', { type: 'subagent_chat', chatId: 'shared', turnId: 't_child' });
  assert.equal((await catalog.resolve(stable))!.source.executionId, 't_child');
  assert.equal((await catalog.resolve(stable))!.streams[0]!.turnId, 't_child');
});

test('shared journal liveness and reads do not fabricate latest output times; capture gaps remain separate from success', async () => {
  const root = await fixture();
  await work(root, 'aw_child', { type: 'subagent_chat', chatId: 'shared', turnId: 't_child' });
  const journal = consoleHistoryPath(root, 'shared');
  await writeFile(journal, turn('t_child', 'shared') + JSON.stringify({ type: 'event', turn_id: 't_child', seq: 1, ts: '2026-09-19T12:00:01Z', kind: 'tool_start', data: {} }) + '\n');
  const catalog = new ConsoleCatalog([root], { cacheMs: 0 });
  const id = consoleSourceId(root.id, 'subagent', 'aw_child');
  assert.equal((await catalog.resolve(id))!.source.lastOutputAt, '2026-09-19T12:00:01Z');
  await appendFile(journal, JSON.stringify({ type: 'event', turn_id: 't_child', seq: 2, ts: '2026-09-19T12:15:00Z', kind: 'status', data: { status: 'provider_active' } }) + '\n'
    + turn('t_other', 'shared') + turn('t_child', 'shared', { status: 'complete', ended_at: '2026-09-19T12:16:00Z', execution_output_capture: 'incomplete' }));
  await writeFile(path.join(root.executionOutputDir!, 't_child.jsonl'), JSON.stringify({ type: 'event', turn_id: 't_child', seq: 1, ts: '2026-09-19T12:00:01Z', kind: 'capture_start', data: {} }) + '\n');
  const source = (await catalog.resolve(id))!;
  assert.equal(source.source.lastOutputAt, '2026-09-19T12:00:01Z'); assert.equal(source.source.state, 'completed');
  assert.equal(source.source.output.reason, 'capture_incomplete'); assert.equal(source.source.output.historyCompleteness, 'partial');
  assert.equal(source.streams.find(s => s.id === 'execution-output')!.captureIncomplete, true);
});

test('configured namespaces are used, source reads create no directories and reject symlink escapes', async () => {
  const root = await fixture('helper:bot'); root.historyNamespace = 'bot-id';
  await work(root, 'aw_one', { type: 'subagent_chat', chatId: 'subagent:parent:abcd' });
  await writeFile(consoleHistoryPath(root, 'subagent:parent:abcd'), turn('t_one', 'subagent:parent:abcd'));
  const outside = path.join(path.dirname(root.jobsDir), 'outside'); await mkdir(outside);
  await writeFile(path.join(outside, 'job.json'), JSON.stringify({ schema: 'home23.coding-job.v1', id: 'cj_escape', backend: 'codex' }));
  await symlink(outside, path.join(root.jobsDir, 'cj_escape'));
  const missingRoot = { ...root, id: 'missing', jobsDir: path.join(root.jobsDir, 'missing-jobs'), workDir: path.join(root.workDir, 'missing-work') };
  const before = await readdir(root.jobsDir);
  const catalog = new ConsoleCatalog([root, missingRoot]);
  const page = await catalog.list(); assert.equal(page.sources.length, 1); assert.equal(page.sources[0]!.executionId, 't_one');
  assert.ok(page.notices.some(n => n.runtimeId === 'missing' && n.reason === 'storage_not_created'));
  assert.deepEqual(await readdir(root.jobsDir), before);
  await assert.rejects(catalog.resolve('../../etc/passwd'), /invalid_source/);
});

test('journal discovery work is bounded across the whole catalog and advances on subsequent refreshes', async () => {
  const root = await fixture();
  for (let i = 0; i < 4; i++) {
    await work(root, `aw_${i}`, { type: 'subagent_chat', chatId: `subagent:origin:${i}abc` });
    await writeFile(consoleHistoryPath(root, `subagent:origin:${i}abc`), turn(`t_${i}`, `subagent:origin:${i}abc`));
  }
  const catalog = new ConsoleCatalog([root], { cacheMs: 0, journalScanBytes: 160 });
  const concurrent = await Promise.all(Array.from({ length: 8 }, () => catalog.list()));
  const first = concurrent[0]!;
  assert.ok(concurrent.every(page => JSON.stringify(page) === JSON.stringify(first)));
  assert.ok(first.sources.filter(s => s.executionId !== null).length <= 1);
  let latest = first;
  for (let i = 0; i < 8; i++) latest = await catalog.list();
  assert.equal(latest.sources.filter(s => s.executionId !== null).length, 4);
});

test('terminal selected streams end incomplete after caught-up output when crash leaves capture and journal tails open', async t => {
  const root = await fixture();
  const ids: string[] = [];
  for (const suffix of ['orphaned', 'partial']) {
    const turnId = `t_${suffix}`, chatId = `subagent:parent:${suffix}`, workId = `aw_${suffix}`;
    await work(root, workId, { type: 'subagent_chat', chatId, turnId }, { status: 'interrupted', finishedAt: '2026-09-19T12:01:00Z' });
    const terminal = turn(turnId, chatId, { status: 'orphaned', ended_at: '2026-09-19T12:01:00Z' });
    // One journal has a durable terminal envelope; the other lost its trailing delimiter in the crash.
    await writeFile(consoleHistoryPath(root, chatId), turn(turnId, chatId) + (suffix === 'partial' ? terminal.slice(0, -1) : terminal));
    const event = (kind: string, data: unknown) => JSON.stringify({ type: 'event', turn_id: turnId, seq: 1, ts: '2026-09-19T12:00:01Z', kind, data }) + '\n';
    await writeFile(path.join(root.executionOutputDir!, `${turnId}.jsonl`), event('capture_start', {})
      + event('tool_output', { text: `${suffix} retained output`, channel: 'stdout', encoding: 'utf8' })
      + '{"type":"event","turn_id":"' + turnId + '","kind":"tool_output","data":');
    ids.push(consoleSourceId(root.id, 'subagent', workId));
  }
  // Small scan budget ensures backlog is distinguished from a caught-up, unterminated tail.
  const catalog = new ConsoleCatalog([root], { cacheMs: 0, journalScanBytes: 320 });
  const first = (await catalog.resolve(ids[0]!))!;
  assert.equal(first.streams.find(stream => stream.id === 'execution-output')?.closureUnknown, false);
  const service = new ConsoleService({ catalog, pollMs: 10 });
  const application = createCoordinationApplication({ flags: { ...disabledCoordinationFeatureFlags(), 'coordination.process.enabled': true, 'coordination.public_api.enabled': true }, services: {
    console: service,
    auth: { validateAccessToken: async () => ({ principalId: 'user_owner', deviceId: 'dev_00000000-0000-7000-8000-000000000001', sessionId: 'ses_00000000-0000-7000-8000-000000000001', scopes: ['product:read'] }) },
  } });
  const server = createCoordinationHttpServer({ application, port: 0 });
  t.after(() => server.drain());
  const { origin } = await server.start();
  const response = await fetch(`${origin}/api/v1/console/stream?${ids.map(id => `sourceId=${id}`).join('&')}`, { headers: { authorization: 'Bearer test-token' }, signal: AbortSignal.timeout(3000) });
  assert.equal(response.status, 200);
  const body = await response.text();
  const frames = body.split('\n\n').flatMap(frame => {
    const event = /^event: (.+)$/m.exec(frame)?.[1], data = /^data: (.+)$/m.exec(frame)?.[1];
    return event && data ? [{ event, data: JSON.parse(data) }] : [];
  });
  assert.deepEqual(frames.filter(frame => frame.event === 'end').map(frame => frame.data).sort((a, b) => a.sourceId.localeCompare(b.sourceId)), ids.map(sourceId => ({ sourceId, status: 'incomplete' })).sort((a, b) => a.sourceId.localeCompare(b.sourceId)));
  assert.equal(frames.filter(frame => frame.event === 'record' && frame.data.record.kind === 'tool_output').length, 2);
  assert.ok(frames.some(frame => frame.event === 'gap' && frame.data.reason === 'writer_closure_unknown'));
  for (const id of ids) assert.equal((await catalog.resolve(id))!.streams.find(stream => stream.id === 'execution-output')!.closureUnknown, true);
});
