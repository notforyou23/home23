const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');

function read(path) {
  return readFileSync(path, 'utf8');
}

test('runtime prompt keeps durable work out of the foreground conversation', () => {
  const prompt = read('src/agents/system-prompt.ts');

  assert.match(prompt, /Keep a fast, bounded conversational answer inline/);
  assert.match(prompt, /invoke the intended supported long tool once/);
  assert.match(prompt, /Runtime interception creates the durable Working Thread/);
  assert.match(prompt, /There is no work_create tool/);
  assert.match(prompt, /Acknowledge a successful handoff briefly and remain available in the foreground/);
  assert.match(prompt, /Nested tools and sub-agents inherit the same canonical parent Work/);
  assert.match(prompt, /progress, tool events, and interim results in that Work's Activity/);
  assert.match(prompt, /single verified final result/);
  assert.match(prompt, /Do not expose raw Work IDs in ordinary copy/);
  assert.match(prompt, /never claim that a separate Working Thread exists unless the supported long-tool handoff reports success/);
});

test('new residents inherit the same Working Thread doctrine', () => {
  const source = read('cli/lib/agent-create.js');

  assert.match(source, /## Working Threads/);
  assert.match(source, /Keep fast, bounded answers in the conversation/);
  assert.match(source, /invoke the intended supported long tool once/);
  assert.match(source, /There is no work_create tool/);
  assert.match(source, /Nested tools and sub-agents inherit the same parent Work and stay hidden/);
  assert.match(source, /resident's single verified final result return to the originating conversation/);
  assert.match(source, /Do not create ornamental threads, perform delegation theater, expose raw Work IDs/);
});
