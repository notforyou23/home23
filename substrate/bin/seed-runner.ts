/**
 * Seed runner entry point (shadow mode).
 *
 *   SEED_STATE_DIR      — the Seed's own state root (required)
 *   SEED_SOURCE         — harness event-ledger.jsonl to tail read-only (required)
 *   SEED_MAX_EVENTS     — stop after N transitions (transient/proof runs)
 *   SEED_BACKFILL_BYTES — start this many bytes before the source's end
 *   SEED_LOBE           — 'echo' = deterministic EchoLobe; 'model' = real model
 *                         via Home23's provider transport; unset = none
 *   SEED_LOBE_MODEL     — model for SEED_LOBE=model (default glm-5.2:cloud)
 *   SEED_LOBE_MIN_INTERVAL_MS — resident spend guard (default 600000 = 10 min)
 *   SEED_POLL_MS        — poll interval (default 2000)
 *   SEED_RELATIONSHIP_SOURCE — relationship-ledger events JSONL (optional)
 *   SEED_WORKER_SOURCE  — worker-runs JSONL (optional)
 *   SEED_EXTRA_BACKFILL_BYTES — backfill for extra sources (default 8192)
 *   SEED_ANATOMY        — JSON array of {id, role} for a BIRTH (ignored on
 *                         restore; anatomy is identity, recorded in genesis)
 *   SEED_NAME           — name recorded in the genesis at birth
 *
 * Residency note: this file still does not self-register with PM2 — the
 * ecosystem generator emits a home23-<agent>-seed app only when the agent's
 * config has substrate.enabled: true, which is an operator decision.
 */

import { SeedRunner } from '../src/runner.js';
import { EchoLobe, ModelLobe } from '../src/lobe.js';
import type { LobeAdapter } from '../src/lobe.js';

const stateDir = process.env['SEED_STATE_DIR'];
const sourcePath = process.env['SEED_SOURCE'];
if (stateDir === undefined || sourcePath === undefined) {
  console.error('SEED_STATE_DIR and SEED_SOURCE are required');
  process.exit(2);
}

const numEnv = (name: string): number | undefined => {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
};

async function buildLobe(): Promise<LobeAdapter | undefined> {
  const kind = process.env['SEED_LOBE'];
  if (kind === 'echo') return new EchoLobe();
  if (kind === 'model') {
    const model = process.env['SEED_LOBE_MODEL'] ?? 'glm-5.2:cloud';
    // Runtime-resolved import: the transport lives in src/ (harness territory,
    // where provider contracts and credentials belong). The substrate package
    // itself never links against it — this seam is the membrane's edge.
    const transportModulePath = new URL('../../src/substrate/lobe-transport.ts', import.meta.url).href;
    const mod = (await import(transportModulePath)) as {
      createSeedLobeTransport: (opts: { model: string }) => (prompt: string) => Promise<{
        text: string;
        modelReceipt: { modelId: string; provider: string; invokedAt: string; durationMs: number; tokensIn: number; tokensOut: number };
      }>;
    };
    const transport = mod.createSeedLobeTransport({ model });
    return new ModelLobe(`lobe.model.${model}`, model, 'home23.providers', (prompt) => transport(prompt));
  }
  return undefined;
}

async function main(): Promise<void> {
  const extraBackfill = numEnv('SEED_EXTRA_BACKFILL_BYTES') ?? 8192;
  const extraSources: NonNullable<ConstructorParameters<typeof SeedRunner>[0]['extraSources']> = [];
  const relationshipSource = process.env['SEED_RELATIONSHIP_SOURCE'];
  if (relationshipSource !== undefined && relationshipSource !== '') {
    extraSources.push({ sourcePath: relationshipSource, sourceType: 'relationship-ledger', id: 'relationship', backfillBytes: extraBackfill });
  }
  const workerSource = process.env['SEED_WORKER_SOURCE'];
  if (workerSource !== undefined && workerSource !== '') {
    extraSources.push({ sourcePath: workerSource, sourceType: 'worker-runs', id: 'worker-runs', backfillBytes: extraBackfill });
  }

  let anatomy;
  const rawAnatomy = process.env['SEED_ANATOMY'];
  if (rawAnatomy !== undefined && rawAnatomy !== '') {
    anatomy = JSON.parse(rawAnatomy);
  }

  const runner = new SeedRunner({
    stateDir: stateDir as string,
    sourcePath: sourcePath as string,
    anatomy,
    name: process.env['SEED_NAME'],
    maxEvents: numEnv('SEED_MAX_EVENTS'),
    backfillBytes: numEnv('SEED_BACKFILL_BYTES'),
    pollMs: numEnv('SEED_POLL_MS') ?? 2000,
    extraSources,
    lobe: await buildLobe(),
    lobeMinIntervalMs: numEnv('SEED_LOBE_MIN_INTERVAL_MS') ?? 600_000,
    log: (line) => console.log(`[seed] ${line}`),
  });

  process.on('SIGINT', () => runner.requestStop());
  process.on('SIGTERM', () => runner.requestStop());

  await runner.run();
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('[seed] fatal:', error);
    process.exit(1);
  });
