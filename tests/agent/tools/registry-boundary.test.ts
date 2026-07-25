import assert from 'node:assert/strict';
import test from 'node:test';

import { ToolRegistry, createSeededToolRegistry } from '../../../src/agent/tools/index.js';
import type { ToolContext, ToolDefinition } from '../../../src/agent/types.js';

const probe = (log: string[]): ToolDefinition => ({
  name: 'probe',
  description: 'test probe',
  input_schema: { type: 'object', properties: {} },
  async execute(_input, ctx) {
    log.push(ctx.chatId);
    return { content: 'ran' };
  },
});
const ctxFor = (chatId: string) => ({ chatId } as unknown as ToolContext);

test('generic registry refuses proposer: and worker: chat ids before the tool runs', async () => {
  const log: string[] = [];
  const registry = new ToolRegistry();
  registry.register(probe(log));
  for (const chatId of ['proposer:shakedown', 'worker:shakedown-jerry']) {
    const out = await registry.execute('probe', {}, ctxFor(chatId));
    assert.equal(out.is_error, true);
    assert.match(out.content, /refused: generic tool/);
  }
  assert.equal(log.length, 0, 'guarded tool must never execute');
  const ok = await registry.execute('probe', {}, ctxFor('chat-normal'));
  assert.equal(ok.content, 'ran');
});

test('seeded registry contains only the given tools and serves restricted chat ids', async () => {
  const log: string[] = [];
  const registry = createSeededToolRegistry([probe(log)]);
  assert.equal(registry.size, 1);
  const out = await registry.execute('probe', {}, ctxFor('proposer:shakedown'));
  assert.equal(out.content, 'ran');
  assert.deepEqual(log, ['proposer:shakedown']);
  const missing = await registry.execute('shell', {}, ctxFor('proposer:shakedown'));
  assert.equal(missing.is_error, true);
  assert.match(missing.content, /Unknown tool/);
});
