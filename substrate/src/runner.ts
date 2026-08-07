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

import type { SeedProcess } from './seed.js';
import { SeedProcess as Seed } from './seed.js';
import { SeedLedger } from './ledger.js';
import { EventLedgerTailAdapter } from './adapters/event-ledger-tail.js';
import type { TailedSourceEvent } from './adapters/event-ledger-tail.js';
import type { LobeAdapter } from './lobe.js';
import type { WorkspaceOutcome } from './types.js';

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
  /** Optional lobe to recruit when a workspace admission happens. */
  lobe?: LobeAdapter;
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
  private adapter: EventLedgerTailAdapter | null = null;
  private transitionsSinceWorkspace = 0;
  private transitionsSinceCheckpoint = 0;
  private totalTransitions = 0;
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private readonly log: (line: string) => void;

  constructor(private readonly opts: SeedRunnerOptions) {
    this.log = opts.log ?? (() => {});
  }

  get seedProcess(): SeedProcess {
    if (this.seed === null) throw new Error('runner not started');
    return this.seed;
  }

  start(): void {
    if (this.seed !== null) return;
    if (SeedLedger.exists(this.opts.stateDir)) {
      this.seed = Seed.restore(this.opts.stateDir);
      this.log(`restored seed ${this.seed.getState().seedId} at ledgerSeq ${this.seed.getState().ledgerSeq}`);
    } else {
      this.seed = Seed.initialize(this.opts.stateDir);
      // Immediate checkpoint: restore() must always have a floor, even if the
      // process dies before the first cadence checkpoint.
      this.seed.checkpoint();
      this.log(`initialized seed ${this.seed.getState().seedId}`);
    }
    this.adapter = new EventLedgerTailAdapter({
      sourcePath: this.opts.sourcePath,
      cursorDir: this.opts.stateDir,
      fromEnd: this.opts.fromEnd,
      backfillBytes: this.opts.backfillBytes,
    });
    this.log(`tailing ${this.opts.sourcePath} from offset ${this.adapter.currentOffset}`);
  }

  /** One poll cycle. Returns what happened — the caller (or test) decides
   * whether that constitutes progress. */
  async tick(): Promise<TickReport> {
    if (this.seed === null || this.adapter === null) throw new Error('runner not started');
    const report: TickReport = { pulled: 0, transitioned: 0, workspaceOutcomes: [], lobeRecruitments: 0, checkpoints: 0 };

    const events: TailedSourceEvent[] = this.adapter.pullSync();
    report.pulled = events.length;

    for (const event of events) {
      if (this.opts.maxEvents !== undefined && this.totalTransitions >= this.opts.maxEvents) break;
      const result = this.seed.transition(event);
      this.adapter.commit(event.endOffset);
      this.totalTransitions++;
      this.transitionsSinceWorkspace++;
      this.transitionsSinceCheckpoint++;
      report.transitioned++;
      this.log(`transition seq=${result.seq} cell=${result.cellId} ref=${event.sourceRef}`);

      if (this.transitionsSinceWorkspace >= (this.opts.workspaceEveryN ?? 8)) {
        this.transitionsSinceWorkspace = 0;
        const outcome = this.seed.workspaceCycle(event.producedAt);
        report.workspaceOutcomes.push(outcome.kind);
        this.log(`workspace: ${outcome.kind}${outcome.kind === 'workspace' ? ` [${outcome.packet.activeCellIds.join(', ')}]` : ''}`);
        if (outcome.kind === 'workspace' && this.opts.lobe !== undefined) {
          const lobeOutcome = await this.seed.recruitLobe(this.opts.lobe, outcome.packet, event.producedAt);
          report.lobeRecruitments++;
          this.log(`lobe ${this.opts.lobe.id}: applied=${lobeOutcome.applied.length} rejected=${lobeOutcome.rejected.length}${lobeOutcome.error !== undefined ? ` error=${lobeOutcome.error}` : ''}`);
        }
      }
      if (this.transitionsSinceCheckpoint >= (this.opts.checkpointEveryN ?? 32)) {
        this.transitionsSinceCheckpoint = 0;
        this.seed.checkpoint();
        report.checkpoints++;
        this.log('checkpoint (cadence)');
      }
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
        await new Promise<void>((resolve) => {
          this.timer = setTimeout(resolve, this.opts.pollMs ?? 2000);
          this.timer.unref?.();
        });
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
      this.adapter = null;
    }
  }

  requestStop(): void {
    this.running = false;
    if (this.timer !== null) clearTimeout(this.timer);
  }
}
