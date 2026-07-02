import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createTurnStatusHandler } from '../../src/routes/chat-turn.js';
import { TurnStore } from '../../src/chat/turn-store.js';

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

async function getJson(app: express.Express, path: string): Promise<{ status: number; body: any }> {
  return await new Promise((resolve, reject) => {
    const server = app.listen(0, async () => {
      try {
        const port = (server.address() as any).port;
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

test('TurnStore.statusForTurn combines pending envelope, last event, and active runtime truth', () => {
  const history = makeHistory({
    c1: [
      {
        type: 'turn',
        turn_id: 't1',
        chat_id: 'c1',
        status: 'pending',
        role: 'assistant',
        started_at: '2026-06-26T14:28:00.000Z',
        model: 'claude-opus-4-8',
        provider: 'anthropic',
      },
      {
        type: 'event',
        turn_id: 't1',
        seq: 2,
        ts: '2026-06-26T14:28:02.000Z',
        kind: 'tool_start',
        data: { type: 'tool_start', tool: 'search' },
      },
    ],
  });

  const status = new TurnStore(history as any).statusForTurn('c1', 't1', {
    active: true,
    provider: 'anthropic',
    defaultModel: 'claude-opus-4-8',
    defaultProvider: 'anthropic',
  });

  assert.ok(status);
  assert.equal(status.turn_id, 't1');
  assert.equal(status.chat_id, 'c1');
  assert.equal(status.status, 'tool_running');
  assert.equal(status.phase, 'tool_start');
  assert.equal(status.active, true);
  assert.equal(status.last_seq, 2);
  assert.equal(status.last_event_at, '2026-06-26T14:28:02.000Z');
  assert.equal(status.model, 'claude-opus-4-8');
  assert.equal(status.provider, 'anthropic');
  assert.deepEqual(status.configured_default, { provider: 'anthropic', model: 'claude-opus-4-8' });
  assert.deepEqual(status.runtime_model, { provider: 'anthropic', model: 'claude-opus-4-8' });
  assert.equal(status.recoverable, true);
});

test('turn-status route returns status without mutating pending turns', async () => {
  const records = {
    c1: [
      {
        type: 'turn',
        turn_id: 't1',
        chat_id: 'c1',
        status: 'pending',
        role: 'assistant',
        started_at: '2026-06-26T14:28:00.000Z',
        model: 'gpt-5.5',
        provider: 'openai-codex',
      },
    ],
  };
  const history = makeHistory(records);
  const app = express();
  app.get('/api/chat/turn-status', createTurnStatusHandler({
    agentName: 'jerry',
    agent: {
      isRunning: (chatId: string) => chatId === 'c1',
      getModel: () => 'gpt-5.5',
      getProvider: () => 'openai-codex',
    } as any,
    history: history as any,
  }));

  const res = await getJson(app, '/api/chat/turn-status?chatId=c1&turn_id=t1');

  assert.equal(res.status, 200);
  assert.equal(res.body.turn_id, 't1');
  assert.equal(res.body.status, 'running');
  assert.equal(res.body.active, true);
  assert.equal(records.c1.length, 1, 'status read must not append orphan/terminal records');
});

test('turn-status route returns 404 for unknown turn', async () => {
  const app = express();
  app.get('/api/chat/turn-status', createTurnStatusHandler({
    agentName: 'jerry',
    agent: {
      isRunning: () => false,
      getModel: () => 'gpt-5.5',
      getProvider: () => 'openai-codex',
    } as any,
    history: makeHistory() as any,
  }));

  const res = await getJson(app, '/api/chat/turn-status?chatId=c1&turn_id=missing');

  assert.equal(res.status, 404);
});
