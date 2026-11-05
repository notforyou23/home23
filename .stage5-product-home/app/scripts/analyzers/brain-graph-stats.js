#!/usr/bin/env node
/**
 * brain-graph-stats.js
 *
 * Snapshot of an agent's brain-edge topology. Prints edge-type counts,
 * the degree distribution, and top hubs with per-type breakdown. Used
 * to verify the Watts-Strogatz bridge cap + preferential decay are
 * bringing the graph into a healthy equilibrium.
 *
 * Usage:
 *   node scripts/analyzers/brain-graph-stats.js <agent>
 *   node scripts/analyzers/brain-graph-stats.js forrest
 *
 * What healthy looks like (after fix settles):
 *   - bridge / (bridge + associative) ratio trending down from ~0.98
 *   - no node over maxBridgesPerNode (currently 40)
 *   - degree distribution power-law-ish, no visible outlier
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const agent = process.argv[2];
if (!agent) {
  console.error('usage: brain-graph-stats.js <agent-name>');
  process.exit(1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const edgesPath = path.join(repoRoot, 'instances', agent, 'brain', 'memory-edges.jsonl.gz');

if (!fs.existsSync(edgesPath)) {
  console.error(`not found: ${edgesPath}`);
  process.exit(1);
}

const CAP = Number(process.env.CAP ?? 40);
const TOP_N = Number(process.env.TOP ?? 20);

function pct(x, total) {
  return total ? ((x / total) * 100).toFixed(1) + '%' : '0%';
}

(async () => {
  const rl = readline.createInterface({
    input: fs.createReadStream(edgesPath).pipe(zlib.createGunzip()),
    crlfDelay: Infinity
  });

  const typeTotals = new Map();
  const deg = new Map();
  const typeByNode = new Map();
  let total = 0;

  for await (const line of rl) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    total++;
    typeTotals.set(e.type, (typeTotals.get(e.type) || 0) + 1);
    for (const endpoint of [e.source, e.target]) {
      deg.set(endpoint, (deg.get(endpoint) || 0) + 1);
      if (!typeByNode.has(endpoint)) typeByNode.set(endpoint, new Map());
      const m = typeByNode.get(endpoint);
      m.set(e.type, (m.get(e.type) || 0) + 1);
    }
  }

  const sortedDeg = [...deg.entries()].sort((a, b) => b[1] - a[1]);
  const n = sortedDeg.length;
  const sum = sortedDeg.reduce((a, [, d]) => a + d, 0);
  const mean = n ? sum / n : 0;
  const variance = n ? sortedDeg.reduce((a, [, d]) => a + (d - mean) ** 2, 0) / n : 0;
  const sd = Math.sqrt(variance);

  const bridge = typeTotals.get('bridge') || 0;
  const assoc = typeTotals.get('associative') || 0;
  const ratio = bridge / Math.max(bridge + assoc, 1);

  console.log(`brain-graph-stats — ${agent}`);
  console.log(`─ file: ${edgesPath}`);
  console.log(`─ edges: ${total}   nodes_with_edges: ${n}   mean_deg: ${mean.toFixed(2)}   sd: ${sd.toFixed(2)}`);
  console.log();

  console.log('edge types:');
  for (const [t, c] of [...typeTotals.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${t.padEnd(14)} ${String(c).padStart(8)}   ${pct(c, total)}`);
  }
  console.log(`  bridge/(bridge+assoc) = ${(ratio * 100).toFixed(1)}%   (target: trending down from ~98%)`);
  console.log();

  const buckets = [
    ['deg > 200', (d) => d > 200],
    ['deg > 100', (d) => d > 100],
    ['deg >  50', (d) => d > 50],
    ['deg >  20', (d) => d > 20],
    ['deg >  10', (d) => d > 10]
  ];
  console.log('degree buckets:');
  for (const [label, pred] of buckets) {
    console.log(`  ${label}: ${sortedDeg.filter(([, d]) => pred(d)).length}`);
  }
  console.log();

  const overCap = [];
  for (const [id, m] of typeByNode) {
    const b = m.get('bridge') || 0;
    if (b > CAP) overCap.push([id, b]);
  }
  overCap.sort((a, b) => b[1] - a[1]);
  console.log(`nodes over fan-out cap (${CAP}): ${overCap.length}`);
  if (overCap.length) {
    for (const [id, b] of overCap.slice(0, 10)) {
      console.log(`  node ${id}: ${b} bridges`);
    }
    if (overCap.length > 10) console.log(`  … and ${overCap.length - 10} more`);
  }
  console.log();

  console.log(`top ${TOP_N} nodes by total degree:`);
  for (const [id, d] of sortedDeg.slice(0, TOP_N)) {
    const m = typeByNode.get(id);
    const breakdown = [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([t, c]) => `${t}=${c}`)
      .join(', ');
    const cap = (m.get('bridge') || 0) > CAP ? '  ⚠' : '';
    console.log(`  ${String(id).padEnd(10)} deg=${String(d).padStart(4)}   ${breakdown}${cap}`);
  }
})().catch(err => {
  console.error(err);
  process.exit(1);
});
