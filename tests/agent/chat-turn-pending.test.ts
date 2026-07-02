import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createPendingTurnsHandler, createTurnStartHandler } from '../../src/routes/chat-turn.js';

type Records = Record<string, Record<string, unknown>[]>;

function makeHistory(records: Records = {}) {
  return {
    loadRaw(chatId: string) {
      return records[chatId] ?? [];
    },
    appendRecord(chatId: string, record: unknown) {
      if (!records[chatId]) records[chatId] = [];
      records[chatId]!.push(record as Record<string, unknown>);
    },
  };
}

async function postJson(app: express.Express, path: string, body: unknown): Promise<{ status: number; body: any }> {
  return await new Promise((resolve, reject) => {
    const server = app.listen(0, async () => {
      try {
        const port = (server.address() as { port: number }).port;
        const res = await fetch(`http://127.0.0.1:${port}${path}`, {
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

async function getJson(app: express.Express, path: string): Promise<{ status: number; body: any }> {
  return await new Promise((resolve, reject) => {
    const server = app.listen(0, async () => {
      try {
        const port = (server.address() as { port: number }).port;
        const res = await fetch(`http://127.0.0.1:${port}${path}`);
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

test('turn start rejects a persisted pending turn even when no in-memory run exists', async () => {
  const records = {
    c1: [
      {
        type: 'turn',
        turn_id: 't-pending',
        chat_id: 'c1',
        status: 'pending',
        role: 'assistant',
        started_at: new Date().toISOString(),
      },
    ],
  };
  let runCalls = 0;
  const app = express();
  app.use(express.json());
  app.post('/api/chat/turn', createTurnStartHandler({
    agentName: 'jerry',
    agent: {
      isRunning: () => false,
      runWithTurn: async () => {
        runCalls++;
        return { turnId: 'new-turn', response: Promise.resolve({}) };
      },
    } as any,
    history: makeHistory(records) as any,
  }));

  const res = await postJson(app, '/api/chat/turn', { chatId: 'c1', message: 'hello' });

  assert.equal(res.status, 409);
  assert.equal(res.body.turn_id, 't-pending');
  assert.equal(res.body.error, 'turn in progress');
  assert.equal(runCalls, 0);
  assert.equal(records.c1.length, 1, 'fresh pending turn must not be auto-terminalized');
});

test('turn start recovers stale persisted pending turn before accepting a new turn', async () => {
  const staleStartedAt = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  const records = {
    c1: [
      {
        type: 'turn',
        turn_id: 't-stale',
        chat_id: 'c1',
        status: 'pending',
        role: 'assistant',
        started_at: staleStartedAt,
      },
    ],
  };
  let runCalls = 0;
  const app = express();
  app.use(express.json());
  app.post('/api/chat/turn', createTurnStartHandler({
    agentName: 'jerry',
    agent: {
      isRunning: () => false,
      runWithTurn: async (_chatId: string, _message: string, opts: any) => {
        runCalls++;
        return { turnId: opts.turnId, response: Promise.resolve({}) };
      },
    } as any,
    history: makeHistory(records) as any,
  }));

  const res = await postJson(app, '/api/chat/turn', { chatId: 'c1', message: 'hello again' });

  assert.equal(res.status, 200);
  assert.equal(runCalls, 1);
  const recovered = records.c1.find((record) => record.type === 'turn' && record.turn_id === 't-stale' && record.status === 'orphaned');
  assert.ok(recovered, 'stale pending turn should be marked orphaned before new turn starts');
});

test('pending endpoint reports pending turns without sweeping orphans', async () => {
  const records = {
    c1: [
      {
        type: 'turn',
        turn_id: 't-stale',
        chat_id: 'c1',
        status: 'pending',
        role: 'assistant',
        started_at: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
      },
    ],
  };
  const app = express();
  app.get('/api/chat/pending', createPendingTurnsHandler({
    agentName: 'jerry',
    agent: {} as any,
    history: makeHistory(records) as any,
  }));

  const res = await getJson(app, '/api/chat/pending?chatId=c1');

  assert.equal(res.status, 200);
  assert.equal(res.body.pending.length, 1);
  assert.equal(records.c1.length, 1, 'pending reads must not append orphan envelopes');
});
