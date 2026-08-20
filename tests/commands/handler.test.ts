import test from 'node:test';
import assert from 'node:assert/strict';
import { CommandHandler } from '../../src/commands/handler.js';

function makeHandler() {
  const agent = {
    getReasoningEffort: () => 'medium',
    getModel: () => 'gpt-5.6-sol',
    getProvider: () => 'openai-codex',
  };
  const handler = new CommandHandler({
    agent: agent as never,
    history: { load: () => [], compact: () => {} } as never,
    contextManager: {} as never,
    scheduler: null,
    toolContext: {} as never,
    projectRoot: '/tmp/home23',
    enginePort: 5002,
    runtimeDir: '/tmp/home23-reasoning-command-test',
    workspacePath: '/tmp/home23-reasoning-command-test/workspace',
    modelAliases: {},
    compaction: null,
  });
  return { handler, agent };
}

test('/effort supports inspect, set, and reset for one chat', async () => {
  const { handler } = makeHandler();
  const current = await handler.handle('/effort', 'chat-a', 'telegram');
  assert.match(current?.text ?? '', /medium/);
  assert.match(current?.text ?? '', /configured|default/i);

  const set = await handler.handle('/effort high', 'chat-a', 'telegram');
  assert.match(set?.text ?? '', /high/);
  assert.equal((handler as any).getEffort('chat-a'), 'high');
  assert.equal((handler as any).getEffort('chat-b'), undefined);

  const overridden = await handler.handle('/effort', 'chat-a', 'telegram');
  assert.match(overridden?.text ?? '', /high/);
  assert.match(overridden?.text ?? '', /chat override/i);

  const reset = await handler.handle('/effort reset', 'chat-a', 'telegram');
  assert.match(reset?.text ?? '', /medium/);
  assert.equal((handler as any).getEffort('chat-a'), undefined);
});

test('/effort rejects unknown values without changing the chat override', async () => {
  const { handler } = makeHandler();
  await handler.handle('/effort high', 'chat-a', 'telegram');
  const invalid = await handler.handle('/effort ultra', 'chat-a', 'telegram');

  assert.match(invalid?.text ?? '', /invalid|must be one of/i);
  assert.match(invalid?.text ?? '', /none, low, medium, high, xhigh, max/);
  assert.equal((handler as any).getEffort('chat-a'), 'high');
});
