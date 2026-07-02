import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { createTurnStartHandler } from '../../src/routes/chat-turn.js';

function makeFakeAgent(captured: { media?: unknown }) {
  return {
    isRunning: () => false,
    runWithTurn: async (_chatId: string, _userText: string, opts: any) => {
      captured.media = opts?.media;
      return { turnId: 'turn-test', response: Promise.resolve({}) };
    },
  };
}
function makeFakeHistory() {
  const records: Record<string, unknown[]> = {};
  return {
    loadRaw(chatId: string) {
      return records[chatId] ?? [];
    },
    appendRecord(chatId: string, record: unknown) {
      if (!records[chatId]) records[chatId] = [];
      records[chatId]!.push(record);
    },
  };
}

async function postJson(app: express.Express, body: unknown): Promise<{ status: number; body: any }> {
  return await new Promise((resolve, reject) => {
    const server = app.listen(0, async () => {
      try {
        const port = (server.address() as any).port;
        const res = await fetch(`http://127.0.0.1:${port}/api/chat/turn`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const json = await res.json().catch(() => ({}));
        server.close();
        resolve({ status: res.status, body: json });
      } catch (err) { server.close(); reject(err); }
    });
  });
}

const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

test('chat-turn writes image to instanceDir/uploads/chat and passes media to runWithTurn', async () => {
  const root = join(tmpdir(), `chat-turn-images-${Date.now()}`);
  const instanceDir = join(root, 'instances', 'agent-x');
  mkdirSync(instanceDir, { recursive: true });
  const captured: { media?: any[] } = {};
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.post('/api/chat/turn', createTurnStartHandler({
    agentName: 'agent-x',
    agent: makeFakeAgent(captured) as any,
    history: makeFakeHistory() as any,
    instanceDir,
  } as any));

  const res = await postJson(app, {
    chatId: 'c1', message: 'hi',
    images: [{ data: TINY_PNG_B64, mimeType: 'image/png', fileName: 'tiny.png' }],
  });

  assert.equal(res.status, 200);
  assert.equal(captured.media?.length, 1);
  assert.equal(captured.media?.[0].type, 'image');
  assert.equal(captured.media?.[0].mimeType, 'image/png');
  assert.ok(captured.media?.[0].path?.startsWith(join(instanceDir, 'uploads', 'chat')));
  assert.ok(existsSync(captured.media?.[0].path));
  const written = readFileSync(captured.media?.[0].path);
  assert.equal(written.length, Buffer.from(TINY_PNG_B64, 'base64').length);

  rmSync(root, { recursive: true, force: true });
});

test('chat-turn rejects > 6 images with 413', async () => {
  const root = join(tmpdir(), `chat-turn-images-${Date.now()}-cap`);
  const instanceDir = join(root, 'instances', 'agent-x');
  mkdirSync(instanceDir, { recursive: true });
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.post('/api/chat/turn', createTurnStartHandler({
    agentName: 'agent-x',
    agent: makeFakeAgent({}) as any,
    history: makeFakeHistory() as any,
    instanceDir,
  } as any));

  const tooMany = Array.from({ length: 7 }, () => ({ data: TINY_PNG_B64, mimeType: 'image/png' }));
  const res = await postJson(app, { chatId: 'c1', message: 'hi', images: tooMany });
  assert.equal(res.status, 413);

  rmSync(root, { recursive: true, force: true });
});

test('chat-turn rejects unsupported mime with 415', async () => {
  const root = join(tmpdir(), `chat-turn-images-${Date.now()}-mime`);
  const instanceDir = join(root, 'instances', 'agent-x');
  mkdirSync(instanceDir, { recursive: true });
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.post('/api/chat/turn', createTurnStartHandler({
    agentName: 'agent-x',
    agent: makeFakeAgent({}) as any,
    history: makeFakeHistory() as any,
    instanceDir,
  } as any));

  const res = await postJson(app, {
    chatId: 'c1', message: 'hi',
    images: [{ data: TINY_PNG_B64, mimeType: 'application/pdf' }],
  });
  assert.equal(res.status, 415);

  rmSync(root, { recursive: true, force: true });
});
