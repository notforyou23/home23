/**
 * Cron agentTurn ↔ WorkRegistry seam.
 * Created when the isolated `cron-<jobId>` turn starts; completed in finally.
 */
import type { WorkRegistry } from './registry.js';
import type { AsyncWorkRecord } from './types.js';

export function cronChatId(jobId: string): string {
  return `cron-${jobId}`;
}

export function startCronAgentTurn(
  registry: WorkRegistry,
  job: { id: string; name?: string },
): AsyncWorkRecord {
  const chatId = cronChatId(job.id);
  return registry.create({
    kind: 'cron',
    originChatId: chatId,
    label: (job.name && job.name.trim()) || job.id,
    resultHandle: { type: 'cron_chat', chatId },
  });
}

export function finishCronAgentTurn(
  registry: WorkRegistry,
  workId: string,
  result: { status: 'ok' | 'error'; error?: string },
): AsyncWorkRecord {
  return registry.complete(
    workId,
    result.status === 'ok' ? 'completed' : 'failed',
    result.error,
  );
}
