import type { CronJob, JobRunLogEntry } from '../scheduler/cron.js';

interface SchedulerLike {
  getJobs(): CronJob[];
  saveJob(job: CronJob): void;
  getRecentRuns?(jobId: string, limit?: number): JobRunLogEntry[];
}

interface AgencyKernelLike {
  intake?(input: Record<string, unknown>): Promise<{ pursuit?: { id?: string } }>;
  recordConsequence?(input: Record<string, unknown>): Promise<unknown> | unknown;
  pursuit?(id: string): { id?: string; status?: string; nextMove?: string; summary?: string } | null | undefined;
  config?: { mode?: string; cronBootcamp?: { retireEnabled?: boolean } };
}

export interface CronBootcampAuditResult {
  checked: number;
  bound: number;
  skippedAlreadyBound: number;
  skippedNonRecurring: number;
  failed: Array<{ jobId: string; reason: string }>;
}

export interface CronBootcampReviewResult {
  checked: number;
  kept: number;
  proposed: number;
  retired: number;
  skippedUnbound: number;
  skippedNonRecurring: number;
  failed: Array<{ jobId: string; reason: string }>;
}

function isEnabledRecurring(job: CronJob): boolean {
  return Boolean(job.enabled && (job.schedule?.kind === 'cron' || job.schedule?.kind === 'every'));
}

function hasPursuitBinding(job: CronJob): boolean {
  return Boolean(job.agency?.pursuitId);
}

function retireReason(job: CronJob, pursuit: { status?: string; nextMove?: string; summary?: string } | null | undefined): string | null {
  const status = String(pursuit?.status || '').toLowerCase();
  if (status === 'discarded') {
    return `bound pursuit ${job.agency?.pursuitId} was discarded by agency editor`;
  }
  if (status === 'closed') {
    return `bound pursuit ${job.agency?.pursuitId} reached its stop condition`;
  }
  const noConsequenceRuns = Number(job.state?.consecutiveNoConsequence || 0);
  if (noConsequenceRuns >= 3) {
    return `bound cron produced ${noConsequenceRuns} consecutive runs without satisfied consequence`;
  }
  return null;
}

function runLogEvidence(job: CronJob, scheduler: SchedulerLike): Array<Record<string, unknown>> {
  const runs = typeof scheduler.getRecentRuns === 'function' ? scheduler.getRecentRuns(job.id, 3) : [];
  return runs.slice(0, 3).map((run) => {
    const outcome = run.outcome && typeof run.outcome === 'object' ? run.outcome as unknown as Record<string, unknown> : {};
    const layers = outcome.layers && typeof outcome.layers === 'object' ? outcome.layers as Record<string, unknown> : {};
    const layerSummary = Object.entries(layers)
      .map(([name, value]) => {
        const status = value && typeof value === 'object' ? (value as Record<string, unknown>).status : null;
        return status ? `${name}:${status}` : null;
      })
      .filter(Boolean)
      .join(', ');
    return {
      type: 'cron_run_log_excerpt',
      ref: job.id,
      runId: run.runId || null,
      timestamp: run.timestamp || null,
      status: run.status || null,
      semanticStatus: outcome.semanticStatus || null,
      responsePreview: String(run.response || run.error || '').slice(0, 280),
      layers: layerSummary,
    };
  });
}

export function mergeExternalCronJobPreservingAgency(existing: CronJob, incoming: CronJob): CronJob {
  return {
    ...existing,
    ...incoming,
    state: existing.state || incoming.state,
    agency: incoming.agency || existing.agency,
  };
}

export async function auditExistingRecurringCronJobsForAgency({
  scheduler,
  kernel,
  now = new Date().toISOString(),
}: {
  scheduler: SchedulerLike;
  kernel: AgencyKernelLike;
  now?: string;
}): Promise<CronBootcampAuditResult> {
  const result: CronBootcampAuditResult = {
    checked: 0,
    bound: 0,
    skippedAlreadyBound: 0,
    skippedNonRecurring: 0,
    failed: [],
  };

  for (const job of scheduler.getJobs()) {
    result.checked += 1;
    if (!isEnabledRecurring(job)) {
      result.skippedNonRecurring += 1;
      continue;
    }
    if (hasPursuitBinding(job)) {
      result.skippedAlreadyBound += 1;
      continue;
    }

    try {
      if (!kernel.intake) {
        result.failed.push({ jobId: job.id, reason: 'agency kernel intake unavailable' });
        continue;
      }
      const intake = await kernel.intake({
        source: 'scheduler.cron.bootcamp',
        kind: 'cron_bootcamp_audit',
        summary: `Recurring cron "${job.name}" is running without resident agency pursuit binding.`,
        evidence: [
          {
            type: 'cron_job',
            ref: job.id,
            name: job.name,
            scheduleKind: job.schedule.kind,
            payloadKind: job.payload.kind,
          },
        ],
        authorityLevel: 'L2',
        desiredChangedFuture: `Recurring cron "${job.name}" is bound to a resident pursuit, demoted, or retired under agency bootcamp.`,
        nextMove: 'Review whether this recurring job still earns its place; keep, demote, repair, or retire it.',
        tags: ['cron', 'agency-bootcamp', 'legacy-recurring-work'],
        whyItMatters: 'Agency bootcamp forbids recurring work that does not connect to a resident pursuit.',
        currentTheory: 'This job predates the resident agency spine and needs explicit consequence accountability.',
        stopCondition: 'The cron is bound to a pursuit, demoted, or retired with a receipt.',
      });
      const pursuitId = intake.pursuit?.id;
      if (!pursuitId) {
        result.failed.push({ jobId: job.id, reason: 'agency intake did not return a pursuit id' });
        continue;
      }

      const updated: CronJob = {
        ...job,
        agency: {
          ...(job.agency || {}),
          pursuitId,
          charterRule: 'existing_recurring_cron_requires_pursuit',
          auditedAt: now,
          auditDecision: 'bound_existing_recurring_job',
        },
      };
      scheduler.saveJob(updated);
      result.bound += 1;

      await kernel.recordConsequence?.({
        at: now,
        source: 'scheduler.cron.bootcamp',
        pursuitId,
        status: 'applied',
        changeType: 'cron_bound_to_pursuit',
        summary: `Recurring cron "${job.name}" is now bound to resident pursuit ${pursuitId}.`,
        evidence: [
          {
            type: 'cron_job',
            ref: job.id,
            name: job.name,
            scheduleKind: job.schedule.kind,
            payloadKind: job.payload.kind,
          },
        ],
      });
    } catch (err) {
      result.failed.push({
        jobId: job.id,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}

export async function reviewBoundRecurringCronJobsForAgency({
  scheduler,
  kernel,
  now = new Date().toISOString(),
}: {
  scheduler: SchedulerLike;
  kernel: AgencyKernelLike;
  now?: string;
}): Promise<CronBootcampReviewResult> {
  const result: CronBootcampReviewResult = {
    checked: 0,
    kept: 0,
    proposed: 0,
    retired: 0,
    skippedUnbound: 0,
    skippedNonRecurring: 0,
    failed: [],
  };
  const liveMode = kernel.config?.mode === 'live' && kernel.config?.cronBootcamp?.retireEnabled === true;

  for (const job of scheduler.getJobs()) {
    result.checked += 1;
    if (!isEnabledRecurring(job)) {
      result.skippedNonRecurring += 1;
      continue;
    }
    if (!hasPursuitBinding(job)) {
      result.skippedUnbound += 1;
      continue;
    }

    try {
      const pursuitId = job.agency?.pursuitId || '';
      const pursuit = kernel.pursuit?.(pursuitId);
      const reason = retireReason(job, pursuit);
      if (!reason) {
        result.kept += 1;
        continue;
      }

      const evidence = [
        {
          type: 'cron_job',
          ref: job.id,
          name: job.name,
          scheduleKind: job.schedule.kind,
          payloadKind: job.payload.kind,
          lastSemanticStatus: job.state?.lastSemanticStatus || null,
          consecutiveNoConsequence: job.state?.consecutiveNoConsequence || 0,
        },
        {
          type: 'agency_pursuit',
          ref: pursuitId,
          status: pursuit?.status || 'unknown',
        },
        ...runLogEvidence(job, scheduler),
      ];

      if (liveMode) {
        const updated: CronJob = {
          ...job,
          enabled: false,
          agency: {
            ...(job.agency || {}),
            auditedAt: now,
            auditDecision: 'retired_by_agency_editor',
            retiredAt: now,
            retireReason: reason,
          },
        };
        scheduler.saveJob(updated);
        result.retired += 1;
        await kernel.recordConsequence?.({
          at: now,
          source: 'scheduler.cron.bootcamp',
          pursuitId,
          status: 'applied',
          changeType: 'cron_retired_by_editor',
          summary: `Recurring cron "${job.name}" was disabled because ${reason}.`,
          evidence,
        });
      } else {
        result.proposed += 1;
        await kernel.recordConsequence?.({
          at: now,
          source: 'scheduler.cron.bootcamp',
          pursuitId,
          status: 'proposed',
          changeType: 'cron_retirement_proposed',
          summary: `Recurring cron "${job.name}" should be disabled because ${reason}.`,
          evidence,
        });
      }
    } catch (err) {
      result.failed.push({
        jobId: job.id,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}
