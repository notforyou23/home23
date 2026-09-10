/**
 * Home23 CLI — init command
 *
 * Silent plumbing: deps, build, encryption key, DB, config seeding.
 * Provider setup happens in the web dashboard, not here.
 */

import { copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

// Modules that depend on root npm packages (js-yaml, proper-lockfile, ...)
// must be imported lazily, after `npm install` has run. On a fresh clone
// there is no node_modules yet, and a static import here would crash init
// before it ever gets the chance to install anything.

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

function checkPrerequisites(execute) {
  const issues = [];
  const warnings = [];

  // Node version
  const nodeVersion = parseInt(process.versions.node.split('.')[0], 10);
  if (nodeVersion < 20) {
    issues.push(`Node.js ${process.versions.node} detected — Node 20+ required`);
  }

  // PM2
  try {
    execute('pm2', ['--version'], { stdio: 'pipe' });
  } catch {
    issues.push('PM2 not found — install with: npm install -g pm2');
  }

  // Python 3
  try {
    execute('python3', ['--version'], { stdio: 'pipe' });
  } catch {
    warnings.push('Python 3 not found — document ingestion (PDF/DOCX/images) will be unavailable');
  }

  // Ollama (for embeddings)
  try {
    execute('ollama', ['--version'], { stdio: 'pipe' });
    // Check if nomic-embed-text is pulled
    try {
      const models = execute('ollama', ['list'], { stdio: 'pipe', encoding: 'utf-8' });
      if (!models.includes('nomic-embed-text')) {
        warnings.push('Ollama installed but nomic-embed-text not pulled — run: ollama pull nomic-embed-text');
      }
    } catch { /* list failed, skip */ }
  } catch {
    warnings.push('Ollama not found — needed for local embeddings (free). Install from https://ollama.com or use cloud embeddings instead.');
  }

  return { issues, warnings };
}

function requiredStepError(step, directory, recovery, cause) {
  const output = [cause?.stderr, cause?.stdout]
    .map((value) => value?.toString().trim())
    .filter(Boolean)
    .join('\n')
    .slice(-4000);
  const error = new Error(
    `${step} failed in ${directory}. Setup stopped. ${recovery} Then rerun node cli/home23.js setup.`
      + (output ? `\n${output}` : ''),
    { cause },
  );
  error.code = 'HOME23_INIT_REQUIRED_STEP_FAILED';
  return error;
}

// Injection keeps install failure paths testable without installing packages,
// starting services, or loading modules before a fresh clone has dependencies.
export async function runInit(home23Root, options = {}, dependencies = {}) {
  const execute = dependencies.execute ?? execFileSync;
  const loadModule = dependencies.loadModule ?? ((specifier) => import(specifier));
  console.log('');
  console.log('Home23 — Setup');
  console.log('──────────────');
  console.log('');

  // Prerequisite check
  const prereqs = checkPrerequisites(execute);
  if (prereqs.issues.length > 0) {
    console.log('❌ Prerequisites missing:');
    for (const issue of prereqs.issues) console.log(`   • ${issue}`);
    console.log('');
    console.log('Fix these before continuing.');
    throw new Error(`Home23 prerequisites missing: ${prereqs.issues.join('; ')}`);
  }
  if (prereqs.warnings.length > 0) {
    console.log('⚠️  Warnings:');
    for (const warn of prereqs.warnings) console.log(`   • ${warn}`);
    console.log('');
  }

  console.log('Preparing local config files...');
  seedLocalConfig(home23Root);

  // Install root/harness dependencies before anything that needs them.
  console.log('');
  console.log('Installing dependencies...');

  const dirs = [
    { name: 'engine', path: join(home23Root, 'engine') },
    { name: 'harness', path: home23Root },
    { name: 'evobrew', path: join(home23Root, 'evobrew') },
  ];

  // A partial checkout is not an installed home. Validate all required sources
  // before starting any dependency installation.
  for (const dir of dirs) {
    if (!existsSync(join(dir.path, 'package.json'))) {
      throw requiredStepError(
        `${dir.name} dependency installation`, dir.path,
        'The required package.json is missing; restore the complete Home23 source checkout.',
      );
    }
  }

  for (const dir of dirs) {
    process.stdout.write(`  ${dir.name}: npm install...`);
    try {
      execute('npm', ['install'], { cwd: dir.path, stdio: 'pipe', timeout: 120000 });
      console.log(' done');
    } catch (err) {
      console.log(' FAILED');
      throw requiredStepError(
        `${dir.name} dependency installation`, dir.path,
        'Run npm install in that directory and resolve the reported error.', err,
      );
    }
  }
  console.log('');

  // Do not configure or advertise a runtime whose required build has failed.
  process.stdout.write('Building TypeScript...');
  try {
    execute('npm', ['run', 'build'], { cwd: home23Root, stdio: 'pipe', timeout: 60000 });
    console.log(' done');
  } catch (err) {
    console.log(' FAILED');
    throw requiredStepError(
      'TypeScript build', home23Root,
      'Run npm run build in that directory and fix the build errors.', err,
    );
  }

  const { ensureBrainOperationsCapabilityKey } =
    await loadModule('./brain-operations-capability.js');

  const brainOperationsCapability = await ensureBrainOperationsCapabilityKey(home23Root);
  console.log(`  Brain operations capability: configured${brainOperationsCapability.permissionsRepaired ? ' (permissions repaired)' : ''}`);

  // Generate ecosystem.config.cjs (no-op if no agents exist yet)
  console.log('');
  console.log('Generating ecosystem config...');
  try {
    const { generateEcosystem } = await loadModule('./generate-ecosystem.js');
    generateEcosystem(home23Root);
  } catch (err) {
    console.log('  FAILED (non-fatal, will regenerate on first agent create)');
    console.error(`  ${err.message?.split('\n')[0] || 'unknown error'}`);
  }

  // Bundled Python venv for document ingestion (MarkItDown + PDF extras).
  // The engine reads this via engine/.venv-markitdown/bin/python3 — see
  // engine/src/ingestion/document-converter.js resolvePythonPath(). Keeping
  // deps inside a venv insulates them from host Python upgrades and avoids
  // the `pip install --break-system-packages` footgun.
  console.log('');
  process.stdout.write('Setting up document ingestion venv (MarkItDown + PDF)...');
  let documentConversion = 'ready';
  try {
    const venvDir = join(home23Root, 'engine', '.venv-markitdown');
    const venvPython = join(venvDir, 'bin', 'python3');
    if (!existsSync(venvPython)) {
      execute('python3', ['-m', 'venv', venvDir], { stdio: 'pipe', timeout: 60000 });
    }
    execute(venvPython, ['-m', 'pip', 'install', '--quiet', '--upgrade', 'pip', 'markitdown[pdf]', 'openai'], {
      stdio: 'pipe',
      timeout: 300000,
    });
    console.log(' done');
  } catch (err) {
    documentConversion = 'unavailable';
    console.log(' UNAVAILABLE (optional capability)');
    console.error(`  ${err.message?.split('\n')[0] || 'unknown error'}`);
    console.error('  Binary document ingestion (PDF/DOCX/etc.) will be unavailable until this is fixed.');
    console.error('  You can re-run this step manually:');
    console.error('    python3 -m venv engine/.venv-markitdown');
    console.error('    engine/.venv-markitdown/bin/pip install "markitdown[pdf]" openai');
  }

  if (options.finalMessage !== false) {
    console.log('');
    console.log('═══════════════════════════════════════════════════');
    console.log(documentConversion === 'ready'
      ? '  Home23 runtime prepared.'
      : '  Home23 runtime prepared; document conversion unavailable.');
    console.log('═══════════════════════════════════════════════════');
    console.log('');
    console.log('  Next step — create your first home:');
    console.log('');
    console.log('    node cli/home23.js setup');
    console.log('');
    console.log('  Terminal-guided setup:');
    console.log('');
    console.log('    node cli/home23.js setup --cli');
    console.log('');
  }

  return { status: 'prepared', documentConversion };
}
