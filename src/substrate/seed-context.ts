/**
 * Seed → situational awareness (the integration the program was aimed at).
 *
 * Composes a compact SUBSTRATE block from the agent's Seed — the persistent,
 * receipted, developmental organism that metabolizes the agent's real life
 * (proven causal under ablation, 2026-08-08). This is lived memory entering
 * the turn: not files retrieved, but carried state — which situations are
 * pressurized, what attention his corrections have earned, which sources
 * hold causal trust, what he has publicly committed to expecting.
 *
 * Read-only by construction: this module reads the Seed's newest checkpoint
 * and ledger tail off disk and writes NOTHING. The Seed's membrane is not
 * involved because no capability is exercised — the chain and checkpoints
 * are the public record of the individual. Degraded-honest: if the state
 * dir is missing or unreadable, returns null (absence, never fabrication).
 * Tolerates torn ledger tails (the state may be a live mirror).
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

interface SeedCell {
  id: string;
  generation: number;
  workspacePressure: number;
  energy: { current: number };
  uncertainty: number;
  estimates: Array<{ claim: string; confidence: number }>;
  predictions: Array<{ claim: string; confidence: number; horizon: string; createdAt: string; resolvedAt?: string; error?: number }>;
  intentions: Array<{ description: string; magnitude: number; open: boolean }>;
}

interface LedgerLine {
  seq: number;
  category: string;
  sourceRef: string;
  payload: Record<string, unknown>;
}

const DEFAULT_BUDGET = 1800;
const LEDGER_TAIL_BYTES = 256 * 1024;

function newestCheckpoint(stateDir: string): { cells: SeedCell[]; ledgerSeq: number } | null {
  const ckDir = join(stateDir, 'checkpoints');
  if (!existsSync(ckDir)) return null;
  const names = readdirSync(ckDir).filter((n) => n.startsWith('ckpt_') && n.endsWith('.json')).sort();
  const newest = names[names.length - 1];
  if (!newest) return null;
  try {
    const manifest = JSON.parse(readFileSync(join(ckDir, newest), 'utf-8')) as { cells?: SeedCell[]; ledgerSeq?: number };
    if (!Array.isArray(manifest.cells)) return null;
    return { cells: manifest.cells, ledgerSeq: manifest.ledgerSeq ?? 0 };
  } catch {
    return null;
  }
}

function ledgerTail(stateDir: string): LedgerLine[] {
  const path = join(stateDir, 'seed-ledger.jsonl');
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return [];
  }
  if (raw.length > LEDGER_TAIL_BYTES) raw = raw.slice(-LEDGER_TAIL_BYTES);
  const lines: LedgerLine[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed = JSON.parse(line) as LedgerLine;
      if (typeof parsed.seq === 'number' && typeof parsed.category === 'string') lines.push(parsed);
    } catch { /* torn head/tail of a live mirror — skip */ }
  }
  return lines;
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

/** Compose the SUBSTRATE situational block, or null when no honest state exists. */
export function composeSeedSituation(stateDir: string, budget = DEFAULT_BUDGET): string | null {
  const checkpoint = newestCheckpoint(stateDir);
  if (checkpoint === null) return null;
  const tail = ledgerTail(stateDir);

  const lines: string[] = [];

  // Carried situations, ranked by presence — the organism's own attention map.
  const ranked = [...checkpoint.cells].sort(
    (a, b) => (b.workspacePressure + b.energy.current) - (a.workspacePressure + a.energy.current),
  );
  lines.push('Your carried situations (from your Seed — receipts, not summaries):');
  for (const cell of ranked) {
    const open = cell.intentions.filter((i) => i.open).length;
    lines.push(
      `- ${cell.id}: pressure ${pct(cell.workspacePressure)}, energy ${pct(cell.energy.current)}, `
      + `gen ${cell.generation}, uncertainty ${pct(cell.uncertainty)}`
      + (open > 0 ? `, ${open} open intention(s)` : ''),
    );
  }

  // Earned attention: what development receipts say matters, by rule.
  const dev = tail.filter((l) => l.category === 'development');
  if (dev.length > 0) {
    const byRule = new Map<string, number>();
    const trust = new Map<string, number>();
    for (const d of dev) {
      const rule = String(d.payload['rule'] ?? 'other');
      byRule.set(rule, (byRule.get(rule) ?? 0) + 1);
      const key = d.payload['trustKey'];
      const value = d.payload['trust'];
      if (typeof key === 'string' && typeof value === 'number' && value !== 1) {
        trust.set(key, Math.max(trust.get(key) ?? 0, value));
      }
    }
    const ruleSummary = [...byRule.entries()].map(([r, n]) => `${r} ×${n}`).join(', ');
    lines.push(`Recent development (window of ${tail.length} records): ${ruleSummary}.`);
    const trusted = [...trust.entries()].filter(([k]) => k !== 'self.prediction').sort((a, b) => b[1] - a[1]).slice(0, 4);
    if (trusted.length > 0) {
      lines.push(`Sources that have earned causal trust: ${trusted.map(([k, v]) => `${k} (${v.toFixed(2)})`).join(', ')}.`);
    }
  }

  // Open expectations — commitments the Seed holds, with deadlines.
  const openPredictions = checkpoint.cells.flatMap((cell) =>
    cell.predictions
      .filter((p) => p.resolvedAt === undefined)
      .map((p) => ({ cellId: cell.id, ...p })),
  );
  if (openPredictions.length > 0) {
    lines.push('Open expectations (your Seed is on the record — resolve honestly when reality answers):');
    for (const p of openPredictions.slice(0, 4)) {
      lines.push(`- [${p.cellId}] ${p.claim.slice(0, 110)} (confidence ${p.confidence}, horizon ${p.horizon}, since ${p.createdAt})`);
    }
  }

  // Strongest held estimates — beliefs with confidence, not vibes.
  const estimates = checkpoint.cells
    .flatMap((cell) => cell.estimates.map((e) => ({ cellId: cell.id, ...e })))
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 3);
  if (estimates.length > 0) {
    lines.push('Strongest current estimates:');
    for (const e of estimates) {
      lines.push(`- [${e.cellId}] ${e.claim.slice(0, 110)} (${e.confidence})`);
    }
  }

  lines.push(`(Seed chain at seq ${checkpoint.ledgerSeq}; this block is read-only expression of receipted state.)`);

  let text = lines.join('\n');
  if (text.length > budget) text = `${text.slice(0, budget - 1)}…`;
  return text;
}
