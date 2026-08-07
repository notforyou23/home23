/**
 * lobe-broker — the Mac-side half of credential-free remote cognition.
 *
 *   BROKER_SSH_HOST     — ssh host alias for the machine hosting the Seed (required)
 *   BROKER_REMOTE_DIR   — exchange dir on that machine (required)
 *   BROKER_MODEL        — model to recruit (default glm-5.2:cloud)
 *   BROKER_INTERVAL_MS  — poll cadence (default 15000)
 *   BROKER_MAX_PER_TICK — spend guard: requests serviced per tick (default 2)
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

const model = process.env['BROKER_MODEL'] ?? 'glm-5.2:cloud';
const intervalMs = Number(process.env['BROKER_INTERVAL_MS'] ?? 15_000);
const maxPerTick = Number(process.env['BROKER_MAX_PER_TICK'] ?? 2);
const FILE_PATTERN = /^req_[a-z0-9]+_[0-9]+\.json$/;

/** Provider keys come from secrets.yaml exactly once, into THIS process's
 * env — the same values PM2 would inject. Nothing is written anywhere. */
function loadProviderEnv(): void {
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
    if (typeof key === 'string' && key !== '' && (process.env[envName] === undefined || process.env[envName] === '')) {
      process.env[envName] = key;
    }
  }
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
      result = { id, error: (error as Error).message.slice(0, 300) };
      console.error(`[broker] ${id} failed: ${(error as Error).message}`);
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

async function main(): Promise<void> {
  loadProviderEnv();
  const transport = await buildTransport();
  console.log(`[broker] serving ${sshHost}:${remoteDir} with ${model}, every ${intervalMs}ms`);
  await tick(transport);
  // The interval keeps the process alive — deliberately NOT unref'd.
  setInterval(() => {
    tick(transport).catch((error) => console.error('[broker] tick error:', (error as Error).message));
  }, intervalMs);
}

main().catch((error) => {
  console.error('[broker] fatal:', error);
  process.exit(1);
});
