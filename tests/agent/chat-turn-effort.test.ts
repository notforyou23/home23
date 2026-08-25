import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createTurnStartHandler } from '../../src/routes/chat-turn.js';

function makeFakeAgent(captured: { effort?: unknown }) {
  return {
    isRunning: () => false,
    runWithTurn: async (_chatId: string, _userText: string, opts: { effort?: unknown }) => {
      captured.effort = opts?.effort;
      return { turnId: 'turn-effort', response: Promise.resolve({}) };
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
        const port = (server.address() as { port: number }).port;
        const res = await fetch(`http://127.0.0.1:${port}/api/chat/turn`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const json = await res.json().catch(() => ({}));
        server.close();
        resolve({ status: res.status, body: json });
      } catch (err) {
        server.close();
        reject(err);
      }
    });
  });
}

test('chat-turn forwards a valid per-turn reasoning effort', async () => {
  const captured: { effort?: unknown } = {};
  const app = express();
  app.use(express.json());
  app.post('/api/chat/turn', createTurnStartHandler({
    agentName: 'agent-x',
    agent: makeFakeAgent(captured) as any,
    history: makeFakeHistory() as any,
  } as any));

  const res = await postJson(app, { chatId: 'c1', message: 'hello', effort: 'xhigh' });
  assert.equal(res.status, 200);
  assert.equal(captured.effort, 'xhigh');
});

test('chat-turn omits effort when the client did not override it', async () => {
  const captured: { effort?: unknown } = {};
  const app = express();
  app.use(express.json());
  app.post('/api/chat/turn', createTurnStartHandler({
    agentName: 'agent-x',
    agent: makeFakeAgent(captured) as any,
    history: makeFakeHistory() as any,
  } as any));

  const res = await postJson(app, { chatId: 'c1', message: 'hello' });
  assert.equal(res.status, 200);
  assert.equal(captured.effort, undefined);
});

test('chat-turn rejects an invalid reasoning effort before starting the turn', async () => {
  const captured: { effort?: unknown } = {};
  const app = express();
  app.use(express.json());
  app.post('/api/chat/turn', createTurnStartHandler({
    agentName: 'agent-x',
    agent: makeFakeAgent(captured) as any,
    history: makeFakeHistory() as any,
  } as any));

  const res = await postJson(app, { chatId: 'c1', message: 'hello', effort: 'ultra' });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'reasoning_effort_invalid');
  assert.equal(captured.effort, undefined);
});
