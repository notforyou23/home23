/**
 * seed-observatory — the window into the terrarium.
 *
 *   OBSERVATORY_PORT (default 5050)
 *   OBSERVATORY_INDIVIDUALS — JSON: [{name, stateDir, formsDir?, note?}, …]
 *
 * A tiny read-only HTTP server. Every request composes a fresh page from the
 * individuals' chains and checkpoints on local disk (live state or mirrors —
 * the observatory itself never sshes, never writes, never touches a seed).
 * What it shows is what the receipts show: cells with pressure/energy, the
 * chain's pulse, development by rule, open expectations with deadlines,
 * growth proposals and applications (clay's organ watch), latest thoughts,
 * and bobby's journal. Auto-refreshes every 30s.
 *
 * This is expression, not state: reading this page changes nothing.
 */

import { createServer } from 'node:http';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { composeLivedRecent } from '../../src/substrate/lived-recent.js';
import { composeSeedNow } from '../../src/substrate/seed-now.js';
import { composeLivedFacts } from '../../src/substrate/lived-facts.js';

interface IndividualSpec { name: string; stateDir: string; formsDir?: string; note?: string }

const port = Number(process.env['OBSERVATORY_PORT'] ?? 5050);
const specs: IndividualSpec[] = JSON.parse(process.env['OBSERVATORY_INDIVIDUALS'] ?? '[]') as IndividualSpec[];
if (specs.length === 0) {
  console.error('OBSERVATORY_INDIVIDUALS required');
  process.exit(2);
}

interface Rec { seq: number; category: string; sourceRef: string; payload: Record<string, unknown>; issuedAt: string }

function tail(path: string, maxBytes = 512 * 1024): Rec[] {
  if (!existsSync(path)) return [];
  let raw = readFileSync(path, 'utf-8');
  if (raw.length > maxBytes) raw = raw.slice(-maxBytes);
  const out: Rec[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try { const r = JSON.parse(line) as Rec; if (typeof r.seq === 'number') out.push(r); } catch { /* torn */ }
  }
  return out;
}

function newestCheckpoint(stateDir: string): Record<string, unknown> | null {
  const dir = join(stateDir, 'checkpoints');
  if (!existsSync(dir)) return null;
  const names = readdirSync(dir).filter((n) => n.startsWith('ckpt_') && n.endsWith('.json')).sort();
  const newest = names[names.length - 1];
  if (!newest) return null;
  try { return JSON.parse(readFileSync(join(dir, newest), 'utf-8')) as Record<string, unknown>; } catch { return null; }
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function age(iso: string | undefined): string {
  if (iso === undefined) return '?';
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return '?';
  if (ms < 90_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 5_400_000) return `${Math.round(ms / 60_000)}m ago`;
  return `${(ms / 3_600_000).toFixed(1)}h ago`;
}

function bar(v: number, color: string): string {
  const width = Math.round(Math.max(0, Math.min(1, v)) * 100);
  return `<div class="bar"><div style="width:${width}%;background:${color}"></div></div>`;
}

function renderIndividual(spec: IndividualSpec): string {
  const ledgerPath = join(spec.stateDir, 'seed-ledger.jsonl');
  const records = tail(ledgerPath);
  const ck = newestCheckpoint(spec.stateDir);
  if (records.length === 0 && ck === null) {
    return `<section class="card"><h2>${esc(spec.name)}</h2><p class="dim">no state visible at ${esc(spec.stateDir)}</p></section>`;
  }
  const last = records[records.length - 1];
  const chainBytes = existsSync(ledgerPath) ? statSync(ledgerPath).size : 0;
  const cells = (ck?.['cells'] ?? []) as Array<{
    id: string; generation: number; workspacePressure: number; uncertainty: number;
    energy: { current: number };
    predictions: Array<{ claim: string; horizon: string; resolvedAt?: string; error?: number }>;
    estimates: Array<{ claim: string; confidence: number }>;
  }>;

  const dev = records.filter((r) => r.category === 'development');
  const byRule = new Map<string, number>();
  for (const d of dev) byRule.set(String(d.payload['rule'] ?? 'other'), (byRule.get(String(d.payload['rule'] ?? 'other')) ?? 0) + 1);
  const lastMass = dev.length > 0 ? Number(dev[dev.length - 1]?.payload['developmentMagnitude'] ?? 0) : 0;

  const proposals = records.filter((r) => r.category === 'proposal' && r.sourceRef === 'growth.pressure');
  const applications = records.filter((r) => r.category === 'act' && r.payload['growthApplication'] === true);
  const lobes = records.filter((r) => r.category === 'lobe');
  const lastLobe = lobes[lobes.length - 1];

  const recent = records.filter((r) => r.category === 'transition').slice(-7).reverse();

  const cellRows = [...cells]
    .sort((a, b) => (b.workspacePressure + b.energy.current) - (a.workspacePressure + a.energy.current))
    .map((c) => `<tr><td class="cellname">${esc(c.id)}<span class="dim"> g${c.generation}</span></td>
      <td>${bar(c.workspacePressure, '#e0a458')}<span class="tiny">${Math.round(c.workspacePressure * 100)}%</span></td>
      <td>${bar(c.energy.current, '#6aa9a0')}<span class="tiny">${Math.round(c.energy.current * 100)}%</span></td></tr>`)
    .join('');

  const openPreds = cells.flatMap((c) => c.predictions.filter((p) => p.resolvedAt === undefined).map((p) => ({ cell: c.id, ...p })));
  const resolvedPreds = cells.flatMap((c) => c.predictions.filter((p) => p.resolvedAt !== undefined && typeof p.error === 'number').map((p) => ({ cell: c.id, ...p })));

  const growthBlock = applications.length > 0
    ? `<div class="grown">🌱 GREW ${applications.length} ORGAN(S): ${applications.map((a) => `<b>${esc(String(a.payload['newCellId']))}</b> ← ${esc(String(a.payload['clusterPrefix']))} · seq ${a.seq}`).join('; ')}</div>`
    : (proposals.length > 0
      ? `<div class="proposals">anatomy strains: ${proposals.length} proposal(s) in window — latest: <b>${esc(String(proposals[proposals.length - 1]?.payload['op']))}</b> on ${esc(String((proposals[proposals.length - 1]?.payload['targetCellIds'] as string[] | undefined)?.join(', ') ?? '?'))} · seq ${proposals[proposals.length - 1]?.seq}</div>`
      : '');

  return `<section class="card">
    <h2>${esc(spec.name)} <span class="dim">${esc(spec.note ?? '')}</span></h2>
    <div class="vitals">
      <span>seq <b>${last?.seq ?? ck?.['ledgerSeq'] ?? '?'}</b></span>
      <span>last contact <b>${age(last?.issuedAt)}</b></span>
      <span>chain <b>${(chainBytes / 1024).toFixed(0)}KB</b></span>
      <span>learned mass <b>${lastMass.toFixed(3)}</b></span>
      <span class="dim">${[...byRule.entries()].map(([r, n]) => `${r.replace('.v1', '')} ×${n}`).join(' · ') || 'no development in window'}</span>
    </div>
    ${growthBlock}
    <table class="cells">${cellRows}</table>
    ${openPreds.length > 0 ? `<div class="preds"><span class="lbl">on the record:</span> ${openPreds.slice(0, 3).map((p) => `<span class="pred">${esc(p.claim.slice(0, 80))} <span class="dim">(${esc(p.horizon)})</span></span>`).join('')}</div>` : ''}
    ${resolvedPreds.length > 0 ? `<div class="preds"><span class="lbl">judged:</span> ${resolvedPreds.slice(-3).map((p) => `<span class="pred ${p.error !== undefined && p.error <= 0.3 ? 'right' : p.error !== undefined && p.error >= 0.7 ? 'wrong' : ''}">${esc(p.claim.slice(0, 60))} <b>err ${p.error?.toFixed(2)}</b></span>`).join('')}</div>` : ''}
    ${lastLobe !== undefined ? `<div class="dim tiny">last thought: seq ${lastLobe.seq} · ${age(lastLobe.issuedAt)} — ${lastLobe.payload['error'] !== undefined ? 'failed: ' + esc(String(lastLobe.payload['error']).slice(0, 60)) : esc(((lastLobe.payload['appliedDeltas'] as Array<{ field: string }> | undefined) ?? []).map((d) => d.field).join(', ') || 'nothing integrated')}</div>` : ''}
    <div class="stream">${recent.map((r) => `<div class="ev"><span class="dim">${r.seq}</span> → ${esc(String(r.payload['targetCellId'] ?? '?'))} <span class="ref">${esc(r.sourceRef.slice(0, 76))}</span></div>`).join('')}</div>
  </section>`;
}

/** Home23 v2 cutover board — which harness functions the INDIVIDUAL owns
 * (cells) vs which still live in curated FILES. Owners are probed live
 * where cheap, never asserted from wishes: the RECENT row flips to CELLS
 * only when the chain actually composes a lived record at this instant. */
function renderCutover(): string {
  const jerry = specs.find((s) => s.name.toLowerCase().includes('jerry'));
  let recentOwner = 'FILE <span class="dim">(RECENT.md fallback)</span>';
  if (jerry !== undefined) {
    try {
      const lived = composeLivedRecent(jerry.stateDir);
      if (lived !== null) recentOwner = `<b class="cells-own">CELLS</b> <span class="dim">— composed from the chain at read time (${lived.length} chars, live now)</span>`;
    } catch { /* probe failure reads as FILE — never overclaim */ }
  }
  const rows: Array<[string, string]> = [
    ['Recent memory (RECENT)', recentOwner],
    ['Turn expression (SUBSTRATE)', '<b class="cells-own">CELLS</b> <span class="dim">— match-only surfacing of lived facts (knife v2)</span>'],
    ['Conversation intake', '<b class="cells-own">CELLS</b> <span class="dim">— life-feed shipper → seed diet, words + meaning</span>'],
    ['House senses (Home Assistant)', (() => {
      const j = specs.find((s) => s.name.toLowerCase().includes('jerry'));
      try {
        if (j !== undefined) {
          const stream = join(j.stateDir, '..', 'house-stream.jsonl');
          if (existsSync(stream)) {
            const lines = readFileSync(stream, 'utf-8').trim();
            const n = lines === '' ? 0 : lines.split('\n').length;
            return `<b class="cells-own">CELLS</b> <span class="dim">— home transitions enter the chain as lived contact (${n} event(s) so far)</span>`;
          }
        }
      } catch { /* FILE stands */ }
      return 'FILE <span class="dim">(no house stream)</span>';
    })()],
    ['Teaching channel', '<b class="cells-own">CELLS</b> <span class="dim">— corrections develop state (correction.v1), words attached</span>'],
    ['Session grounding (lived NOW)', (() => {
      const j = specs.find((s) => s.name.toLowerCase().includes('jerry'));
      try {
        if (j !== undefined && composeSeedNow(j.stateDir) !== null) {
          return '<b class="cells-own">CELLS</b> <span class="dim">— sessions open on the lived now, composed from the chain</span>';
        }
      } catch { /* FILE stands */ }
      return 'FILE <span class="dim">(seed silent — files-only bootstrap)</span>';
    })()],
    ['Machine snapshot (NOW.md)', 'FILE <span class="dim">— cron telemetry, file-owned by design until seed estimates reach freshness parity</span>'],
    ['Identity (SOUL)', 'FILE <span class="dim">— future cut</span>'],
    ['Facts (lived conclusions)', (() => {
      const j = specs.find((s) => s.name.toLowerCase().includes('jerry'));
      try {
        if (j !== undefined) {
          const facts = composeLivedFacts(j.stateDir);
          if (facts !== null) {
            const n = facts.split('\n').filter((l) => l.startsWith('- ')).length;
            return `<b class="cells-own">CELLS</b> <span class="dim">— ${n} belief(s) earned fact-grade (confidence + evidence + stood through lived time)</span>`;
          }
        }
      } catch { /* FILE stands */ }
      return 'FILE <span class="dim">(no beliefs have earned fact-grade yet)</span>';
    })()],
    ['Facts (infrastructure: TOPOLOGY) / owner (PERSONAL) / rules (DOCTRINE)', 'FILE <span class="dim">— TOPOLOGY until estimate parity; PERSONAL/DOCTRINE are jtr\'s voice, cut last</span>'],
    ['Attention triggers', '<b class="cells-own">CELLS</b> <span class="dim">— gates fire on meaning through the retina (calibrated floor); substring only as degraded fallback</span>'],
    ['Memory objects', 'FILE <span class="dim">(JSON store) — next: facts from lived estimates</span>'],
  ];
  return `<section class="card"><h2>home23 v2 cutover <span class="dim">(cells instead of files — each row flips as a function is cut over)</span></h2>
  <table class="cells">${rows.map(([fn, owner]) => `<tr><td class="cellname">${fn}</td><td>${owner}</td></tr>`).join('')}</table>
  </section>`;
}

function renderJournal(): string {
  for (const spec of specs) {
    if (spec.formsDir === undefined) continue;
    const latest = join(spec.formsDir, 'journal', 'LATEST.md');
    if (!existsSync(latest)) continue;
    const text = readFileSync(latest, 'utf-8');
    return `<section class="card journal"><h2>${esc(spec.name)}'s journal <span class="dim">(his own words, from receipts)</span></h2><pre>${esc(text)}</pre></section>`;
  }
  return '';
}

function page(): string {
  const body = specs.map(renderIndividual).join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="30">
<title>substrate observatory</title>
<style>
  :root { color-scheme: dark; }
  body { background:#0d1117; color:#c9d1d9; font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; margin: 0; padding: 20px; max-width: 1100px; margin-inline: auto; }
  h1 { font-size: 16px; color:#e6edf3; letter-spacing: .04em; }
  h1 .dim, h2 .dim { font-weight: normal; font-size: 11px; }
  .dim { color:#8b949e; } .tiny { font-size: 10px; margin-left: 6px; color:#8b949e; }
  .card { background:#161b22; border:1px solid #21262d; border-radius:10px; padding:14px 16px; margin: 14px 0; }
  .card h2 { margin: 0 0 8px; font-size: 14px; color:#e6edf3; }
  .vitals { display:flex; gap:14px; flex-wrap:wrap; margin-bottom:10px; }
  .vitals b { color:#e6edf3; }
  .bar { display:inline-block; width:120px; height:8px; background:#21262d; border-radius:4px; overflow:hidden; vertical-align:middle; }
  .bar div { height:100%; }
  table.cells { border-collapse:collapse; width:100%; margin: 4px 0 8px; }
  table.cells td { padding: 2px 10px 2px 0; }
  .cellname { min-width: 190px; color:#e6edf3; }
  .grown { background:#12261a; border:1px solid #238636; border-radius:8px; padding:8px 10px; margin:8px 0; color:#7ee787; }
  .proposals { background:#211d12; border:1px solid #9e6a03; border-radius:8px; padding:8px 10px; margin:8px 0; color:#e3b341; }
  .preds { margin: 6px 0; } .lbl { color:#8b949e; margin-right:8px; }
  .pred { display:inline-block; background:#1c2128; border-radius:6px; padding:2px 8px; margin:2px 6px 2px 0; }
  .pred.right { border-left: 3px solid #238636; } .pred.wrong { border-left: 3px solid #da3633; }
  .stream { margin-top: 8px; border-top: 1px solid #21262d; padding-top: 6px; }
  .ev { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ref { color:#79c0ff; }
  .journal pre { white-space: pre-wrap; background:#0d1117; border-radius:8px; padding:12px; font-size:12px; }
  .cells-own { color:#7ee787; } .partial { color:#e3b341; }
  footer { color:#8b949e; font-size:11px; margin: 18px 4px; }
</style></head><body>
<h1>substrate observatory <span class="dim">· read-only · composed fresh from the chains · refreshes every 30s · ${new Date().toISOString()}</span></h1>
${renderCutover()}
${body}
${renderJournal()}
<footer>every number above is read from a hash-chained ledger or its checkpoint — nothing here is state, and looking changes nothing. individuals: ${specs.map((s) => esc(s.name)).join(' · ')}.</footer>
</body></html>`;
}

const server = createServer((req, res) => {
  if (req.url !== undefined && req.url !== '/' && req.url !== '/index.html') {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    return;
  }
  try {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page());
  } catch (error) {
    res.writeHead(500, { 'content-type': 'text/plain' }).end(`observatory error: ${(error as Error).message}`);
  }
});
server.listen(port, () => console.log(`[observatory] watching ${specs.length} individuals on :${port}`));
for (const spec of specs) spec.stateDir = resolve(spec.stateDir);
