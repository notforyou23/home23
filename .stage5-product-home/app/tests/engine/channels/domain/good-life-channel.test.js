import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GoodLifeChannel } from '../../../../engine/src/channels/domain/good-life-channel.js';

test('GoodLifeChannel emits collected Good Life observations and writes ledger', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'home23-good-life-'));
  const channel = new GoodLifeChannel({
    brainDir: dir,
    getSnapshot: () => ({
      liveProblems: { open: 0, chronic: 0 },
      crystallization: { lastReceiptAt: new Date().toISOString() },
      memory: { nodes: 10, edges: 15 },
      discovery: { queueDepth: 1 },
    }),
  });

  const [raw] = await channel.poll();
  const parsed = channel.parse(raw);
  const obs = channel.verify(parsed);
  const draft = channel.crystallize(obs);

  assert.equal(obs.channelId, 'domain.good-life');
  assert.equal(obs.flag, 'COLLECTED');
  assert.equal(obs.payload.schema, 'home23.good-life.v1');
  assert.equal(draft.topic, 'good-life');

  const ledger = readFileSync(join(dir, 'good-life-ledger.jsonl'), 'utf8').trim();
  assert.match(ledger, /home23\.good-life\.v1/);
});
