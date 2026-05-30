const test = require('node:test');
const assert = require('node:assert/strict');

const { SynthesisAgent, extractJsonObject } = require('../../../engine/src/synthesis/synthesis-agent.js');

test('extractJsonObject accepts fenced JSON with leading text', () => {
  const parsed = extractJsonObject('\n\n```json\n{"selfUnderstanding":{"summary":"ok"},"consolidatedInsights":[]}\n```\nextra');
  assert.equal(parsed.selfUnderstanding.summary, 'ok');
});

test('extractJsonObject extracts the first balanced JSON object', () => {
  const parsed = extractJsonObject('Here is the JSON:\n{"a":{"b":"brace } inside string"},"c":1}\nThanks.');
  assert.deepEqual(parsed, { a: { b: 'brace } inside string' }, c: 1 });
});

test('synthesis index digest counts sections without carrying full stale volume into prompt', () => {
  const agent = Object.create(SynthesisAgent.prototype);
  const digest = agent._buildIndexDigest(`# Brain Index
Documents compiled: 3

## Trading
portfolio details that should not be copied wholesale
## Trading
more stale trading volume
## Architecture
agency spine
`);

  assert.match(digest, /Trading \(2 index sections\)/);
  assert.match(digest, /Architecture \(1 index sections\)/);
  assert.match(digest, /Counts are not salience/);
  assert.doesNotMatch(digest, /portfolio details that should not be copied wholesale/);
});

test('synthesis search themes seed current conversation and brain cleanup before stale index headings', () => {
  const agent = Object.create(SynthesisAgent.prototype);
  const themes = agent._collectSearchThemes('## Trading\n## Architecture\n');

  assert.equal(themes[0], 'direct user conversation jtr current request');
  assert.equal(themes[2], 'brain cleanup memory retrieval consolidation salience');
  assert.ok(themes.includes('Trading'));
  assert.ok(themes.includes('Architecture'));
});
