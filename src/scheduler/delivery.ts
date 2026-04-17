/**
 * COSMO Home 2.3 — Delivery Manager
 *
 * Handles delivering scheduler job results to channels
 * via the registered ChannelAdapter instances.
 * Supports single-channel (channel/to) and multi-channel (channels[]) delivery.
 */

import type { ChannelAdapter, OutgoingResponse } from '../channels/router.js';
import type { CronJob, JobResult } from './cron.js';
import type { DeliveryProfiles } from '../types.js';

export type { DeliveryProfiles };

// ─── DeliveryManager ─────────────────────────────────────────

export class DeliveryManager {
  private adapters: Map<string, ChannelAdapter>;
  private profiles: DeliveryProfiles;

  constructor(adapters: Map<string, ChannelAdapter>, profiles: DeliveryProfiles = {}) {
    this.adapters = adapters;
    this.profiles = profiles;
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
        console.log(`[delivery] Job ${job.id} result delivered to ${target.channel}:${target.to}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[delivery] Failed to deliver job ${job.id} to ${target.channel}:${target.to}: ${msg}`);
        this.lastDeliveryError = msg;
      }
    }
  }

  /** Last delivery error from the most recent deliver() call. Null if success or no attempt. */
  lastDeliveryError: string | null = null;

  private formatText(job: CronJob, result: JobResult): string | null {
    switch (job.delivery?.mode) {
      case 'full':
        return result.status === 'ok'
          ? result.response ?? `[scheduler] Job "${job.name}" completed successfully.`
          : `[scheduler] Job "${job.name}" failed: ${result.error ?? 'unknown error'}`;
      case 'summary':
        return result.status === 'ok'
          ? `[scheduler] ${job.name}: ok (${result.durationMs}ms)`
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
}
