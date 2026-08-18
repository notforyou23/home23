'use strict';

/**
 * Per-run search governor for the drill bits.
 *
 * A live run must never starve on broken search: SearXNG down, DuckDuckGo
 * timing out ~20s per call, the model re-issuing near-duplicate queries
 * forever. The governor:
 *
 * - circuit-breaks each search backend after bounded failures — a dead
 *   backend is not retried on every query for the rest of the run;
 * - caps every backend attempt with a hard timeout, so no repeated
 *   multi-second waits leak into the drill;
 * - detects near-duplicate failed searches and blocks them WITHOUT touching
 *   any backend, returning a structured strategy-change instruction;
 * - reports exactly which backends are unavailable so the model can change
 *   strategy (direct URLs, shell, coding backend, native knowledge) instead
 *   of looping.
 *
 * One governor per RUN, shared by all parallel workers: breaker state and
 * failed-query memory live on the orchestrator, not on a single bit.
 */

const DEFAULT_MAX_BACKEND_FAILURES = 3;
const DEFAULT_ATTEMPT_TIMEOUT_MS = 8000;
const DEFAULT_DUPLICATE_THRESHOLD = 0.8;
const DEFAULT_FAILED_QUERY_MEMORY = 16;

function normalizeQueryWords(query) {
  return new Set(
    String(query || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((word) => word.length > 2)
  );
}

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const word of a) if (b.has(word)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

class SearchGovernor {
  constructor(options = {}) {
    this.logger = options.logger || console;
    this.maxBackendFailures = Number(options.maxBackendFailures) > 0
      ? Math.floor(Number(options.maxBackendFailures))
      : DEFAULT_MAX_BACKEND_FAILURES;
    this.attemptTimeoutMs = Number(options.attemptTimeoutMs) > 0
      ? Math.floor(Number(options.attemptTimeoutMs))
      : DEFAULT_ATTEMPT_TIMEOUT_MS;
    this.duplicateThreshold = Number(options.duplicateThreshold) > 0
      ? Number(options.duplicateThreshold)
      : DEFAULT_DUPLICATE_THRESHOLD;
    this.failedQueryMemory = Number(options.failedQueryMemory) > 0
      ? Math.floor(Number(options.failedQueryMemory))
      : DEFAULT_FAILED_QUERY_MEMORY;

    this.backends = new Map(); // name -> { failures, open, lastError }
    this.failedQueries = [];   // [{ query, words, at }]
  }

  backendState(name) {
    if (!this.backends.has(name)) {
      this.backends.set(name, { failures: 0, open: false, lastError: null });
    }
    return this.backends.get(name);
  }

  isOpen(name) {
    return this.backendState(name).open;
  }

  recordFailure(name, error) {
    const state = this.backendState(name);
    state.failures += 1;
    state.lastError = String(error?.message || error || 'failed').slice(0, 200);
    if (!state.open && state.failures >= this.maxBackendFailures) {
      state.open = true;
      this.logger?.warn?.(`Search backend circuit OPEN for this run: ${name}`, {
        failures: state.failures,
        lastError: state.lastError
      });
    }
    return state;
  }

  recordSuccess(name) {
    const state = this.backendState(name);
    state.failures = 0;
    state.lastError = null;
    return state;
  }

  /**
   * Race an attempt against the hard timeout. A timed-out attempt counts as
   * a backend failure; the dangling request is ignored, never awaited again.
   */
  async withTimeout(promiseFactory, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`${label} timed out after ${this.attemptTimeoutMs}ms`));
      }, this.attemptTimeoutMs);
      timer.unref?.();
    });
    try {
      const result = await Promise.race([
        Promise.resolve().then(promiseFactory).catch((err) => { throw err; }),
        timeout
      ]);
      return result;
    } finally {
      clearTimeout(timer);
    }
  }

  isNearDuplicateOfFailed(query) {
    const words = normalizeQueryWords(query);
    for (const failed of this.failedQueries) {
      if (jaccard(words, failed.words) >= this.duplicateThreshold) {
        return failed.query;
      }
    }
    return null;
  }

  recordFailedQuery(query) {
    this.failedQueries.push({ query: String(query), words: normalizeQueryWords(query), at: Date.now() });
    if (this.failedQueries.length > this.failedQueryMemory) {
      this.failedQueries.shift();
    }
  }

  /**
   * Gate a query BEFORE any backend is touched.
   * Returns { blocked: false } or { blocked: true, reason }.
   */
  checkQuery(query, configuredBackends = []) {
    const duplicateOf = this.isNearDuplicateOfFailed(query);
    if (duplicateOf) {
      return {
        blocked: true,
        reason: `near-duplicate of a search that already failed: "${duplicateOf}"`
      };
    }
    const configured = configuredBackends.filter(Boolean);
    if (configured.length > 0 && configured.every((name) => this.isOpen(name))) {
      return {
        blocked: true,
        reason: 'every configured search backend is circuit-broken for this run'
      };
    }
    return { blocked: false };
  }

  statusSummary(configuredBackends = []) {
    const status = {};
    for (const name of configuredBackends.filter(Boolean)) {
      const state = this.backendState(name);
      status[name] = state.open
        ? `unavailable — circuit open after ${state.failures} failures (${state.lastError || 'failed'})`
        : (state.failures > 0
          ? `degraded — ${state.failures} recent failure${state.failures > 1 ? 's' : ''} (${state.lastError || 'failed'})`
          : 'available');
    }
    return status;
  }

  /**
   * The structured result the model gets instead of another doomed search.
   * It says exactly which backends are down and forces a strategy change.
   */
  strategyMessage(query, reason, configuredBackends = []) {
    const payload = {
      web_search: 'blocked',
      query,
      reason,
      backends: this.statusSummary(configuredBackends),
      change_strategy: [
        'Do NOT issue another web_search for this or a similar query.',
        'Fetch specific URLs you already know directly: run_command with `curl -sL <url>` (archive.org, official sites, publications).',
        'Use coding_run to script scraping or API calls against known sources.',
        'Use read_file / list_directory / search_files on material already in this run.',
        'If a fact is only reachable by search, proceed from your own knowledge and clearly mark it as unverified.'
      ]
    };
    return JSON.stringify(payload, null, 2);
  }
}

/**
 * One governor per run, shared across parallel workers. The orchestrator is
 * the run-scoped object every bit already carries; contexts without one
 * (tests, bare tools) get a governor pinned to the context itself.
 */
function getSearchGovernor(context = {}) {
  const host = context.orchestrator || context;
  if (!host._searchGovernor) {
    const searchConfig = context.orchestrator?.config?.search || context.config?.search || {};
    host._searchGovernor = new SearchGovernor({
      logger: context.logger,
      maxBackendFailures: searchConfig.maxBackendFailures,
      attemptTimeoutMs: searchConfig.attemptTimeoutMs,
      duplicateThreshold: searchConfig.duplicateThreshold
    });
  }
  return host._searchGovernor;
}

module.exports = {
  SearchGovernor,
  getSearchGovernor,
  DEFAULT_MAX_BACKEND_FAILURES,
  DEFAULT_ATTEMPT_TIMEOUT_MS,
  DEFAULT_DUPLICATE_THRESHOLD
};
