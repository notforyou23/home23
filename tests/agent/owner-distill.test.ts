import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import Database from 'better-sqlite3';
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
    contact('group', 'I live in Paris.', 65, { channelKind: 'group' }),
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
