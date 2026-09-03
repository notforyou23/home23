/**
 * Terminal pipeline for async work — the "Jerry report-back" step.
 *
 * Raw worker output is evidence, not the agent's conclusion. On successful
 * coding work with a human origin, a review turn runs in an isolated
 * `workreview:<workId>` chat (keeping the origin transcript clean of injected
 * prompts); the review's report is what reaches the human, with the single
 * push. Failures skip review and interrupt immediately. Every path appends a
 * durable receipt to the ORIGIN conversation and stamps deliveredAt exactly
 * once, so boot recovery can re-run this for undelivered terminal records.
 */
import { isHumanOrigin, type AsyncWorkKind, type AsyncWorkRecord } from './types.js';
import { deliverWorkReceipt, workPushBody, type ReceiptSinks } from './receipt-delivery.js';
import type { WorkRegistry } from './registry.js';
import type { AsyncWorkTerminalResult } from './types.js';

export interface CompletionDeps {
  registry: WorkRegistry;
  sinks: ReceiptSinks;
  /** Per-kind review switch. Defaults wired in home.ts: { coding: true, subagent: false, cron: false }. */
  review: Partial<Record<AsyncWorkKind, boolean>>;
  /** True while the given chat has an active run (review defers to live turns). */
  isChatBusy: (chatId: string) => boolean;
  waitForIdleMs: number;
  idlePollMs: number;
  /** Run a tracked turn in the given chat, resolving to the assistant's final text. */
  runReviewTurn: (chatId: string, prompt: string) => Promise<string>;
}

export function reviewPrompt(work: AsyncWorkRecord, evidence: string): string {
  return [
    `[async-work review] Work "${work.label}" (${work.workId}, kind: ${work.kind}) reported success.`,
    `Treat the evidence below as a claim, not a conclusion. Verify what you can cheaply`,
    `(coding_result, git diff/log in the job workspace, run a targeted check if fast), then`,
    `write the report you would send the owner: what changed, whether your verification`,
    `passed (say plainly if it did not or you could not check), where the work lives, and`,
    `what remains or needs their judgment. The report is your final message text.`,
    ``,
    `Evidence:`,
    evidence,
  ].join('\n');
}

async function waitForIdle(chatId: string, deps: CompletionDeps): Promise<boolean> {
  const deadline = Date.now() + deps.waitForIdleMs;
  while (Date.now() < deadline) {
    if (!deps.isChatBusy(chatId)) return true;
    await new Promise(resolve => setTimeout(resolve, deps.idlePollMs));
  }
  return !deps.isChatBusy(chatId);
}

/**
 * In-flight guard: deliveredAt is stamped only at the END of an async
 * pipeline run, so two overlapping calls for the same work item (live
 * job_finished listener racing boot reconciliation) would both pass the
 * deliveredAt check. Per-process set makes the second call a no-op.
 */
const deliveryInFlight = new Set<string>();

/**
 * Deliver a terminal work record. `receiptText` is the compact durable receipt
 * (built by the caller from the job receipt / sub-agent result). Never throws.
 */
export async function handleWorkCompletion(
  work: AsyncWorkRecord,
  result: string | AsyncWorkTerminalResult,
  deps: CompletionDeps,
): Promise<void> {
  if (deliveryInFlight.has(work.workId)) return;
  deliveryInFlight.add(work.workId);
  try {
    const current = deps.registry.get(work.workId) ?? work;
    if (current.deliveredAt) return;
    const receiptText = typeof result === 'string' ? result : result.receiptText;

    if (current.originChatId.startsWith('coordination:')) {
      const route = await deliverWorkReceipt(current, result, deps.sinks);
      // Missing or invalid producer wiring is recoverable. Leave deliveredAt
      // empty so boot reconciliation can retry after the bridge is restored.
      if (route !== 'coordination') return;
      deps.registry.update(current.workId, { deliveredAt: new Date().toISOString() });
      return;
    }

    const reviewWanted =
      current.status === 'completed' &&
      deps.review[current.kind] &&
      isHumanOrigin(current.originChatId);

    if (!reviewWanted) {
      await deliverWorkReceipt(current, result, deps.sinks);
      deps.registry.update(current.workId, { deliveredAt: new Date().toISOString() });
      return;
    }

    // Evidence lands durably first — no push yet; the report is the notification.
    deps.sinks.appendHistory(current.originChatId, receiptText);
    deps.registry.update(current.workId, { verification: 'pending' });

    let report: string | null = null;
    if (await waitForIdle(current.originChatId, deps)) {
      try {
        report = await deps.runReviewTurn(`workreview:${current.workId}`, reviewPrompt(current, receiptText));
      } catch (err) {
        console.warn(`[work] review turn failed for ${current.workId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (report && report.trim()) {
      deps.sinks.appendHistory(current.originChatId, report);
      if (/^-?\d+$/.test(current.originChatId)) {
        deps.sinks.sendTelegram?.(current.originChatId, report.slice(0, 4096));
      } else {
        deps.sinks.pushWork?.({
          chatId: current.originChatId,
          workId: current.workId,
          status: current.status,
          body: workPushBody(current),
        });
      }
      deps.registry.update(current.workId, { verification: 'reviewed', deliveredAt: new Date().toISOString() });
      return;
    }

    // Review could not run — the receipt itself becomes the notification.
    if (/^-?\d+$/.test(current.originChatId)) {
      deps.sinks.sendTelegram?.(current.originChatId, receiptText.slice(0, 4096));
    } else {
      deps.sinks.pushWork?.({
        chatId: current.originChatId,
        workId: current.workId,
        status: current.status,
        body: workPushBody(current),
      });
    }
    deps.registry.update(current.workId, { verification: 'skipped', deliveredAt: new Date().toISOString() });
  } catch (err) {
    console.warn(`[work] completion delivery failed for ${work.workId}: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    deliveryInFlight.delete(work.workId);
  }
}
