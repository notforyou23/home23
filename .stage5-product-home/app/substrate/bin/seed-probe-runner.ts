/**
 * seed-probe-runner — the LIVE-ABLATION-PROTOCOL's probe instrument.
 *
 *   node seed-probe-runner.ts <developedDir> <twinDir> <workDir> <probesJson>
 *
 * Runs the four preregistered probe procedures (P1 routing, P2 admission,
 * P3 trust drive, P4 silence) against BOTH arms. Each probe runs on FRESH
 * copies of each arm (no cross-probe contamination); the source arm dirs are
 * never written. Probe events are synthetic, event-timed after the branch
 * point, byte-identical across arms, no lobe anywhere. Outcomes are read
 * from each work copy's ledger (and, for P3, corroborated by the
 * stateHashAfter fields of the transition receipts). Results print as one
 * JSON document — the outcome table's raw material.
 *
 * The probes file carries the concrete prefixes derived from the developed
 * arm's OWN development receipts (learned = has receipted affinity/trust;
 * control = receipted BELOW the divert floor; neverSeen = absent from the
 * chain). The shapes are fixed by the protocol; only the prefixes are
 * instantiated from the lived chain.
 */

import { cpSync, rmSync, readFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SeedProcess } from '../src/seed.js';
import { SeedLedger } from '../src/ledger.js';
import type { SourceEvent, EventCategory } from '../src/types.js';

const [developedDir, twinDir, workDir, probesPath] = process.argv.slice(2).map((p) => resolve(p));
if (developedDir === undefined || twinDir === undefined || workDir === undefined || probesPath === undefined) {
  console.error('usage: seed-probe-runner <developedDir> <twinDir> <workDir> <probes.json>');
  process.exit(2);
}

interface ProbeSpec {
  learnedPrefixes: string[];
  controlPrefix: string;
  neverSeenPrefix: string;
  highTrustPrefix: string;
  taughtCellId: string;
  baseTime: string;
}
const spec = JSON.parse(readFileSync(probesPath, 'utf-8')) as ProbeSpec;

function freshArm(sourceDir: string, name: string): SeedProcess {
  const dir = join(workDir, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });
  cpSync(sourceDir, dir, { recursive: true });
  return SeedProcess.restore(dir);
}

let timeCounter = 0;
function nextTime(): string {
  timeCounter += 1;
  const base = Date.parse(spec.baseTime);
  return new Date(base + timeCounter * 60_000).toISOString();
}

function probeEvent(prefix: string, category: EventCategory, index: number, producedAt: string, targetCellId?: string): SourceEvent {
  return {
    eventId: `probe_${prefix}_${category}_${index}`,
    category,
    sourceAuthority: 'seed.adapter',
    sourceRef: `${prefix}:probe-${category}-${index}`,
    ...(targetCellId !== undefined ? { targetCellId } : {}),
    payload: { probe: true },
    producedAt,
  };
}

function lastRecords(dir: string, sinceSeq: number): Array<{ seq: number; category: string; payload: Record<string, unknown>; sourceRef: string; stateHashAfter?: string }> {
  return new SeedLedger(join(workDir, dir)).readAll()
    .filter((r) => r.seq > sinceSeq)
    .map((r) => ({ seq: r.seq, category: r.category, payload: r.payload, sourceRef: r.sourceRef, stateHashAfter: r.stateHashAfter }));
}

// ─── P1 Routing: learned prefixes in NON-native categories ───────────────────
function p1(): Record<string, unknown> {
  const results: Record<string, unknown>[] = [];
  const prefixes = [...spec.learnedPrefixes, spec.controlPrefix];
  for (const prefix of prefixes) {
    const d = freshArm(developedDir, 'p1-developed');
    const a = freshArm(twinDir, 'p1-twin');
    const t = nextTime();
    // Non-native category: these prefixes arrive natively as correction/
    // consequence; 'observation' is the counterfactual shape.
    const event = probeEvent(prefix, 'observation', 1, t);
    const dCell = d.transition({ ...event }).cellId;
    const aCell = a.transition({ ...event }).cellId;
    d.stop(); a.stop();
    results.push({ prefix, developedRouted: dCell, twinRouted: aCell, diverged: dCell !== aCell });
  }
  return { probe: 'P1-routing', results };
}

// ─── P2 Admission: identical pressure sequence, then one workspaceCycle ──────
function p2(): Record<string, unknown> {
  const prefix = spec.learnedPrefixes[0] as string;
  const d = freshArm(developedDir, 'p2-developed');
  const a = freshArm(twinDir, 'p2-twin');
  const seqD = d.getState().ledgerSeq;
  const seqA = a.getState().ledgerSeq;
  const times: string[] = [];
  for (let i = 0; i < 6; i++) times.push(nextTime());
  for (const arm of [d, a]) {
    for (let i = 0; i < 6; i++) {
      arm.transition(probeEvent(prefix, 'correction', i, times[i] as string));
    }
    arm.workspaceCycle(times[5] as string);
  }
  d.stop(); a.stop();
  const dOut = lastRecords('p2-developed', seqD).filter((r) => r.category === 'workspace' || r.category === 'silence');
  const aOut = lastRecords('p2-twin', seqA).filter((r) => r.category === 'workspace' || r.category === 'silence');
  return {
    probe: 'P2-admission',
    prefix,
    developed: dOut.map((r) => ({ seq: r.seq, kind: r.category, admitted: r.payload['admittedCellIds'], scores: r.payload['scores'] })),
    twin: aOut.map((r) => ({ seq: r.seq, kind: r.category, admitted: r.payload['admittedCellIds'], scores: r.payload['scores'] })),
  };
}

// ─── P3 Trust drive: pinned identical event, high-trust vs never-seen ────────
function p3(): Record<string, unknown> {
  const results: Record<string, unknown>[] = [];
  for (const prefix of [spec.highTrustPrefix, spec.neverSeenPrefix]) {
    const d = freshArm(developedDir, `p3-developed-${prefix.replace(/[^a-z0-9]/gi, '_')}`);
    const a = freshArm(twinDir, `p3-twin-${prefix.replace(/[^a-z0-9]/gi, '_')}`);
    const t = nextTime();
    const event = probeEvent(prefix, 'correction', 1, t, spec.taughtCellId);
    const dRes = d.transition({ ...event });
    const aRes = a.transition({ ...event });
    const dState = d.getCell(spec.taughtCellId)?.continuousState;
    const aState = a.getCell(spec.taughtCellId)?.continuousState;
    let normSq = 0;
    if (dState !== undefined && aState !== undefined) {
      for (let i = 0; i < dState.length; i++) normSq += ((dState[i] ?? 0) - (aState[i] ?? 0)) ** 2;
    }
    d.stop(); a.stop();
    results.push({
      prefix,
      divergenceNorm: Math.sqrt(normSq),
      developedStateHashAfter: dRes.stateHashAfter,
      twinStateHashAfter: aRes.stateHashAfter,
      hashesEqual: dRes.stateHashAfter === aRes.stateHashAfter,
    });
  }
  return { probe: 'P3-trust-drive', results };
}

// ─── P4 Silence: 10 low-signal periphery-category events ─────────────────────
function p4(): Record<string, unknown> {
  const d = freshArm(developedDir, 'p4-developed');
  const a = freshArm(twinDir, 'p4-twin');
  const times: string[] = [];
  for (let i = 0; i < 10; i++) times.push(nextTime());
  const counts: Record<string, { admissions: number; silences: number }> = {};
  for (const [name, arm] of [['developed', d], ['twin', a]] as const) {
    let admissions = 0;
    let silences = 0;
    for (let i = 0; i < 10; i++) {
      // 'proposal' has no anatomy role — static routing sends it to the
      // periphery. Low-signal: unfamiliar prefix, no target hint.
      arm.transition(probeEvent(spec.neverSeenPrefix, 'proposal', i, times[i] as string));
      const outcome = arm.workspaceCycle(times[i] as string);
      if (outcome.kind === 'workspace') admissions += 1;
      else silences += 1;
    }
    arm.stop();
    counts[name] = { admissions, silences };
  }
  return { probe: 'P4-silence', ...counts };
}

const report = {
  protocol: 'LIVE-ABLATION-PROTOCOL v1',
  spec,
  p1: p1(),
  p2: p2(),
  p3: p3(),
  p4: p4(),
};
console.log(JSON.stringify(report, null, 1));
