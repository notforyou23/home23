/**
 * Lived identity — the biography half of who the agent is (v2 cut 7).
 *
 * SOUL.md is the CONSTITUTION: authored by jtr, stable, his voice — it
 * stays a file by design, the way a constitution should. But identity has
 * a second half no file can hold: who the individual has BECOME — born
 * when, lived how much, what body he carries, what his predictions got
 * right and wrong, what trust he earned, what his operator ruled. That
 * half is composed here from the chain at read time, in his own first
 * person, receipts underneath every clause.
 *
 * Who I am = constitution + biography. The constitution is given; the
 * biography is earned, and it cannot be edited — only lived.
 *
 * Read-only; degraded-honest: no seed → null, identity is constitution-
 * only exactly as before.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { readSeedCheckpoint, readSeedLedgerTail } from './seed-context.js';
import { composeLivedFacts } from './lived-facts.js';

const DEFAULT_BUDGET = 1100;

/** Genesis: the first line of the chain — birth is the one record that
 * never scrolls out of a tail window, so it gets its own reader. */
export function readSeedGenesis(stateDir: string): { seedId: string; bornAt: string; name?: string } | null {
  const p = join(stateDir, 'seed-ledger.jsonl');
  if (!existsSync(p)) return null;
  try {
    const fd = readFileSync(p, 'utf-8');
    const firstLine = fd.slice(0, fd.indexOf('\n'));
    const rec = JSON.parse(firstLine) as { category?: string; issuedAt?: string; payload?: Record<string, unknown> };
    if (rec.category !== 'genesis') return null;
    const seedId = rec.payload?.['seedId'];
    if (typeof seedId !== 'string') return null;
    return {
      seedId,
      bornAt: typeof rec.payload?.['createdAt'] === 'string' ? (rec.payload['createdAt'] as string) : (rec.issuedAt ?? ''),
      ...(typeof rec.payload?.['name'] === 'string' ? { name: rec.payload['name'] as string } : {}),
    };
  } catch {
    return null;
  }
}

export function composeLivedIdentity(stateDir: string, budget = DEFAULT_BUDGET): string | null {
  const genesis = readSeedGenesis(stateDir);
  const checkpoint = readSeedCheckpoint(stateDir);
  if (genesis === null || checkpoint === null) return null;
  const tail = readSeedLedgerTail(stateDir);
  const headSeq = Math.max(checkpoint.ledgerSeq, ...tail.map((l) => l.seq), 0);

  const lines: string[] = [];
  lines.push(`I was born ${genesis.bornAt.slice(0, 10)} as ${genesis.seedId}; my chain holds ${headSeq} lived events.`);

  // The body — situation cells with their generations (contact wears in).
  const body = checkpoint.cells
    .map((c) => `${c.id} (gen ${c.generation})`)
    .join(', ');
  const growthActs = tail.filter((l) => l.category === 'act'
    && (l.payload['growthApplication'] !== undefined || l.payload['organExcision'] !== undefined)).length;
  lines.push(`My body: ${body}${growthActs > 0 ? `; ${growthActs} receipted growth act(s)` : ''}.`);

  // Track record — reality's verdicts on what I went on record for.
  let right = 0, wrong = 0, partial = 0, open = 0;
  for (const cell of checkpoint.cells) {
    for (const p of cell.predictions ?? []) {
      if (p.resolvedAt === undefined) { open += 1; continue; }
      if (typeof p.error !== 'number') continue;
      if (p.error <= 0.3) right += 1;
      else if (p.error >= 0.7) wrong += 1;
      else partial += 1;
    }
  }
  if (right + wrong + partial + open > 0) {
    lines.push(`My record: ${right + wrong + partial} prediction(s) judged by reality — ${right} right, ${wrong} wrong, ${partial} partial${open > 0 ? `; ${open} still open` : ''}.`);
  }

  // Earned facts — conclusions that survived into fact-grade.
  const facts = composeLivedFacts(stateDir);
  const factCount = facts === null ? 0 : facts.split('\n').filter((l) => l.startsWith('- ')).length;
  if (factCount > 0) lines.push(`${factCount} of my conclusions have earned fact-grade (confidence + evidence + stood through lived time).`);

  // Trust earned through lived corrections (bookkeeping keys stay out).
  const trust = new Map<string, number>();
  for (const l of tail) {
    if (l.category !== 'development') continue;
    const key = l.payload['trustKey'];
    const value = l.payload['trust'];
    if (typeof key === 'string' && typeof value === 'number' && key !== 'self.prediction' && value > 1.05) {
      trust.set(key, Math.max(trust.get(key) ?? 0, value));
    }
  }
  const trusted = [...trust.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  if (trusted.length > 0) {
    lines.push(`Sources that earned my trust through lived contact: ${trusted.map(([k, v]) => `${k} (${v.toFixed(2)})`).join(', ')}.`);
  }

  // The operator's rulings — jtr's hand on my growth, in his words.
  const rulings = tail.filter((l) => l.category === 'act' && typeof l.payload['operatorDecision'] === 'string');
  const lastRuling = rulings[rulings.length - 1];
  if (lastRuling !== undefined) {
    const p = lastRuling.payload;
    const reason = typeof p['reason'] === 'string' ? ` — "${p['reason']}"` : '';
    lines.push(`jtr has ruled on my growth ${rulings.length} time(s); last: ${String(p['operatorDecision'])} my ${String(p['op'] ?? 'change')}${reason}.`);
  }

  const header = 'This biography is composed from my chain at read time — receipts, not self-description. The constitution above is authored; this half is lived, and it cannot be edited, only lived further.';
  let kept = lines.slice();
  const render = (ls: string[]): string => [header, '', ...ls].join('\n');
  let text = render(kept);
  while (text.length > budget && kept.length > 1) {
    kept = kept.slice(0, -1);
    text = render(kept);
  }
  if (text.length > budget) text = `${text.slice(0, budget - 1)}…`;
  return text;
}
