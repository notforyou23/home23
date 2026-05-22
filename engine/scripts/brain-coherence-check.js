#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const { StateCompression } = require('../src/core/state-compression');
const { readSnapshot } = require('../src/core/brain-snapshot');
const { readMemoryDeltas, readMemorySidecars, sidecarsExist } = require('../src/core/memory-sidecar');
const { listBackups } = require('../src/core/brain-backups');

function parseArgs(argv) {
  const out = { agent: 'jerry', json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--agent' && argv[i + 1]) out.agent = argv[++i];
    else if (arg === '--brain-dir' && argv[i + 1]) out.brainDir = argv[++i];
    else if (arg === '--json') out.json = true;
  }
  return out;
}

function fileMeta(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return {
      exists: true,
      bytes: stat.size,
      mtime: stat.mtime.toISOString(),
      mtimeMs: stat.mtimeMs,
    };
  } catch {
    return { exists: false, bytes: 0, mtime: null, mtimeMs: 0 };
  }
}

async function loadJsonWithRetry(filePath, fallback, attempts = 3) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      if (!fs.existsSync(filePath)) return fallback;
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
      if (i === attempts - 1) throw err;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  return fallback;
}

function lastJsonlTimestamp(filePath) {
  if (!fs.existsSync(filePath)) return { count: 0, lastAt: null };
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(lines[i]);
      const ts = parsed.receivedAt || parsed.producedAt || parsed.generatedAt || parsed.at || parsed.ts || null;
      return { count: lines.length, lastAt: ts };
    } catch {
      continue;
    }
  }
  return { count: lines.length, lastAt: null };
}

function addCheck(checks, warnings, errors, id, ok, severity, detail) {
  const check = { id, ok, severity, detail };
  checks.push(check);
  if (!ok) {
    if (severity === 'error') errors.push(check);
    else warnings.push(check);
  }
}

function printText(report) {
  console.log(`Brain coherence check: ${report.brainDir}`);
  console.log(`authoritative source: ${report.authoritativeSource}`);
  console.log(`ok: ${report.ok}`);
  console.log('');
  console.log('counts:');
  console.log(`  snapshot nodes=${report.counts.snapshotNodes} edges=${report.counts.snapshotEdges}`);
  console.log(`  sidecar  nodes=${report.counts.sidecarNodes} edges=${report.counts.sidecarEdges}`);
  console.log(`  highWater nodes=${report.counts.highWaterNodes}`);
  console.log(`  memoryObjects=${report.counts.memoryObjects} receipts=${report.counts.crystallizationReceipts}`);
  console.log('');
  console.log('checks:');
  for (const check of report.checks) {
    const marker = check.ok ? 'OK  ' : (check.severity === 'error' ? 'ERR ' : 'WARN');
    console.log(`  ${marker} ${check.id} - ${check.detail}`);
  }
  if (report.health.synthesisGeneratedAt || report.health.lastCrystallizationReceiptAt || report.health.lastPublishAt) {
    console.log('');
    console.log('health:');
    if (report.health.synthesisGeneratedAt) console.log(`  synthesis: ${report.health.synthesisGeneratedAt}`);
    if (report.health.lastCrystallizationReceiptAt) console.log(`  last crystallization receipt: ${report.health.lastCrystallizationReceiptAt}`);
    if (report.health.lastPublishAt) console.log(`  last publish: ${report.health.lastPublishAt}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(__dirname, '..', '..');
  const brainDir = args.brainDir || path.join(repoRoot, 'instances', args.agent, 'brain');

  const statePath = path.join(brainDir, 'state.json');
  const memoryObjectsPath = path.join(brainDir, 'memory-objects.json');
  const brainStatePath = path.join(brainDir, 'brain-state.json');
  const receiptsPath = path.join(brainDir, 'crystallization-receipts.jsonl');
  const publishLedgerPath = path.join(brainDir, 'publish-ledger.jsonl');
  const highWaterPath = path.join(brainDir, 'brain-high-water.json');

  const checks = [];
  const warnings = [];
  const errors = [];

  const snapshot = readSnapshot(brainDir);
  const backups = listBackups(brainDir);
  const state = await StateCompression.loadCompressed(statePath);
  const sidecarPresent = sidecarsExist(brainDir);

  let sidecarCounts = { nodes: 0, edges: 0, nodeParseErrors: 0, edgeParseErrors: 0 };
  let logicalSidecarCounts = { nodes: 0, edges: 0, deltaEntries: 0, deltaParseErrors: 0 };
  if (sidecarPresent) {
    const nodeIds = new Set();
    const edgeKeys = new Set();
    const edgeKeyFor = (edge) => {
      const source = edge?.source ?? edge?.from;
      const target = edge?.target ?? edge?.to;
      return [source, target].sort((a, b) => String(a).localeCompare(String(b))).join('->');
    };
    const result = await readMemorySidecars(brainDir, {
      onNode(node) { if (node?.id !== undefined) nodeIds.add(node.id); },
      onEdge(edge) { if (edge) edgeKeys.add(edgeKeyFor(edge)); },
    });
    const deltaResult = await readMemoryDeltas(brainDir, {
      onNode(node) { if (node?.id !== undefined) nodeIds.add(node.id); },
      onEdge(edge) { if (edge) edgeKeys.add(edgeKeyFor(edge)); },
      onRemoveNode(id) {
        nodeIds.delete(id);
        // Edge deletions caused by node removal are accounted for by the
        // engine at load time; this checker only has keys, not full edge
        // records, so it treats explicit edge removals exactly and leaves
        // node-cascade edge pruning to live load verification.
      },
      onRemoveEdge(key) { edgeKeys.delete(key); },
    });
    sidecarCounts = {
      nodes: result.nodes.count,
      edges: result.edges.count,
      nodeParseErrors: result.nodes.parseErrors,
      edgeParseErrors: result.edges.parseErrors,
    };
    logicalSidecarCounts = {
      nodes: nodeIds.size,
      edges: edgeKeys.size,
      deltaEntries: deltaResult.count,
      deltaParseErrors: deltaResult.parseErrors,
    };
  }

  let memoryObjects = { objects: [] };
  try {
    memoryObjects = await loadJsonWithRetry(memoryObjectsPath, { objects: [] });
  } catch {
    memoryObjects = { objects: [] };
    addCheck(checks, warnings, errors, 'memory_objects_parse', false, 'warn', 'memory-objects.json could not be parsed after retries');
  }

  let brainState = null;
  try {
    brainState = await loadJsonWithRetry(brainStatePath, null);
  } catch {
    brainState = null;
    addCheck(checks, warnings, errors, 'brain_state_parse', false, 'warn', 'brain-state.json could not be parsed');
  }

  let highWater = null;
  try {
    highWater = fs.existsSync(highWaterPath) ? JSON.parse(fs.readFileSync(highWaterPath, 'utf8')) : null;
  } catch {
    highWater = null;
  }

  const receipts = lastJsonlTimestamp(receiptsPath);
  const publish = lastJsonlTimestamp(publishLedgerPath);

  const files = {
    state: fileMeta(`${statePath}.gz`),
    nodesSidecar: fileMeta(path.join(brainDir, 'memory-nodes.jsonl.gz')),
    edgesSidecar: fileMeta(path.join(brainDir, 'memory-edges.jsonl.gz')),
    nodesSidecarTmp: fileMeta(path.join(brainDir, 'memory-nodes.jsonl.gz.tmp')),
    edgesSidecarTmp: fileMeta(path.join(brainDir, 'memory-edges.jsonl.gz.tmp')),
    snapshot: fileMeta(path.join(brainDir, 'brain-snapshot.json')),
    memoryObjects: fileMeta(memoryObjectsPath),
    brainState: fileMeta(brainStatePath),
    receipts: fileMeta(receiptsPath),
  };

  addCheck(
    checks,
    warnings,
    errors,
    'required_surfaces_present',
    files.state.exists && files.nodesSidecar.exists && files.edgesSidecar.exists && files.snapshot.exists,
    'error',
    'state.json.gz, both sidecars, and brain-snapshot.json should all exist'
  );
  addCheck(
    checks,
    warnings,
    errors,
    'stale_sidecar_tmp',
    !files.nodesSidecarTmp.exists && !files.edgesSidecarTmp.exists,
    'warn',
    `nodesTmp=${files.nodesSidecarTmp.exists} edgesTmp=${files.edgesSidecarTmp.exists}`
  );

  addCheck(
    checks,
    warnings,
    errors,
    'snapshot_vs_sidecars',
    !!snapshot && snapshot.nodeCount === logicalSidecarCounts.nodes && snapshot.edgeCount === logicalSidecarCounts.edges,
    'error',
    `snapshot=${snapshot ? `${snapshot.nodeCount}/${snapshot.edgeCount}` : 'missing'} logicalSidecars=${logicalSidecarCounts.nodes}/${logicalSidecarCounts.edges} fullSidecars=${sidecarCounts.nodes}/${sidecarCounts.edges} deltaEntries=${logicalSidecarCounts.deltaEntries}`
  );
  addCheck(
    checks,
    warnings,
    errors,
    'sidecar_parse_errors',
    sidecarCounts.nodeParseErrors === 0 && sidecarCounts.edgeParseErrors === 0 && logicalSidecarCounts.deltaParseErrors === 0,
    'warn',
    `nodeParseErrors=${sidecarCounts.nodeParseErrors} edgeParseErrors=${sidecarCounts.edgeParseErrors} deltaParseErrors=${logicalSidecarCounts.deltaParseErrors}`
  );

  const inlineNodes = Array.isArray(state?.memory?.nodes) ? state.memory.nodes.length : 0;
  const inlineEdges = Array.isArray(state?.memory?.edges) ? state.memory.edges.length : 0;
  addCheck(
    checks,
    warnings,
    errors,
    'state_shape_matches_sidecar_mode',
    !sidecarPresent || (inlineNodes === 0 && inlineEdges === 0),
    'warn',
    `sidecarsPresent=${sidecarPresent} inlineNodes=${inlineNodes} inlineEdges=${inlineEdges}`
  );

  const stateSnapshotDriftMs = Math.abs(files.state.mtimeMs - files.snapshot.mtimeMs);
  const fullSidecarSnapshotDriftMs = Math.max(
    Math.abs(files.nodesSidecar.mtimeMs - files.snapshot.mtimeMs),
    Math.abs(files.edgesSidecar.mtimeMs - files.snapshot.mtimeMs),
  );
  const snapshotMatchesLogicalSidecars = !!snapshot &&
    snapshot.nodeCount === logicalSidecarCounts.nodes &&
    snapshot.edgeCount === logicalSidecarCounts.edges;
  const deltaOverlayActive = logicalSidecarCounts.deltaEntries > 0;
  addCheck(
    checks,
    warnings,
    errors,
    'coherent_save_mtime_drift',
    stateSnapshotDriftMs <= 5 * 60 * 1000 && (fullSidecarSnapshotDriftMs <= 5 * 60 * 1000 || (deltaOverlayActive && snapshotMatchesLogicalSidecars)),
    'warn',
    `state/snapshot drift ${(stateSnapshotDriftMs / 1000).toFixed(1)}s; full-sidecar/snapshot drift ${(fullSidecarSnapshotDriftMs / 1000).toFixed(1)}s; deltaEntries=${logicalSidecarCounts.deltaEntries}`
  );

  const highWaterNodes = Number.isFinite(highWater?.maxNodeCount) ? highWater.maxNodeCount : null;
  addCheck(
    checks,
    warnings,
    errors,
    'high_water_regression',
    highWaterNodes === null || snapshot?.nodeCount >= Math.floor(highWaterNodes * 0.9),
    'warn',
    `snapshotNodes=${snapshot?.nodeCount ?? 'n/a'} highWater=${highWaterNodes ?? 'n/a'}`
  );

  addCheck(
    checks,
    warnings,
    errors,
    'backups_present',
    backups.length > 0,
    'warn',
    `backup count=${backups.length}`
  );

  const report = {
    ok: errors.length === 0,
    brainDir,
    authoritativeSource: sidecarPresent ? 'sidecars' : 'state.json.gz',
    counts: {
      snapshotNodes: snapshot?.nodeCount ?? 0,
      snapshotEdges: snapshot?.edgeCount ?? 0,
      sidecarNodes: logicalSidecarCounts.nodes || sidecarCounts.nodes,
      sidecarEdges: logicalSidecarCounts.edges || sidecarCounts.edges,
      fullSidecarNodes: sidecarCounts.nodes,
      fullSidecarEdges: sidecarCounts.edges,
      deltaEntries: logicalSidecarCounts.deltaEntries,
      highWaterNodes: highWaterNodes ?? 0,
      memoryObjects: Array.isArray(memoryObjects?.objects) ? memoryObjects.objects.length : 0,
      crystallizationReceipts: receipts.count,
    },
    surfaces: {
      state: files.state,
      nodesSidecar: files.nodesSidecar,
      edgesSidecar: files.edgesSidecar,
      snapshot: { ...files.snapshot, memorySource: snapshot?.memorySource ?? null, cycle: snapshot?.cycle ?? null },
      highWater: { exists: highWaterNodes !== null, maxNodeCount: highWaterNodes },
      backups: {
        count: backups.length,
        latest: backups.length ? backups[backups.length - 1].name : null,
      },
      memoryObjects: files.memoryObjects,
      brainState: files.brainState,
    },
    health: {
      synthesisGeneratedAt: brainState?.generatedAt || null,
      lastCrystallizationReceiptAt: receipts.lastAt,
      lastPublishAt: publish.lastAt,
    },
    checks,
    warnings,
    errors,
  };

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  printText(report);
  process.exitCode = report.ok ? 0 : 1;
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
