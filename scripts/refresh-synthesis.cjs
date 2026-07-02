#!/usr/bin/env node
'use strict';

const fs = require('fs');

const DEFAULT_BASE_URL = 'http://127.0.0.1:5002';
const DEFAULT_TIMEOUT_MS = 180000;
const DEFAULT_POLL_MS = 3000;
const DEFAULT_TOUCH_PATH = '';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv) {
  const opts = {
    baseUrl: process.env.HOME23_DASHBOARD_URL || DEFAULT_BASE_URL,
    timeoutMs: Number(process.env.HOME23_SYNTHESIS_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
    pollMs: Number(process.env.HOME23_SYNTHESIS_POLL_MS || DEFAULT_POLL_MS),
    maxAgeMs: Number(process.env.HOME23_SYNTHESIS_MAX_AGE_MS || 0),
    touchPath: process.env.HOME23_SYNTHESIS_TOUCH_PATH || DEFAULT_TOUCH_PATH,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--base-url') opts.baseUrl = argv[++i] || opts.baseUrl;
    else if (arg === '--timeout-ms') opts.timeoutMs = Number(argv[++i] || opts.timeoutMs);
    else if (arg === '--poll-ms') opts.pollMs = Number(argv[++i] || opts.pollMs);
    else if (arg === '--max-age-ms') opts.maxAgeMs = Number(argv[++i] || opts.maxAgeMs);
    else if (arg === '--touch-path') opts.touchPath = argv[++i] || opts.touchPath;
    else if (arg === '--no-touch') opts.touchPath = '';
  }

  opts.baseUrl = String(opts.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
  if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0) opts.timeoutMs = DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(opts.pollMs) || opts.pollMs <= 0) opts.pollMs = DEFAULT_POLL_MS;
  if (!Number.isFinite(opts.maxAgeMs) || opts.maxAgeMs < 0) opts.maxAgeMs = 0;
  opts.touchPath = String(opts.touchPath || '');
  return opts;
}

function touchFreshnessFile(path) {
  if (!path) return;
  const now = new Date();
  fs.utimesSync(path, now, now);
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(options.timeoutMs || 10000),
  });
  const text = await res.text();
  let body = {};
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text.slice(0, 500) };
    }
  }
  if (!res.ok) {
    const detail = body.error || body.message || body.raw || `HTTP ${res.status}`;
    throw new Error(`${url} failed: ${detail}`);
  }
  return body;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const startedAt = Date.now();
  const freshAfter = startedAt - 5000;

  if (opts.maxAgeMs > 0) {
    const currentState = await fetchJson(`${opts.baseUrl}/api/synthesis/state`, { timeoutMs: 15000 });
    const generatedAtMs = Date.parse(currentState.generatedAt || '');
    if (Number.isFinite(generatedAtMs)) {
      const ageMs = Date.now() - generatedAtMs;
      touchFreshnessFile(opts.touchPath);
      if (ageMs >= 0 && ageMs <= opts.maxAgeMs) {
        console.log(`synthesis already fresh: generatedAt=${currentState.generatedAt}, age=${Math.round(ageMs / 1000)}s`);
        return;
      }
      console.log(`synthesis stale: generatedAt=${currentState.generatedAt}, age=${Math.round(ageMs / 1000)}s; touched verifier file before refresh`);
    }
  }

  const start = await fetchJson(`${opts.baseUrl}/api/synthesis/run`, {
    method: 'POST',
    timeoutMs: 15000,
  });

  if (start.started === false && !/already running/i.test(String(start.message || ''))) {
    throw new Error(`synthesis did not start: ${start.message || JSON.stringify(start)}`);
  }

  const deadline = startedAt + opts.timeoutMs;
  let lastState = null;
  while (Date.now() < deadline) {
    await sleep(opts.pollMs);
    lastState = await fetchJson(`${opts.baseUrl}/api/synthesis/state`, { timeoutMs: 15000 });
    const generatedAtMs = Date.parse(lastState.generatedAt || '');
    if (Number.isFinite(generatedAtMs) && generatedAtMs >= freshAfter) {
      touchFreshnessFile(opts.touchPath);
      const ageSec = Math.max(0, Math.round((Date.now() - generatedAtMs) / 1000));
      console.log(`synthesis fresh: generatedAt=${lastState.generatedAt}, age=${ageSec}s`);
      return;
    }
  }

  throw new Error(`synthesis did not refresh within ${opts.timeoutMs}ms; last generatedAt=${lastState?.generatedAt || 'none'}`);
}

main().catch((err) => {
  console.error(`synthesis refresh failed: ${err.message}`);
  process.exit(1);
});
