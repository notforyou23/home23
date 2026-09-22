/**
 * Prepare a non-live managed source for adoption.
 * Seed receipts come only from prepareSeedBirth. Conversation lines come only
 * from ChatHistory.append. The encoder file records the owned recipe id and
 * does not claim the encoder finished. No live home is read.
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { prepareSeedBirth } from './seed-birth.js';
import { OWNED_RECIPE_HASH, writeSemanticPrep } from './product-embedder.js';

const NAME = /^[a-z][a-z0-9-]{0,62}$/;

export async function prepareManagedAdoptionSource({ root, residents } = {}) {
  if (typeof root !== 'string' || !root.startsWith('/')) throw new Error('Adoption source root must be absolute.');
  if (!Array.isArray(residents) || residents.length < 2) throw new Error('A managed adoption source needs two residents.');
  const names = residents.map(resident => resident?.name);
  if (new Set(names).size !== names.length || names.some(name => !NAME.test(name || ''))) {
    throw new Error('Resident names must be unique lowercase slugs.');
  }
  if (existsSync(root)) {
    const stat = lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || readdirSync(root).length) {
      throw new Error('Adoption source root already exists and is not an empty directory. Refusing to write birth, config, or release markers.');
    }
  }
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const births = [];
  const { tsImport } = await import('tsx/esm/api');
  const { ConversationHistory } = await tsImport('../../src/agent/history.ts', import.meta.url);
  for (const resident of residents) {
    const birth = await prepareSeedBirth(root, {
      name: resident.name,
      ownerName: resident.ownerName,
      purpose: resident.purpose,
      provider: resident.provider,
      model: resident.model,
    });
    if (birth.receipt?.schema !== 'home23.seed-birth.v1' || birth.receipt.runtimeStarted !== false) {
      throw new Error(`Seed birth for ${resident.name} was not a fresh verified receipt.`);
    }
    const conversations = join(root, 'instances', resident.name, 'conversations');
    mkdirSync(conversations, { recursive: true, mode: 0o700 });
    const history = new ConversationHistory(conversations, 400_000, resident.name);
    history.append('local-note', [{
      role: 'user',
      content: resident.note,
    }]);
    births.push({ name: resident.name, seedId: birth.receipt.seedId, genesisHash: birth.receipt.genesisHash });
  }
  mkdirSync(join(root, 'runtime'), { recursive: true, mode: 0o700 });
  writeSemanticPrep(root, {
    handle: 'managed-adoption-source',
    phase: 'downloading',
    workerPid: 0,
    recipeId: OWNED_RECIPE_HASH,
    cacheDir: join(root, 'runtime', 'embedder-cache'),
  });
  mkdirSync(join(root, 'instances/.house/coordination'), { recursive: true, mode: 0o700 });
  const residentsRecord = Object.fromEntries(names.map(name => [name, {}]));
  writeFileSync(join(root, 'instances/.house/coordination/active-release.json'), `${JSON.stringify({
    releaseId: 'local-managed-adoption-source',
    residents: residentsRecord,
  }, null, 2)}\n`);
  mkdirSync(join(root, 'config'), { recursive: true, mode: 0o700 });
  writeFileSync(join(root, 'config/home.yaml'), `home:\n  primaryAgent: ${names[0]}\n`, { mode: 0o600 });
  return { root, births, recipeId: OWNED_RECIPE_HASH, primary: names[0] };
}
