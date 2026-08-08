/**
 * lobe-broker — the Mac-side half of credential-free remote cognition.
 *
 *   BROKER_SSH_HOST     — ssh host alias for the machine hosting the Seed (required)
 *   BROKER_REMOTE_DIR   — exchange dir on that machine (required)
 *   BROKER_MODEL        — model to recruit (default claude-haiku-4-5)
 *   BROKER_INTERVAL_MS  — poll cadence (default 15000)
 *   BROKER_MAX_PER_TICK — spend guard: requests serviced per tick (default 2)
 *   BROKER_FORMS_REMOTE — remote forms dir to mirror locally (optional)
 *   BROKER_FORMS_DEST   — local mirror destination (required with above)
 *   BROKER_FORMS_EVERY_TICKS — mirror cadence in ticks (default 30)
 *   BROKER_STATE_REMOTE — remote seed state dir to mirror read-only
 *                         (checkpoints + ledger; feeds the observatory)
 *   BROKER_STATE_DEST   — local destination for the state mirror
 *
 * Polls <remote>/requests/ over ssh, services each request with Home23's
 * provider transport (keys loaded from config/secrets.yaml into env HERE,
 * on the trusted machine — they never travel), writes the result file back
 * atomically, then removes the request. Result-before-delete: a crash
 * between the two re-services the request; duplicate results are orphan
 * files the Seed-side transport sweeps. At-least-once, never silent.
 *
 * All remote paths are validated tokens (no shell interpolation of request
 * content); ssh runs via execFile with argument arrays.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { parseLobeRequest, formatLobeResult } from '../src/lobe-file-transport.js';
import type { LobeFileResult } from '../src/lobe-file-transport.js';

const sshHost = process.env['BROKER_SSH_HOST'];
const remoteDir = process.env['BROKER_REMOTE_DIR'];
if (sshHost === undefined || remoteDir === undefined) {
  console.error('BROKER_SSH_HOST and BROKER_REMOTE_DIR are required');
  process.exit(2);
}
if (!/^[A-Za-z0-9._@-]+$/.test(sshHost) || !/^[A-Za-z0-9._/-]+$/.test(remoteDir)) {
  console.error('BROKER_SSH_HOST or BROKER_REMOTE_DIR contains unsafe characters');
  process.exit(2);
}

const model = process.env['BROKER_MODEL'] ?? 'claude-haiku-4-5';
const intervalMs = Number(process.env['BROKER_INTERVAL_MS'] ?? 15_000);
const maxPerTick = Number(process.env['BROKER_MAX_PER_TICK'] ?? 2);
const FILE_PATTERN = /^req_[a-z0-9]+_[0-9]+\.json$/;

/** Provider keys come from secrets.yaml into THIS process's env — the same
 * values PM2 would inject. Nothing is written anywhere. Home23's OAuth
 * tokens ROTATE (cosmo23 broker + the dashboard's 30-min re-sync poller
 * keep secrets.yaml fresh), so a long-lived broker must be able to re-read:
 * `force` overwrites the env from the current file. Proven live 2026-08-08 —
 * a 16h-old broker held a revoked token while secrets.yaml sat fresh. */
function loadProviderEnv(force = false): void {
  const repoRoot = resolve(import.meta.dirname, '..', '..');
  const secretsPath = resolve(repoRoot, 'config', 'secrets.yaml');
  let secrets: Record<string, { apiKey?: string } | undefined> = {};
  try {
    const requireFromRepo = createRequire(resolve(repoRoot, 'package.json'));
    const yaml = requireFromRepo('js-yaml') as { load: (s: string) => unknown };
    const parsed = yaml.load(readFileSync(secretsPath, 'utf-8')) as { providers?: typeof secrets };
    secrets = parsed?.providers ?? {};
  } catch (error) {
    console.error(`[broker] could not load secrets.yaml: ${(error as Error).message}`);
  }
  const mapping: Array<[string, string]> = [
    ['ollama-cloud', 'OLLAMA_CLOUD_API_KEY'],
    ['anthropic', 'ANTHROPIC_AUTH_TOKEN'],
    ['openai', 'OPENAI_API_KEY'],
    ['xai', 'XAI_API_KEY'],
    ['minimax', 'MINIMAX_API_KEY'],
  ];
  for (const [providerName, envName] of mapping) {
    const key = secrets[providerName]?.apiKey;
    if (typeof key === 'string' && key !== '' && (force || process.env[envName] === undefined || process.env[envName] === '')) {
      process.env[envName] = key;
    }
  }
}

/** 401/revoked-token shaped failures mean our env snapshot went stale. */
function isAuthFailure(message: string): boolean {
  return /authentication_error|revoked|\b401\b/i.test(message);
}

function ssh(command: string, input?: string): string {
  return execFileSync('ssh', ['-o', 'ConnectTimeout=10', sshHost as string, command], {
    encoding: 'utf-8',
    timeout: 30_000,
    ...(input !== undefined ? { input } : {}),
  });
}

type Transport = (prompt: string) => Promise<{
  text: string;
  modelReceipt: { modelId: string; provider: string; invokedAt: string; durationMs: number; tokensIn: number; tokensOut: number };
}>;

async function buildTransport(): Promise<Transport> {
  const transportModulePath = new URL('../../src/substrate/lobe-transport.ts', import.meta.url).href;
  const mod = (await import(transportModulePath)) as {
    createSeedLobeTransport: (opts: { model: string }) => Transport;
  };
  return mod.createSeedLobeTransport({ model });
}

async function tick(transport: Transport): Promise<void> {
  let listing = '';
  try {
    listing = ssh(`ls ${remoteDir}/requests 2>/dev/null || true`);
  } catch (error) {
    console.error(`[broker] list failed: ${(error as Error).message}`);
    return;
  }
  const pending = listing.split('\n').map((l) => l.trim()).filter((l) => FILE_PATTERN.test(l)).sort();
  for (const fileName of pending.slice(0, maxPerTick)) {
    const requestPath = `${remoteDir}/requests/${fileName}`;
    let result: LobeFileResult;
    let id = fileName.replace(/\.json$/, '');
    try {
      const raw = ssh(`cat ${requestPath}`);
      const request = parseLobeRequest(raw);
      id = request.id;
      console.log(`[broker] servicing ${id} (${request.prompt.length} chars) with ${model}`);
      const { text, modelReceipt } = await transport(request.prompt);
      result = { id, text, modelReceipt };
    } catch (error) {
      const message = (error as Error).message;
      result = { id, error: message.slice(0, 300) };
      console.error(`[broker] ${id} failed: ${message}`);
      if (isAuthFailure(message)) {
        // Token rotated under us — re-read secrets.yaml so the NEXT request
        // uses the fresh credential (generateText reads env per call).
        loadProviderEnv(true);
        console.log('[broker] auth failure — provider env refreshed from secrets.yaml');
      }
    }
    const resultPath = `${remoteDir}/results/res-${id}.json`;
    try {
      ssh(`mkdir -p ${remoteDir}/results && cat > ${resultPath}.tmp && mv ${resultPath}.tmp ${resultPath}`, formatLobeResult(result));
      ssh(`rm -f ${requestPath}`);
      console.log(`[broker] ${id} → ${result.error !== undefined ? `error(${result.error.slice(0, 60)})` : 'result delivered'}`);
    } catch (error) {
      console.error(`[broker] deliver ${id} failed: ${(error as Error).message}`);
    }
  }
}

// ─── Forms mirror: the conversational read aperture ──────────────────────────
// Jerry (and anyone on the trusted machine) reads the Seed's forms with plain
// file tools. Pull-based rsync, read-only at the source, no write path back —
// the mirror is a window, not a channel.

const formsRemote = process.env['BROKER_FORMS_REMOTE'];
const formsDest = process.env['BROKER_FORMS_DEST'];
const formsEveryTicks = Number(process.env['BROKER_FORMS_EVERY_TICKS'] ?? 30);
if (formsRemote !== undefined && !/^[A-Za-z0-9._/-]+$/.test(formsRemote)) {
  console.error('BROKER_FORMS_REMOTE contains unsafe characters');
  process.exit(2);
}

function mirrorForms(): void {
  if (formsRemote === undefined || formsDest === undefined) return;
  try {
    execFileSync('rsync', ['-a', '--delete', `${sshHost}:${formsRemote}/`, `${formsDest}/`], { timeout: 60_000 });
    console.log(`[broker] forms mirrored to ${formsDest}`);
  } catch (error) {
    console.error(`[broker] forms mirror failed: ${(error as Error).message}`);
  }
  const stateRemote = process.env['BROKER_STATE_REMOTE'];
  const stateDest = process.env['BROKER_STATE_DEST'];
  if (stateRemote !== undefined && stateDest !== undefined && /^[A-Za-z0-9._/-]+$/.test(stateRemote)) {
    try {
      execFileSync('rsync', ['-az', `${sshHost}:${stateRemote}/checkpoints`, `${sshHost}:${stateRemote}/seed-ledger.jsonl`, `${stateDest}/`], { timeout: 60_000 });
      console.log(`[broker] state mirrored to ${stateDest}`);
    } catch (error) {
      console.error(`[broker] state mirror failed: ${(error as Error).message}`);
    }
  }
}

async function main(): Promise<void> {
  loadProviderEnv();
  const transport = await buildTransport();
  console.log(`[broker] serving ${sshHost}:${remoteDir} with ${model}, every ${intervalMs}ms`);
  await tick(transport);
  mirrorForms();
  let ticks = 0;
  // The interval keeps the process alive — deliberately NOT unref'd.
  setInterval(() => {
    ticks++;
    tick(transport).catch((error) => console.error('[broker] tick error:', (error as Error).message));
    if (ticks % formsEveryTicks === 0) mirrorForms();
  }, intervalMs);
}

main().catch((error) => {
  console.error('[broker] fatal:', error);
  process.exit(1);
});
