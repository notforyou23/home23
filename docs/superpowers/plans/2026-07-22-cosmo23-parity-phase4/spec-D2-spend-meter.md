# cosmo23 Phase 4 Component 4.2 — spend metering + budget (R4): new engine/src/core/spend-meter.js (process-global meter, debounced tmp+fsync+rename persist to <logsDir>/.spend.json, boot resume, bounded shutdown flush, config-priced USD), leaf metering hooks in the four engine clients + unified-client's xAI/Codex leaves, orchestrator lifecycle binding + additive getStats() spend snapshot, and Patch 72 launch-surface keys (spendMaxTokens/spendMaxUsd/spendPrices) that survive the sentinel's metadata.json replay.

## Target current state

FIRST-STOP REPORT — RunCommitmentGovernor (cosmo23/engine/src/core/run-commitment-governor.js, imported at orchestrator.js:29, constructed at :104): a PURE run-level decision unit — no I/O, no spawning, no file writes. evaluate(snapshot) turns {cycleCount, activeAgents, goals, plan, providerErrors, artifactAudit, synthesisCommit} into a bounded decision {spawnAllowed, rateLimited, cooldownUntilCycle, requiresArtifactCommitment, shouldStopForCompletion/BlockedRun, spawn budgets, reasonCodes, nextActions}. Its provider-error feed is the key precedent for this component: UnifiedClient exposes a STATIC process-global handler registry (UnifiedClient.onProviderError), the orchestrator subscribes at construction (orchestrator.js:107 → recordProviderError → normalizeProviderError → providerErrorEvents ring, last 50), and collectCommitmentSnapshot() feeds those into evaluate(). The spend meter is built WITH this pattern, not beside it: a process-global singleton fed by client-level hooks, bound by the orchestrator, exposed additively through getStats() so the Phase 4 lanes/regulator (components 4.1/4.3) can consume spend evidence exactly the way providerErrors flow into the governor today. recordCompletionSpend deliberately never touches the governor and never gates generation.

CHOKE-POINT VERDICT (read deeply, 2026-07-22): there is NO single choke point. UnifiedClient.generate() covers most traffic — every inherited GPT5Client convenience wrapper (generateWithRetry/generateWithWebSearch/generateWithReasoning/generateFast/executeInContainer/generateWithCodeInterpreter/createCompletion) funnels back through `this.generate()` by dynamic dispatch — BUT (a) UnifiedClient.generateWithWebSearch routes local/ollama-cloud/anthropic/minimax DIRECTLY to sub-client methods (unified-client.js:1065,1073,1081,1088), generateWithReasoning routes local/ollama-cloud directly (:1150,:1158), generateFast routes local/ollama-cloud directly (:1220,:1231); and (b) provider fallbacks (generate()'s fallbackAssignment branches, generateAnthropic/generateMiniMax internal super.generate() fallbacks at :836/:864) would be MISLABELED by any boundary-level meter. Therefore the meter hooks the SEVEN LEAF RETURN SITES where a provider response actually materializes — gpt5-client.js generate() success+error-shaped returns (2), chat-completions-client.js generateStreaming+generateNonStreaming returns (2), anthropic-client.js _streamResponseWithWebSearch success return (1 — generate() AND generateWithWebSearch() both funnel through it; providerId separates anthropic vs minimax), unified-client.js generateXAI+generateCodex returns (2). Leaf metering also counts every intra-retry attempt that returns (generateWithRetry loops re-enter the leaves) and keeps fallback attribution correct.

USAGE SHAPES (verified in source): OpenAI/GPT5Client: raw Responses usage {input_tokens, output_tokens, total_tokens, *_details} from response.completed — may be undefined if the stream died. xAI: same Responses shape via finalResponse?.usage — absent unless response.completed arrived. Codex (generateCodex): normalized {input_tokens, output_tokens, total_tokens} but ZERO-FILLED when the SSE stream never delivered usage — zeros must read as "no data". Anthropic engine client: {input_tokens (message_start), output_tokens (accumulated message_delta)} — no total_tokens; _buildErrorResponse zero-fills; cache_creation/read tokens are NOT captured by the stream handler today. ChatCompletionsClient streaming: normalized {input_tokens, output_tokens, total_tokens} OR null — the payload does NOT set stream_options.include_usage, so most OpenAI-compatible servers (vLLM etc.) omit usage on stream (Ollama includes it on the final chunk); ChatCompletionsClient NON-streaming: RAW chat shape {prompt_tokens, completion_tokens, total_tokens} passed through normalizeProviderCompletion untranslated (lib/provider-completion.js:84 is a passthrough). PATHS THAT DROP USAGE (honestly unmetered, never estimated): thrown/aborted calls (no result at all — they surface via emitProviderError/governor instead), Codex zero-fills, xAI/GPT5 streams without response.completed, CC streaming without server usage, Anthropic error responses.

INSTANCE TOPOLOGY: ~15 UnifiedClient construction sites (base-agent per agent, meta/executive/action coordinators, summarizer, goal systems, query-engine, etc.) — a per-instance meter would fragment, so the meter is a module-level singleton (same lifetime pattern as UnifiedClient.providerErrorHandlers).

LAUNCH/REPLAY CHAIN (verified): POST /api/launch → launchResearch → launchPreparedResearch (server/index.js:1021) → serializeLaunchSettings(payload) (:756, FIXED key set — custom payload keys do NOT pass through) → configGenerator.writeConfig() regenerates config.yaml + writeRuntimeMetadata() writes camelCase metadata.json (:879). Sentinel replay (server/lib/run-sentinel.js:160 createContinuationRelauncher) reads <runDir>/metadata.json and spreads it as the payload into launchPreparedResearch — i.e. config.yaml is REGENERATED from metadata.json on every sentinel relaunch. So spend config must round-trip payload(camel) → serializeLaunchSettings(snake) → metadata.json(camel) → replay payload → serialize again; all three touchpoints are patched (Patch 72). Engine ConfigLoader validates required sections only — the new top-level `spend:` block passes through to config.spend untouched.

SHUTDOWN/PERSIST PATTERNS REUSED: heartbeat.js tmp+rename idiom (`${target}.tmp-${pid}`, unref'd timer); StateCompression's fsync-before-rename added for crash-safety; orchestrator stop() sequence (stop → saveStateForShutdown → telemetry → backup wait → closeLedgerForShutdown) gains flushSpendMeterForShutdown AFTER the ledger close, bounded by shutdownBudgetMs(this.shutdownDeadline, config.shutdownSpendMeterTimeoutMs || 3000) — the exact closeLedgerForShutdown Promise.race pattern (orchestrator.js:9765). No new save path was invented; the meter file is additive telemetry fully outside the sacred brain persistence path (state.json.gz/manifest/sidecars untouched).

DONOR VERIFICATION: no spend/metering donor exists anywhere in the tree (grep for spend-meter/getSpendMeter/recordCompletionSpend across engine/, server/, lib/, launcher/ is empty; the only "price" strings are the legacy hardcoded `costPerMToken: [3, 15]` rows inside config-generator's providers.anthropic.models block — deliberately NOT used, R4 forbids hardcoded prices). The Good Life spend machinery in home23/engine was not transplanted — this is a cosmo23-native shape built on the governor's own feed pattern.

## CHANGE: /Users/jtr/_JTR23_/release/home23/cosmo23/engine/src/core/spend-meter.js

NEW FILE — process-global SpendMeter singleton. recordUsage({provider, model, inputTokens, outputTokens, unmetered}) accumulates in-memory (per-provider + per-model buckets, capped at 200 model buckets/provider with __other__ overflow, Object.create(null) maps against key pollution); debounced unref'd tmp+fsync+rename persist to <logsDir>/.spend.json every spend.persistIntervalMs (default 30s, min 10ms for tests); boot resume via resumeFromDisk() (additive absorb, guarded against double-resume, corrupt files preserved aside as .spend.json.corrupt-<ts> — never deleted, R1); getSnapshot() → {startedAt, updatedAt, totals, unmeteredCalls, byProvider, usd (null without a config price table), budget {maxTokens, maxUsd, tokensFractionUsed, overTokens, usdFractionUsed, overUsd, usdState 'priced'|'unpriced'}, persistPath, persistCount, resumed}; flushForShutdown(timeoutMs) is the bounded shutdown awaitable (ledger-close pattern). extractUsageTokens handles BOTH verified shape families (input_tokens/output_tokens AND prompt_tokens/completion_tokens); all-zero or missing usage counts unmetered — never estimated. recordCompletionSpend(result, fallbackProvider, fallbackModel) is the never-throwing client hook that prefers result.provider/result.model over the fallback label so provider fallbacks stay correctly attributed. USD comes ONLY from config spend.prices ({"provider/model"|"provider": {inPerMTok, outPerMTok}}, per-million-token, sanitized, max 64 entries) — no hardcoded prices. Dependency-free (node fs/path only) so all four clients can require it without cycles. VALIDATED: full content below ran green under the 17-test suite in an isolated mirror.

### Anchor
```
NEW FILE — no anchor. Create at cosmo23/engine/src/core/spend-meter.js.
```

### Code
```js
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

```

## CHANGE: /Users/jtr/_JTR23_/release/home23/cosmo23/engine/src/core/gpt5-client.js

Edit 1/3 — import the metering hook. REPLACE the exact single line (line 1) with the two lines. Verified unique (1 match).

### Anchor
```
const { getOpenAIClient, getOpenAIClientAsync } = require('./openai-client');
```

### Code
```js
REPLACE:
const { getOpenAIClient, getOpenAIClientAsync } = require('./openai-client');

WITH:
const { getOpenAIClient, getOpenAIClientAsync } = require('./openai-client');
const { recordCompletionSpend } = require('./spend-meter');
```

## CHANGE: /Users/jtr/_JTR23_/release/home23/cosmo23/engine/src/core/gpt5-client.js

Edit 2/3 — meter the error-shaped Responses return (leaf site 1 of 2; error-shaped returns can still carry real usage). REPLACE the exact block (~line 248) — verified unique.

### Anchor
```
// BUT still include output for any partial data
```

### Code
```js
REPLACE:
        // Return a meaningful error message instead of empty string
        // BUT still include output for any partial data
        return {
          content: `[Error: ${errorMsg}]`,
          reasoning: reasoningSummary,
          responseId: finalResponse?.id,
          conversationId: finalResponse?.conversation?.id,
          model: finalResponse?.model || model,
          usage: finalResponse?.usage,
          hadError: true,
          errorType,
          output: finalResponse?.output // CRITICAL: Always pass through output for tool calls
        };

WITH:
        // Return a meaningful error message instead of empty string
        // BUT still include output for any partial data
        // Phase 4 (R4): error-shaped returns can still carry real usage
        // (tokens were consumed) — meter them; missing usage counts unmetered.
        return recordCompletionSpend({
          content: `[Error: ${errorMsg}]`,
          reasoning: reasoningSummary,
          responseId: finalResponse?.id,
          conversationId: finalResponse?.conversation?.id,
          model: finalResponse?.model || model,
          usage: finalResponse?.usage,
          hadError: true,
          errorType,
          output: finalResponse?.output // CRITICAL: Always pass through output for tool calls
        }, 'openai', model);
```

## CHANGE: /Users/jtr/_JTR23_/release/home23/cosmo23/engine/src/core/gpt5-client.js

Edit 3/3 — meter the success Responses return (leaf site 2 of 2). REPLACE the exact block (~line 272) — verified unique.

### Anchor
```
webSearchSources, // NEW: Return web search sources
```

### Code
```js
REPLACE:
      return {
        content: aggregatedText,
        reasoning: reasoningSummary,
        responseId: finalResponse?.id,
        conversationId: finalResponse?.conversation?.id,
        model: finalResponse?.model || model,
        usage: finalResponse?.usage,
        hadError,
        errorType: hadError ? errorType : null,
        webSearchSources, // NEW: Return web search sources
        citations, // NEW: Return URL citations
        output: finalResponse?.output // CRITICAL: Pass through for code_interpreter file annotations
      };

WITH:
      // Phase 4 (R4): leaf metering — every returned OpenAI Responses call.
      return recordCompletionSpend({
        content: aggregatedText,
        reasoning: reasoningSummary,
        responseId: finalResponse?.id,
        conversationId: finalResponse?.conversation?.id,
        model: finalResponse?.model || model,
        usage: finalResponse?.usage,
        hadError,
        errorType: hadError ? errorType : null,
        webSearchSources, // NEW: Return web search sources
        citations, // NEW: Return URL citations
        output: finalResponse?.output // CRITICAL: Pass through for code_interpreter file annotations
      }, 'openai', model);
```

## CHANGE: /Users/jtr/_JTR23_/release/home23/cosmo23/engine/src/core/chat-completions-client.js

Edit 1/3 — import the metering hook after the provider-completion require (line 30). Verified unique.

### Anchor
```
const { normalizeProviderCompletion } = require('../../../lib/provider-completion');
```

### Code
```js
REPLACE:
const { normalizeProviderCompletion } = require('../../../lib/provider-completion');

WITH:
const { normalizeProviderCompletion } = require('../../../lib/provider-completion');
const { recordCompletionSpend } = require('./spend-meter');
```

## CHANGE: /Users/jtr/_JTR23_/release/home23/cosmo23/engine/src/core/chat-completions-client.js

Edit 2/3 — meter the streaming return (generateStreaming, ~line 519). Streaming servers frequently omit usage (payload does not send stream_options.include_usage) — null usage counts unmetered. REPLACE the exact block — verified unique.

### Anchor
```
if (!content && reasoning) content = reasoning;
```

### Code
```js
REPLACE:
    if (!content && reasoning) content = reasoning;
    throwIfAborted(signal);
    return normalizeProviderCompletion({
      content, terminalReceived, finishReason, hadError, error: streamError,
      responseId, model: originalModel, observedModel: responseModel,
      provider: this.config.providerId,
      usage: usage ? {
        input_tokens: usage.prompt_tokens,
        output_tokens: usage.completion_tokens,
        total_tokens: usage.total_tokens,
      } : null,
      output: toolCalls.length ? toolCalls.map(toolCall => ({
        type: 'function_call', id: toolCall.id,
        name: toolCall.name, arguments: toolCall.arguments,
      })) : null,
    });

WITH:
    if (!content && reasoning) content = reasoning;
    throwIfAborted(signal);
    // Phase 4 (R4): leaf metering — streaming servers frequently omit usage
    // (no stream_options.include_usage in the payload); null usage counts as
    // an unmetered call, never an estimate.
    return recordCompletionSpend(normalizeProviderCompletion({
      content, terminalReceived, finishReason, hadError, error: streamError,
      responseId, model: originalModel, observedModel: responseModel,
      provider: this.config.providerId,
      usage: usage ? {
        input_tokens: usage.prompt_tokens,
        output_tokens: usage.completion_tokens,
        total_tokens: usage.total_tokens,
      } : null,
      output: toolCalls.length ? toolCalls.map(toolCall => ({
        type: 'function_call', id: toolCall.id,
        name: toolCall.name, arguments: toolCall.arguments,
      })) : null,
    }), this.config.providerId, originalModel);
```

## CHANGE: /Users/jtr/_JTR23_/release/home23/cosmo23/engine/src/core/chat-completions-client.js

Edit 3/3 — meter the non-streaming return (generateNonStreaming, ~line 576; usage passes through RAW prompt_tokens/completion_tokens — the meter normalizes both shape families). REPLACE the exact block — verified unique.

### Anchor
```
terminalReceived: Boolean(choice?.finish_reason),
```

### Code
```js
REPLACE:
    return normalizeProviderCompletion({
      content,
      terminalReceived: Boolean(choice?.finish_reason),
      finishReason: choice?.finish_reason || null,
      hadError: false,
      responseId: response.id,
      model: originalModel,
      observedModel: response.model || requestPayload.model,
      provider: this.config.providerId,
      usage: response.usage,
      output: choice?.message?.tool_calls || null,
    });

WITH:
    // Phase 4 (R4): leaf metering — non-streaming usage passes through RAW
    // chat-completions shape (prompt_tokens/completion_tokens); the meter
    // normalizes both shape families.
    return recordCompletionSpend(normalizeProviderCompletion({
      content,
      terminalReceived: Boolean(choice?.finish_reason),
      finishReason: choice?.finish_reason || null,
      hadError: false,
      responseId: response.id,
      model: originalModel,
      observedModel: response.model || requestPayload.model,
      provider: this.config.providerId,
      usage: response.usage,
      output: choice?.message?.tool_calls || null,
    }), this.config.providerId, originalModel);
```

## CHANGE: /Users/jtr/_JTR23_/release/home23/cosmo23/engine/src/core/anthropic-client.js

Edit 1/2 — import the metering hook after the oauth-engine require (line 16). Verified unique.

### Anchor
```
require('../services/anthropic-oauth-engine');
```

### Code
```js
REPLACE:
const { getAnthropicApiKey, prepareSystemPrompt, isOAuthToken, getStealthHeaders } = require('../services/anthropic-oauth-engine');

WITH:
const { getAnthropicApiKey, prepareSystemPrompt, isOAuthToken, getStealthHeaders } = require('../services/anthropic-oauth-engine');
const { recordCompletionSpend } = require('./spend-meter');
```

## CHANGE: /Users/jtr/_JTR23_/release/home23/cosmo23/engine/src/core/anthropic-client.js

Edit 2/2 — meter the shared stream-processor success return (_streamResponseWithWebSearch ~line 802; generate() and generateWithWebSearch() both funnel through it; providerId keeps anthropic vs minimax attribution honest). REPLACE the exact block — verified unique ('      return response;' occurs once in the file).

### Anchor
```
'[AnthropicClient] Citations extracted:'
```

### Code
```js
REPLACE:
      if (citations.length > 0) {
        response.citations = citations;
        this.logger?.info?.('[AnthropicClient] Citations extracted:', citations.length);
      }

      return response;

WITH:
      if (citations.length > 0) {
        response.citations = citations;
        this.logger?.info?.('[AnthropicClient] Citations extracted:', citations.length);
      }

      // Phase 4 (R4): leaf metering — generate() and generateWithWebSearch()
      // both funnel through this stream processor; providerId keeps
      // anthropic vs minimax attribution honest. Error-shaped results
      // (_buildErrorResponse) are deliberately NOT metered: they zero-fill
      // usage by construction and include pre-call failures.
      return recordCompletionSpend(response, this.providerId, response.model);
```

## CHANGE: /Users/jtr/_JTR23_/release/home23/cosmo23/engine/src/core/unified-client.js

Edit 1/3 — import the metering hook after the provider-prompts require (line 4). Verified unique.

### Anchor
```
const { wrapSystemPrompt } = require('./provider-prompts');
```

### Code
```js
REPLACE:
const { wrapSystemPrompt } = require('./provider-prompts');

WITH:
const { wrapSystemPrompt } = require('./provider-prompts');
const { recordCompletionSpend } = require('./spend-meter');
```

## CHANGE: /Users/jtr/_JTR23_/release/home23/cosmo23/engine/src/core/unified-client.js

Edit 2/3 — meter the generateXAI leaf return (~line 636; xAI is implemented inside unified-client, not via GPT5Client). REPLACE the exact block — verified unique (the 'CRITICAL: tool calls for agentic loop' comment appears once).

### Anchor
```
output: finalResponse?.output || null,  // CRITICAL: tool calls for agentic loop
```

### Code
```js
REPLACE:
    return {
      content: aggregatedText,
      reasoning: reasoningSummary,
      responseId: finalResponse?.id,
      model: assignment.model,
      usage: finalResponse?.usage,
      output: finalResponse?.output || null,  // CRITICAL: tool calls for agentic loop
      hadError,
      errorType
    };

WITH:
    // Phase 4 (R4): leaf metering — xAI Responses stream (usage only arrives
    // when response.completed delivered it; absent usage counts unmetered).
    return recordCompletionSpend({
      content: aggregatedText,
      reasoning: reasoningSummary,
      responseId: finalResponse?.id,
      model: assignment.model,
      usage: finalResponse?.usage,
      output: finalResponse?.output || null,  // CRITICAL: tool calls for agentic loop
      hadError,
      errorType
    }, 'xai', assignment.model);
```

## CHANGE: /Users/jtr/_JTR23_/release/home23/cosmo23/engine/src/core/unified-client.js

Edit 3/3 — meter the generateCodex leaf return (~line 795; Codex zero-fills usage when its SSE stream never delivered it — all-zero counts unmetered). REPLACE the exact block — verified unique (provider: 'openai-codex' appears once).

### Anchor
```
provider: 'openai-codex'
```

### Code
```js
REPLACE:
    return {
      content: aggregatedText,
      reasoning: reasoningSummary || undefined,
      usage: {
        input_tokens: finalUsage.input_tokens || 0,
        output_tokens: finalUsage.output_tokens || 0,
        total_tokens: (finalUsage.input_tokens || 0) + (finalUsage.output_tokens || 0)
      },
      model: assignment.model,
      provider: 'openai-codex'
    };

WITH:
    // Phase 4 (R4): leaf metering — Codex zero-fills usage when its stream
    // never delivered it; all-zero usage counts as an unmetered call.
    return recordCompletionSpend({
      content: aggregatedText,
      reasoning: reasoningSummary || undefined,
      usage: {
        input_tokens: finalUsage.input_tokens || 0,
        output_tokens: finalUsage.output_tokens || 0,
        total_tokens: (finalUsage.input_tokens || 0) + (finalUsage.output_tokens || 0)
      },
      model: assignment.model,
      provider: 'openai-codex'
    }, 'openai-codex', assignment.model);
```

## CHANGE: /Users/jtr/_JTR23_/release/home23/cosmo23/engine/src/core/orchestrator.js

Edit 1/6 — import getSpendMeter next to the governor require (line 29). Verified unique. NOTE: orchestrator.js contains pre-existing trailing whitespace on some lines — none of these anchor blocks include such lines; apply byte-exact.

### Anchor
```
const { RunCommitmentGovernor } = require('./run-commitment-governor');
```

### Code
```js
REPLACE:
const { RunCommitmentGovernor } = require('./run-commitment-governor');

WITH:
const { RunCommitmentGovernor } = require('./run-commitment-governor');
const { getSpendMeter } = require('./spend-meter');
```

## CHANGE: /Users/jtr/_JTR23_/release/home23/cosmo23/engine/src/core/orchestrator.js

Edit 2/6 — constructor: bind the process-global meter to this run right after the EventLedger construction (~line 278). configure() is sync, never throws, attaches <logsDir>/.spend.json + budget from config.spend. REPLACE the exact block — verified unique.

### Anchor
```
this.shutdownHandler = null; // Created after initialization
```

### Code
```js
REPLACE:
    this.eventLedger = new EventLedger(this.logsDir, {
      maxBytes: config.ledger?.maxBytes,
      keepRolls: config.ledger?.keepRolls,
      logger,
    });
    this.shutdownHandler = null; // Created after initialization

WITH:
    this.eventLedger = new EventLedger(this.logsDir, {
      maxBytes: config.ledger?.maxBytes,
      keepRolls: config.ledger?.keepRolls,
      logger,
    });
    // Phase 4 (R4): bind the process-global spend meter to this run —
    // <logsDir>/.spend.json persistence, budget from config.spend
    // (maxTokens/maxUsd/prices — NO hardcoded prices). Metering itself
    // happens inside the provider clients (leaf response returns); the
    // orchestrator only attaches the sink and exposes the snapshot.
    this.spendMeter = getSpendMeter();
    this.spendMeter.configure({
      logsDir: this.logsDir,
      spendConfig: config.spend || {},
      logger,
    });
    this.shutdownHandler = null; // Created after initialization
```

## CHANGE: /Users/jtr/_JTR23_/release/home23/cosmo23/engine/src/core/orchestrator.js

Edit 3/6 — initialize(): boot-resume the meter right after the event-ledger init try/catch (~line 612), before any LLM call can fire. Non-fatal. REPLACE the exact block — verified unique ('Event ledger init failed (non-fatal)' occurs once).

### Anchor
```
Event ledger init failed (non-fatal)
```

### Code
```js
REPLACE:
    try {
      await this.eventLedger.initialize();
    } catch (error) {
      this.logger.warn('Event ledger init failed (non-fatal)', { error: error.message });
    }

WITH:
    try {
      await this.eventLedger.initialize();
    } catch (error) {
      this.logger.warn('Event ledger init failed (non-fatal)', { error: error.message });
    }

    // Phase 4 (R4): boot-resume the cumulative spend meter from
    // <logsDir>/.spend.json (tmp+rename persisted; corrupt files are
    // preserved aside, never deleted). Non-fatal — metering must never
    // block a run.
    try {
      await this.spendMeter.resumeFromDisk();
    } catch (error) {
      this.logger.warn('Spend meter resume failed (non-fatal)', { error: error.message });
    }
```

## CHANGE: /Users/jtr/_JTR23_/release/home23/cosmo23/engine/src/core/orchestrator.js

Edit 4/6 — add flushSpendMeterForShutdown() right after closeLedgerForShutdown()'s closing brace (~line 9793), reusing the module-local shutdownBudgetMs (defined at ~line 10599, already exported). New config knob: shutdownSpendMeterTimeoutMs (default 3000). REPLACE the exact block — verified unique ('Event ledger close failed (non-fatal)' occurs once).

### Anchor
```
Event ledger close failed (non-fatal)
```

### Code
```js
REPLACE:
    if (result.status === 'error') {
      this.logger.warn('Event ledger close failed (non-fatal)', {
        error: result.error?.message || String(result.error),
      });
    }
  }

WITH:
    if (result.status === 'error') {
      this.logger.warn('Event ledger close failed (non-fatal)', {
        error: result.error?.message || String(result.error),
      });
    }
  }

  /**
   * Phase 4 (R4): flush the spend meter's last debounced window during
   * shutdown, bounded by the shutdown budget (same pattern as
   * closeLedgerForShutdown). Best-effort by design — a wedged fs can cost
   * at most the bound, and the meter itself never throws.
   */
  async flushSpendMeterForShutdown() {
    if (!this.spendMeter) return;
    const timeoutMs = shutdownBudgetMs(this.shutdownDeadline, this.config.shutdownSpendMeterTimeoutMs || 3000);
    try {
      const outcome = await this.spendMeter.flushForShutdown(timeoutMs);
      if (outcome?.status === 'timeout') {
        this.logger.warn('⚠️ Spend meter flush timed out during shutdown; continuing', { timeoutMs });
      } else if (outcome?.status === 'error') {
        this.logger.warn('Spend meter flush failed (non-fatal)', { reason: outcome?.reason || null });
      }
    } catch (error) {
      this.logger.warn('Spend meter flush failed (non-fatal)', { error: error?.message });
    }
  }
```

## CHANGE: /Users/jtr/_JTR23_/release/home23/cosmo23/engine/src/core/orchestrator.js

Edit 5/6 — stop(): flush the final spend window AFTER the ledger close (ledger evidence lands first under a tight budget), before the final log line (~line 9870). REPLACE the exact block — verified unique. NOTE: the blank line between '}' and the logger line is a true empty line in the current source.

### Anchor
```
await this.closeLedgerForShutdown();
```

### Code
```js
REPLACE:
    if (this.eventLedger) {
      await this.closeLedgerForShutdown();
    }

    this.logger.info('GPT-5.2 system stopped');

WITH:
    if (this.eventLedger) {
      await this.closeLedgerForShutdown();
    }

    // Phase 4 (R4): persist the final spend window (bounded). After the
    // ledger close so ledger evidence lands first under a tight budget.
    if (this.spendMeter) {
      await this.flushSpendMeterForShutdown();
    }

    this.logger.info('GPT-5.2 system stopped');
```

## CHANGE: /Users/jtr/_JTR23_/release/home23/cosmo23/engine/src/core/orchestrator.js

Edit 6/6 — getStats() (~line 10491): expose the ADDITIVE spend snapshot (R3: computed, never stored authority — lanes and the status contract read from here). REPLACE the exact single line — verified unique in the file (the similar saveState block uses different text).

### Anchor
```
clusterCoordinator: this.clusterCoordinator ? this.clusterCoordinator.getStats() : null,
```

### Code
```js
REPLACE:
      clusterCoordinator: this.clusterCoordinator ? this.clusterCoordinator.getStats() : null,

WITH:
      clusterCoordinator: this.clusterCoordinator ? this.clusterCoordinator.getStats() : null,
      // Phase 4 (R4): additive spend snapshot — computed, never stored
      // authority; lanes and the status contract read from here.
      spend: this.spendMeter ? this.spendMeter.getSnapshot() : null,
```

## CHANGE: /Users/jtr/_JTR23_/release/home23/cosmo23/server/index.js

Patch 72 edit 1/3 — add parseSpendLimit + sanitizeSpendPrices helpers right after parsePositiveInt (~line 432). Both mirror the existing duplicated-helper convention between server/index.js and config-generator.js. REPLACE the exact function — verified unique in this file.

### Anchor
```
function parsePositiveInt(value, fallback) {
```

### Code
```js
REPLACE:
function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

WITH:
function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// Phase 4 (R4) — Patch 72: optional launch spend budget. Positive finite
// number or null; never coerced defaults (absent budget = metering only).
function parseSpendLimit(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

// Phase 4 (R4) — Patch 72: config-provided price table, per million tokens,
// keyed "provider/model" or "provider" -> { inPerMTok, outPerMTok }. NO
// hardcoded prices anywhere; invalid entries dropped; capped at 64.
function sanitizeSpendPrices(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = {};
  let count = 0;
  for (const [rawKey, rawPrice] of Object.entries(value)) {
    if (count >= 64) break;
    const key = typeof rawKey === 'string' ? rawKey.trim().slice(0, 200) : '';
    if (!key || !rawPrice || typeof rawPrice !== 'object') continue;
    const inPerMTok = Number(rawPrice.inPerMTok);
    const outPerMTok = Number(rawPrice.outPerMTok);
    const entry = {};
    if (Number.isFinite(inPerMTok) && inPerMTok >= 0) entry.inPerMTok = inPerMTok;
    if (Number.isFinite(outPerMTok) && outPerMTok >= 0) entry.outPerMTok = outPerMTok;
    if (Object.keys(entry).length === 0) continue;
    entries[key] = entry;
    count += 1;
  }
  return count > 0 ? entries : null;
}
```

## CHANGE: /Users/jtr/_JTR23_/release/home23/cosmo23/server/index.js

Patch 72 edit 2/3 — serializeLaunchSettings (~line 875): serialize the three optional camelCase payload keys into snake_case launchSettings. Additive: payloads without spend keys serialize as null fields. REPLACE the exact tail of the return object — verified unique.

### Anchor
```
xai_strategic_model: xaiStrategicModel
```

### Code
```js
REPLACE:
    xai_default_model: xaiDefaultModel,
    xai_strategic_model: xaiStrategicModel
  };

WITH:
    xai_default_model: xaiDefaultModel,
    xai_strategic_model: xaiStrategicModel,
    // Phase 4 (R4) — Patch 72: optional run spend budget + price table.
    // Persisted into metadata.json (writeRuntimeMetadata) so the sentinel's
    // metadata replay (launchPreparedResearch) regenerates the same spend
    // config after a restart. Additive: absent keys serialize as null.
    spend_max_tokens: parseSpendLimit(payload.spendMaxTokens),
    spend_max_usd: parseSpendLimit(payload.spendMaxUsd),
    spend_prices: sanitizeSpendPrices(payload.spendPrices)
  };
```

## CHANGE: /Users/jtr/_JTR23_/release/home23/cosmo23/server/index.js

Patch 72 edit 3/3 — writeRuntimeMetadata (~line 928): persist the camelCase spend keys into metadata.json — the exact file createContinuationRelauncher (run-sentinel.js) spreads back into the replay payload. REPLACE the exact pair of lines — verified unique.

### Anchor
```
synthesisSpineCap: launchSettings.synthesis_spine_cap,
```

### Code
```js
REPLACE:
    synthesisSpineCap: launchSettings.synthesis_spine_cap,
    savedAt: new Date().toISOString()

WITH:
    synthesisSpineCap: launchSettings.synthesis_spine_cap,
    spendMaxTokens: launchSettings.spend_max_tokens,
    spendMaxUsd: launchSettings.spend_max_usd,
    spendPrices: launchSettings.spend_prices,
    savedAt: new Date().toISOString()
```

## CHANGE: /Users/jtr/_JTR23_/release/home23/cosmo23/launcher/config-generator.js

Patch 72 edit 1/4 — add parseSpendLimit + sanitizeSpendPrices module helpers after parsePositiveInt (~line 39). REPLACE the exact function — verified unique in this file.

### Anchor
```
function parsePositiveInt(value, fallback) {
```

### Code
```js
REPLACE:
function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

WITH:
function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// Phase 4 (R4) — Patch 72: optional launch spend budget (positive finite
// number or null; null = metering without that budget dimension).
function parseSpendLimit(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

// Phase 4 (R4) — Patch 72: config-provided price table (per million tokens,
// keys "provider/model" or "provider"). NO hardcoded prices; capped at 64.
function sanitizeSpendPrices(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = {};
  let count = 0;
  for (const [rawKey, rawPrice] of Object.entries(value)) {
    if (count >= 64) break;
    const key = typeof rawKey === 'string' ? rawKey.trim().slice(0, 200) : '';
    if (!key || !rawPrice || typeof rawPrice !== 'object') continue;
    const inPerMTok = Number(rawPrice.inPerMTok);
    const outPerMTok = Number(rawPrice.outPerMTok);
    const entry = {};
    if (Number.isFinite(inPerMTok) && inPerMTok >= 0) entry.inPerMTok = inPerMTok;
    if (Number.isFinite(outPerMTok) && outPerMTok >= 0) entry.outPerMTok = outPerMTok;
    if (Object.keys(entry).length === 0) continue;
    entries[key] = entry;
    count += 1;
  }
  return count > 0 ? entries : null;
}
```

## CHANGE: /Users/jtr/_JTR23_/release/home23/cosmo23/launcher/config-generator.js

Patch 72 edit 2/4 — generateConfig() destructure (~line 146): accept the three snake_case keys. IMPORTANT: the synthesis pair also appears in generateMetadata (~line 952) — this anchor is disambiguated by the trailing 'const enable_feeder' line which only follows the generateConfig occurrence. REPLACE the exact block — verified unique.

### Anchor
```
const enable_feeder = settings.enable_feeder !== false;
```

### Code
```js
REPLACE:
      synthesis_commit_step = true,
      synthesis_spine_cap = 5
    } = settings || {};

    const enable_feeder = settings.enable_feeder !== false;

WITH:
      synthesis_commit_step = true,
      synthesis_spine_cap = 5,
      spend_max_tokens = null,
      spend_max_usd = null,
      spend_prices = null
    } = settings || {};

    const enable_feeder = settings.enable_feeder !== false;
```

## CHANGE: /Users/jtr/_JTR23_/release/home23/cosmo23/launcher/config-generator.js

Patch 72 edit 3/4 — generateConfig(): sanitize + precompute the YAML values (~line 206). Disambiguated from generateMetadata's identical synthesis lines by the leading usesCodexModels line. REPLACE the exact block — verified unique.

### Anchor
```
const usesCodexModels = selectedProviders.includes('openai-codex') || enable_openai_codex;
```

### Code
```js
REPLACE:
    const usesCodexModels = selectedProviders.includes('openai-codex') || enable_openai_codex;
    const synthesisCommitStep = parseBoolean(synthesis_commit_step, true);
    const synthesisSpineCap = parsePositiveInt(synthesis_spine_cap, 5);

WITH:
    const usesCodexModels = selectedProviders.includes('openai-codex') || enable_openai_codex;
    const synthesisCommitStep = parseBoolean(synthesis_commit_step, true);
    const synthesisSpineCap = parsePositiveInt(synthesis_spine_cap, 5);
    // Phase 4 (R4) — Patch 72: spend block values. JSON is valid YAML, so the
    // sanitized price table is emitted as a single-line flow mapping.
    const spendMaxTokens = parseSpendLimit(spend_max_tokens);
    const spendMaxUsd = parseSpendLimit(spend_max_usd);
    const spendPrices = sanitizeSpendPrices(spend_prices);
    const spendMaxTokensYaml = spendMaxTokens === null ? 'null' : String(spendMaxTokens);
    const spendMaxUsdYaml = spendMaxUsd === null ? 'null' : String(spendMaxUsd);
    const spendPricesYaml = spendPrices ? JSON.stringify(spendPrices) : 'null';
```

## CHANGE: /Users/jtr/_JTR23_/release/home23/cosmo23/launcher/config-generator.js

Patch 72 edit 4/4 — emit the spend: YAML block inside the generateConfig template literal, between the commitmentGovernor block and coordinator: (~line 539). These are lines INSIDE a JS template literal — the ${...} interpolations are intentional. REPLACE the exact block — verified unique.

### Anchor
```
maxUrgentSpawnsPerCycle: 1
```

### Code
```js
REPLACE:
commitmentGovernor:
  enabled: true
  preserveDifferentiatedRoles: true
  requireCommittedArtifacts: true
  rateLimitWindowCycles: 8
  rateLimitThreshold: 3
  rateLimitCooldownCycles: 5
  maxStrategicSpawnsPerCycle: 1
  maxUrgentSpawnsPerCycle: 1

coordinator:

WITH:
commitmentGovernor:
  enabled: true
  preserveDifferentiatedRoles: true
  requireCommittedArtifacts: true
  rateLimitWindowCycles: 8
  rateLimitThreshold: 3
  rateLimitCooldownCycles: 5
  maxStrategicSpawnsPerCycle: 1
  maxUrgentSpawnsPerCycle: 1

# Phase 4 (R4): run spend budget — token metering is always on inside the
# engine; USD is computed only from this config-provided price table
# (per-million-token prices keyed "provider/model" or "provider") — never
# from hardcoded prices. null = metering without that budget dimension.
spend:
  maxTokens: ${spendMaxTokensYaml}
  maxUsd: ${spendMaxUsdYaml}
  prices: ${spendPricesYaml}

coordinator:
```

## CHANGE: /Users/jtr/_JTR23_/release/home23/package.json

Register the new suite in the root test authority (scripts.test, cosmo23 node --test block). CONCURRENCY WARNING: package.json is being modified by concurrent sessions — if this exact pair has moved, insert 'tests/cosmo23/spend-meter.test.cjs ' anywhere inside the same cosmo23 `node --test --test-concurrency=1` segment of scripts.test instead. REPLACE the exact substring (verified adjacent and unique in the current scripts.test).

### Anchor
```
tests/cosmo23/event-ledger-hygiene.test.cjs tests/cosmo23/model-catalog-builtin-coverage.test.cjs
```

### Code
```js
REPLACE (substring inside scripts.test):
tests/cosmo23/event-ledger-hygiene.test.cjs tests/cosmo23/model-catalog-builtin-coverage.test.cjs

WITH:
tests/cosmo23/event-ledger-hygiene.test.cjs tests/cosmo23/spend-meter.test.cjs tests/cosmo23/model-catalog-builtin-coverage.test.cjs
```

## CHANGE: /Users/jtr/_JTR23_/release/home23/tests/cosmo23/package-test-registration.test.cjs

Register the new suite in the registration-authority list (the test that pins every lightweight COSMO suite into package.json exactly once). REPLACE the exact line (4-space indent) — verified unique.

### Anchor
```
'tests/cosmo23/event-ledger-hygiene.test.cjs',
```

### Code
```js
REPLACE:
    'tests/cosmo23/event-ledger-hygiene.test.cjs',

WITH:
    'tests/cosmo23/event-ledger-hygiene.test.cjs',
    'tests/cosmo23/spend-meter.test.cjs',
```

## CHANGE: /Users/jtr/_JTR23_/release/home23/docs/design/COSMO23-VENDORED-PATCHES.md

R5 — ONE integration-boundary patch-log entry for the server-surface changes (launch payload keys + metadata.json fields + config.yaml spend block). Patch 71 exists; 72 is the next free number — if another Phase 4 component claims 72 first, renumber to the next free and/or fold into that component's shared Phase 4 entry. APPEND at end of file (current final line ends with '...the ladder stays bounded across remediations).').

### Anchor
```
the ladder stays bounded across remediations).
```

### Code
```js
APPEND AT END OF FILE (preceded by one blank line):

## Patch 72 — launch spend budget keys for run spend metering (2026-07-22)

**Why:** Phase 4 (R4) adds engine-side spend metering (`cosmo23/engine/src/core/spend-meter.js` — engine-internal, not a boundary; usage read from real provider responses at the client leaf return sites, persisted to `<runDir>/.spend.json`, exposed additively as `spend` in the orchestrator's getStats()). The budget/price-table config must flow from the launch payload into the engine's config.yaml AND survive the sentinel's metadata.json replay (Patch 71 relauncher), which regenerates config.yaml through `serializeLaunchSettings`.

**What changed (server API surface):** `serializeLaunchSettings` accepts three OPTIONAL launch payload keys — `spendMaxTokens` (number > 0), `spendMaxUsd` (number > 0), `spendPrices` (object: `"provider/model"` or `"provider"` → `{ inPerMTok, outPerMTok }`, per-million-token prices; sanitized, capped at 64 entries) — serialized as `spend_max_tokens` / `spend_max_usd` / `spend_prices` (null when absent or invalid; no coerced defaults). `writeRuntimeMetadata` persists them into `metadata.json` (`spendMaxTokens`/`spendMaxUsd`/`spendPrices`), the exact file `createContinuationRelauncher` spreads back into the replay payload, so a sentinel relaunch regenerates identical spend config. `ConfigGenerator.generateConfig` emits a `spend:` block (`maxTokens`/`maxUsd`/`prices`, null when unset; the price table as a JSON flow mapping) into the run's config.yaml; the engine reads it as `config.spend` (plus engine-only knobs `spend.persistIntervalMs`, default 30s, and `shutdownSpendMeterTimeoutMs`, default 3s). NO hardcoded prices anywhere — absent price table = token metering only (engine snapshot reports `usd: null`, `budget.usdState: 'unpriced'`).

**Effect standalone:** additive only (Patch 9 compat) — payloads without spend keys serialize exactly as before plus three null fields; existing metadata.json consumers and config.yaml readers are unaffected; `/api/launch` and `/api/continue` accept the new keys transparently. **Documented gap:** UI continuation (`normalizeBrainMetadataToSettings` / `UI_SETTING_FIELDS` in `server/lib/continuation-state.js`) does not yet map spend keys, so a UI "continue" without explicit spend keys in the request body drops them; the sentinel replay path (raw metadata.json spread) preserves them. **Tests:** `tests/cosmo23/spend-meter.test.cjs` (Home23 root harness) — meter behavior, all four client leaf integrations, persistence/resume/bounded flush, USD/budget, and source-contract pins on the serialize → metadata.json → replay round-trip and the generateConfig spend block.
```

## TEST FILE: /Users/jtr/_JTR23_/release/home23/tests/cosmo23/spend-meter.test.cjs

```js
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

```

## API NOTES

VERIFICATION RECEIPT (all offline, repo untouched — validated in an isolated scratchpad mirror at /private/tmp/claude-501/-Users-jtr--JTR23--release-home23/a403bbd0-d1fd-461a-91bc-9cc077611c0c/scratchpad/spendmeter with the engine's real node_modules symlinked): all 24 REPLACE blocks applied with exactly 1 match each (anchor-uniqueness machine-checked); node --check green on all 8 touched files; the shipped test file ran 17/17 green (node --test) against the patched mirror including REAL GPT5Client/ChatCompletionsClient/AnthropicClient/UnifiedClient code paths with fake transports; zero new trailing whitespace introduced (pre-existing counts unchanged: gpt5-client 32, unified-client 73, orchestrator 670, config-generator 27 — none of the anchor blocks include trailing-whitespace lines).

METER API (cosmo23/engine/src/core/spend-meter.js, dependency-free): getSpendMeter() → process-global singleton; recordUsage({provider, model, inputTokens, outputTokens, unmetered}); recordCompletionSpend(result, fallbackProvider, fallbackModel) → the never-throwing client hook (prefers result.provider/result.model — keeps fallback attribution correct); extractUsageTokens(usage) handles {input_tokens/output_tokens} AND {prompt_tokens/completion_tokens}, all-zero ⇒ null; configure({logsDir, spendConfig, logger}); resumeFromDisk() (double-resume guarded, corrupt file → .spend.json.corrupt-<ts> aside, never deleted); getSnapshot() → {startedAt, updatedAt, totals{inputTokens,outputTokens,totalTokens,meteredCalls}, unmeteredCalls, byProvider{<p>:{...counters, unmeteredCalls, models{<m>:counters}}}, usd: null | {total, pricedBuckets, unpricedBuckets[]}, budget{maxTokens, maxUsd, tokensFractionUsed, overTokens, usdFractionUsed, overUsd, usdState 'priced'|'unpriced'}, persistPath, persistCount, resumed}; flushForShutdown(timeoutMs) → {status: ok|clean|empty|skipped|timeout|error}. The spend LANE (component 4.1/4.3) should read getStats().spend — overTokens/overUsd + fractions are the lane evidence; null means that budget dimension is unset. Regulator note (R1/R2): the meter takes NO actions and writes NO engine state — budget enforcement (pace/park) belongs to the regulator, which should treat budget.overTokens===true or overUsd===true as its spend-lane critical signal and write its own ledger receipts.

CONFIG KEYS (engine): config.spend.{maxTokens, maxUsd, prices, persistIntervalMs (default 30000, engine-only)}; config.shutdownSpendMeterTimeoutMs (default 3000, bounded by shutdownBudgetMs like the ledger close). Launch payload (Patch 72): spendMaxTokens, spendMaxUsd, spendPrices — round-trip verified payload → serializeLaunchSettings (spend_max_tokens/usd/prices) → metadata.json (spendMaxTokens/...) → sentinel replay → config.yaml `spend:` block. Price-table keys must match the provider/model ids as they appear in snapshot buckets (provider ids: openai, openai-codex, anthropic, minimax, xai, local, ollama-cloud; model = the result.model each client reports — for GPT5Client that is the WIRE model from the response, e.g. a dated variant, so provider-level price entries are the robust choice for OpenAI).

HONEST GAPS (documented, not silently papered over): (1) thrown/aborted calls leave no metered record — they surface via UnifiedClient.emitProviderError → governor telemetry; unmeteredCalls counts only calls that RETURNED without usable usage; (2) AnthropicClient error-shaped results (_buildErrorResponse) are not counted at all (zero-filled by construction, includes pre-call credential failures — counting them would exaggerate uncertainty); (3) ChatCompletions streaming rarely carries usage because the engine payload does not send stream_options:{include_usage:true} — adding that is a wire-payload change I deliberately left out of scope (flag as a Phase 4 follow-up; Ollama includes final-chunk usage anyway, vLLM does not); (4) Anthropic cache_creation/cache_read_input_tokens are not captured by the engine's stream handler today, so they are not metered; (5) embeddings (network-memory addNode, query-side) go through a separate OpenAI client path and are NOT metered — .spend.json scope is generation calls through the engine clients; (6) the dashboard subprocess (engine/src/dashboard/server.js, own process) gets its own unconfigured singleton — its query LLM usage accumulates in-memory there and never writes the run's .spend.json (run-budget scope is the engine process); (7) UI continuation does not yet map spend keys (see Patch 72 entry) — sentinel replay preserves them, a manual UI continue without explicit keys drops them.

IMPLEMENTER NOTES: apply the spend-meter.js file first, then client edits, then orchestrator, then server/launcher, then registrations — the source-pin tests fail until ALL edits land. package.json scripts.test is concurrently moving (other Phase 4 sessions): if the event-ledger-hygiene/model-catalog pair anchor misses, insert tests/cosmo23/spend-meter.test.cjs anywhere in the same cosmo23 node --test segment. Patch 72: if another component claims number 72 first, renumber (next free) — content stands alone. Doc-truth follow-up for the phase's doc task (not included here to avoid CLAUDE.md collision with parallel agents): add `.spend.json` (+ .spend.json.corrupt-<ts>) to the State Files table in cosmo23/engine/src/core/CLAUDE.md and `spend.*`/`shutdownSpendMeterTimeoutMs` to the config-fields table. Run gates before restart per doctrine: `node --test --test-concurrency=1 tests/cosmo23/spend-meter.test.cjs`, then the full root `npm test`, then the cosmo23 engine mocha block (`cd cosmo23/engine && npm test`) — the meter never touches saveState/loadState, but the orchestrator constructor/stop() edits make the standalone-load-test-before-restart rule apply in full.
