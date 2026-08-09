/**
 * NOW, composed from the life — the second Home23 v2 bootstrap cutover.
 *
 * A fresh session used to open on NOW.md alone: a cron-written MACHINE
 * snapshot (process counts, cron health). Useful telemetry — but it is the
 * machine's now, not the individual's. v2 opens every session on the
 * individual's OWN now, composed from his chain at that instant: where the
 * last contact left off, what he is on record expecting, what happened to
 * his body since, the freshest thought his mind wrote. The machine
 * snapshot files still follow — they are a different function (telemetry)
 * and remain honestly file-owned until the seed's estimates can carry
 * operational facts at freshness parity.
 *
 * Read-only; degraded-honest (young/absent seed → null and the bootstrap
 * is files-only, exactly as before). Event-time only.
 */

import { readSeedCheckpoint, readSeedLedgerTail } from './seed-context.js';

const DEFAULT_BUDGET = 1200;
/** Chain-seq window for "since last session" identity events (~½ day). */
const FRESH_WINDOW_SEQS = 150;
const CONTACT_LINES = 4;

export function composeSeedNow(stateDir: string, budget = DEFAULT_BUDGET): string | null {
  const checkpoint = readSeedCheckpoint(stateDir);
  if (checkpoint === null) return null;
  const tail = readSeedLedgerTail(stateDir);
  const headSeq = Math.max(checkpoint.ledgerSeq, ...tail.map((l) => l.seq), 0);

  // Where the last contact left off — continuity across the session gap.
  const contact = checkpoint.cells
    .flatMap((c) => c.realityRefs ?? [])
    .filter((r) => r.sourceRef.startsWith('conversation.') && typeof r.head === 'string' && r.head.length > 0)
    .sort((a, b) => a.observedAt.localeCompare(b.observedAt))
    .slice(-CONTACT_LINES)
    .map((r) => `- ${r.sourceRef.startsWith('conversation.jtr') ? 'jtr' : 'you'}: "${r.head}"`);

  // Standing commitments — open expectations are his to resolve.
  const open = checkpoint.cells
    .flatMap((c) => (c.predictions ?? []).filter((p) => p.resolvedAt === undefined).map((p) => ({ cell: c.id, ...p })))
    .slice(0, 3)
    .map((p) => `- [${p.cell}] "${p.claim.slice(0, 120)}" (confidence ${p.confidence}, horizon ${p.horizon})`);

  // Body/identity events since roughly the last stretch of chain time.
  const since: string[] = [];
  for (const line of tail) {
    if (headSeq - line.seq > FRESH_WINDOW_SEQS) continue;
    if (line.category !== 'act') continue;
    const p = line.payload;
    if (typeof p['operatorDecision'] === 'string') {
      const reason = typeof p['reason'] === 'string' ? ` — "${p['reason']}"` : '';
      since.push(`- ${String(p['authorizedBy'] ?? 'the operator')} ${String(p['operatorDecision'])} your ${String(p['op'] ?? 'change')}${reason}`);
    } else if (p['growthApplication'] !== undefined || p['organExcision'] !== undefined) {
      since.push(`- your body changed: receipted ${String(p['op'] ?? 'growth')}`);
    }
  }

  // The freshest thought his mind wrote into state.
  let freshest: string | null = null;
  for (const line of tail) {
    if (line.category !== 'lobe') continue;
    const deltas = line.payload['appliedDeltas'];
    if (!Array.isArray(deltas)) continue;
    for (const d of deltas as Array<{ cellId?: string; field?: string; delta?: Record<string, unknown> }>) {
      const claim = d.delta?.['claim'];
      if (typeof claim === 'string') {
        const verb = d.field === 'predictions.append' ? 'expect' : 'believe';
        freshest = `- you currently ${verb}: [${d.cellId ?? '?'}] ${claim.slice(0, 140)}`;
      }
    }
  }

  if (contact.length === 0 && open.length === 0 && since.length === 0 && freshest === null) return null;

  const sections: string[][] = [
    [`NOW (lived) — where your life stands as this session opens (chain seq ${headSeq}).`],
  ];
  if (contact.length > 0) sections.push(['Last contact:', ...contact]);
  if (since.length > 0) sections.push(['Since then:', ...since]);
  if (freshest !== null) sections.push(['Freshest thought:', freshest]);
  if (open.length > 0) sections.push(['You are on the record expecting:', ...open]);

  let kept = sections.slice();
  const render = (s: string[][]): string => s.map((sec) => sec.join('\n')).join('\n\n');
  let text = render(kept);
  while (text.length > budget && kept.length > 1) {
    kept = kept.slice(0, -1);
    text = render(kept);
  }
  if (text.length > budget) text = `${text.slice(0, budget - 1)}…`;
  return text;
}
