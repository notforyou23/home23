import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createTurnStreamHandler } from '../../src/routes/chat-turn.js';
import { turnBus } from '../../src/chat/turn-bus.js';

async function readSseUntilDone(app: express.Express, path: string, timeoutMs = 300): Promise<string> {
  return await new Promise((resolve, reject) => {
    const server = app.listen(0, async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
        server.close();
        reject(new Error('timed out waiting for terminal SSE envelope'));
      }, timeoutMs);

      try {
        const port = (server.address() as { port: number }).port;
        const res = await fetch(`http://127.0.0.1:${port}${path}`, { signal: controller.signal });
        const reader = res.body?.getReader();
        assert.ok(reader);
        const decoder = new TextDecoder();
        let text = '';
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          text += decoder.decode(value, { stream: true });
          if (text.includes('data: [DONE]')) {
            clearTimeout(timer);
            server.close();
            resolve(text);
            return;
          }
        }
        clearTimeout(timer);
        server.close();
        resolve(text);
      } catch (err) {
        clearTimeout(timer);
        server.close();
        if (controller.signal.aborted) return;
        reject(err);
      }
    });
  });
}

async function readFirstSseChunk(app: express.Express, path: string, timeoutMs = 300): Promise<string> {
  return await new Promise((resolve, reject) => {
    const server = app.listen(0, async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
        server.close();
        reject(new Error('timed out waiting for first SSE chunk'));
      }, timeoutMs);

      try {
        const port = (server.address() as { port: number }).port;
        const res = await fetch(`http://127.0.0.1:${port}${path}`, { signal: controller.signal });
        const reader = res.body?.getReader();
        assert.ok(reader);
        const { value } = await reader.read();
        clearTimeout(timer);
        controller.abort();
        server.close();
        resolve(new TextDecoder().decode(value));
      } catch (err) {
        clearTimeout(timer);
        server.close();
        if (controller.signal.aborted) return;
        reject(err);
      }
    });
  });
}

test('turn stream flushes an initial connected comment before any events exist', async () => {
  const history = {
    loadRaw() {
      return [
        {
          type: 'turn',
          turn_id: 't-empty',
          chat_id: 'c-empty',
          status: 'pending',
          role: 'assistant',
          started_at: '2026-06-26T15:00:00.000Z',
        },
      ];
    },
  };
  const app = express();
  app.get('/api/chat/stream', createTurnStreamHandler({
    agentName: 'jerry',
    agent: {} as any,
    history: history as any,
  }));

  const text = await readFirstSseChunk(app, '/api/chat/stream?chatId=c-empty&turn_id=t-empty&cursor=-1');

  assert.match(text, /: connected/);
});

test('turn stream catches terminal envelope emitted while persisted catch-up is being read', async () => {
  const terminal = {
    type: 'turn',
    turn_id: 't1',
    chat_id: 'c1',
    status: 'complete',
    role: 'assistant',
    started_at: '',
    ended_at: '2026-06-26T15:00:02.000Z',
    last_seq: 1,
  };
  let loadCalls = 0;
  const history = {
    loadRaw() {
      loadCalls++;
      if (loadCalls === 1) {
        turnBus.emit('c1', 't1', terminal as any);
        turnBus.close('c1', 't1');
      }
      return [
        {
          type: 'turn',
          turn_id: 't1',
          chat_id: 'c1',
          status: 'pending',
          role: 'assistant',
          started_at: '2026-06-26T15:00:00.000Z',
        },
        {
          type: 'event',
          turn_id: 't1',
          seq: 1,
          ts: '2026-06-26T15:00:01.000Z',
          kind: 'response_chunk',
          data: { chunk: 'hello' },
        },
      ];
    },
  };
  const app = express();
  app.get('/api/chat/stream', createTurnStreamHandler({
    agentName: 'jerry',
    agent: {} as any,
    history: history as any,
  }));

  const text = await readSseUntilDone(app, '/api/chat/stream?chatId=c1&turn_id=t1&cursor=-1');

  assert.match(text, /"status":"complete"/);
  assert.match(text, /data: \[DONE\]/);
});

test('turn stream enriches a persisted complete envelope with canonical assistant content', async () => {
  const full = 'Full canonical response after every streamed chunk.';
  const records = [
    {
      type: 'turn', turn_id: 't-canonical', chat_id: 'c-canonical', status: 'pending',
      role: 'assistant', started_at: '2026-07-12T16:00:00.000Z',
    },
    {
      type: 'event', turn_id: 't-canonical', seq: 1, ts: '2026-07-12T16:00:01.000Z',
      kind: 'response_chunk', data: { type: 'response_chunk', chunk: 'Full canonical' },
    },
    { role: 'user', content: 'question', ts: '2026-07-12T16:00:00.000Z' },
    { role: 'assistant', content: full, ts: '2026-07-12T16:00:02.000Z' },
    {
      type: 'turn', turn_id: 't-canonical', chat_id: 'c-canonical', status: 'complete',
      role: 'assistant', started_at: '', ended_at: '2026-07-12T16:00:02.000Z', last_seq: 1,
      stop_reason: 'end_turn',
    },
  ];
  const app = express();
  app.get('/api/chat/stream', createTurnStreamHandler({
    agentName: 'jerry',
    agent: {} as any,
    history: { loadRaw: () => records } as any,
  }));

  const text = await readSseUntilDone(
    app,
    '/api/chat/stream?chatId=c-canonical&turn_id=t-canonical&cursor=1',
  );

  assert.match(text, /"status":"complete"/);
  assert.match(text, /"assistant_content":"Full canonical response after every streamed chunk\."/);
});
