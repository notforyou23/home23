/**
 * Home23 — System Health
 *
 * Self-healing function that ensures all plumbing is correct.
 * Runs on every start and after every update. Idempotent.
 */

import { copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  ensureBrainOperationsCapabilityKey,
} from './brain-operations-capability.js';

function seedLocalConfig(home23Root) {
  const seeds = [
    ['config/home.yaml.example', 'config/home.yaml'],
    ['config/targets.yaml.example', 'config/targets.yaml'],
    ['config/cron-jobs.json.example', 'config/cron-jobs.json'],
  ];

  for (const [sourceRel, targetRel] of seeds) {
    const source = join(home23Root, sourceRel);
    const target = join(home23Root, targetRel);
    if (!existsSync(target) && existsSync(source)) {
      copyFileSync(source, target);
      console.log(`  Seeded ${targetRel}`);
    }
  }
}

export async function ensureSystemHealth(home23Root) {
  console.log('Checking system health...');
  let changed = false;

  seedLocalConfig(home23Root);

  const brainOperationsCapability = await ensureBrainOperationsCapabilityKey(home23Root);
  if (brainOperationsCapability.keyCreated || brainOperationsCapability.permissionsRepaired) {
    changed = true;
  }
  console.log('  Brain operations capability: configured');

  // 4. Regenerate ecosystem.config.cjs. Rendering/writing failures are fatal:
  // callers must never restart from a stale or partially prepared boundary.
  const { generateEcosystem } = await import('./generate-ecosystem.js');
  generateEcosystem(home23Root);

  // 5. Generate evobrew config
  if (!existsSync(join(home23Root, '.home23-product-no-evobrew'))) {
    try {
      const { writeEvobrewConfig } = await import('./evobrew-config.js');
      writeEvobrewConfig(home23Root);
    } catch (err) {
      console.warn(`  evobrew config failed: ${err.message}`);
    }
  }

  if (!changed) {
    console.log('  System healthy');
  }
  return { changed, brainOperationsCapabilityConfigured: true };
}
