/**
 * Field journal (Cut 4, first organ of expression).
 *
 * A journal entry is EXPRESSION generated from receipts — never canonical
 * state, never an input to the Seed's own senses, never prose that invents.
 * Every claim carries its ledger seq. The contract's rule holds: a generated
 * essay with no changed state is exhaust; this journal only speaks about
 * state changes that actually happened, by reading the chain that recorded
 * them.
 *
 * Deterministic: pure function of (ledger records, checkpoint cells, window).
 * No model, no wall clock in the content (the entry is ABOUT event-time).
 * The interpretive voice (a lobe reading its own journal window) comes later,
 * through the lobe broker — this organ tells the truth plainly first.
 */

import type { LedgerRecord, SerializedCell, Prediction } from './types.js';

export interface JournalWindow {
  name: string;
  seedId: string;
  /** Records with seq > sinceSeq, in order. */
  records: LedgerRecord[];
  /** Cells from the newest checkpoint (symbolic view). */
  cells: SerializedCell[];
  sinceSeq: number;
}

function eventTimeRange(records: LedgerRecord[]): string {
  const times = records
    .map((r) => r.payload?.['producedAt'])
    .filter((t): t is string => typeof t === 'string')
    .sort();
  const first = times[0];
  const last = times[times.length - 1];
  if (first === undefined) return 'no events';
  return first === last ? first : `${first} → ${last}`;
}

function pct(n: number): string {
  return (n * 100).toFixed(0) + '%';
}

/** Compose one journal entry. Returns null when the window holds nothing
 * worth speaking about (an empty entry would be exhaust). */
export function composeJournalEntry(window: JournalWindow): string | null {
  const { records, cells } = window;
  if (records.length === 0) return null;

  const transitions = records.filter((r) => r.category === 'transition');
  const admissions = records.filter((r) => r.category === 'workspace');
  const silences = records.filter((r) => r.category === 'silence');
  const developments = records.filter((r) => r.category === 'development');
  const lobes = records.filter((r) => r.category === 'lobe');
  const growthProposals = records.filter((r) => r.category === 'proposal' && r.sourceRef === 'growth.pressure');

  const lines: string[] = [];
  const lastSeq = records[records.length - 1]?.seq ?? window.sinceSeq;
  lines.push(`# ${window.name} — field journal · seq ${window.sinceSeq + 1}–${lastSeq}`);
  lines.push(`event-time: ${eventTimeRange(transitions)}`);
  lines.push('');

  // ── Still with me: cells by presence, receipts for their last contact ──
  const byCell = new Map<string, LedgerRecord[]>();
  for (const t of transitions) {
    const cellId = t.payload?.['targetCellId'];
    if (typeof cellId === 'string') {
      const list = byCell.get(cellId) ?? [];
      list.push(t);
      byCell.set(cellId, list);
    }
  }
  lines.push('## still with me');
  const ranked = [...cells].sort((a, b) => (b.workspacePressure + b.energy.current) - (a.workspacePressure + a.energy.current));
  for (const cell of ranked) {
    const touched = byCell.get(cell.id) ?? [];
    const last = touched[touched.length - 1];
    const lastNote = last !== undefined
      ? ` — last contact ${String(last.payload?.['originalCategory'] ?? '?')} from ${String(last.sourceRef).split(':')[0]} · seq ${last.seq}`
      : ' — untouched this window';
    lines.push(`- **${cell.id}** (gen ${cell.generation}, pressure ${pct(cell.workspacePressure)}, energy ${pct(cell.energy.current)})${lastNote}`);
  }
  lines.push('');

  // ── What happened ──
  lines.push('## what happened');
  const bySource = new Map<string, number>();
  for (const t of transitions) {
    const prefix = String(t.sourceRef).split(':')[0] ?? '?';
    bySource.set(prefix, (bySource.get(prefix) ?? 0) + 1);
  }
  const sourceSummary = [...bySource.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([s, n]) => `${s} ×${n}`)
    .join(', ');
  lines.push(`- ${transitions.length} moments of contact: ${sourceSummary}`);
  for (const a of admissions) {
    const admitted = a.payload?.['admittedCellIds'];
    lines.push(`- workspace admitted ${Array.isArray(admitted) ? admitted.join(', ') : '?'} · seq ${a.seq}`);
  }
  if (silences.length > 0) {
    const best = silences
      .map((s) => ({ seq: s.seq, top: Number(s.payload?.['topScore'] ?? 0), thr: Number(s.payload?.['threshold'] ?? 0) }))
      .sort((a, b) => b.top - a.top)[0];
    lines.push(`- stayed quiet ×${silences.length} (closest call ${best?.top.toFixed(2)} vs threshold ${best?.thr.toFixed(2)} · seq ${best?.seq}) — nothing earned the workspace`);
  }
  for (const l of lobes) {
    const err = l.payload?.['error'];
    if (err !== undefined) {
      lines.push(`- recruited thought failed (${String(err).slice(0, 60)}) · seq ${l.seq}`);
      continue;
    }
    // Only typed deltas integrate — the advisory arrays are context, and the
    // journal must never count offered-but-unintegrated items as change.
    const appliedDeltas = l.payload?.['appliedDeltas'];
    const integrated = Array.isArray(appliedDeltas) ? appliedDeltas.length : 0;
    const fields = Array.isArray(appliedDeltas)
      ? [...new Set(appliedDeltas.map((d) => String((d as { field?: unknown }).field ?? '?')))].join(', ')
      : '';
    lines.push(`- recruited thought landed ${integrated} typed delta(s)${fields !== '' ? ` (${fields})` : ''} · seq ${l.seq}`);
  }
  lines.push('');

  // ── What changed in me ──
  lines.push('## what changed in me');
  if (developments.length === 0) {
    lines.push('- nothing — no corrections or consequences reached me this window');
  }
  for (const d of developments) {
    const rule = String(d.payload?.['rule'] ?? '?');
    if (rule === 'consolidation.v1') {
      const cellsSummary = d.payload?.['cells'];
      const n = Array.isArray(cellsSummary) ? cellsSummary.length : 0;
      lines.push(`- quiet gap ended: consolidated ${n} cell(s) — unearned learning faded, corroborated stayed · seq ${d.seq}`);
    } else if (d.payload?.['ablation'] === true) {
      lines.push(`- ABLATION: my development was zeroed by sanctioned instrument · seq ${d.seq}`);
    } else {
      const cellId = String(d.payload?.['cellId'] ?? '?');
      const key = String(d.payload?.['trustKey'] ?? '?');
      const mag = Number(d.payload?.['developmentMagnitude'] ?? 0);
      lines.push(`- ${rule === 'correction.v1' ? 'a correction taught' : 'an outcome corroborated'} ${cellId} (source ${key}; my learned mass is now ${mag.toFixed(3)}) · seq ${d.seq}`);
    }
  }
  lines.push('');

  // ── Growth pressure (anatomy under strain — proposals only, receipted) ──
  if (growthProposals.length > 0) {
    lines.push('## growth pressure');
    for (const g of growthProposals) {
      const op = String(g.payload?.['op'] ?? '?');
      const targets = Array.isArray(g.payload?.['targetCellIds']) ? (g.payload['targetCellIds'] as string[]).join(', ') : '?';
      const trial = g.payload?.['shadowTrial'] as { clusterCapture?: number; eventsTried?: number } | undefined;
      lines.push(`- my anatomy strains: I proposed **${op}** on ${targets}`
        + (trial?.eventsTried !== undefined ? ` (shadow trial over ${trial.eventsTried} of my own events${trial.clusterCapture !== undefined ? `, cluster capture ${(trial.clusterCapture * 100).toFixed(0)}%` : ''})` : '')
        + ` — nothing changes unless an operator agrees · seq ${g.seq}`);
    }
    lines.push('');
  }

  // ── Open expectations ──
  const open: Array<{ cellId: string; p: Prediction }> = [];
  for (const cell of cells) {
    for (const p of cell.predictions as Prediction[]) {
      if (p.resolvedAt === undefined) open.push({ cellId: cell.id, p });
    }
  }
  if (open.length > 0) {
    lines.push('## open expectations');
    for (const { cellId, p } of open.slice(0, 6)) {
      lines.push(`- [${cellId}] ${p.claim.slice(0, 100)} (horizon ${p.horizon})`);
    }
    lines.push('');
  }

  // ── The air (latest physical readings, receipts included) ──
  const baro = [...transitions].reverse().find((t) => String(t.sourceRef).startsWith('baro.'));
  const shifts = transitions.filter((t) => String(t.sourceRef).startsWith('baro.shift'));
  if (baro !== undefined) {
    lines.push('## the air');
    lines.push(`- ${String(baro.sourceRef).split(':').slice(1).join(':')} · seq ${baro.seq}`);
    for (const s of shifts) {
      lines.push(`- pressure moved: ${String(s.sourceRef).split(':').slice(1).join(':')} · seq ${s.seq}`);
    }
    lines.push('');
  }

  lines.push(`_every claim above cites its receipt; nothing here is canonical state, and I do not read my own journal._`);
  return lines.join('\n');
}
