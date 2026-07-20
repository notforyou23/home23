#!/usr/bin/env node
'use strict';

/**
 * Migrate legacy COSMO research runs to manifest-v1 memory sidecars.
 *
 * Completed research brains persisted only state.json.gz (inline memory);
 * the brain-operations source reader requires manifest-v1, so every query
 * or search against them failed with source_unavailable while the catalog
 * showed their node counts (found 2026-07-20, jerry's 07-19 session).
 *
 * The migration is ADDITIVE ONLY: it writes memory-manifest.json plus the
 * base .jsonl.gz sidecars next to the run's existing artifacts via
 * cosmo23's own persistResearchState with a no-op saveState — the original
 * state.json.gz and every other run artifact are left byte-identical
 * (cosmo23/runs history is never modified, per AGENTS.md).
 *
 * Usage: node scripts/migrate-legacy-research-runs.cjs [--apply] [runId...]
 * Default is dry-run. Without runIds, scans every run dir, skipping test
 * artifacts (cosmo23-acceptance-*, smoke-*, anthropic-oauth-smoke-*);
 * naming a run explicitly overrides the skip patterns.
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { persistResearchState } = require('../cosmo23/lib/memory-sidecar.js');

const MAX_GZ_BYTES = 64 * 1024 * 1024;
const MAX_RAW_BYTES = 512 * 1024 * 1024;
const SKIP_PATTERNS = [/^cosmo23-acceptance/, /^smoke-/, /^anthropic-oauth-smoke/];

function loadState(runDir) {
  const statePath = path.join(runDir, 'state.json.gz');
  const stat = fs.statSync(statePath);
  if (stat.size > MAX_GZ_BYTES) {
    throw Object.assign(new Error(`state.json.gz is ${stat.size} bytes (cap ${MAX_GZ_BYTES})`), {
      code: 'state_too_large',
    });
  }
  const raw = zlib.gunzipSync(fs.readFileSync(statePath), { maxOutputLength: MAX_RAW_BYTES });
  return JSON.parse(raw.toString('utf8'));
}

async function migrateRun(runsRoot, runId, { apply }) {
  const runDir = path.join(runsRoot, runId);
  const receipt = { runId, outcome: null, nodes: 0, edges: 0 };
  if (!fs.existsSync(path.join(runDir, 'state.json.gz'))) {
    receipt.outcome = 'skipped_no_state';
    return receipt;
  }
  if (fs.existsSync(path.join(runDir, 'memory-manifest.json'))) {
    receipt.outcome = 'skipped_already_manifest';
    return receipt;
  }
  let state;
  try {
    state = loadState(runDir);
  } catch (error) {
    receipt.outcome = 'failed_unreadable_state';
    receipt.error = error?.code || error?.message;
    return receipt;
  }
  const memory = state?.memory;
  if (!memory || !Array.isArray(memory.nodes) || !Array.isArray(memory.edges)) {
    receipt.outcome = 'skipped_no_inline_memory';
    return receipt;
  }
  receipt.nodes = memory.nodes.length;
  receipt.edges = memory.edges.length;
  if (receipt.nodes === 0 && receipt.edges === 0) {
    receipt.outcome = 'skipped_empty_memory';
    return receipt;
  }
  if (!apply) {
    receipt.outcome = 'would_migrate';
    return receipt;
  }
  const result = await persistResearchState(runDir, state, {
    // Additive only: the manifest sidecars are committed by
    // persistCapturedResearchMemory before saveState runs; refusing the
    // shell write keeps state.json.gz byte-identical.
    saveState: async () => null,
    logger: console,
  });
  if (result.degraded) {
    receipt.outcome = 'failed_manifest_commit';
    receipt.error = result.error?.code || result.error?.message;
    return receipt;
  }
  receipt.outcome = 'migrated';
  receipt.revision = result.revision;
  return receipt;
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const named = args.filter((value) => value !== '--apply');
  const home23Root = path.resolve(__dirname, '..');
  const runsRoot = path.join(home23Root, 'cosmo23', 'runs');
  const targets = named.length > 0
    ? named
    : fs.readdirSync(runsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => entry.name)
      .filter((name) => !SKIP_PATTERNS.some((pattern) => pattern.test(name)))
      .sort();

  const receipts = [];
  for (const runId of targets) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/.test(runId)) {
      receipts.push({ runId, outcome: 'skipped_invalid_name' });
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const receipt = await migrateRun(runsRoot, runId, { apply });
    receipts.push(receipt);
    console.log(`${apply ? '' : 'DRY '}${receipt.outcome} ${runId}`
      + (receipt.nodes ? ` nodes=${receipt.nodes} edges=${receipt.edges}` : '')
      + (receipt.error ? ` error=${receipt.error}` : ''));
  }
  const summary = receipts.reduce((acc, receipt) => {
    acc[receipt.outcome] = (acc[receipt.outcome] || 0) + 1;
    return acc;
  }, {});
  console.log(`${apply ? 'APPLIED' : 'DRY RUN'} ${JSON.stringify(summary)}`);
  if (receipts.some((receipt) => receipt.outcome.startsWith('failed'))) process.exitCode = 1;
}

main().catch((error) => {
  console.error('FAILED:', error?.message || error);
  process.exit(1);
});
