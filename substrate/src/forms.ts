/**
 * Private forms (Cut 4 — the rest of expression).
 *
 * A form is an artifact the Seed produces about its own situation: an
 * inquiry it wants to pursue, a growth proposal rendered readable. Forms are
 * EXPRESSION with lineage — every form's manifest cites the receipts that
 * motivated it — and they live entirely inside a forms directory that is
 * structurally sandboxed: nothing in this module takes a state dir, so form
 * code cannot touch seed state even by bug. Forms are never canonical
 * state, never a sense source, and deleting a form deletes only the form:
 * the cell, the intention, and every receipt that motivated it remain. The
 * manifest keeps a tombstone so even deletion has lineage.
 *
 * Deterministic: materialization is a pure function of (cells, window
 * records, existing manifest). No model. No wall clock in content — forms
 * are dated by the event-time of the receipts that motivated them.
 */

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { LedgerRecord, SerializedCell, IntentionTension } from './types.js';

export interface FormManifestEntry {
  formId: string;
  kind: 'inquiry' | 'growth-proposal';
  title: string;
  /** Ledger seqs this form grew out of — inspectable lineage to live contact. */
  lineageSeqs: number[];
  cellId?: string;
  /** Event-time of the newest lineage receipt. */
  asOf: string;
  status: 'open' | 'deleted';
  path: string;
  deletedAt?: string;
}

const MANIFEST_NAME = 'manifest.jsonl';

/** An intention must carry at least this magnitude to open an inquiry —
 * passing whims don't get stationery. */
export const INQUIRY_MIN_MAGNITUDE = 0.5;

export function formsManifestPath(formsDir: string): string {
  return join(formsDir, MANIFEST_NAME);
}

export function readManifest(formsDir: string): FormManifestEntry[] {
  const path = formsManifestPath(formsDir);
  if (!existsSync(path)) return [];
  const entries = new Map<string, FormManifestEntry>();
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      const entry = JSON.parse(line) as FormManifestEntry;
      entries.set(entry.formId, entry);
    } catch { /* torn tail line — later entries rewrite it */ }
  }
  return [...entries.values()];
}

function appendManifest(formsDir: string, entry: FormManifestEntry): void {
  mkdirSync(formsDir, { recursive: true });
  appendFileSync(formsManifestPath(formsDir), JSON.stringify(entry) + '\n', 'utf-8');
}

/** Delete a form — the FILE dies, the lineage does not. Never touches any
 * seed state (this module cannot: it has no path to it). */
export function deleteForm(formsDir: string, formId: string, deletedAtEventTime: string): boolean {
  const existing = readManifest(formsDir).find((e) => e.formId === formId);
  if (existing === undefined || existing.status === 'deleted') return false;
  try { unlinkSync(join(formsDir, existing.path)); } catch { /* already gone */ }
  appendManifest(formsDir, { ...existing, status: 'deleted', deletedAt: deletedAtEventTime });
  return true;
}

// ─── Inquiry forms: intentions with weight become projects ───────────────────

interface IntentionLineage {
  intention: IntentionTension;
  cellId: string;
  /** Seq of the lobe receipt whose applied deltas appended this intention,
   * if it is in the window; falls back to the receipts we can prove. */
  lineageSeqs: number[];
}

function findIntentionLineage(records: readonly LedgerRecord[], description: string): number[] {
  const seqs: number[] = [];
  for (const record of records) {
    if (record.category !== 'lobe') continue;
    const applied = record.payload?.['appliedDeltas'];
    if (!Array.isArray(applied)) continue;
    for (const delta of applied) {
      const d = (delta as { delta?: { description?: unknown } }).delta;
      if (d !== undefined && typeof d === 'object' && (d as { description?: unknown }).description === description) {
        seqs.push(record.seq);
      }
    }
  }
  return seqs;
}

function composeInquiryForm(lineage: IntentionLineage, seedName: string): string {
  const { intention, cellId, lineageSeqs } = lineage;
  const lines: string[] = [];
  lines.push(`# inquiry — ${intention.description.slice(0, 80)}`);
  lines.push('');
  lines.push(`opened by **${seedName}** from situation **${cellId}**, as of ${intention.createdAt}`);
  lines.push('');
  lines.push('## the intention');
  lines.push(`- ${intention.description}`);
  lines.push(`- magnitude ${intention.magnitude.toFixed(2)}, direction: ${intention.direction}`);
  lines.push(`- tension ${intention.tensionId}, still open: ${intention.open}`);
  lines.push('');
  lines.push('## lineage');
  if (lineageSeqs.length > 0) {
    lines.push(`- appended by recruited thought · seq ${lineageSeqs.join(', ')}`);
  } else {
    lines.push('- carried in from an earlier window (receipt outside this window; the chain has it)');
  }
  lines.push(`- consequences so far: ${intention.consequenceRefs.length === 0 ? 'none yet' : intention.consequenceRefs.join(', ')}`);
  lines.push('');
  lines.push('## open questions');
  lines.push('- what evidence would raise or retire this intention?');
  lines.push('- which of my senses bears on it?');
  lines.push('');
  lines.push('_a form is expression with lineage — deleting it deletes nothing that made it._');
  return lines.join('\n');
}

// ─── Growth-proposal forms: receipted proposals rendered readable ────────────

function composeGrowthForm(record: LedgerRecord, seedName: string): string {
  const p = record.payload as {
    op?: string; targetCellIds?: string[]; evidence?: Record<string, unknown>;
    shadowTrial?: Record<string, unknown>; proposedAnatomy?: Array<{ id?: string; role?: string }>;
    beforeAnatomy?: Array<{ id?: string; role?: string }>;
  };
  const lines: string[] = [];
  lines.push(`# growth proposal — ${String(p.op ?? '?')} · seq ${record.seq}`);
  lines.push('');
  lines.push(`**${seedName}** proposes: **${String(p.op ?? '?')}** on ${Array.isArray(p.targetCellIds) ? p.targetCellIds.join(', ') : '?'}`);
  lines.push('');
  lines.push('## evidence (typed, from my own chain)');
  for (const [key, value] of Object.entries(p.evidence ?? {})) {
    lines.push(`- ${key}: ${typeof value === 'object' ? JSON.stringify(value) : String(typeof value === 'number' ? Number(value.toFixed?.(3) ?? value) : value)}`);
  }
  lines.push('');
  lines.push('## shadow trial (real router, my actual window, zero state touched)');
  for (const [key, value] of Object.entries(p.shadowTrial ?? {})) {
    lines.push(`- ${key}: ${typeof value === 'number' ? value.toFixed(3) : String(value)}`);
  }
  lines.push('');
  lines.push('## proposed anatomy');
  for (const cell of p.proposedAnatomy ?? []) lines.push(`- ${String(cell.id)} (${String(cell.role)})`);
  lines.push('');
  lines.push('## rollback');
  lines.push('the before-anatomy is carried verbatim in the receipt — applying and');
  lines.push('reverting are both fully specified. nothing applies without an operator.');
  for (const cell of p.beforeAnatomy ?? []) lines.push(`- ${String(cell.id)} (${String(cell.role)})`);
  lines.push('');
  lines.push(`_proposed from repeated real pressure, not instruction · receipt seq ${record.seq}_`);
  return lines.join('\n');
}

// ─── Materialization pass (idempotent; the expression organ calls this) ──────

export interface MaterializeResult {
  created: FormManifestEntry[];
}

export function materializeForms(
  formsDir: string,
  seedName: string,
  cells: readonly SerializedCell[],
  windowRecords: readonly LedgerRecord[],
): MaterializeResult {
  const manifest = readManifest(formsDir);
  const known = new Set(manifest.map((e) => e.formId));
  const created: FormManifestEntry[] = [];

  const privateDir = join(formsDir, 'private');
  const growthDir = join(formsDir, 'growth');

  for (const cell of cells) {
    for (const intention of cell.intentions) {
      if (!intention.open || intention.magnitude < INQUIRY_MIN_MAGNITUDE) continue;
      const formId = `inquiry-${intention.tensionId}`;
      if (known.has(formId)) continue;
      const lineageSeqs = findIntentionLineage(windowRecords, intention.description);
      const relPath = join('private', `${formId}.md`);
      mkdirSync(privateDir, { recursive: true });
      writeFileSync(join(formsDir, relPath), composeInquiryForm({ intention, cellId: cell.id, lineageSeqs }, seedName), 'utf-8');
      const entry: FormManifestEntry = {
        formId,
        kind: 'inquiry',
        title: intention.description.slice(0, 80),
        lineageSeqs,
        cellId: cell.id,
        asOf: intention.createdAt,
        status: 'open',
        path: relPath,
      };
      appendManifest(formsDir, entry);
      created.push(entry);
      known.add(formId);
    }
  }

  for (const record of windowRecords) {
    if (record.category !== 'proposal' || record.sourceRef !== 'growth.pressure') continue;
    const formId = `growth-${record.seq}`;
    if (known.has(formId)) continue;
    const relPath = join('growth', `${formId}.md`);
    mkdirSync(growthDir, { recursive: true });
    writeFileSync(join(formsDir, relPath), composeGrowthForm(record, seedName), 'utf-8');
    const asOf = record.payload?.['asOf'];
    const entry: FormManifestEntry = {
      formId,
      kind: 'growth-proposal',
      title: `${String(record.payload?.['op'] ?? '?')} ${Array.isArray(record.payload?.['targetCellIds']) ? (record.payload['targetCellIds'] as string[]).join(', ') : ''}`.trim(),
      lineageSeqs: [record.seq],
      asOf: typeof asOf === 'string' ? asOf : '',
      status: 'open',
      path: relPath,
    };
    appendManifest(formsDir, entry);
    created.push(entry);
    known.add(formId);
  }

  return { created };
}
