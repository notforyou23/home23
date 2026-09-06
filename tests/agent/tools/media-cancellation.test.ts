import test from 'node:test';
import assert from 'node:assert/strict';
import { TTSService } from '../../../src/observability/tts.js';
for (const provider of ['elevenlabs', 'minimax']) test(`${provider} speech propagates actual parent cancellation`, async (t) => {
  const controller = new AbortController();
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = (async (_url, input) => {
    assert.equal(input?.signal, controller.signal);
    return new Promise((_resolve, reject) => {
      input!.signal!.addEventListener('abort', () => reject(input!.signal!.reason), { once: true });
    });
  }) as typeof fetch;
  const service = new TTSService({ enabled: true, apiKey: 'fixture', provider, auto: 'tagged' } as never);
  const speech = service.speak('fixture', true, controller.signal);
  controller.abort(new Error('owner stopped'));
  await assert.rejects(speech, /owner stopped/);
});
