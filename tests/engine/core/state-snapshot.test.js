// RECENT.md is a SUMMARY OF THE BRAIN, curator-generated from brain nodes and
// re-loaded every turn as a system-prompt surface (src/agent/context-assembly.ts).
// Re-ingesting it INTO the brain as a permanent node is the ouroboros: the
// summary becomes the cortex, and the next summary then summarises that.
//
// Three compounding defects made this worse than a simple "duplicate node"
// bug:
//   1. The writer read RECENT.md directly off disk, bypassing the feeder --
//      no watch-path change could ever have stopped it.
//   2. The dedup gate hashed the *whole file*, including the curator's
//      "_Generated: <timestamp>_" stamp -- so every regeneration produced a
//      new hash, and the gate never actually deduped anything in practice.
//   3. confidence_decay: 1 made the copies immune to forgetting, on top of
//      exemptTags immunity elsewhere -- belt and braces protecting a summary
//      of the brain from being forgotten by the brain.
//
// The fix removes the writer entirely. RECENT.md stays exactly where it
// already was designed to live -- read straight off disk by
// context-assembly.ts on every turn -- it simply never becomes a node.
//
// Harness style matches tests/engine/core/thought-persistence.test.js:
// Object.create(Orchestrator.prototype) + Object.assign minimal collaborators,
// exercise the real instance method (while it still exists) -- no reinvented
// mock framework. Source-text assertions match
// tests/engine/core/orchestrator-cycle-timeout-context.test.js, used where
// direct instantiation of TS layers (context-assembly.ts) isn't possible
// from the plain `node --test` engine suite.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { Orchestrator } = require('../../../engine/src/core/orchestrator.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');
const orchestratorPath = path.join(repoRoot, 'engine/src/core/orchestrator.js');
const contextAssemblyPath = path.join(repoRoot, 'src/agent/context-assembly.ts');
const orchestratorSource = fs.readFileSync(orchestratorPath, 'utf8');
const contextAssemblySource = fs.readFileSync(contextAssemblyPath, 'utf8');

function makeLogger() {
  const entries = [];
  return {
    entries,
    info(message, data) { entries.push({ level: 'info', message, data }); },
    warn(message, data) { entries.push({ level: 'warn', message, data }); },
    error(message, data) { entries.push({ level: 'error', message, data }); },
    debug(message, data) { entries.push({ level: 'debug', message, data }); },
  };
}

function makeOrchestrator({ cycleCount = 1 } = {}) {
  const logger = makeLogger();
  const addedNodes = [];
  const nodesById = new Map();
  const memory = {
    nodes: nodesById,
    async addNode(nodeData) {
      const node = { id: `node_${addedNodes.length + 1}`, ...nodeData };
      addedNodes.push(node);
      nodesById.set(node.id, node);
      return node;
    },
  };
  const orchestrator = Object.create(Orchestrator.prototype);
  Object.assign(orchestrator, {
    logger,
    memory,
    cycleCount,
  });
  return { orchestrator, logger, addedNodes, memory };
}

function isStateSnapshotNode(node) {
  const tags = Array.isArray(node?.tags) ? node.tags : [];
  return node?.tag === 'state_snapshot' ||
    node?.type === 'state_snapshot' ||
    tags.includes('state_snapshot') ||
    node?.metadata?.kind === 'state_snapshot';
}

async function withWorkspace(run) {
  const workspacePath = await mkdtemp(path.join(os.tmpdir(), 'home23-state-snapshot-'));
  const originalWorkspaceEnv = process.env.COSMO_WORKSPACE_PATH;
  process.env.COSMO_WORKSPACE_PATH = workspacePath;
  try {
    await run(workspacePath);
  } finally {
    if (originalWorkspaceEnv === undefined) {
      delete process.env.COSMO_WORKSPACE_PATH;
    } else {
      process.env.COSMO_WORKSPACE_PATH = originalWorkspaceEnv;
    }
    await rm(workspacePath, { recursive: true, force: true });
  }
}

function recentMdBody(cycleLabel) {
  return [
    `# Recent Activity — covers last 48h`,
    ``,
    `_Generated: ${new Date().toISOString()}_`,
    ``,
    `- cycle marker: ${cycleLabel}`,
    `- curator regenerated this surface again`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Behavioral: driving the real (pre-removal) entry point must never leave a
// state_snapshot node behind, no matter how many times RECENT.md changes.
// ---------------------------------------------------------------------------

test('a changed RECENT.md produces no state_snapshot node, across repeated curator regenerations', async () => {
  await withWorkspace(async (workspacePath) => {
    const { orchestrator, addedNodes } = makeOrchestrator();
    const recentPath = path.join(workspacePath, 'RECENT.md');

    // If the writer still exists (pre-fix), drive it exactly the way the
    // real callers do -- startup priming and every saveState() call. If it
    // has been removed (post-fix), there is nothing to call: that itself is
    // the fix, and the assertion below still holds trivially.
    const driveWriter = async () => {
      if (typeof orchestrator.maybeWriteCurrentStateSnapshot === 'function') {
        await orchestrator.maybeWriteCurrentStateSnapshot();
      }
    };

    // Simulate three curator regenerations -- each stamps a fresh
    // "_Generated: <timestamp>_" line, which is exactly what defeated the
    // old content-hash dedup gate.
    for (const label of ['first pass', 'second pass', 'third pass']) {
      await writeFile(recentPath, recentMdBody(label), 'utf8');
      await driveWriter();
      // A microtask tick so two regenerations in the same millisecond still
      // produce genuinely different file content/timestamps where it matters.
      await new Promise((resolve) => setTimeout(resolve, 2));
    }

    const snapshotNodes = addedNodes.filter(isStateSnapshotNode);
    assert.equal(
      snapshotNodes.length,
      0,
      `expected zero state_snapshot nodes; got ${snapshotNodes.length} -- ` +
      `RECENT.md must never become a brain node, not merely become one less often`
    );
  });
});

test('RECENT.md state-snapshot writer, its callers, and its dedup-hash state are fully removed from orchestrator.js', () => {
  assert.doesNotMatch(
    orchestratorSource,
    /maybeWriteCurrentStateSnapshot/,
    'the writer function and every call to it must be gone'
  );
  assert.doesNotMatch(
    orchestratorSource,
    /lastStateSnapshotHash/,
    'the dedup-hash field must be gone -- it existed only to gate this writer'
  );
  assert.doesNotMatch(
    orchestratorSource,
    /stateSnapshotHashLoaded/,
    'the one-time hash-scan flag must be gone -- it existed only to gate this writer'
  );
  assert.doesNotMatch(
    orchestratorSource,
    /\[STATE_SNAPSHOT\] RECENT\.md as of cycle/,
    'the node concept template must be gone -- no state_snapshot node may ever be minted from RECENT.md again'
  );
});

// ---------------------------------------------------------------------------
// Safety: RECENT.md must remain readable by context assembly, independent of
// the brain/memory graph entirely. This is the one thing this change must
// not break -- the agent must not lose situational awareness.
// ---------------------------------------------------------------------------

test('the RECENT.md surface is still readable by context assembly, independent of brain nodes', () => {
  // RECENT.md is declared as a domain surface, loaded straight off disk
  // (loadSurface -> readFileSync) on relevance. It is deliberately NOT
  // alwaysBoost (2026-07-17): RECENT is built from the event ledger and the
  // machine's own cycle thoughts, so loading it every turn could only ever
  // tell the agent about itself. PERSONAL.md took the unconditional slot --
  // who jtr is loads every turn instead of the machine's heartbeat.
  assert.match(
    contextAssemblySource,
    /\{\s*name:\s*'RECENT',\s*file:\s*'RECENT\.md',[^}]*alwaysBoost:\s*false/,
    'RECENT.md must remain a declared domain surface, relevance-gated (not always-loaded)'
  );
  assert.match(
    contextAssemblySource,
    /\{\s*name:\s*'PERSONAL',\s*file:\s*'PERSONAL\.md',[^}]*alwaysBoost:\s*true/,
    'PERSONAL.md must hold the always-loaded slot -- jtr every turn, not the machine'
  );
  assert.match(
    contextAssemblySource,
    /function loadSurface\(workspacePath: string, filename: string, budget: number\): string \| null \{\s*\n\s*const filePath = join\(workspacePath, filename\);\s*\n\s*if \(!existsSync\(filePath\)\) return null;\s*\n\s*const content = readFileSync\(filePath, 'utf-8'\)/,
    'the surface loader must read the file straight off disk, not query the brain/memory graph'
  );
  assert.match(
    contextAssemblySource,
    /const content = loadSurface\(config\.workspacePath, surface\.file, surface\.budget\);/,
    'each domain surface, including RECENT, must be loaded via the disk-based loader'
  );
});
