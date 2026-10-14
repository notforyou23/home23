import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import Database from 'better-sqlite3';
import { runInNewContext } from 'node:vm';
import { OwnerSessionDistiller, OWNER_DISTILL_INTERVAL_MS, normalizeOwnerQuote, containsOwnerSecret,
  ownerChannelKindReader, type OwnerDistillerOptions } from '../../src/agent/owner-distill.js';

const NOW = Date.parse('2026-10-13T12:00:00Z');
const at = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
function contact(id: string, text: string, minutes = 60, options: Record<string, unknown> = {}) {
  return { schema: 'home23.resident.contact.v1', contactId: `message:${id}`, sourceRef: `coordination.message:${id}`,
    channelId: 'direct-1', session: 'coordination:direct-1', messageId: id, channelKind: 'direct',
    actor: { principalId: 'owner-1', kind: 'owner', displayName: 'Jason' }, voice: 'jtr', role: 'user',
    content: text, ts: at(minutes), ...options };
}
function residentContact(id: string, text: string, minutes: number) {
  return contact(id, text, minutes, { role: 'assistant', voice: 'self',
    actor: { principalId: 'resident', kind: 'bot', displayName: 'Jerry' } });
}
function item(statement: string, quote: string, id: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({ kind: 'fact', statement, quote, messageRef: `coordination.message:${id}`, privacy: 'personal', ...extra });
}
function fixture(t: TestContext, records: unknown[], replies: string[] | OwnerDistillerOptions['generate'], extra: Partial<OwnerDistillerOptions> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'owner-distill-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const brainDir = join(root, 'brain'); mkdirSync(brainDir);
  const sourcePath = join(root, 'contact.jsonl');
  writeFileSync(sourcePath, records.map(r => JSON.stringify(r)).join('\n') + '\n');
  const prompts: string[] = [];
  const scripted = Array.isArray(replies) ? [...replies] : undefined;
  const generate: OwnerDistillerOptions['generate'] = async request => {
    prompts.push(request.prompt);
    return scripted ? (scripted.shift() ?? '') : (replies as OwnerDistillerOptions['generate'])(request);
  };
  const distiller = new OwnerSessionDistiller({ brainDir, sourcePath, now: () => NOW, generate, ...extra });
  t.after(() => distiller.stop());
  const objects = () => existsSync(join(brainDir, 'memory-objects.json'))
    ? JSON.parse(readFileSync(join(brainDir, 'memory-objects.json'), 'utf8')).objects : [];
  const entries = () => existsSync(join(brainDir, 'relationship-ledger.json'))
    ? JSON.parse(readFileSync(join(brainDir, 'relationship-ledger.json'), 'utf8')).entries : [];
  return { root, brainDir, sourcePath, prompts, distiller, objects, entries };
}

test('quote gate normalizes whitespace, case and quote marks and writes grounded durable facts', async t => {
  const f = fixture(t, [contact('one', 'I live in “New York”.\nMy dogs are  Max and Ruby.')], [[
    item('Jason lives in New York.', 'i LIVE in "New York".', 'one'),
    item('His dogs are Max and Ruby.', 'My dogs are Max and Ruby.', 'one'),
    item('He lives in Paris.', 'I live in Paris', 'one'),
  ].join('\n')]);
  // One scripted response, containing JSON lines.
  assert.equal(normalizeOwnerQuote(' “HELLO”\n there '), '"hello" there');
  const result = await f.distiller.pass();
  assert.equal(result.saved, 2);
  assert.equal(f.objects().length, 2);
  const object = f.objects()[0];
  assert.equal(object.lifecycle_layer, 'durable');
  assert.equal(object.provenance.generation_method, 'owner_conversation');
  assert.deepEqual(object.evidence.evidence_links, ['coordination.message:one']);
  assert.equal(object.evidence.grounding_note, 'i LIVE in "New York".');
  assert.equal(object.updated_at, at(60));
  assert.notEqual(object.provenance.node_profile.authorityClass, 'verified_current_state');
});

test('only owner voice in the same finished session can ground output', async t => {
  const resident = contact('resident', 'I live in Paris.', 59, { role: 'assistant', voice: 'self',
    actor: { principalId: 'resident', kind: 'bot', displayName: 'Jerry' } });
  const f = fixture(t, [contact('one', 'I live in New York.', 150), resident, contact('two', 'I live in Boston.', 60)], [
    [item('Assistant as owner', 'I live in Paris.', 'resident'), item('Wrong session', 'I live in Boston.', 'two'),
      item('Invented ref', 'I live in New York.', 'outside')].join('\n'),
    item('Jason lives in Boston.', 'I live in Boston.', 'two'),
  ]);
  await f.distiller.pass();
  assert.equal(f.objects().length, 1);
  assert.equal(f.objects()[0].statement, 'Jason lives in Boston.');
  assert.ok(f.prompts[1]?.includes('"voice":"resident"'));
});

test('groups, peers, scheduled inputs, workers and unknown provenance are excluded; paired devices are owner voice', async t => {
  const f = fixture(t, [
    contact('home-device', 'I live in New York.', 70, { deviceId: 'paired-home' }),
    contact('mobile', 'I have two dogs.', 69, { deviceId: 'paired-iphone' }),
    contact('group', 'I live in Paris.', 65, { channelKind: 'group', channelId: 'group-1', session: 'coordination:group-1' }),
    contact('scheduled', 'I live in Paris.', 64, { scheduled: true }),
    contact('runtime', 'I live in Paris.', 63, { runtime: true }),
    contact('worker', 'I live in Paris.', 62, { worker: true }),
    contact('peer', 'I live in Paris.', 61, { voice: 'peer', actor: { kind: 'bot', principalId: 'peer' } }),
    contact('unknown', 'I live in Paris.', 60, { channelKind: undefined, session: 'coordination:unknown', channelId: 'unknown' }),
  ], [[item('Jason lives in New York.', 'I live in New York.', 'home-device'),
    item('Jason has two dogs.', 'I have two dogs.', 'mobile'), item('No groups', 'I live in Paris.', 'group')].join('\n')]);
  await f.distiller.pass();
  assert.equal(f.objects().length, 2);
  assert.equal(f.prompts.length, 1);
  for (const id of ['group', 'scheduled', 'runtime', 'worker', 'peer', 'unknown']) assert.ok(!f.prompts[0]!.includes(`coordination.message:${id}`));
});

test('already shipped canonical contact uses read-only channel kind lookup', async t => {
  const f = fixture(t, [contact('one', 'I live in New York.', 60, { channelKind: undefined })], [item('Jason lives in New York.', 'I live in New York.', 'one')]);
  const dbPath = join(f.root, 'core.sqlite3');
  const db = new Database(dbPath);
  db.exec("CREATE TABLE channels(id TEXT, kind TEXT); INSERT INTO channels VALUES('direct-1','direct'), ('group-1','group')"); db.close();
  const lookup = ownerChannelKindReader(dbPath);
  const readonlyDistiller = new OwnerSessionDistiller({ brainDir: f.brainDir, sourcePath: f.sourcePath, now: () => NOW,
    channelKind: lookup, generate: async () => item('Jason lives in New York.', 'I live in New York.', 'one') });
  assert.equal(lookup('group-1'), 'group');
  assert.equal(lookup('missing'), undefined);
  assert.equal(ownerChannelKindReader(join(f.root, 'missing.sqlite3'))('one'), undefined);
  assert.equal(await readonlyDistiller.pass().then(r => r.saved), 1);
});

test('channel kind lookup caches failures for ten minutes and known kinds for its lifetime', t => {
  let now = NOW;
  t.mock.method(Date, 'now', () => now);
  const f = fixture(t, [], []);
  const dbPath = join(f.root, 'core.sqlite3');
  const lookup = ownerChannelKindReader(dbPath);
  assert.equal(lookup('direct-1'), undefined);
  assert.equal(existsSync(dbPath), false, 'a read must not create Core');
  const db = new Database(dbPath);
  t.after(() => db.close());
  db.exec("CREATE TABLE channels(id TEXT, kind TEXT); INSERT INTO channels VALUES('direct-1','direct')");
  assert.equal(lookup('direct-1'), undefined, 'an unavailable lookup is negatively cached');
  now += 10 * 60_000;
  assert.equal(lookup('direct-1'), 'direct', 'an unavailable lookup becomes retryable after ten minutes');
  db.exec("UPDATE channels SET kind='group' WHERE id='direct-1'");
  assert.equal(lookup('direct-1'), 'direct', 'a known kind is cached for this reader lifetime');
  assert.equal(ownerChannelKindReader(dbPath)('direct-1'), 'group');
});

test('locked Core fails fast and attempts each unresolved channel once across passes until cache expiry', async t => {
  let now = NOW;
  t.mock.method(Date, 'now', () => now);
  const f = fixture(t, [], []);
  const dbPath = join(f.root, 'core.sqlite3');
  const db = new Database(dbPath);
  t.after(() => { if (db.open) db.close(); });
  db.exec("CREATE TABLE channels(id TEXT, kind TEXT); INSERT INTO channels VALUES('direct-1','direct'), ('direct-2','direct')");
  db.exec('PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT');
  const prepare = Database.prototype.prepare;
  const timeouts: number[] = [];
  t.mock.method(Database.prototype, 'prepare', function (this: Database.Database, sql: string) {
    timeouts.push(this.pragma('busy_timeout', { simple: true }) as number);
    return prepare.call(this, sql);
  });
  writeFileSync(f.sourcePath, [contact('one', 'I have two dogs.', 150, { channelKind: undefined }),
    contact('two', 'I live in New York.', 60, { channelKind: undefined }),
    contact('other', 'Independent channel.', 60, { channelKind: undefined, channelId: 'direct-2', session: 'coordination:direct-2' })]
    .map(record => JSON.stringify(record)).join('\n') + '\n');
  const distiller = new OwnerSessionDistiller({ brainDir: f.brainDir, sourcePath: f.sourcePath, now: () => now,
    channelKind: ownerChannelKindReader(dbPath), generate: async () => '' });
  t.after(() => distiller.stop());
  assert.deepEqual(await distiller.pass(), { sessions: 0, saved: 0 });
  assert.deepEqual(timeouts, [0, 0], 'each channel lookup disables synchronous busy waiting');
  for (let pass = 0; pass < 3; pass++) assert.deepEqual(await distiller.pass(), { sessions: 0, saved: 0 });
  assert.equal(timeouts.length, 2, 'failures stay cached across passes, independently per channel');
  now += 10 * 60_000 - 1;
  await distiller.pass();
  assert.equal(timeouts.length, 2);
  now++;
  await distiller.pass();
  assert.equal(timeouts.length, 4, 'expired failures permit one new attempt per channel');
  assert.equal(existsSync(join(f.brainDir, 'owner-distill-cursor.json')), false);
  db.close();
  now += 10 * 60_000;
  assert.deepEqual(await distiller.pass(), { sessions: 3, saved: 0 }, 'pending sessions survive until Core is available');
  const readonly = new Database(dbPath, { readonly: true });
  assert.deepEqual(readonly.prepare('SELECT * FROM channels').all(), [{ id: 'direct-1', kind: 'direct' }, { id: 'direct-2', kind: 'direct' }]);
  readonly.close();
});

test('live-shaped stream and old projection records resolve direct kind into finished sessions', async t => {
  for (const projection of [false, true]) {
    const owner = contact('one', 'I have two dogs.', 60, { channelKind: undefined });
    const resident = contact('reply', 'I remember.', 59, { channelKind: undefined, role: 'assistant', voice: 'self',
      actor: { principalId: 'resident', kind: 'bot', displayName: 'Jerry' } });
    const records = [owner, resident].map(({ schema, channelId, messageId, content, ...record }) => projection
      ? { schema, channelId, messageId, content, ...record }
      : { ...record, text: content, semantic_recipe_id: 'fixture-recipe', semantic_absence: 'unavailable' });
    const f = fixture(t, records, [item('Jason has two dogs.', 'I have two dogs.', 'one')], { channelKind: () => 'direct' });
    assert.deepEqual(await f.distiller.pass(), { sessions: 1, saved: 1 });
    assert.ok(f.prompts[0]!.includes('"voice":"resident"'));
  }
});

test('a later kinded projection line resolves earlier legacy turns in the same channel without Core', async t => {
  let lookups = 0;
  const f = fixture(t, [contact('old', 'I have two dogs.', 150, { channelKind: undefined }),
    contact('new', 'I live in New York.', 60)], async request => request.prompt.includes('coordination.message:old')
      ? item('Jason has two dogs.', 'I have two dogs.', 'old')
      : item('Jason lives in New York.', 'I live in New York.', 'new'),
  { channelKind: () => { lookups++; return undefined; } });
  assert.deepEqual(await f.distiller.pass(), { sessions: 2, saved: 2 });
  assert.equal(f.objects().length, 2);
  assert.equal(lookups, 0, 'projection metadata takes precedence over a locked Core');
});

test('kind discovery scans already processed projection lines before applying the cursor', async t => {
  const f = fixture(t, [contact('done', 'Earlier session.', 240)], ['']);
  assert.deepEqual(await f.distiller.pass(), { sessions: 1, saved: 0 });
  appendFileSync(f.sourcePath, [contact('old', 'I have two dogs.', 150, { channelKind: undefined }),
    contact('new', 'I live in New York.', 60, { channelKind: undefined }),
    contact('other', 'Independent channel.', 60, { channelId: 'direct-2', session: 'coordination:direct-2' })]
    .map(record => JSON.stringify(record)).join('\n') + '\n');
  const distiller = new OwnerSessionDistiller({ brainDir: f.brainDir, sourcePath: f.sourcePath, now: () => NOW,
    channelKind: () => { assert.fail('the processed line still supplies channel kind'); }, generate: async () => '' });
  assert.deepEqual(await distiller.pass(), { sessions: 3, saved: 0 });
  const cursor = JSON.parse(readFileSync(join(f.brainDir, 'owner-distill-cursor.json'), 'utf8'));
  assert.equal(cursor.through['coordination:direct-1'], Date.parse(at(60)));
  assert.equal(cursor.through['coordination:direct-2'], Date.parse(at(60)));
  assert.deepEqual(await distiller.pass(), { sessions: 0, saved: 0 });
});

test('kind discovery includes contact outside the fourteen-day evidence window and peer voice', async t => {
  const f = fixture(t, [contact('metadata', 'Peer context.', 15 * 24 * 60, { voice: 'peer',
    actor: { principalId: 'peer', kind: 'bot' } }), contact('one', 'I have two dogs.', 60, { channelKind: undefined })],
  [item('Jason has two dogs.', 'I have two dogs.', 'one')], { channelKind: () => { assert.fail('metadata needs no Core lookup'); } });
  assert.deepEqual(await f.distiller.pass(), { sessions: 1, saved: 1 });
  assert.ok(!f.prompts[0]!.includes('coordination.message:metadata'));
});

test('unresolved channels stay pending while other channels progress and later projection metadata unlocks them', async t => {
  const f = fixture(t, [contact('old', 'I have two dogs.', 150, { channelKind: undefined }),
    contact('new', 'I live in New York.', 60, { channelKind: undefined }),
    contact('other', 'Independent channel.', 60, { channelId: 'direct-2', session: 'coordination:direct-2' })], [''],
  { channelKind: () => undefined });
  assert.deepEqual(await f.distiller.pass(), { sessions: 1, saved: 0 });
  const cursor = JSON.parse(readFileSync(join(f.brainDir, 'owner-distill-cursor.json'), 'utf8'));
  assert.equal(cursor.through['coordination:direct-1'], undefined);
  assert.equal(cursor.through['coordination:direct-2'], Date.parse(at(60)));
  assert.deepEqual(await f.distiller.pass(), { sessions: 0, saved: 0 });
  appendFileSync(f.sourcePath, JSON.stringify(contact('kind', 'A current reply.', 1, { role: 'assistant', voice: 'self',
    actor: { principalId: 'resident', kind: 'bot' } })) + '\n');
  assert.deepEqual(await f.distiller.pass(), { sessions: 2, saved: 0 });
});

test('projection kind metadata cannot cross channels or use malformed canonical identity', async t => {
  const f = fixture(t, [contact('one', 'I have two dogs.', 60, { channelKind: undefined }),
    contact('mismatch', 'Wrong channel.', 1, { channelId: 'direct-2' }),
    contact('bad-ref', 'Wrong identity.', 1, { contactId: 'message:another' }),
    contact('other', 'Independent channel.', 60, { channelId: 'direct-2', session: 'coordination:direct-2' })], [''],
  { channelKind: () => undefined });
  assert.deepEqual(await f.distiller.pass(), { sessions: 1, saved: 0 });
  assert.ok(!f.prompts[0]!.includes('coordination.message:one'));
  const cursor = JSON.parse(readFileSync(join(f.brainDir, 'owner-distill-cursor.json'), 'utf8'));
  assert.equal(cursor.through['coordination:direct-1'], undefined);
});

test('group and conflicting projection kinds never qualify legacy owner turns', async t => {
  for (const conflict of [false, true]) {
    const f = fixture(t, [contact('one', 'I have two dogs.', 60, { channelKind: undefined }),
      ...(conflict ? [contact('direct', 'Direct metadata.', 15 * 24 * 60)] : []),
      contact('group', 'Group metadata.', 1, { channelKind: 'group' })], [], { channelKind: () => 'direct' });
    assert.deepEqual(await f.distiller.pass(), { sessions: 0, saved: 0 });
    assert.equal(f.prompts.length, 0);
    assert.equal(existsSync(join(f.brainDir, 'owner-distill-cursor.json')), false);
  }
});

test('cursor preserves progress when switching between the known stream and projection sources', async t => {
  const f = fixture(t, [contact('done', 'Earlier session.', 120)], ['']);
  await f.distiller.pass();
  const projectionPath = join(f.root, 'projection.jsonl');
  writeFileSync(projectionPath, [contact('done', 'Earlier session.', 120), contact('next', 'I have two dogs.', 60)]
    .map(record => JSON.stringify(record)).join('\n') + '\n');
  const projection = new OwnerSessionDistiller({ brainDir: f.brainDir, sourcePath: projectionPath,
    alternateSourcePath: f.sourcePath, now: () => NOW, generate: async () => item('Jason has two dogs.', 'I have two dogs.', 'next') });
  assert.deepEqual(await projection.pass(), { sessions: 1, saved: 1 });
  const cursor = JSON.parse(readFileSync(join(f.brainDir, 'owner-distill-cursor.json'), 'utf8'));
  assert.equal(cursor.source, projectionPath);
  assert.equal(cursor.since, NOW - 14 * 86_400_000);
  appendFileSync(f.sourcePath, JSON.stringify(contact('later', 'Last session.', 31)) + '\n');
  const fallback = new OwnerSessionDistiller({ brainDir: f.brainDir, sourcePath: f.sourcePath,
    alternateSourcePath: projectionPath, now: () => NOW, generate: async () => '' });
  assert.deepEqual(await fallback.pass(), { sessions: 1, saved: 0 });
  assert.equal(JSON.parse(readFileSync(join(f.brainDir, 'owner-distill-cursor.json'), 'utf8')).source, f.sourcePath);
  const unrelated = new OwnerSessionDistiller({ brainDir: f.brainDir, sourcePath: projectionPath,
    now: () => NOW, generate: async () => '' });
  await assert.rejects(unrelated.pass(), /cursor/);
});

test('home harness prefers Core projection for Seed and non-Seed residents; absent projection falls back to stream', t => {
  const f = fixture(t, [], []);
  const harness = readFileSync(new URL('../../src/home.ts', import.meta.url), 'utf8');
  const start = harness.indexOf('const coordinationDatabasePath =');
  const end = harness.indexOf('ownerDistiller.start();', start);
  assert.ok(start >= 0 && end > start);
  // Execute only the distiller wiring, without launching the harness or its services.
  const wiring = harness.slice(start, end);
  const instanceDir = join(f.root, 'instances', 'jerry');
  const projectionPath = join(f.root, 'instances', '.house', 'coordination', 'resident-contact', 'jerry.jsonl');
  const streamPath = join(instanceDir, 'substrate', 'conversation-stream.jsonl');
  mkdirSync(dirname(projectionPath), { recursive: true });
  mkdirSync(dirname(streamPath), { recursive: true });
  writeFileSync(streamPath, '');
  const choose = (hasSeed: boolean) => runInNewContext(`${wiring}\nownerDistiller.opts.sourcePath`, {
    OwnerSessionDistiller: class { constructor(public opts: OwnerDistillerOptions) {} },
    ownerChannelKindReader, join, dirname, existsSync, process: { env: {} },
    HOME23_ROOT: f.root, INSTANCE_DIR: instanceDir, AGENT_NAME: 'jerry', BRAIN_DIR: f.brainDir,
    workspacePath: join(instanceDir, 'workspace'), config: { chat: {}, agent: {} },
    resolveSubstrateStateDir: () => hasSeed ? dirname(streamPath) : undefined,
  });
  writeFileSync(projectionPath, '');
  for (const hasSeed of [true, false]) assert.equal(choose(hasSeed), projectionPath);
  rmSync(projectionPath);
  for (const hasSeed of [true, false]) assert.equal(choose(hasSeed), streamPath);
});

test('Seed contact-stream shape preserves canonical owner voice and excludes canonical group contact', async t => {
  const streamed = (id: string, channel: string) => ({ role: 'user', text: 'I have two dogs.', ts: at(60),
    session: `coordination:${channel}`, contactId: `message:${id}`, sourceRef: `coordination.message:${id}`,
    voice: 'jtr', actor: { principalId: 'owner-1', kind: 'owner', displayName: 'Jason' },
    semantic_recipe_id: 'fixture-recipe', semantic_absence: 'unavailable' });
  const f = fixture(t, [streamed('direct', 'direct-1'), streamed('group', 'group-1')], [
    item('Jason has two dogs.', 'I have two dogs.', 'direct'),
  ], { channelKind: id => id === 'direct-1' ? 'direct' : 'group' });
  assert.equal((await f.distiller.pass()).saved, 1);
  assert.ok(!f.prompts[0]!.includes('coordination.message:group'));
});

test('duplicate canonical and legacy copies collapse before session grouping', async t => {
  const canonical = contact('one', 'I have two dogs.');
  const legacy = { role: 'user', text: canonical.content, ts: canonical.ts, voice: 'jtr', session: 'jerry__ios_home',
    contactId: 'legacy:jerry__ios_home.jsonl:abc', sourceRef: 'legacy.conversation:jerry__ios_home.jsonl' };
  const f = fixture(t, [legacy, canonical, canonical], [item('Jason has two dogs.', 'I have two dogs.', 'one')]);
  await f.distiller.pass();
  assert.equal(f.prompts.length, 1);
  assert.equal(f.prompts[0]!.split('"voice":"owner"').length - 1, 1);
  assert.equal(f.objects().length, 1);
});

test('legacy direct contact accepts configured Telegram owner; legacy groups and cron files never qualify', async t => {
  const legacy = (session: string) => ({ role: 'user', text: 'I have two dogs.', ts: at(60), voice: 'jtr', session,
    contactId: `legacy:${session}.jsonl:abc`, sourceRef: `legacy.conversation:${session}.jsonl` });
  const f = fixture(t, [legacy('jerry__1234'), legacy('jerry__5678'), legacy('jerry__-1234'), legacy('jerry__cron_job')], [
    JSON.stringify({ kind: 'fact', statement: 'Jason has two dogs.', quote: 'I have two dogs.', messageRef: 'legacy:jerry__1234.jsonl:abc', privacy: 'personal' }),
  ], { ownerTelegramId: '1234' });
  await f.distiller.pass();
  assert.equal(f.objects().length, 1);
  assert.equal(f.prompts.length, 1);
});

test('legacy copies differing only in serialization collapse without collapsing distinct canonical sends', async t => {
  const legacy = { role: 'user', text: 'I have two dogs.', ts: at(60), voice: 'jtr', session: 'jerry__ios_home',
    contactId: 'legacy:jerry__ios_home.jsonl:one', sourceRef: 'legacy.conversation:jerry__ios_home.jsonl' };
  const f = fixture(t, [legacy, { ...legacy, contactId: 'legacy:jerry__ios_home.jsonl:two', text: 'I have  two dogs.' }], ['']);
  await f.distiller.pass(); assert.equal(f.prompts[0]!.split('"voice":"owner"').length - 1, 1);
  const canonical = fixture(t, [contact('one', 'I have two dogs.'), contact('two', 'I have two dogs.')], ['']);
  await canonical.distiller.pass(); assert.equal(canonical.prompts[0]!.split('"voice":"owner"').length - 1, 2);
});

test('finished sessions wait for timestamp gap and first pass excludes history older than fourteen days', async t => {
  const f = fixture(t, [contact('old', 'I live in Paris.', 15 * 24 * 60), contact('finished', 'I live in New York.', 60),
    contact('open', 'I have two dogs.', 10)], [item('Jason lives in New York.', 'I live in New York.', 'finished')]);
  assert.equal((await f.distiller.pass()).sessions, 1);
  assert.equal(f.prompts.length, 1);
  assert.ok(!f.prompts[0]!.includes('coordination.message:old'));
  assert.ok(!f.prompts[0]!.includes('coordination.message:open'));
});

test('scheduler notices do not extend finished sessions or enter the transcript', async t => {
  const f = fixture(t, [contact('owner', 'I have two dogs.', 60),
    residentContact('reply', 'I remember Max and Ruby.', 59),
    ...[40, 20, 1].map(minutes => residentContact(`notice-${minutes}`,
      '[scheduler] Job "process-cpu-io-sampler" failed: Command timed out', minutes)),
  ], [item('Jason has two dogs.', 'I have two dogs.', 'owner')]);
  assert.deepEqual(await f.distiller.pass(), { sessions: 1, saved: 1 });
  assert.ok(f.prompts[0]!.includes('coordination.message:reply'), 'ordinary resident replies remain context');
  assert.ok(!f.prompts[0]!.includes('[scheduler]'));
  const cursor = JSON.parse(readFileSync(join(f.brainDir, 'owner-distill-cursor.json'), 'utf8'));
  assert.equal(cursor.through['coordination:direct-1'], Date.parse(at(59)), 'cursor stops at the last included turn');
  appendFileSync(f.sourcePath, JSON.stringify(residentContact('notice-next', '[scheduler] Job failed again', 0)) + '\n');
  assert.deepEqual(await f.distiller.pass(), { sessions: 0, saved: 0 });
  assert.equal(f.prompts.length, 1, 'recurring notices never re-distill the completed session');
});

test('scheduler notices cannot bridge separate owner conversations and owner text keeps its marker', async t => {
  const f = fixture(t, [contact('first', 'I live in New York.', 120),
    residentContact('first-reply', 'I remember.', 119),
    ...[100, 80, 60].map(minutes => residentContact(`notice-${minutes}`, '[scheduler] Job failed', minutes)),
    contact('second', '[scheduler] is the error I saw. I have two dogs.', 40),
    residentContact('second-reply', 'I remember your dogs.', 39),
  ], [item('Jason lives in New York.', 'I live in New York.', 'first'),
    item('Jason has two dogs.', 'I have two dogs.', 'second')]);
  assert.deepEqual(await f.distiller.pass(), { sessions: 2, saved: 2 });
  assert.ok(!f.prompts[0]!.includes('coordination.message:second'));
  assert.ok(!f.prompts[1]!.includes('coordination.message:first'));
  assert.ok(f.prompts[1]!.includes('[scheduler] is the error I saw.'));
  for (const prompt of f.prompts) assert.ok(!prompt.includes('coordination.message:notice-'));
  assert.deepEqual(await f.distiller.pass(), { sessions: 0, saved: 0 });
});

test('trailing resident-only turns do not delay completion and the cursor retains their included end', async t => {
  let now = NOW - 1;
  const f = fixture(t, [contact('owner', 'I have two dogs.', 30),
    residentContact('reply', 'I remember.', 29),
    residentContact('follow-up', 'Max and Ruby are in my notes.', 10),
    residentContact('last-reply', 'I will keep that in mind.', 1),
  ], [item('Jason has two dogs.', 'I have two dogs.', 'owner'),
    item('Jason lives in New York.', 'I live in New York.', 'later')], { now: () => now });
  assert.deepEqual(await f.distiller.pass(), { sessions: 0, saved: 0 }, 'owner inactivity must reach the full gap');
  now = NOW;
  assert.deepEqual(await f.distiller.pass(), { sessions: 1, saved: 1 });
  for (const id of ['reply', 'follow-up', 'last-reply']) assert.ok(f.prompts[0]!.includes(`coordination.message:${id}`));
  const cursorPath = join(f.brainDir, 'owner-distill-cursor.json');
  assert.equal(JSON.parse(readFileSync(cursorPath, 'utf8')).through['coordination:direct-1'], Date.parse(at(1)));
  assert.deepEqual(await f.distiller.pass(), { sessions: 0, saved: 0 });
  appendFileSync(f.sourcePath, JSON.stringify(contact('later', 'I live in New York.', 0)) + '\n');
  assert.deepEqual(await f.distiller.pass(), { sessions: 0, saved: 0 }, 'later real owner contact waits for its own gap');
  now += 30 * 60_000;
  assert.deepEqual(await f.distiller.pass(), { sessions: 1, saved: 1 });
  assert.equal(f.prompts.length, 2);
  assert.ok(f.prompts[1]!.includes('coordination.message:later'));
  assert.ok(!f.prompts[1]!.includes('coordination.message:owner'));
  assert.ok(!f.prompts[1]!.includes('coordination.message:last-reply'));
  assert.equal(JSON.parse(readFileSync(cursorPath, 'utf8')).through['coordination:direct-1'], NOW);
  assert.deepEqual(await f.distiller.pass(), { sessions: 0, saved: 0 });
});

test('repeats refresh evidence and dates; cursor reruns and cursor-loss replay create no duplicates', async t => {
  const f = fixture(t, [contact('one', 'I have two dogs.', 120), contact('two', 'I have two dogs.', 60)], [
    item('Jason has two dogs.', 'I have two dogs.', 'one'), item('Jason has two dogs.', 'I have two dogs.', 'two'),
    item('Jason has two dogs.', 'I have two dogs.', 'one'), item('Jason has two dogs.', 'I have two dogs.', 'two'),
  ]);
  assert.equal((await f.distiller.pass()).sessions, 2);
  assert.equal(f.objects().length, 1);
  assert.equal(f.objects()[0].updated_at, at(60));
  assert.deepEqual(f.objects()[0].evidence.evidence_links, ['coordination.message:one', 'coordination.message:two']);
  assert.deepEqual(await f.distiller.pass(), { sessions: 0, saved: 0 });
  assert.equal(f.prompts.length, 2);
  rmSync(join(f.brainDir, 'owner-distill-cursor.json'));
  await f.distiller.pass();
  assert.equal(f.objects().length, 1);
});

test('new owner words supersede earlier fact and decision without deleting them', async t => {
  let factId = ''; let decisionId = '';
  const f = fixture(t, [contact('one', 'I live in Boston. Use short answers.', 150),
    contact('two', 'I now live in New York. Use detailed answers.', 60)], async request => {
    if (!factId) return [item('Jason lives in Boston.', 'I live in Boston.', 'one'),
      item('Use short answers.', 'Use short answers.', 'one', { kind: 'decision' })].join('\n');
    assert.ok(request.prompt.includes(factId)); assert.ok(request.prompt.includes(decisionId));
    return [item('Jason lives in New York.', 'I now live in New York.', 'two', { supersedes: factId }),
      item('Use detailed answers.', 'Use detailed answers.', 'two', { kind: 'decision', supersedes: decisionId })].join('\n');
  }, { config: { maxSessionsPerPass: 1 } });
  await f.distiller.pass(); factId = f.objects()[0].memory_id; decisionId = f.entries()[0].id;
  await f.distiller.pass();
  assert.equal(f.objects().length, 2); assert.equal(f.entries().length, 2);
  assert.equal(f.objects().find((o: any) => o.memory_id === factId).status, 'superseded');
  assert.equal(f.entries().find((e: any) => e.id === decisionId).status, 'superseded');
});

test('privacy labels are stored for all non-secret topics and secrets are refused in statements or quotes', async t => {
  const text = 'I have diabetes. I owe $400. My password is sample-credential-42. I use a password manager. My secret is that I love ice cream.';
  const f = fixture(t, [contact('one', text)], [[
    item('Jason has diabetes.', 'I have diabetes.', 'one', { privacy: 'sensitive' }),
    item('Jason owes $400.', 'I owe $400.', 'one'),
    item('Save credential', 'My password is sample-credential-42.', 'one'),
    item('password: invented-credential-42', 'I owe $400.', 'one'),
    item('Uses a password manager.', 'I use a password manager.', 'one'),
    item('Loves ice cream.', 'My secret is that I love ice cream.', 'one', { privacy: 'sensitive' }),
    item('Bad privacy', 'I owe $400.', 'one', { privacy: 'unknown' }),
  ].join('\n')], { config: { renderSensitive: false } });
  await f.distiller.pass();
  assert.equal(f.objects().length, 4);
  assert.equal(f.objects()[0].privacy_class, 'sensitive');
  for (const value of ['API key: sample-credential-42', 'token=sample-credential-42', 'Pairing code is 123456', 'Bearer abc123456789',
    'My password was fixture-value', 'My API token was fixture123', 'Use my token fixture123',
    'My pairing code was 123456', 'My password, fixture-value, is no longer valid']) assert.equal(containsOwnerSecret(value), true);
  assert.equal(containsOwnerSecret('I use a password manager.'), false);
  assert.equal(containsOwnerSecret('My secret is that I love ice cream.'), false);
  assert.equal(containsOwnerSecret('Client secret: fixture-credential'), true);
  assert.ok(!JSON.stringify(f.objects()).includes('sample-credential'));
});

test('credential values cannot be laundered by omitting their label', async t => {
  const f = fixture(t, [contact('one', 'My password is fixture-value. I have two dogs.')], [[
    item('Uses fixture-value', 'fixture-value', 'one'),
    item('Jason has two dogs.', 'I have two dogs.', 'one'),
  ].join('\n')]);
  await f.distiller.pass(); assert.equal(f.objects().length, 1);
  assert.equal(f.objects()[0].statement, 'Jason has two dogs.');
});

test('an aversion can supersede an earlier preference in the relationship ledger', async t => {
  let earlierId = '';
  const f = fixture(t, [contact('one', 'I prefer jokes.', 120), contact('two', 'Never tell me jokes.', 60)], async () => earlierId
    ? item('Avoid jokes.', 'Never tell me jokes.', 'two', { kind: 'aversion', supersedes: earlierId })
    : item('Jason prefers jokes.', 'I prefer jokes.', 'one', { kind: 'preference' }), { config: { maxSessionsPerPass: 1 } });
  await f.distiller.pass(); earlierId = f.entries()[0].id;
  await f.distiller.pass(); assert.equal(f.entries().length, 2);
  assert.equal(f.entries().find((e: any) => e.id === earlierId).status, 'superseded');
});

test('decision, preference and aversion route to the relationship ledger with quote evidence', async t => {
  const f = fixture(t, [contact('one', 'Keep answers short. Never repeat that topic. Stop the project.')], [[
    item('Keep answers short.', 'Keep answers short.', 'one', { kind: 'preference' }),
    item('Never repeat that topic.', 'Never repeat that topic.', 'one', { kind: 'aversion', privacy: 'sensitive' }),
    item('Stop the project.', 'Stop the project.', 'one', { kind: 'decision' }),
  ].join('\n')]);
  await f.distiller.pass(); assert.equal(f.objects().length, 0); assert.equal(f.entries().length, 3);
  assert.deepEqual(f.entries().map((e: any) => e.type).sort(), ['aversion', 'decision', 'preference']);
  assert.equal(f.entries()[0].provenance.generation_method, 'owner_conversation');
  assert.equal(f.entries()[0].evidence_note, 'Keep answers short.');
  assert.deepEqual(f.entries()[0].provenance.source_refs, ['coordination.message:one']);
  assert.notEqual(f.entries()[0].actor, 'jtr');
});

test('budgets bound input, output, statement size and item count; malformed output cannot write', async t => {
  let tokens = 0; let promptLength = 0;
  const f = fixture(t, [contact('one', 'I have two dogs.')], async request => {
    tokens = request.maxTokens; promptLength = request.prompt.length;
    return ['bad JSON', item('x'.repeat(60), 'I have two dogs.', 'one'),
      item('Jason has two dogs.', 'I have two dogs.', 'one'), item('Has dogs.', 'I have two dogs.', 'one')].join('\n');
  }, { config: { maxInputChars: 1000, maxOutputTokens: 128, maxStatementChars: 40, maxItemsPerSession: 1 } });
  await f.distiller.pass(); assert.equal(f.objects().length, 1); assert.equal(tokens, 128); assert.ok(promptLength <= 1000);
});

test('a long owner turn still gets one bounded model call with attributable excerpts', async t => {
  const f = fixture(t, [contact('one', 'Long context. '.repeat(1000) + 'I have two dogs.')], async request => {
    assert.ok(request.prompt.length <= 1000);
    assert.ok(request.prompt.includes('"excerpt":true'));
    return item('Jason has two dogs.', 'I have two dogs.', 'one');
  }, { config: { maxInputChars: 1000 } });
  assert.equal((await f.distiller.pass()).saved, 1); assert.equal(f.prompts.length, 1);
});

test('redaction before excerpting prevents credential fragments from becoming owner knowledge', async t => {
  const credential = 'fixtureCREDENTIAL'.repeat(1000);
  const f = fixture(t, [contact('one', `My password is ${credential}. I have two dogs.`)], async request => {
    assert.ok(!request.prompt.includes('fixturecredential'));
    return [item('Credential fragment.', 'fixtureCREDENTIAL'.repeat(4), 'one'),
      item('Stores a credential.', '[credential omitted]', 'one'),
      item('Jason has two dogs.', 'I have two dogs.', 'one')].join('\n');
  }, { config: { maxInputChars: 1000 } });
  assert.equal((await f.distiller.pass()).saved, 1);
  assert.equal(f.objects()[0].statement, 'Jason has two dogs.');
});

test('quoted and unquoted multiword passwords are completely redacted while safe facts survive', async t => {
  for (const value of ['“fixture first second third”', "'fixture first second third'", 'fixture first second third']) {
    const f = fixture(t, [contact('one', `My password is ${value}. I have two dogs.`)], async request => {
      assert.ok(!request.prompt.includes('first second third'));
      return [item('Credential fragment.', 'first second third', 'one'),
        item('Jason has two dogs.', 'I have two dogs.', 'one')].join('\n');
    });
    assert.equal((await f.distiller.pass()).saved, 1);
    assert.equal(f.objects()[0].statement, 'Jason has two dogs.');
  }
});

test('failed generation retains cursor and aborted pass never writes output', async t => {
  let attempt = 0;
  const f = fixture(t, [contact('one', 'I have two dogs.')], async () => {
    if (attempt++ === 0) throw new Error('scripted unavailable');
    return item('Jason has two dogs.', 'I have two dogs.', 'one');
  });
  await assert.rejects(f.distiller.pass(), /scripted unavailable/);
  assert.ok(!existsSync(join(f.brainDir, 'owner-distill-cursor.json')));
  assert.equal((await f.distiller.pass()).saved, 1);
  const aborted = fixture(t, [contact('one', 'I have two dogs.')], async () => {
    aborted.distiller.stop(); return item('Jason has two dogs.', 'I have two dogs.', 'one');
  });
  await assert.rejects(aborted.distiller.pass(), /abort/i); assert.equal(aborted.objects().length, 0);
});

test('partial append waits; corrupt cursor or corrupt shared store fails closed', async t => {
  const f = fixture(t, [contact('one', 'I have two dogs.')], [item('Jason has two dogs.', 'I have two dogs.', 'one')]);
  appendFileSync(f.sourcePath, '{"not-finished":');
  assert.equal((await f.distiller.pass()).saved, 1);
  writeFileSync(join(f.brainDir, 'owner-distill-cursor.json'), '{invalid');
  await assert.rejects(f.distiller.pass(), /cursor/);
  const broken = fixture(t, [contact('one', 'I have two dogs.')], [item('Jason has two dogs.', 'I have two dogs.', 'one')]);
  writeFileSync(join(broken.brainDir, 'memory-objects.json'), '{invalid');
  await assert.rejects(broken.distiller.pass());
  assert.equal(readFileSync(join(broken.brainDir, 'memory-objects.json'), 'utf8'), '{invalid');
});

test('harness schedules background start and fifteen-minute passes, without reply or reset extraction', async t => {
  const f = fixture(t, [contact('one', 'I have two dogs.')], ['']);
  f.distiller.start(); assert.equal(f.prompts.length, 0);
  assert.equal((f.distiller as any).timer._idleTimeout, OWNER_DISTILL_INTERVAL_MS);
  f.distiller.stop(); assert.equal((f.distiller as any).timer, undefined);
  for (const file of ['src/agent/loop.ts', 'src/commands/handler.ts']) {
    const source = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
    assert.ok(!source.includes('.extractAndSave('));
    assert.ok(!source.includes('.distiller.pass('));
  }
  const harness = readFileSync(new URL('../../src/home.ts', import.meta.url), 'utf8');
  assert.ok(harness.includes('ownerDistiller.start()')); assert.ok(harness.includes('ownerDistiller.stop()'));
  const disabled = fixture(t, [contact('one', 'I have two dogs.')], [''], { config: { enabled: false } });
  disabled.distiller.start(); assert.equal((disabled.distiller as any).timer, undefined);
  assert.deepEqual(await disabled.distiller.pass(), { sessions: 0, saved: 0 });
  assert.equal(disabled.prompts.length, 0);
});

test('kind reader fails fast against an EXCLUSIVE-locked Core and backs off per channel', t => {
  const dir = mkdtempSync(join(tmpdir(), 'owner-kind-lock-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'core.sqlite3');
  const core = new Database(path);
  t.after(() => core.close());
  core.pragma('journal_mode = WAL');
  core.exec("CREATE TABLE channels (id TEXT PRIMARY KEY, kind TEXT); INSERT INTO channels VALUES ('direct-1','direct')");
  core.pragma('locking_mode = EXCLUSIVE');
  core.exec("INSERT INTO channels VALUES ('lock','group')"); // first write takes and holds the exclusive lock
  const read = ownerChannelKindReader(path);
  const started = Date.now();
  assert.equal(read('direct-1'), undefined);
  assert.equal(read('direct-1'), undefined); // backed off: no second open
  assert.ok(Date.now() - started < 500, 'locked Core must not stall the harness');
});
