'use strict';

/**
 * SpendMeter — Phase 4 (R4): run-level spend metering for COSMO23.
 *
 * One process-global meter accumulates token usage from REAL provider
 * responses. Metering happens at the seven leaf return sites where a
 * provider response actually materializes (verified 2026-07-22 — there is
 * no single choke point: UnifiedClient.generate() covers most traffic, but
 * generateWithWebSearch/generateWithReasoning/generateFast route local,
 * ollama-cloud, anthropic and minimax straight to the sub-clients, and
 * provider fallbacks would be mislabeled at the boundary):
 *
 *   gpt5-client.js            2 sites (success + error-shaped return; both
 *                             can carry real Responses-API usage)
 *   chat-completions-client.js 2 sites (streaming already normalized to
 *                             input_tokens/output_tokens — often null when
 *                             the server omits usage on stream; non-streaming
 *                             passes RAW prompt_tokens/completion_tokens)
 *   anthropic-client.js       1 site (_streamResponseWithWebSearch success —
 *                             generate() and generateWithWebSearch() both
 *                             funnel through it; providerId distinguishes
 *                             anthropic vs minimax)
 *   unified-client.js         2 sites (generateXAI, generateCodex)
 *
 * Honesty rules (R4): meter only what the provider reported. All-zero or
 * missing usage counts as an "unmetered call" — a real completion cannot
 * cost zero input tokens (Codex zero-fills when its stream never delivered
 * usage). Never estimate. Thrown/aborted calls return no result and are NOT
 * counted here — they surface via provider-error telemetry instead.
 *
 * Bounded by design (R1): the meter never throws into the hot path, never
 * deletes data (a corrupt .spend.json is preserved aside, never discarded),
 * writes only <logsDir>/.spend.json via tmp+fsync+rename on a debounced
 * unref'd timer, and its shutdown flush is budget-capped by the caller
 * (orchestrator.flushSpendMeterForShutdown — same pattern as
 * closeLedgerForShutdown).
 *
 * USD is computed ONLY from a config-provided price table
 * (config.spend.prices: { "provider/model" | "provider": { inPerMTok,
 * outPerMTok } }, prices per million tokens). No price table => usd: null
 * and budget.usdState 'unpriced'. NO hardcoded prices.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const SPEND_FILENAME = '.spend.json';
const SPEND_FILE_VERSION = 1;
const DEFAULT_PERSIST_INTERVAL_MS = 30000;
const MIN_PERSIST_INTERVAL_MS = 10;
const MAX_MODEL_BUCKETS_PER_PROVIDER = 200;
const MAX_PRICE_TABLE_ENTRIES = 64;
const MAX_KEY_LENGTH = 200;
const OVERFLOW_MODEL_KEY = '__other__';

function toFiniteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toNonNegativeInt(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.floor(parsed);
}

function normalizeKey(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, MAX_KEY_LENGTH);
}

function emptyBucket() {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0, meteredCalls: 0 };
}

function sanitizeCounters(raw) {
  const bucket = emptyBucket();
  if (raw && typeof raw === 'object') {
    bucket.inputTokens = toNonNegativeInt(raw.inputTokens) ?? 0;
    bucket.outputTokens = toNonNegativeInt(raw.outputTokens) ?? 0;
    bucket.totalTokens = toNonNegativeInt(raw.totalTokens)
      ?? (bucket.inputTokens + bucket.outputTokens);
    bucket.meteredCalls = toNonNegativeInt(raw.meteredCalls) ?? 0;
  }
  return bucket;
}

/**
 * Extract token counts from a provider usage object. Handles the two shape
 * families that actually cross the engine clients (read from the client
 * sources, 2026-07-22):
 *   Responses-style: { input_tokens, output_tokens[, total_tokens] }
 *     (GPT5Client/OpenAI, xAI, Codex-normalized, AnthropicClient,
 *      ChatCompletionsClient streaming-normalized)
 *   Chat-completions raw: { prompt_tokens, completion_tokens[, total_tokens] }
 *     (ChatCompletionsClient non-streaming passes response.usage through raw)
 * Returns { inputTokens, outputTokens } or null when no usable data exists.
 * All-zero usage is treated as no data — never estimated.
 */
function extractUsageTokens(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const input = toNonNegativeInt(
    usage.input_tokens ?? usage.prompt_tokens ?? usage.inputTokens,
  );
  const output = toNonNegativeInt(
    usage.output_tokens ?? usage.completion_tokens ?? usage.outputTokens,
  );
  if (input === null && output === null) return null;
  const inputTokens = input ?? 0;
  const outputTokens = output ?? 0;
  if (inputTokens === 0 && outputTokens === 0) return null;
  return { inputTokens, outputTokens };
}

function sanitizePriceTable(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const entries = Object.create(null);
  let count = 0;
  for (const [rawKey, rawPrice] of Object.entries(raw)) {
    if (count >= MAX_PRICE_TABLE_ENTRIES) break;
    const key = normalizeKey(rawKey);
    if (!key || !rawPrice || typeof rawPrice !== 'object') continue;
    const inPerMTok = toFiniteNumber(rawPrice.inPerMTok);
    const outPerMTok = toFiniteNumber(rawPrice.outPerMTok);
    const entry = {};
    if (inPerMTok !== null && inPerMTok >= 0) entry.inPerMTok = inPerMTok;
    if (outPerMTok !== null && outPerMTok >= 0) entry.outPerMTok = outPerMTok;
    if (Object.keys(entry).length === 0) continue;
    entries[key] = entry;
    count += 1;
  }
  return count > 0 ? entries : null;
}

class SpendMeter {
  constructor() {
    this.byProvider = Object.create(null);
    this.totals = emptyBucket();
    this.unmeteredCalls = 0;
    this.startedAt = null;
    this.updatedAt = null;
    this.persistCount = 0;
    this.resumed = false;
    this.persistPath = null;
    this.persistIntervalMs = DEFAULT_PERSIST_INTERVAL_MS;
    this.budget = { maxTokens: null, maxUsd: null };
    this.prices = null;
    this.logger = null;
    this._dirty = false;
    this._persistTimer = null;
    this._persistInFlight = null;
  }

  /**
   * Bind run-scoped persistence + budget config. Idempotent, never throws.
   * Safe to call after usage has already accumulated (pre-configure records
   * stay in memory and get flushed once a persistPath exists).
   */
  configure({ logsDir, spendConfig, logger } = {}) {
    try {
      if (logger) this.logger = logger;
      const cfg = spendConfig && typeof spendConfig === 'object' ? spendConfig : {};
      const interval = toFiniteNumber(cfg.persistIntervalMs);
      this.persistIntervalMs = interval !== null && interval >= MIN_PERSIST_INTERVAL_MS
        ? Math.floor(interval)
        : DEFAULT_PERSIST_INTERVAL_MS;
      const maxTokens = toFiniteNumber(cfg.maxTokens);
      const maxUsd = toFiniteNumber(cfg.maxUsd);
      this.budget = {
        maxTokens: maxTokens !== null && maxTokens > 0 ? maxTokens : null,
        maxUsd: maxUsd !== null && maxUsd > 0 ? maxUsd : null,
      };
      this.prices = sanitizePriceTable(cfg.prices);
      if (typeof logsDir === 'string' && logsDir) {
        this.persistPath = path.join(logsDir, SPEND_FILENAME);
        if (this._dirty) this._schedulePersist();
      }
    } catch (error) {
      this.logger?.debug?.('[SpendMeter] configure failed (non-fatal)', {
        error: error?.message,
      });
    }
  }

  /**
   * Boot resume: absorb the persisted cumulative meter from
   * <logsDir>/.spend.json. Additive merge (boot meters are empty, so this
   * equals a restore); guarded so a second call cannot double-count. A
   * corrupt file is preserved aside as .spend.json.corrupt-<ts> — never
   * deleted (R1). Never throws.
   */
  async resumeFromDisk() {
    if (!this.persistPath) return { resumed: false, reason: 'not_configured' };
    if (this.resumed) return { resumed: false, reason: 'already_resumed' };
    let raw;
    try {
      raw = await fsp.readFile(this.persistPath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return { resumed: false, reason: 'no_file' };
      this.logger?.warn?.('[SpendMeter] spend file unreadable; starting fresh', {
        error: error?.message,
      });
      return { resumed: false, reason: 'unreadable' };
    }
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || parsed.version !== SPEND_FILE_VERSION) {
        throw new Error(`unsupported spend file shape (version: ${parsed?.version})`);
      }
      this._absorb(parsed);
      this.resumed = true;
      return { resumed: true };
    } catch (error) {
      const asidePath = `${this.persistPath}.corrupt-${Date.now()}`;
      try {
        await fsp.rename(this.persistPath, asidePath);
      } catch (_) { /* best-effort preservation */ }
      this.logger?.warn?.('[SpendMeter] corrupt spend file preserved aside; starting fresh', {
        error: error?.message,
        asidePath,
      });
      return { resumed: false, reason: 'corrupt_preserved_aside' };
    }
  }

  _absorb(parsed) {
    const totals = sanitizeCounters(parsed.totals);
    this.totals.inputTokens += totals.inputTokens;
    this.totals.outputTokens += totals.outputTokens;
    this.totals.totalTokens += totals.totalTokens;
    this.totals.meteredCalls += totals.meteredCalls;
    this.unmeteredCalls += toNonNegativeInt(parsed.unmeteredCalls) ?? 0;
    const byProvider = parsed.byProvider && typeof parsed.byProvider === 'object'
      ? parsed.byProvider
      : {};
    for (const [rawProvider, rawBucket] of Object.entries(byProvider)) {
      const provider = normalizeKey(rawProvider);
      if (!provider || !rawBucket || typeof rawBucket !== 'object') continue;
      const bucket = this._providerBucket(provider);
      const counters = sanitizeCounters(rawBucket);
      bucket.inputTokens += counters.inputTokens;
      bucket.outputTokens += counters.outputTokens;
      bucket.totalTokens += counters.totalTokens;
      bucket.meteredCalls += counters.meteredCalls;
      bucket.unmeteredCalls += toNonNegativeInt(rawBucket.unmeteredCalls) ?? 0;
      const models = rawBucket.models && typeof rawBucket.models === 'object'
        ? rawBucket.models
        : {};
      for (const [rawModel, rawModelBucket] of Object.entries(models)) {
        const model = normalizeKey(rawModel);
        if (!model) continue;
        const modelBucket = this._modelBucket(bucket, model);
        const modelCounters = sanitizeCounters(rawModelBucket);
        modelBucket.inputTokens += modelCounters.inputTokens;
        modelBucket.outputTokens += modelCounters.outputTokens;
        modelBucket.totalTokens += modelCounters.totalTokens;
        modelBucket.meteredCalls += modelCounters.meteredCalls;
      }
    }
    if (typeof parsed.startedAt === 'string'
        && (!this.startedAt || parsed.startedAt < this.startedAt)) {
      this.startedAt = parsed.startedAt;
    }
    if (typeof parsed.updatedAt === 'string'
        && (!this.updatedAt || parsed.updatedAt > this.updatedAt)) {
      this.updatedAt = parsed.updatedAt;
    }
  }

  _providerBucket(provider) {
    let bucket = this.byProvider[provider];
    if (!bucket) {
      bucket = {
        ...emptyBucket(),
        unmeteredCalls: 0,
        models: Object.create(null),
      };
      this.byProvider[provider] = bucket;
    }
    return bucket;
  }

  _modelBucket(providerBucket, model) {
    let key = model;
    if (!providerBucket.models[key]
        && Object.keys(providerBucket.models).length >= MAX_MODEL_BUCKETS_PER_PROVIDER) {
      key = OVERFLOW_MODEL_KEY;
    }
    let bucket = providerBucket.models[key];
    if (!bucket) {
      bucket = emptyBucket();
      providerBucket.models[key] = bucket;
    }
    return bucket;
  }

  /**
   * Record one provider call. Sync, in-memory, never throws, never awaited
   * on the hot path. `unmetered: true` (or unusable/zero token counts)
   * increments the honest unmetered counter instead of the token totals.
   */
  recordUsage({ provider, model, inputTokens, outputTokens, unmetered } = {}) {
    try {
      const providerKey = normalizeKey(provider) || 'unknown';
      const modelKey = normalizeKey(model) || 'unknown';
      const now = new Date().toISOString();
      if (!this.startedAt) this.startedAt = now;
      this.updatedAt = now;
      const bucket = this._providerBucket(providerKey);
      const input = toNonNegativeInt(inputTokens);
      const output = toNonNegativeInt(outputTokens);
      const isUnmetered = unmetered === true
        || ((input === null || input === 0) && (output === null || output === 0));
      if (isUnmetered) {
        this.unmeteredCalls += 1;
        bucket.unmeteredCalls += 1;
      } else {
        const inTok = input ?? 0;
        const outTok = output ?? 0;
        const total = inTok + outTok;
        bucket.inputTokens += inTok;
        bucket.outputTokens += outTok;
        bucket.totalTokens += total;
        bucket.meteredCalls += 1;
        this.totals.inputTokens += inTok;
        this.totals.outputTokens += outTok;
        this.totals.totalTokens += total;
        this.totals.meteredCalls += 1;
        const modelBucket = this._modelBucket(bucket, modelKey);
        modelBucket.inputTokens += inTok;
        modelBucket.outputTokens += outTok;
        modelBucket.totalTokens += total;
        modelBucket.meteredCalls += 1;
      }
      this._dirty = true;
      this._schedulePersist();
    } catch (error) {
      this.logger?.debug?.('[SpendMeter] recordUsage failed (non-fatal)', {
        error: error?.message,
      });
    }
  }

  _snapshotByProvider() {
    const byProvider = {};
    for (const [provider, bucket] of Object.entries(this.byProvider)) {
      const models = {};
      for (const [model, modelBucket] of Object.entries(bucket.models)) {
        models[model] = { ...modelBucket };
      }
      byProvider[provider] = {
        inputTokens: bucket.inputTokens,
        outputTokens: bucket.outputTokens,
        totalTokens: bucket.totalTokens,
        meteredCalls: bucket.meteredCalls,
        unmeteredCalls: bucket.unmeteredCalls,
        models,
      };
    }
    return byProvider;
  }

  _computeUsd() {
    if (!this.prices) return null;
    let total = 0;
    let pricedBuckets = 0;
    const unpricedBuckets = [];
    for (const [provider, bucket] of Object.entries(this.byProvider)) {
      for (const [model, modelBucket] of Object.entries(bucket.models)) {
        const price = this.prices[`${provider}/${model}`] || this.prices[provider] || null;
        if (!price) {
          unpricedBuckets.push(`${provider}/${model}`);
          continue;
        }
        pricedBuckets += 1;
        total += (
          modelBucket.inputTokens * (price.inPerMTok || 0)
          + modelBucket.outputTokens * (price.outPerMTok || 0)
        ) / 1e6;
      }
    }
    return {
      total: Number(total.toFixed(6)),
      pricedBuckets,
      unpricedBuckets,
    };
  }

  /**
   * Read-only snapshot for getStats()/lanes: byProvider + totals +
   * unmeteredCalls + usd (null without a price table) + budget evaluation.
   * Computed, never stored authority (R3).
   */
  getSnapshot() {
    const usd = this._computeUsd();
    const totalTokens = this.totals.totalTokens;
    const usdTotal = usd ? usd.total : null;
    return {
      startedAt: this.startedAt,
      updatedAt: this.updatedAt,
      totals: { ...this.totals },
      unmeteredCalls: this.unmeteredCalls,
      byProvider: this._snapshotByProvider(),
      usd,
      budget: {
        maxTokens: this.budget.maxTokens,
        maxUsd: this.budget.maxUsd,
        tokensFractionUsed: this.budget.maxTokens
          ? totalTokens / this.budget.maxTokens
          : null,
        overTokens: this.budget.maxTokens
          ? totalTokens > this.budget.maxTokens
          : null,
        usdFractionUsed: this.budget.maxUsd && usdTotal !== null
          ? usdTotal / this.budget.maxUsd
          : null,
        overUsd: this.budget.maxUsd
          ? (usdTotal !== null ? usdTotal > this.budget.maxUsd : null)
          : null,
        usdState: this.prices ? 'priced' : 'unpriced',
      },
      persistPath: this.persistPath,
      persistCount: this.persistCount,
      resumed: this.resumed,
    };
  }

  _schedulePersist() {
    if (!this.persistPath || this._persistTimer) return;
    this._persistTimer = setTimeout(() => {
      this._persistTimer = null;
      this._persistNow().catch(() => {});
    }, this.persistIntervalMs);
    if (typeof this._persistTimer.unref === 'function') this._persistTimer.unref();
  }

  /**
   * Serialized tmp+fsync+rename write of the cumulative meter. A concurrent
   * call joins the in-flight write and re-marks dirty; failures re-arm the
   * debounce instead of throwing.
   */
  async _persistNow() {
    if (!this.persistPath) return { persisted: false, reason: 'not_configured' };
    if (this._persistInFlight) {
      this._dirty = true;
      return this._persistInFlight;
    }
    const target = this.persistPath;
    this._dirty = false;
    const payload = {
      version: SPEND_FILE_VERSION,
      startedAt: this.startedAt,
      updatedAt: this.updatedAt,
      totals: { ...this.totals },
      unmeteredCalls: this.unmeteredCalls,
      byProvider: this._snapshotByProvider(),
    };
    this._persistInFlight = (async () => {
      const tmp = `${target}.tmp-${process.pid}`;
      const handle = await fsp.open(tmp, 'w');
      try {
        await handle.writeFile(JSON.stringify(payload));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fsp.rename(tmp, target);
      this.persistCount += 1;
      return { persisted: true };
    })().catch((error) => {
      this.logger?.debug?.('[SpendMeter] persist failed (non-fatal)', {
        error: error?.message,
      });
      this._dirty = true;
      return { persisted: false, reason: error?.message || 'persist_failed' };
    }).finally(() => {
      this._persistInFlight = null;
      if (this._dirty) this._schedulePersist();
    });
    return this._persistInFlight;
  }

  /**
   * Bounded shutdown flush (Phase 2 bounded-shutdown pattern — the caller
   * derives timeoutMs from the shutdown budget). Cancels the debounce timer,
   * then races one final persist against the bound. Never throws.
   */
  async flushForShutdown(timeoutMs = 3000) {
    if (this._persistTimer) {
      clearTimeout(this._persistTimer);
      this._persistTimer = null;
    }
    if (!this.persistPath) return { status: 'skipped', reason: 'not_configured' };
    if (!this._dirty && !this._persistInFlight) {
      return { status: this.persistCount > 0 ? 'clean' : 'empty' };
    }
    let timeoutId = null;
    const timeoutPromise = new Promise((resolve) => {
      timeoutId = setTimeout(() => resolve({ status: 'timeout' }), Math.max(1, timeoutMs));
    });
    const persistPromise = this._persistNow()
      .then((result) => (result?.persisted
        ? { status: 'ok' }
        : { status: 'error', reason: result?.reason || null }))
      .catch((error) => ({ status: 'error', reason: error?.message || null }));
    const outcome = await Promise.race([persistPromise, timeoutPromise]);
    if (timeoutId) clearTimeout(timeoutId);
    if (outcome.status === 'timeout') persistPromise.catch(() => {});
    return outcome;
  }
}

let singleton = new SpendMeter();

function getSpendMeter() {
  return singleton;
}

/** Test hook: swap in a fresh meter (the module functions read the live one). */
function resetSpendMeterForTests() {
  if (singleton?._persistTimer) {
    clearTimeout(singleton._persistTimer);
    singleton._persistTimer = null;
  }
  singleton = new SpendMeter();
  return singleton;
}

/**
 * Client-side hook: record a completed provider result into the global
 * meter and return it unchanged. Prefers identity carried ON the result
 * (result.provider from the chat-completions/codex paths) over the caller's
 * fallback label, so provider fallbacks stay correctly attributed. Never
 * throws, never awaited — generation must be unaffected.
 */
function recordCompletionSpend(result, fallbackProvider, fallbackModel) {
  try {
    if (!result || typeof result !== 'object') return result;
    const tokens = extractUsageTokens(result.usage);
    singleton.recordUsage({
      provider: (typeof result.provider === 'string' && result.provider)
        || fallbackProvider || 'unknown',
      model: (typeof result.model === 'string' && result.model)
        || fallbackModel || null,
      inputTokens: tokens ? tokens.inputTokens : null,
      outputTokens: tokens ? tokens.outputTokens : null,
      unmetered: !tokens,
    });
  } catch (_) { /* metering must never break generation */ }
  return result;
}

module.exports = {
  SpendMeter,
  getSpendMeter,
  resetSpendMeterForTests,
  recordCompletionSpend,
  extractUsageTokens,
  sanitizePriceTable,
  SPEND_FILENAME,
  SPEND_FILE_VERSION,
  DEFAULT_PERSIST_INTERVAL_MS,
};

