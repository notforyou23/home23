import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { StoredMessage } from '../../src/agent/history.ts';
import {
  buildRealtimeInstructions,
  buildRealtimeSessionPayload,
  createRealtimeSessionHandler,
  createRealtimeSessionTextParser,
  _resetRealtimeSessionsForTests,
  type RealtimeWebSocketLike,
  type WebSocketFactory,
} from '../../src/routes/chat-realtime.ts';

const SAMPLE_SDP = 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n';

type AppendCall = { chatId: string; role: string; content: string };

type TestRealtimeWebSocket = RealtimeWebSocketLike & {
  sent: string[];
  emit(event: 'open' | 'message' | 'close' | 'error', ...args: unknown[]): void;
  waitForSent(count: number): Promise<void>;
};

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function makeWs(events: Array<Record<string, unknown>>): TestRealtimeWebSocket {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  const sent: string[] = [];
  const sendWaiters: Array<{ count: number; resolve(): void }> = [];
  let started = false;
  const emit = (event: 'open' | 'message' | 'close' | 'error', ...args: unknown[]) => {
    for (const handler of handlers.get(event) ?? []) handler(...args);
  };
  const start = () => {
    if (started) return;
    started = true;
    emit('open');
    for (const event of events) {
      emit('message', JSON.stringify(event));
    }
  };
  const ws: TestRealtimeWebSocket = {
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      if (event === 'message') queueMicrotask(start);
    },
    send(data) {
      sent.push(data);
      for (let i = sendWaiters.length - 1; i >= 0; i--) {
        if (sent.length < sendWaiters[i]!.count) continue;
        sendWaiters.splice(i, 1)[0]!.resolve();
      }
    },
    close() { emit('close'); },
    sent,
    emit,
    waitForSent(count) {
      if (sent.length >= count) return Promise.resolve();
      return new Promise<void>(resolve => sendWaiters.push({ count, resolve }));
    },
  };
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

test('realtime instructions require actual Home23 tool calls and prohibit fake pending state', () => {
  const instructions = buildRealtimeInstructions('jerry', { load: () => [] }, 'ios_voice');

  assert.match(instructions, /MUST call consult_home23 immediately/i);
  assert.match(instructions, /current state.*tools.*files.*brain lookup.*house or device state.*actions/i);
  assert.match(instructions, /Do not say.*checking.*running.*waiting.*unless.*emitted the function call/i);
  assert.match(instructions, /Never invent.*pending.*stuck.*tool state/i);
  assert.match(instructions, /Keep spoken replies concise/i);
});

test('realtime session payload enables automatic tool choice', () => {
  const payload = buildRealtimeSessionPayload('test instructions');

  assert.equal(payload.tool_choice, 'auto');
});

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

test('realtime session preserves exact offer and answer SDP', async (t) => {
  const answerSdp = 'v=0\r\nanswer\r\n';
  let forwardedSdp = '';
  const { base } = startApp(t, {
    fetchImpl: async (_input, init) => {
      assert.ok(init?.body instanceof FormData);
      const sdpPart = init.body.get('sdp');
      assert.equal(typeof sdpPart, 'string');
      forwardedSdp = sdpPart as string;
      return new Response(answerSdp, {
        status: 200,
        headers: { Location: 'https://api.openai.com/v1/realtime/calls/call_exact_sdp' },
      });
    },
    createWebSocket: () => makeWs([]),
  });

  const res = await fetch(`${base}/api/chat/realtime/session?chatId=ios_voice`, {
    method: 'POST',
    ...AUTH_SDP,
    body: SAMPLE_SDP,
  });
  assert.equal(res.status, 200);
  assert.equal(forwardedSdp, SAMPLE_SDP);
  assert.equal(forwardedSdp.endsWith('\r\n'), true);
  const downstreamSdp = await res.text();
  assert.equal(downstreamSdp, answerSdp);
  assert.equal(downstreamSdp.endsWith('\r\n'), true);
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

test('realtime arguments-done event without a name dispatches consult_home23', async (t) => {
  const ws = makeWs([{
    type: 'response.function_call_arguments.done',
    call_id: 'fn_no_name',
    arguments: JSON.stringify({ question: 'what is up?' }),
  }]);
  const { base, getConsultCalls } = startApp(t, {
    fetchImpl: async () => new Response('v=0\r\nok\r\n', {
      status: 200,
      headers: { Location: 'https://api.openai.com/v1/realtime/calls/call_fn_no_name' },
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
});

test('realtime completed output-item function call dispatches consult_home23', async (t) => {
  const ws = makeWs([{
    type: 'response.output_item.done',
    item: {
      type: 'function_call',
      status: 'completed',
      name: 'consult_home23',
      call_id: 'fn_item',
      arguments: JSON.stringify({ question: 'check the sauna' }),
    },
  }]);
  const { base, getConsultCalls } = startApp(t, {
    fetchImpl: async () => new Response('v=0\r\nok\r\n', {
      status: 200,
      headers: { Location: 'https://api.openai.com/v1/realtime/calls/call_fn_item' },
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
});

test('realtime response.done function-call output dispatches consult_home23', async (t) => {
  const ws = makeWs([{
    type: 'response.done',
    response: {
      status: 'completed',
      output: [{
        type: 'function_call',
        status: 'completed',
        name: 'consult_home23',
        call_id: 'fn_response',
        arguments: JSON.stringify({ question: 'check the brain' }),
      }],
    },
  }]);
  const { base, getConsultCalls } = startApp(t, {
    fetchImpl: async () => new Response('v=0\r\nok\r\n', {
      status: 200,
      headers: { Location: 'https://api.openai.com/v1/realtime/calls/call_fn_response' },
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
});

test('realtime consult_home23 wraps the question and uses the bounded voice turn contract', async (t) => {
  const question = 'Is the sauna heating now?\nInclude the current temperature.';
  const infoLines: string[] = [];
  const originalInfo = console.info;
  console.info = (...args: unknown[]) => { infoLines.push(args.map(String).join(' ')); };
  t.after(() => { console.info = originalInfo; });

  let runCall: { chatId: unknown; prompt: unknown; options: unknown } | undefined;
  const ws = makeWs([{
    type: 'response.function_call_arguments.done',
    call_id: 'fn_voice_contract',
    arguments: JSON.stringify({ question }),
  }]);
  const { base } = startApp(t, {
    fetchImpl: async () => new Response('v=0\r\nok\r\n', {
      status: 200,
      headers: { Location: 'https://api.openai.com/v1/realtime/calls/call_voice_contract' },
    }),
    createWebSocket: () => ws,
    agent: {
      runWithTurn: async (...args: unknown[]) => {
        runCall = { chatId: args[0], prompt: args[1], options: args[2] };
        return { turnId: 't_voice_contract', response: Promise.resolve({ text: 'The sauna is heating.' }) };
      },
    },
  });

  const res = await fetch(`${base}/api/chat/realtime/session?chatId=ios_voice`, {
    method: 'POST',
    ...AUTH_SDP,
    body: SAMPLE_SDP,
  });
  assert.equal(res.status, 200);
  await ws.waitForSent(2);

  assert.ok(runCall);
  assert.equal(runCall.chatId, 'voice-consult:call_voice_contract');
  assert.equal(typeof runCall.prompt, 'string');
  const prompt = runCall.prompt as string;
  assert.match(prompt, /realtime voice tool consult/i);
  assert.match(prompt, /use tools immediately/i);
  assert.match(prompt, /do not narrate progress/i);
  assert.match(prompt, /do not use TTS/i);
  assert.match(prompt, /do not (?:claim|report).*pending or running/i);
  assert.match(prompt, /at most 2 tool calls/i);
  assert.match(prompt, /one concise factual answer/i);
  assert.match(prompt, /cannot be obtained promptly.*say that plainly/i);
  assert.match(prompt, /do not start.*durable.*background/i);
  assert.ok(prompt.endsWith(`Actual user question:\n${question}`));
  assert.deepEqual(runCall.options, {
    modelOverride: { provider: 'openai-codex', model: 'gpt-5.4-mini' },
    effort: 'low',
    firstTokenTimeoutMs: 8_000,
    inactivityMs: 20_000,
    hardDurationMs: 30_000,
  });

  const completion = infoLines.find(line => line.includes('function_call_complete'));
  assert.ok(completion);
  assert.match(completion, /status=success/);
  assert.match(completion, /elapsed_ms=\d+/);
  assert.equal(completion.includes(question), false);
});

test('realtime consult_home23 returns a user-safe answer when the bounded turn fails', async (t) => {
  const response = deferred<{ text: string }>();
  const consultStarted = deferred<void>();
  const warnLines: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnLines.push(args.map(String).join(' ')); };
  t.after(() => { console.warn = originalWarn; });

  const ws = makeWs([{
    type: 'response.function_call_arguments.done',
    call_id: 'fn_voice_failure',
    arguments: JSON.stringify({ question: 'What is the current house state?' }),
  }]);
  const { base } = startApp(t, {
    fetchImpl: async () => new Response('v=0\r\nok\r\n', {
      status: 200,
      headers: { Location: 'https://api.openai.com/v1/realtime/calls/call_voice_failure' },
    }),
    createWebSocket: () => ws,
    agent: {
      runWithTurn: async () => {
        consultStarted.resolve();
        return { turnId: 't_voice_failure', response: response.promise };
      },
    },
  });

  const res = await fetch(`${base}/api/chat/realtime/session?chatId=ios_voice`, {
    method: 'POST',
    ...AUTH_SDP,
    body: SAMPLE_SDP,
  });
  assert.equal(res.status, 200);
  await consultStarted.promise;
  response.reject(new Error('private provider failure at /internal/secret-path'));
  await ws.waitForSent(2);

  const outputEvent = JSON.parse(ws.sent[0]!) as {
    item: { output: string };
  };
  const output = JSON.parse(outputEvent.item.output) as { answer: string };
  assert.match(output.answer, /could not obtain.*promptly/i);
  assert.equal(output.answer.includes('private provider failure'), false);
  assert.equal(output.answer.includes('/internal/secret-path'), false);
  assert.deepEqual(JSON.parse(ws.sent[1]!), { type: 'response.create' });

  const completion = warnLines.find(line => line.includes('function_call_complete'));
  assert.ok(completion);
  assert.match(completion, /status=failure/);
  assert.match(completion, /elapsed_ms=\d+/);
  assert.equal(completion.includes('private provider failure'), false);
});

test('realtime consult_home23 drops a late result after the exact session disconnects', async (t) => {
  const response = deferred<{ text: string }>();
  const consultStarted = deferred<void>();
  const warnLines: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnLines.push(args.map(String).join(' ')); };
  t.after(() => { console.warn = originalWarn; });

  const ws = makeWs([{
    type: 'response.function_call_arguments.done',
    call_id: 'fn_voice_late',
    arguments: JSON.stringify({ question: 'Is the sauna ready?' }),
  }]);
  const { base } = startApp(t, {
    fetchImpl: async () => new Response('v=0\r\nok\r\n', {
      status: 200,
      headers: { Location: 'https://api.openai.com/v1/realtime/calls/call_voice_late' },
    }),
    createWebSocket: () => ws,
    agent: {
      runWithTurn: async () => {
        consultStarted.resolve();
        return { turnId: 't_voice_late', response: response.promise };
      },
    },
  });

  const res = await fetch(`${base}/api/chat/realtime/session?chatId=ios_voice`, {
    method: 'POST',
    ...AUTH_SDP,
    body: SAMPLE_SDP,
  });
  assert.equal(res.status, 200);
  await consultStarted.promise;
  ws.emit('close', 1006);
  response.resolve({ text: 'Late internal answer that must be dropped.' });
  await response.promise;
  await new Promise<void>(resolve => setImmediate(resolve));

  assert.deepEqual(ws.sent, []);
  const dropped = warnLines.find(line => line.includes('function_call_result_dropped'));
  assert.ok(dropped);
  assert.match(dropped, /reason=session_inactive/);
  assert.match(dropped, /elapsed_ms=\d+/);
  assert.equal(dropped.includes('Late internal answer'), false);
});

test('realtime consult_home23 dedupes the same call across event shapes', async (t) => {
  const ws = makeWs([
    {
      type: 'response.function_call_arguments.done',
      call_id: 'fn_1',
      arguments: JSON.stringify({ question: 'what is up?' }),
    },
    {
      type: 'response.output_item.done',
      item: {
        type: 'function_call',
        status: 'completed',
        name: 'consult_home23',
        call_id: 'fn_1',
        arguments: JSON.stringify({ question: 'what is up?' }),
      },
    },
    {
      type: 'response.done',
      response: {
        status: 'completed',
        output: [{
          type: 'function_call',
          status: 'completed',
          name: 'consult_home23',
          call_id: 'fn_1',
          arguments: JSON.stringify({ question: 'what is up?' }),
        }],
      },
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

test('realtime explicitly named unknown tools do not dispatch', async (t) => {
  const ws = makeWs([
    {
      type: 'response.function_call_arguments.done',
      name: 'unknown_tool',
      call_id: 'fn_unknown_args',
      arguments: JSON.stringify({ question: 'do not run' }),
    },
    {
      type: 'response.output_item.done',
      item: {
        type: 'function_call',
        status: 'completed',
        name: 'unknown_tool',
        call_id: 'fn_unknown_item',
        arguments: JSON.stringify({ question: 'do not run' }),
      },
    },
    {
      type: 'response.done',
      response: {
        status: 'completed',
        output: [{
          type: 'function_call',
          status: 'completed',
          name: 'unknown_tool',
          call_id: 'fn_unknown_response',
          arguments: JSON.stringify({ question: 'do not run' }),
        }],
      },
    },
  ]);
  const { base, getConsultCalls } = startApp(t, {
    fetchImpl: async () => new Response('v=0\r\nok\r\n', {
      status: 200,
      headers: { Location: 'https://api.openai.com/v1/realtime/calls/call_fn_unknown' },
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

  assert.equal(getConsultCalls(), 0);
  const sent = (ws as RealtimeWebSocketLike & { sent: string[] }).sent;
  assert.equal(sent.some(line => line.includes('function_call_output')), false);
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
