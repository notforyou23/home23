/**
 * Home23 CLI — init command
 *
 * Prompts for API keys, writes config/secrets.yaml,
 * installs dependencies, builds TypeScript.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { askSecret, askWithDefault, closeRL } from './prompts.js';

function loadExistingSecrets(secretsPath) {
  if (!existsSync(secretsPath)) return {};
  try {
    // Simple YAML parser for flat structure — enough for secrets
    const content = readFileSync(secretsPath, 'utf8');
    const secrets = {};
    let currentProvider = null;
    for (const line of content.split('\n')) {
      const providerMatch = line.match(/^\s{2}(\S+):/);
      const keyMatch = line.match(/^\s{4}apiKey:\s*"?([^"]*)"?/);
      if (providerMatch) currentProvider = providerMatch[1];
      if (keyMatch && currentProvider) {
        secrets[currentProvider] = keyMatch[1];
      }
    }
    return secrets;
  } catch {
    return {};
  }
}

function maskKey(key) {
  if (!key || key.length < 10) return '';
  return key.slice(0, 8) + '...' + key.slice(-4);
}

export async function runInit(home23Root) {
  console.log('');
  console.log('Home23 — Setup');
  console.log('──────────────');
  console.log('');

  const secretsPath = join(home23Root, 'config', 'secrets.yaml');
  const existing = loadExistingSecrets(secretsPath);

  console.log('API Keys (paste each, or press Enter to keep current):');
  console.log('');

  const ollamaCloud = await askWithDefault(
    `  Ollama Cloud API key${existing['ollama-cloud'] ? ` (current: ${maskKey(existing['ollama-cloud'])})` : ''}`,
    existing['ollama-cloud'] || ''
  );

  const anthropic = await askWithDefault(
    `  Anthropic API key${existing.anthropic ? ` (current: ${maskKey(existing.anthropic)})` : ''}`,
    existing.anthropic || ''
  );

  const openai = await askWithDefault(
    `  OpenAI API key${existing.openai ? ` (current: ${maskKey(existing.openai)})` : ''}`,
    existing.openai || ''
  );

  const xai = await askWithDefault(
    `  xAI API key${existing.xai ? ` (current: ${maskKey(existing.xai)})` : ''}`,
    existing.xai || ''
  );

  closeRL();

  // Write secrets.yaml
  console.log('');
  console.log('Writing config/secrets.yaml...');

  // Preserve any existing agent bot tokens
  let agentsSection = '';
  if (existsSync(secretsPath)) {
    const content = readFileSync(secretsPath, 'utf8');
    const agentsIdx = content.indexOf('\nagents:');
    if (agentsIdx !== -1) {
      agentsSection = '\n' + content.slice(agentsIdx + 1);
    }
  }

  const secretsContent = `# Home23 secrets — API keys and tokens
# This file is gitignored. Never commit it.

providers:
  ollama-cloud:
    apiKey: "${ollamaCloud}"
  anthropic:
    apiKey: "${anthropic}"
  openai:
    apiKey: "${openai}"
  xai:
    apiKey: "${xai}"
${agentsSection}`;

  writeFileSync(secretsPath, secretsContent, 'utf8');
  console.log('  done');

  // Install dependencies
  console.log('');
  console.log('Installing dependencies...');

  const dirs = [
    { name: 'engine', path: join(home23Root, 'engine') },
    { name: 'feeder', path: join(home23Root, 'feeder') },
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

  console.log('');
  console.log('Home23 is ready. Create your first agent:');
  console.log('  node cli/home23.js agent create <name>');
  console.log('');
}
