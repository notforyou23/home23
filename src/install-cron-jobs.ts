import type { HomeConfig } from './types.js';
import type { CronJob } from './scheduler/cron.js';
import {
  mergeExternalCronJobPreservingAgency,
} from './agency/cron-bootcamp.js';

type SchedulerLike = {
  getJob(id: string): CronJob | null | undefined;
  addJob(job: CronJob): void;
  saveJob(job: CronJob): void;
};

export function shouldLoadInstallCronJobs(config: Pick<HomeConfig, 'scheduler'>): boolean {
  return config.scheduler?.loadInstallJobs !== false;
}

export function mergeInstallCronJobs({
  scheduler,
  jobs,
}: {
  scheduler: SchedulerLike;
  jobs: CronJob[];
}): { added: number; updated: number; total: number } {
  let added = 0;
  let updated = 0;
  for (const job of jobs) {
    const existing = scheduler.getJob(job.id);
    if (!existing) {
      scheduler.addJob(job);
      added += 1;
    } else {
      scheduler.saveJob(mergeExternalCronJobPreservingAgency(existing, job));
      updated += 1;
    }
  }
  return { added, updated, total: jobs.length };
}
