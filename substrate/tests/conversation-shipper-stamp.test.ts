/**
 * New conversation-stream lines carry recipe provenance.
 * Old stream bytes stay unknown. Seen contacts are never re-embedded.
 * Fixture embed only — no live encoder.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConversationShipper } from '../src/conversation-shipper.js';
import { isLegacyConversationSession } from '../src/conversation-turn.js';
import {
  LEGACY_EMBEDDING_PROFILE,
  LEGACY_EMBEDDING_RECIPE_ID,
  readSemanticProvenance,
} from '../src/semantic-provenance.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'home23-shipper-stamp-'));
  const conversationsDir = join(root, 'conversations');
  mkdirSync(conversationsDir, { recursive: true });
  return {
    conversationsDir,
    streamPath: join(root, 'stream.jsonl'),
    cursorPath: join(root, 'cursor.json'),
  };
}

function canonical(messageId: string, content = 'recycle paper tomorrow morning please', ts = '2026-09-10T18:00:00.000Z') {
  return { schema: 'home23.resident.contact.v1', messageId, channelId: 'owner-chat',
    contactId: `message:${messageId}`, sourceRef: `coordination.message:${messageId}`,
    session: 'coordination:owner-chat', actor: { principalId: 'owner', kind: 'owner', displayName: 'Owner' },
    role: 'user', voice: 'jtr', content, ts };
}

test('Core-only subscriptions do not require a legacy conversation directory', t => {
  const root = mkdtempSync(join(tmpdir(), 'shipper-core-only-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const coordinationSource = join(root, 'core.jsonl');
  writeFileSync(coordinationSource, JSON.stringify(canonical('core-only')) + '\n');
  const streamPath = join(root, 'substrate', 'conversation-stream.jsonl');
  const shipper = createConversationShipper({ conversationsDir: join(root, 'conversations'), streamPath,
    cursorPath: `${streamPath}.cursor.json`, coordinationSource, backfillBytes: 4096, maxAgeDays: 30, embed: () => null });
  assert.equal(shipper.pass(), 1);
  assert.equal(JSON.parse(readFileSync(streamPath, 'utf8')).contactId, 'message:core-only');
});

test('Core twins win over legacy turns before embedding, even with equivalent timestamp spelling', () => {
  const paths = fixture();
  const coordinationSource = join(paths.conversationsDir, 'core-contact.jsonl');
  const contact = canonical('owner-1');
  writeFileSync(coordinationSource, `${JSON.stringify(contact)}\n`);
  writeFileSync(join(paths.conversationsDir, 'jerry__ios_chat.jsonl'), `${JSON.stringify({
    role: contact.role, content: contact.content, ts: '2026-09-10T14:00:00-04:00',
  })}\n`);
  let embeds = 0;
  const shipper = createConversationShipper({ ...paths, coordinationSource, backfillBytes: 4096, maxAgeDays: 30,
    embed: () => { embeds += 1; return null; } });
  assert.equal(shipper.pass(), 1);
  assert.equal(embeds, 1, 'a canonical twin must suppress legacy perception');
  const output = JSON.parse(readFileSync(paths.streamPath, 'utf8').trim());
  assert.equal(output.contactId, 'message:owner-1');
  assert.equal(output.sourceRef, 'coordination.message:owner-1');
  assert.equal(output.actor.kind, 'owner');
});

test('later legacy twins remain deduped after restart and a lost cursor', () => {
  const paths = fixture();
  const coordinationSource = join(paths.conversationsDir, 'core-contact.jsonl');
  const contact = canonical('owner-1');
  writeFileSync(coordinationSource, `${JSON.stringify(contact)}\n`);
  const options = { ...paths, coordinationSource, backfillBytes: 4096, maxAgeDays: 30, embed: () => null };
  assert.equal(createConversationShipper(options).pass(), 1);
  const committed = readFileSync(paths.streamPath, 'utf8');
  writeFileSync(join(paths.conversationsDir, 'jerry__ios_chat.jsonl'), `${JSON.stringify({
    role: contact.role, content: contact.content, ts: contact.ts,
  })}\n`);
  writeFileSync(paths.cursorPath, '{}');
  assert.equal(createConversationShipper(options).pass(), 0);
  assert.equal(readFileSync(paths.streamPath, 'utf8'), committed);
});

test('a late Core twin does not repeat a shipped legacy turn; other timestamps stay distinct', () => {
  const paths = fixture();
  const coordinationSource = join(paths.conversationsDir, 'core-contact.jsonl');
  const contact = canonical('late-owner-1');
  writeFileSync(join(paths.conversationsDir, 'jerry__12345.jsonl'), `${JSON.stringify({
    role: contact.role, content: contact.content, ts: contact.ts,
  })}\n`);
  const options = { ...paths, coordinationSource, backfillBytes: 4096, maxAgeDays: 30, embed: () => null };
  assert.equal(createConversationShipper(options).pass(), 1);
  const committed = readFileSync(paths.streamPath, 'utf8');
  writeFileSync(coordinationSource, `${JSON.stringify(contact)}\n`);
  appendFileSync(coordinationSource, `${JSON.stringify(canonical('later-owner-2', contact.content, '2026-09-10T18:00:01.000Z'))}\n`);
  assert.equal(createConversationShipper(options).pass(), 1);
  const raw = readFileSync(paths.streamPath, 'utf8');
  assert.ok(raw.startsWith(committed), 'historical stream bytes must remain unchanged');
  assert.equal(JSON.parse(raw.trim().split('\n')[1]!).contactId, 'message:later-owner-2');
});

test('canonical message identities remain distinct even when role, text and time match', () => {
  const paths = fixture();
  const coordinationSource = join(paths.conversationsDir, 'core-contact.jsonl');
  writeFileSync(coordinationSource, `${JSON.stringify(canonical('one'))}\n${JSON.stringify(canonical('two'))}\n`);
  const shipper = createConversationShipper({ ...paths, coordinationSource, backfillBytes: 4096, maxAgeDays: 30, embed: () => null });
  assert.equal(shipper.pass(), 2);
  assert.deepEqual(readFileSync(paths.streamPath, 'utf8').trim().split('\n').map(line => JSON.parse(line).contactId),
    ['message:one', 'message:two']);
});

test('a Core projection behind its cursor still suppresses a newly discovered legacy twin', () => {
  const paths = fixture();
  const coordinationSource = join(paths.conversationsDir, 'core-contact.jsonl');
  const contact = canonical('owner-1');
  writeFileSync(coordinationSource, `${JSON.stringify(contact)}\n`);
  // The original legacy line remains the receipt when Core arrived later.
  writeFileSync(paths.streamPath, `${JSON.stringify({ role: contact.role, text: contact.content, ts: contact.ts,
    contactId: 'legacy:original', sourceRef: 'legacy.conversation:original', voice: 'jtr' })}\n`);
  writeFileSync(paths.cursorPath, JSON.stringify({ [`canonical:${coordinationSource}`]: statSync(coordinationSource).size }));
  writeFileSync(join(paths.conversationsDir, 'jerry__ios_chat.jsonl'), `${JSON.stringify({
    role: contact.role, content: contact.content, ts: contact.ts,
  })}\n`);
  const shipper = createConversationShipper({ ...paths, coordinationSource, backfillBytes: 4096, maxAgeDays: 30, embed: () => null });
  assert.equal(shipper.pass(), 0);
});

test('unattributed legacy Telegram group files never become owner voice; direct messages still ship', () => {
  const paths = fixture();
  const turn = { role: 'user', content: 'group participant words', ts: '2026-09-10T18:00:00.000Z' };
  writeFileSync(join(paths.conversationsDir, 'jerry__-10012345.jsonl'), `${JSON.stringify(turn)}\n`);
  writeFileSync(join(paths.conversationsDir, 'jerry__12345.jsonl'), `${JSON.stringify({ ...turn, content: 'direct owner words' })}\n`);
  assert.equal(isLegacyConversationSession('jerry__-10012345.jsonl'), false);
  assert.equal(isLegacyConversationSession('jerry__12345.jsonl'), true);
  const shipper = createConversationShipper({ ...paths, backfillBytes: 4096, maxAgeDays: 30, embed: () => null });
  assert.equal(shipper.pass(), 1);
  const output = JSON.parse(readFileSync(paths.streamPath, 'utf8').trim());
  assert.equal(output.text, 'direct owner words');
  assert.equal(output.voice, 'jtr');
});

test('new shipped lines stamp hash provenance; old stream lines stay byte-identical', () => {
  const paths = fixture();
  const oldLine = JSON.stringify({
    ts: '2026-08-09T14:00:00.000Z',
    role: 'user',
    text: 'should I do the sauna tonight?',
    session: 's1',
    contactId: 'legacy-old-contact',
    sourceRef: 'legacy.conversation:old',
    voice: 'jtr',
    semantic_vector: Array.from({ length: 16 }, () => 0.1),
  });
  writeFileSync(paths.streamPath, `${oldLine}\n`);
  writeFileSync(
    join(paths.conversationsDir, 'jerry__ios_chat.jsonl'),
    `${JSON.stringify({
      role: 'user',
      content: 'recycle paper tomorrow morning please',
      ts: '2026-09-10T18:00:00.000Z',
    })}\n`,
  );

  let embedCalls = 0;
  const shipper = createConversationShipper({
    ...paths,
    backfillBytes: 4096,
    maxAgeDays: 30,
    embed(text) {
      embedCalls += 1;
      assert.match(text, /recycle paper/);
      return Array.from({ length: 16 }, () => 0.2);
    },
  });

  assert.equal(shipper.pass(Date.parse('2026-09-10T18:00:01.000Z')), 1);
  const raw = readFileSync(paths.streamPath, 'utf8');
  const lines = raw.split('\n').filter(Boolean);
  assert.equal(lines[0], oldLine);
  assert.equal(Object.hasOwn(JSON.parse(lines[0]!), 'semantic_recipe_id'), false);

  const newest = JSON.parse(lines[1]!);
  const provenance = readSemanticProvenance(newest);
  assert.equal(newest.semantic_recipe_id, LEGACY_EMBEDDING_RECIPE_ID);
  assert.equal(newest.semantic_encoder, LEGACY_EMBEDDING_PROFILE);
  assert.deepEqual(newest.semantic_vector, Array.from({ length: 16 }, () => 0.2));
  assert.equal(newest.semantic_absence, undefined);
  assert.equal(provenance.semanticRecipeId, LEGACY_EMBEDDING_RECIPE_ID);
  assert.equal(embedCalls, 1);

  assert.equal(shipper.pass(Date.parse('2026-09-10T18:00:02.000Z')), 0);
  assert.equal(embedCalls, 1, 'restore / retry must not re-embed a committed contact');
  assert.equal(readFileSync(paths.streamPath, 'utf8').split('\n').filter(Boolean)[0], oldLine);
});

test('embedder outage stamps typed absence and does not invent a vector', () => {
  const paths = fixture();
  writeFileSync(
    join(paths.conversationsDir, 'jerry__ios_chat.jsonl'),
    `${JSON.stringify({
      role: 'user',
      content: 'recycle paper tomorrow morning please',
      ts: '2026-09-10T18:00:00.000Z',
    })}\n`,
  );
  const shipper = createConversationShipper({
    ...paths,
    backfillBytes: 4096,
    maxAgeDays: 30,
    embed: () => null,
  });
  assert.equal(shipper.pass(Date.parse('2026-09-10T18:00:01.000Z')), 1);
  const newest = JSON.parse(readFileSync(paths.streamPath, 'utf8').trim());
  assert.equal(newest.semantic_vector, undefined);
  assert.equal(newest.semantic_absence, 'unavailable');
  assert.equal(newest.semantic_recipe_id, LEGACY_EMBEDDING_RECIPE_ID);
  assert.equal(newest.semantic_encoder, LEGACY_EMBEDDING_PROFILE);
});
