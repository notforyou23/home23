/**
 * Home23 — System Health
 *
 * Self-healing function that ensures all plumbing is correct.
 * Runs on every start and after every update. Idempotent.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import yaml from 'js-yaml';

function loadYaml(filePath) {
  if (!existsSync(filePath)) return {};
  try { return yaml.load(readFileSync(filePath, 'utf8')) || {}; }
  catch { return {}; }
}

export async function ensureSystemHealth(home23Root) {
  console.log('Checking system health...');
  let changed = false;

  // 1. Ensure cosmo23 encryption key exists in secrets.yaml
  const secretsPath = join(home23Root, 'config', 'secrets.yaml');
  const secrets = loadYaml(secretsPath);
  if (!secrets.cosmo23?.encryptionKey) {
    if (!secrets.cosmo23) secrets.cosmo23 = {};
    secrets.cosmo23.encryptionKey = randomBytes(32).toString('hex');
    const header = '# Home23 secrets — API keys and tokens\n# This file is gitignored. Never commit it.\n\n';
    writeFileSync(secretsPath, header + yaml.dump(secrets, { lineWidth: 120 }), 'utf8');
    console.log('  Generated encryption key');
    changed = true;
  }

  // 2. Ensure Prisma DB exists
  const dbPath = join(home23Root, 'cosmo23', 'prisma', 'dev.db');
  if (!existsSync(dbPath)) {
    console.log('  Creating Prisma database...');
    try {
      execSync(`DATABASE_URL="file:${dbPath}" npx prisma db push`, {
        cwd: join(home23Root, 'cosmo23'), stdio: 'pipe', timeout: 30000,
      });
      console.log('  Prisma DB created');
      changed = true;
    } catch (err) {
      console.warn(`  Prisma DB creation failed: ${err.message}`);
    }
  }

  // 3. Seed cosmo23 config
  try {
    const { seedCosmo23Config } = await import('./cosmo23-config.js');
    seedCosmo23Config(home23Root);
  } catch (err) {
    console.warn(`  cosmo23 config seed failed: ${err.message}`);
  }

  // 4. Regenerate ecosystem.config.cjs
  try {
    const { generateEcosystem } = await import('./generate-ecosystem.js');
    generateEcosystem(home23Root);
  } catch {
    // No agents yet — fine, ecosystem generated on first agent create
  }

  // 5. Generate evobrew config
  try {
    const { writeEvobrewConfig } = await import('./evobrew-config.js');
    writeEvobrewConfig(home23Root);
  } catch (err) {
    console.warn(`  evobrew config failed: ${err.message}`);
  }

  if (!changed) {
    console.log('  System healthy');
  }
}
