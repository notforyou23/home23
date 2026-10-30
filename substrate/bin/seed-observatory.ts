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
 * page never writes or touches a seed. The optional legacy organ
 * sentinel includes remote probes; a Host installation watches only its
 * declared local processes and streams.
 */

import { createServer } from 'node:http';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { nextCrossingAt } from '../src/concern.js';
import type { Commitment } from '../src/concern.js';
import { probeAll, localProbeRoster, readDeclaredProcessRoster, judgePm2 } from './organ-probes.js';
import type { ProbeResult } from './organ-probes.js';
import { objectOf, readJsonlWindow, projectOutreach, projectGrowth, summarizeRouting } from '../src/observatory-state.js';
import type { JsonlWindow, GrowthView, OutreachView } from '../src/observatory-state.js';
import { readDocument, readCheckpointView, projectConcernView, readLearningView, learningChoices, residentRoot } from '../src/observatory-evidence.js';
import type { ChoiceView } from '../src/observatory-evidence.js';
import { createRequire } from 'node:module';
const engineRequire = createRequire(import.meta.url);
const { runPm2Sync } = engineRequire('../../engine/src/system/pm2-client.cjs');

interface IndividualSpec { name: string; stateDir: string; formsDir?: string; note?: string }

const port = Number(process.env['OBSERVATORY_PORT'] ?? 5050);
const specs: IndividualSpec[] = JSON.parse(process.env['OBSERVATORY_INDIVIDUALS'] ?? '[]') as IndividualSpec[];
if (specs.length === 0) {
  console.error('OBSERVATORY_INDIVIDUALS required');
  process.exit(2);
}

interface Rec { seq: number; category: string; sourceRef: string; payload: Record<string, unknown>; issuedAt: string }

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
const stringOf = (value: unknown, max = 500): string => typeof value === 'string' ? value.slice(0, max) : '';
const recordsOf = (window: JsonlWindow): Rec[] => window.available ? window.records.filter(r => Number.isSafeInteger(r.seq) && typeof r.category === 'string' && typeof r.sourceRef === 'string' && typeof r.issuedAt === 'string' && r.payload !== null && typeof r.payload === 'object' && !Array.isArray(r.payload)) as unknown as Rec[] : [];

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
  freshness: { asOf: string; ledgerAvailable: boolean; ledgerError: string; ledgerCoverage: JsonlWindow['coverage']; checkpointAvailable: boolean; checkpointAt: string | null; checkpointSeq: number | null; checkpointError: string; headSeq: number | null; concernCurrent: boolean; concernSeq: number; conversationAvailable: boolean; brainAvailable: boolean; brainCoverage: JsonlWindow['coverage']; brainError: string; outboxAvailable: boolean; relayAvailable: boolean };
  lobe: { status: 'success' | 'failure' | 'unavailable'; at: string | null; provider: string; model: string; error: string };
  learning: { available: boolean; seq: number | null; lessons: Array<{ id: string; scope: string; tags: string[]; excludes: string[]; value: number; createdAt: string }>; choices: ChoiceView[] };
  routing: ReturnType<typeof summarizeRouting>;
  config: { agency: 'enabled' | 'disabled' | 'unknown'; cognitionMode: string; at: string | null; available: boolean };
  growthRecords: GrowthView[]; asksHistory: OutreachView[];
  awake: boolean; lastEventAt: string | null; being: string;
  cells: CellData[]; assoc: Array<{ from: string; to: string; strength: number }>;
  flows: Array<{ seq: number; ref: string; target: string }>;
  maxGen: number; dreamed: boolean;
  exchange: Array<{ who: string; text: string }>;
  /** What just happened, in words — the chain's notable tail (2026-08-11:
   * jtr: "hard to see what's happening on this page"). */
  pulse: Array<{ at: string; text: string }>;
  thought: { text: string; dream: boolean; at: string } | null;
  record: Array<{ mark: 'right' | 'wrong' | 'partial' | 'open' | 'assessed'; text: string; detail: string }>;
  growth: string | null; prov: string; journal: string | null;
  /** Cut 6: motor reaches to jtr (outbox tail — the operator's channel). */
  asks: OutreachView[];
  /** Cut 6: open commitments — what the individual is bound to resolve. */
  commitments: Array<{ claim: string; due: string; presses: number }>;
  /** The next moment this individual could originate on its own — the SOLVED
   * crossing time of its earliest-pressing commitment, or null when nothing
   * is scheduled. Null is the honest, load-bearing answer: for days the
   * program waited on a hand that no open commitment could ever produce
   * (2026-08-12). A watcher must be able to see "nothing is scheduled". */
  nextCrossing: { at: string; claim: string } | null;
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
  const ledger = readJsonlWindow(ledgerPath);
  const records = recordsOf(ledger);
  const checkpoint = readCheckpointView(spec.stateDir);
  const ck = checkpoint.document ?? null;
  const concernView = ck ? projectConcernView(ck, ledger) : { current: false, throughSeq: 0, concern: {} };
  const learning = readLearningView(spec.stateDir, checkpoint);
  const root = residentRoot(spec.stateDir);
  const brain = root ? readJsonlWindow(join(root, 'brain', 'event-ledger.jsonl'), 2 * 1024 * 1024) : { available: false, records: [], coverage: { bytesRead: 0, totalBytes: 0, startOffset: 0, endOffset: 0, fullHistory: false, tornTail: false }, error: 'resident engine path is unavailable' };
  const config = root ? readDocument(join(root, 'config.yaml'), 512 * 1024, 'yaml') : { available: false, at: null, value: undefined };
  const homeConfig = root ? readDocument(join(root, '..', '..', 'config', 'home.yaml'), 512 * 1024, 'yaml') : { available: false, value: undefined };
  const agency = objectOf(config.value?.agency).enabled ?? objectOf(homeConfig.value?.agency).enabled;
  const engine = objectOf(config.value?.engine);
  const base = root ? readDocument(join(root, '..', '..', 'config', 'base-engine.yaml'), 512 * 1024, 'yaml') : { available: false, value: undefined };
  const cognitionMode = stringOf(objectOf(engine.architecture).cognitionMode ?? objectOf(base.value?.architecture).cognitionMode, 100) || 'unknown';

  const last = records[records.length - 1];
  const headSeq = last?.seq ?? null;
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

  // Life share: which cells his recent life actually flows through — the
  // honest answer to "why do some circles do nothing" made visible.
  const recentTransitions = records.filter((r) => r.category === 'transition').slice(-200);
  const shareByCell = new Map<string, number>();
  for (const r of recentTransitions) {
    const id = String(r.payload['targetCellId'] ?? '');
    shareByCell.set(id, (shareByCell.get(id) ?? 0) + 1);
  }
  for (const c of cells) {
    const n = shareByCell.get(c.id) ?? 0;
    const pct = recentTransitions.length > 0 ? Math.round((n / recentTransitions.length) * 100) : 0;
    c.words = `${c.words} · ${pct}%`;
  }

  // The pulse: newest notable events, in words. Telemetry stays out.
  const pulse: IndividualData['pulse'] = [];
  for (let i = records.length - 1; i >= 0 && pulse.length < 5; i--) {
    const r = records[i];
    if (r === undefined) continue;
    const p = r.payload;
    let text: string | null = null;
    if (r.category === 'lobe' && p['error'] === undefined && p['dream'] !== undefined) {
      const quiet = Math.round(Number((p['dream'] as { quietSeconds?: number }).quietSeconds ?? 0) / 60);
      text = `🌙 dreamed at waking (~${quiet}min quiet)`;
    } else if (r.category === 'concern' && p['crossing'] === true) {
      text = `⚡ his own obligation crossed: “${String(p['claim'] ?? '').slice(0, 90)}”`;
    } else if (r.category === 'concern' && Array.isArray(p['formed']) && (p['formed'] as unknown[]).length > 0) {
      const f = (p['formed'] as Array<{ claim?: string }>)[0];
      text = `bound himself: “${String(f?.claim ?? '').slice(0, 90)}”`;
    } else if (r.category === 'concern' && Array.isArray(p['discharged']) && (p['discharged'] as unknown[]).length > 0) {
      const d = (p['discharged'] as Array<{ status?: string }>)[0];
      text = `settled a commitment — ${String(d?.status ?? '')}`;
    } else if (r.category === 'concern' && p['status'] === 'expired') {
      text = 'let a commitment go (pressed unanswered)';
    } else if (r.category === 'act' && p['motor'] === true && p['authorized'] === true) {
      text = `✋ authorized an operator request: “${String(p['message'] ?? '').slice(0, 90)}”`;
    } else if (r.category === 'development' && p['rule'] === 'consolidation.v1') {
      text = `slept (~${Math.round(Number(p['quietSeconds'] ?? 0) / 60)}min quiet)`;
    } else if (r.category === 'transition' && r.sourceRef.startsWith('dream:')) {
      text = '🔗 a dream entered his chain (T1 at birth)';
    } else if (r.category === 'transition' && r.sourceRef.startsWith('house.')) {
      const entity = r.sourceRef.split(':')[1] ?? r.sourceRef;
      text = `sensed the house — ${entity.replace(/^[a-z_]+\./, '').replace(/_/g, ' ')}`;
    } else if (r.category === 'lobe' && p['error'] === undefined) {
      const deltas = (p['appliedDeltas'] as Array<{ delta?: { claim?: string } }> | undefined) ?? [];
      const claim = deltas.map((d) => d.delta?.claim).find((c) => typeof c === 'string');
      if (claim !== undefined) text = `model estimate: “${claim.slice(0, 90)}”`;
    } else if (r.category === 'proposal' && r.sourceRef === 'growth.pressure') {
      text = `growth proposal: ${String(p['op'] ?? '?')} ${((p['targetCellIds'] as string[] | undefined) ?? []).map((x) => x.split('.').slice(-1)[0]).join(' + ')}`;
    }
    if (text !== null) pulse.push({ at: r.issuedAt, text });
  }

  const flows = records.filter((r) => r.category === 'transition').slice(-24)
    .map((r) => ({ seq: r.seq, ref: r.sourceRef.slice(0, 90), target: String(r.payload['targetCellId'] ?? '') }));

  const sleeps = records.filter((r) => r.category === 'development' && r.payload['rule'] === 'consolidation.v1').length;
  const dreams = records.filter((r) => r.category === 'lobe' && r.payload['dream'] !== undefined && r.payload['error'] === undefined).length;
  const being = [
    headSeq === null ? 'ledger head unavailable' : `ledger through seq ${headSeq.toLocaleString()}`,
    `${sleeps} sleep receipt${sleeps === 1 ? '' : 's'} in window`,
    `${dreams} dream receipt${dreams === 1 ? '' : 's'} in window`,
  ].join(' · ');
  const conversation = readJsonlWindow(join(spec.stateDir, '..', 'conversation-stream.jsonl'), 64 * 1024);
  const exchange: IndividualData['exchange'] = conversation.available ? conversation.records
    .filter(t => typeof t.ts === 'string' && typeof t.text === 'string' && (t.role === 'user' || t.role === 'assistant'))
    .sort((a, b) => String(a.ts).localeCompare(String(b.ts))).slice(-3)
    .map(t => ({ who: t.role === 'user' ? 'jtr' : spec.name.replace('-seed', ''), text: stringOf(t.text, 150) })) : [];

  const lobeCalls = records.filter(r => r.category === 'lobe');
  const latestCall = lobeCalls.at(-1);
  const lobes = lobeCalls.filter(r => r.payload['error'] === undefined);
  const lobe: IndividualData['lobe'] = latestCall ? { status: latestCall.payload.error === undefined ? 'success' : 'failure', at: latestCall.issuedAt,
    provider: stringOf(latestCall.payload.provider, 100), model: stringOf(latestCall.payload.modelId, 100), error: stringOf(latestCall.payload.error, 320) || (latestCall.payload.error === undefined ? '' : 'call failed; detail unavailable') }
    : { status: 'unavailable', at: null, provider: '', model: '', error: '' };
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
    for (const p of (c['predictions'] ?? []) as Array<{ claim: string; horizon: string; resolvedAt?: string; error?: number; resolutionEvidence?: { verificationStatus?: string } }>) {
      if (p.resolvedAt !== undefined && typeof p.error === 'number') {
        record.push({
          mark: p.resolutionEvidence?.verificationStatus === 'assessed' ? 'assessed' : p.error <= 0.3 ? 'right' : p.error >= 0.7 ? 'wrong' : 'partial',
          text: p.claim.slice(0, 70), detail: `${p.resolutionEvidence?.verificationStatus === 'assessed' ? 'provisional model assessment' : 'historical recorded grade'} · error ${p.error.toFixed(2)} · independent verification unavailable`,
        });
      } else if (p.resolvedAt === undefined) {
        record.push({ mark: 'open', text: p.claim.slice(0, 70), detail: `horizon ${p.horizon}` });
      }
    }
  }

  const growthRecords = projectGrowth(ledger.available ? ledger.records : [], ledger.coverage.fullHistory);
  const growth = growthRecords.length ? `${growthRecords.length} growth proposal${growthRecords.length === 1 ? '' : 's'} observed in window` : null;
  const dev = records.filter((r) => r.category === 'development');
  const byRule = new Map<string, number>();
  for (const d of dev) byRule.set(String(d.payload['rule'] ?? 'other').replace('.v1', ''), (byRule.get(String(d.payload['rule'] ?? 'other').replace('.v1', '')) ?? 0) + 1);
  const prov = `ledger window ${ledger.coverage.startOffset}–${ledger.coverage.endOffset} of ${ledger.coverage.totalBytes} bytes · ${ledger.coverage.fullHistory ? 'full retained file' : 'recent window only'}${ledger.coverage.tornTail ? ' · incomplete trailing row excluded' : ''} · ${[...byRule.entries()].map(([r, n]) => `${r} ×${n}`).join(' · ') || 'no development receipts observed in window'}`;
  const journalRead = spec.formsDir ? readDocument(join(spec.formsDir, 'journal', 'LATEST.md'), 64 * 1024, 'text') : null;
  const journal = journalRead?.available ? journalRead.text?.slice(0, 4000) ?? null : null;
  const outbox = readJsonlWindow(join(spec.stateDir, 'outbox.jsonl'), 64 * 1024);
  const relay = readDocument(join(spec.stateDir, 'operator-outreach.json'), 512 * 1024);
  const outreach = projectOutreach(outbox.available ? outbox.records : [], concernView.current ? concernView.concern : {}, relay.available && Array.isArray(relay.value?.receipts) ? relay.value.receipts.map(objectOf) : []);
  const commitments: IndividualData['commitments'] = [];
  let nextCrossing: IndividualData['nextCrossing'] = null;
  try {
    const open = Object.values(concernView.concern).filter(c => c.status === 'open' && typeof c.claim === 'string');
    for (const c of open.slice(0, 4)) commitments.push({ claim: stringOf(c.claim, 140), due: stringOf(c.dueAt, 100), presses: Number(c.crossings ?? 0) });
    if (concernView.current) for (const c of open) {
      const at = nextCrossingAt(c as unknown as Commitment);
      if (at !== null && (nextCrossing === null || at < nextCrossing.at)) nextCrossing = { at, claim: stringOf(c.claim) };
    }
  } catch { /* malformed concern state cannot promise eligibility */ }

  const ageMs = last?.issuedAt !== undefined ? Date.now() - Date.parse(last.issuedAt) : Infinity;
  return {
    name: spec.name, note: spec.note ?? '',
    awake: ledger.available && ageMs >= -60_000 && ageMs < 40 * 60_000, lastEventAt: last?.issuedAt ?? null,
    being: commitments.length > 0
      ? `${being} · holds ${commitments.length} commitment${commitments.length === 1 ? '' : 's'}`
      : being,
    cells, assoc, flows, maxGen,
    dreamed: dreams > 0, exchange, pulse, thought, record: record.slice(-5), growth, prov, journal,
    asks: outreach.current, asksHistory: outreach.history, commitments, nextCrossing, lobe, growthRecords,
    config: { available: config.available, agency: agency === true ? 'enabled' : agency === false ? 'disabled' : 'unknown', cognitionMode, at: config.at },
    routing: summarizeRouting(brain.available ? brain.records : []),
    learning: { available: learning.available === true, seq: learning.seq ?? null,
      lessons: learning.lessons.filter(l => l.authority === 'owner' && l.active === true).slice(-12).map(l => ({ id: l.lessonId, scope: l.scope, tags: l.tags, excludes: l.excludes, value: l.value, createdAt: l.createdAt })),
      choices: learningChoices(learning, brain.available ? brain.records : []) },
    freshness: { asOf: new Date().toISOString(), ledgerAvailable: ledger.available, ledgerError: ledger.error ?? '', ledgerCoverage: ledger.coverage,
      checkpointAvailable: checkpoint.available, checkpointAt: checkpoint.at, checkpointSeq: typeof ck?.ledgerSeq === 'number' ? ck.ledgerSeq : null, checkpointError: checkpoint.error ?? '',
      headSeq, concernCurrent: concernView.current, concernSeq: concernView.throughSeq, conversationAvailable: conversation.available,
      brainAvailable: brain.available, brainCoverage: brain.coverage, brainError: brain.error ?? '', outboxAvailable: outbox.available, relayAvailable: relay.available },
  };
}

/** The countdown line. States a TIME or states NOTHING — never a promise.
 * (2026-08-12: days were spent waiting on a hand no open commitment could
 * produce; a watcher must be able to read "nothing is scheduled".) */
function crossingHTML(d: IndividualData): string {
  const label = '<span class="sectlabel">next operator-reach eligibility</span>';
  if (!d.freshness.concernCurrent) return `<div class="crossing">${label} <span class="dim">unavailable — current concern state is not established</span></div>`;
  if (d.nextCrossing !== null) {
    const ms = Date.parse(d.nextCrossing.at) - Date.now();
    const when = ms <= 0 ? 'threshold eligible now' : ageStr(d.nextCrossing.at);
    return `<div class="crossing crossing-live">${label} <b>${esc(when)}</b> — if “${esc(d.nextCrossing.claim.slice(0, 90))}” remains unresolved.<div class="dim">Concern threshold only. Runner admission, throttle and refractory state can delay a reach. This is not the next engine action.</div></div>`;
  }
  return `<div class="crossing">${label} <span class="dim">${d.commitments.length ? 'no further concern threshold scheduled' : 'no open commitment'}. The next autonomous engine action is not established here.</span></div>`;
}

// ─── Organ vitals (2026-08-10: five silent organ deaths in one day — a dead
// feed must be SEEN where jtr already looks, not found by archaeology) ───────

let vitalsCache: { at: number; html: string } | null = null;

function vitalsHTML(): string {
  const now = Date.now();
  if (vitalsCache !== null && now - vitalsCache.at < 10_000) return vitalsCache.html;
  const parts: string[] = [];
  // PM2-supervised organs: errored/stopped is RED; flapping shows restarts.
  try {
    const raw = runPm2Sync(['jlist'], { timeout: 8_000 }).toString();
    const apps = JSON.parse(raw) as Array<{ name: string; pm2_env?: { status?: string; restart_time?: number } }>;
    if (process.env['HOME23_PRODUCT_HOST'] === 'true') {
      const roster = readDeclaredProcessRoster(process.env['HOME23_ROOT']);
      const judgments = judgePm2(apps as Parameters<typeof judgePm2>[0], roster.expected, roster.apps);
      for (const result of judgments) {
        const name = result.organ.replace(/^pm2:/, '');
        const app = apps.find(row => row.name.replace(/^home23-/, '') === name || row.name === name);
        const restarts = app?.pm2_env?.restart_time ?? 0;
        parts.push(`<span class="organ ${result.ok ? 'organ-ok' : 'organ-dead'}" title="${esc(result.why)}">${result.ok ? '●' : '✖'} ${esc(name)}${restarts > 3 ? ` <b>↺${restarts}</b>` : ''}</span>`);
      }
    } else for (const app of apps.filter(a => a.name.startsWith('home23-')).sort((a, b) => a.name.localeCompare(b.name))) {
      const status = app.pm2_env?.status ?? '?', restarts = app.pm2_env?.restart_time ?? 0, ok = status === 'online';
      parts.push(`<span class="organ ${ok ? 'organ-ok' : 'organ-dead'}" title="${esc(status)}">${ok ? '●' : '✖'} ${esc(app.name.replace('home23-', ''))}${restarts > 3 ? ` <b>↺${restarts}</b>` : ''}</span>`);
    }
  } catch { parts.push('<span class="organ organ-dead">✖ pm2 unreadable</span>'); }
  // Feed freshness: the streams the seeds actually eat. Age is honest — a
  // quiet feed and a dead feed look alike here; the PM2 row above tells them
  // apart.
  let feeds: Array<[string, string]> = [
    ['jerry convo', 'instances/jerry/substrate/conversation-stream.jsonl'],
    ['forrest convo', 'instances/forrest/substrate/conversation-stream.jsonl'],
    ['house', 'instances/jerry/substrate/house-stream.jsonl'],
    ['bobby mirror', 'instances/bobby/seed-01-mirror/seed-ledger.jsonl'],
  ];
  if (process.env['HOME23_PRODUCT_HOST'] === 'true') {
    try { feeds = localProbeRoster().feeds.map(feed => [feed.label, feed.path]); }
    catch { feeds = []; parts.push('<span class="organ organ-dead">✖ installed feed inventory unreadable</span>'); }
  }
  for (const [label, path] of feeds) {
    try {
      const ageMin = Math.round((now - statSync(path).mtimeMs) / 60_000);
      const stale = label === 'bobby mirror' ? ageMin > 20 : ageMin > 24 * 60;
      parts.push(`<span class="organ ${stale ? 'organ-stale' : 'organ-ok'}">${esc(label)} ${ageMin < 60 ? `${ageMin}m` : `${(ageMin / 60).toFixed(1)}h`}</span>`);
    } catch { parts.push(`<span class="organ organ-dead">✖ ${esc(label)} missing</span>`); }
  }
  // Function-probe reds (the sentinel's view): an organ can be pm2-online
  // and still not WORKING — those failures surface here by name.
  for (const r of sentinelResults.filter((x) => !x.ok && !x.organ.startsWith('pm2:'))) {
    parts.push(`<span class="organ organ-dead" title="${esc(r.why)}">✖ ${esc(r.organ)}</span>`);
  }
  const html = `<div class="vitals"><span class="sectlabel">declared processes</span> ${parts.join(' ')}<span class="dim">Process snapshot ${esc(new Date(now).toISOString())} · function probes ${sentinelCheckedAt ? esc(sentinelCheckedAt) : 'not yet observed'}${sentinelError ? ` · unavailable: ${esc(sentinelError)}` : ''}. Online status does not prove function.</span></div>`;
  vitalsCache = { at: now, html };
  return html;
}

// ─── The organ sentinel (2026-08-11, jtr: "get to the bottom of it… rock
// solid life"). The disease: PM2 'online' proves existence, not function;
// every zombie was visible in receipts nobody read continuously. The cure:
// function probes run every minute; a red persisting past the patience
// window escalates to jtr's PHONE through the bridge notify path (the same
// door live-problems uses); recovery posts a notice. The sentinel never
// remediates state — it observes and it KNOCKS. ────────────────────────────

const SENTINEL_INTERVAL_MS = 60_000;
const SENTINEL_PATIENCE_MS = 10 * 60_000;      // red this long → escalate
const SENTINEL_REESCALATE_MS = 60 * 60_000;    // still red → remind hourly

let sentinelResults: ProbeResult[] = [];
let sentinelCheckedAt: string | null = null;
let sentinelError = '';
const redSince = new Map<string, number>();
const lastEscalated = new Map<string, number>();

async function sentinelNotify(text: string, severity: string): Promise<void> {
  const url = process.env['ORGAN_SENTINEL_NOTIFY_URL'];
  const token = process.env['ORGAN_SENTINEL_NOTIFY_TOKEN'];
  if (url === undefined || url === '') {
    console.log(`[sentinel] (no notify url) ${text}`);
    return;
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token !== undefined && token !== '' ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ text, severity, source: 'organ-sentinel', requiresAction: severity === 'alert', isFailure: severity === 'alert' }),
    });
    console.log(`[sentinel] notified (${res.status}): ${text}`);
  } catch (error) {
    console.log(`[sentinel] notify FAILED (${(error as Error).message.slice(0, 60)}): ${text}`);
  }
}

function sentinelTick(): void {
  let results: ProbeResult[];
  try { results = probeAll(); } catch (error) {
    sentinelError = (error as Error).message.slice(0, 180);
    vitalsCache = null;
    console.log(`[sentinel] probe run failed: ${(error as Error).message.slice(0, 80)}`);
    return;
  }
  sentinelResults = results;
  sentinelCheckedAt = new Date().toISOString();
  sentinelError = '';
  vitalsCache = null;
  const now = Date.now();
  // Deliberately-stopped organs (operator's list, csv env) don't page jtr —
  // they still render red in the terrarium; silence is chosen, not blind.
  const ignore = new Set((process.env['ORGAN_SENTINEL_IGNORE'] ?? '').split(',').map((s) => s.trim()).filter((s) => s !== ''));
  for (const r of results) {
    if (ignore.has(r.organ)) continue;
    if (r.ok) {
      if (lastEscalated.has(r.organ)) {
        void sentinelNotify(`✅ [organ-sentinel] ${r.organ} recovered — ${r.why}`, 'notice');
        lastEscalated.delete(r.organ);
      }
      redSince.delete(r.organ);
      continue;
    }
    const since = redSince.get(r.organ) ?? now;
    if (!redSince.has(r.organ)) redSince.set(r.organ, now);
    const redFor = now - since;
    const last = lastEscalated.get(r.organ);
    const due = redFor >= SENTINEL_PATIENCE_MS && (last === undefined || now - last >= SENTINEL_REESCALATE_MS);
    if (due) {
      lastEscalated.set(r.organ, now);
      void sentinelNotify(`🚨 [organ-sentinel] ${r.organ} NOT functioning for ${Math.round(redFor / 60_000)}min — ${r.why}`, 'alert');
    }
  }
}

setInterval(sentinelTick, SENTINEL_INTERVAL_MS);
setTimeout(sentinelTick, 5_000);

// ─── The cutover board (server-rendered; builder detail, collapsed) ─────────

function renderBoard(data: IndividualData[]): string {
  return `<section class="card boardcard"><details data-detail-key="coverage"><summary>Read model coverage — per resident</summary><table class="cells">${data.map(d => `<tr><td>${esc(d.name)}</td><td>${d.freshness.ledgerAvailable ? `ledger seq ${d.freshness.headSeq ?? '?'}` : 'ledger unavailable'} · ${d.freshness.checkpointAvailable ? `checkpoint seq ${d.freshness.checkpointSeq}` : 'checkpoint unavailable'} · learning ${d.learning.available ? `accepted through seq ${d.learning.seq}` : 'unavailable'} · ${d.learning.lessons.length} active owner lesson${d.learning.lessons.length === 1 ? '' : 's'} observed</td></tr>`).join('')}</table><div class="dim">A stored lesson, a runtime choice, delivery, and an execution outcome are separate evidence. Missing recent evidence does not prove a lifetime absence.</div></details></section>`;
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

  function graphSignature(ind) {
    return JSON.stringify([ind.maxGen, ind.assoc, ind.cells.map(function(c) { return [c.id, c.short, c.gen, c.pressure, c.energy, c.uncertainty, c.words, (c.state || []).length]; })]);
  }

  function layout(s) {
    var previousShown = s.shown; s.shown = {}; s.target = {}; s.particles = [];
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
      s.shown[c.id] = previousShown[c.id] && previousShown[c.id].length === (c.state || []).length ? previousShown[c.id].slice() : (c.state || []).slice();
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
  var drawerSelection = null;
  function byAttribute(attr, value) { var nodes = document.querySelectorAll('[' + attr + ']'); for (var i = 0; i < nodes.length; i++) if (nodes[i].getAttribute(attr) === value) return nodes[i]; return null; }
  function escHtml(x) { var d = document.createElement('div'); d.textContent = x; return d.innerHTML; }
  function openDrawerFor(s, cellId) {
    return function () {
      drawerSelection = { body: s, cellId: cellId };
      var c = null, cells = s.ind.cells;
      for (var i = 0; i < cells.length; i++) if (cells[i].id === cellId) c = cells[i];
      if (!c) { drawer.classList.remove('open'); drawerSelection = null; return; }
      var h = '<div class="drawerhead"><h3>' + escHtml(c.id) + '</h3><button id="drawer-close">×</button></div>';
      h += '<div class="being">' + escHtml(c.words) + ' · generation ' + c.gen + '</div>';
      h += '<div class="drawer-metrics">pressure ' + Math.round(c.pressure * 100) + '% · energy ' + Math.round(c.energy * 100) + '% · uncertainty ' + Math.round(c.uncertainty * 100) + '%</div>';
      if (c.estimates.length) {
        h += '<div class="sectlabel">checkpoint estimates (inference)</div>';
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
      document.getElementById('drawer-close').addEventListener('click', function () { drawer.classList.remove('open'); drawerSelection = null; });
    };
  }

  var bodies = [];
  for (var bi = 0; bi < DATA.individuals.length; bi++) {
    var ind = DATA.individuals[bi];
    var mount = byAttribute('data-body', ind.name);
    if (mount && ind.cells && ind.cells.length) bodies.push(makeBody(mount, ind));
  }
  function loop(now) {
    for (var i = 0; i < bodies.length; i++) frame(bodies[i], now);
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  function setHTML(card, sel, html) {
    var el = card.querySelector(sel);
    if (!el || typeof html !== 'string') return;
    var opened = [];
    el.querySelectorAll('details[open]').forEach(function (d) { if (d.dataset.detailKey) opened.push(d.dataset.detailKey); });
    el.innerHTML = html;
    el.querySelectorAll('details').forEach(function (d) { if (opened.indexOf(d.dataset.detailKey) >= 0) d.open = true; });
  }
  var pollInFlight = false;
  var lastPollAt = null;
  function poll() {
    if (pollInFlight) return;
    pollInFlight = true;
    fetch('/api/terrarium', { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (fresh) {
      if (!Array.isArray(fresh.individuals)) throw new Error('Invalid projection response');
      for (var i = 0; i < fresh.individuals.length; i++) {
        var ni = fresh.individuals[i];
        var s = null;
        for (var b = 0; b < bodies.length; b++) if (bodies[b].ind.name === ni.name) s = bodies[b];
        var card = byAttribute('data-card', ni.name);
        if (s && ni.cells) {
          var structureChanged = graphSignature(ni) !== graphSignature(s.ind);
          s.ind = ni;
          if (structureChanged) layout(s);
          else for (var c = 0; c < ni.cells.length; c++) s.target[ni.cells[c].id] = (ni.cells[c].state || []).slice();
          spawnParticles(s, ni.flows || []);
        } else if (card && ni.cells && ni.cells.length) {
          var mount = byAttribute('data-body', ni.name);
          if (mount) bodies.push(makeBody(mount, ni));
        }
        if (card) {
          setHTML(card, '.being', ni.beingHTML);
          setHTML(card, '.prose', ni.proseHTML);
          setHTML(card, '.prov', ni.provHTML);
          setHTML(card, '.chipmount', ni.chipHTML);
          setHTML(card, '.pulsemount', ni.pulseHTML);
          setHTML(card, '.crossingmount', ni.crossingHTML);
          setHTML(card, '.freshnessmount', ni.freshnessHTML);
          setHTML(card, '.growthmount', ni.growthHTML);
          setHTML(card, '.journalmount', ni.journalHTML);
        }
      }
      setHTML(document, '#vitals-mount', fresh.vitalsHTML);
      setHTML(document, '#board-mount', fresh.boardHTML);
      if (drawerSelection && drawer.classList.contains('open')) openDrawerFor(drawerSelection.body, drawerSelection.cellId)();
      lastPollAt = fresh.at;
      var state = document.getElementById('connection-state');
      state.className = 'dim'; state.textContent = 'Projection updated ' + fresh.at;
    }).catch(function (error) {
      var state = document.getElementById('connection-state');
      state.className = 'organ-dead'; state.textContent = 'Projection stale: ' + error.message + (lastPollAt ? ' · last update ' + lastPollAt : ' · no successful poll yet');
    }).finally(function () { pollInFlight = false; });
  }
  setInterval(poll, 5000);
})();
`;

// ─── Server-side card templates (the poll returns the same fragments) ───────

function ageStr(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return '?';
  const span = Math.abs(ms);
  const duration = span < 90_000 ? `${Math.round(span / 1000)}s`
    : span < 5_400_000 ? `${Math.round(span / 60_000)}m` : `${(span / 3_600_000).toFixed(1)}h`;
  return ms < 0 ? `in ${duration}` : `${duration} ago`;
}

function chipHTML(d: IndividualData): string {
  return `<span class="chip ${d.awake ? 'chip-awake' : 'chip-quiet'}">${d.awake ? '● ledger active' : d.freshness.ledgerAvailable ? '○ ledger quiet' : '✖ ledger unavailable'}${d.lastEventAt !== null ? ` · last event ${ageStr(d.lastEventAt)}` : ''}</span>${d.dreamed ? '<span class="chip chip-dream">🌙 dream receipt in window</span>' : ''}`;
}

function proseHTML(d: IndividualData): string {
  // Cut 6: a reach to jtr leads everything — an outbox nobody sees is theatre.
  const asks = d.asks.length > 0
    ? `<div class="sect ask"><div class="sectlabel">✋ current canonical request</div>${d.asks.map((a) =>
        `<blockquote class="thought">${esc(a.message)}</blockquote><div class="prov">${ageStr(a.at)} · canonical message recorded; notification and owner attention unconfirmed</div>`).join('')}</div>`
    : '';
  const commitments = d.commitments.length > 0
    ? `<div class="sect"><div class="sectlabel">${d.freshness.concernCurrent ? 'open commitments — current accepted receipts' : 'open commitments — checkpoint snapshot only'}</div>${d.commitments.map((c) =>
        `<div class="chatline from-agent"><span class="who">holds</span>${esc(c.claim)} <span class="prov">· due ${c.due !== '' ? ageStr(c.due) : '?'} · pressed ${c.presses}/3</span></div>`).join('')}</div>`
    : '';
  const exchange = d.exchange.length > 0
    ? `<div class="sect"><div class="sectlabel">last exchange</div>${d.exchange.map((l) =>
        `<div class="chatline ${l.who === 'jtr' ? 'from-jtr' : 'from-agent'}"><span class="who">${esc(l.who)}</span>${esc(l.text)}</div>`).join('')}</div>`
    : '';
  const thought = d.thought !== null
    ? `<div class="sect"><div class="sectlabel">${d.thought.dream ? '🌙 latest successful dream estimate' : 'latest successful model estimate'}</div><blockquote class="thought">${esc(d.thought.text)}</blockquote><div class="prov">${ageStr(d.thought.at)} · inference, not a verified inspection or execution</div></div>`
    : '';
  const record = d.record.length > 0
    ? `<div class="sect"><div class="sectlabel">prediction record — checkpoint snapshot</div><div class="pills">${d.record.map((r) => {
        const mark = r.mark === 'right' ? 'low recorded error:' : r.mark === 'wrong' ? 'high recorded error:' : r.mark === 'partial' ? 'partial recorded error:' : r.mark === 'assessed' ? 'model assessed:' : 'open:';
        return `<span class="pill pill-${r.mark}" title="${esc(r.detail)}">${mark} ${esc(r.text)}</span>`;
      }).join('')}</div><div class="dim">Recorded error grades and provisional model assessments; independent verification is unavailable here.</div></div>`
    : '';
  return asks + commitments + lobeHTML(d) + exchange + thought + record + learningHTML(d) + routingHTML(d) + requestsHistoryHTML(d);
}

function freshnessHTML(d: IndividualData): string {
  const f = d.freshness, cp = f.checkpointAvailable ? `checkpoint seq ${f.checkpointSeq} · ${f.checkpointAt ?? 'time unavailable'}` : `checkpoint unavailable: ${f.checkpointError}`;
  const lag = f.headSeq !== null && f.checkpointSeq !== null ? f.headSeq - f.checkpointSeq : null;
  return `<div class="note">Read as of ${esc(f.asOf)} · ${f.ledgerAvailable ? `ledger seq ${f.headSeq ?? '?'}` : `ledger unavailable: ${esc(f.ledgerError)}`}<br>${esc(cp)}${lag === null ? '' : lag === 0 ? ' · checkpoint at observed head' : lag > 0 ? ` · cells are ${lag} ledger events behind` : ' · checkpoint ahead of this ledger window; current state unavailable'}. Cell vectors, numeric labels and prediction record are a checkpoint projection, not verified cognition.<br>Concern ${f.concernCurrent ? `receipts connected through seq ${f.concernSeq}` : 'current state unavailable; snapshot only'} · conversation ${f.conversationAvailable ? 'bounded window available' : 'unavailable'} · relay ${f.relayAvailable && f.outboxAvailable ? 'bounded receipts available' : 'unavailable or incomplete'}.</div>`;
}
function lobeHTML(d: IndividualData): string {
  const call = d.lobe;
  return `<div class="sect"><div class="sectlabel">latest lobe call in window</div><div class="${call.status === 'failure' ? 'organ-dead' : 'dim'}">${esc(call.status)}${call.at ? ` · ${ageStr(call.at)}` : ''}${call.provider ? ` · ${esc(call.provider)}` : ''}${call.model ? ` / ${esc(call.model)}` : ''}${call.error ? ` · ${esc(call.error)}` : ''}</div><div class="prov">foreground agency ${esc(d.config.agency)} · engine cognition mode ${esc(d.config.cognitionMode)}${d.config.at ? ` · config ${esc(d.config.at)}` : ''}. Configuration does not prove a running action.</div></div>`;
}
function learningHTML(d: IndividualData): string {
  const learning = d.learning;
  const lessons = learning.lessons.map(l => `<div class="drawer-item"><b>${esc(l.scope)}</b> · value ${l.value}<br>tags ${esc(l.tags.join(', ') || '(none)')} · excludes ${esc(l.excludes.join(', ') || '(none)')}<div class="prov">${esc(l.id)} · ${esc(l.createdAt)}</div></div>`).join('');
  const choices = learning.choices.map(c => `<div class="drawer-item">${esc(c.scope)} / ${esc(c.surface || 'unknown surface')} · ${c.evidenceStatus === 'verified' ? `choice ${esc(c.choice ?? '?')}${c.adjustment === undefined ? '' : ` · learned adjustment ${c.adjustment}`} · delivery ${c.deliveryStatus === 'observed' ? `${c.deliveredChars ?? 0} characters recorded` : 'unavailable'}` : `evidence unavailable: ${esc(c.reason ?? 'no exact witness')}`}<div class="prov">${esc(c.decisionId)} · ${ageStr(c.at)}${c.lessonIds.length ? ` · lessons ${esc(c.lessonIds.join(', '))}` : ''}</div></div>`).join('');
  return `<div class="sect"><details data-detail-key="learning"><summary>Learning evidence · ${learning.available ? `accepted through seq ${learning.seq}` : 'unavailable'}</summary><div class="sectlabel">durable active owner lessons</div>${lessons || '<div class="dim">No active owner lesson observed in the accepted snapshot.</div>'}<div class="sectlabel">latest witnessed context choices</div>${choices || '<div class="dim">No exact retained choice and raw runtime evidence joined in this bounded window.</div>'}<div class="prov">A durable lesson is not proof that a later choice or delivery used it. Delivery needs the exact RetrievalExecuted learningDecisionIds join.</div></details></div>`;
}
function routingHTML(d: IndividualData): string {
  const events = d.routing.events.map(e => `<div class="drawer-item">${esc(e.stage)} · ${esc(e.reasonCode || e.status)}${e.stage === 'execution' ? ` · execution ${e.executionAttempted ? 'attempted' : 'not recorded as attempted'} · task outcome ${e.taskOutcomeVerified ? 'receipt reports verified evidence' : 'not verified'}` : ''}<div class="prov">${esc(e.eventId)} · ${ageStr(e.at)}${e.agendaId ? ` · agenda ${esc(e.agendaId)}` : ''}${e.turnId ? ` · turn ${esc(e.turnId)}` : ''}${e.executionId ? ` · execution ${esc(e.executionId)}` : ''}</div>${e.detail ? `<div class="dim">${esc(e.detail)}</div>` : ''}</div>`).join('');
  const f = d.freshness;
  return `<div class="sect"><details data-detail-key="routing"><summary>Routing and execution evidence</summary><div class="dim">${f.brainAvailable ? `Engine event window ${f.brainCoverage.startOffset}–${f.brainCoverage.endOffset} of ${f.brainCoverage.totalBytes} bytes${f.brainCoverage.fullHistory ? '' : ' · recent window only'}` : `Engine evidence unavailable: ${esc(f.brainError)}`}</div>${events || '<div class="dim">No routing or execution receipt observed in this window.</div>'}<div class="prov">No intent is not a failure. Policy rejection, queued work, dispatch, and execution outcomes remain separate. Model descriptions of an inspection do not count as tool runs.</div></details></div>`;
}
function requestsHistoryHTML(d: IndividualData): string {
  if (!d.asksHistory.length) return '';
  return `<div class="sect"><details data-detail-key="requests"><summary>Historical or unconfirmed operator requests (${d.asksHistory.length} shown)</summary>${d.asksHistory.map(a => `<div class="drawer-item">${esc(a.message)}<div class="prov">${ageStr(a.at)} · ${esc(a.reason)} · relay ${esc(a.deliveryStatus)} · commitment ${esc(a.commitmentStatus)}</div></div>`).join('')}<div class="dim">Current requests require an open current concern, an exact committed relay receipt, and age within 24 hours.</div></details></div>`;
}
function growthHTML(d: IndividualData): string {
  if (!d.growthRecords.length) return '<div class="dim">No growth proposal observed in the ledger window.</div>';
  return `<details data-detail-key="growth"><summary>${esc(d.growth ?? 'Growth proposals')}</summary>${d.growthRecords.map(g => `<div class="drawer-item">proposal ${g.seq}: ${esc(g.op)} ${esc(g.targets.join(' + '))} · ${g.applicationEvidence === 'self-gate' ? 'cited as evidence for applied self growth' : esc(g.status.replace(/_/g, ' '))}${g.decisionSeq ? ` · decision seq ${g.decisionSeq}` : ''}</div>`).join('')}<div class="dim">Proposal lifecycle receipts only; a proposal is not an applied anatomy change.</div></details>`;
}
function journalHTML(d: IndividualData): string {
  return d.journal === null ? '' : `<details class="journal" data-detail-key="journal"><summary>Journal file (bounded excerpt)</summary><pre>${esc(d.journal)}</pre></details>`;
}

function pulseHTML(d: IndividualData): string {
  if (d.pulse.length === 0) return '<span class="dim">nothing notable in the recent chain</span>';
  return d.pulse.map((p) =>
    `<div class="pulseline"><span class="pulseage">${ageStr(p.at)}</span>${esc(p.text)}</div>`).join('');
}

function renderCard(d: IndividualData): string {
  return `<section class="card" data-card="${esc(d.name)}">
    <div class="cardhead"><h2>${esc(d.name)}</h2><span class="chipmount">${chipHTML(d)}</span></div>
    <div class="being">${esc(d.being)}</div>
    ${d.note !== '' ? `<div class="note">${esc(d.note)}</div>` : ''}
    <div class="freshnessmount">${freshnessHTML(d)}</div>
    <div class="crossingmount">${crossingHTML(d)}</div>
    <div class="pulse"><div class="sectlabel">the pulse — what just happened</div><div class="pulsemount">${pulseHTML(d)}</div></div>
    <div class="growthmount">${growthHTML(d)}</div>
    <figure class="bodyfig"><div data-body="${esc(d.name)}"></div>
    <figcaption>checkpoint cell projection — size and animation derive from stored numeric state; arriving dots show recent ledger transitions · click a cell to open it</figcaption></figure>
    <div class="prose">${proseHTML(d)}</div>
    <div class="prov">${esc(d.prov)}</div>
    <div class="journalmount">${journalHTML(d)}</div>
  </section>`;
}

function withFragments(d: IndividualData): Record<string, unknown> {
  return { ...d, beingHTML: esc(d.being), proseHTML: proseHTML(d), provHTML: esc(d.prov), chipHTML: chipHTML(d), pulseHTML: pulseHTML(d), crossingHTML: crossingHTML(d), freshnessHTML: freshnessHTML(d), growthHTML: growthHTML(d), journalHTML: journalHTML(d) };
}

function apiPayload(): string {
  const data = specs.map(computeIndividual).filter((d): d is IndividualData => d !== null);
  return JSON.stringify({ individuals: data.map(withFragments), vitalsHTML: vitalsHTML(), boardHTML: renderBoard(data), at: new Date().toISOString() });
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
  .crossing { margin:10px 0 2px; font-size:13px; color:#8b95a6; }
  .crossing-live { color:#d8e0ea; }
  .crossing b { color:#f0c060; }
  .pulse { margin:12px 0 4px; padding:10px 14px; background:#0d1118; border:1px solid #1a2130; border-radius:10px; }
  .pulseline { font-size:14px; color:#c5cdd9; padding:2px 0; }
  .pulseage { display:inline-block; min-width:52px; color:#5d6878; font-size:12px; font-variant-numeric:tabular-nums; }
  .vitals { margin:-8px 0 16px; font-size:12px; color:#7d8798; display:flex; flex-wrap:wrap; gap:6px 10px; align-items:baseline; }
  .organ { white-space:nowrap; }
  .organ-ok { color:#6fae7f; }
  .organ-dead { color:#e06c60; font-weight:600; }
  .organ-stale { color:#d0a05a; }
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
  .pill-right, .pill-assessed { border-color:#263043; color:#aeb9c9; }
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
<div class="pagesub">${specs.length} individuals, read-only projections · sources and timestamps shown below · updates every five seconds</div>
<div id="connection-state" class="dim" role="status">Snapshot loaded; waiting for the next poll.</div>
<div id="vitals-mount">${vitalsHTML()}</div>
${cards}
<div id="board-mount">${renderBoard(data)}</div>
<div id="drawer"></div>
<footer>Read-only evidence projection. Estimates and computed labels remain separate from verified outcomes. individuals: ${specs.map((s) => esc(s.name)).join(' · ')}.</footer>
<script type="application/json" id="terrarium-data">${initial.replace(/</g, '\\u003c')}</script>
<script>${CLIENT_JS}</script>
</body></html>`;
}

const server = createServer((req, res) => {
  try {
    // Process liveness only: no Seed composition, filesystem reads or probes.
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }).end('ok\n');
      return;
    }
    if (req.url === '/api/terrarium') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(apiPayload());
      return;
    }
    if (req.url === '/api/organs') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        .end(JSON.stringify({ organs: sentinelResults, checkedAt: sentinelCheckedAt, error: sentinelError || null }));
      return;
    }
    if (req.url !== undefined && req.url !== '/' && req.url !== '/index.html') {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(page());
  } catch (error) {
    res.writeHead(500, { 'content-type': 'text/plain', 'cache-control': 'no-store' }).end(`observatory error: ${(error as Error).message}`);
  }
});
server.listen({ port, host: process.env.HOME23_PRODUCT_HOST === 'true' ? '127.0.0.1' : undefined }, () => {
  const address = server.address();
  console.log(`[observatory] the terrarium — watching ${specs.length} individuals on :${typeof address === 'object' && address !== null ? address.port : port}`);
});
