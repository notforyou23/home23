#!/usr/bin/env node
/**
 * Live smoke test for brain_* tools. Requires a running agent + cosmo23.
 *
 * Usage:
 *   HOME23_AGENT=jerry node scripts/smoke-brain-tools.js
 */

const agentName = process.env.HOME23_AGENT || 'jerry';
const cosmo23Port = Number(process.env.COSMO23_PORT || 43210);
const enginePort = Number(process.env.HOME23_ENGINE_PORT || 5002);
const cosmo23Base = `http://localhost:${cosmo23Port}`;
const engineBase = `http://localhost:${enginePort}`;

async function resolveBrainRoute() {
  const res = await fetch(`${cosmo23Base}/api/brains`);
  if (!res.ok) throw new Error(`${cosmo23Base}/api/brains returned HTTP ${res.status}`);
  const data = await res.json();
  const brains = data.brains || [];
  const match = brains.find(b => b.name === agentName) ||
                brains.find(b => typeof b.path === 'string' && b.path.includes(`/instances/${agentName}/brain`));
  if (!match?.id) throw new Error(`No brain found for agent ${agentName} in ${cosmo23Base}/api/brains`);
  return `${cosmo23Base}/api/brain/${match.id}`;
}

function assertOk(condition, msg) {
  if (!condition) { console.error(`  ✗ ${msg}`); process.exitCode = 1; }
  else console.log(`  ✓ ${msg}`);
}

async function smokeBrainSearch() {
  console.log('\n[brain_search]');
  const res = await fetch(`${engineBase}/api/memory/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: 'smoke test query', topK: 3, minSimilarity: 0.1 }),
  });
  assertOk(res.ok, `HTTP ${res.status}`);
  if (res.ok) {
    const data = await res.json();
    assertOk(Array.isArray(data.results), 'results is array');
  }
}

async function smokeBrainStatus() {
  console.log('\n[brain_status]');
  const res = await fetch(`${engineBase}/api/state`);
  assertOk(res.ok, `HTTP ${res.status}`);
}

async function smokeBrainQuery(brainRoute) {
  console.log('\n[brain_query] (mode=full, no PGS, short timeout)');
  const res = await fetch(`${brainRoute}/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: 'What is the current status of the system?',
      mode: 'full',
      enableSynthesis: true,
      enablePGS: false,
    }),
    signal: AbortSignal.timeout(120_000),
  });
  assertOk(res.ok, `HTTP ${res.status}`);
  if (res.ok) {
    const data = await res.json();
    assertOk(typeof data.answer === 'string', 'answer is string');
  }
}

async function smokeBrainQueryExport(brainRoute) {
  console.log('\n[brain_query_export]');
  const res = await fetch(`${brainRoute}/export-query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: 'smoke export test',
      answer: 'smoke test answer content',
      format: 'markdown',
      metadata: { smoke: true },
    }),
  });
  assertOk(res.ok, `HTTP ${res.status}`);
  if (res.ok) {
    const data = await res.json();
    assertOk(typeof data.exportedTo === 'string' && data.exportedTo.length > 0, `exportedTo: ${data.exportedTo}`);
  }
}

(async () => {
  console.log(`Smoke test for agent=${agentName} cosmo23=${cosmo23Base} engine=${engineBase}`);
  const brainRoute = await resolveBrainRoute();
  console.log(`Resolved brainRoute: ${brainRoute}`);

  await smokeBrainSearch();
  await smokeBrainStatus();
  await smokeBrainQuery(brainRoute);
  await smokeBrainQueryExport(brainRoute);

  if (process.exitCode) console.error('\n✗ Smoke FAILED');
  else console.log('\n✓ Smoke PASSED');
})().catch(err => { console.error(err); process.exit(1); });
