/**
 * Private forms (Cut 4): inquiries materialize from weighty intentions with
 * lineage to the receipts that appended them; growth proposals render
 * readable; deletion kills the form and ONLY the form — the cell, the
 * intention, and the chain remain; the manifest keeps a tombstone.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SeedProcess } from '../src/seed.js';
import { SeedLedger } from '../src/ledger.js';
import { materializeForms, deleteForm, readManifest, INQUIRY_MIN_MAGNITUDE } from '../src/forms.js';
import type { LobeAdapter } from '../src/lobe.js';
import type { SourceEvent, LobeResult, SerializedCell } from '../src/types.js';
import { TEST_ANATOMY } from './named-anatomy.js';

function makeDirs(t: { after(fn: () => void): void }): { stateDir: string; formsDir: string } {
  const stateDir = mkdtempSync(join(tmpdir(), 'substrate-forms-state-'));
  const formsDir = mkdtempSync(join(tmpdir(), 'substrate-forms-forms-'));
  t.after(() => { rmSync(stateDir, { recursive: true, force: true }); rmSync(formsDir, { recursive: true, force: true }); });
  return { stateDir, formsDir };
}

/** A lobe that proposes exactly one weighty intention on the admitted cell. */
function intentionLobe(description: string): LobeAdapter {
  return {
    id: 'lobe.intent',
    modelId: 'test',
    provider: 'test',
    invoke: (packet) => {
      const cellId = packet.activeCellIds[0] as string;
      const result: LobeResult = {
        observations: [],
        interpretations: [],
        predictions: [],
        stateDeltas: [{
          cellId,
          field: 'intentions.append',
          delta: { description, magnitude: 0.7, direction: 'investigate' },
          authority: 'propose',
        }],
        candidateForms: [],
        candidateActions: [],
        evidenceRefs: [],
        uncertainty: 0.4,
        modelReceipt: { modelId: 'test', provider: 'test', invokedAt: '1970-01-01T00:00:00.000Z', durationMs: 1, tokensIn: 1, tokensOut: 1 },
      };
      return Promise.resolve(result);
    },
  };
}

function checkpointCells(seed: SeedProcess, stateDir: string): SerializedCell[] {
  seed.checkpoint();
  const ckDir = join(stateDir, 'checkpoints');
  const names = readdirSync(ckDir).filter((n) => n.startsWith('ckpt_') && n.endsWith('.json')).sort();
  const manifest = JSON.parse(readFileSync(join(ckDir, names[names.length - 1] as string), 'utf-8')) as { cells: SerializedCell[] };
  return manifest.cells;
}

function liveALittle(seed: SeedProcess): void {
  for (let i = 0; i < 8; i++) {
    const event: SourceEvent = {
      eventId: `evt_${i}`,
      category: 'observation',
      sourceAuthority: 'seed.adapter',
      sourceRef: `baro.sample:r${i}`,
      payload: {},
      producedAt: `2026-08-07T20:0${i}:00.000Z`,
    };
    seed.transition(event);
  }
}

test('an intention with weight opens an inquiry form with lineage to its lobe receipt', async (t) => {
  const { stateDir, formsDir } = makeDirs(t);
  const seed = SeedProcess.initialize(stateDir, undefined, { anatomy: TEST_ANATOMY, reservoirSeed: 91, name: 'form-test' });
  liveALittle(seed);
  const outcome = seed.workspaceCycle('2026-08-07T20:09:00.000Z');
  assert.equal(outcome.kind, 'workspace');
  if (outcome.kind !== 'workspace') return;

  const description = 'find out whether pressure falls before the door opens';
  const recruited = await seed.recruitLobe(intentionLobe(description), outcome.packet, '2026-08-07T20:10:00.000Z');
  assert.equal(recruited.applied.length, 1, 'the intention landed');

  const cells = checkpointCells(seed, stateDir);
  const ledger = new SeedLedger(stateDir);
  const records = ledger.readAll();

  const { created } = materializeForms(formsDir, 'form-test', cells, records);
  assert.equal(created.length, 1, 'one inquiry opened');
  const form = created[0];
  assert.ok(form !== undefined);
  assert.equal(form.kind, 'inquiry');
  assert.equal(form.status, 'open');
  assert.ok(existsSync(join(formsDir, form.path)), 'the form file exists');

  // Lineage: every cited seq must be a real lobe receipt on the chain.
  assert.ok(form.lineageSeqs.length > 0, 'lineage recovered');
  for (const seq of form.lineageSeqs) {
    const record = records.find((r) => r.seq === seq);
    assert.ok(record !== undefined && record.category === 'lobe', `lineage seq ${seq} is a lobe receipt`);
  }
  const body = readFileSync(join(formsDir, form.path), 'utf-8');
  assert.ok(body.includes(description));
  assert.ok(body.includes(`seq ${form.lineageSeqs[0]}`), 'the form cites its receipt');

  // Idempotent: a second pass opens nothing new.
  assert.equal(materializeForms(formsDir, 'form-test', cells, records).created.length, 0);
});

test('weightless intentions get no stationery', async (t) => {
  const { stateDir, formsDir } = makeDirs(t);
  const seed = SeedProcess.initialize(stateDir, undefined, { anatomy: TEST_ANATOMY, reservoirSeed: 92, name: 'form-test' });
  liveALittle(seed);
  const outcome = seed.workspaceCycle('2026-08-07T20:09:00.000Z');
  if (outcome.kind !== 'workspace') return;

  const weightless: LobeAdapter = {
    ...intentionLobe('a passing whim'),
    invoke: async (packet) => {
      const r = await intentionLobe('a passing whim').invoke(packet);
      const delta = r.stateDeltas[0] as { delta: { magnitude: number } };
      delta.delta.magnitude = INQUIRY_MIN_MAGNITUDE - 0.1;
      return r;
    },
  };
  await seed.recruitLobe(weightless, outcome.packet, '2026-08-07T20:10:00.000Z');

  const cells = checkpointCells(seed, stateDir);
  const records = new SeedLedger(stateDir).readAll();
  assert.equal(materializeForms(formsDir, 'form-test', cells, records).created.length, 0);
});

test('deleting a form deletes ONLY the form — cell, intention, and chain survive; tombstone remains', async (t) => {
  const { stateDir, formsDir } = makeDirs(t);
  const seed = SeedProcess.initialize(stateDir, undefined, { anatomy: TEST_ANATOMY, reservoirSeed: 93, name: 'form-test' });
  liveALittle(seed);
  const outcome = seed.workspaceCycle('2026-08-07T20:09:00.000Z');
  if (outcome.kind !== 'workspace') return;
  await seed.recruitLobe(intentionLobe('the situation that generated it'), outcome.packet, '2026-08-07T20:10:00.000Z');

  const cells = checkpointCells(seed, stateDir);
  const ledger = new SeedLedger(stateDir);
  const records = ledger.readAll();
  const { created } = materializeForms(formsDir, 'form-test', cells, records);
  const form = created[0];
  assert.ok(form !== undefined);

  const hashBefore = seed.getState().stateHash;
  const seqBefore = seed.getState().ledgerSeq;
  const intentionsBefore = cells.flatMap((c) => c.intentions).length;

  assert.equal(deleteForm(formsDir, form.formId, '2026-08-07T21:00:00.000Z'), true);

  assert.ok(!existsSync(join(formsDir, form.path)), 'the form file is gone');
  const tombstone = readManifest(formsDir).find((e) => e.formId === form.formId);
  assert.ok(tombstone !== undefined && tombstone.status === 'deleted', 'the manifest remembers');
  assert.ok(tombstone.lineageSeqs.length > 0, 'even the tombstone keeps lineage');

  // The situation that generated the form is untouched.
  assert.equal(seed.getState().stateHash, hashBefore, 'seed state unmoved');
  assert.equal(seed.getState().ledgerSeq, seqBefore, 'no ledger writes from form deletion');
  const cellsAfter = checkpointCells(seed, stateDir);
  assert.equal(cellsAfter.flatMap((c) => c.intentions).length, intentionsBefore, 'the intention survives its form');
  assert.equal(new SeedLedger(stateDir).verifyChain().ok, true, 'chain intact');

  // Deleting twice is a no-op, not an error.
  assert.equal(deleteForm(formsDir, form.formId, '2026-08-07T21:01:00.000Z'), false);
});

test('receipted growth proposals materialize as readable forms', (t) => {
  const { stateDir, formsDir } = makeDirs(t);
  const seed = SeedProcess.initialize(stateDir, undefined, {
    reservoirSeed: 94,
    name: 'form-test',
    anatomy: [
      { id: 'contact.jtr', role: 'correction' },
      { id: 'world.pi', role: 'observation' },
      { id: 'work.house', role: 'consequence' },
      { id: 'frontier.becoming', role: 'interpretation' },
      { id: 'periphery.open-field', role: 'periphery' },
    ],
  });
  for (let i = 0; i < 60; i++) {
    const prefix = i % 2 === 0 ? 'baro.sample' : 'vitals.sample';
    const event: SourceEvent = {
      eventId: `evt_${i}`, category: 'observation', sourceAuthority: 'seed.adapter',
      sourceRef: `${prefix}:r${i}`, payload: {},
      producedAt: `2026-08-07T20:${String(10 + Math.floor(i / 6)).padStart(2, '0')}:${String((i % 6) * 10).padStart(2, '0')}.000Z`,
    };
    seed.transition(event);
    if (i > 0 && i % 9 === 0) seed.workspaceCycle(event.producedAt);
  }
  const proposals = seed.evaluateGrowth('2026-08-07T20:30:00.000Z');
  assert.ok(proposals.length > 0);

  const records = new SeedLedger(stateDir).readAll();
  const { created } = materializeForms(formsDir, 'form-test', [], records);
  const growthForms = created.filter((f) => f.kind === 'growth-proposal');
  assert.equal(growthForms.length, proposals.length, 'every proposal receipt becomes a form');
  const body = readFileSync(join(formsDir, growthForms[0]?.path ?? ''), 'utf-8');
  assert.ok(body.includes('shadow trial'), 'the form shows the trial');
  assert.ok(body.includes('rollback'), 'the form shows the rollback');
  assert.ok(body.includes('nothing applies without an operator'));
});
