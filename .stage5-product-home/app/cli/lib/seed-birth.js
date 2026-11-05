/**
 * Prepare a new resident's actual Seed before its first runtime start.
 * Uses the existing substrate genesis/checkpoint implementation. No lobe is
 * recruited here, and no historical resident files are copied. A complete
 * birth is published by one directory rename; retries verify its receipt and
 * return the same lineage without appending to it.
 */

import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';

const RECEIPT_FILE = 'birth-receipt.json';
const RECEIPT_SCHEMA = 'home23.seed-birth.v1';

export const FRESH_SEED_ANATOMY = Object.freeze([
  Object.freeze({ id: 'contact.owner', role: 'correction' }),
  Object.freeze({ id: 'frontier.becoming', role: 'interpretation' }),
  Object.freeze({ id: 'work.projects', role: 'consequence' }),
  Object.freeze({ id: 'world.home', role: 'observation' }),
  Object.freeze({ id: 'periphery.open-field', role: 'periphery' }),
]);

const hash = (value) => createHash('sha256').update(value).digest('hex');

function nonemptyString(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Seed birth requires ${field}`);
  return value.trim();
}

function directoryIfPresent(path) {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Seed birth requires a real directory: ${path}`);
  }
}

/**
 * @returns {Promise<{substrate: object, receipt: object, stateDir: string}>}
 * The caller writes `substrate` into the new agent's configuration before
 * generating its ecosystem. Existing homes require an explicit migration;
 * an unreceipted Seed is never adopted or rewritten by this creation path.
 */
export async function prepareSeedBirth(root, { name, ownerName, purpose, provider, model } = {}) {
  if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new Error('Seed agent name must be lowercase alphanumeric with hyphens');
  }
  const identity = {
    name,
    ownerName: nonemptyString(ownerName, 'ownerName'),
    purpose: nonemptyString(purpose, 'purpose'),
    provider: nonemptyString(provider, 'provider'),
    model: nonemptyString(model, 'model'),
  };
  const substrate = {
    enabled: true,
    name,
    anatomy: FRESH_SEED_ANATOMY.map((cell) => ({ ...cell })),
    selfFormation: true,
    lobe: 'model',
    lobeProvider: identity.provider,
    lobeModel: identity.model,
    lobeMinIntervalMs: 600000,
  };
  const inputDigest = hash(JSON.stringify({ identity, substrate }));
  const instancesDir = join(resolve(root), 'instances');
  const instanceDir = join(instancesDir, name);
  const substrateDir = join(instanceDir, 'substrate');
  const stateDir = join(substrateDir, 'seed-01');
  for (const path of [instancesDir, instanceDir, substrateDir, stateDir]) directoryIfPresent(path);

  // CLI setup is plain JavaScript. Load the same TypeScript substrate module
  // through the runtime dependency already used by supervised Seed runners.
  const { tsImport } = await import('tsx/esm/api');
  const { SeedProcess } = await tsImport('../../substrate/src/seed.ts', import.meta.url);
  const { SeedLedger } = await tsImport('../../substrate/src/ledger.ts', import.meta.url);

  function readBirth() {
    const receiptPath = join(stateDir, RECEIPT_FILE);
    if (!existsSync(receiptPath)) {
      throw new Error(`Seed state already exists without a birth receipt: ${stateDir}`);
    }
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    if (receipt.schema !== RECEIPT_SCHEMA || receipt.inputDigest !== inputDigest) {
      throw new Error('Existing Seed birth does not match this home creation request');
    }
    const ledger = new SeedLedger(stateDir);
    const chain = ledger.verifyChain();
    const genesis = ledger.readAll()[0];
    if (!chain.ok || genesis?.category !== 'genesis'
      || genesis.payload.seedId !== receipt.seedId || genesis.payload.name !== name
      || genesis.payload.selfFormation !== true
      || JSON.stringify(genesis.payload.anatomy) !== JSON.stringify(substrate.anatomy)
      || ledger.cursorAt(1) !== receipt.genesisHash) {
      throw new Error('Existing Seed birth lineage failed verification');
    }
    // Check exact birth checkpoint bytes before invoking restore, so the
    // creation retry never quarantines or repairs existing runtime state.
    if (typeof receipt.checkpointId !== 'string' || !/^ckpt_[a-z0-9_]+$/.test(receipt.checkpointId)) {
      throw new Error('Existing Seed birth has an invalid checkpoint identity');
    }
    const checkpoint = readFileSync(join(stateDir, 'checkpoints', `${receipt.checkpointId}.json`));
    if (hash(checkpoint) !== receipt.checkpointDigest) {
      throw new Error('Existing Seed birth checkpoint failed verification');
    }
    const restored = SeedProcess.restore(stateDir, receipt.checkpointId);
    if (restored.getState().seedId !== receipt.seedId) throw new Error('Existing Seed birth identity mismatch');
    return { substrate, receipt, stateDir };
  }

  if (existsSync(stateDir)) return readBirth();
  mkdirSync(substrateDir, { recursive: true });
  const stagedDir = mkdtempSync(join(substrateDir, '.birth-'));
  try {
    const seed = SeedProcess.initialize(stagedDir, undefined, {
      name,
      anatomy: substrate.anatomy,
      selfFormation: substrate.selfFormation,
    });
    const checkpointId = seed.checkpoint();
    const ledger = new SeedLedger(stagedDir);
    const restored = SeedProcess.restore(stagedDir);
    const state = restored.getState();
    if (!ledger.verifyChain().ok || state.seedId !== seed.getState().seedId) {
      throw new Error('New Seed birth could not be restored and verified');
    }
    const receipt = {
      schema: RECEIPT_SCHEMA,
      name,
      seedId: state.seedId,
      preparedAt: new Date().toISOString(),
      inputDigest,
      genesisHash: ledger.cursorAt(1),
      checkpointId,
      checkpointDigest: hash(readFileSync(join(stagedDir, 'checkpoints', `${checkpointId}.json`))),
      stateDir: 'substrate/seed-01',
      runtimeStarted: false,
      modelInvocations: 0,
    };
    writeFileSync(join(stagedDir, RECEIPT_FILE), `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    // A concurrent successful creation wins. Verify that exact request and
    // discard only this invocation's unpublished staging directory.
    if (existsSync(stateDir)) return readBirth();
    try {
      renameSync(stagedDir, stateDir);
    } catch (error) {
      if (existsSync(stateDir)) return readBirth();
      throw error;
    }
    return { substrate, receipt, stateDir };
  } finally {
    if (existsSync(stagedDir)) rmSync(stagedDir, { recursive: true, force: true });
  }
}
