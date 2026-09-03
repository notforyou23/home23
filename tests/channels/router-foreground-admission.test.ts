import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  BUSY_REPLY_TEXT,
  admitForegroundTurn,
  assertCanStartSpeaking,
  ForegroundTurnHeld,
} from '../../src/agent/foreground-admission.js';
import { SessionRouter, type IncomingMessage, type OutgoingResponse } from '../../src/channels/router.js';

function sessionsConfig(mode: 'direct' | 'collect' = 'direct') {
  return {
    threadBindings: { enabled: true, idleHours: 24 },
    messageQueue: {
      mode,
      debounceMs: 10,
      cap: 20,
      overflowStrategy: 'drop',
      adaptiveDebounce: false,
      queueDuringRun: true,
    },
  };
}

function message(text: string, chatId = 'ios_chat'): IncomingMessage {
  return {
    channel: 'webhook',
    chatId,
    senderId: 'jtr',
    senderName: 'jtr',
    text,
    timestamp: Date.now(),
  };
}

test('Work W1 stays active while M2 is accepted and a foreground turn starts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fg-router-'));
  const work = new Map<string, { status: string }>([['aw_w1', { status: 'running' }]]);
  const started: string[] = [];
  const replies: string[] = [];

  const handler = async (incoming: IncomingMessage): Promise<OutgoingResponse> => {
    const speakingActive = started.length > 0 && started.at(-1) === '__speaking__';
    const decision = admitForegroundTurn({
      speakingActive,
      workActive: work.get('aw_w1')?.status === 'running',
    });
    assert.equal(decision.accepted, true);
    assert.equal(decision.busyReply, null);
    assert.notEqual(incoming.text, BUSY_REPLY_TEXT);
    if (!decision.startSpeaking) throw new ForegroundTurnHeld();
    started.push(incoming.text);
    assert.equal(work.get('aw_w1')?.status, 'running');
    return { text: `answered:${incoming.text}`, channel: incoming.channel, chatId: incoming.chatId };
  };

  const router = new SessionRouter(sessionsConfig('direct'), handler, join(root, 'sessions'));
  router.registerAdapter({
    name: 'webhook',
    async start() {},
    async stop() {},
    async send(response) { replies.push(response.text); },
  });

  await router.handleMessage(message('M2 while W1 is running'));

  assert.deepEqual(started, ['M2 while W1 is running']);
  assert.deepEqual(replies, ['answered:M2 while W1 is running']);
  assert.equal(work.get('aw_w1')?.status, 'running');
  assert.equal(replies.includes(BUSY_REPLY_TEXT), false);
  rmSync(root, { recursive: true, force: true });
});

test('a second Message is accepted while speaking but does not start a second completion', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fg-router-hold-'));
  let releaseSpeaking!: () => void;
  const speaking = new Promise<void>((resolve) => { releaseSpeaking = resolve; });
  const started: string[] = [];
  const replies: string[] = [];
  const key = 'webhook:ios_chat';

  const handler = async (incoming: IncomingMessage): Promise<OutgoingResponse> => {
    router.markSpeakingActive(key);
    try {
      started.push(incoming.text);
      if (incoming.text === 'first') await speaking;
      return { text: `done:${incoming.text}`, channel: incoming.channel, chatId: incoming.chatId };
    } finally {
      router.markSpeakingComplete(key);
      await router.drainPending(key);
    }
  };

  const router = new SessionRouter(sessionsConfig('direct'), handler, join(root, 'sessions'));
  router.registerAdapter({
    name: 'webhook',
    async start() {},
    async stop() {},
    async send(response) { replies.push(response.text); },
  });

  const first = router.handleMessage(message('first'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ['first']);
  await router.handleMessage(message('second'));
  assert.deepEqual(started, ['first']);
  assert.equal(router.queueSizes.get(key), 1);
  releaseSpeaking();
  await first;
  assert.equal(started.includes('second'), true);
  assert.equal(replies.includes(BUSY_REPLY_TEXT), false);
  rmSync(root, { recursive: true, force: true });
});

test('queueDuringRun=false still serializes speaking turns', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fg-router-serialize-'));
  const started: string[] = [];
  const router = new SessionRouter({
    threadBindings: { enabled: true, idleHours: 24 },
    messageQueue: {
      mode: 'collect',
      debounceMs: 5,
      cap: 20,
      overflowStrategy: 'drop',
      adaptiveDebounce: false,
      queueDuringRun: false,
    },
  }, async (incoming) => {
    started.push(incoming.text);
    return { text: incoming.text, channel: incoming.channel, chatId: incoming.chatId };
  }, join(root, 'sessions'));

  router.markSpeakingActive('webhook:ios_chat');
  await router.handleMessage(message('held'));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(started, []);
  assert.equal(router.queueSizes.get('webhook:ios_chat'), 1);
  rmSync(root, { recursive: true, force: true });
});

test('home-style handler parks instead of busy-replying when speaking is already active', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fg-router-home-'));
  const replies: string[] = [];
  let speaking = false;

  const handler = async (incoming: IncomingMessage): Promise<OutgoingResponse> => {
    assertCanStartSpeaking({ speakingActive: speaking });
    speaking = true;
    return { text: `spoke:${incoming.text}`, channel: incoming.channel, chatId: incoming.chatId };
  };

  const router = new SessionRouter(sessionsConfig('direct'), handler, join(root, 'sessions'));
  router.registerAdapter({
    name: 'webhook',
    async start() {},
    async stop() {},
    async send(response) { replies.push(response.text); },
  });

  speaking = true;
  await router.handleMessage(message('M2'));
  assert.deepEqual(replies, []);
  assert.equal(replies.includes(BUSY_REPLY_TEXT), false);
  assert.equal(router.queueSizes.get('webhook:ios_chat'), 1);
  rmSync(root, { recursive: true, force: true });
});
