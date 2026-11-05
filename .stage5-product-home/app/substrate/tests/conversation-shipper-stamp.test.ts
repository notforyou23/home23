/**
 * New conversation-stream lines carry recipe provenance.
 * Old stream bytes stay unknown. Seen contacts are never re-embedded.
 * Fixture embed only — no live encoder.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConversationShipper } from '../src/conversation-shipper.js';
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
