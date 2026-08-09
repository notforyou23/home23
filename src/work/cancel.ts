import { TERMINAL_WORK_STATUSES, type AsyncWorkRecord } from './types.js';
import type { WorkRegistry } from './registry.js';

export type WorkCancelOutcome =
  | { status: 'accepted'; work: AsyncWorkRecord }
  | { status: 'not_found' }
  | { status: 'already_terminal'; work: AsyncWorkRecord };

export interface WorkCancelDeps {
  registry: WorkRegistry;
  cancelCodingJob: (jobId: string) => Promise<void>;
  stopChat: (chatId: string) => boolean;
  warn?: (message: string) => void;
}

/** Request cancellation without waiting for the underlying process to settle. */
export function requestAsyncWorkCancel(
  deps: WorkCancelDeps,
  workId: string,
): WorkCancelOutcome {
  const work = deps.registry.get(workId);
  if (!work) return { status: 'not_found' };
  if (TERMINAL_WORK_STATUSES.has(work.status)) {
    return { status: 'already_terminal', work };
  }

  deps.registry.requestCancel(work.workId);
  if (work.resultHandle.type === 'coding_job') {
    const jobId = work.resultHandle.jobId;
    try {
      void deps.cancelCodingJob(jobId).catch((error) =>
        (deps.warn ?? console.warn)(`[work] cancel of ${jobId} failed: ${error instanceof Error ? error.message : String(error)}`));
    } catch (error) {
      (deps.warn ?? console.warn)(`[work] cancel of ${jobId} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    deps.stopChat(work.resultHandle.chatId);
  }
  return { status: 'accepted', work };
}
