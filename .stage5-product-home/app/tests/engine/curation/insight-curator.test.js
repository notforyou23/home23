import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { InsightCurator } = require('../../../engine/src/curation/insight-curator.js');

function makeLogger() {
  const entries = [];
  return {
    entries,
    info(message, data) {
      entries.push({ level: 'info', message, data });
    },
    warn(message, data) {
      entries.push({ level: 'warn', message, data });
    },
    error(message, data) {
      entries.push({ level: 'error', message, data });
    },
  };
}

test('selectCurationInputs bounds, deduplicates, and prioritizes curation work', () => {
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-key';
  const logger = makeLogger();
  const curator = new InsightCurator({
    coordinator: {
      insightCuration: {
        maxRawInsights: 3,
      },
    },
  }, logger, '/tmp/home23-curator-test');

  const selected = curator.selectCurationInputs([
    { content: 'low priority newest insight', priority: 1, cycle: 50 },
    { content: 'agent finding A has concrete evidence', priority: 10, cycle: 1 },
    { content: 'agent finding B has concrete evidence', priority: 10, cycle: 2 },
    { content: 'agent finding B has concrete evidence', priority: 10, cycle: 3 },
    { content: 'coordinator review C has useful direction', priority: 9, cycle: 99 },
    { content: 'coordinator review D has useful direction', priority: 9, cycle: 100 },
  ]);

  assert.deepEqual(
    selected.map((insight) => insight.content),
    [
      'agent finding B has concrete evidence',
      'agent finding A has concrete evidence',
      'coordinator review D has useful direction',
    ]
  );
  assert.ok(logger.entries.some((entry) => entry.message === 'Curation inputs bounded'));
});

test('scoreInsights uses configured serial batch scoring and timeout', async () => {
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-key';
  const logger = makeLogger();
  const curator = new InsightCurator({
    coordinator: {
      insightCuration: {
        scoringBatchSize: 2,
        scoringParallelBatches: 1,
        scoringRequestTimeoutMs: 12345,
      },
    },
  }, logger, '/tmp/home23-curator-test');
  const calls = [];

  curator.gpt5 = {
    async generate(request) {
      calls.push(request);
      return {
        content: JSON.stringify([
          { index: 1, actionability: 8, specificity: 7, novelty: 6, businessValue: 5 },
          { index: 2, actionability: 6, specificity: 6, novelty: 6, businessValue: 6 },
        ]),
      };
    },
  };

  const scored = await curator.scoreInsights([
    { content: 'one'.repeat(30) },
    { content: 'two'.repeat(30) },
    { content: 'three'.repeat(30) },
    { content: 'four'.repeat(30) },
    { content: 'five'.repeat(30) },
  ]);

  assert.equal(scored.length, 5);
  assert.equal(calls.length, 3);
  assert.ok(calls.every((call) => call.requestTimeoutMs === 12345));
  assert.deepEqual(
    logger.entries
      .filter((entry) => String(entry.message).startsWith('   Scoring batches'))
      .map((entry) => entry.message),
    ['   Scoring batches 1-1/3', '   Scoring batches 2-2/3', '   Scoring batches 3-3/3']
  );
});
