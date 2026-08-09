/**
 * Seed runner entry point (shadow mode).
 *
 *   SEED_STATE_DIR      — the Seed's own state root (required)
 *   SEED_SOURCE         — harness event-ledger.jsonl to tail read-only (required)
 *   SEED_MAX_EVENTS     — stop after N transitions (transient/proof runs)
 *   SEED_BACKFILL_BYTES — start this many bytes before the source's end
 *   SEED_LOBE           — 'echo' = deterministic EchoLobe; 'model' = real model
 *                         via Home23's provider transport; 'file' = broker
 *                         exchange (credential-free hosts); unset = none
 *   SEED_LOBE_MODEL     — model for SEED_LOBE=model (default claude-haiku-4-5)
 *   SEED_LOBE_EXCHANGE  — exchange dir for SEED_LOBE=file (required for it)
 *   SEED_LOBE_MIN_INTERVAL_MS — resident spend guard (default 600000 = 10 min)
 *   SEED_LOBE_TIMEOUT_MS — per-recruitment cap (default 30000; raise for
 *                          SEED_LOBE=file, where broker poll + model stack)
 *   SEED_POLL_MS        — poll interval (default 2000)
 *   SEED_RELATIONSHIP_SOURCE — relationship-ledger events JSONL (optional)
 *   SEED_WORKER_SOURCE  — worker-runs JSONL (optional)
 *   SEED_EXTRA_BACKFILL_BYTES — backfill for extra sources (default 8192)
 *   SEED_ANATOMY        — JSON array of {id, role} for a BIRTH (ignored on
 *                         restore; anatomy is identity, recorded in genesis)
 *   SEED_NAME           — name recorded in the genesis at birth
 *   SEED_SELF_FORMATION — '1' at BIRTH grants growth.v2 governed
 *                         self-application (SELF-FORMATION-PROTOCOL v1.1);
 *                         a birth property, ignored on restore
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
  if (kind === 'file') {
    // Credential-free hosts: requests go to an exchange dir; a broker on a
    // trusted machine services them and the REAL model receipt comes back
    // with the result. This process never holds a key or opens a port.
    const exchangeDir = process.env['SEED_LOBE_EXCHANGE'];
    if (exchangeDir === undefined || exchangeDir === '') {
      throw new Error('SEED_LOBE=file requires SEED_LOBE_EXCHANGE');
    }
    const { createFileLobeTransport } = await import('../src/lobe-file-transport.js');
    return new ModelLobe('lobe.broker', 'via-broker', 'home23.broker', createFileLobeTransport(exchangeDir));
  }
  if (kind === 'model') {
    const model = process.env['SEED_LOBE_MODEL'] ?? 'claude-haiku-4-5';
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
  // The life itself: the agent's real conversations with his person, shipped
  // by substrate/bin/conversation-shipper.ts with words + perceived vectors.
  const conversationSource = process.env['SEED_CONVERSATION_SOURCE'];
  if (conversationSource !== undefined && conversationSource !== '') {
    extraSources.push({ sourcePath: conversationSource, sourceType: 'conversation-stream', id: 'conversation', backfillBytes: extraBackfill });
  }
  // The home as senses: lived house transitions (substrate/bin/house-sense.ts).
  const houseSource = process.env['SEED_HOUSE_SOURCE'];
  if (houseSource !== undefined && houseSource !== '') {
    extraSources.push({ sourcePath: houseSource, sourceType: 'house-stream', id: 'house', backfillBytes: extraBackfill });
  }
  // Deliberate memory promotions (promote_to_memory) — relationship-format
  // lines with words + meaning; the Seed IS the promotion pipeline now.
  const memorySource = process.env['SEED_MEMORY_SOURCE'];
  if (memorySource !== undefined && memorySource !== '') {
    extraSources.push({ sourcePath: memorySource, sourceType: 'relationship-ledger', id: 'memory', backfillBytes: Math.max(extraBackfill, 65536) });
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
    selfFormation: process.env['SEED_SELF_FORMATION'] === '1',
    maxEvents: numEnv('SEED_MAX_EVENTS'),
    backfillBytes: numEnv('SEED_BACKFILL_BYTES'),
    pollMs: numEnv('SEED_POLL_MS') ?? 2000,
    extraSources,
    lobe: await buildLobe(),
    lobeMinIntervalMs: numEnv('SEED_LOBE_MIN_INTERVAL_MS') ?? 600_000,
    lobeTimeoutMs: numEnv('SEED_LOBE_TIMEOUT_MS'),
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
