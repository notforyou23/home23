import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createEvobrewChatHandler } from '../../src/routes/evobrew-bridge.js';

function makeFakeAgent(captured: {
  chatId?: string;
  userText?: string;
  onEventForwarded?: boolean;
}) {
  return {
    run: async () => {
      throw new Error('raw run forbidden');
    },
    runWithTurn: async (chatId: string, userText: string, options: {
      onEvent?: (event: { type: string; content?: string }) => void;
    }) => {
      captured.chatId = chatId;
      captured.userText = userText;
      captured.onEventForwarded = typeof options.onEvent === 'function';
      options.onEvent?.({ type: 'thinking', content: 'working' });
      return {
        turnId: 'evobrew-turn',
        response: Promise.resolve({
          text: 'ok', model: 'test', toolCallCount: 0, durationMs: 1,
        }),
      };
    },
  };
}

async function postSse(app: express.Express, body: unknown): Promise<{ status: number; text: string }> {
  return await new Promise((resolve, reject) => {
    const server = app.listen(0, async () => {
      try {
        const port = (server.address() as any).port;
        const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const text = await res.text();
        server.close();
        resolve({ status: res.status, text });
      } catch (err) {
        server.close();
        reject(err);
      }
    });
  });
}

test('evobrew bridge forwards structured IDE context to the local agent loop', async () => {
  const captured: { chatId?: string; userText?: string; onEventForwarded?: boolean } = {};
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.post('/api/chat', createEvobrewChatHandler({
    agentName: 'jerry',
    token: '',
    agent: makeFakeAgent(captured) as any,
  }));

  const res = await postSse(app, {
    chatId: 'evobrew:jerry:workspace123',
    context: {
      source: 'evobrew',
      currentFolder: '/tmp/project',
      fileName: 'src/app.ts',
      language: 'typescript',
      selectedText: 'const selected = true;',
      fileTreeContext: 'src/app.ts\npackage.json',
      brain: {
        enabled: true,
        name: 'JerryG-fork-jtr',
        path: '/brains/JerryG-fork-jtr',
        nodes: 1243,
      },
    },
    messages: [
      { role: 'system', content: 'ignored by this test' },
      { role: 'user', content: 'Use this context.' },
    ],
  });

  assert.equal(res.status, 200);
  assert.equal(captured.chatId, 'evobrew:jerry:workspace123');
  assert.equal(captured.onEventForwarded, true);
  assert.match(captured.userText || '', /\[Evobrew IDE Context\]/);
  assert.match(captured.userText || '', /Working directory: \/tmp\/project/);
  assert.match(captured.userText || '', /Open file: src\/app\.ts/);
  assert.match(captured.userText || '', /Language: typescript/);
  assert.match(captured.userText || '', /Connected brain: JerryG-fork-jtr \(1243 nodes, path: \/brains\/JerryG-fork-jtr\)/);
  assert.match(captured.userText || '', /Selected text:/);
  assert.match(captured.userText || '', /const selected = true;/);
  assert.match(captured.userText || '', /File tree:/);
  assert.match(captured.userText || '', /package\.json/);
  assert.match(captured.userText || '', /Use this context\./);
  assert.match(res.text, /data: \[DONE\]/);
  assert.match(res.text, /"type":"thinking"/);
});

test('evobrew bridge understands current Evobrew prompt labels as a fallback', async () => {
  const captured: { chatId?: string; userText?: string; onEventForwarded?: boolean } = {};
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.post('/api/chat', createEvobrewChatHandler({
    agentName: 'jerry',
    token: '',
    agent: makeFakeAgent(captured) as any,
  }));

  const res = await postSse(app, {
    systemPrompt: `**File**: src/main.js
**Language**: javascript
**Folder**: /tmp/current-evobrew
**Brain**: LiveBrain (55 nodes, path: /brains/live)

## Project Structure
src/main.js
README.md

## Operating Mode
General mode`,
    messages: [
      { role: 'user', content: 'What context do you have?' },
    ],
  });

  assert.equal(res.status, 200);
  assert.equal(captured.chatId, 'evobrew:jerry');
  assert.match(captured.userText || '', /Working directory: \/tmp\/current-evobrew/);
  assert.match(captured.userText || '', /Open file: src\/main\.js/);
  assert.match(captured.userText || '', /Language: javascript/);
  assert.match(captured.userText || '', /Connected brain: LiveBrain/);
  assert.match(captured.userText || '', /Project structure:/);
  assert.match(captured.userText || '', /README\.md/);
});
