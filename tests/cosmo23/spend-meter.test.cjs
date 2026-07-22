'use strict';

// Phase 4 (R4) — run spend metering + budget.
//
// The meter reads usage from REAL provider responses at the seven leaf
// return sites where a response materializes (there is no single choke
// point — UnifiedClient.generate() covers most traffic, but the
// webSearch/reasoning/fast convenience methods route local, ollama-cloud,
// anthropic and minimax straight to the sub-clients, and provider
// fallbacks would be mislabeled at the boundary):
//   gpt5-client.js 2, chat-completions-client.js 2, anthropic-client.js 1,
//   unified-client.js 2 (generateXAI + generateCodex).
//
// Honesty contract: meter only what the provider reported; all-zero or
// missing usage counts as an unmetered call; USD exists only when a
// config-provided price table exists (spend.prices — NO hardcoded prices);
// persistence is debounced tmp+fsync+rename to <logsDir>/.spend.json,
// boot-resumed, and flushed bounded at shutdown.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  SpendMeter,
  getSpendMeter,
  resetSpendMeterForTests,
  recordCompletionSpend,
  extractUsageTokens,
  sanitizePriceTable,
  SPEND_FILENAME,
  SPEND_FILE_VERSION,
  DEFAULT_PERSIST_INTERVAL_MS,
} = require('../../cosmo23/engine/src/core/spend-meter');
const { GPT5Client } = require('../../cosmo23/engine/src/core/gpt5-client');
const { ChatCompletionsClient } = require('../../cosmo23/engine/src/core/chat-completions-client');
const AnthropicClient = require('../../cosmo23/engine/src/core/anthropic-client');
const { UnifiedClient } = require('../../cosmo23/engine/src/core/unified-client');
const { ConfigGenerator } = require('../../cosmo23/launcher/config-generator');

const quietLogger = { info() {}, warn() {}, error() {}, debug() {} };

function readSource(relPath) {
  return fsSync.readFileSync(path.resolve(__dirname, relPath), 'utf8');
}

function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

async function makeTmpDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cosmo23-spend-'));
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

async function waitFor(predicate, { timeoutMs = 4000, stepMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  return false;
}

// ---------------------------------------------------------------------------
// extractUsageTokens — the two verified shape families
// ---------------------------------------------------------------------------

test('extractUsageTokens handles both provider usage shape families honestly', () => {
  // Responses-style (OpenAI/GPT5Client, xAI, Codex, Anthropic, normalized CC streaming)
  assert.deepEqual(
    extractUsageTokens({ input_tokens: 120, output_tokens: 30, total_tokens: 150 }),
    { inputTokens: 120, outputTokens: 30 },
  );
  // Anthropic carries no total_tokens — still metered
  assert.deepEqual(
    extractUsageTokens({ input_tokens: 500, output_tokens: 42 }),
    { inputTokens: 500, outputTokens: 42 },
  );
  // Chat-completions RAW shape (ChatCompletionsClient non-streaming)
  assert.deepEqual(
    extractUsageTokens({ prompt_tokens: 77, completion_tokens: 33, total_tokens: 110 }),
    { inputTokens: 77, outputTokens: 33 },
  );
  // Missing usage => no data, never an estimate
  assert.equal(extractUsageTokens(null), null);
  assert.equal(extractUsageTokens(undefined), null);
  assert.equal(extractUsageTokens({}), null);
  // All-zero usage (Codex zero-fill, Anthropic error responses) => no data
  assert.equal(extractUsageTokens({ input_tokens: 0, output_tokens: 0, total_tokens: 0 }), null);
  // Partial data is still data
  assert.deepEqual(
    extractUsageTokens({ output_tokens: 5 }),
    { inputTokens: 0, outputTokens: 5 },
  );
  // Garbage never throws, never counts
  assert.equal(extractUsageTokens({ input_tokens: 'NaNish', output_tokens: -4 }), null);
});

// ---------------------------------------------------------------------------
// recordUsage accumulation + unmetered counting
// ---------------------------------------------------------------------------

test('recordUsage accumulates per provider/model and counts unmetered calls honestly', () => {
  const meter = new SpendMeter();
  meter.recordUsage({ provider: 'openai', model: 'gpt-5.2', inputTokens: 100, outputTokens: 10 });
  meter.recordUsage({ provider: 'openai', model: 'gpt-5.2', inputTokens: 50, outputTokens: 5 });
  meter.recordUsage({ provider: 'openai', model: 'gpt-5-mini', inputTokens: 20, outputTokens: 2 });
  meter.recordUsage({ provider: 'anthropic', model: 'claude-sonnet-4-7', inputTokens: 7, outputTokens: 3 });
  meter.recordUsage({ provider: 'openai', model: 'gpt-5.2', unmetered: true });
  meter.recordUsage({ provider: 'xai', model: 'grok-4.5', inputTokens: 0, outputTokens: 0 });

  const snapshot = meter.getSnapshot();
  assert.equal(snapshot.totals.inputTokens, 177);
  assert.equal(snapshot.totals.outputTokens, 20);
  assert.equal(snapshot.totals.totalTokens, 197);
  assert.equal(snapshot.totals.meteredCalls, 4);
  assert.equal(snapshot.unmeteredCalls, 2);
  assert.equal(snapshot.byProvider.openai.models['gpt-5.2'].inputTokens, 150);
  assert.equal(snapshot.byProvider.openai.models['gpt-5.2'].meteredCalls, 2);
  assert.equal(snapshot.byProvider.openai.models['gpt-5-mini'].outputTokens, 2);
  assert.equal(snapshot.byProvider.openai.unmeteredCalls, 1);
  assert.equal(snapshot.byProvider.xai.unmeteredCalls, 1);
  assert.equal(snapshot.byProvider.xai.meteredCalls, 0);
  assert.equal(snapshot.byProvider.anthropic.totalTokens, 10);

  // Snapshot is a copy — mutating it never touches the meter (R3: computed,
  // not stored authority).
  snapshot.totals.inputTokens = 999999;
  snapshot.byProvider.openai.models['gpt-5.2'].inputTokens = 999999;
  const again = meter.getSnapshot();
  assert.equal(again.totals.inputTokens, 177);
  assert.equal(again.byProvider.openai.models['gpt-5.2'].inputTokens, 150);

  // Hostile provider keys stay plain own keys (Object.create(null) maps).
  meter.recordUsage({ provider: '__proto__', model: 'x', inputTokens: 1, outputTokens: 1 });
  assert.equal(meter.getSnapshot().byProvider.__proto__.inputTokens, 1);
  assert.equal({}.inputTokens, undefined);
});

test('recordCompletionSpend prefers identity on the result and never throws', () => {
  const meter = resetSpendMeterForTests();

  // result.provider (chat-completions/codex results) wins over the fallback label
  const ccResult = {
    provider: 'ollama-cloud',
    model: 'nemotron-3-super',
    usage: { input_tokens: 11, output_tokens: 4, total_tokens: 15 },
  };
  assert.equal(recordCompletionSpend(ccResult, 'local', 'other-model'), ccResult);
  assert.equal(meter.getSnapshot().byProvider['ollama-cloud'].models['nemotron-3-super'].inputTokens, 11);

  // No provider on the result => fallback label attributes the spend
  recordCompletionSpend(
    { model: 'gpt-5.2-test', usage: { input_tokens: 9, output_tokens: 1 } },
    'openai',
    'requested-model',
  );
  assert.equal(meter.getSnapshot().byProvider.openai.models['gpt-5.2-test'].totalTokens, 10);

  // Missing usage => unmetered, result still returned unchanged
  const bare = { content: 'x', model: 'm' };
  assert.equal(recordCompletionSpend(bare, 'xai', 'm'), bare);
  assert.equal(meter.getSnapshot().byProvider.xai.unmeteredCalls, 1);

  // Codex-style zero-fill => unmetered
  recordCompletionSpend(
    { provider: 'openai-codex', model: 'gpt-5.3-codex', usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } },
    'openai-codex',
    'gpt-5.3-codex',
  );
  assert.equal(meter.getSnapshot().byProvider['openai-codex'].unmeteredCalls, 1);

  // Non-object results pass through untouched
  assert.equal(recordCompletionSpend(null, 'openai'), null);
  assert.equal(recordCompletionSpend('text', 'openai'), 'text');
});

// ---------------------------------------------------------------------------
// Real client leaves feed the meter (prototype-driven fakes, real code paths)
// ---------------------------------------------------------------------------

test('GPT5Client.generate meters real OpenAI Responses usage at the leaf', async (t) => {
  const meter = resetSpendMeterForTests();
  const previousOauth = process.env.OPENAI_OAUTH_ENABLED;
  delete process.env.OPENAI_OAUTH_ENABLED;
  t.after(() => {
    if (previousOauth !== undefined) process.env.OPENAI_OAUTH_ENABLED = previousOauth;
  });

  const fakeClient = {
    responses: {
      stream: async () => (async function* stream() {
        yield { type: 'response.output_text.delta', delta: 'hello from the openai fixture' };
        yield {
          type: 'response.completed',
          response: {
            id: 'resp_fixture_1',
            model: 'gpt-5.2-test',
            usage: { input_tokens: 111, output_tokens: 22, total_tokens: 133 },
            output: [],
          },
        };
      })(),
    },
  };

  const client = new GPT5Client(quietLogger, fakeClient);
  const result = await client.generate({ model: 'gpt-5.2-test', input: 'ping', maxTokens: 64 });
  assert.equal(result.content, 'hello from the openai fixture');

  const bucket = meter.getSnapshot().byProvider.openai;
  assert.ok(bucket, 'openai bucket exists');
  assert.equal(bucket.models['gpt-5.2-test'].inputTokens, 111);
  assert.equal(bucket.models['gpt-5.2-test'].outputTokens, 22);
  assert.equal(bucket.meteredCalls, 1);
  assert.equal(meter.getSnapshot().unmeteredCalls, 0);
});

test('ChatCompletionsClient non-streaming meters RAW prompt/completion token usage', async () => {
  const meter = resetSpendMeterForTests();
  const fakeSdk = {
    chat: {
      completions: {
        create: async () => ({
          id: 'cc_fixture_1',
          model: 'nemotron-3-super',
          choices: [{
            message: { content: 'ollama cloud fixture reply with plenty of words' },
            finish_reason: 'stop',
          }],
          usage: { prompt_tokens: 77, completion_tokens: 33, total_tokens: 110 },
        }),
      },
    },
  };

  const client = new ChatCompletionsClient({
    providerId: 'ollama-cloud',
    client: fakeSdk,
    supportsStreaming: false,
    supportsTools: false,
    modelMapping: {},
  }, quietLogger);

  const result = await client.generate({
    model: 'nemotron-3-super',
    input: 'ping',
    maxOutputTokens: 256,
  });
  assert.equal(result.status, 'complete');
  assert.equal(result.provider, 'ollama-cloud');

  const bucket = meter.getSnapshot().byProvider['ollama-cloud'];
  assert.equal(bucket.models['nemotron-3-super'].inputTokens, 77);
  assert.equal(bucket.models['nemotron-3-super'].outputTokens, 33);
  assert.equal(bucket.meteredCalls, 1);
});

test('ChatCompletionsClient streaming without server usage counts an unmetered call', async () => {
  const meter = resetSpendMeterForTests();
  const fakeSdk = {
    chat: {
      completions: {
        // Async-iterable stream whose chunks never carry usage — the common
        // OpenAI-compatible default when stream_options.include_usage is not
        // sent (the engine payload does not send it).
        create: async () => (async function* stream() {
          yield { id: 'cc_s1', model: 'llama3.1:70b', choices: [{ delta: { content: 'streamed fixture content here' } }] };
          yield { id: 'cc_s1', model: 'llama3.1:70b', choices: [{ delta: {}, finish_reason: 'stop' }] };
        })(),
      },
    },
  };

  const client = new ChatCompletionsClient({
    providerId: 'local',
    client: fakeSdk,
    supportsStreaming: true,
    supportsTools: false,
    modelMapping: {},
  }, quietLogger);

  const result = await client.generate({
    model: 'llama3.1:70b',
    input: 'ping',
    maxOutputTokens: 256,
  });
  assert.equal(result.status, 'complete');
  assert.equal(result.usage, null, 'no usage on the wire => null usage, never estimated');

  const snapshot = meter.getSnapshot();
  assert.equal(snapshot.unmeteredCalls, 1);
  assert.equal(snapshot.byProvider.local.unmeteredCalls, 1);
  assert.equal(snapshot.totals.meteredCalls, 0);
});

test('AnthropicClient stream processor meters message_start input + accumulated output deltas', async () => {
  const meter = resetSpendMeterForTests();
  const client = new AnthropicClient({ providerId: 'anthropic' }, quietLogger);

  async function* anthropicStream() {
    yield { type: 'message_start', message: { id: 'msg_1', model: 'claude-sonnet-4-7', usage: { input_tokens: 500 } } };
    yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'anthropic fixture text' } };
    yield { type: 'message_delta', usage: { output_tokens: 41 } };
    yield { type: 'message_delta', usage: { output_tokens: 1 } };
    yield { type: 'message_stop' };
  }

  const result = await client._streamResponseWithWebSearch(anthropicStream(), { model: 'claude-sonnet-4-7' });
  assert.equal(result.content, 'anthropic fixture text');
  assert.equal(result.hadError, false);

  const bucket = meter.getSnapshot().byProvider.anthropic;
  assert.equal(bucket.models['claude-sonnet-4-7'].inputTokens, 500);
  assert.equal(bucket.models['claude-sonnet-4-7'].outputTokens, 42);
  assert.equal(bucket.meteredCalls, 1);

  // The same class with providerId 'minimax' attributes to minimax — the
  // providerId keeps Anthropic-compatible providers honestly separated.
  const minimax = new AnthropicClient({ providerId: 'minimax' }, quietLogger);
  await minimax._streamResponseWithWebSearch((async function* stream() {
    yield { type: 'message_start', message: { id: 'msg_2', model: 'MiniMax-M3', usage: { input_tokens: 10 } } };
    yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'mm' } };
    yield { type: 'message_delta', usage: { output_tokens: 2 } };
    yield { type: 'message_stop' };
  })(), { model: 'MiniMax-M3' });
  assert.equal(meter.getSnapshot().byProvider.minimax.models['MiniMax-M3'].totalTokens, 12);
});

test('UnifiedClient.generateXAI meters the xAI leaf (and absent usage stays unmetered)', async () => {
  const meter = resetSpendMeterForTests();
  const uc = new UnifiedClient(null, quietLogger);

  uc.xai = {
    responses: {
      stream: async () => (async function* stream() {
        yield { type: 'response.output_text.delta', delta: 'grok fixture reply' };
        yield {
          type: 'response.completed',
          response: { id: 'xai_1', usage: { input_tokens: 9, output_tokens: 4, total_tokens: 13 }, output: null },
        };
      })(),
    },
  };
  const metered = await uc.generateXAI({ model: 'grok-4-test', provider: 'xai' }, { input: 'ping', maxTokens: 64 });
  assert.equal(metered.content, 'grok fixture reply');
  assert.equal(meter.getSnapshot().byProvider.xai.models['grok-4-test'].totalTokens, 13);

  // Stream that dies before response.completed => no usage => unmetered.
  uc.xai = {
    responses: {
      stream: async () => (async function* stream() {
        yield { type: 'response.output_text.delta', delta: 'partial' };
      })(),
    },
  };
  await uc.generateXAI({ model: 'grok-4-test', provider: 'xai' }, { input: 'ping', maxTokens: 64 });
  const snapshot = meter.getSnapshot();
  assert.equal(snapshot.byProvider.xai.unmeteredCalls, 1);
  assert.equal(snapshot.byProvider.xai.meteredCalls, 1);
});

// ---------------------------------------------------------------------------
// Persistence: debounced tmp+rename, boot resume, corrupt-aside, bounded flush
// ---------------------------------------------------------------------------

test('debounced persistence writes one .spend.json per window and resumes on boot', async (t) => {
  const dir = await makeTmpDir(t);
  const meter = new SpendMeter();
  meter.configure({ logsDir: dir, spendConfig: { persistIntervalMs: 50 }, logger: quietLogger });
  assert.equal(meter.persistIntervalMs, 50);

  // Three rapid records inside one debounce window => exactly one write.
  meter.recordUsage({ provider: 'openai', model: 'gpt-5.2', inputTokens: 10, outputTokens: 1 });
  meter.recordUsage({ provider: 'openai', model: 'gpt-5.2', inputTokens: 20, outputTokens: 2 });
  meter.recordUsage({ provider: 'anthropic', model: 'claude-sonnet-4-7', unmetered: true });
  assert.equal(meter.persistCount, 0, 'debounce holds the first write back');

  const spendPath = path.join(dir, SPEND_FILENAME);
  assert.ok(await waitFor(() => meter.persistCount === 1), 'one debounced write lands');
  const persisted = JSON.parse(await fs.readFile(spendPath, 'utf8'));
  assert.equal(persisted.version, SPEND_FILE_VERSION);
  assert.equal(persisted.totals.inputTokens, 30);
  assert.equal(persisted.totals.meteredCalls, 2);
  assert.equal(persisted.unmeteredCalls, 1);
  assert.equal(persisted.byProvider.openai.models['gpt-5.2'].outputTokens, 3);
  assert.equal(meter.persistCount, 1, 'three records, one write');

  // A later record re-arms the debounce for a second write.
  meter.recordUsage({ provider: 'openai', model: 'gpt-5.2', inputTokens: 5, outputTokens: 5 });
  assert.ok(await waitFor(() => meter.persistCount === 2), 'second window persists');

  // No stray tmp files after rename.
  const leftovers = (await fs.readdir(dir)).filter((name) => name.includes('.tmp-'));
  assert.deepEqual(leftovers, []);

  // Boot resume: a fresh meter absorbs the cumulative file exactly once.
  const rebooted = new SpendMeter();
  rebooted.configure({ logsDir: dir, spendConfig: {}, logger: quietLogger });
  assert.equal(rebooted.persistIntervalMs, DEFAULT_PERSIST_INTERVAL_MS);
  const outcome = await rebooted.resumeFromDisk();
  assert.deepEqual(outcome, { resumed: true });
  const snapshot = rebooted.getSnapshot();
  assert.equal(snapshot.totals.inputTokens, 35);
  assert.equal(snapshot.totals.outputTokens, 8);
  assert.equal(snapshot.totals.meteredCalls, 3);
  assert.equal(snapshot.unmeteredCalls, 1);
  assert.equal(snapshot.resumed, true);

  // Second resume is a guarded no-op — never double-counts.
  const second = await rebooted.resumeFromDisk();
  assert.equal(second.resumed, false);
  assert.equal(second.reason, 'already_resumed');
  assert.equal(rebooted.getSnapshot().totals.inputTokens, 35);
});

test('a corrupt .spend.json is preserved aside (never deleted) and metering starts fresh', async (t) => {
  const dir = await makeTmpDir(t);
  const spendPath = path.join(dir, SPEND_FILENAME);
  await fs.writeFile(spendPath, '{{{ not json', 'utf8');

  const meter = new SpendMeter();
  meter.configure({ logsDir: dir, spendConfig: { persistIntervalMs: 30 }, logger: quietLogger });
  const outcome = await meter.resumeFromDisk();
  assert.equal(outcome.resumed, false);
  assert.equal(outcome.reason, 'corrupt_preserved_aside');

  const names = await fs.readdir(dir);
  const aside = names.filter((name) => name.startsWith(`${SPEND_FILENAME}.corrupt-`));
  assert.equal(aside.length, 1, 'corrupt file preserved aside');
  assert.equal(
    await fs.readFile(path.join(dir, aside[0]), 'utf8'),
    '{{{ not json',
    'preserved byte-exact',
  );

  // Metering continues fresh and re-creates the file.
  meter.recordUsage({ provider: 'openai', model: 'gpt-5.2', inputTokens: 3, outputTokens: 1 });
  assert.ok(await waitFor(() => meter.persistCount === 1));
  const persisted = JSON.parse(await fs.readFile(spendPath, 'utf8'));
  assert.equal(persisted.totals.totalTokens, 4);

  // Absent file is a clean no-resume.
  const emptyMeter = new SpendMeter();
  emptyMeter.configure({ logsDir: path.join(dir, 'nowhere'), spendConfig: {} });
  await fs.mkdir(path.join(dir, 'nowhere'), { recursive: true });
  assert.deepEqual(await emptyMeter.resumeFromDisk(), { resumed: false, reason: 'no_file' });
});

test('flushForShutdown persists the dirty window and is honestly bounded', async (t) => {
  const dir = await makeTmpDir(t);
  const meter = new SpendMeter();
  // Interval far beyond the test so only the shutdown flush can write.
  meter.configure({ logsDir: dir, spendConfig: { persistIntervalMs: 600000 }, logger: quietLogger });
  meter.recordUsage({ provider: 'openai', model: 'gpt-5.2', inputTokens: 40, outputTokens: 2 });
  assert.equal(meter.persistCount, 0);

  const outcome = await meter.flushForShutdown(2000);
  assert.equal(outcome.status, 'ok');
  assert.equal(meter.persistCount, 1);
  const persisted = JSON.parse(await fs.readFile(path.join(dir, SPEND_FILENAME), 'utf8'));
  assert.equal(persisted.totals.inputTokens, 40);

  // Nothing new => clean, no second write.
  assert.deepEqual(await meter.flushForShutdown(2000), { status: 'clean' });
  assert.equal(meter.persistCount, 1);

  // A wedged fs cannot stall shutdown: the flush resolves at the bound.
  const wedged = new SpendMeter();
  wedged.configure({ logsDir: dir, spendConfig: { persistIntervalMs: 600000 }, logger: quietLogger });
  wedged.recordUsage({ provider: 'openai', model: 'gpt-5.2', inputTokens: 1, outputTokens: 1 });
  wedged._persistNow = () => new Promise(() => {});
  const bounded = await wedged.flushForShutdown(60);
  assert.equal(bounded.status, 'timeout');

  // An unconfigured meter (no logsDir) skips without touching disk.
  const unbound = new SpendMeter();
  unbound.recordUsage({ provider: 'openai', model: 'gpt-5.2', inputTokens: 1, outputTokens: 1 });
  assert.deepEqual(await unbound.flushForShutdown(50), { status: 'skipped', reason: 'not_configured' });
});

// ---------------------------------------------------------------------------
// USD + budget: config-provided price table only, never hardcoded
// ---------------------------------------------------------------------------

test('USD is null without a price table and computed exactly with one — no hardcoded prices', () => {
  // No price table => token metering only, usd null, lane reads 'unpriced'.
  const bare = new SpendMeter();
  bare.recordUsage({ provider: 'openai', model: 'gpt-5.2', inputTokens: 1000, outputTokens: 100 });
  const bareSnapshot = bare.getSnapshot();
  assert.equal(bareSnapshot.usd, null);
  assert.equal(bareSnapshot.budget.usdState, 'unpriced');
  assert.equal(bareSnapshot.budget.overUsd, null);
  assert.equal(bareSnapshot.budget.maxTokens, null);
  assert.equal(bareSnapshot.budget.overTokens, null);

  // With a table: exact "provider/model" match, "provider" fallback, and an
  // honest unpriced-bucket listing for everything else.
  const meter = new SpendMeter();
  meter.configure({
    spendConfig: {
      maxTokens: 100,
      maxUsd: 5,
      prices: {
        'openai/gpt-5.2-test': { inPerMTok: 2, outPerMTok: 10 },
        anthropic: { inPerMTok: 3, outPerMTok: 15 },
      },
    },
    logger: quietLogger,
  });
  meter.recordUsage({ provider: 'openai', model: 'gpt-5.2-test', inputTokens: 1000000, outputTokens: 100000 });
  meter.recordUsage({ provider: 'anthropic', model: 'claude-sonnet-4-7', inputTokens: 1000000, outputTokens: 200000 });
  meter.recordUsage({ provider: 'xai', model: 'grok-4-test', inputTokens: 10, outputTokens: 10 });

  const snapshot = meter.getSnapshot();
  // openai: (1e6*2 + 1e5*10)/1e6 = 3; anthropic: (1e6*3 + 2e5*15)/1e6 = 6
  assert.equal(snapshot.usd.total, 9);
  assert.equal(snapshot.usd.pricedBuckets, 2);
  assert.deepEqual(snapshot.usd.unpricedBuckets, ['xai/grok-4-test']);
  assert.equal(snapshot.budget.usdState, 'priced');
  assert.equal(snapshot.budget.overUsd, true);
  assert.equal(snapshot.budget.overTokens, true);
  assert.ok(snapshot.budget.tokensFractionUsed > 1);
  assert.equal(snapshot.budget.usdFractionUsed, 9 / 5);

  // Price table sanitizer drops garbage and keeps only usable entries.
  // (It returns a null-prototype map so hostile keys like 'constructor'
  // can never resolve through Object.prototype — compare structurally.)
  assert.equal(sanitizePriceTable(null), null);
  assert.equal(sanitizePriceTable({ '': { inPerMTok: 1 } }), null);
  assert.equal(sanitizePriceTable({ 'openai/gpt-5.2': { inPerMTok: 'NaNish' } }), null);
  const sanitized = sanitizePriceTable({ 'openai/gpt-5.2': { inPerMTok: 1.25, outPerMTok: 10, junk: 4 } });
  assert.equal(Object.getPrototypeOf(sanitized), null);
  assert.deepEqual(
    JSON.parse(JSON.stringify(sanitized)),
    { 'openai/gpt-5.2': { inPerMTok: 1.25, outPerMTok: 10 } },
  );
});

// ---------------------------------------------------------------------------
// Launch surface: spend.* survives the sentinel's metadata.json replay
// ---------------------------------------------------------------------------

test('ConfigGenerator emits the spend block from launch settings (null-safe)', async (t) => {
  const dir = await makeTmpDir(t);
  const generator = new ConfigGenerator(dir, quietLogger);

  const yaml = await generator.generateConfig({
    spend_max_tokens: 123456,
    spend_max_usd: 12.5,
    spend_prices: { 'openai/gpt-5.2': { inPerMTok: 1.25, outPerMTok: 10 } },
  });
  assert.match(yaml, /\nspend:\n  maxTokens: 123456\n  maxUsd: 12\.5\n  prices: /);
  assert.ok(yaml.includes('"openai/gpt-5.2":{"inPerMTok":1.25,"outPerMTok":10}'));

  // Absent keys => explicit nulls: metering without budget, USD unpriced.
  const bare = await generator.generateConfig({});
  assert.match(bare, /\nspend:\n  maxTokens: null\n  maxUsd: null\n  prices: null\n/);

  // Invalid values degrade to null — never silently coerced budgets.
  const junk = await generator.generateConfig({
    spend_max_tokens: 'not-a-number',
    spend_max_usd: -4,
    spend_prices: { '': { inPerMTok: 1 } },
  });
  assert.match(junk, /\nspend:\n  maxTokens: null\n  maxUsd: null\n  prices: null\n/);
});

test('launch payload spend keys round-trip through serialize -> metadata.json -> replay (source contract)', () => {
  const serverSource = readSource('../../cosmo23/server/index.js');

  // serializeLaunchSettings reads camelCase payload keys (also what the
  // sentinel replays back out of metadata.json).
  assert.equal(countOccurrences(serverSource, 'spend_max_tokens: parseSpendLimit(payload.spendMaxTokens)'), 1);
  assert.equal(countOccurrences(serverSource, 'spend_max_usd: parseSpendLimit(payload.spendMaxUsd)'), 1);
  assert.equal(countOccurrences(serverSource, 'spend_prices: sanitizeSpendPrices(payload.spendPrices)'), 1);

  // writeRuntimeMetadata persists the camelCase keys into metadata.json —
  // the exact file createContinuationRelauncher spreads into the replay
  // payload (Patch 71 sentinel machinery).
  assert.equal(countOccurrences(serverSource, 'spendMaxTokens: launchSettings.spend_max_tokens'), 1);
  assert.equal(countOccurrences(serverSource, 'spendMaxUsd: launchSettings.spend_max_usd'), 1);
  assert.equal(countOccurrences(serverSource, 'spendPrices: launchSettings.spend_prices'), 1);

  // config-generator carries the snake_case keys into the engine YAML.
  const generatorSource = readSource('../../cosmo23/launcher/config-generator.js');
  assert.equal(countOccurrences(generatorSource, 'spend_max_tokens = null'), 1);
  assert.equal(countOccurrences(generatorSource, 'spend_max_usd = null'), 1);
  assert.equal(countOccurrences(generatorSource, 'spend_prices = null'), 1);
  assert.equal(countOccurrences(generatorSource, 'spend:\n  maxTokens: ${spendMaxTokensYaml}'), 1);
});

// ---------------------------------------------------------------------------
// Wiring pins: leaf metering sites + orchestrator lifecycle, exactly once
// ---------------------------------------------------------------------------

test('the seven leaf metering sites exist exactly once each — no double counting', () => {
  const gpt5Source = readSource('../../cosmo23/engine/src/core/gpt5-client.js');
  const ccSource = readSource('../../cosmo23/engine/src/core/chat-completions-client.js');
  const anthropicSource = readSource('../../cosmo23/engine/src/core/anthropic-client.js');
  const unifiedSource = readSource('../../cosmo23/engine/src/core/unified-client.js');

  assert.equal(countOccurrences(gpt5Source, 'recordCompletionSpend('), 2,
    'gpt5-client: success + error-shaped Responses returns');
  assert.equal(countOccurrences(ccSource, 'recordCompletionSpend('), 2,
    'chat-completions: streaming + non-streaming returns');
  assert.equal(countOccurrences(anthropicSource, 'recordCompletionSpend('), 1,
    'anthropic: the shared stream processor return');
  assert.equal(countOccurrences(unifiedSource, 'recordCompletionSpend('), 2,
    'unified: generateXAI + generateCodex leaves');

  // Each client imports the hook exactly once.
  for (const [name, source] of [
    ['gpt5-client', gpt5Source],
    ['chat-completions-client', ccSource],
    ['anthropic-client', anthropicSource],
    ['unified-client', unifiedSource],
  ]) {
    assert.equal(
      countOccurrences(source, "require('./spend-meter')"),
      1,
      `${name} requires spend-meter exactly once`,
    );
  }
});

test('orchestrator binds, resumes, exposes and flushes the meter exactly once each', () => {
  const orchestratorSource = readSource('../../cosmo23/engine/src/core/orchestrator.js');

  assert.equal(countOccurrences(orchestratorSource, 'this.spendMeter = getSpendMeter()'), 1);
  assert.equal(countOccurrences(orchestratorSource, 'this.spendMeter.configure({'), 1);
  assert.equal(countOccurrences(orchestratorSource, 'await this.spendMeter.resumeFromDisk()'), 1);
  assert.equal(countOccurrences(orchestratorSource, 'async flushSpendMeterForShutdown()'), 1);
  assert.equal(countOccurrences(orchestratorSource, 'await this.flushSpendMeterForShutdown()'), 1);
  assert.equal(
    countOccurrences(orchestratorSource, 'spend: this.spendMeter ? this.spendMeter.getSnapshot() : null'),
    1,
    'getStats exposes the additive spend snapshot',
  );
  // The flush is budget-capped by the same shutdown machinery as the ledger.
  assert.equal(
    countOccurrences(orchestratorSource, "shutdownBudgetMs(this.shutdownDeadline, this.config.shutdownSpendMeterTimeoutMs || 3000)"),
    1,
  );
  // The stop() ordering keeps the flush after the ledger close.
  const stopIndex = orchestratorSource.indexOf('await this.closeLedgerForShutdown();');
  const flushIndex = orchestratorSource.indexOf('await this.flushSpendMeterForShutdown();');
  assert.ok(stopIndex > 0 && flushIndex > stopIndex, 'spend flush runs after ledger close in stop()');
});

// ---------------------------------------------------------------------------
// Process-global singleton: many UnifiedClient instances, one meter
// ---------------------------------------------------------------------------

test('getSpendMeter is process-global — every client instance feeds one meter', () => {
  const meter = resetSpendMeterForTests();
  assert.equal(getSpendMeter(), meter);
  // base-agent, coordinators, summarizer, query-engine etc. each construct
  // their own UnifiedClient; the hook writes to the module singleton so the
  // run's spend stays whole.
  recordCompletionSpend({ model: 'a', usage: { input_tokens: 1, output_tokens: 1 } }, 'openai');
  recordCompletionSpend({ model: 'b', usage: { input_tokens: 2, output_tokens: 2 } }, 'xai');
  assert.equal(getSpendMeter().getSnapshot().totals.totalTokens, 6);
});

