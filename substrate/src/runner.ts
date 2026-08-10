/**
 * SeedRunner — the resident shadow process (Cut 2).
 *
 * Wires the Seed's metabolism to live Home23 reality through read-only source
 * adapters. Lifecycle:
 *
 *   start(): restore from the last checkpoint if the Seed exists, else
 *            initialize and immediately checkpoint (so restore always has a
 *            floor). Adapter cursors live in the Seed's own state dir.
 *   tick():  one poll — pull events, transition each (receipted), commit the
 *            adapter cursor after each receipt, run a workspace cycle every
 *            workspaceEveryN transitions (anchored to the last event's
 *            producedAt — event-time, not wall clock), checkpoint every
 *            checkpointEveryN transitions.
 *   run():   tick on an interval until stop().
 *   stop():  final checkpoint + stop receipt. Restart resumes exactly.
 *
 * The runner holds NO model credentials. Lobe recruitment (optional) uses an
 * injected LobeAdapter — by default the runner recruits nothing.
 */

import { writeFileSync, readFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { SeedProcess } from './seed.js';
import { SeedProcess as Seed } from './seed.js';
import { SeedLedger } from './ledger.js';
import { EventLedgerTailAdapter } from './adapters/event-ledger-tail.js';
import type { TailedSourceEvent, TailSourceType } from './adapters/event-ledger-tail.js';
import type { LobeAdapter } from './lobe.js';
import type { WorkspaceOutcome, AnatomyCellSpec } from './types.js';

export interface SeedRunnerOptions {
  stateDir: string;
  sourcePath: string;
  pollMs?: number;
  /** Run a workspace cycle after this many transitions (default 8). */
  workspaceEveryN?: number;
  /** Checkpoint after this many transitions (default 32). */
  checkpointEveryN?: number;
  /** Stop after this many total transitions (transient/proof runs). */
  maxEvents?: number;
  /** Start reading the source from its end minus this many bytes. */
  backfillBytes?: number;
  fromEnd?: boolean;
  /** Additional read-only streams (relationship ledger, worker runs, …).
   * Events from all sources merge in event-time order each tick. */
  extraSources?: Array<{
    sourcePath: string;
    sourceType: TailSourceType;
    id: string;
    backfillBytes?: number;
  }>;
  /** Birth-only: anatomy and name recorded in the genesis. Ignored when the
   * stateDir already holds a Seed (anatomy is identity — it never changes on
   * restore). */
  anatomy?: readonly AnatomyCellSpec[];
  name?: string;
  /** growth.v2 birth property: governed self-application (crystallize-only,
   * gated, covenanted). Ignored on restore — recorded in genesis at birth. */
  selfFormation?: boolean;
  /** Optional lobe to recruit when a workspace admission happens. */
  lobe?: LobeAdapter;
  /** Minimum wall-clock ms between lobe recruitments (resident spend guard;
   * an operational throttle, not seed state — every recruitment that DOES
   * happen is fully receipted, so replay is unaffected). Default 0. */
  lobeMinIntervalMs?: number;
  /** How long one recruitment may take before it's receipted as a timeout.
   * Default 30s suits a direct model call; broker-mediated transports
   * (SEED_LOBE=file) stack broker poll + model latency and need more. */
  lobeTimeoutMs?: number;
  log?: (line: string) => void;
}

export interface TickReport {
  pulled: number;
  transitioned: number;
  workspaceOutcomes: Array<WorkspaceOutcome['kind']>;
  lobeRecruitments: number;
  checkpoints: number;
}

export class SeedRunner {
  private seed: SeedProcess | null = null;
  private adapters: EventLedgerTailAdapter[] = [];
  private transitionsSinceWorkspace = 0;
  private transitionsSinceCheckpoint = 0;
  private totalTransitions = 0;
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private wake: (() => void) | null = null;
  private lastLobeAtMs = 0;
  private _dreamDeferralLogged = false;
  private lockPath: string | null = null;
  private readonly log: (line: string) => void;

  constructor(private readonly opts: SeedRunnerOptions) {
    this.log = opts.log ?? (() => {});
  }

  get seedProcess(): SeedProcess {
    if (this.seed === null) throw new Error('runner not started');
    return this.seed;
  }

  /**
   * MECHANICAL fork guard (added 2026-08-08 after clay's stillbirth: two
   * runners on one stateDir interleaved appends and forked the chain — the
   * fail-closed restore caught it, but the guard must exist BEFORE the
   * damage, not after). One exclusive lock per stateDir: a second runner
   * REFUSES loudly; a stale lock (dead pid) is taken over.
   */
  private acquireRunnerLock(): void {
    const lockPath = join(this.opts.stateDir, '.runner.lock');
    mkdirSync(this.opts.stateDir, { recursive: true });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
        this.lockPath = lockPath;
        return;
      } catch {
        let holder = NaN;
        try { holder = Number(readFileSync(lockPath, 'utf-8').trim()); } catch { /* unreadable */ }
        let alive = false;
        if (Number.isFinite(holder) && holder > 0) {
          try { process.kill(holder, 0); alive = true; } catch { alive = false; }
        }
        if (alive) {
          throw new Error(
            `stateDir ${this.opts.stateDir} is HELD by live runner pid ${holder} — `
            + 'two writers fork the chain; refusing to start (never two live instances)',
          );
        }
        try { unlinkSync(lockPath); } catch { /* raced */ }
      }
    }
    throw new Error(`could not acquire runner lock at ${lockPath}`);
  }

  start(): void {
    if (this.seed !== null) return;
    this.acquireRunnerLock();
    if (SeedLedger.exists(this.opts.stateDir)) {
      this.seed = Seed.restore(this.opts.stateDir);
      this.log(`restored seed ${this.seed.getState().seedId} at ledgerSeq ${this.seed.getState().ledgerSeq}`);
    } else {
      this.seed = Seed.initialize(this.opts.stateDir, undefined, {
        anatomy: this.opts.anatomy,
        name: this.opts.name,
        selfFormation: this.opts.selfFormation,
      });
      // Immediate checkpoint: restore() must always have a floor, even if the
      // process dies before the first cadence checkpoint.
      this.seed.checkpoint();
      this.log(`initialized seed ${this.seed.getState().seedId}`);
    }
    this.adapters = [
      new EventLedgerTailAdapter({
        sourcePath: this.opts.sourcePath,
        cursorDir: this.opts.stateDir,
        fromEnd: this.opts.fromEnd,
        backfillBytes: this.opts.backfillBytes,
        log: this.log,
      }),
      ...(this.opts.extraSources ?? []).map((src) =>
        new EventLedgerTailAdapter({
          sourcePath: src.sourcePath,
          sourceType: src.sourceType,
          id: src.id,
          cursorDir: this.opts.stateDir,
          fromEnd: this.opts.fromEnd,
          backfillBytes: src.backfillBytes,
          log: this.log,
        }),
      ),
    ];
    for (const adapter of this.adapters) {
      this.log(`tailing [${adapter.id}] ${'sourcePath' in this.opts ? '' : ''}from offset ${adapter.currentOffset}`);
    }
  }

  /**
   * Operator inbox: typed operator decisions (declines) appended to
   * <stateDir>/operator-inbox.jsonl by the operator's instrument reach the
   * individual THROUGH its own living process — the runner lock forbids
   * side-writes to the chain, so this is the door. Cursor-tracked,
   * at-least-once; a decline already receipted is skipped by seq.
   */
  private consumeOperatorInbox(): void {
    if (this.seed === null) return;
    const inboxPath = join(this.opts.stateDir, 'operator-inbox.jsonl');
    const cursorPath = join(this.opts.stateDir, 'operator-inbox.cursor');
    let raw = '';
    try { raw = readFileSync(inboxPath, 'utf-8'); } catch { return; }
    let offset = 0;
    try { offset = Number(readFileSync(cursorPath, 'utf-8').trim()) || 0; } catch { /* first read */ }
    if (offset >= raw.length) return;
    const fresh = raw.slice(offset);
    const lastNewline = fresh.lastIndexOf('\n');
    if (lastNewline < 0) return;
    for (const line of fresh.slice(0, lastNewline).split('\n')) {
      if (line.trim() === '') continue;
      try {
        const cmd = JSON.parse(line) as { action?: string; proposalSeq?: number; authorizedBy?: string; reason?: string };
        if (cmd.action === 'decline' && typeof cmd.proposalSeq === 'number' && typeof cmd.authorizedBy === 'string') {
          const result = this.seed.recordOperatorDecision(cmd.proposalSeq, 'declined', cmd.authorizedBy, cmd.reason ?? '');
          this.log(`operator: DECLINED proposal seq ${cmd.proposalSeq} (${result.proposalKey}) by ${cmd.authorizedBy} · act seq ${result.actSeq}`);
        }
      } catch (error) {
        this.log(`operator inbox: skipped bad line (${(error as Error).message.slice(0, 80)})`);
      }
    }
    writeFileSync(cursorPath, String(offset + lastNewline + 1), 'utf-8');
  }

  /** One poll cycle. Returns what happened — the caller (or test) decides
   * whether that constitutes progress. */
  async tick(): Promise<TickReport> {
    if (this.seed === null || this.adapters.length === 0) throw new Error('runner not started');
    this.consumeOperatorInbox();
    const report: TickReport = { pulled: 0, transitioned: 0, workspaceOutcomes: [], lobeRecruitments: 0, checkpoints: 0 };

    // Pull from every source, merge in EVENT-TIME order (deterministic
    // tiebreak: adapter id, then file offset). Cursors commit per adapter at
    // the end of the tick, up to each adapter's contiguous processed prefix —
    // a crash mid-tick re-delivers the batch (at-least-once, as designed).
    const perAdapter = this.adapters.map((adapter) => ({ adapter, events: adapter.pullSync() }));
    const merged = perAdapter
      .flatMap(({ adapter, events }) => events.map((event) => ({ adapter, event })))
      .sort((a, b) =>
        a.event.producedAt.localeCompare(b.event.producedAt)
        || a.adapter.id.localeCompare(b.adapter.id)
        || (a.event.endOffset - b.event.endOffset));
    report.pulled = merged.length;
    const processed = new Set<string>();

    for (const { event } of merged) {
      if (this.opts.maxEvents !== undefined && this.totalTransitions >= this.opts.maxEvents) break;
      const result = this.seed.transition(event);
      processed.add(event.eventId);
      this.totalTransitions++;
      this.transitionsSinceWorkspace++;
      this.transitionsSinceCheckpoint++;
      report.transitioned++;
      this.log(`transition seq=${result.seq} cell=${result.cellId} ref=${event.sourceRef}`);

      // dream.v1 (REM): a transition that ended a quiet gap marked a
      // pending dream — the mind works the residue at waking. Fires
      // promptly (not on workspace cadence), under the same lobe spend
      // guard. v1 requires at least one admissible cell; a silence outcome
      // dissolves the dream honestly (sub-threshold deep-sleep dreaming is
      // future work, and the silence receipt already explains itself).
      if (this.opts.lobe !== undefined && this.seed.hasPendingDream()) {
        const minInterval = this.opts.lobeMinIntervalMs ?? 0;
        const sinceLast = Date.now() - this.lastLobeAtMs;
        if (sinceLast >= minInterval) {
          const dream = this.seed.consumePendingDream();
          if (dream !== null) {
            const outcome = this.seed.workspaceCycle(event.producedAt);
            report.workspaceOutcomes.push(outcome.kind);
            if (outcome.kind === 'workspace') {
              this.lastLobeAtMs = Date.now();
              const packet = { ...outcome.packet, dream };
              this.log(`dream: waking after ~${Math.round(dream.quietSeconds / 60)}min quiet — working the residue [${packet.activeCellIds.join(', ')}]`);
              const lobeOutcome = await this.seed.recruitLobe(this.opts.lobe, packet, event.producedAt, this.opts.lobeTimeoutMs ?? 30_000);
              report.lobeRecruitments++;
              this.log(`dream lobe ${this.opts.lobe.id}: applied=${lobeOutcome.applied.length} rejected=${lobeOutcome.rejected.length}${lobeOutcome.error !== undefined ? ` error=${lobeOutcome.error}` : ''}`);
            } else {
              this.log('dream dissolved — nothing admissible at waking (silence receipted)');
            }
          }
        } else if (!this._dreamDeferralLogged) {
          // The dream STAYS pending — the guard delays it, never eats it
          // (bobby lost nine dreams to the old consume-on-defer).
          this._dreamDeferralLogged = true;
          this.log(`dream deferred by lobe guard (${Math.round((minInterval - sinceLast) / 1000)}s remaining) — it stays pending until the guard opens`);
        }
      } else {
        this._dreamDeferralLogged = false;
      }

      if (this.transitionsSinceWorkspace >= (this.opts.workspaceEveryN ?? 8)) {
        this.transitionsSinceWorkspace = 0;
        const outcome = this.seed.workspaceCycle(event.producedAt);
        report.workspaceOutcomes.push(outcome.kind);
        this.log(`workspace: ${outcome.kind}${outcome.kind === 'workspace' ? ` [${outcome.packet.activeCellIds.join(', ')}]` : ''}`);
        if (outcome.kind === 'workspace' && this.opts.lobe !== undefined) {
          const minInterval = this.opts.lobeMinIntervalMs ?? 0;
          const sinceLast = Date.now() - this.lastLobeAtMs;
          if (sinceLast >= minInterval) {
            this.lastLobeAtMs = Date.now();
            const lobeOutcome = await this.seed.recruitLobe(this.opts.lobe, outcome.packet, event.producedAt, this.opts.lobeTimeoutMs ?? 30_000);
            report.lobeRecruitments++;
            this.log(`lobe ${this.opts.lobe.id}: applied=${lobeOutcome.applied.length} rejected=${lobeOutcome.rejected.length}${lobeOutcome.error !== undefined ? ` error=${lobeOutcome.error}` : ''}`);
          } else {
            this.log(`lobe throttled (${Math.round((minInterval - sinceLast) / 1000)}s remaining)`);
          }
        }
      }
      if (this.transitionsSinceCheckpoint >= (this.opts.checkpointEveryN ?? 32)) {
        this.transitionsSinceCheckpoint = 0;
        // Growth pressure rides the checkpoint cadence: same chain, zero
        // mutations, receipted proposals only. Detectors have their own
        // floors and cooldowns — most evaluations receipt nothing.
        const proposals = this.seed.evaluateGrowth(event.producedAt);
        for (const proposal of proposals) {
          this.log(`growth: proposed ${proposal.op} on ${proposal.targetCellIds.join(', ')} (window ${proposal.evidence.windowTransitions}t/${proposal.evidence.windowAdmissions}a)`);
        }
        this.seed.checkpoint();
        report.checkpoints++;
        this.log('checkpoint (cadence)');
      }
    }

    // Commit each adapter's cursor to its contiguous processed prefix.
    for (const { adapter, events } of perAdapter) {
      let lastContiguous: number | null = null;
      for (const event of events) {
        if (!processed.has(event.eventId)) break;
        lastContiguous = event.endOffset;
      }
      if (lastContiguous !== null) adapter.commit(lastContiguous);
    }
    return report;
  }

  /** Poll until stop() (or until maxEvents is reached). */
  async run(): Promise<void> {
    this.start();
    this.running = true;
    while (this.running) {
      const report = await this.tick();
      if (this.opts.maxEvents !== undefined && this.totalTransitions >= this.opts.maxEvents) {
        this.log(`maxEvents ${this.opts.maxEvents} reached`);
        break;
      }
      if (report.pulled === 0) {
        // The wake handle lets requestStop() resolve this sleep immediately —
        // clearing the timer alone would leave the promise pending forever and
        // turn a graceful SIGINT into a SIGKILL past the final checkpoint.
        // The timer is deliberately NOT unref'd: during idle it is the only
        // live handle, and an unref'd timer lets Node exit code-0 mid-sleep —
        // the resident becomes a crash-looping cron (observed live: 50
        // one-second lifetimes before this line was fixed).
        await new Promise<void>((resolve) => {
          this.wake = resolve;
          this.timer = setTimeout(resolve, this.opts.pollMs ?? 2000);
        });
        this.wake = null;
      }
    }
    this.stop();
  }

  /** Final checkpoint + stop receipt. Idempotent-ish: safe to call once after run(). */
  stop(): void {
    this.running = false;
    if (this.timer !== null) clearTimeout(this.timer);
    if (this.seed !== null) {
      const checkpointId = this.seed.stop();
      this.log(`stopped at checkpoint ${checkpointId}, ledgerSeq ${this.seed.getState().ledgerSeq}`);
      this.seed = null;
      this.adapters = [];
    }
    if (this.lockPath !== null) {
      try { unlinkSync(this.lockPath); } catch { /* already gone */ }
      this.lockPath = null;
    }
  }

  requestStop(): void {
    this.running = false;
    if (this.timer !== null) clearTimeout(this.timer);
    this.wake?.();
  }
}
