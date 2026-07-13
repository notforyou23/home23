'use strict';

const assert = require('node:assert/strict');
const { parseAnnMetadataChunks } = require('../../../engine/src/dashboard/memory-search');

const LABELS = 25_000;
const LARGE_CONCEPT = 'ann-stream-canary '.repeat(256);

async function* metadataChunks() {
  yield Buffer.from(`{"version":1,"dimension":768,"count":${LABELS},"skipped":0,"labels":[`);
  for (let index = 0; index < LABELS; index += 1) {
    if (index > 0) yield Buffer.from(',');
    yield Buffer.from(JSON.stringify({
      id: `node-${index}`,
      concept: LARGE_CONCEPT,
      tag: 'general',
      weight: 1,
      activation: 0.5,
      cluster: index % 30,
      created: '2026-07-13T00:00:00.000Z',
      source_class: 'durable',
      salienceWeight: 1,
      provenance: { sourceClass: 'durable', reason: 'discarded', retention: 'durable' },
    }));
  }
  yield Buffer.from(']}');
}

async function* amplifiedMetadataChunks() {
  yield Buffer.from(`{"version":1,"dimension":768,"count":${LABELS},"skipped":0,"labels":[`);
  for (let index = 0; index < 1_000_000; index += 1) {
    if (index > 0) yield Buffer.from(',');
    yield Buffer.from(`{"id":"node-${index}","concept":""}`);
  }
  yield Buffer.from(']}');
}

(async () => {
  assert.equal(typeof global.gc, 'function');
  if (process.argv[2] === 'amplification') {
    await assert.rejects(
      parseAnnMetadataChunks(amplifiedMetadataChunks()),
      (error) => error?.code === 'source_unavailable'
        && /label count/i.test(error?.message || ''),
    );
    global.gc();
    process.stdout.write(`${JSON.stringify({
      rejected: true,
      heapUsedBytes: process.memoryUsage().heapUsed,
      maxRssBytes: process.resourceUsage().maxRSS * 1024,
    })}\n`);
    return;
  }
  const parsed = await parseAnnMetadataChunks(metadataChunks());
  assert.equal(parsed.labels.length, LABELS);
  assert.equal(parsed.labels.every((label) => (
    Buffer.byteLength(label.concept, 'utf8') <= 512
    && !Object.hasOwn(label, 'provenance')
  )), true);
  global.gc();
  process.stdout.write(`${JSON.stringify({
    labels: parsed.labels.length,
    heapUsedBytes: process.memoryUsage().heapUsed,
    maxRssBytes: process.resourceUsage().maxRSS * 1024,
  })}\n`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
