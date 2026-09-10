import assert from 'node:assert/strict';
import express from 'express';
import { test } from 'node:test';
import { createTurnStartHandler } from '../../src/routes/chat-turn.js';

test('POST /api/chat/turn rejects whitespace-only message with 400 message required', async () => {
  const app = express();
  app.use(express.json());
  app.post('/api/chat/turn', createTurnStartHandler({
    agentName: 'scout',
    history: { loadRaw: () => [], append: () => {}, scanForRecovery: async () => null } as any,
    agent: {
      isRunning: () => false,
      runWithTurn: async () => ({ turnId: 't_x', response: null }),
      getModel: () => 'gpt-test',
      getReasoningEffort: () => 'medium',
      getProvider: () => 'openai',
    } as any,
  }));

  const body = await new Promise<any>((resolve, reject) => {
    const server = app.listen(0, async () => {
      try {
        const port = (server.address() as { port: number }).port;
        const response = await fetch(`http://127.0.0.1:${port}/api/chat/turn`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chatId: 'c1', message: '   \n\t  ' }),
        });
        resolve({ status: response.status, json: await response.json() });
      } catch (error) {
        reject(error);
      } finally {
        server.close();
      }
    });
  });

  assert.equal(body.status, 400);
  assert.equal(body.json.error, 'message required');
});
