#!/usr/bin/env node

/**
 * promote-staged-brain.js
 *
 * Copy a validated staged brain into an agent's live brain directory after the
 * engine has been stopped. Creates a rollback backup of the files it replaces.
 *
 * This script deliberately refuses to run unless --confirm-stopped is passed.
 * It does not stop or restart PM2; the operator must do that explicitly.
 */

const fs = require('fs');
const path = require('path');

const REQUIRED = [
  'state.json.gz',
  'memory-nodes.jsonl.gz',
  'memory-edges.jsonl.gz',
  'brain-snapshot.json',
  'brain-high-water.json',
];

function parseArgs(argv) {
  const args = { agent: 'jerry' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if ((arg === '--stage' || arg === '-s') && argv[i + 1]) args.stage = argv[++i];
    else if (arg === '--agent' && argv[i + 1]) args.agent = argv[++i];
    else if (arg === '--brain-dir' && argv[i + 1]) args.brainDir = argv[++i];
    else if (arg === '--backup-dir' && argv[i + 1]) args.backupDir = argv[++i];
    else if (arg === '--confirm-stopped') args.confirmStopped = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
  }
  return args;
}

function usage() {
  console.log(`Usage:
  node engine/scripts/promote-staged-brain.js --stage <stage-dir> --confirm-stopped [--agent jerry]

Required:
  --stage             Staged brain directory produced by stage-merged-brain-import.js
  --confirm-stopped   Acknowledge the target engine process is stopped

Options:
  --agent             Home23 agent name (default: jerry)
  --brain-dir         Explicit live brain directory
  --backup-dir        Explicit rollback backup directory
`);
}

function copyFileRequired(src, dest) {
  if (!fs.existsSync(src)) throw new Error(`Missing source file: ${src}`);
  fs.copyFileSync(src, dest);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.stage) {
    usage();
    process.exit(args.help ? 0 : 1);
  }
  if (!args.confirmStopped) {
    throw new Error('Refusing to promote while engine status is unknown. Stop home23-jerry first, then pass --confirm-stopped.');
  }

  const repoRoot = path.resolve(__dirname, '..', '..');
  const stageDir = path.resolve(args.stage);
  const brainDir = args.brainDir
    ? path.resolve(args.brainDir)
    : path.join(repoRoot, 'instances', args.agent, 'brain');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = args.backupDir
    ? path.resolve(args.backupDir)
    : path.join(brainDir, 'backups', `manual-promote-${stamp}`);

  for (const file of REQUIRED) {
    const src = path.join(stageDir, file);
    if (!fs.existsSync(src)) throw new Error(`Stage is missing required file: ${src}`);
  }

  fs.mkdirSync(backupDir, { recursive: true });

  console.log('=== Promote staged brain ===');
  console.log(`stage:  ${stageDir}`);
  console.log(`target: ${brainDir}`);
  console.log(`backup: ${backupDir}`);

  for (const file of REQUIRED) {
    const livePath = path.join(brainDir, file);
    if (fs.existsSync(livePath)) {
      copyFileRequired(livePath, path.join(backupDir, file));
    }
  }

  if (fs.existsSync(path.join(stageDir, 'import-manifest.json'))) {
    copyFileRequired(path.join(stageDir, 'import-manifest.json'), path.join(backupDir, 'promoted-import-manifest.json'));
  }

  for (const file of REQUIRED) {
    copyFileRequired(path.join(stageDir, file), path.join(brainDir, file));
  }

  fs.writeFileSync(
    path.join(backupDir, 'ROLLBACK.md'),
    [
      '# Manual Brain Promotion Rollback',
      '',
      `Created: ${new Date().toISOString()}`,
      `Target: ${brainDir}`,
      '',
      'To roll back while the engine is stopped:',
      '',
      '```bash',
      `cp ${backupDir}/state.json.gz ${brainDir}/state.json.gz`,
      `cp ${backupDir}/memory-nodes.jsonl.gz ${brainDir}/memory-nodes.jsonl.gz`,
      `cp ${backupDir}/memory-edges.jsonl.gz ${brainDir}/memory-edges.jsonl.gz`,
      `cp ${backupDir}/brain-snapshot.json ${brainDir}/brain-snapshot.json`,
      `cp ${backupDir}/brain-high-water.json ${brainDir}/brain-high-water.json`,
      '```',
      '',
    ].join('\n'),
    'utf8'
  );

  console.log('\nPromoted staged brain files.');
  console.log(`Rollback files are in: ${backupDir}`);
  console.log(`Next check: node engine/scripts/brain-coherence-check.js --brain-dir ${brainDir}`);
}

try {
  main();
} catch (err) {
  console.error(`FATAL: ${err.message}`);
  process.exit(1);
}
