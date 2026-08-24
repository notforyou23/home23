import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { StoredMessage } from '../../src/agent/history.ts';
import {
  createRealtimeSessionHandler,
  createRealtimeSessionTextParser,
  _resetRealtimeSessionsForTests,
  type RealtimeWebSocketLike,
  type WebSocketFactory,
} from '../../src/routes/chat-realtime.ts';

const SAMPLE_SDP = 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n';

type AppendCall = { chatId: string; role: string; content: string };

function makeWs(events: Array<Record<string, unknown>>): RealtimeWebSocketLike {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  const sent: string[] = [];
  let started = false;
  const start = () => {
    if (started) return;
    started = true;
    for (const h of handlers.get('open') ?? []) h();
    for (const event of events) {
      for (const h of handlers.get('message') ?? []) h(JSON.stringify(event));
    }
  };
  const ws: RealtimeWebSocketLike = {
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      if (event === 'message') queueMicrotask(start);
    },
    send(data) { sent.push(data); },
    close() {
      for (const h of handlers.get('close') ?? []) h();
    },
  };
  (ws as RealtimeWebSocketLike & { sent: string[] }).sent = sent;
  return ws;
}

function startApp(
  t: { after(fn: () => void): void },
  opts: {
    fetchImpl?: typeof fetch;
    createWebSocket?: WebSocketFactory;
    openaiApiKey?: string;
    token?: string;
    agent?: { runWithTurn: (...args: unknown[]) => Promise<{ turnId: string; response: Promise<{ text: string }> }> };
  } = {},
) {
  _resetRealtimeSessionsForTests();
  const appended: AppendCall[] = [];
  const history = {
    load: (chatId: string): StoredMessage[] => (
      chatId === 'ios_voice'
        ? [{ role: 'user', content: 'prior question' }, { role: 'assistant', content: 'prior answer' }]
        : []
    ),
    append(chatId: string, records: Array<{ role: string; content: string }>) {
      for (const rec of records) {
        appended.push({ chatId, role: rec.role, content: String(rec.content) });
      }
    },
  };
  let consultCalls = 0;
  const agent = opts.agent ?? {
    runWithTurn: async (_chatId: string, question: string) => {
      consultCalls++;
      return {
        turnId: 't_test',
        response: Promise.resolve({ text: `answered: ${question}` }),
      };
    },
  };

  const app = express();
  app.post(
    '/api/chat/realtime/session',
    createRealtimeSessionTextParser(),
    createRealtimeSessionHandler({
      agentName: 'jerry',
      agent,
      history,
      token: opts.token ?? 'secret',
      openaiApiKey: opts.openaiApiKey ?? 'sk-test',
      fetchImpl: opts.fetchImpl,
      createWebSocket: opts.createWebSocket,
      maxActiveSessions: 4,
    }),
  );
  const server = app.listen(0);
  t.after(() => {
    server.close();
    _resetRealtimeSessionsForTests();
  });
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    appended,
    getConsultCalls: () => consultCalls,
  };
}

const AUTH_SDP = {
  headers: {
    Authorization: 'Bearer secret',
    'Content-Type': 'application/sdp',
  },
};

test('realtime session requires auth', async (t) => {
  const { base } = startApp(t);
  assert.equal((await fetch(`${base}/api/chat/realtime/session?chatId=ios_voice`, {
    method: 'POST',
    body: SAMPLE_SDP,
  })).status, 401);
  assert.equal((await fetch(`${base}/api/chat/realtime/session?chatId=ios_voice`, {
    method: 'POST',
    headers: { Authorization: 'Bearer wrong', 'Content-Type': 'application/sdp' },
    body: SAMPLE_SDP,
  })).status, 401);
});

test('realtime session validates chat id and sdp', async (t) => {
  const { base } = startApp(t);
  assert.equal((await fetch(`${base}/api/chat/realtime/session?chatId=../x`, {
    method: 'POST',
    ...AUTH_SDP,
    body: SAMPLE_SDP,
  })).status, 400);

  assert.equal((await fetch(`${base}/api/chat/realtime/session?chatId=ios_voice`, {
    method: 'POST',
    ...AUTH_SDP,
    body: '   ',
  })).status, 400);

  const noKey = startApp(t, { openaiApiKey: '' });
  assert.equal((await fetch(`${noKey.base}/api/chat/realtime/session?chatId=ios_voice`, {
    method: 'POST',
    ...AUTH_SDP,
    body: SAMPLE_SDP,
  })).status, 503);
});

test('realtime session returns sdp answer and call id header', async (t) => {
  const { base } = startApp(t, {
    fetchImpl: async () => new Response('v=0\r\nanswer\r\n', {
      status: 200,
      headers: { Location: 'https://api.openai.com/v1/realtime/calls/call_abc123' },
    }),
    createWebSocket: () => makeWs([]),
  });

  const res = await fetch(`${base}/api/chat/realtime/session?chatId=ios_voice`, {
    method: 'POST',
    ...AUTH_SDP,
    body: SAMPLE_SDP,
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type')?.includes('application/sdp'), true);
  assert.equal(res.headers.get('x-home23-realtime-call-id'), 'call_abc123');
  assert.match(await res.text(), /answer/);
});

test('realtime sideband persists transcripts exactly once', async (t) => {
  const duplicateUser = {
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'item_u1',
    transcript: ' hello there ',
  };
  const duplicateAssistant = {
    type: 'response.output_audio_transcript.done',
    item_id: 'item_a1',
    transcript: ' hi back ',
  };
  const { base, appended } = startApp(t, {
    fetchImpl: async () => new Response('v=0\r\nok\r\n', {
      status: 200,
      headers: { Location: '/v1/realtime/calls/call_tx1' },
    }),
    createWebSocket: () => makeWs([
      duplicateUser,
      duplicateUser,
      duplicateAssistant,
      duplicateAssistant,
      { type: 'conversation.item.input_audio_transcription.completed', item_id: 'blank', transcript: '   ' },
      { type: 'response.output_audio_transcript.done', item_id: 'unknown', transcript: '' },
    ]),
  });

  const res = await fetch(`${base}/api/chat/realtime/session?chatId=ios_voice`, {
    method: 'POST',
    ...AUTH_SDP,
    body: SAMPLE_SDP,
  });
  assert.equal(res.status, 200);
  await new Promise(r => setTimeout(r, 25));

  assert.deepEqual(appended, [
    { chatId: 'ios_voice', role: 'user', content: 'hello there' },
    { chatId: 'ios_voice', role: 'assistant', content: 'hi back' },
  ]);
});

test('realtime consult_home23 dedupes duplicate function calls', async (t) => {
  const ws = makeWs([
    {
      type: 'response.function_call_arguments.done',
      name: 'consult_home23',
      call_id: 'fn_1',
      arguments: JSON.stringify({ question: 'what is up?' }),
    },
    {
      type: 'response.function_call_arguments.done',
      name: 'consult_home23',
      call_id: 'fn_1',
      arguments: JSON.stringify({ question: 'what is up?' }),
    },
  ]);
  const { base, getConsultCalls } = startApp(t, {
    fetchImpl: async () => new Response('v=0\r\nok\r\n', {
      status: 200,
      headers: { Location: 'https://api.openai.com/v1/realtime/calls/call_fn1' },
    }),
    createWebSocket: () => ws,
  });

  const res = await fetch(`${base}/api/chat/realtime/session?chatId=ios_voice`, {
    method: 'POST',
    ...AUTH_SDP,
    body: SAMPLE_SDP,
  });
  assert.equal(res.status, 200);
  await new Promise(r => setTimeout(r, 50));

  assert.equal(getConsultCalls(), 1);
  const sent = (ws as RealtimeWebSocketLike & { sent: string[] }).sent;
  assert.ok(sent.some(line => line.includes('function_call_output')));
  assert.ok(sent.some(line => line.includes('"type":"response.create"')));
});

test('realtime upstream errors are sanitized', async (t) => {
  const { base } = startApp(t, {
    fetchImpl: async () => new Response(JSON.stringify({
      error: { message: 'bad key sk-secretkey123', code: 'invalid_api_key' },
    }), { status: 401 }),
  });

  const res = await fetch(`${base}/api/chat/realtime/session?chatId=ios_voice`, {
    method: 'POST',
    ...AUTH_SDP,
    body: SAMPLE_SDP,
  });
  assert.equal(res.status, 502);
  const body = await res.json() as { error: string };
  assert.match(body.error, /authentication failed/i);
  assert.equal(body.error.includes('sk-secretkey123'), false);
});
