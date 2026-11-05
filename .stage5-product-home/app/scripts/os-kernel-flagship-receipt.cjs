#!/usr/bin/env node
'use strict';

/**
 * Flagship harness: verify a deliverable on disk, record an os-kernel goal +
 * action receipt, optionally write a BeliefDelta, and print the control-plane
 * snapshot.
 *
 * Normal use (against a live checkout with instances/):
 *   node scripts/os-kernel-flagship-receipt.cjs \
 *     --agent forrest \
 *     --deliverable instances/forrest/workspace/reports/2026-07-17-weekly.md
 *
 * CI / worktree self-check (temp brain + deliverable under /tmp):
 *   node scripts/os-kernel-flagship-receipt.cjs --self-test
 *
 * Worktrees may have empty gitignored instances/ — point --deliverable at a real
 * file in the main checkout, or use --self-test.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { getOsKernel } = require('../engine/src/os-kernel/index.js');
const { ACTION_CLASSES } = require('../engine/src/os-kernel/schemas.js');

function findProjectRoot(startDir) {
  let dir = path.resolve(startDir || process.cwd());
  while (true) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(startDir || process.cwd());
    dir = parent;
  }
}

function parseArgs(argv) {
  const opts = {
    agent: null,
    deliverable: null,
    selfTest: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--agent') opts.agent = argv[++i] || null;
    else if (arg === '--deliverable') opts.deliverable = argv[++i] || null;
    else if (arg === '--self-test') opts.selfTest = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
  }

  return opts;
}

function usage() {
  return `Usage:
  node scripts/os-kernel-flagship-receipt.cjs --agent <name> --deliverable <path>
  node scripts/os-kernel-flagship-receipt.cjs --self-test

Options:
  --agent         Agent name (instances/<agent>/brain)
  --deliverable   Path relative to repo root or absolute
  --self-test     Create temp deliverable + brainDir under /tmp and run harness
`;
}

function resolveDeliverablePath(projectRoot, deliverableArg) {
  if (!deliverableArg) return null;
  if (path.isAbsolute(deliverableArg)) return path.resolve(deliverableArg);
  return path.resolve(projectRoot, deliverableArg);
}

function maybeRecordBeliefDelta(store, payload) {
  try {
    const mod = require('../engine/src/os-kernel/belief-delta.js');
    if (typeof mod.recordBeliefDelta !== 'function') return null;
    if (typeof store.appendBeliefDelta !== 'function') return null;
    return mod.recordBeliefDelta(store, payload);
  } catch {
    return null;
  }
}

function writeReceiptMarkdown(projectRoot, { agent, deliverableDisplay, goalId, receiptId }) {
  const receiptsDir = path.join(projectRoot, 'docs', 'receipts');
  fs.mkdirSync(receiptsDir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const slug = String(agent || 'self-test').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  const filePath = path.join(receiptsDir, `${date}-os-kernel-flagship-${slug}.md`);
  const body = `# OS Kernel Flagship Receipt

Date: ${date}
Agent: ${agent || 'self-test'}
Deliverable: ${deliverableDisplay}

Flagship harness ran successfully; goal \`${goalId}\` completed with action receipt \`${receiptId}\`.
`;
  fs.writeFileSync(filePath, body, 'utf8');
  return filePath;
}

function fail(message) {
  console.error(`[os-kernel-flagship] ${message}`);
  process.exit(1);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(usage());
    process.exit(0);
  }

  const projectRoot = findProjectRoot(__dirname);
  let agent = opts.agent;
  let brainDir;
  let deliverablePath;
  let deliverableDisplay;
  let cleanup = null;

  if (opts.selfTest) {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'os-kernel-flagship-'));
    deliverablePath = path.join(tmpRoot, 'flagship-deliverable.md');
    fs.writeFileSync(deliverablePath, '# Flagship self-test deliverable\n', 'utf8');
    brainDir = path.join(tmpRoot, 'brain');
    fs.mkdirSync(brainDir, { recursive: true });
    agent = agent || 'self-test';
    deliverableDisplay = deliverablePath;
    cleanup = () => {
      try {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      } catch {
        // best-effort temp cleanup
      }
    };
  } else {
    if (!agent) fail('Missing required --agent (or use --self-test)');
    if (!opts.deliverable) fail('Missing required --deliverable (or use --self-test)');

    brainDir = path.join(projectRoot, 'instances', agent, 'brain');
    deliverableDisplay = opts.deliverable;
    deliverablePath = resolveDeliverablePath(projectRoot, opts.deliverable);

    if (!fs.existsSync(deliverablePath)) {
      fail(
        `Deliverable not found: ${deliverablePath}\n`
        + 'Worktrees may have empty gitignored instances/. '
        + 'Point --deliverable at a file in your main checkout, or run with --self-test.',
      );
    }
  }

  const kernel = getOsKernel(brainDir);
  const store = kernel.store;

  const goal = store.createGoal({
    title: `Flagship: ${path.basename(deliverablePath)}`,
    owner: agent,
    deliverable: deliverableDisplay,
    acceptanceTest: {
      type: 'file_exists',
      args: { path: deliverablePath },
    },
    // createGoal defaults to 'queued'. This harness verifies the deliverable
    // and completes the goal in the same run, so there's no meaningful
    // "queued" window — go straight to 'active' explicitly rather than
    // adding a throwaway activateGoal() call just to satisfy the WIP gate.
    status: 'active',
  });

  const testResult = { ok: true, detail: 'file_exists' };
  const receipt = kernel.buildActionReceipt({
    goalId: goal.id,
    actionClass: ACTION_CLASSES.DRAFT,
    artifactPath: deliverablePath,
    testResult,
    outcome: 'pass',
    actor: 'os-kernel-flagship',
  });

  store.completeGoal(goal.id, { receiptId: receipt.id, receipt });

  maybeRecordBeliefDelta(store, {
    goalId: goal.id,
    claim: `deliverable missing or unverified: ${deliverableDisplay}`,
    outcome: 'pass',
    revisedBelief: `deliverable verified on disk: ${deliverableDisplay}`,
    evidenceReceiptId: receipt.id,
  });

  if (!opts.selfTest) {
    const receiptMd = writeReceiptMarkdown(projectRoot, {
      agent,
      deliverableDisplay,
      goalId: goal.id,
      receiptId: receipt.id,
    });
    console.log(`receipt_md: ${receiptMd}`);
  }

  const snapshot = kernel.getControlPlaneSnapshot();
  console.log(JSON.stringify(snapshot, null, 2));
  console.log('flagship_ok');

  if (cleanup) cleanup();
  process.exit(0);
}

main();
