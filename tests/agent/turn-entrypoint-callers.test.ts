import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function source(file: string): string {
  return readFileSync(resolve(file), 'utf8');
}

test('interactive, cron, and Evobrew entrypoints converge on executeTrackedTurn', () => {
  const home = source('src/home.ts');
  const bridge = source('src/routes/evobrew-bridge.ts');

  assert.match(home, /executeTrackedTurn\(\s*agent,\s*message\.chatId,\s*text/);
  assert.match(home, /runAgentLoop\s*=\s*async[\s\S]{0,500}executeTrackedTurn\(\s*agent,\s*ctx\.chatId/);
  assert.match(home, /executeTrackedTurn\(\s*agent,\s*cronChatId,\s*resolvedMessage/);
  assert.doesNotMatch(home, /const agentPromise\s*=\s*agent\.run\(/);
  assert.doesNotMatch(home, /Promise\.race\(\[agentPromise,\s*timeoutPromise\]\)/);

  assert.match(bridge, /executeTrackedTurn\(\s*config\.agent,\s*chatId,\s*enrichedMessage/);
  assert.doesNotMatch(bridge, /config\.agent\.run\(/);
});

test('subagent and worker paths retain the injected tracked runAgentLoop boundary', () => {
  for (const file of ['src/agent/tools/subagent.ts', 'src/workers/runner.ts']) {
    const text = source(file);
    assert.match(text, /ctx\.runAgentLoop/);
    assert.doesNotMatch(text, /\bagent\.run\(/);
    assert.doesNotMatch(text, /Promise\.race\([\s\S]{0,500}runAgentLoop/);
  }
});
