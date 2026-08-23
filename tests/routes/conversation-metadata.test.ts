import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { ConversationMetadataStore } from '../../src/chat/conversation-metadata.ts';
import {
  createChatListHandler,
  createChatMetadataHandler,
} from '../../src/routes/chat-history.ts';

function startApp(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'conv-meta-'));
  const metadata = new ConversationMetadataStore(join(dir, '.conversation-metadata.json'));
  const history = {
    listChatIds: () => ['ios_old', 'ios_new'],
    loadRaw: (chatId: string) => {
      if (chatId === 'ios_old') return [{ ts: '2026-08-01T00:00:00Z' }];
      if (chatId === 'ios_new') return [{ role: 'user', content: 'hi', ts: '2026-08-23T00:00:00Z' }];
      return [];
    },
  };
  const app = express();
  app.use(express.json());
  const config = { agentName: 'jerry', history: history as never, token: 'secret', metadata };
  app.get('/api/chat/conversations', createChatListHandler(config));
  app.patch('/api/chat/conversations/:chatId', createChatMetadataHandler(config));
  const server = app.listen(0);
  t.after(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const port = (server.address() as AddressInfo).port;
  return { dir, metadata, base: `http://127.0.0.1:${port}` };
}

const AUTH = { headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' } };

test('conversations list requires auth and stays compatible without metadata', async (t) => {
  const { base } = startApp(t);
  assert.equal((await fetch(`${base}/api/chat/conversations`)).status, 401);
  assert.equal((await fetch(`${base}/api/chat/conversations`, {
    headers: { Authorization: 'Bearer wrong' },
  })).status, 401);

  const body = await (await fetch(`${base}/api/chat/conversations`, AUTH)).json();
  assert.equal(body.conversations.length, 2);
  assert.equal(body.conversations[0].chatId, 'ios_new');
  assert.equal(body.conversations[0].pinned, false);
  assert.equal(body.conversations[0].title, null);
  assert.equal(body.conversations[0].agent, 'jerry');
});

test('patch validates chat id, body, and persists title plus pin across store reload', async (t) => {
  const { base, dir, metadata } = startApp(t);

  assert.equal((await fetch(`${base}/api/chat/conversations/ios_old`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pinned: true }),
  })).status, 401);

  assert.equal((await fetch(`${base}/api/chat/conversations/${encodeURIComponent('..passwd')}`, {
    method: 'PATCH',
    ...AUTH,
    body: JSON.stringify({ pinned: true }),
  })).status, 400);

  assert.equal((await fetch(`${base}/api/chat/conversations/${encodeURIComponent('ios..x')}`, {
    method: 'PATCH',
    ...AUTH,
    body: JSON.stringify({ pinned: true }),
  })).status, 400);

  assert.equal((await fetch(`${base}/api/chat/conversations/ios_old`, {
    method: 'PATCH',
    ...AUTH,
    body: JSON.stringify({}),
  })).status, 400);

  assert.equal((await fetch(`${base}/api/chat/conversations/ios_old`, {
    method: 'PATCH',
    ...AUTH,
    body: JSON.stringify({ pinned: 'yes' }),
  })).status, 400);

  const renamed = await (await fetch(`${base}/api/chat/conversations/ios_old`, {
    method: 'PATCH',
    ...AUTH,
    body: JSON.stringify({ title: '  Durable name  ', pinned: true }),
  })).json();
  assert.equal(renamed.chatId, 'ios_old');
  assert.equal(renamed.title, 'Durable name');
  assert.equal(renamed.pinned, true);
  assert.equal(renamed.lastTs, '2026-08-01T00:00:00Z');

  const listed = await (await fetch(`${base}/api/chat/conversations`, AUTH)).json();
  assert.deepEqual(listed.conversations.map((row: { chatId: string }) => row.chatId), [
    'ios_old',
    'ios_new',
  ]);
  assert.equal(listed.conversations[0].pinned, true);
  assert.equal(listed.conversations[0].title, 'Durable name');

  const jsonl = readdirSync(dir).filter((name) => name.endsWith('.jsonl'));
  assert.deepEqual(jsonl, []);

  const reloaded = new ConversationMetadataStore(join(dir, '.conversation-metadata.json'));
  assert.deepEqual(reloaded.get('ios_old'), { title: 'Durable name', pinned: true });
  assert.equal(existsSync(join(dir, '.conversation-metadata.json')), true);
  assert.equal(metadata.get('ios_old').pinned, true);
});

test('pin does not require a conversation file and clear title is backward compatible', async (t) => {
  const { base } = startApp(t);
  const created = await (await fetch(`${base}/api/chat/conversations/ios_only_meta`, {
    method: 'PATCH',
    ...AUTH,
    body: JSON.stringify({ title: 'Ghost', pinned: true }),
  })).json();
  assert.equal(created.count, 0);
  assert.equal(created.title, 'Ghost');

  const cleared = await (await fetch(`${base}/api/chat/conversations/ios_only_meta`, {
    method: 'PATCH',
    ...AUTH,
    body: JSON.stringify({ title: '' }),
  })).json();
  assert.equal(cleared.title, null);
  assert.equal(cleared.pinned, true);
});
