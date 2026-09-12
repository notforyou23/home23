import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test, { type TestContext } from 'node:test';
import WebSocket from 'ws';
import {
  createGptLiveWebRtcSession,
  GptLiveProviderError,
  type GptLiveEvent,
  type GptLiveSessionOptions,
  type GptLiveSocket,
} from '../../src/voice/gpt-live-provider.js';

const TEST_KEY = 'sk-test-private-do-not-expose';

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING;
  sent: GptLiveEvent[] = [];
  terminated = false;
  throwOnSend = false;
  respondToClose = false;

  open() { this.readyState = WebSocket.OPEN; this.emit('open'); }
  receive(event: GptLiveEvent) { this.emit('message', Buffer.from(JSON.stringify(event))); }
  send(raw: string, callback?: (error?: Error) => void) {
    if (this.throwOnSend) throw new Error(`secret ${TEST_KEY}`);
    const event = JSON.parse(raw) as GptLiveEvent;
    this.sent.push(event);
    callback?.();
    if (event.type === 'session.close' && this.respondToClose) {
      this.receive({ type: 'session.closed', reason: 'close_requested', usage: { seconds: 45.8 } });
    }
  }
  close() { this.readyState = WebSocket.CLOSED; this.emit('close', 1000, Buffer.from('')); }
  terminate() { this.terminated = true; this.close(); }
}

function fixture(t: TestContext, overrides: Partial<GptLiveSessionOptions> = {}) {
  // Production timers must not retain the process; this handle keeps timeout tests alive.
  const keepAlive = setInterval(() => {}, 1_000);
  t.after(() => clearInterval(keepAlive));
  const socket = new FakeSocket();
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const events: GptLiveEvent[] = [];
  let socketUrl: string | undefined;
  let socketOptions: WebSocket.ClientOptions | undefined;
  const options: GptLiveSessionOptions = {
    apiKey: TEST_KEY,
    sdp: 'v=0\r\nSDP offer',
    instructions: 'You are the voice of our existing resident.',
    onEvent: event => { events.push(event); },
    requestTimeoutMs: 50,
    attachTimeoutMs: 50,
    closeTimeoutMs: 15,
    hangupTimeoutMs: 30,
    fetch: async (url, init) => {
      calls.push({ url: String(url), init: init! });
      return String(url).endsWith('/hangup')
        ? new Response(null, { status: 200 })
        : Response.json({ session: { id: 'live_opaque:123/x' }, transport: { type: 'webrtc', sdp: 'SDP answer' } });
    },
    webSocketFactory: (url, config) => {
      socketUrl = url;
      socketOptions = config;
      queueMicrotask(() => socket.open());
      return socket as unknown as GptLiveSocket;
    },
    ...overrides,
  };
  return { socket, calls, events, options, socketUrl: () => socketUrl, socketOptions: () => socketOptions };
}

function closedEvent(seconds = 12): GptLiveEvent {
  return { type: 'session.closed', reason: 'close_requested', usage: { seconds } };
}

test('creates client delegation with exact WebRTC schema and restricted frontend commands', async t => {
  const f = fixture(t, { voice: 'cedar', input: [{ role: 'user', text: 'hello' }, { role: 'assistant', text: 'hi' }] });
  const connection = await createGptLiveWebRtcSession(f.options);
  const body = JSON.parse(f.calls[0]!.init.body as string);
  assert.equal(f.calls[0]!.url, 'https://api.openai.com/v1/live/sessions');
  assert.equal(f.calls[0]!.init.method, 'POST');
  assert.equal(f.calls[0]!.init.redirect, 'error');
  assert.deepEqual(body.transport, { type: 'webrtc', sdp: f.options.sdp });
  assert.equal(body.session.model, 'gpt-live-1');
  assert.deepEqual(body.session.delegation, { type: 'client' });
  assert.deepEqual(body.session.audio, { output: { voice: 'cedar' } });
  assert.equal(body.session.store, false);
  assert.deepEqual(body.session.input, [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] },
  ]);
  assert.deepEqual(body.session.client.data_channel.allowed_client_events,
    ['session.close', 'session.input_audio.mute', 'session.input_audio.unmute']);
  assert.ok(body.session.client.data_channel.allowed_server_events.every((event: GptLiveEvent) => typeof event.type === 'string'));
  assert.ok(body.session.client.data_channel.allowed_server_events.some((event: GptLiveEvent) => event.type === 'session.delegation.created'));
  assert.equal(connection.sessionId, 'live_opaque:123/x');
  assert.equal(connection.answerSdp, 'SDP answer');
  assert.equal(f.socketUrl(), 'wss://api.openai.com/v1/live/sessions/live_opaque%3A123%2Fx/attach');
  assert.deepEqual(f.socketOptions()?.headers, { Authorization: `Bearer ${TEST_KEY}` });
  assert.deepEqual(f.calls[0]!.init.headers, { Authorization: `Bearer ${TEST_KEY}`, 'Content-Type': 'application/json' });
  assert.ok(!JSON.stringify(connection).includes(TEST_KEY));
  assert.equal(f.socket.sent.length, 0, 'attach does not send session.start');
  f.socket.receive(closedEvent());
});

test('sideband delivers text events and sends context, discarding reflected audio', async t => {
  const f = fixture(t);
  const connection = await createGptLiveWebRtcSession(f.options);
  const transcript = { type: 'session.input_transcript.delta', delta: 'Hello', start_ms: 0, end_ms: 50 };
  f.socket.receive(transcript);
  f.socket.receive({ type: 'session.input_audio.append', audio: 'do not retain' });
  f.socket.receive({ type: 'session.output_audio.delta', delta: 'do not retain' });
  assert.deepEqual(f.events, [transcript]);
  connection.send({ type: 'session.commentary.append', delegation_id: 'd_1', content: 'The resident has answered.' });
  assert.equal(f.socket.sent[0]?.type, 'session.commentary.append');
  for (const type of ['session.start', 'session.input_audio.append', 'session.close']) {
    assert.throws(() => connection.send({ type }), /invalid sideband command/);
  }
  f.socket.receive(closedEvent());
});

test('close waits for session.closed, saves final usage, and sends exactly one close', async t => {
  const f = fixture(t);
  const connection = await createGptLiveWebRtcSession(f.options);
  f.socket.receive({ type: 'session.usage.updated', usage: { seconds: 3 } });
  const close = connection.close();
  assert.equal(connection.close(), close);
  assert.equal(f.socket.terminated, false);
  assert.deepEqual(f.socket.sent, [{ type: 'session.close' }]);
  assert.throws(() => connection.send({ type: 'session.thinking.append' }), /connection unavailable/);
  f.socket.receive(closedEvent(12.5));
  assert.deepEqual(await close, { finalized: true, reason: 'close_requested', usageSeconds: 12.5 });
  assert.equal(f.socket.terminated, true);
  assert.equal(f.calls.length, 1, 'no hangup needed after confirmed final event');
});

test('close handler exists before sending even if final event arrives synchronously', async t => {
  const f = fixture(t);
  f.socket.respondToClose = true;
  const connection = await createGptLiveWebRtcSession(f.options);
  assert.deepEqual(await connection.close(), { finalized: true, reason: 'close_requested', usageSeconds: 45.8 });
});

test('unsolicited final close notifies owner once and remains finalized after socket error', async t => {
  const notices: unknown[] = [];
  const f = fixture(t, { onDisconnect: result => notices.push(result) });
  const connection = await createGptLiveWebRtcSession(f.options);
  f.socket.receive({ type: 'session.closed', reason: 'connection_lost', usage: { seconds: 7 } });
  f.socket.emit('error', new Error(TEST_KEY));
  assert.deepEqual(await connection.close(), { finalized: true, reason: 'connection_lost', usageSeconds: 7 });
  assert.equal(notices.length, 1);
});

test('close timeout reports unconfirmed usage and waits for best-effort hangup cleanup', async t => {
  const f = fixture(t);
  const connection = await createGptLiveWebRtcSession(f.options);
  f.socket.receive({ type: 'session.usage.updated', usage: { seconds: 9 } });
  assert.deepEqual(await connection.close(), { finalized: false, reason: 'close_timeout', usageSeconds: 9, hangupAcknowledged: true });
  assert.equal(f.socket.terminated, true);
  assert.ok(f.calls[1]!.url.endsWith('/live_opaque%3A123%2Fx/hangup'));
  assert.equal(f.calls[1]!.init.body, undefined);
});

test('socket loss cannot be mistaken for finalization and failed hangup is explicit', async t => {
  const f = fixture(t);
  const originalFetch = f.options.fetch!;
  f.options.fetch = async (url, init) => String(url).endsWith('/hangup')
    ? new Response(TEST_KEY, { status: 503 }) : originalFetch(url, init);
  const connection = await createGptLiveWebRtcSession(f.options);
  f.socket.close();
  assert.deepEqual(await connection.close(), { finalized: false, reason: 'connection_closed', hangupAcknowledged: false });
});

test('attach errors and timeouts terminate local socket and hang up created session', async t => {
  for (const scenario of ['error', 'timeout']) {
    const f = fixture(t);
    f.options.webSocketFactory = () => {
      if (scenario === 'error') queueMicrotask(() => f.socket.emit('error', new Error(TEST_KEY)));
      return f.socket as unknown as GptLiveSocket;
    };
    await assert.rejects(createGptLiveWebRtcSession(f.options), error => {
      assert.ok(error instanceof GptLiveProviderError);
      assert.ok(!String(error).includes(TEST_KEY));
      assert.match(error.code, /^attach_(failed|timeout)$/);
      return true;
    });
    assert.equal(f.socket.terminated, true);
    assert.equal(f.calls.length, 2);
    assert.ok(f.calls[1]!.url.endsWith('/hangup'));
  }
});

test('socket factory failure closes created session without propagating credentials', async t => {
  const f = fixture(t, { webSocketFactory: () => { throw new Error(TEST_KEY); } });
  await assert.rejects(createGptLiveWebRtcSession(f.options), error => {
    assert.equal(String(error), 'GptLiveProviderError: GPT-Live attach failed');
    return true;
  });
  assert.equal(f.calls.length, 2);
});

test('a socket lost in the opening turn cannot return a usable session', async t => {
  const f = fixture(t);
  f.options.webSocketFactory = () => {
    queueMicrotask(() => { f.socket.open(); f.socket.emit('error', new Error(TEST_KEY)); });
    return f.socket as unknown as GptLiveSocket;
  };
  await assert.rejects(createGptLiveWebRtcSession(f.options), /connection closed during attach/);
  assert.equal(f.socket.terminated, true);
  assert.equal(f.calls.length, 2);
});

test('hung hangup request is bounded and cannot turn a lost connection into success', async t => {
  const f = fixture(t);
  const originalFetch = f.options.fetch!;
  f.options.fetch = async (url, init) => String(url).endsWith('/hangup')
    ? new Promise<Response>(() => {}) : originalFetch(url, init);
  const connection = await createGptLiveWebRtcSession(f.options);
  f.socket.close();
  assert.deepEqual(await connection.close(), { finalized: false, reason: 'connection_closed', hangupAcknowledged: false });
  assert.equal(f.socket.terminated, true);
});

test('close and hangup use a short combined deadline independent of the creation timeout', async t => {
  const f = fixture(t, { requestTimeoutMs: 10_000, closeTimeoutMs: 15, hangupTimeoutMs: 25 });
  const originalFetch = f.options.fetch!;
  f.options.fetch = async (url, init) => String(url).endsWith('/hangup')
    ? new Promise<Response>(() => {}) : originalFetch(url, init);
  const connection = await createGptLiveWebRtcSession(f.options);
  const started = Date.now();
  const result = await connection.close();
  assert.equal(result.reason, 'close_timeout');
  assert.equal(result.hangupAcknowledged, false);
  assert.ok(Date.now() - started < 500, 'must not inherit the ten-second create deadline');
});

test('invalid SDP response still cleans up a known created session', async t => {
  const f = fixture(t);
  const originalFetch = f.options.fetch!;
  f.options.fetch = async (url, init) => String(url).endsWith('/hangup')
    ? originalFetch(url, init) : Response.json({ session: { id: 'live_test' }, transport: {} });
  await assert.rejects(createGptLiveWebRtcSession(f.options), /invalid session response/);
  assert.equal(f.calls[0]!.url, 'https://api.openai.com/v1/live/sessions/live_test/hangup');
});

test('HTTP failures and network errors do not expose upstream bodies or causes', async t => {
  for (const fetchImpl of [
    async () => new Response(`upstream private ${TEST_KEY}`, { status: 401 }),
    async () => { throw new Error(`headers Authorization: ${TEST_KEY}`); },
    async () => new Response(`not JSON ${TEST_KEY}`, { status: 200 }),
  ]) {
    const f = fixture(t, { fetch: fetchImpl });
    await assert.rejects(createGptLiveWebRtcSession(f.options), error => {
      assert.ok(error instanceof GptLiveProviderError);
      assert.ok(!String(error).includes(TEST_KEY));
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.equal(f.socketUrl(), undefined);
  }
});

test('request timeout aborts fetch and prevents indefinite startup', async t => {
  let signal: AbortSignal | null | undefined;
  const f = fixture(t, { fetch: async (_url, init) => {
    signal = init?.signal;
    return new Promise<Response>(() => {});
  } });
  await assert.rejects(createGptLiveWebRtcSession(f.options), /request timeout/);
  assert.equal(signal?.aborted, true);
});

test('scrubs provider error bodies but preserves safe command correlation', async t => {
  const f = fixture(t);
  await createGptLiveWebRtcSession(f.options);
  f.socket.receive({ type: 'error', body: TEST_KEY, error: {
    type: 'invalid_request_error', code: 'unknown_parameter', client_event_id: 'command_1',
    message: TEST_KEY, param: TEST_KEY,
  } });
  assert.deepEqual(f.events[0], { type: 'error', error: {
    type: 'invalid_request_error', code: 'unknown_parameter', client_event_id: 'command_1',
    message: 'GPT-Live rejected a session command.',
  } });
  assert.ok(!JSON.stringify(f.events).includes(TEST_KEY));
  f.socket.receive(closedEvent());
});

test('send errors and malformed events close resources with sanitized failure', async t => {
  for (const scenario of ['send', 'message']) {
    const f = fixture(t);
    const connection = await createGptLiveWebRtcSession(f.options);
    if (scenario === 'send') {
      f.socket.throwOnSend = true;
      assert.throws(() => connection.send({ type: 'session.thinking.append' }), /GPT-Live send failed/);
    } else {
      f.socket.emit('message', Buffer.from(`not json ${TEST_KEY}`));
    }
    const result = await connection.close();
    assert.equal(result.finalized, false);
    assert.equal(result.hangupAcknowledged, true);
    assert.equal(f.socket.terminated, true);
    assert.ok(!JSON.stringify(result).includes(TEST_KEY));
  }
});
