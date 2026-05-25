import type { CronJob } from '../scheduler/cron.js';

interface SchedulerLike {
  getJobs(): CronJob[];
  saveJob(job: CronJob): void;
}

interface AgencyKernelLike {
  intake(input: Record<string, unknown>): Promise<{ pursuit?: { id?: string } }>;
  recordConsequence?(input: Record<string, unknown>): Promise<unknown> | unknown;
}

export interface CronBootcampAuditResult {
  checked: number;
  bound: number;
  skippedAlreadyBound: number;
  skippedNonRecurring: number;
  failed: Array<{ jobId: string; reason: string }>;
}

function isEnabledRecurring(job: CronJob): boolean {
  return Boolean(job.enabled && (job.schedule?.kind === 'cron' || job.schedule?.kind === 'every'));
}

function hasPursuitBinding(job: CronJob): boolean {
  return Boolean(job.agency?.pursuitId);
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
