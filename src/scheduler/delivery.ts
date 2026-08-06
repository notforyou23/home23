/**
 * COSMO Home 2.3 — Delivery Manager
 *
 * Handles delivering scheduler job results to channels
 * via the registered ChannelAdapter instances.
 * Supports single-channel (channel/to) and multi-channel (channels[]) delivery.
 */

import { appendFileSync, mkdirSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { randomUUID } from 'crypto';
import type { ChannelAdapter, OutgoingResponse } from '../channels/router.js';
import type { CronJob, JobResult } from './cron.js';
import type { DeliveryProfiles } from '../types.js';
import type { AttentionGate, OutboundSignal } from '../agent/attention/attention-gate.js';

export type { DeliveryProfiles };

// ─── DeliveryManager ─────────────────────────────────────────

export class DeliveryManager {
  private adapters: Map<string, ChannelAdapter>;
  private profiles: DeliveryProfiles;
  private eventLedgerPath: string;
  /**
   * Optional attention gate (Step 30). Scheduler deliveries are EXPLICIT jtr
   * config, so the gate here is dedup-only: a configured delivery is marked
   * explicitlyWatched (always surfaces) and the gate only suppresses an
   * identical repeat inside the dedupe window — it never withholds a delivery
   * jtr set up. Absent gate = original behavior, unchanged.
   */
  private gate: AttentionGate | null;

  constructor(adapters: Map<string, ChannelAdapter>, profiles: DeliveryProfiles = {}, gate: AttentionGate | null = null) {
    this.adapters = adapters;
    this.profiles = profiles;
    this.gate = gate;
    const home23Root = resolve(import.meta.dirname, '..', '..');
    const agentName = process.env.HOME23_AGENT ?? 'test-agent';
    this.eventLedgerPath = join(home23Root, 'instances', agentName, 'brain', 'event-ledger.jsonl');
  }

  /**
   * Deliver a job result to the configured channel(s).
   * Respects job.delivery.mode — if 'none' or missing, does nothing.
   * Supports profile (expanded from the profiles map), channels[] (multi), and channel/to (single).
   */
  async deliver(job: CronJob, result: JobResult): Promise<void> {
    if (!job.delivery || job.delivery.mode === 'none') {
      return;
    }

    if (job.delivery.mode === 'failures' && result.status !== 'error') {
      return;
    }

    const text = this.formatText(job, result);
    if (!text) {
      return;
    }

    // Attention gate (dedup-only for configured deliveries). A configured cron
    // delivery is explicitlyWatched → it always surfaces on first occurrence;
    // the only way the gate suppresses is an identical repeat within the window
    // (the "repetitive status update" the brief says to avoid). We deliberately
    // do NOT set isFailure here — a first failure surfaces via explicitlyWatched,
    // and identical repeated failures are what dedup is for.
    let gateSignal: OutboundSignal | null = null;
    if (this.gate) {
      gateSignal = {
        origin: 'cron',
        text,
        explicitlyWatched: true,
        kind: job.delivery?.mode === 'summary' ? 'summary' : undefined,
      };
      const verdict = this.gate.evaluate(gateSignal);
      if (verdict.decision === 'suppress') {
        console.log(`[delivery] Job ${job.id} suppressed by attention gate (${verdict.reason}${verdict.detail ? `: ${verdict.detail}` : ''})`);
        return;
      }
      // 'surface' (the normal path) and 'aggregate' both proceed to send here —
      // a jtr-configured delivery is never held. We arm dedup (record()) only
      // AFTER at least one adapter send succeeds (below), so a total send failure
      // leaves an identical retry eligible instead of self-suppressing for the
      // dedupe window.
    }

    const targets: Array<{ channel: string; to: string }> = [];

    if (job.delivery.profile) {
      const profile = this.profiles[job.delivery.profile];
      if (!profile) {
        console.warn(`[delivery] Job ${job.id} references unknown profile "${job.delivery.profile}"`);
      } else {
        for (const t of profile.channels) targets.push({ channel: t.channel, to: t.to });
      }
    } else if (job.delivery.channels && job.delivery.channels.length > 0) {
      for (const t of job.delivery.channels) {
        targets.push({ channel: t.channel, to: t.to });
      }
    } else if (job.delivery.channel) {
      targets.push({ channel: job.delivery.channel, to: job.delivery.to ?? 'scheduler' });
    }

    if (targets.length === 0) {
      console.warn(`[delivery] Job ${job.id} has delivery mode "${job.delivery.mode}" but no channel configured`);
      return;
    }

    let anyDelivered = false;
    for (const target of targets) {
      // 'auto' channel: pick the first available adapter
      const adapter = target.channel === 'auto'
        ? this.adapters.values().next().value
        : this.adapters.get(target.channel);

      if (!adapter) {
        console.warn(`[delivery] No adapter registered for channel "${target.channel}" (job ${job.id}), skipping`);
        continue;
      }

      const response: OutgoingResponse = {
        text,
        channel: target.channel,
        chatId: target.to,
        durationMs: result.durationMs,
        mode: 'scheduler',
      };

      try {
        await adapter.send(response);
        anyDelivered = true;
        this.appendDeliveryLedgerEvent(job, target, result);
        console.log(`[delivery] Job ${job.id} result delivered to ${target.channel}:${target.to}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[delivery] Failed to deliver job ${job.id} to ${target.channel}:${target.to}: ${msg}`);
        this.lastDeliveryError = msg;
      }
    }

    // Arm dedup only now that a real delivery reached jtr. A total send failure
    // (anyDelivered === false) leaves the dedup key unset, so the next identical
    // retry is still eligible to surface. Mirrors the /api/notify path, which
    // also records only after a confirmed delivery.
    if (this.gate && gateSignal && anyDelivered) {
      this.gate.record(gateSignal);
    }
  }

  /** Last delivery error from the most recent deliver() call. Null if success or no attempt. */
  lastDeliveryError: string | null = null;

  private appendDeliveryLedgerEvent(
    job: CronJob,
    target: { channel: string; to: string },
    result: JobResult,
  ): void {
    const timestamp = new Date().toISOString();
    try {
      mkdirSync(dirname(this.eventLedgerPath), { recursive: true });
      appendFileSync(this.eventLedgerPath, JSON.stringify({
        event_id: randomUUID(),
        event_type: 'NotificationDelivered',
        thread_id: `channel:${target.channel}:${target.to}`,
        session_id: `channel:${target.channel}:${target.to}`,
        object_id: `scheduler-delivery:${job.id}:${timestamp}`,
        timestamp,
        ts: timestamp,
        actor: 'home23-delivery-manager',
        payload: {
          schema: 'home23.notification-delivery.v1',
          source: 'scheduler',
          channel: target.channel,
          chatId: target.to,
          jobId: job.id,
          jobName: job.name,
          status: result.status,
          durationMs: result.durationMs,
        },
      }) + '\n');
    } catch (err) {
      console.warn('[delivery] Failed to append delivery ledger event:', err);
    }
  }

  private formatText(job: CronJob, result: JobResult): string | null {
    switch (job.delivery?.mode) {
      case 'full':
        return result.status === 'ok'
          ? result.response ?? `[scheduler] Job "${job.name}" completed successfully.`
          : `[scheduler] Job "${job.name}" failed: ${result.error ?? 'unknown error'}`;
      case 'summary':
        return result.status === 'ok'
          ? this.formatSummarySuccess(job, result)
          : `[scheduler] ${job.name}: failed — ${result.error ?? 'unknown error'}`;
      case 'failures':
        return result.status === 'error'
          ? `[scheduler] Job "${job.name}" failed: ${result.error ?? 'unknown error'}`
          : null;
      case 'none':
      case undefined:
        return null;
      default:
        return result.status === 'ok'
          ? result.response ?? `[scheduler] Job "${job.name}" completed successfully.`
          : `[scheduler] Job "${job.name}" failed: ${result.error ?? 'unknown error'}`;
    }
  }

  private formatSummarySuccess(job: CronJob, result: JobResult): string {
    const response = this.humanSummaryExcerpt(result.response);
    if (!response) {
      return `[scheduler] ${job.name}: ok (${result.durationMs}ms)`;
    }
    return response;
  }

  private humanSummaryExcerpt(response: string | undefined): string | null {
    if (!response) return null;

    const humanSection = response.split(/\n+AGENCY_INTAKE_PACKET:/)[0]?.trim() ?? '';
    const normalized = humanSection.replace(/\n{3,}/g, '\n\n').trim();
    if (!normalized) return null;

    const maxLength = 2800;
    return normalized.length > maxLength
      ? `${normalized.slice(0, maxLength).trimEnd()}...`
      : normalized;
  }
}
