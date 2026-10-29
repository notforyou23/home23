/**
 * Lossless recovery for a valid, fully receipted Seed tail.
 *
 * Recovery never edits the ledger. It replays the tail from the last valid
 * checkpoint in an isolated temporary branch, compares every generated state
 * hash with the resident receipts, and only then appends a new checkpoint
 * boundary to the resident chain. Source events are recovered from the same
 * read-only streams used by the runner; model output is replayed from its full
 * lobe receipt and is never invoked again.
 */

import { createHash } from 'node:crypto';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { CheckpointManager } from '../src/checkpoint.js';
import { EventLedgerTailAdapter, type TailSourceType } from '../src/adapters/event-ledger-tail.js';
import { SeedLedger } from '../src/ledger.js';
import { SeedProcess } from '../src/seed.js';
import { RESIDENT_RESOURCE_BUDGET } from '../src/resource.js';
import type { LobeAdapter } from '../src/lobe.js';
import type { LedgerRecord, LobeResult, SourceEvent, WorkspacePacket } from '../src/types.js';

interface SourceSpec { type: TailSourceType; path: string }

function die(message: string): never { throw new Error(message); }
function hashLine(line: string): string { return createHash('sha256').update(line).digest('hex'); }

function args(): { stateDir: string; sources: SourceSpec[]; apply: boolean; backupDir?: string } {
  const values = process.argv.slice(2);
  const stateDir = values.shift();
  if (!stateDir) die('usage: seed-recover-tail <stateDir> --source <type>:<absolute-path> [--source ...] [--apply --backup-dir <dir>]');
  const sources: SourceSpec[] = [];
  let apply = false;
  let backupDir: string | undefined;
  while (values.length) {
    const flag = values.shift();
    if (flag === '--apply') apply = true;
    else if (flag === '--backup-dir') backupDir = values.shift() ?? die('--backup-dir needs a path');
    else if (flag === '--source') {
      const value = values.shift() ?? die('--source needs <type>:<absolute-path>');
      const colon = value.indexOf(':');
      if (colon < 1) die(`invalid source: ${value}`);
      sources.push({ type: value.slice(0, colon) as TailSourceType, path: value.slice(colon + 1) });
    } else die(`unknown argument: ${flag}`);
  }
  if (apply && !backupDir) die('--apply requires --backup-dir');
  return { stateDir: resolve(stateDir), sources, apply, ...(backupDir ? { backupDir: resolve(backupDir) } : {}) };
}

function readLines(path: string): string[] {
  return readFileSync(path, 'utf8').split('\n').filter((line) => line.trim().length > 0);
}

function collectEvents(specs: SourceSpec[], scratch: string, wanted: Set<string>): Map<string, SourceEvent> {
  const found = new Map<string, SourceEvent>();
  for (const [index, spec] of specs.entries()) {
    if (!existsSync(spec.path)) continue;
    const adapter = new EventLedgerTailAdapter({
      sourcePath: spec.path, sourceType: spec.type, id: `recovery_${index}`,
      cursorDir: scratch, fromEnd: false, maxBatch: 4096,
    });
    for (;;) {
      const events = adapter.pullSync();
      if (events.length === 0) break;
      for (const event of events) if (wanted.has(event.eventId)) found.set(event.eventId, event);
      adapter.commit(events.at(-1)!.endOffset);
      if (found.size === wanted.size) return found;
    }
  }
  return found;
}

function lobeResult(record: LedgerRecord): LobeResult {
  const p = record.payload;
  const advisory = p['advisory'] as Record<string, unknown> | undefined;
  return {
    observations: (advisory?.['observations'] ?? []) as LobeResult['observations'],
    interpretations: (advisory?.['interpretations'] ?? []) as LobeResult['interpretations'],
    predictions: (advisory?.['predictions'] ?? []) as LobeResult['predictions'],
    stateDeltas: (p['appliedDeltas'] ?? []) as LobeResult['stateDeltas'],
    candidateForms: [], candidateActions: [],
    uncertainty: Number(p['lobeUncertainty']),
    modelReceipt: p['modelReceipt'] as LobeResult['modelReceipt'],
  };
}

function assertReplay(original: LedgerRecord[], replayed: LedgerRecord[]): void {
  if (replayed.length !== original.length) die(`replay receipt count mismatch: expected ${original.length}, got ${replayed.length}`);
  for (let i = 0; i < original.length; i++) {
    const expected = original[i]!; const actual = replayed[i]!;
    if (actual.category !== expected.category
      || actual.stateHashBefore !== expected.stateHashBefore
      || actual.stateHashAfter !== expected.stateHashAfter) {
      die(`replay diverged at resident seq ${expected.seq}: expected ${expected.category} ${expected.stateHashAfter ?? '-'}, got ${actual.category} ${actual.stateHashAfter ?? '-'}`);
    }
  }
}

async function main(): Promise<void> {
  const options = args();
  const lock = join(options.stateDir, '.runner.lock');
  if (existsSync(lock)) die(`runner lock exists: ${lock}`);
  const ledgerPath = join(options.stateDir, 'seed-ledger.jsonl');
  const lines = readLines(ledgerPath);
  const records = lines.map((line) => JSON.parse(line) as LedgerRecord);
  const chain = new SeedLedger(options.stateDir).verifyChain();
  if (!chain.ok) die(`resident chain is invalid (${chain.errors.length} errors); refusing recovery`);

  const checkpoints = new CheckpointManager(options.stateDir).list();
  const latest = checkpoints[0] ?? die('no checkpoint available');
  const tail = records.filter((record) => record.seq > latest.ledgerSeq);
  if (tail.length === 0) die('ledger already ends at a checkpoint boundary');
  const checkpointReceipt = tail[0];
  if (checkpointReceipt?.category !== 'checkpoint' || checkpointReceipt.payload['checkpointId'] !== latest.checkpointId) {
    die(`latest checkpoint is not followed by its own receipt at seq ${latest.ledgerSeq + 1}`);
  }
  const life = tail.slice(1);
  if (life.length === 0) die('only the accepted checkpoint receipt follows the manifest; no recovery needed');
  const wanted = new Set(life.filter((r) => r.category === 'transition').map((r) => String(r.payload['eventId'])));

  const scratchRoot = mkdtempSync(join(tmpdir(), 'home23-seed-recover-'));
  const scratch = join(scratchRoot, 'seed');
  try {
    mkdirSync(join(scratch, 'checkpoints'), { recursive: true });
    const manifestPath = join(options.stateDir, 'checkpoints', `${latest.checkpointId}.json`);
    cpSync(manifestPath, join(scratch, 'checkpoints', basename(manifestPath)));
    writeFileSync(join(scratch, 'checkpoints', 'CHECKPOINT_INDEX.json'), JSON.stringify({
      schema: 'home23.seed.checkpoint-index.v1', version: 1, checkpoints: [latest],
    }, null, 2));
    // Preserve the checkpoint receipt so replayed sequence-dependent IDs and
    // hashes occupy the exact resident sequence numbers.
    writeFileSync(join(scratch, 'seed-ledger.jsonl'), `${lines.slice(0, latest.ledgerSeq + 1).join('\n')}\n`);

    const events = collectEvents(options.sources, scratchRoot, wanted);
    const missing = [...wanted].filter((id) => !events.has(id));
    if (missing.length) die(`source evidence missing for ${missing.length} transition(s): ${missing.slice(0, 5).join(', ')}`);

    const seed = SeedProcess.restore(scratch, undefined, { budget: RESIDENT_RESOURCE_BUDGET });
    let packet: WorkspacePacket | undefined;
    for (const record of life) {
      if (record.category === 'transition') seed.transition(events.get(String(record.payload['eventId']))!);
      else if (record.category === 'workspace' || record.category === 'silence') {
        const outcome = seed.workspaceCycle(String(record.payload['asOf']));
        packet = outcome.kind === 'workspace' ? outcome.packet : undefined;
      } else if (record.category === 'lobe') {
        if (!packet) die(`lobe receipt at seq ${record.seq} has no replayed workspace packet`);
        const p = record.payload;
        const adapter: LobeAdapter = {
          id: String(p['lobeId']), modelId: String(p['modelId']), provider: String(p['provider']),
          invoke: async () => lobeResult(record),
        };
        await seed.recruitLobe(adapter, packet, String(p['asOf']), 30_000, record);
      }
    }
    const replayed = new SeedLedger(scratch).readFrom(latest.ledgerSeq + 2);
    assertReplay(life, replayed);
    const expectedHash = [...life].reverse().find((r) => r.stateHashAfter)?.stateHashAfter;
    if (!expectedHash || seed.getState().stateHash !== expectedHash) die('replayed head state hash does not match resident head receipt');
    const recoveryCheckpointId = seed.checkpoint();
    const recovered = JSON.parse(readFileSync(join(scratch, 'checkpoints', `${recoveryCheckpointId}.json`), 'utf8'));

    const head = records.at(-1)!;
    const verdict = { stateDir: options.stateDir, checkpointId: latest.checkpointId,
      checkpointSeq: latest.ledgerSeq, headSeq: head.seq, tailReceipts: life.length,
      headCursor: hashLine(lines.at(-1)!), stateHash: expectedHash, replayVerified: true, apply: options.apply };
    if (!options.apply) { console.log(JSON.stringify(verdict, null, 2)); return; }

    const backup = options.backupDir!;
    if (existsSync(backup)) die(`backup path already exists: ${backup}`);
    mkdirSync(backup, { recursive: true, mode: 0o700 });
    cpSync(ledgerPath, join(backup, 'seed-ledger.jsonl'));
    cpSync(join(options.stateDir, 'checkpoints', 'CHECKPOINT_INDEX.json'), join(backup, 'CHECKPOINT_INDEX.json'));
    writeFileSync(join(backup, 'provenance.json'), JSON.stringify(verdict, null, 2), { mode: 0o600 });

    const oldResources = recovered.resourceSnapshot;
    oldResources.ledgerBytes = readFileSync(ledgerPath).byteLength;
    const manager = new CheckpointManager(options.stateDir);
    const newId = manager.write({
      stateHash: recovered.stateHash, ledgerSeq: head.seq, ledgerCursor: hashLine(lines.at(-1)!),
      cells: recovered.cells, dispositions: recovered.dispositions,
      resourceSnapshot: oldResources, development: recovered.development,
      seedLastTransitionAt: recovered.seedLastTransitionAt, concern: recovered.concern,
    });
    new SeedLedger(options.stateDir).append({ category: 'checkpoint', sourceAuthority: 'seed.internal',
      sourceRef: records[0]!.payload['seedId'] as string,
      payload: { checkpointId: newId, stateHash: recovered.stateHash, ledgerSeq: head.seq } });
    console.log(JSON.stringify({ ...verdict, appliedCheckpointId: newId, backup }, null, 2));
  } finally {
    rmSync(scratchRoot, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
