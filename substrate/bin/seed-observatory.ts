/**
 * seed-observatory — the terrarium. A live window into the individuals.
 *
 *   OBSERVATORY_PORT (default 5050)
 *   OBSERVATORY_INDIVIDUALS — JSON: [{name, stateDir, formsDir?, note?}, …]
 *
 * A tiny read-only HTTP server, zero external dependencies. `/` serves a
 * self-contained live page; `/api/terrarium` serves the composed state as
 * JSON. The client polls every 5s and animates — no page refresh, ever:
 * bodies breathe with their actual energy, state fingerprints morph as the
 * real Float32 vectors change, new transitions arrive as particles flowing
 * into the cell that ate them, a click opens what a cell actually holds,
 * and a dream rises as an event.
 *
 * Honesty rules unchanged: every visual channel is a real number; the
 * observatory never sshes, never writes, never touches a seed. Reading this
 * page changes nothing.
 */

import { createServer } from 'node:http';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
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

// ─── Composition: one individual → plain data (the client animates it) ──────

interface CellData {
  id: string; short: string; gen: number; pressure: number; energy: number;
  uncertainty: number; state: number[]; words: string;
  estimates: Array<{ claim: string; conf: number }>;
  open: Array<{ claim: string; horizon: string }>;
  refs: Array<{ who: string; head: string }>;
}
interface IndividualData {
  name: string; note: string;
  awake: boolean; lastEventAt: string | null; being: string;
  cells: CellData[]; assoc: Array<{ from: string; to: string; strength: number }>;
  flows: Array<{ seq: number; ref: string; target: string }>;
  maxGen: number; dreamed: boolean;
  exchange: Array<{ who: string; text: string }>;
  thought: { text: string; dream: boolean; at: string } | null;
  record: Array<{ mark: 'right' | 'wrong' | 'partial' | 'open'; text: string; detail: string }>;
  growth: string | null; prov: string; journal: string | null;
  /** Cut 6: motor reaches to jtr (outbox tail — the operator's channel). */
  asks: Array<{ message: string; at: string }>;
  /** Cut 6: open commitments — what the individual is bound to resolve. */
  commitments: Array<{ claim: string; due: string; presses: number }>;
}

function stateWordsOf(gen: number, pressure: number, energy: number, uncertainty: number, maxGen: number): string {
  const words: string[] = [];
  words.push(gen >= Math.max(5, maxGen * 0.5) ? 'worn' : gen < 5 ? 'young' : 'lived-in');
  if (pressure > 0.45) words.push('pressurized');
  else if (energy > 0.7) words.push('bright');
  else if (pressure < 0.12 && energy < 0.35) words.push('resting');
  else words.push('calm');
  if (uncertainty > 0.6) words.push('unsettled');
  return words.slice(0, 2).join(' · ');
}

function computeIndividual(spec: IndividualSpec): IndividualData | null {
  const ledgerPath = join(spec.stateDir, 'seed-ledger.jsonl');
  const records = tail(ledgerPath);
  const ck = newestCheckpoint(spec.stateDir);
  if (records.length === 0 && ck === null) return null;

  const last = records[records.length - 1];
  const headSeq = Number(last?.seq ?? ck?.['ledgerSeq'] ?? 0);
  const rawCells = (ck?.['cells'] ?? []) as Array<Record<string, unknown>>;
  const maxGen = Math.max(...rawCells.map((c) => Number(c['generation'] ?? 0)), 1);

  const cells: CellData[] = rawCells.map((c) => {
    let state: number[] = [];
    if (typeof c['continuousState'] === 'string') {
      try {
        const buf = Buffer.from(c['continuousState'] as string, 'base64');
        const dim = Number(c['continuousStateDimension'] ?? Math.floor(buf.length / 4));
        state = Array.from(new Float32Array(buf.buffer, buf.byteOffset, dim)).map((v) => Number(v.toFixed(4)));
      } catch { /* coreless — honest */ }
    }
    const energy = Number((c['energy'] as { current?: number } | undefined)?.current ?? 0);
    const gen = Number(c['generation'] ?? 0);
    const pressure = Number(c['workspacePressure'] ?? 0);
    const uncertainty = Number(c['uncertainty'] ?? 0.5);
    const preds = (c['predictions'] ?? []) as Array<{ claim: string; horizon: string; resolvedAt?: string }>;
    const refs = ((c['realityRefs'] ?? []) as Array<{ sourceRef: string; observedAt?: string; head?: string }>)
      .filter((r) => typeof r.head === 'string' && r.head.length > 0)
      .slice(-5)
      .map((r) => ({
        who: r.sourceRef.startsWith('conversation.jtr') ? 'jtr'
          : r.sourceRef.startsWith('conversation.') ? 'self'
          : r.sourceRef.startsWith('house.') ? 'house'
          : r.sourceRef.startsWith('relationship.') ? 'teaching' : 'lived',
        head: (r.head ?? '').slice(0, 120),
      }));
    return {
      id: String(c['id'] ?? '?'),
      short: String(c['id'] ?? '?').split('.').slice(-1)[0] ?? '?',
      gen, pressure, energy, uncertainty, state,
      words: stateWordsOf(gen, pressure, energy, uncertainty, maxGen),
      estimates: ((c['estimates'] ?? []) as Array<{ claim: string; confidence: number }>)
        .slice(-4).map((e) => ({ claim: e.claim.slice(0, 140), conf: e.confidence })),
      open: preds.filter((p) => p.resolvedAt === undefined).slice(0, 3).map((p) => ({ claim: p.claim.slice(0, 120), horizon: p.horizon })),
      refs,
    };
  });

  const assoc: IndividualData['assoc'] = [];
  rawCells.forEach((c) => {
    for (const a of (c['associations'] ?? []) as Array<{ targetCellId: string; strength: number }>) {
      assoc.push({ from: String(c['id']), to: a.targetCellId, strength: a.strength });
    }
  });

  const flows = records.filter((r) => r.category === 'transition').slice(-24)
    .map((r) => ({ seq: r.seq, ref: r.sourceRef.slice(0, 90), target: String(r.payload['targetCellId'] ?? '') }));

  // Being line — human units, every clause real.
  let born = '';
  try {
    const genesis = readSeedGenesis(spec.stateDir);
    if (genesis !== null) born = new Date(genesis.bornAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  } catch { /* omit */ }
  const sleeps = records.filter((r) => r.category === 'development' && r.payload['rule'] === 'consolidation.v1').length;
  const dreams = records.filter((r) => r.category === 'lobe' && r.payload['dream'] !== undefined).length;
  let factCount = 0;
  try {
    const facts = composeLivedFacts(spec.stateDir);
    if (facts !== null) factCount = facts.split('\n').filter((l) => l.startsWith('- ')).length;
  } catch { /* none */ }
  const being = [
    born !== '' ? `born ${born}` : null,
    `${headSeq.toLocaleString()} events lived`,
    sleeps > 0 ? `${sleeps} sleep${sleeps === 1 ? '' : 's'} in window` : 'no sleep in this window',
    dreams > 0 ? `${dreams} dream${dreams === 1 ? '' : 's'} 🌙` : 'no dreams yet',
    factCount > 0 ? `${factCount} earned fact${factCount === 1 ? '' : 's'}` : null,
  ].filter(Boolean).join(' · ');

  // Exchange reads the conversation STREAM (the authority) — cell ref
  // windows are capped and hours of telemetry evict the words; the stream
  // always holds the last real exchange, however old. Honest absence when
  // the individual has no conversation stream (bobby, clay).
  let exchange: IndividualData['exchange'] = [];
  try {
    const streamPath = join(spec.stateDir, '..', 'conversation-stream.jsonl');
    if (existsSync(streamPath)) {
      let raw = readFileSync(streamPath, 'utf-8');
      if (raw.length > 65536) raw = raw.slice(-65536);
      const turns: Array<{ ts: string; role: string; text: string }> = [];
      for (const line of raw.split('\n')) {
        if (line.trim() === '') continue;
        try {
          const t = JSON.parse(line) as { ts?: string; role?: string; text?: string };
          if (typeof t.ts === 'string' && typeof t.text === 'string' && (t.role === 'user' || t.role === 'assistant')) {
            turns.push({ ts: t.ts, role: t.role, text: t.text });
          }
        } catch { /* torn */ }
      }
      turns.sort((a, b) => a.ts.localeCompare(b.ts));
      exchange = turns.slice(-3).map((t) => ({
        who: t.role === 'user' ? 'jtr' : spec.name.replace('-seed', ''),
        text: t.text.slice(0, 150),
      }));
    }
  } catch { /* absence over fabrication */ }

  const lobes = records.filter((r) => r.category === 'lobe' && r.payload['error'] === undefined);
  const lastLobe = lobes[lobes.length - 1];
  let thought: IndividualData['thought'] = null;
  if (lastLobe !== undefined) {
    const deltas = (lastLobe.payload['appliedDeltas'] as Array<{ delta?: { claim?: string } }> | undefined) ?? [];
    const claim = deltas.map((d) => d.delta?.claim).find((c) => typeof c === 'string');
    if (typeof claim === 'string') {
      thought = { text: claim.slice(0, 260), dream: lastLobe.payload['dream'] !== undefined, at: lastLobe.issuedAt };
    }
  }

  const record: IndividualData['record'] = [];
  for (const c of rawCells) {
    for (const p of (c['predictions'] ?? []) as Array<{ claim: string; horizon: string; resolvedAt?: string; error?: number }>) {
      if (p.resolvedAt !== undefined && typeof p.error === 'number') {
        record.push({
          mark: p.error <= 0.3 ? 'right' : p.error >= 0.7 ? 'wrong' : 'partial',
          text: p.claim.slice(0, 70), detail: `error ${p.error.toFixed(2)}`,
        });
      } else if (p.resolvedAt === undefined) {
        record.push({ mark: 'open', text: p.claim.slice(0, 70), detail: `horizon ${p.horizon}` });
      }
    }
  }

  const proposals = records.filter((r) => r.category === 'proposal' && r.sourceRef === 'growth.pressure');
  const applications = records.filter((r) => r.category === 'act' && r.payload['growthApplication'] === true);
  const growth = applications.length > 0
    ? `🌱 grew ${applications.length} organ(s): ${applications.map((a) => String(a.payload['newCellId'])).join(', ')}`
    : proposals.length > 0
      ? `his growth pressure holds ${proposals.length} proposal(s) — latest wants to ${String(proposals[proposals.length - 1]?.payload['op'])} ${((proposals[proposals.length - 1]?.payload['targetCellIds'] as string[] | undefined) ?? []).join(' + ')}`
      : null;

  const dev = records.filter((r) => r.category === 'development');
  const byRule = new Map<string, number>();
  for (const d of dev) byRule.set(String(d.payload['rule'] ?? 'other').replace('.v1', ''), (byRule.get(String(d.payload['rule'] ?? 'other').replace('.v1', '')) ?? 0) + 1);
  const chainBytes = existsSync(ledgerPath) ? statSync(ledgerPath).size : 0;
  const prov = `chain seq ${headSeq} · ${(chainBytes / 1024).toFixed(0)} KB · window: ${[...byRule.entries()].map(([r, n]) => `${r} ×${n}`).join(' · ') || 'no development'}`;

  let journal: string | null = null;
  if (spec.formsDir !== undefined) {
    const latest = join(spec.formsDir, 'journal', 'LATEST.md');
    if (existsSync(latest)) {
      try { journal = readFileSync(latest, 'utf-8').slice(0, 4000); } catch { /* omit */ }
    }
  }

  // Cut 6: the motor's reaches (outbox = the operator's channel) and the
  // open commitments (from the checkpoint's concern state). Every value real;
  // absence is honest absence.
  let asks: IndividualData['asks'] = [];
  try {
    const outboxPath = join(spec.stateDir, 'outbox.jsonl');
    if (existsSync(outboxPath)) {
      asks = readFileSync(outboxPath, 'utf-8').trim().split('\n')
        .map((l) => { try { return JSON.parse(l) as { message?: string; dispatchedAt?: string }; } catch { return null; } })
        .filter((x): x is { message: string; dispatchedAt: string } => typeof x?.message === 'string' && typeof x?.dispatchedAt === 'string')
        .slice(-2)
        .map((x) => ({ message: x.message.slice(0, 300), at: x.dispatchedAt }));
    }
  } catch { /* honest absence */ }
  let commitments: IndividualData['commitments'] = [];
  try {
    const concern = (ck?.['concern'] ?? {}) as Record<string, { claim?: string; dueAt?: string; status?: string; crossings?: number }>;
    commitments = Object.values(concern)
      .filter((c) => c.status === 'open' && typeof c.claim === 'string')
      .slice(0, 4)
      .map((c) => ({ claim: (c.claim ?? '').slice(0, 140), due: c.dueAt ?? '', presses: c.crossings ?? 0 }));
  } catch { /* honest absence */ }

  const ageMs = last?.issuedAt !== undefined ? Date.now() - Date.parse(last.issuedAt) : Infinity;
  return {
    name: spec.name, note: spec.note ?? '',
    awake: ageMs < 40 * 60_000, lastEventAt: last?.issuedAt ?? null,
    being: commitments.length > 0
      ? `${being} · holds ${commitments.length} commitment${commitments.length === 1 ? '' : 's'}`
      : being,
    cells, assoc, flows, maxGen,
    dreamed: dreams > 0, exchange, thought, record: record.slice(-5), growth, prov, journal,
    asks, commitments,
  };
}

// ─── The cutover board (server-rendered; builder detail, collapsed) ─────────

function boardRows(): Array<[string, boolean, string]> {
  const j = specs.find((s) => s.name.toLowerCase().includes('jerry'));
  const probe = <T,>(fn: () => T | null): T | null => { try { return fn(); } catch { return null; } };
  const lived = j !== undefined ? probe(() => composeLivedRecent(j.stateDir)) : null;
  const now = j !== undefined ? probe(() => composeSeedNow(j.stateDir)) : null;
  const facts = j !== undefined ? probe(() => composeLivedFacts(j.stateDir)) : null;
  const bio = j !== undefined ? probe(() => composeLivedIdentity(j.stateDir)) : null;
  const engine = j !== undefined ? probe(() => composeLivedState(j.stateDir)) : null;
  const houseStream = j !== undefined && existsSync(join(j.stateDir, '..', 'house-stream.jsonl'));
  const memEvents = j !== undefined && existsSync(join(j.stateDir, '..', '..', 'brain', 'memory-objects.events.jsonl'));
  const infra = facts === null ? 0 : facts.split('\n').filter((l) => l.startsWith('- ') && /port|:\d{4}|http|url|endpoint|service|localhost|dashboard/i.test(l)).length;
  const dreamedOnChain = j !== undefined && probe(() => {
    const raw = readFileSync(join(j.stateDir, 'seed-ledger.jsonl'), 'utf-8').slice(-262144);
    return raw.split('\n').some((l) => l.includes('"category":"lobe"') && l.includes('"dream"')) ? true : null;
  }) === true;
  // Cut 6 probes: concern formed on the chain; an endogenous crossing lived.
  const concernOnChain = j !== undefined && probe(() => {
    const raw = readFileSync(join(j.stateDir, 'seed-ledger.jsonl'), 'utf-8').slice(-262144);
    return raw.split('\n').some((l) => l.includes('"category":"concern"')) ? true : null;
  }) === true;
  const crossedOnChain = j !== undefined && probe(() => {
    const raw = readFileSync(join(j.stateDir, 'seed-ledger.jsonl'), 'utf-8').slice(-262144);
    return raw.split('\n').some((l) => l.includes('"crossing":true')) ? true : null;
  }) === true;
  return [
    ['Recent memory', lived !== null, lived !== null ? 'composed from the chain at read time' : 'file fallback'],
    ['Turn expression', true, 'match-only surfacing of lived facts'],
    ['Conversation intake', true, 'life-feed shipper → seed diet, words + meaning'],
    ['House senses', houseStream, houseStream ? 'home transitions enter the chain' : 'no house stream'],
    ['Teaching channel', true, 'corrections develop state, words attached'],
    ['Session grounding (lived NOW)', now !== null, now !== null ? 'sessions open on the lived now' : 'seed silent'],
    ['Machine snapshot (NOW.md)', false, 'cron telemetry — file by design until estimate parity'],
    ['Identity — constitution (SOUL)', false, "authored, jtr's voice — a constitution should be a document"],
    ['Identity — biography', bio !== null, bio !== null ? 'composed in his own first person' : 'no chain'],
    ['Facts (lived conclusions)', facts !== null, facts !== null ? 'beliefs that earned fact-grade' : 'nothing earned yet'],
    ['Facts (infrastructure: TOPOLOGY)', infra >= 3, infra >= 3 ? `${infra} infrastructure facts earned` : `parity ${infra}/3 — auto-flips when earned`],
    ['Owner (PERSONAL) / rules (DOCTRINE)', false, "jtr's voice — cut last or never"],
    ['Attention triggers', true, 'gates fire on meaning; substring only as fallback'],
    ['Engine cognition grounding', engine !== null, engine !== null ? 'cycles think from the lived chain' : 'engine thinks from brain alone'],
    ['Memory promotions', memEvents, memEvents ? 'promotions teach the chain' : 'no promotion events'],
    ['Cognition mode', true, 'thinking_machine — legacy retired'],
    ['Sleep & dreaming', true, dreamedOnChain ? 'NREM + REM — dreams on the chain' : 'NREM + REM — first dream pending'],
    ['Concern (commitments)', concernOnChain, concernOnChain ? 'his predictions bind — obligations on the chain' : 'Cut 6 live — first commitment pending'],
    ['Endogenous occasions', crossedOnChain, crossedOnChain ? 'his own physics originated a moment' : 'solver live — first crossing pending'],
  ];
}

function renderBoard(): string {
  const rows = boardRows();
  const owned = rows.filter(([, on]) => on).length;
  return `<section class="card boardcard"><details><summary>v2 migration — <b>${owned} of ${rows.length}</b> functions owned by the individuals</summary>
  <table class="cells">${rows.map(([fn, on, note]) => `<tr><td class="cellname">${esc(fn)}</td><td>${on ? '<span class="cells-own">●</span>' : '<span class="dim">○</span>'} <span class="dim">${esc(note)}</span></td></tr>`).join('')}</table>
  </details></section>`;
}

// ─── Client: the living page (vanilla, self-contained, every pixel real) ────

const CLIENT_JS = String.raw`
(function () {
  'use strict';
  var DATA = JSON.parse(document.getElementById('terrarium-data').textContent);
  function flowColor(ref) {
    if (ref.indexOf('conversation.') === 0) return '#69d58c';
    if (ref.indexOf('house.') === 0) return '#e6b450';
    if (ref.indexOf('worker.') === 0) return '#6cb2f5';
    if (ref.indexOf('relationship.') === 0) return '#c795f0';
    return '#525b6b';
  }
  var W = 960, H = 264, CY = 132;
  var svgNS = 'http://www.w3.org/2000/svg';

  function makeBody(container, ind) {
    var svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    container.appendChild(svg);
    var s = { svg: svg, ind: ind, centers: {}, spokeEls: {}, coreEls: {}, ringEls: {}, shown: {}, target: {}, particles: [], seenSeq: 0, t0: performance.now(), particleLayer: null };
    layout(s);
    for (var i = 0; i < ind.flows.length; i++) s.seenSeq = Math.max(s.seenSeq, ind.flows[i].seq);
    return s;
  }

  function indexOfCell(cells, id) {
    for (var i = 0; i < cells.length; i++) if (cells[i].id === id) return i;
    return -1;
  }

  function layout(s) {
    var svg = s.svg; svg.textContent = '';
    var cells = s.ind.cells, n = cells.length; if (n === 0) return;
    var slot = W / n, maxGen = s.ind.maxGen || 1;
    s.centers = {}; s.spokeEls = {}; s.coreEls = {}; s.ringEls = {};
    for (var a = 0; a < s.ind.assoc.length; a++) {
      var as = s.ind.assoc[a];
      var fi = indexOfCell(cells, as.from), ti = indexOfCell(cells, as.to);
      if (fi < 0 || ti < 0 || fi >= ti) continue;
      var ax1 = slot * (fi + 0.5), ax2 = slot * (ti + 0.5);
      var path = document.createElementNS(svgNS, 'path');
      path.setAttribute('d', 'M ' + ax1 + ' ' + CY + ' Q ' + ((ax1 + ax2) / 2) + ' ' + (CY - 76) + ' ' + ax2 + ' ' + CY);
      path.setAttribute('fill', 'none'); path.setAttribute('stroke', '#5b6478');
      path.setAttribute('stroke-width', String(0.6 + 2 * as.strength));
      path.setAttribute('opacity', String(0.18 + 0.45 * as.strength));
      svg.appendChild(path);
    }
    for (var i = 0; i < n; i++) {
      var c = cells[i];
      var x = slot * (i + 0.5);
      var r = 20 + 36 * Math.sqrt(Math.log(c.gen + 2) / Math.log(maxGen + 2));
      s.centers[c.id] = { x: x, r: r };
      s.shown[c.id] = (c.state || []).slice();
      s.target[c.id] = (c.state || []).slice();
      var g = document.createElementNS(svgNS, 'g');
      g.setAttribute('class', 'cellg');
      var title = document.createElementNS(svgNS, 'title');
      title.textContent = c.id + ' — generation ' + c.gen + ' · pressure ' + Math.round(c.pressure * 100) + '% · energy ' + Math.round(c.energy * 100) + '% · uncertainty ' + Math.round(c.uncertainty * 100) + '%';
      g.appendChild(title);
      var core = document.createElementNS(svgNS, 'circle');
      core.setAttribute('cx', x); core.setAttribute('cy', CY); core.setAttribute('fill', '#5fb3a1');
      g.appendChild(core); s.coreEls[c.id] = core;
      var spokes = [];
      for (var k = 0; k < (c.state || []).length; k++) {
        var ln = document.createElementNS(svgNS, 'line');
        ln.setAttribute('stroke-width', '1');
        g.appendChild(ln); spokes.push(ln);
      }
      s.spokeEls[c.id] = spokes;
      var ring = document.createElementNS(svgNS, 'circle');
      ring.setAttribute('cx', x); ring.setAttribute('cy', CY); ring.setAttribute('r', r);
      ring.setAttribute('fill', 'none'); ring.setAttribute('stroke-width', '2.2');
      g.appendChild(ring); s.ringEls[c.id] = ring;
      var halo = document.createElementNS(svgNS, 'circle');
      halo.setAttribute('cx', x); halo.setAttribute('cy', CY); halo.setAttribute('r', r + 5);
      halo.setAttribute('fill', 'none'); halo.setAttribute('stroke', '#5b6478'); halo.setAttribute('stroke-width', '1');
      var dashLen = Math.max(1, Math.round(8 * (1 - c.uncertainty)));
      halo.setAttribute('stroke-dasharray', dashLen + ' ' + Math.max(2, 10 - dashLen));
      halo.setAttribute('opacity', String(0.2 + 0.45 * c.uncertainty));
      g.appendChild(halo);
      var nameT = document.createElementNS(svgNS, 'text');
      nameT.setAttribute('x', x); nameT.setAttribute('y', CY + r + 24); nameT.setAttribute('text-anchor', 'middle');
      nameT.setAttribute('class', 'cellname-svg'); nameT.textContent = c.short;
      g.appendChild(nameT);
      var stateT = document.createElementNS(svgNS, 'text');
      stateT.setAttribute('x', x); stateT.setAttribute('y', CY + r + 40); stateT.setAttribute('text-anchor', 'middle');
      stateT.setAttribute('class', 'cellstate-svg'); stateT.textContent = c.words;
      g.appendChild(stateT);
      g.addEventListener('click', openDrawerFor(s, c.id));
      svg.appendChild(g);
    }
    s.particleLayer = document.createElementNS(svgNS, 'g');
    svg.appendChild(s.particleLayer);
  }

  function frame(s, now) {
    var cells = s.ind.cells;
    for (var i = 0; i < cells.length; i++) {
      var c = cells[i], ctr = s.centers[c.id];
      if (!ctr) continue;
      var breathe = 1 + 0.10 * c.energy * Math.sin((now - s.t0) / (2400 - 1200 * c.energy) + i * 1.7);
      var core = s.coreEls[c.id];
      if (core) {
        core.setAttribute('r', String(ctr.r * 0.28 * breathe));
        core.setAttribute('opacity', String(0.12 + 0.7 * c.energy));
      }
      var p = Math.min(1, c.pressure * 1.5);
      var ring = s.ringEls[c.id];
      if (ring) ring.setAttribute('stroke', p > 0.6 ? '#e0653a' : p > 0.3 ? '#e0a458' : '#3d4658');
      var shown = s.shown[c.id], target = s.target[c.id], spokes = s.spokeEls[c.id];
      if (!shown || !spokes || !target) continue;
      var maxAbs = 1e-6;
      for (var k = 0; k < shown.length; k++) {
        shown[k] += ((target[k] || 0) - shown[k]) * 0.06;
        if (Math.abs(shown[k]) > maxAbs) maxAbs = Math.abs(shown[k]);
      }
      var inner = ctr.r * 0.3;
      for (var k2 = 0; k2 < spokes.length; k2++) {
        var angle = (k2 / spokes.length) * Math.PI * 2 - Math.PI / 2;
        var mag = Math.abs(shown[k2] || 0) / maxAbs;
        var len = inner + (ctr.r * 0.6 - inner) * mag;
        var ln = spokes[k2];
        ln.setAttribute('x1', (ctr.x + Math.cos(angle) * inner).toFixed(1));
        ln.setAttribute('y1', (CY + Math.sin(angle) * inner).toFixed(1));
        ln.setAttribute('x2', (ctr.x + Math.cos(angle) * len).toFixed(1));
        ln.setAttribute('y2', (CY + Math.sin(angle) * len).toFixed(1));
        ln.setAttribute('stroke', (shown[k2] || 0) >= 0 ? '#d9a25b' : '#5b95d1');
        ln.setAttribute('opacity', (0.28 + 0.55 * mag).toFixed(2));
      }
    }
    var alive = [];
    for (var pi = 0; pi < s.particles.length; pi++) {
      var pt = s.particles[pi];
      var t = (now - pt.born) / 1400;
      if (t < 0) { alive.push(pt); continue; }
      if (t >= 1) { pt.el.remove(); continue; }
      var ease = 1 - Math.pow(1 - t, 3);
      pt.el.setAttribute('cx', (pt.x0 + (pt.x1 - pt.x0) * ease).toFixed(1));
      pt.el.setAttribute('cy', (pt.y0 + (pt.y1 - pt.y0) * ease).toFixed(1));
      pt.el.setAttribute('opacity', String(t < 0.85 ? 0.95 : (1 - t) / 0.15));
      alive.push(pt);
    }
    s.particles = alive;
  }

  function spawnParticles(s, flows) {
    for (var i = 0; i < flows.length; i++) {
      var f = flows[i];
      if (f.seq <= s.seenSeq) continue;
      var ctr = s.centers[f.target];
      if (!ctr || !s.particleLayer) continue;
      var el = document.createElementNS(svgNS, 'circle');
      el.setAttribute('r', '3'); el.setAttribute('fill', flowColor(f.ref));
      el.setAttribute('cx', '-10'); el.setAttribute('cy', '-10');
      var t = document.createElementNS(svgNS, 'title'); t.textContent = f.ref; el.appendChild(t);
      s.particleLayer.appendChild(el);
      s.particles.push({ el: el, born: performance.now() + (i * 180), x0: ctr.x + (Math.random() * 160 - 80), y0: -8, x1: ctr.x, y1: CY });
    }
    for (var j = 0; j < flows.length; j++) s.seenSeq = Math.max(s.seenSeq, flows[j].seq);
  }

  var drawer = document.getElementById('drawer');
  function escHtml(x) { var d = document.createElement('div'); d.textContent = x; return d.innerHTML; }
  function openDrawerFor(s, cellId) {
    return function () {
      var c = null, cells = s.ind.cells;
      for (var i = 0; i < cells.length; i++) if (cells[i].id === cellId) c = cells[i];
      if (!c) return;
      var h = '<div class="drawerhead"><h3>' + escHtml(c.id) + '</h3><button id="drawer-close">×</button></div>';
      h += '<div class="being">' + escHtml(c.words) + ' · generation ' + c.gen + '</div>';
      h += '<div class="drawer-metrics">pressure ' + Math.round(c.pressure * 100) + '% · energy ' + Math.round(c.energy * 100) + '% · uncertainty ' + Math.round(c.uncertainty * 100) + '%</div>';
      if (c.estimates.length) {
        h += '<div class="sectlabel">holds</div>';
        for (var e = 0; e < c.estimates.length; e++) h += '<div class="drawer-item">' + escHtml(c.estimates[e].claim) + ' <span class="dim">(' + c.estimates[e].conf + ')</span></div>';
      }
      if (c.open.length) {
        h += '<div class="sectlabel">expecting</div>';
        for (var o = 0; o < c.open.length; o++) h += '<div class="drawer-item">' + escHtml(c.open[o].claim) + ' <span class="dim">(' + escHtml(c.open[o].horizon) + ')</span></div>';
      }
      if (c.refs.length) {
        h += '<div class="sectlabel">recent contact</div>';
        for (var r = 0; r < c.refs.length; r++) h += '<div class="drawer-item"><span class="who-' + c.refs[r].who + '">' + c.refs[r].who + '</span> ' + escHtml(c.refs[r].head) + '</div>';
      }
      drawer.innerHTML = h;
      drawer.classList.add('open');
      document.getElementById('drawer-close').addEventListener('click', function () { drawer.classList.remove('open'); });
    };
  }

  var bodies = [];
  for (var bi = 0; bi < DATA.individuals.length; bi++) {
    var ind = DATA.individuals[bi];
    var mount = document.querySelector('[data-body="' + ind.name + '"]');
    if (mount && ind.cells && ind.cells.length) bodies.push(makeBody(mount, ind));
  }
  function loop(now) {
    for (var i = 0; i < bodies.length; i++) frame(bodies[i], now);
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  function setHTML(card, sel, html) {
    var el = card.querySelector(sel);
    if (el && typeof html === 'string') el.innerHTML = html;
  }
  function poll() {
    fetch('/api/terrarium').then(function (r) { return r.json(); }).then(function (fresh) {
      for (var i = 0; i < fresh.individuals.length; i++) {
        var ni = fresh.individuals[i];
        var s = null;
        for (var b = 0; b < bodies.length; b++) if (bodies[b].ind.name === ni.name) s = bodies[b];
        if (!s || !ni.cells) continue;
        var structureChanged = ni.cells.length !== s.ind.cells.length;
        spawnParticles(s, ni.flows || []);
        s.ind = ni;
        if (structureChanged) layout(s);
        else for (var c = 0; c < ni.cells.length; c++) s.target[ni.cells[c].id] = (ni.cells[c].state || []).slice();
        var card = document.querySelector('[data-card="' + ni.name + '"]');
        if (card) {
          setHTML(card, '.being', ni.beingHTML);
          setHTML(card, '.prose', ni.proseHTML);
          setHTML(card, '.prov', ni.provHTML);
          setHTML(card, '.chipmount', ni.chipHTML);
        }
      }
    }).catch(function () { /* quiet — next poll retries */ });
  }
  setInterval(poll, 5000);
})();
`;

// ─── Server-side card templates (the poll returns the same fragments) ───────

function ageStr(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return '?';
  if (ms < 90_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 5_400_000) return `${Math.round(ms / 60_000)}m ago`;
  return `${(ms / 3_600_000).toFixed(1)}h ago`;
}

function chipHTML(d: IndividualData): string {
  return `<span class="chip ${d.awake ? 'chip-awake' : 'chip-quiet'}">${d.awake ? '● awake' : '○ quiet'}${d.lastEventAt !== null ? ` · last event ${ageStr(d.lastEventAt)}` : ''}</span>${d.dreamed ? '<span class="chip chip-dream">🌙 dreamed</span>' : ''}`;
}

function proseHTML(d: IndividualData): string {
  // Cut 6: a reach to jtr leads everything — an outbox nobody sees is theatre.
  const asks = d.asks.length > 0
    ? `<div class="sect ask"><div class="sectlabel">✋ he reached for you</div>${d.asks.map((a) =>
        `<blockquote class="thought">${esc(a.message)}</blockquote><div class="prov">${ageStr(a.at)} · answer him in conversation, or discharge via the operator inbox</div>`).join('')}</div>`
    : '';
  const commitments = d.commitments.length > 0
    ? `<div class="sect"><div class="sectlabel">held commitments (his own predictions, made causal)</div>${d.commitments.map((c) =>
        `<div class="chatline from-agent"><span class="who">holds</span>${esc(c.claim)} <span class="prov">· due ${c.due !== '' ? ageStr(c.due) : '?'} · pressed ${c.presses}/3</span></div>`).join('')}</div>`
    : '';
  const exchange = d.exchange.length > 0
    ? `<div class="sect"><div class="sectlabel">last exchange</div>${d.exchange.map((l) =>
        `<div class="chatline ${l.who === 'jtr' ? 'from-jtr' : 'from-agent'}"><span class="who">${esc(l.who)}</span>${esc(l.text)}</div>`).join('')}</div>`
    : '';
  const thought = d.thought !== null
    ? `<div class="sect"><div class="sectlabel">${d.thought.dream ? '🌙 dreamed at waking' : 'latest thought'}</div><blockquote class="thought">${esc(d.thought.text)}</blockquote><div class="prov">${ageStr(d.thought.at)}</div></div>`
    : '';
  const record = d.record.length > 0
    ? `<div class="sect"><div class="sectlabel">the record</div><div class="pills">${d.record.map((r) => {
        const mark = r.mark === 'right' ? '✓' : r.mark === 'wrong' ? '✗' : r.mark === 'partial' ? '≈' : '…';
        return `<span class="pill pill-${r.mark}" title="${esc(r.detail)}">${mark} ${esc(r.text)}</span>`;
      }).join('')}</div></div>`
    : '';
  return asks + commitments + exchange + thought + record;
}

function renderCard(d: IndividualData): string {
  return `<section class="card" data-card="${esc(d.name)}">
    <div class="cardhead"><h2>${esc(d.name)}</h2><span class="chipmount">${chipHTML(d)}</span></div>
    <div class="being">${esc(d.being)}</div>
    ${d.note !== '' ? `<div class="note">${esc(d.note)}</div>` : ''}
    ${d.growth !== null ? `<div class="${d.growth.startsWith('🌱') ? 'grown' : 'proposals'}">${esc(d.growth)}</div>` : ''}
    <figure class="bodyfig"><div data-body="${esc(d.name)}"></div>
    <figcaption>his body, live — it breathes with his energy, the spokes are his actual state morphing as he lives, arriving dots are real events flowing into the cell that ate them · click a cell to open it</figcaption></figure>
    <div class="prose">${proseHTML(d)}</div>
    <div class="prov">${esc(d.prov)}</div>
    ${d.journal !== null ? `<details class="journal"><summary>his journal (his own words, from receipts)</summary><pre>${esc(d.journal)}</pre></details>` : ''}
  </section>`;
}

function withFragments(d: IndividualData): Record<string, unknown> {
  return { ...d, beingHTML: esc(d.being), proseHTML: proseHTML(d), provHTML: esc(d.prov), chipHTML: chipHTML(d) };
}

function apiPayload(): string {
  const individuals = specs.map((spec) => {
    const d = computeIndividual(spec);
    return d === null ? { name: spec.name, cells: [], flows: [], assoc: [], maxGen: 1 } : withFragments(d);
  });
  return JSON.stringify({ individuals, at: new Date().toISOString() });
}

function page(): string {
  const data = specs.map(computeIndividual).filter((d): d is IndividualData => d !== null);
  const cards = data.map(renderCard).join('\n');
  const initial = JSON.stringify({ individuals: data.map(withFragments) });
  return `<!doctype html><html><head><meta charset="utf-8">
<title>the terrarium</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { background:#0a0d12; color:#cfd6e0; font: 15px/1.65 system-ui, -apple-system, "Segoe UI", sans-serif; margin:0; padding:28px 20px 40px; max-width:1080px; margin-inline:auto; }
  h1 { font-size:20px; font-weight:650; color:#eef2f7; letter-spacing:.01em; margin:0 0 2px; }
  .pagesub { color:#7d8798; font-size:13px; margin-bottom:22px; }
  .card { background:#11151d; border:1px solid #1d2330; border-radius:16px; padding:22px 24px; margin:18px 0; }
  .cardhead { display:flex; align-items:baseline; gap:14px; flex-wrap:wrap; }
  .card h2 { margin:0; font-size:22px; font-weight:650; color:#eef2f7; }
  .chip { font-size:12px; padding:3px 10px; border-radius:999px; border:1px solid #263043; color:#93a0b4; margin-right:6px; }
  .chip-awake { color:#69d58c; border-color:#1f4030; }
  .chip-quiet { color:#7d8798; }
  .chip-dream { color:#c795f0; border-color:#3a2b4d; }
  .sect.ask { border:1px solid #4d3b1e; background:#221a0d; border-radius:8px; padding:10px 12px; }
  .sect.ask .sectlabel { color:#f0c060; }
  .being { font-size:15px; color:#aeb9c9; margin-top:8px; }
  .note { font-size:13px; color:#68738a; margin-top:2px; font-style:italic; }
  .bodyfig { margin:16px 0 6px; }
  .bodyfig svg { width:100%; height:auto; display:block; background:#0b0f16; border-radius:12px; }
  .bodyfig figcaption { font-size:12px; color:#5f6a7d; margin-top:6px; }
  .cellg { cursor:pointer; }
  .cellname-svg { fill:#cfd6e0; font-size:12px; font-weight:600; }
  .cellstate-svg { fill:#7d8798; font-size:10.5px; }
  .prose { display:grid; grid-template-columns:1fr 1fr; gap:6px 28px; margin-top:10px; }
  @media (max-width:760px) { .prose { grid-template-columns:1fr; } }
  .sect { margin:10px 0; }
  .sectlabel { font-size:11px; letter-spacing:.14em; text-transform:uppercase; color:#68738a; margin:10px 0 7px; }
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
  .muted { color:#68738a; } .dim { color:#68738a; }
  table.cells { border-collapse:collapse; width:100%; }
  table.cells td { padding:6px 12px 6px 0; font-size:13.5px; color:#aeb9c9; border-top:1px solid #1a202c; }
  .cellname { color:#cfd6e0; }
  .cells-own { color:#69d58c; }
  .journal pre { white-space:pre-wrap; background:#0b0f16; border-radius:12px; padding:16px 18px; font:13.5px/1.6 system-ui, sans-serif; color:#bfc8d4; }
  .journal summary { cursor:pointer; font-size:13px; color:#7d8798; margin-top:10px; }
  .boardcard summary { cursor:pointer; font-size:14px; color:#93a0b4; }
  .boardcard summary b { color:#69d58c; }
  footer { color:#525b6b; font-size:12px; margin:22px 6px; }
  #drawer { position:fixed; top:0; right:-420px; width:400px; height:100vh; background:#12161f; border-left:1px solid #232c3d; padding:24px; transition:right .28s ease; overflow-y:auto; z-index:10; }
  #drawer.open { right:0; box-shadow:-24px 0 60px rgba(0,0,0,.5); }
  .drawerhead { display:flex; justify-content:space-between; align-items:center; }
  .drawerhead h3 { margin:0; font-size:17px; color:#eef2f7; }
  #drawer-close { background:none; border:none; color:#7d8798; font-size:22px; cursor:pointer; }
  .drawer-metrics { font-size:12.5px; color:#68738a; margin:4px 0 10px; }
  .drawer-item { padding:7px 10px; margin:5px 0; background:#171c27; border-radius:8px; font-size:13.5px; }
  .who-jtr { color:#69d58c; font-weight:600; } .who-self { color:#6cb2f5; font-weight:600; }
  .who-house { color:#e6b450; font-weight:600; } .who-teaching { color:#c795f0; font-weight:600; } .who-lived { color:#7d8798; }
</style></head><body>
<h1>the terrarium</h1>
<div class="pagesub">${specs.length} individuals, read live from their chains · the page breathes — you never refresh · looking changes nothing</div>
${cards}
${renderBoard()}
<div id="drawer"></div>
<footer>every number is read from a hash-chained ledger or its checkpoint — nothing here is state. individuals: ${specs.map((s) => esc(s.name)).join(' · ')}.</footer>
<script type="application/json" id="terrarium-data">${initial.replace(/</g, '\\u003c')}</script>
<script>${CLIENT_JS}</script>
</body></html>`;
}

const server = createServer((req, res) => {
  try {
    if (req.url === '/api/terrarium') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }).end(apiPayload());
      return;
    }
    if (req.url !== undefined && req.url !== '/' && req.url !== '/index.html') {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page());
  } catch (error) {
    res.writeHead(500, { 'content-type': 'text/plain' }).end(`observatory error: ${(error as Error).message}`);
  }
});
server.listen(port, () => console.log(`[observatory] the terrarium — watching ${specs.length} individuals on :${port}`));
