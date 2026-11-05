#!/usr/bin/env node

/**
 * stage-merged-brain-import.js
 *
 * Build a staged Jerry brain by importing memory nodes/edges from a merged
 * COSMO run into Jerry's current sidecar brain. This script does not modify the
 * live brain. It writes a standalone staging directory that can be inspected
 * and coherence-checked before any live swap.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const readline = require('readline');
const { pipeline } = require('stream/promises');

const { StateCompression } = require('../src/core/state-compression');
const { readSnapshot } = require('../src/core/brain-snapshot');

const MERGE_ONLY_FIELDS = [
  'originalId',
  'sourceRun',
  'sourceRuns',
  'runPrefix',
  'provenance',
  'degree',
  'mergedAt',
];

function parseArgs(argv) {
  const args = {
    agent: 'jerry',
    thresholdLabel: 'native-import',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if ((arg === '--source' || arg === '-s') && argv[i + 1]) args.source = argv[++i];
    else if (arg === '--agent' && argv[i + 1]) args.agent = argv[++i];
    else if (arg === '--brain-dir' && argv[i + 1]) args.brainDir = argv[++i];
    else if (arg === '--out' && argv[i + 1]) args.out = argv[++i];
    else if (arg === '--label' && argv[i + 1]) args.thresholdLabel = argv[++i];
    else if (arg === '--keep-provenance') args.keepProvenance = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
  }

  return args;
}

function usage() {
  console.log(`Usage:
  node engine/scripts/stage-merged-brain-import.js --source <run-dir-or-state.json.gz> [--agent jerry] [--out <stage-dir>]

Options:
  --source           Merged COSMO run directory or state.json(.gz) file to import from
  --agent            Home23 agent name for the target brain (default: jerry)
  --brain-dir        Explicit target brain directory instead of instances/<agent>/brain
  --out              Staging directory to write (default: /private/tmp/home23-brain-import-<timestamp>)
  --label            Migration label written into import-manifest.json
  --keep-provenance  Keep sourceRun/sourceRuns/provenance metadata on imported nodes
`);
}

function resolveStatePath(input) {
  const resolved = path.resolve(input);
  const stat = fs.statSync(resolved);
  if (stat.isDirectory()) {
    const candidates = [
      path.join(resolved, 'state.json.gz'),
      path.join(resolved, 'coordinator', 'state.json.gz'),
      path.join(resolved, 'state.json'),
      path.join(resolved, 'coordinator', 'state.json'),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }
    throw new Error(`No state.json(.gz) found under ${resolved}`);
  }
  return resolved;
}

async function loadStateFile(filePath) {
  if (filePath.endsWith('.gz')) {
    return JSON.parse(zlib.gunzipSync(fs.readFileSync(filePath)).toString('utf8'));
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

async function* readJsonlGz(filePath) {
  const input = fs.createReadStream(filePath).pipe(zlib.createGunzip());
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    yield JSON.parse(line);
  }
}

function writeLine(stream, line) {
  if (stream.write(line)) return Promise.resolve();
  return new Promise(resolve => stream.once('drain', resolve));
}

async function writeCompressedJsonl(filePath, writeRecords) {
  const tmpPath = `${filePath}.tmp`;
  const gzip = zlib.createGzip({ level: zlib.constants.Z_BEST_COMPRESSION });
  const out = fs.createWriteStream(tmpPath);
  const pipePromise = pipeline(gzip, out);

  let count = 0;
  const writeRecord = async (record) => {
    await writeLine(gzip, `${JSON.stringify(record)}\n`);
    count += 1;
  };

  await writeRecords(writeRecord);
  gzip.end();
  await pipePromise;
  fs.renameSync(tmpPath, filePath);

  return { count, bytes: fs.statSync(filePath).size };
}

function cloneImportedNode(node, newId, meanRatio, keepProvenance) {
  const imported = { ...node, id: newId };
  imported.activation = 0;
  imported.accessCount = 0;
  imported.accessed = imported.accessed || new Date().toISOString();
  imported.weight = Math.min(1, Math.max(0.1, (Number(imported.weight) || 0.5) * meanRatio));

  if (!keepProvenance) {
    for (const field of MERGE_ONLY_FIELDS) {
      delete imported[field];
    }
  }

  return imported;
}

function normalizeEdgeEndpoint(edge, key) {
  if (edge[key] !== undefined) return edge[key];
  if (key === 'source' && edge.from !== undefined) return edge.from;
  if (key === 'target' && edge.to !== undefined) return edge.to;
  return undefined;
}

function cloneImportedEdge(edge, source, target) {
  return {
    source,
    target,
    weight: Math.min(1, Number(edge.weight) || 0.3),
    type: edge.type || 'associative',
    created: edge.created || new Date().toISOString(),
    accessed: edge.accessed || edge.created || new Date().toISOString(),
  };
}

async function scanCurrentNodes(nodesPath) {
  let count = 0;
  let numericMaxId = 0;
  let weightSum = 0;
  let nodesWithEmbedding = 0;

  for await (const node of readJsonlGz(nodesPath)) {
    count += 1;
    if (typeof node.id === 'number' && node.id > numericMaxId) numericMaxId = node.id;
    const weight = Number(node.weight);
    weightSum += Number.isFinite(weight) ? weight : 0.5;
    if (Array.isArray(node.embedding)) nodesWithEmbedding += 1;
  }

  return {
    count,
    numericMaxId,
    meanWeight: count > 0 ? weightSum / count : 0.5,
    nodesWithEmbedding,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.source) {
    usage();
    process.exit(args.help ? 0 : 1);
  }

  const repoRoot = path.resolve(__dirname, '..', '..');
  const brainDir = args.brainDir
    ? path.resolve(args.brainDir)
    : path.join(repoRoot, 'instances', args.agent, 'brain');
  const sourceStatePath = resolveStatePath(args.source);
  const outDir = args.out
    ? path.resolve(args.out)
    : path.join('/private/tmp', `home23-brain-import-${args.agent}-${Date.now()}`);

  const currentStatePath = path.join(brainDir, 'state.json');
  const currentNodesPath = path.join(brainDir, 'memory-nodes.jsonl.gz');
  const currentEdgesPath = path.join(brainDir, 'memory-edges.jsonl.gz');

  for (const required of [`${currentStatePath}.gz`, currentNodesPath, currentEdgesPath]) {
    if (!fs.existsSync(required)) throw new Error(`Missing required target brain file: ${required}`);
  }

  const sourceState = await loadStateFile(sourceStatePath);
  const sourceNodes = sourceState.memory?.nodes || [];
  const sourceEdges = sourceState.memory?.edges || [];
  if (!Array.isArray(sourceNodes) || sourceNodes.length === 0) {
    throw new Error('Source state has no inline memory.nodes to import');
  }

  console.log('=== Stage merged brain import ===');
  console.log(`target brain: ${brainDir}`);
  console.log(`source state: ${sourceStatePath}`);
  console.log(`stage dir:    ${outDir}`);

  console.log('\nScanning current Jerry sidecar nodes...');
  const preflightStats = await scanCurrentNodes(currentNodesPath);
  const currentSnapshot = readSnapshot(brainDir);
  console.log(`  current nodes: ${preflightStats.count}`);
  console.log(`  current edges: ${currentSnapshot?.edgeCount ?? 'unknown'} snapshot / sidecar will be copied`);
  console.log(`  max numeric id: ${preflightStats.numericMaxId}`);
  console.log(`  mean weight: ${preflightStats.meanWeight.toFixed(4)}`);

  const sourceWeightSum = sourceNodes.reduce((sum, node) => {
    const weight = Number(node.weight);
    return sum + (Number.isFinite(weight) ? weight : 0.5);
  }, 0);
  const sourceMeanWeight = sourceNodes.length > 0 ? sourceWeightSum / sourceNodes.length : 0.5;

  console.log('\nPreparing imported jtr nodes...');
  console.log(`  source nodes: ${sourceNodes.length}`);
  console.log(`  source edges: ${sourceEdges.length}`);
  console.log(`  source mean weight: ${sourceMeanWeight.toFixed(4)}`);

  fs.mkdirSync(outDir, { recursive: true });

  console.log('\nWriting staged sidecars...');
  const stagedNodesPath = path.join(outDir, 'memory-nodes.jsonl.gz');
  const stagedEdgesPath = path.join(outDir, 'memory-edges.jsonl.gz');

  const currentNodeIds = new Set();
  const copiedStats = {
    nodes: 0,
    numericMaxId: 0,
    weightSum: 0,
    nodesWithEmbedding: 0,
  };
  const idMap = new Map();
  const importedNodes = [];
  let nextId = 1;
  let meanRatio = 1;

  const nodeWrite = await writeCompressedJsonl(stagedNodesPath, async (writeRecord) => {
    for await (const node of readJsonlGz(currentNodesPath)) {
      copiedStats.nodes += 1;
      currentNodeIds.add(node.id);
      if (typeof node.id === 'number' && node.id > copiedStats.numericMaxId) copiedStats.numericMaxId = node.id;
      const weight = Number(node.weight);
      copiedStats.weightSum += Number.isFinite(weight) ? weight : 0.5;
      if (Array.isArray(node.embedding)) copiedStats.nodesWithEmbedding += 1;
      await writeRecord(node);
    }

    const copiedMeanWeight = copiedStats.nodes > 0 ? copiedStats.weightSum / copiedStats.nodes : 0.5;
    meanRatio = sourceMeanWeight > 0 ? copiedMeanWeight / sourceMeanWeight : 1;
    nextId = copiedStats.numericMaxId + 1;

    for (const node of importedNodes) {
      await writeRecord(node);
    }

    for (const node of sourceNodes) {
      const newId = nextId++;
      if (currentNodeIds.has(newId)) {
        throw new Error(`Refusing to stage import: generated id ${newId} already exists in copied target nodes`);
      }
      idMap.set(node.id, newId);
      const imported = cloneImportedNode(node, newId, meanRatio, args.keepProvenance);
      importedNodes.push(imported);
      currentNodeIds.add(newId);
      await writeRecord(imported);
    }
  });

  const importedEdges = [];
  let droppedEdges = 0;
  let selfLoops = 0;
  const importedEdgeKeys = new Set();
  for (const edge of sourceEdges) {
    const oldSource = normalizeEdgeEndpoint(edge, 'source');
    const oldTarget = normalizeEdgeEndpoint(edge, 'target');
    const source = idMap.get(oldSource);
    const target = idMap.get(oldTarget);
    if (source === undefined || target === undefined) {
      droppedEdges += 1;
      continue;
    }
    if (source === target) {
      selfLoops += 1;
      continue;
    }
    const [a, b] = [source, target].sort((left, right) => String(left).localeCompare(String(right)));
    const key = `${a}->${b}`;
    if (importedEdgeKeys.has(key)) continue;
    importedEdgeKeys.add(key);
    importedEdges.push(cloneImportedEdge(edge, a, b));
  }

  console.log(`  copied current nodes: ${copiedStats.nodes}`);
  console.log(`  copied max numeric id: ${copiedStats.numericMaxId}`);
  console.log(`  weight ratio: ${meanRatio.toFixed(4)}`);
  console.log(`  remapped node ids: ${importedNodes[0]?.id}..${importedNodes.at(-1)?.id}`);
  console.log(`  imported edges: ${importedEdges.length}`);
  if (droppedEdges || selfLoops) {
    console.log(`  dropped edges: ${droppedEdges} orphan, ${selfLoops} self-loop`);
  }

  let currentEdgesCopied = 0;
  let currentEdgesSkipped = 0;
  const edgeWrite = await writeCompressedJsonl(stagedEdgesPath, async (writeRecord) => {
    for await (const edge of readJsonlGz(currentEdgesPath)) {
      const source = normalizeEdgeEndpoint(edge, 'source');
      const target = normalizeEdgeEndpoint(edge, 'target');
      if (!currentNodeIds.has(source) || !currentNodeIds.has(target) || source === target) {
        currentEdgesSkipped += 1;
        continue;
      }
      currentEdgesCopied += 1;
      await writeRecord(edge);
    }
    for (const edge of importedEdges) {
      await writeRecord(edge);
    }
  });

  console.log(`  staged nodes: ${nodeWrite.count}`);
  console.log(`  staged edges: ${edgeWrite.count}`);
  if (currentEdgesSkipped) {
    console.log(`  skipped current edges not present in copied node set: ${currentEdgesSkipped}`);
  }

  console.log('\nWriting staged state and snapshot...');
  const stagedState = await StateCompression.loadCompressed(currentStatePath);
  stagedState.memory = {
    ...(stagedState.memory || {}),
    nodes: [],
    edges: [],
    nextNodeId: nextId,
  };
  stagedState.timestamp = new Date().toISOString();
  await StateCompression.saveCompressed(path.join(outDir, 'state.json'), stagedState, {
    compress: true,
    pretty: false,
  });

  const snapshot = {
    savedAt: new Date().toISOString(),
    cycle: stagedState.cycleCount || 0,
    nodeCount: nodeWrite.count,
    edgeCount: edgeWrite.count,
    fileSize: fs.statSync(path.join(outDir, 'state.json.gz')).size,
    memorySource: 'sidecar',
    nodesSidecarBytes: nodeWrite.bytes,
    edgesSidecarBytes: edgeWrite.bytes,
    stagedImport: true,
    importedFrom: sourceStatePath,
  };
  fs.writeFileSync(path.join(outDir, 'brain-snapshot.json'), JSON.stringify(snapshot, null, 2));

  const highWaterPath = path.join(brainDir, 'brain-high-water.json');
  let highWater = { maxNodeCount: nodeWrite.count, lastSeen: snapshot.savedAt };
  if (fs.existsSync(highWaterPath)) {
    try {
      const currentHighWater = JSON.parse(fs.readFileSync(highWaterPath, 'utf8'));
      highWater.maxNodeCount = Math.max(Number(currentHighWater.maxNodeCount) || 0, nodeWrite.count);
    } catch {
      // Keep generated high water.
    }
  }
  fs.writeFileSync(path.join(outDir, 'brain-high-water.json'), JSON.stringify(highWater, null, 2));

  const manifest = {
    createdAt: snapshot.savedAt,
    label: args.thresholdLabel,
    targetBrainDir: brainDir,
    sourceStatePath,
    keepProvenance: !!args.keepProvenance,
    current: {
      preflightNodes: preflightStats.count,
      copiedNodes: copiedStats.nodes,
      copiedEdges: currentEdgesCopied,
      skippedEdges: currentEdgesSkipped,
      snapshotEdges: currentSnapshot?.edgeCount ?? null,
      maxNumericId: copiedStats.numericMaxId,
      meanWeight: copiedStats.nodes > 0 ? copiedStats.weightSum / copiedStats.nodes : 0.5,
    },
    source: {
      nodes: sourceNodes.length,
      edges: sourceEdges.length,
      meanWeight: sourceMeanWeight,
      cycleCount: sourceState.cycleCount || 0,
    },
    staged: {
      dir: outDir,
      nodes: nodeWrite.count,
      edges: edgeWrite.count,
      nextNodeId: nextId,
      importedNodes: importedNodes.length,
      importedEdges: importedEdges.length,
      droppedEdges,
      selfLoops,
      nodesSidecarBytes: nodeWrite.bytes,
      edgesSidecarBytes: edgeWrite.bytes,
    },
  };
  fs.writeFileSync(path.join(outDir, 'import-manifest.json'), JSON.stringify(manifest, null, 2));

  console.log('\nDone.');
  console.log(`  manifest: ${path.join(outDir, 'import-manifest.json')}`);
  console.log(`  next check: node engine/scripts/brain-coherence-check.js --brain-dir ${outDir}`);
}

main().catch((err) => {
  console.error(`FATAL: ${err.stack || err.message}`);
  process.exit(1);
});
