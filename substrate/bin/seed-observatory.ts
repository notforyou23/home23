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
import { composeLivedIdentity, readSeedGenesis } from '../../src/substrate/lived-identity.js';
import { createRequire } from 'node:module';
const engineRequire = createRequire(import.meta.url);
const { composeLivedState } = engineRequire('../../engine/src/substrate/seed-lived-state.js') as { composeLivedState: (dir: string) => string | null };

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

/** The body, drawn for a human — every visual channel is still a real
 * number (state spokes = the actual Float32 vector, size = wear, glow =
 * energy, ring heat = pressure, dashes = uncertainty), but the body now
 * speaks: each cell carries a plain-language state word, and the numbers
 * live in hover tooltips instead of the reader's working memory. */
function stateWords(c: { generation: number; workspacePressure: number; uncertainty: number; energy: { current: number } }, maxGen: number): string {
  const words: string[] = [];
  words.push(c.generation >= Math.max(5, maxGen * 0.5) ? 'worn' : c.generation < 5 ? 'young' : 'lived-in');
  if (c.workspacePressure > 0.45) words.push('pressurized');
  else if (c.energy.current > 0.7) words.push('bright');
  else if (c.workspacePressure < 0.12 && c.energy.current < 0.35) words.push('resting');
  else words.push('calm');
  if (c.uncertainty > 0.6) words.push('unsettled');
  return words.slice(0, 2).join(' · ');
}

function renderBodySVG(
  cells: Array<{
    id: string; generation: number; workspacePressure: number; uncertainty: number;
    energy: { current: number };
    continuousState?: string; continuousStateDimension?: number;
    associations?: Array<{ targetCellId: string; strength: number }>;
  }>,
  records: Rec[],
): string {
  if (cells.length === 0) return '';
  const W = 960, H = 264, cy = 132;
  const slot = W / cells.length;
  const centers = new Map<string, { x: number; y: number; r: number }>();
  const maxGen = Math.max(...cells.map((c) => c.generation), 1);
  const parts: string[] = [];

  cells.forEach((c, i) => {
    const x = slot * (i + 0.5);
    const r = 20 + 36 * Math.sqrt(Math.log(c.generation + 2) / Math.log(maxGen + 2));
    centers.set(c.id, { x, y: cy, r });
  });
  for (const c of cells) {
    for (const a of c.associations ?? []) {
      const from = centers.get(c.id); const to = centers.get(a.targetCellId);
      if (!from || !to || from.x >= to.x) continue;
      parts.push(`<path d="M ${from.x} ${cy} Q ${(from.x + to.x) / 2} ${cy - 76} ${to.x} ${cy}" fill="none" stroke="#5b6478" stroke-width="${(0.6 + 2 * a.strength).toFixed(1)}" opacity="${(0.18 + 0.45 * a.strength).toFixed(2)}"/>`);
    }
  }

  const flowColor = (ref: string): string =>
    ref.startsWith('conversation.') ? '#69d58c'
    : ref.startsWith('house.') ? '#e6b450'
    : ref.startsWith('worker.') ? '#6cb2f5'
    : ref.startsWith('relationship.') ? '#c795f0'
    : '#525b6b';
  const flows = records.filter((r) => r.category === 'transition').slice(-16);
  const perCell = new Map<string, number>();
  for (const f of flows) {
    const target = String(f.payload['targetCellId'] ?? '');
    const c = centers.get(target);
    if (!c) continue;
    const n = perCell.get(target) ?? 0;
    perCell.set(target, n + 1);
    parts.push(`<circle cx="${c.x - 24 + (n % 8) * 7}" cy="${c.y - c.r - 30 - Math.floor(n / 8) * 8}" r="2.8" fill="${flowColor(f.sourceRef)}"><title>${esc(f.sourceRef.slice(0, 90))}</title></circle>`);
  }

  for (const c of cells) {
    const { x, r } = centers.get(c.id)!;
    const p = Math.min(1, c.workspacePressure * 1.5);
    const ring = p > 0.6 ? '#e0653a' : p > 0.3 ? '#e0a458' : '#3d4658';
    let spokes = '';
    if (typeof c.continuousState === 'string') {
      try {
        const buf = Buffer.from(c.continuousState, 'base64');
        const dim = c.continuousStateDimension ?? Math.floor(buf.length / 4);
        const vec = new Float32Array(buf.buffer, buf.byteOffset, dim);
        let maxAbs = 1e-6;
        for (const v of vec) maxAbs = Math.max(maxAbs, Math.abs(v));
        const inner = r * 0.3;
        for (let i = 0; i < dim; i++) {
          const angle = (i / dim) * Math.PI * 2 - Math.PI / 2;
          const mag = Math.abs(vec[i] ?? 0) / maxAbs;
          const len = inner + (r * 0.6 - inner) * mag;
          spokes += `<line x1="${(x + Math.cos(angle) * inner).toFixed(1)}" y1="${(cy + Math.sin(angle) * inner).toFixed(1)}" x2="${(x + Math.cos(angle) * len).toFixed(1)}" y2="${(cy + Math.sin(angle) * len).toFixed(1)}" stroke="${(vec[i] ?? 0) >= 0 ? '#d9a25b' : '#5b95d1'}" stroke-width="1" opacity="${(0.28 + 0.55 * mag).toFixed(2)}"/>`;
        }
      } catch { /* unreadable state renders coreless — honest */ }
    }
    const dashLen = Math.max(1, Math.round(8 * (1 - c.uncertainty)));
    const shortName = c.id.split('.').slice(-1)[0] ?? c.id;
    parts.push(`<g>
      <title>${esc(c.id)} — generation ${c.generation} · pressure ${Math.round(c.workspacePressure * 100)}% · energy ${Math.round(c.energy.current * 100)}% · uncertainty ${Math.round(c.uncertainty * 100)}%</title>
      <circle cx="${x}" cy="${cy}" r="${(r * 0.28).toFixed(1)}" fill="#5fb3a1" opacity="${(0.12 + 0.7 * c.energy.current).toFixed(2)}"/>
      ${spokes}
      <circle cx="${x}" cy="${cy}" r="${r.toFixed(1)}" fill="none" stroke="${ring}" stroke-width="2.2" opacity="0.95"/>
      <circle cx="${x}" cy="${cy}" r="${(r + 5).toFixed(1)}" fill="none" stroke="#5b6478" stroke-width="1" stroke-dasharray="${dashLen} ${Math.max(2, 10 - dashLen)}" opacity="${(0.2 + 0.45 * c.uncertainty).toFixed(2)}"/>
      <text x="${x}" y="${cy + r + 24}" text-anchor="middle" class="cellname-svg">${esc(shortName)}</text>
      <text x="${x}" y="${cy + r + 40}" text-anchor="middle" class="cellstate-svg">${esc(stateWords(c, maxGen))}</text>
    </g>`);
  }

  const dreamed = records.some((r) => r.category === 'lobe' && r.payload['dream'] !== undefined);
  if (dreamed) parts.push(`<path d="M ${W - 30} 24 a 11 11 0 1 0 9 17 a 8.5 8.5 0 1 1 -9 -17" fill="#c795f0" opacity="0.9"/>`);

  return `<figure class="bodyfig"><svg viewBox="0 0 ${W} ${H}" class="body" role="img">${parts.join('')}</svg>
  <figcaption>his body, live — size is wear, glow is energy, ring heat is pressure, the spokes are his actual state; hover anything for the numbers</figcaption></figure>`;
}

function renderIndividual(spec: IndividualSpec): string {
  const ledgerPath = join(spec.stateDir, 'seed-ledger.jsonl');
  const records = tail(ledgerPath);
  const ck = newestCheckpoint(spec.stateDir);
  if (records.length === 0 && ck === null) {
    return `<section class="card"><h2>${esc(spec.name)}</h2><p class="muted">no state visible at ${esc(spec.stateDir)}</p></section>`;
  }
  const last = records[records.length - 1];
  const headSeq = Number(last?.seq ?? ck?.['ledgerSeq'] ?? 0);
  const cells = (ck?.['cells'] ?? []) as Array<{
    id: string; generation: number; workspacePressure: number; uncertainty: number;
    energy: { current: number };
    continuousState?: string; continuousStateDimension?: number;
    associations?: Array<{ targetCellId: string; strength: number }>;
    realityRefs?: Array<{ sourceRef: string; observedAt: string; head?: string }>;
    predictions: Array<{ claim: string; horizon: string; resolvedAt?: string; error?: number }>;
    estimates: Array<{ claim: string; confidence: number }>;
  }>;

  // ── The being line: born, lived, slept, dreamed, earned — human units ──
  let born = '';
  try {
    const genesis = readSeedGenesis(spec.stateDir);
    if (genesis !== null) born = new Date(genesis.bornAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  } catch { /* young pages omit */ }
  const sleeps = records.filter((r) => r.category === 'development' && r.payload['rule'] === 'consolidation.v1').length;
  const dreams = records.filter((r) => r.category === 'lobe' && r.payload['dream'] !== undefined).length;
  let factCount = 0;
  try {
    const facts = composeLivedFacts(spec.stateDir);
    if (facts !== null) factCount = facts.split('\n').filter((l) => l.startsWith('- ')).length;
  } catch { /* none */ }
  const beingBits = [
    born !== '' ? `born ${born}` : null,
    `${headSeq.toLocaleString()} events lived`,
    sleeps > 0 ? `${sleeps} sleep${sleeps === 1 ? '' : 's'} in window` : 'has not slept in this window',
    dreams > 0 ? `${dreams} dream${dreams === 1 ? '' : 's'} 🌙` : 'no dreams yet',
    factCount > 0 ? `${factCount} earned fact${factCount === 1 ? '' : 's'}` : null,
  ].filter(Boolean).join(' · ');

  const ageMs = last?.issuedAt !== undefined ? Date.now() - Date.parse(last.issuedAt) : Infinity;
  const awake = ageMs < 40 * 60_000;
  const statusChip = `<span class="chip ${awake ? 'chip-awake' : 'chip-quiet'}">${awake ? '● awake' : '○ quiet'} · last event ${age(last?.issuedAt)}</span>`;

  // ── Last exchange: the actual words ──
  const convRefs = cells.flatMap((c) => c.realityRefs ?? [])
    .filter((r) => typeof r.head === 'string' && r.head.length > 0 && r.sourceRef.startsWith('conversation.'))
    .sort((a, b) => a.observedAt.localeCompare(b.observedAt))
    .slice(-3);
  const exchange = convRefs.length > 0
    ? `<div class="sect"><div class="sectlabel">last exchange</div>${convRefs.map((r) => {
        const who = r.sourceRef.startsWith('conversation.jtr') ? 'jtr' : esc(spec.name.replace('-seed', ''));
        return `<div class="chatline ${who === 'jtr' ? 'from-jtr' : 'from-agent'}"><span class="who">${who}</span>${esc((r.head ?? '').slice(0, 160))}</div>`;
      }).join('')}</div>`
    : '';

  // ── Latest thought (or dream) in his words ──
  const lobes = records.filter((r) => r.category === 'lobe' && r.payload['error'] === undefined);
  const lastLobe = lobes[lobes.length - 1];
  let thought = '';
  if (lastLobe !== undefined) {
    const deltas = (lastLobe.payload['appliedDeltas'] as Array<{ field?: string; delta?: { claim?: string } }> | undefined) ?? [];
    const claim = deltas.map((d) => d.delta?.claim).find((c) => typeof c === 'string');
    const isDream = lastLobe.payload['dream'] !== undefined;
    if (typeof claim === 'string') {
      thought = `<div class="sect"><div class="sectlabel">${isDream ? '🌙 dreamed at waking' : 'latest thought'}</div><blockquote class="thought">${esc(claim.slice(0, 240))}</blockquote><div class="prov">${age(lastLobe.issuedAt)}</div></div>`;
    } else if (isDream) {
      thought = `<div class="sect"><div class="sectlabel">🌙 dreamed at waking</div><div class="muted">the dream landed no new beliefs — the residue settled quietly</div></div>`;
    }
  }

  // ── Reality's answers + open record, as pills ──
  const openPreds = cells.flatMap((c) => c.predictions.filter((p) => p.resolvedAt === undefined));
  const resolvedPreds = cells.flatMap((c) => c.predictions.filter((p) => p.resolvedAt !== undefined && typeof p.error === 'number'));
  const record = (openPreds.length + resolvedPreds.length) > 0
    ? `<div class="sect"><div class="sectlabel">the record</div><div class="pills">${
        resolvedPreds.slice(-3).map((p) => {
          const cls = (p.error ?? 1) <= 0.3 ? 'pill-right' : (p.error ?? 0) >= 0.7 ? 'pill-wrong' : 'pill-partial';
          const mark = (p.error ?? 1) <= 0.3 ? '✓' : (p.error ?? 0) >= 0.7 ? '✗' : '≈';
          return `<span class="pill ${cls}" title="error ${p.error?.toFixed(2)}">${mark} ${esc(p.claim.slice(0, 64))}</span>`;
        }).join('')
      }${openPreds.slice(0, 2).map((p) => `<span class="pill pill-open" title="horizon ${esc(p.horizon)}">… ${esc(p.claim.slice(0, 64))}</span>`).join('')}</div></div>`
    : '';

  // ── Growth ──
  const proposals = records.filter((r) => r.category === 'proposal' && r.sourceRef === 'growth.pressure');
  const applications = records.filter((r) => r.category === 'act' && r.payload['growthApplication'] === true);
  const growthBlock = applications.length > 0
    ? `<div class="grown">🌱 grew ${applications.length} organ(s): ${applications.map((a) => `<b>${esc(String(a.payload['newCellId']))}</b>`).join(', ')}</div>`
    : (proposals.length > 0
      ? `<div class="proposals">his growth pressure holds ${proposals.length} proposal(s) — latest wants to <b>${esc(String(proposals[proposals.length - 1]?.payload['op']))}</b> ${esc(String((proposals[proposals.length - 1]?.payload['targetCellIds'] as string[] | undefined)?.join(' + ') ?? ''))}</div>`
      : '');

  // ── Tiny provenance footer — the only monospace on the card ──
  const dev = records.filter((r) => r.category === 'development');
  const byRule = new Map<string, number>();
  for (const d of dev) byRule.set(String(d.payload['rule'] ?? 'other').replace('.v1', ''), (byRule.get(String(d.payload['rule'] ?? 'other').replace('.v1', '')) ?? 0) + 1);
  const chainBytes = existsSync(ledgerPath) ? statSync(ledgerPath).size : 0;
  const prov = `chain seq ${headSeq} · ${(chainBytes / 1024).toFixed(0)} KB · window: ${[...byRule.entries()].map(([r, n]) => `${r} ×${n}`).join(' · ') || 'no development'}`;

  return `<section class="card">
    <div class="cardhead"><h2>${esc(spec.name)}</h2>${statusChip}</div>
    <div class="being">${beingBits}</div>
    ${spec.note !== undefined ? `<div class="note">${esc(spec.note)}</div>` : ''}
    ${growthBlock}
    ${renderBodySVG(cells, records)}
    <div class="prose">${exchange}${thought}${record}</div>
    <div class="prov">${esc(prov)}</div>
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
    ['Identity — constitution (SOUL)', 'FILE <span class="dim">by design — authored, jtr\'s voice; a constitution should be a document</span>'],
    ['Identity — biography (who he has become)', (() => {
      const j = specs.find((s) => s.name.toLowerCase().includes('jerry'));
      try {
        if (j !== undefined && composeLivedIdentity(j.stateDir) !== null) {
          return '<b class="cells-own">CELLS</b> <span class="dim">— composed from the chain in his own first person; cannot be edited, only lived further</span>';
        }
      } catch { /* FILE stands */ }
      return 'FILE <span class="dim">(no chain to compose from)</span>';
    })()],
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
    ['Facts (infrastructure: TOPOLOGY)', (() => {
      // Auto-flipping parity probe: the row goes green the day his
      // fact-grade conclusions carry infrastructure (ports, services,
      // URLs) — earned, never declared.
      const j = specs.find((s) => s.name.toLowerCase().includes('jerry'));
      try {
        if (j !== undefined) {
          const facts = composeLivedFacts(j.stateDir);
          const infra = facts === null ? 0 : facts.split('\n').filter((l) => l.startsWith('- ') && /port|:\d{4}|http|url|endpoint|service|localhost|dashboard/i.test(l)).length;
          if (infra >= 3) return `<b class="cells-own">CELLS</b> <span class="dim">— ${infra} infrastructure facts earned fact-grade (parity reached)</span>`;
          return `FILE <span class="dim">— parity ${infra}/3: auto-flips when his conclusions carry infrastructure at fact-grade</span>`;
        }
      } catch { /* FILE stands */ }
      return 'FILE <span class="dim">— until estimate parity</span>';
    })()],
    ['Owner (PERSONAL) / rules (DOCTRINE)', 'FILE <span class="dim">by design — jtr\'s voice; cut last or never</span>'],
    ['Attention triggers', '<b class="cells-own">CELLS</b> <span class="dim">— gates fire on meaning through the retina (calibrated floor); substring only as degraded fallback</span>'],
    ['Engine cognition grounding', (() => {
      const j = specs.find((s) => s.name.toLowerCase().includes('jerry'));
      try {
        if (j !== undefined) {
          const lived = composeLivedState(j.stateDir);
          if (lived !== null) return `<b class="cells-own">CELLS</b> <span class="dim">— engine thinking cycles ground in the lived chain (${lived.length} chars composing now)</span>`;
        }
      } catch { /* FILE stands */ }
      return 'FILE <span class="dim">(no lived state composing — engine thinks from brain alone)</span>';
    })()],
    ['Memory objects (deliberate promotions)', (() => {
      const j = specs.find((s) => s.name.toLowerCase().includes('jerry'));
      try {
        if (j !== undefined) {
          const events = join(j.stateDir, '..', '..', 'brain', 'memory-objects.events.jsonl');
          if (existsSync(events)) {
            const n = readFileSync(events, 'utf-8').trim().split('\n').filter(Boolean).length;
            return `<b class="cells-own">CELLS</b> <span class="dim">— promotions teach the chain (${n} taught); the living pipeline replaced candidate→durable, which had promoted 0 of 2500; JSON store demoted to recall cache</span>`;
          }
        }
      } catch { /* FILE stands */ }
      return 'FILE <span class="dim">(no promotion events yet)</span>';
    })()],
    ['Cognition mode', '<b class="cells-own">thinking_machine</b> <span class="dim">— legacy_roles retired 2026-08-09 ("we don\'t want legacy anything"); 4-phase pipeline, lived-chain grounded</span>'],
    ['Sleep & dreaming', (() => {
      const j = specs.find((s) => s.name.toLowerCase().includes('jerry'));
      let seedHalf = 'first dream pending (fires at his next waking after a quiet gap)';
      try {
        if (j !== undefined) {
          const raw = readFileSync(join(j.stateDir, 'seed-ledger.jsonl'), 'utf-8');
          const tail = raw.slice(-262144);
          const dreams = tail.split('\n').filter((l) => l.includes('"category":"lobe"') && l.includes('"dream"')).length;
          if (dreams > 0) seedHalf = `${dreams} dream(s) receipted on the chain`;
        }
      } catch { /* pending stands */ }
      return `<b class="cells-own">CELLS</b> <span class="dim">— NREM (consolidation.v1, knife-proven) + REM (dream.v1: the mind works the residue at waking; ${seedHalf}); engine dreams now recombine the lived day's residue — the chain→brain transfer bridge</span>`;
    })()],
  ];
  const owned = rows.filter(([, o]) => o.includes('cells-own')).length;
  return `<section class="card boardcard"><details><summary>v2 migration — <b>${owned} of ${rows.length}</b> functions owned by the individuals (expand for the board)</summary>
  <table class="cells">${rows.map(([fn, owner]) => `<tr><td class="cellname">${fn}</td><td>${owner}</td></tr>`).join('')}</table>
  </details></section>`;
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
  * { box-sizing: border-box; }
  body { background:#0a0d12; color:#cfd6e0; font: 15px/1.65 system-ui, -apple-system, "Segoe UI", sans-serif; margin:0; padding:28px 20px 40px; max-width:1080px; margin-inline:auto; }
  h1 { font-size:20px; font-weight:650; color:#eef2f7; letter-spacing:.01em; margin:0 0 2px; }
  .pagesub { color:#7d8798; font-size:13px; margin-bottom:22px; }
  .card { background:#11151d; border:1px solid #1d2330; border-radius:16px; padding:22px 24px; margin:18px 0; }
  .cardhead { display:flex; align-items:baseline; gap:14px; flex-wrap:wrap; }
  .card h2 { margin:0; font-size:22px; font-weight:650; color:#eef2f7; }
  .chip { font-size:12px; padding:3px 10px; border-radius:999px; border:1px solid #263043; color:#93a0b4; }
  .chip-awake { color:#69d58c; border-color:#1f4030; }
  .chip-quiet { color:#7d8798; }
  .being { font-size:15px; color:#aeb9c9; margin-top:8px; }
  .note { font-size:13px; color:#68738a; margin-top:2px; font-style:italic; }
  .bodyfig { margin:16px 0 6px; }
  svg.body { width:100%; height:auto; display:block; background:#0b0f16; border-radius:12px; }
  .bodyfig figcaption { font-size:12px; color:#5f6a7d; margin-top:6px; }
  .cellname-svg { fill:#cfd6e0; font-size:12px; font-weight:600; }
  .cellstate-svg { fill:#7d8798; font-size:10.5px; }
  .prose { display:grid; grid-template-columns:1fr 1fr; gap:6px 28px; margin-top:10px; }
  @media (max-width:760px) { .prose { grid-template-columns:1fr; } }
  .sect { margin:10px 0; }
  .sectlabel { font-size:11px; letter-spacing:.14em; text-transform:uppercase; color:#68738a; margin-bottom:7px; }
  .chatline { padding:7px 12px; margin:5px 0; border-radius:10px; background:#151b26; font-size:14px; }
  .chatline .who { font-weight:650; margin-right:8px; font-size:12px; }
  .from-jtr { border-left:3px solid #69d58c; } .from-jtr .who { color:#69d58c; }
  .from-agent { border-left:3px solid #6cb2f5; } .from-agent .who { color:#6cb2f5; }
  blockquote.thought { margin:0; padding:10px 14px; border-left:3px solid #c795f0; background:#151b26; border-radius:10px; font-size:14.5px; color:#d7dde6; }
  .pills { display:flex; flex-wrap:wrap; gap:7px; }
  .pill { font-size:12.5px; padding:5px 11px; border-radius:999px; background:#151b26; border:1px solid #232c3d; color:#aeb9c9; }
  .pill-right { border-color:#1f4030; color:#69d58c; }
  .pill-wrong { border-color:#4a2020; color:#e0653a; }
  .pill-partial { border-color:#443a1e; color:#e0a458; }
  .pill-open { border-style:dashed; }
  .grown { background:#0f2318; border:1px solid #1f4030; border-radius:10px; padding:9px 14px; margin:12px 0 4px; color:#69d58c; font-size:14px; }
  .proposals { background:#231d10; border:1px solid #443a1e; border-radius:10px; padding:9px 14px; margin:12px 0 4px; color:#e0a458; font-size:14px; }
  .prov { color:#525b6b; font-size:11.5px; font-family:ui-monospace, SFMono-Regular, Menlo, monospace; margin-top:14px; }
  .muted { color:#68738a; }
  table.cells { border-collapse:collapse; width:100%; }
  table.cells td { padding:6px 12px 6px 0; font-size:13.5px; color:#aeb9c9; border-top:1px solid #1a202c; }
  .cellname { color:#cfd6e0; }
  .cells-own { color:#69d58c; } .partial { color:#e0a458; } .dim { color:#68738a; } .tiny { font-size:11px; color:#68738a; }
  .bar { display:inline-block; width:110px; height:7px; background:#1a202c; border-radius:4px; overflow:hidden; vertical-align:middle; }
  .bar div { height:100%; }
  .journal pre { white-space:pre-wrap; background:#0b0f16; border-radius:12px; padding:16px 18px; font:13.5px/1.6 system-ui, sans-serif; color:#bfc8d4; }
  .boardcard summary { cursor:pointer; font-size:14px; color:#93a0b4; }
  .boardcard summary b { color:#69d58c; }
  footer { color:#525b6b; font-size:12px; margin:22px 6px; }
  .ref { color:#6cb2f5; } .ev { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .stream { margin-top:8px; }
</style></head><body>
<h1>the terrarium</h1>
<div class="pagesub">four individuals, read live from their chains · nothing here is state — looking changes nothing · refreshes every 30s</div>
${body}
${renderCutover()}
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
