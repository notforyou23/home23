import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { MemorySummarizer } = require('../../../engine/src/memory/summarizer.js');

function makeLogger() {
  const entries = [];
  const logger = {
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
    debug(message, data) {
      entries.push({ level: 'debug', message, data });
    },
  };
  return logger;
}

test('createConsolidatedMemoryGPT5 caps large clusters before sending model prompt', async () => {
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-key';
  const logger = makeLogger();
  const summarizer = new MemorySummarizer({}, logger, {});
  const sent = [];

  summarizer.gpt5 = {
    async generate(request) {
      sent.push(request);
      return { content: 'consolidated insight', reasoning: 'reasoned', model: 'test-model' };
    },
  };

  const cluster = Array.from({ length: 4688 }, (_, index) => ({
    id: `node-${index}`,
    concept: `memory concept ${index} ${'x'.repeat(500)}`,
    weight: index === 4687 ? 99999 : index,
  }));

  const result = await summarizer.createConsolidatedMemoryGPT5(cluster);

  assert.equal(result.content, 'consolidated insight');
  assert.equal(sent.length, 1);
  assert.ok(sent[0].messages[0].content.length < 60000);
  assert.ok(sent[0].messages[0].content.includes('memory concept 4687'));
  assert.ok(sent[0].messages[0].content.includes('omitted'));
  assert.ok(
    logger.entries.some((entry) =>
      entry.message === 'Large memory cluster compacted before consolidation' &&
      entry.data.clusterSize === 4688 &&
      entry.data.selected < 4688
    )
  );
});
