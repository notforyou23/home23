import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createTurnStopHandler } from '../../src/routes/chat-turn.js';

function makeHistory(records: Record<string, unknown[]> = {}) {
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
        const port = (server.address() as any).port;
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

test('stop-turn honors turn_id and writes terminal stopped envelope', async () => {
  const records = {
    c1: [
      {
        type: 'turn',
        turn_id: 't1',
        chat_id: 'c1',
        status: 'pending',
        role: 'assistant',
        started_at: '2026-06-26T14:28:00.000Z',
      },
      {
        type: 'event',
        turn_id: 't1',
        seq: 2,
        ts: '2026-06-26T14:28:02.000Z',
        kind: 'response_chunk',
        data: { type: 'response_chunk', chunk: 'partial' },
      },
    ],
  };
  const stoppedArgs: any[] = [];
  const app = express();
  app.use(express.json());
  app.post('/api/chat/stop-turn', createTurnStopHandler({
    agentName: 'jerry',
    agent: {
      stop: (chatId: string, turnId?: string) => {
        stoppedArgs.push([chatId, turnId]);
        return { stopped: true, chatIds: [chatId], turnId };
      },
    } as any,
    history: makeHistory(records) as any,
  }));

  const res = await postJson(app, '/api/chat/stop-turn', { chatId: 'c1', turn_id: 't1' });

  assert.equal(res.status, 200);
  assert.equal(res.body.stopped, true);
  assert.deepEqual(stoppedArgs, [['c1', 't1']]);
  const final = records.c1[records.c1.length - 1] as any;
  assert.equal(final.type, 'turn');
  assert.equal(final.turn_id, 't1');
  assert.equal(final.status, 'stopped');
  assert.equal(final.last_seq, 2);
  assert.equal(final.stop_reason, 'operator_stop');
});

test('stop-turn rejects unknown requested turn_id without stopping chat', async () => {
  const records = {
    c1: [
      {
        type: 'turn',
        turn_id: 't1',
        chat_id: 'c1',
        status: 'pending',
        role: 'assistant',
        started_at: '2026-06-26T14:28:00.000Z',
      },
    ],
  };
  let stopCalls = 0;
  const app = express();
  app.use(express.json());
  app.post('/api/chat/stop-turn', createTurnStopHandler({
    agentName: 'jerry',
    agent: {
      stop: () => {
        stopCalls++;
        return { stopped: true, chatIds: ['c1'] };
      },
    } as any,
    history: makeHistory(records) as any,
  }));

  const res = await postJson(app, '/api/chat/stop-turn', { chatId: 'c1', turn_id: 'missing' });

  assert.equal(res.status, 404);
  assert.equal(stopCalls, 0);
  assert.equal(records.c1.length, 1);
});

test('stop-turn rejects mismatched active turn without terminalizing requested pending turn', async () => {
  const records = {
    c1: [
      {
        type: 'turn',
        turn_id: 't1',
        chat_id: 'c1',
        status: 'pending',
        role: 'assistant',
        started_at: '2026-06-26T14:28:00.000Z',
      },
    ],
  };
  const app = express();
  app.use(express.json());
  app.post('/api/chat/stop-turn', createTurnStopHandler({
    agentName: 'jerry',
    agent: {
      stop: (_chatId: string, _turnId?: string) => {
        return { stopped: false, chatIds: [], activeTurnId: 't2' };
      },
    } as any,
    history: makeHistory(records) as any,
  }));

  const res = await postJson(app, '/api/chat/stop-turn', { chatId: 'c1', turn_id: 't1' });

  assert.equal(res.status, 409);
  assert.equal(res.body.activeTurnId, 't2');
  assert.equal(records.c1.length, 1, 'requested turn must remain pending until a truthful recovery decision');
});
