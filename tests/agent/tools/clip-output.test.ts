import test from 'node:test';
import assert from 'node:assert/strict';
import { clipToolOutput, TOOL_OUTPUT_CHAR_LIMIT } from '../../../src/agent/tools/clip-output.js';

test('clipToolOutput leaves short text unchanged', () => {
  assert.equal(clipToolOutput('hello', 'continue later'), 'hello');
});

test('clipToolOutput stays under the cap and teaches the next call', () => {
  const clipped = clipToolOutput('abcdefghij'.repeat(500), 'Continue with read_file offset=80 limit=80.');
  assert.ok(clipped.length <= TOOL_OUTPUT_CHAR_LIMIT);
  assert.match(clipped, /OUTPUT TRUNCATED/);
  assert.match(clipped, /Continue with read_file offset=80/);
  assert.match(clipped, /do not treat it as the full result/);
  assert.equal(clipped.startsWith('abcdefghij'), true);
});
