import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createOwnerConversationEnricher, enrichOwnerConversationEvidence, ownerConversationMatch, ownerConversationQuery,
  ownerConversationSnippet, type OwnerConversationEvidence, type OwnerTranscriptOptions } from '../../src/agent/owner-conversation-recall.js';

const NOW = Date.parse('2026-10-14T18:00:00Z');
const evidence: OwnerConversationEvidence = { id: 'rel_20261014T103624Z_fe27', kind: 'decision',
  statement: 'Check current retrieval.', quote: 'Check the brain', createdAt: '2026-10-14T10:36:24Z',
  occurredAt: '2026-10-14T10:36:24Z', sourceRefs: ['coordination.message:msg_check'],
  sessionRefs: ['owner-session:test'], privacyClass: 'personal', status: 'active' };

test('owner dates resolve in America/New_York independently of the harness timezone', () => {
  const previous = process.env.TZ;
  process.env.TZ = 'Pacific/Honolulu';
  try {
    for (const query of ['today', 'Oct 14', 'October 14 2026', '2026-10-14', '"2026-10-14" "owner" "brain"']) {
      assert.deepEqual(ownerConversationQuery(query, NOW).window,
        { start: Date.parse('2026-10-14T04:00:00Z'), end: Date.parse('2026-10-15T04:00:00Z') }, query);
    }
    for (const query of ['this morning', 'October 14 2026 morning conversation dinner brain surgery re embedded restarted clarity retrieval fixes']) {
      assert.deepEqual(ownerConversationQuery(query, NOW).window,
        { start: Date.parse('2026-10-14T04:00:00Z'), end: Date.parse('2026-10-14T16:00:00Z') }, query);
    }
    assert.deepEqual(ownerConversationQuery('yesterday', NOW).window,
      { start: Date.parse('2026-10-13T04:00:00Z'), end: Date.parse('2026-10-14T04:00:00Z') });
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
});

test('explicit owner time intent admits October 14 thin heads despite unmatched dinner and surgery terms', () => {
  const query = ownerConversationQuery('October 14 2026 morning conversation dinner brain surgery re embedded restarted clarity retrieval fixes', NOW);
  assert.notEqual(ownerConversationMatch(evidence, query), null);
  assert.notEqual(ownerConversationMatch({ ...evidence, quote: 'Yup. Give it a go…', occurredAt: '2026-10-14T12:58:30Z' }, query), null);
  assert.equal(ownerConversationMatch({ ...evidence, occurredAt: '2026-09-15T14:40:35Z' }, query), null);
});

test('owner calendar windows account for daylight saving transitions and reject invalid dates', () => {
  assert.deepEqual(ownerConversationQuery('2026-03-08', Date.parse('2026-03-09T12:00:00Z')).window,
    { start: Date.parse('2026-03-08T05:00:00Z'), end: Date.parse('2026-03-09T04:00:00Z') });
  assert.deepEqual(ownerConversationQuery('2026-11-01', Date.parse('2026-11-02T12:00:00Z')).window,
    { start: Date.parse('2026-11-01T04:00:00Z'), end: Date.parse('2026-11-02T05:00:00Z') });
  assert.equal(ownerConversationQuery('2026-02-30', NOW).valid, false);
});

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'owner-recall-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'conversations')); mkdirSync(join(root, 'substrate'));
  const options: OwnerTranscriptOptions = { instanceDir: root, agentName: 'jerry' };
  const rawPath = join(root, 'conversations', 'jerry__coordination_chn_owner_wrk_one.jsonl');
  const streamPath = join(root, 'substrate', 'conversation-stream.jsonl');
  return { root, options, rawPath, streamPath };
}
function writeRecords(path: string, records: unknown[]) { writeFileSync(path, records.map(record => JSON.stringify(record)).join('\n') + '\n'); }
function raw(message = 'msg_check', text = 'Check the brain. Dinner and brain surgery came up this morning.',
  overrides: Record<string, unknown> = {}) {
  return [{ type: 'turn', status: 'pending', turn_id: `turn_${message}`, chat_id: 'coordination:chn_owner:wrk_one',
    started_at: '2026-10-14T10:36:24Z', context_purpose: 'conversation',
    coordination_origin: { kind: 'coordination', originMessageId: message, channelId: 'chn_owner' }, ...overrides },
  { role: 'user', content: text, ts: '2026-10-14T10:36:24Z' },
  { role: 'assistant', content: 'We re embedded and restarted retrieval. Clarity improved after the fixes.', ts: '2026-10-14T10:37:00Z' },
  { type: 'turn', status: 'complete', turn_id: `turn_${message}` }];
}
function contact(id: string, text: string, role: 'user' | 'assistant' = 'user', ts = '2026-10-14T10:36:24Z', extra: Record<string, unknown> = {}) {
  return { schema: 'home23.resident.contact.v1', role, text, ts, sourceRef: `coordination.message:${id}`,
    messageId: id, contactId: `message:${id}`, session: 'coordination:chn_owner', channelId: 'chn_owner',
    channelKind: 'direct', voice: role === 'user' ? 'jtr' : 'self',
    actor: { kind: role === 'user' ? 'owner' : 'bot', principalId: role === 'user' ? 'user_owner' : 'bot_jerry' }, ...extra };
}

test('thin ledger citation resolves actual raw owner and assistant language without a contact projection', t => {
  const f = fixture(t); writeRecords(f.rawPath, raw());
  const before = readFileSync(f.rawPath, 'utf8');
  const query = ownerConversationQuery('October 14 2026 morning conversation dinner brain surgery re embedded restarted clarity retrieval fixes', NOW);
  const enriched = enrichOwnerConversationEvidence(evidence, query, f.options);
  assert.match(enriched.transcript!.excerpt, /\[owner verbatim\] Check the brain\. Dinner and brain surgery/);
  assert.match(enriched.transcript!.excerpt, /\[assistant clipped\] We re embedded and restarted retrieval/);
  assert.equal(enriched.transcript!.turns[0]!.text, raw()[1]!.content);
  assert.equal(ownerConversationSnippet(enriched, query), enriched.transcript!.excerpt);
  assert.equal(readFileSync(f.rawPath, 'utf8'), before, 'recall preserves transcript bytes');
});

test('a morning owner citation keeps same-turn assistant context when raw persistence finishes after noon', t => {
  const f = fixture(t);
  const records = raw();
  Object.assign(records[0]!, { started_at: '2026-10-14T15:59:00Z' });
  Object.assign(records[1]!, { ts: '2026-10-14T16:02:00Z' });
  Object.assign(records[2]!, { ts: '2026-10-14T16:02:00Z' });
  writeRecords(f.rawPath, records);
  const query = ownerConversationQuery('this morning dinner surgery retrieval', NOW);
  const result = enrichOwnerConversationEvidence({ ...evidence, occurredAt: '2026-10-14T15:59:00Z' }, query, f.options);
  assert.match(result.transcript!.excerpt, /Check the brain\. Dinner and brain surgery/);
  assert.match(result.transcript!.excerpt, /\[assistant clipped\] We re embedded and restarted retrieval/);
  assert.equal(result.transcript!.turns.find(turn => turn.role === 'user')!.ts, '2026-10-14T15:59:00Z');
  assert.equal(result.transcript!.turns.find(turn => turn.role === 'assistant')!.ts, '2026-10-14T16:02:00Z');
  assert.equal(result.transcriptResolution, 'incomplete', 'raw completion-to-arrival timestamp mapping remains an inference');
});

test('only the latest cited raw owner uses the preserved ledger occurrence; older refs keep their own window', t => {
  const f = fixture(t);
  const older = raw('msg_old', 'Check the brain. Older owner sentinel.');
  Object.assign(older[0]!, { started_at: '2026-10-13T15:59:00Z' });
  Object.assign(older[1]!, { ts: '2026-10-13T16:02:00Z' });
  Object.assign(older[2]!, { ts: '2026-10-13T16:02:00Z', content: 'Older assistant sentinel.' });
  const latest = raw();
  Object.assign(latest[0]!, { started_at: '2026-10-14T15:59:00Z' });
  Object.assign(latest[1]!, { ts: '2026-10-14T16:02:00Z' });
  Object.assign(latest[2]!, { ts: '2026-10-14T16:02:00Z' });
  writeRecords(f.rawPath, [...older, ...latest]);
  const record = { ...evidence, occurredAt: '2026-10-14T15:59:00Z',
    sourceRefs: ['coordination.message:msg_old', 'coordination.message:msg_check'] };
  const result = enrichOwnerConversationEvidence(record, ownerConversationQuery('this morning', NOW), f.options);
  assert.match(result.transcript!.excerpt, /Check the brain/);
  assert.doesNotMatch(JSON.stringify(result.transcript), /Older owner sentinel|Older assistant sentinel/);
});

test('an older replay appended after the current source does not change its preserved morning occurrence', t => {
  const f = fixture(t);
  const older = raw('msg_old', 'Check the brain. Older replay sentinel.');
  Object.assign(older[0]!, { started_at: '2026-10-13T15:59:00Z' });
  Object.assign(older[1]!, { ts: '2026-10-13T16:02:00Z' });
  Object.assign(older[2]!, { ts: '2026-10-13T16:02:00Z', content: 'Older replay assistant sentinel.' });
  const current = raw();
  Object.assign(current[0]!, { started_at: '2026-10-14T15:59:00Z' });
  Object.assign(current[1]!, { ts: '2026-10-14T16:02:00Z' });
  Object.assign(current[2]!, { ts: '2026-10-14T16:02:00Z' });
  writeRecords(f.rawPath, [...older, ...current]);
  const result = enrichOwnerConversationEvidence({ ...evidence, occurredAt: '2026-10-14T15:59:00Z',
    sourceRefs: ['coordination.message:msg_check', 'coordination.message:msg_old'] },
    ownerConversationQuery('this morning dinner surgery retrieval', NOW), f.options);
  assert.match(result.transcript!.excerpt, /Check the brain\. Dinner and brain surgery/);
  assert.match(result.transcript!.excerpt, /\[assistant clipped\] We re embedded/);
  assert.equal(result.transcript!.turns.find(turn => turn.role === 'user')!.ts, '2026-10-14T15:59:00Z');
  assert.doesNotMatch(JSON.stringify(result.transcript), /Older replay sentinel|Older replay assistant sentinel/);
});

test('a queued owner turn retains its morning occurrence when its pending onset is later', t => {
  const f = fixture(t);
  const records = raw();
  Object.assign(records[0]!, { started_at: '2026-10-14T16:40:00Z' });
  Object.assign(records[1]!, { ts: '2026-10-14T16:43:00Z' });
  Object.assign(records[2]!, { ts: '2026-10-14T16:43:00Z' });
  writeRecords(f.rawPath, records);
  const result = enrichOwnerConversationEvidence({ ...evidence, occurredAt: '2026-10-14T15:59:00Z' },
    ownerConversationQuery('this morning', NOW), f.options);
  assert.equal(result.transcript!.turns.find(turn => turn.role === 'user')!.ts, '2026-10-14T15:59:00Z');
  assert.match(result.transcript!.excerpt, /\[assistant clipped\]/);
});

test('distinct equally compatible raw sources do not inherit an ambiguous preserved occurrence', t => {
  const f = fixture(t);
  const first = raw('msg_one');
  const second = raw('msg_two');
  for (const records of [first, second]) {
    Object.assign(records[0]!, { started_at: '2026-10-14T15:59:00Z' });
    Object.assign(records[1]!, { ts: '2026-10-14T16:02:00Z' });
    Object.assign(records[2]!, { ts: '2026-10-14T16:02:00Z' });
  }
  writeRecords(f.rawPath, [...first, ...second]);
  const result = enrichOwnerConversationEvidence({ ...evidence, occurredAt: '2026-10-14T15:59:00Z',
    sourceRefs: ['coordination.message:msg_one', 'coordination.message:msg_two'] },
    ownerConversationQuery('this morning', NOW), f.options);
  assert.equal(result.transcript, undefined);
  assert.equal(result.transcriptResolution, 'incomplete');
});

test('raw companion assistant replies after the owner window still exclude future content', t => {
  const f = fixture(t);
  const records = raw();
  Object.assign(records[0]!, { started_at: '2026-10-14T15:59:00Z' });
  Object.assign(records[1]!, { ts: '2026-10-14T16:00:00Z' });
  Object.assign(records[2]!, { ts: '2026-10-14T18:01:00Z', content: 'Future assistant sentinel.' });
  writeRecords(f.rawPath, records);
  const result = enrichOwnerConversationEvidence({ ...evidence, occurredAt: '2026-10-14T15:59:00Z' },
    ownerConversationQuery('this morning', NOW), f.options);
  assert.match(result.transcript!.excerpt, /Check the brain/);
  assert.doesNotMatch(JSON.stringify(result.transcript), /Future assistant sentinel/);
});

test('canonical owner occurrence wins over raw completion and the ledger fallback date', t => {
  const f = fixture(t);
  writeRecords(f.streamPath, [contact('msg_check', 'Check the brain. Dinner and brain surgery came up this morning.',
    'user', '2026-10-14T15:58:00Z')]);
  const records = raw();
  Object.assign(records[0]!, { started_at: '2026-10-14T15:59:00Z' });
  Object.assign(records[1]!, { ts: '2026-10-14T16:02:00Z' });
  Object.assign(records[2]!, { ts: '2026-10-14T16:02:00Z' });
  writeRecords(f.rawPath, records);
  const result = enrichOwnerConversationEvidence({ ...evidence, occurredAt: '2026-10-14T15:59:00Z' },
    ownerConversationQuery('this morning', NOW), f.options);
  assert.equal(result.transcript!.turns.find(turn => turn.role === 'user')!.ts, '2026-10-14T15:58:00Z');
  assert.match(result.transcript!.excerpt, /\[assistant clipped\] We re embedded/);
});

test('a raw owner citation beyond 8000 characters resolves before the verbatim excerpt is clipped', t => {
  const f = fixture(t);
  writeRecords(f.rawPath, raw('msg_check', `${'Earlier owner context. '.repeat(500)}Check the brain. Dinner surgery retrieval restart.`));
  const result = enrichOwnerConversationEvidence(evidence, ownerConversationQuery('Oct 14 dinner surgery retrieval', NOW), f.options);
  assert.match(result.transcript!.excerpt, /Check the brain\. Dinner surgery retrieval restart/);
  assert.match(result.transcript!.excerpt, /\[assistant clipped\]/);
  assert.equal(result.transcriptResolution, 'incomplete');
  assert.ok(result.transcript!.turns.every(turn => turn.text.length <= 280));
});

test('canonical session hashes resolve full bounded owner sessions across per-Work transcript files', t => {
  const f = fixture(t);
  const sessionId = `owner-session:${createHash('sha256').update('coordination:chn_owner\0coordination.message:msg_check').digest('hex').slice(0, 32)}`;
  writeRecords(f.streamPath, [contact('msg_check', 'Check the brain.'),
    contact('msg_dinner', 'Dinner is at six. Brain surgery recovery is improving.', 'user', '2026-10-14T10:40:00Z'),
    contact('msg_reply', 'I remember the dinner plan.', 'assistant', '2026-10-14T10:41:00Z'),
    contact('msg_later', 'Unrelated afternoon sentinel.', 'user', '2026-10-14T17:00:00Z')]);
  writeRecords(f.rawPath, raw());
  const secondPath = join(f.root, 'conversations', 'jerry__coordination_chn_owner_wrk_two.jsonl');
  writeRecords(secondPath, raw('msg_dinner', 'Dinner is at six. Brain surgery recovery is improving.'));
  const query = ownerConversationQuery('Oct 14 morning dinner', NOW);
  const enriched = enrichOwnerConversationEvidence({ ...evidence, sourceRefs: ['coordination.message:missing'], sessionRefs: [sessionId] }, query, f.options);
  assert.deepEqual(enriched.transcript!.sessionIds, [sessionId]);
  assert.match(enriched.transcript!.excerpt, /Dinner is at six/);
  assert.doesNotMatch(enriched.transcript!.excerpt, /afternoon sentinel/);
});

test('actual shipped contacts without channelKind resolve only through their quote-gated owner citation', t => {
  const f = fixture(t);
  writeRecords(f.streamPath, [contact('msg_check', 'Check the brain.', 'user', '2026-10-14T10:36:24Z', { channelKind: undefined }),
    contact('msg_dinner', 'Dinner and surgery recovery.', 'user', '2026-10-14T10:40:00Z', { channelKind: undefined }),
    contact('msg_unattributed', 'Unknown direct-channel sentinel.', 'user', '2026-10-14T10:40:00Z',
      { channelKind: undefined, channelId: 'chn_unknown', session: 'coordination:chn_unknown' })]);
  const result = enrichOwnerConversationEvidence(evidence, ownerConversationQuery('Oct 14 dinner', NOW), f.options);
  assert.match(result.transcript!.excerpt, /Dinner and surgery recovery/);
  assert.doesNotMatch(result.transcript!.excerpt, /Unknown direct-channel sentinel/);
});

test('owner recall refuses raw scheduled, delegated, worker and unanchored role=user records', t => {
  const f = fixture(t);
  for (const overrides of [{ context_purpose: 'work' }, { delegation_origin: { kind: 'subagent' } },
    { scheduled: true }, { worker: true }, { runtime: true }, { context_purpose: undefined }]) {
    writeRecords(f.rawPath, raw('msg_check', 'Check the brain. Excluded sentinel.', overrides));
    assert.equal(enrichOwnerConversationEvidence(evidence, ownerConversationQuery('Oct 14', NOW), f.options).transcript, undefined);
  }
  writeRecords(f.rawPath, [...raw('msg_unknown', 'Check the brain. Wrong message sentinel.'),
    ...raw('msg_check', 'Unrelated content without the cited quote.')]);
  assert.equal(enrichOwnerConversationEvidence(evidence, ownerConversationQuery('Oct 14', NOW), f.options).transcript, undefined);
});

test('terminal turns prevent later plain assistant lines inheriting owner attribution', t => {
  const f = fixture(t);
  for (const end of [{ type: 'turn', status: 'complete' }, { type: 'turn', status: 'error' }]) {
    writeRecords(f.rawPath, [...raw().slice(0, 3), end,
      { role: 'assistant', content: 'Unattributed assistant sentinel.', ts: '2026-10-14T10:38:00Z' }]);
    const result = enrichOwnerConversationEvidence(evidence, ownerConversationQuery('Oct 14', NOW), f.options);
    assert.match(result.transcript!.excerpt, /We re embedded/);
    assert.doesNotMatch(JSON.stringify(result.transcript), /Unattributed assistant sentinel/);
  }
});

test('a runtime session boundary between the pending envelope and owner language preserves its cited attribution', t => {
  const f = fixture(t);
  const records = raw();
  writeRecords(f.rawPath, [records[0], { type: 'session_boundary', ts: '2026-10-14T10:36:24Z', trigger: 'coordination' }, ...records.slice(1)]);
  const result = enrichOwnerConversationEvidence(evidence, ownerConversationQuery('Oct 14', NOW), f.options);
  assert.match(result.transcript!.excerpt, /Check the brain/);
  assert.match(result.transcript!.excerpt, /\[assistant clipped\]/);
  assert.deepEqual(result.transcript!.sourceRefs, ['coordination.message:msg_check']);
  assert.equal(result.transcript!.turns.find(turn => turn.role === 'assistant')!.sourceRef, undefined);
});

test('groups, peers, scheduler context, secret turns, wrong residents and symbolic links never enter recall', t => {
  const f = fixture(t);
  writeRecords(f.rawPath, [contact('msg_check', 'Check the brain.'),
    contact('group', 'Group sentinel.', 'user', undefined,
      { channelKind: 'group', channelId: 'chn_group', session: 'coordination:chn_group' }),
    contact('peer', 'Peer sentinel.', 'user', undefined, { voice: 'peer', actor: { kind: 'bot', principalId: 'peer' } }),
    contact('scheduled', 'Scheduled sentinel.', 'user', undefined, { scheduled: true }),
    contact('worker', 'Worker sentinel.', 'user', undefined, { worker: true }),
    contact('subagent', 'Subagent sentinel.', 'assistant', undefined, { actor: { kind: 'subagent', principalId: 'subagent' } }),
    contact('scheduler', '[scheduler] scheduler sentinel.', 'assistant'),
    contact('credential', 'Password is artificial-test-secret-0123456.', 'user')]);
  writeRecords(join(f.root, 'conversations', 'forrest__coordination_chn_owner.jsonl'), raw('msg_check', 'Check the brain. Wrong resident sentinel.'));
  writeRecords(join(f.root, 'outside.jsonl'), raw('msg_check', 'Check the brain. Symlink sentinel.'));
  symlinkSync(join(f.root, 'outside.jsonl'), join(f.root, 'conversations', 'jerry__coordination_chn_link.jsonl'));
  const result = enrichOwnerConversationEvidence(evidence, ownerConversationQuery('Oct 14', NOW), f.options);
  assert.match(result.transcript!.excerpt, /Check the brain/);
  assert.doesNotMatch(JSON.stringify(result.transcript), /sentinel|artificial-test-secret/);
});

test('conflicting direct/group channel metadata fails closed for canonical and raw copies', t => {
  const f = fixture(t);
  writeRecords(f.streamPath, [contact('msg_check', 'Check the brain.'),
    contact('group', 'Group metadata.', 'user', undefined, { channelKind: 'group' })]);
  writeRecords(f.rawPath, raw());
  assert.equal(enrichOwnerConversationEvidence(evidence, ownerConversationQuery('Oct 14', NOW), f.options).transcript, undefined);
});

test('excerpt reserves real assistant context when many long owner messages precede it', t => {
  const f = fixture(t);
  writeRecords(f.streamPath, [contact('msg_check', `Check the brain. ${'Earlier context. '.repeat(40)}`),
    ...Array.from({ length: 5 }, (_, index) => contact(`msg_extra_${index}`, `${'Generic context. '.repeat(35)}Dinner surgery retrieval ${index}.`,
      'user', `2026-10-14T10:${38 + index}:00Z`)),
    contact('msg_reply', 'The retrieval restart improved clarity and dinner recall.', 'assistant', '2026-10-14T10:43:00Z')]);
  const result = enrichOwnerConversationEvidence(evidence, ownerConversationQuery('Oct 14 dinner surgery retrieval', NOW), f.options);
  assert.match(result.transcript!.excerpt, /\[owner verbatim\]/);
  assert.match(result.transcript!.excerpt, /Dinner surgery retrieval/);
  assert.match(result.transcript!.excerpt, /\[assistant clipped\] The retrieval restart improved clarity/);
  assert.equal(result.transcript!.complete, false);
  assert.ok(result.transcript!.excerpt.length <= 650);
});

test('one search snapshot bounds reads and stays consistent; a new search invalidates changed file mtimes', t => {
  const f = fixture(t); writeRecords(f.rawPath, raw());
  const query = ownerConversationQuery('Oct 14', NOW);
  const enrich = createOwnerConversationEnricher(f.options);
  const first = enrich(evidence, query);
  writeRecords(f.rawPath, raw('msg_check', 'Check the brain. Updated dinner sentinel.'));
  utimesSync(f.rawPath, new Date(NOW), new Date(NOW + 1_000));
  assert.equal(enrich(evidence, query).transcript!.excerpt, first.transcript!.excerpt, 'one search shares one read snapshot');
  assert.match(enrichOwnerConversationEvidence(evidence, query, f.options).transcript!.excerpt, /Updated dinner sentinel/);
});

test('byte, file, record and turn caps return bounded partial excerpts and ignore an uncommitted tail', t => {
  const f = fixture(t);
  writeRecords(f.rawPath, [{ type: 'ignored', padding: 'x'.repeat(10_000) }, ...raw()]);
  appendFileSync(f.rawPath, JSON.stringify(contact('tail', 'Uncommitted sentinel.')));
  const query = ownerConversationQuery('Oct 14', NOW);
  const result = enrichOwnerConversationEvidence(evidence, query, { ...f.options,
    limits: { bytesPerFile: 1_000, totalBytes: 1_000, turns: 2, excerptChars: 200 } });
  assert.ok(result.transcript!.excerpt.length <= 200);
  assert.equal(result.transcript!.complete, false);
  assert.doesNotMatch(JSON.stringify(result.transcript), /Uncommitted sentinel/);
  assert.equal(enrichOwnerConversationEvidence(evidence, query, { ...f.options, limits: { recordsPerFile: 1 } }).transcript, undefined);
});

test('file and directory caps constrain a whole federation snapshot', t => {
  const f = fixture(t); writeRecords(f.rawPath, raw());
  writeRecords(join(f.root, 'conversations', 'jerry__coordination_chn_other_wrk_two.jsonl'), raw('msg_unrelated', 'Unrelated sentinel.'));
  utimesSync(f.rawPath, new Date(NOW), new Date(NOW + 1_000));
  const result = enrichOwnerConversationEvidence(evidence, ownerConversationQuery('Oct 14', NOW), { ...f.options, limits: { files: 1 } });
  assert.match(result.transcript!.excerpt, /Check the brain/);
  assert.equal(result.transcript!.complete, false);
  const capped = enrichOwnerConversationEvidence(evidence, ownerConversationQuery('Oct 14', NOW), { ...f.options, limits: { directoryEntries: 1 } });
  assert.ok(!capped.transcript || capped.transcript.complete === false);
});

test('unavailable and capped transcript resolution statuses remain distinct from healthy owner evidence', t => {
  const f = fixture(t);
  const query = ownerConversationQuery('Oct 14', NOW);
  assert.equal(enrichOwnerConversationEvidence(evidence, query, f.options).transcriptResolution, 'unavailable');
  writeRecords(f.rawPath, raw('msg_unknown', 'Different owner message.'));
  const capped = enrichOwnerConversationEvidence(evidence, query, { ...f.options, limits: { bytesPerFile: 10 } });
  assert.equal(capped.transcriptResolution, 'incomplete');
  assert.equal(capped.transcript, undefined);
});
