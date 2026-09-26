import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { DocumentConverter, PYTHON_FORMATS } = require('../../../engine/src/ingestion/document-converter');
const { resolveVisionTarget, callVisionModel } = require('../../../engine/src/ingestion/vision-ocr');

// Vision OCR used to call OpenAI with whatever model the provider-agnostic
// picker chose. It must go to the provider that owns the configured model,
// and a provider error must leave the file waiting, never quarantined.

const silentLogger = { info() {}, warn() {}, debug() {}, error() {} };
const ALL_MODULES = [...new Set(Object.values(PYTHON_FORMATS).flatMap(spec => spec.modules))];
const PROBE = JSON.stringify({ python: '3.12.4', markitdown: true, error: null,
  modules: Object.fromEntries(ALL_MODULES.map(m => [m, true])) });

const providers = {
  'MiniMax-M3': { providerName: 'minimax', baseUrl: 'https://api.minimax.io/anthropic', apiKey: undefined },
  'gpt-5.6-luna': { providerName: 'openai-codex', baseUrl: undefined, apiKey: undefined },
  'grok-4.5': { providerName: 'xai', baseUrl: 'https://api.x.ai/v1', apiKey: undefined },
};
const keys = { minimax: 'mm-key', 'openai-codex': 'codex-jwt', xai: 'xai-key', openai: 'sk-openai' };
const resolveProvider = model => providers[model] || null;

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-vision-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('the vision model is routed to the provider that lists it', () => {
  const resolveKey = provider => keys[provider] || '';
  const minimax = resolveVisionTarget('MiniMax-M3', { resolveProvider, resolveKey });
  assert.equal(minimax.provider, 'minimax');
  assert.equal(minimax.api, 'anthropic');
  assert.equal(minimax.baseURL, 'https://api.minimax.io/anthropic');
  assert.equal(minimax.apiKey, 'mm-key');
  assert.equal(minimax.hasCredentials, true);

  const codex = resolveVisionTarget('gpt-5.6-luna', { resolveProvider, resolveKey });
  assert.equal(codex.api, 'codex');
  assert.equal(codex.apiKey, null, 'the OAuth client resolves its own token');
  assert.equal(codex.hasCredentials, true);

  const xai = resolveVisionTarget('grok-4.5', { resolveProvider, resolveKey });
  assert.equal(xai.api, 'openai');
  assert.equal(xai.baseURL, 'https://api.x.ai/v1');

  // An unlisted model keeps the historical OpenAI routing.
  const legacy = resolveVisionTarget('gpt-4o-mini', { resolveProvider, resolveKey });
  assert.equal(legacy.provider, 'openai');
  assert.equal(legacy.baseURL, 'https://api.openai.com/v1');
  assert.equal(legacy.listed, false);

  const noKey = resolveVisionTarget('MiniMax-M3', { resolveProvider, resolveKey: () => '' });
  assert.equal(noKey.hasCredentials, false);
});

function visionConverter(t, { model = 'MiniMax-M3', visionCall, clock = { now: 0 }, resolveKey = provider => keys[provider] || '', ...rest } = {}) {
  return new DocumentConverter({
    logger: silentLogger,
    visionModel: model,
    pythonPath: '/nonexistent/python-for-images',
    visionResolver: m => resolveVisionTarget(m, { resolveProvider, resolveKey }),
    visionCall,
    now: () => clock.now,
    ...rest,
  });
}

test('an image is OCR\'d by the configured model through its own provider, with no python', async (t) => {
  const dir = tempDir(t);
  const image = path.join(dir, 'whiteboard.png');
  fs.writeFileSync(image, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const calls = [];
  const converter = visionConverter(t, {
    visionCall: async (args) => { calls.push(args); return '```markdown\n# Whiteboard\nShip 188\n```'; },
    execFileImpl: () => { throw new Error('images must not spawn python'); },
  });

  const result = await converter.convertDetailed(image);

  assert.equal(result.ok, true);
  assert.equal(result.text, '# Whiteboard\nShip 188');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].target.provider, 'minimax');
  assert.equal(calls[0].target.model, 'MiniMax-M3');
  assert.equal(calls[0].mimeType, 'image/png');
  assert.equal(calls[0].base64, Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'));
  assert.equal((await converter.checkHealth()).vision.state, 'ok');
});

test('a model error pauses image OCR without quarantining, then retries after the cooldown', async (t) => {
  const dir = tempDir(t);
  const first = path.join(dir, 'a.png');
  const second = path.join(dir, 'b.jpg');
  fs.writeFileSync(first, 'a');
  fs.writeFileSync(second, 'b');
  const clock = { now: 1_000 };
  let calls = 0;
  let fixed = false;
  const converter = visionConverter(t, {
    clock,
    visionCall: async () => {
      calls += 1;
      if (fixed) return 'text';
      const err = new Error("404 The model `MiniMax-M3` does not exist or you do not have access to it.");
      err.status = 404;
      throw err;
    },
  });

  const failed = await converter.convertDetailed(first);
  assert.equal(failed.ok, false);
  assert.equal(failed.status, 'converter_misconfigured');
  assert.equal(failed.retryable, true);
  assert.equal(failed.needs, 'vision');
  assert.match(failed.error, /^vision OCR \(minimax MiniMax-M3\): .*does not exist/);

  const paused = await converter.convertDetailed(second);
  assert.equal(paused.status, 'converter_misconfigured');
  assert.equal(calls, 1, 'a paused provider is not called once per waiting file');
  assert.equal(converter.canConvertNow(second, 'vision'), false);
  const health = await converter.checkHealth();
  assert.equal(health.vision.state, 'misconfigured');
  assert.equal(health.formats.images, false);
  assert.match(health.reason, /image OCR paused/);

  clock.now += 31 * 60 * 1000;
  fixed = true;
  assert.equal(converter.canConvertNow(second, 'vision'), true);
  assert.equal((await converter.convertDetailed(second)).ok, true);
  assert.equal(calls, 2);
});

test('a changed credential lifts a vision pause early; a missing one never calls', async (t) => {
  const dir = tempDir(t);
  const image = path.join(dir, 'a.png');
  fs.writeFileSync(image, 'a');
  const clock = { now: 0 };
  let key = 'old-key';
  let calls = 0;
  const converter = visionConverter(t, {
    clock,
    resolveKey: provider => (provider === 'minimax' ? key : ''),
    visionCall: async () => {
      calls += 1;
      if (key === 'old-key') throw Object.assign(new Error('invalid_api_key'), { status: 401 });
      return 'text';
    },
  });

  assert.equal((await converter.convertDetailed(image)).status, 'converter_misconfigured');
  key = 'new-key';
  clock.now += 31 * 1000; // past the target cache, well inside the pause
  assert.equal((await converter.convertDetailed(image)).ok, true);
  assert.equal(calls, 2);

  const keyless = visionConverter(t, { resolveKey: () => '', visionCall: async () => { throw new Error('must not call'); } });
  const result = await keyless.convertDetailed(image);
  assert.equal(result.status, 'converter_misconfigured');
  assert.equal(result.retryable, true);
  const health = await keyless.checkHealth();
  assert.equal(health.vision.state, 'no_credentials');
  assert.match(health.reason, /no credentials for minimax/);
});

test('a bad image is the file\'s fault; a rate limit is a short retryable pause', async (t) => {
  const dir = tempDir(t);
  const image = path.join(dir, 'a.webp');
  fs.writeFileSync(image, 'a');
  const bad = visionConverter(t, {
    visionCall: async () => { throw Object.assign(new Error('Invalid image: could not decode'), { status: 400 }); },
  });
  const badResult = await bad.convertDetailed(image);
  assert.equal(badResult.status, 'conversion_failed');
  assert.equal(badResult.retryable, false);

  const clock = { now: 0 };
  const limited = visionConverter(t, {
    clock,
    visionCall: async () => { throw Object.assign(new Error('Rate limit reached'), { status: 429 }); },
  });
  const limitedResult = await limited.convertDetailed(image);
  assert.equal(limitedResult.status, 'converter_unavailable');
  assert.equal(limitedResult.retryable, true);
  assert.equal(limited.canConvertNow(image, 'vision'), false);
  clock.now += 61 * 1000;
  assert.equal(limited.canConvertNow(image, 'vision'), true);
});

test('a scanned PDF is rendered with pdftoppm and each page OCR\'d by the configured provider', async (t) => {
  const dir = tempDir(t);
  const pdf = path.join(dir, 'scan.pdf');
  fs.writeFileSync(pdf, 'pdf without a text layer');
  const python = path.join(dir, 'python-stub');
  fs.writeFileSync(python, [
    '#!/bin/sh',
    `if [ "$1" = "-c" ]; then echo '${PROBE}'; exit 0; fi`,
    'echo "conversion produced empty text: scan.pdf" >&2',
    'exit 3',
    '',
  ].join('\n'), { mode: 0o755 });
  const pdftoppm = path.join(dir, 'pdftoppm-stub');
  // Last argument is the output prefix; write two page images there.
  fs.writeFileSync(pdftoppm, [
    '#!/bin/sh',
    'for last; do :; done',
    'printf page1 > "$last-1.png"',
    'printf page2 > "$last-2.png"',
    '',
  ].join('\n'), { mode: 0o755 });
  const pages = [];
  const converter = visionConverter(t, {
    pythonPath: python,
    pdftoppmPath: pdftoppm,
    visionCall: async ({ target, mimeType, base64 }) => {
      pages.push({ provider: target.provider, mimeType, page: Buffer.from(base64, 'base64').toString() });
      return `text of ${Buffer.from(base64, 'base64').toString()}`;
    },
  });

  const result = await converter.convertDetailed(pdf);

  assert.equal(result.ok, true);
  assert.equal(result.text, 'text of page1\n\ntext of page2');
  assert.deepEqual(pages, [
    { provider: 'minimax', mimeType: 'image/png', page: 'page1' },
    { provider: 'minimax', mimeType: 'image/png', page: 'page2' },
  ]);

  const noRenderer = visionConverter(t, { pythonPath: python, pdftoppmPath: null, visionCall: async () => 'x' });
  const waiting = await noRenderer.convertDetailed(pdf);
  assert.equal(waiting.status, 'converter_unavailable');
  assert.equal(waiting.retryable, true);
  assert.equal(waiting.needs, 'pdftoppm');
});

test('MarkItDown gets a vision client only when the model\'s provider speaks the OpenAI API', async (t) => {
  const dir = tempDir(t);
  const pptx = path.join(dir, 'deck.pptx');
  fs.writeFileSync(pptx, 'pptx');
  const envs = [];
  const execFileImpl = (_file, args, options, callback) => {
    if (args[0] === '-c') return callback(null, PROBE, '');
    envs.push(options.env);
    return callback(null, '# deck\n', '');
  };

  await visionConverter(t, { model: 'grok-4.5', execFileImpl, visionCall: async () => 'x' }).convertDetailed(pptx);
  await visionConverter(t, { model: 'MiniMax-M3', execFileImpl, visionCall: async () => 'x' }).convertDetailed(pptx);

  assert.equal(envs[0].HOME23_VISION_MODEL, 'grok-4.5');
  assert.equal(envs[0].HOME23_VISION_BASE_URL, 'https://api.x.ai/v1');
  assert.equal(envs[0].HOME23_VISION_API_KEY, 'xai-key');
  assert.equal(envs[0].MLM_MODEL, undefined);
  assert.equal(envs[1].HOME23_VISION_MODEL, undefined, 'an Anthropic-API model is never handed to the OpenAI client');
});

test('a provider error from MarkItDown\'s own image hook leaves the file waiting', async (t) => {
  const dir = tempDir(t);
  const pptx = path.join(dir, 'deck.pptx');
  fs.writeFileSync(pptx, 'pptx');
  const execFileImpl = (_file, args, _options, callback) => {
    if (args[0] === '-c') return callback(null, PROBE, '');
    const err = new Error('Command failed');
    err.code = 1;
    return callback(err, '', "openai.NotFoundError: Error code: 404 - {'error': {'code': 'model_not_found'}}");
  };
  const converter = visionConverter(t, { model: 'grok-4.5', execFileImpl, visionCall: async () => 'x' });

  const result = await converter.convertDetailed(pptx);

  assert.equal(result.status, 'converter_misconfigured');
  assert.equal(result.retryable, true);
});

test('the OpenAI-API and Anthropic-API calls carry the image in each API\'s own shape', async (t) => {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      requests.push({ url: req.url, auth: req.headers.authorization || req.headers['x-api-key'], body: JSON.parse(body) });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url.endsWith('/chat/completions')) {
        res.end(JSON.stringify({ id: 'c1', object: 'chat.completion', created: 0, model: 'grok-4.5',
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'openai-shaped text' } }] }));
      } else {
        res.end(JSON.stringify({ id: 'm1', type: 'message', role: 'assistant', model: 'MiniMax-M3', stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
          content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'anthropic-shaped text' }] }));
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const openaiText = await callVisionModel({
    target: { model: 'grok-4.5', provider: 'xai', api: 'openai', baseURL: `${base}/v1`, apiKey: 'xai-key' },
    prompt: 'read it', mimeType: 'image/png', base64: 'aW1n',
  });
  const anthropicText = await callVisionModel({
    target: { model: 'MiniMax-M3', provider: 'minimax', api: 'anthropic', baseURL: base, apiKey: 'mm-key' },
    prompt: 'read it', mimeType: 'image/jpeg', base64: 'aW1n',
  });

  assert.equal(openaiText, 'openai-shaped text');
  assert.equal(anthropicText, 'anthropic-shaped text');
  const [openaiRequest, anthropicRequest] = requests;
  assert.equal(openaiRequest.url, '/v1/chat/completions');
  assert.equal(openaiRequest.auth, 'Bearer xai-key');
  assert.equal(openaiRequest.body.model, 'grok-4.5');
  assert.deepEqual(openaiRequest.body.messages[0].content[1], { type: 'image_url', image_url: { url: 'data:image/png;base64,aW1n' } });
  assert.equal(anthropicRequest.url, '/v1/messages');
  assert.equal(anthropicRequest.auth, 'mm-key');
  assert.equal(anthropicRequest.body.model, 'MiniMax-M3');
  assert.deepEqual(anthropicRequest.body.messages[0].content[0], {
    type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'aW1n' },
  });
});
