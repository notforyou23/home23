/**
 * Home23 CLI — init command
 *
 * Silent plumbing: deps, build, encryption key, DB, config seeding.
 * Provider setup happens in the web dashboard, not here.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import yaml from 'js-yaml';
import { seedCosmo23Config } from './cosmo23-config.js';
import { generateEcosystem } from './generate-ecosystem.js';

function loadYaml(filePath) {
  if (!existsSync(filePath)) return {};
  try {
    return yaml.load(readFileSync(filePath, 'utf8')) || {};
  } catch {
    return {};
  }
}

function checkPrerequisites() {
  const issues = [];
  const warnings = [];

  // Node version
  const nodeVersion = parseInt(process.versions.node.split('.')[0], 10);
  if (nodeVersion < 20) {
    issues.push(`Node.js ${process.versions.node} detected — Node 20+ required`);
  }

  // PM2
  try {
    execSync('pm2 --version', { stdio: 'pipe' });
  } catch {
    issues.push('PM2 not found — install with: npm install -g pm2');
  }

  // Python 3
  try {
    execSync('python3 --version', { stdio: 'pipe' });
  } catch {
    warnings.push('Python 3 not found — document ingestion (PDF/DOCX/images) will be unavailable');
  }

  // Ollama (for embeddings)
  try {
    execSync('ollama --version', { stdio: 'pipe' });
    // Check if nomic-embed-text is pulled
    try {
      const models = execSync('ollama list', { stdio: 'pipe', encoding: 'utf-8' });
      if (!models.includes('nomic-embed-text')) {
        warnings.push('Ollama installed but nomic-embed-text not pulled — run: ollama pull nomic-embed-text');
      }
    } catch { /* list failed, skip */ }
  } catch {
    warnings.push('Ollama not found — needed for local embeddings (free). Install from https://ollama.com or use cloud embeddings instead.');
  }

  return { issues, warnings };
}

export async function runInit(home23Root) {
  console.log('');
  console.log('Home23 — Setup');
  console.log('──────────────');
  console.log('');

  // Prerequisite check
  const prereqs = checkPrerequisites();
  if (prereqs.issues.length > 0) {
    console.log('❌ Prerequisites missing:');
    for (const issue of prereqs.issues) console.log(`   • ${issue}`);
    console.log('');
    console.log('Fix these before continuing.');
    process.exit(1);
  }
  if (prereqs.warnings.length > 0) {
    console.log('⚠️  Warnings:');
    for (const warn of prereqs.warnings) console.log(`   • ${warn}`);
    console.log('');
  }

  // Merge secrets.yaml — never clobber existing provider keys or agent bot tokens
  const secretsPath = join(home23Root, 'config', 'secrets.yaml');
  console.log('Preparing config/secrets.yaml...');

  const secrets = loadYaml(secretsPath);

  // Generate cosmo23 encryption key if missing
  if (!secrets.cosmo23) secrets.cosmo23 = {};
  let secretsChanged = false;
  if (!secrets.cosmo23.encryptionKey) {
    secrets.cosmo23.encryptionKey = randomBytes(32).toString('hex');
    secretsChanged = true;
    console.log('  Generated cosmo23 encryption key');
  } else {
    console.log('  Encryption key exists');
  }

  if (secretsChanged) {
    const header = '# Home23 secrets — API keys and tokens\n# This file is gitignored. Never commit it.\n\n';
    writeFileSync(secretsPath, header + yaml.dump(secrets, { lineWidth: 120 }), 'utf8');
  }
  console.log('  done');

  // Install dependencies
  console.log('');
  console.log('Installing dependencies...');

  const dirs = [
    { name: 'engine', path: join(home23Root, 'engine') },
    { name: 'harness', path: home23Root },
    { name: 'evobrew', path: join(home23Root, 'evobrew') },
  ];

  for (const dir of dirs) {
    if (existsSync(join(dir.path, 'package.json'))) {
      process.stdout.write(`  ${dir.name}: npm install...`);
      try {
        execSync('npm install', { cwd: dir.path, stdio: 'pipe', timeout: 120000 });
        console.log(' done');
      } catch (err) {
        console.log(' FAILED');
        console.error(`    ${err.message?.split('\n')[0]}`);
      }
    }
  }

  const cosmo23Dir = join(home23Root, 'cosmo23');
  const cosmo23EngineDir = join(cosmo23Dir, 'engine');
  if (existsSync(join(cosmo23Dir, 'package.json'))) {
    console.log('Installing COSMO 2.3 dependencies...');
    execSync('npm install', { cwd: cosmo23Dir, stdio: 'inherit' });
    if (existsSync(join(cosmo23EngineDir, 'package.json'))) {
      console.log('Installing COSMO 2.3 engine dependencies...');
      execSync('npm install', { cwd: cosmo23EngineDir, stdio: 'inherit' });
    }
    execSync('npx prisma generate', { cwd: cosmo23Dir, stdio: 'inherit' });

    // Create the Prisma SQLite database (required for OAuth token storage)
    console.log('Creating COSMO 2.3 database...');
    try {
      const dbPath = join(cosmo23Dir, 'prisma', 'dev.db');
      if (!existsSync(dbPath)) {
        execSync(`DATABASE_URL="file:${dbPath}" npx prisma db push`, {
          cwd: cosmo23Dir, stdio: 'pipe', timeout: 30000,
        });
      }
      // Verify the DB file actually exists after creation
      if (existsSync(dbPath)) {
        console.log('  done');
      } else {
        console.log('  WARNING: prisma db push ran but dev.db not found');
        console.error(`  Fix manually: cd cosmo23 && DATABASE_URL="file:./prisma/dev.db" npx prisma db push`);
      }
    } catch (err) {
      console.log('  FAILED (OAuth sign-in will not work until this is fixed)');
      console.error(`  Fix manually: cd cosmo23 && DATABASE_URL="file:./prisma/dev.db" npx prisma db push`);
    }

    // Create config directory for cosmo23
    const cosmo23ConfigDir = join(cosmo23Dir, '.cosmo23-config');
    if (!existsSync(cosmo23ConfigDir)) {
      mkdirSync(cosmo23ConfigDir, { recursive: true });
    }
  }

  // Seed cosmo23 config with Home23 API keys
  console.log('');
  console.log('Seeding COSMO 2.3 config...');
  try {
    seedCosmo23Config(home23Root);
  } catch (err) {
    console.log('  FAILED (non-fatal, COSMO will still work via env vars)');
    console.error(`  ${err.message?.split('\n')[0] || 'unknown error'}`);
  }

  // Generate ecosystem.config.cjs (no-op if no agents exist yet)
  console.log('');
  console.log('Generating ecosystem config...');
  try {
    generateEcosystem(home23Root);
  } catch (err) {
    console.log('  FAILED (non-fatal, will regenerate on first agent create)');
    console.error(`  ${err.message?.split('\n')[0] || 'unknown error'}`);
  }

  // Build TypeScript
  console.log('');
  process.stdout.write('Building TypeScript...');
  try {
    execSync('npx tsc', { cwd: home23Root, stdio: 'pipe', timeout: 60000 });
    console.log(' done');
  } catch (err) {
    console.log(' FAILED');
    console.error('  Check build errors with: npx tsc --noEmit');
  }

  // Bundled Python venv for document ingestion (MarkItDown + PDF extras).
  // The engine reads this via engine/.venv-markitdown/bin/python3 — see
  // engine/src/ingestion/document-converter.js resolvePythonPath(). Keeping
  // deps inside a venv insulates them from host Python upgrades and avoids
  // the `pip install --break-system-packages` footgun.
  console.log('');
  process.stdout.write('Setting up document ingestion venv (MarkItDown + PDF)...');
  try {
    const venvDir = join(home23Root, 'engine', '.venv-markitdown');
    const venvPython = join(venvDir, 'bin', 'python3');
    if (!existsSync(venvPython)) {
      execSync(`python3 -m venv "${venvDir}"`, { stdio: 'pipe', timeout: 60000 });
    }
    execSync(`"${venvPython}" -m pip install --quiet --upgrade pip "markitdown[pdf]" openai`, {
      stdio: 'pipe',
      timeout: 300000,
    });
    console.log(' done');
  } catch (err) {
    console.log(' FAILED');
    console.error(`  ${err.message?.split('\n')[0] || 'unknown error'}`);
    console.error('  Binary document ingestion (PDF/DOCX/etc.) will be unavailable until this is fixed.');
    console.error('  You can re-run this step manually:');
    console.error('    python3 -m venv engine/.venv-markitdown');
    console.error('    engine/.venv-markitdown/bin/pip install "markitdown[pdf]" openai');
  }

  console.log('');
  console.log('═══════════════════════════════════════════════════');
  console.log('  Home23 is ready!');
  console.log('═══════════════════════════════════════════════════');
  console.log('');
  console.log('  Next step — start the system:');
  console.log('');
  console.log('    node cli/home23.js start');
  console.log('');
  console.log('  Then open your browser:');
  console.log('');
  console.log('    http://localhost:5002/home23');
  console.log('');
  console.log('  The web dashboard will walk you through creating');
  console.log('  your first agent and setting up API providers.');
  console.log('');
}
