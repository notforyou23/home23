import type { ApnsClient } from './apns-client.js';
import type { ConnectedAgentsDeliveryStore } from './connected-agents-delivery-store.js';
import type { DeviceRegistry } from './device-registry.js';
import type {
  DeviceRegistration,
  PushPayload,
  QueryNotificationDeliveryReceipt,
  QueryPushPayload,
  QueryTerminalState,
} from './types.js';
import {
  buildAsyncWorkPayload,
  buildConnectedAgentsMessagePayload,
} from './types.js';

export interface QueryTerminalNotificationInput {
  operationId: string;
  state: QueryTerminalState;
  routeId: string;
  generation: number;
  deviceIds: string[];
}

export interface QueryTerminalNotificationReceipt {
  operationId: string;
  routeId: string;
  generation: number;
  delivered: string[];
  failed: Array<{ deviceId: string; retryable: boolean }>;
  pending: string[];
}

interface ApnsPusherOptions {
  queryTimeoutMs?: number;
  queryMaxConcurrency?: number;
  connectedAgentsRegistrationIsCurrent?: (registration: DeviceRegistration) => boolean;
  connectedAgentsDeliveryStore?: ConnectedAgentsDeliveryStore;
  connectedAgentsMaximumAttempts?: number;
  connectedAgentsRetryDelaysMs?: readonly number[];
}

export class ApnsPusher {
  private readonly queryDeliveries = new Map<string, Promise<QueryTerminalNotificationReceipt>>();
  private readonly querySendWaiters: Array<() => void> = [];
  private queryActiveSends = 0;
  private readonly queryTimeoutMs: number;
  private readonly queryMaxConcurrency: number;
  private readonly connectedAgentsRegistrationIsCurrent:
    (registration: DeviceRegistration) => boolean;
  private readonly connectedAgentsDeliveryStore: ConnectedAgentsDeliveryStore | undefined;
  private readonly connectedAgentsMaximumAttempts: number;
  private readonly connectedAgentsRetryDelaysMs: readonly number[];
  private readonly connectedAgentsDeliveries = new Map<string, Promise<void>>();

  constructor(
    private client: ApnsClient,
    private registry: DeviceRegistry,
    private agentName: string,
    options: ApnsPusherOptions = {},
  ) {
    this.queryTimeoutMs = options.queryTimeoutMs ?? 5_000;
    this.queryMaxConcurrency = options.queryMaxConcurrency ?? 4;
    this.connectedAgentsRegistrationIsCurrent =
      options.connectedAgentsRegistrationIsCurrent ?? (() => true);
    this.connectedAgentsDeliveryStore = options.connectedAgentsDeliveryStore;
    this.connectedAgentsMaximumAttempts = options.connectedAgentsMaximumAttempts ?? 3;
    this.connectedAgentsRetryDelaysMs = options.connectedAgentsRetryDelaysMs ?? [250, 1_000];
    if (!Number.isSafeInteger(this.queryTimeoutMs)
        || this.queryTimeoutMs < 1 || this.queryTimeoutMs > 30_000) {
      throw new TypeError('query_apns_timeout_invalid');
    }
    if (!Number.isSafeInteger(this.queryMaxConcurrency)
        || this.queryMaxConcurrency < 1 || this.queryMaxConcurrency > 16) {
      throw new TypeError('query_apns_concurrency_invalid');
    }
    if (!Number.isSafeInteger(this.connectedAgentsMaximumAttempts)
        || this.connectedAgentsMaximumAttempts < 1
        || this.connectedAgentsMaximumAttempts > 5
        || this.connectedAgentsRetryDelaysMs.length < this.connectedAgentsMaximumAttempts - 1
        || this.connectedAgentsRetryDelaysMs.some(delay =>
          !Number.isSafeInteger(delay) || delay < 0 || delay > 30_000)) {
      throw new TypeError('connected_agents_delivery_retry_invalid');
    }
  }

  private connectedAgentsDelivery(
    input: Parameters<typeof buildConnectedAgentsMessagePayload>[0],
    device: DeviceRegistration,
  ): Promise<void> {
    const deviceId = device.coordination_device_id;
    const store = this.connectedAgentsDeliveryStore;
    if (!deviceId || !store) {
      return Promise.reject(new Error('connected_agents_delivery_store_unavailable'));
    }
    const key = `${input.messageId}\0${deviceId}\0${device.bundle_id}`;
    const existing = this.connectedAgentsDeliveries.get(key);
    if (existing) return existing;
    const delivery = this.deliverConnectedAgentsMessage(input, device, deviceId, store)
      .finally(() => {
        if (this.connectedAgentsDeliveries.get(key) === delivery) {
          this.connectedAgentsDeliveries.delete(key);
        }
      });
    this.connectedAgentsDeliveries.set(key, delivery);
    return delivery;
  }

  private async deliverConnectedAgentsMessage(
    input: Parameters<typeof buildConnectedAgentsMessagePayload>[0],
    device: DeviceRegistration,
    deviceId: string,
    store: ConnectedAgentsDeliveryStore,
  ): Promise<void> {
    let receipt = store.begin({
      messageId: input.messageId,
      deviceId,
      bundleId: device.bundle_id,
      maximumAttempts: this.connectedAgentsMaximumAttempts,
    });
    if (receipt.state === 'delivered'
        || receipt.state === 'invalid'
        || receipt.state === 'failed') return;
    const payload = buildConnectedAgentsMessagePayload(input);
    while (true) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.queryTimeoutMs);
        timeout.unref?.();
        let result: Awaited<ReturnType<ApnsClient['send']>>;
        try {
          result = await this.client.send(
            device.device_token,
            payload,
            device.env,
            { signal: controller.signal },
          );
        } finally {
          clearTimeout(timeout);
        }
        if (result.status >= 200 && result.status < 300) {
          store.finish({
            messageId: input.messageId,
            deviceId,
            bundleId: device.bundle_id,
            state: 'delivered',
          });
          return;
        }
        if (result.status === 410) {
          store.finish({
            messageId: input.messageId,
            deviceId,
            bundleId: device.bundle_id,
            state: 'invalid',
          });
          this.registry.invalidate(device.device_token, device.bundle_id);
          return;
        }
        const retryable = result.status === 0 || result.status === 429 || result.status >= 500;
        if (!retryable || receipt.attempts >= this.connectedAgentsMaximumAttempts) {
          store.finish({
            messageId: input.messageId,
            deviceId,
            bundleId: device.bundle_id,
            state: 'failed',
            errorCode: retryable ? 'retry_exhausted' : `apns_${result.status}`,
          });
          return;
        }
        receipt = store.finish({
          messageId: input.messageId,
          deviceId,
          bundleId: device.bundle_id,
          state: 'retryable',
          errorCode: `apns_${result.status}`,
        });
      } catch (error) {
        if (receipt.attempts >= this.connectedAgentsMaximumAttempts) {
          store.finish({
            messageId: input.messageId,
            deviceId,
            bundleId: device.bundle_id,
            state: 'failed',
            errorCode: 'retry_exhausted',
          });
          return;
        }
        receipt = store.finish({
          messageId: input.messageId,
          deviceId,
          bundleId: device.bundle_id,
          state: 'retryable',
          errorCode: (error as { name?: string }).name === 'AbortError'
            ? 'apns_timeout' : 'apns_unavailable',
        });
      }
      const delay = this.connectedAgentsRetryDelaysMs[receipt.attempts - 1] ?? 0;
      if (delay > 0) await new Promise<void>(resolve => setTimeout(resolve, delay));
      receipt = store.begin({
        messageId: input.messageId,
        deviceId,
        bundleId: device.bundle_id,
        maximumAttempts: this.connectedAgentsMaximumAttempts,
      });
      if (receipt.state === 'delivered'
          || receipt.state === 'invalid'
          || receipt.state === 'failed') return;
    }
  }

  /**
   * Wake devices for a canonical assistant Message that is already durable.
   * The notification is intentionally content-free; the Message API is truth.
   */
  async notifyConnectedAgentsMessage(input: {
    conversationId: string;
    channelId: string;
    messageId: string;
    workId?: string;
    agent?: string;
    displayName?: string;
  }): Promise<void> {
    const devices = this.registry.lookupConnectedAgentsDevices()
      .filter((device) => this.connectedAgentsRegistrationIsCurrent(device));
    if (devices.length === 0) return;
    const outcomes = await Promise.allSettled(
      devices.map(device => this.connectedAgentsDelivery(input, device)),
    );
    const failures = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
    );
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map(failure => failure.reason),
        'connected_agents_notification_delivery_failed',
      );
    }
  }

  private async withQuerySendSlot<T>(task: () => Promise<T>): Promise<T> {
    await new Promise<void>((resolve) => {
      if (this.queryActiveSends < this.queryMaxConcurrency) {
        this.queryActiveSends += 1;
        resolve();
        return;
      }
      this.querySendWaiters.push(() => {
        this.queryActiveSends += 1;
        resolve();
      });
    });
    try {
      return await task();
    } finally {
      this.queryActiveSends -= 1;
      this.querySendWaiters.shift()?.();
    }
  }

  private preview(text: string): string {
    const stripped = text.replace(/\s+/g, ' ').trim();
    if (stripped.length <= 100) return stripped;
    return stripped.slice(0, 99) + '…';
  }

  /**
   * Fire pushes for a completed turn. Fire-and-forget — never throws.
   * Called by the turn-completion hook.
   */
  async notifyTurnComplete(opts: { chatId: string; turnId: string; assistantText: string }): Promise<void> {
    const devices = this.registry.lookupByChatId(opts.chatId);
    if (devices.length === 0) return;

    const body = this.preview(opts.assistantText);
    if (!body) return;

    const payload: PushPayload = {
      aps: {
        alert: { title: this.agentName, body },
        'mutable-content': 1,
        sound: 'default',
      },
      chatId: opts.chatId,
      turnId: opts.turnId,
      agent: this.agentName,
    };

    await Promise.allSettled(devices.map(async (dev) => {
      try {
        const result = await this.client.send(dev.device_token, payload, dev.env);
        if (result.status === 410) {
          console.log(`[push] ${this.agentName}: device ${dev.device_token.slice(0, 8)}… gone (410), invalidating`);
          this.registry.invalidate(dev.device_token, dev.bundle_id);
        } else if (result.status >= 400) {
          console.warn(`[push] ${this.agentName}: ${result.status} ${result.reason ?? ''} for ${dev.device_token.slice(0, 8)}…`);
        }
      } catch (err) {
        console.warn(`[push] ${this.agentName}: send failed for ${dev.device_token.slice(0, 8)}…:`, err instanceof Error ? err.message : err);
      }
    }));
  }

  /**
   * Fire pushes for terminal async work (coding jobs, sub-agents; Step 31).
   * Same device-lookup/410-invalidation semantics as notifyTurnComplete, but
   * the payload carries chatId + workId — never a turnId.
   */
  async notifyAsyncWork(opts: { chatId: string; workId: string; status: string; body: string }): Promise<void> {
    const devices = this.registry.lookupByChatId(opts.chatId);
    if (devices.length === 0) return;
    if (!opts.body.trim()) return;

    const payload = buildAsyncWorkPayload({
      agentName: this.agentName,
      chatId: opts.chatId,
      workId: opts.workId,
      status: opts.status,
      body: this.preview(opts.body),
    });

    await Promise.allSettled(devices.map(async (dev) => {
      try {
        const result = await this.client.send(dev.device_token, payload, dev.env);
        if (result.status === 410) {
          console.log(`[push] ${this.agentName}: device ${dev.device_token.slice(0, 8)}… gone (410), invalidating`);
          this.registry.invalidate(dev.device_token, dev.bundle_id);
        } else if (result.status >= 400) {
          console.warn(`[push] ${this.agentName}: ${result.status} ${result.reason ?? ''} for ${dev.device_token.slice(0, 8)}…`);
        }
      } catch (err) {
        console.warn(`[push] ${this.agentName}: send failed for ${dev.device_token.slice(0, 8)}…:`, err instanceof Error ? err.message : err);
      }
    }));
  }

  private queryReceipt(
    input: QueryTerminalNotificationInput,
    receipts: QueryNotificationDeliveryReceipt[],
  ): QueryTerminalNotificationReceipt {
    const ordered = [...receipts].sort((left, right) => left.device_id.localeCompare(right.device_id));
    return {
      operationId: input.operationId,
      routeId: input.routeId,
      generation: input.generation,
      delivered: ordered.filter(receipt => receipt.state === 'delivered')
        .map(receipt => receipt.device_id),
      failed: ordered.filter(receipt => receipt.state === 'failed')
        .map(receipt => ({ deviceId: receipt.device_id, retryable: receipt.retryable })),
      pending: ordered.filter(receipt => receipt.state === 'pending')
        .map(receipt => receipt.device_id),
    };
  }

  /**
   * Deliver one generic terminal Query route to explicitly subscribed installations.
   * Receipt state is persisted before each APNs attempt and survives replay/restart.
   */
  async notifyQueryTerminal(
    input: QueryTerminalNotificationInput,
  ): Promise<QueryTerminalNotificationReceipt> {
    const key = JSON.stringify([
      input.operationId, input.state, input.routeId, input.generation,
      [...input.deviceIds].sort(),
    ]);
    const existing = this.queryDeliveries.get(key);
    if (existing) return existing;
    const current = this.deliverQueryTerminal(input).finally(() => {
      if (this.queryDeliveries.get(key) === current) this.queryDeliveries.delete(key);
    });
    this.queryDeliveries.set(key, current);
    return current;
  }

  private async deliverQueryTerminal(
    input: QueryTerminalNotificationInput,
  ): Promise<QueryTerminalNotificationReceipt> {
    const devices = this.registry.lookupQueryNotificationDevices(input.deviceIds, this.agentName);
    const results = await Promise.all(devices.map(async (device) => {
      const deviceId = device.installation_id!;
      let receipt = this.registry.beginQueryNotificationDelivery({
        routeId: input.routeId,
        operationId: input.operationId,
        deviceId,
        generation: input.generation,
        terminalState: input.state,
      });
      if (receipt.state === 'delivered'
          || (receipt.state === 'failed' && receipt.retryable === false)) return receipt;
      const displayName = this.agentName
        ? this.agentName.charAt(0).toUpperCase() + this.agentName.slice(1)
        : 'Home23';
      const payload: QueryPushPayload = {
        aps: {
          alert: { title: displayName, body: `${displayName}'s Query is ready.` },
          'mutable-content': 1,
          sound: 'default',
        },
        kind: 'query_operation',
        operationId: input.operationId,
        state: input.state,
        agent: this.agentName,
        routeId: input.routeId,
        generation: input.generation,
      };
      try {
        const result = await this.withQuerySendSlot(async () => {
          const controller = new AbortController();
          let timer: NodeJS.Timeout | undefined;
          const timeout = new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              controller.abort();
              const error = new Error('apns_timeout') as Error & { code: string };
              error.code = 'apns_timeout';
              reject(error);
            }, this.queryTimeoutMs);
            timer.unref?.();
          });
          try {
            return await Promise.race([
              this.client.send(device.device_token, payload, device.env, {
                signal: controller.signal,
              }),
              timeout,
            ]);
          } finally {
            if (timer) clearTimeout(timer);
            controller.abort();
          }
        });
        if (result.status >= 200 && result.status < 300) {
          receipt = this.registry.finishQueryNotificationDelivery({
            routeId: input.routeId, deviceId, generation: input.generation,
            state: 'delivered',
          });
        } else if (result.status === 410) {
          this.registry.invalidate(device.device_token, device.bundle_id);
          receipt = this.registry.finishQueryNotificationDelivery({
            routeId: input.routeId, deviceId, generation: input.generation,
            state: 'failed', retryable: false, errorCode: 'device_invalid',
          });
        } else {
          receipt = this.registry.finishQueryNotificationDelivery({
            routeId: input.routeId, deviceId, generation: input.generation,
            state: 'failed', retryable: true, errorCode: 'apns_rejected',
          });
        }
      } catch (error) {
        receipt = this.registry.finishQueryNotificationDelivery({
          routeId: input.routeId, deviceId, generation: input.generation,
          state: 'failed', retryable: true,
          errorCode: (error as { code?: string }).code === 'apns_timeout'
            ? 'apns_timeout' : 'apns_unavailable',
        });
      }
      return receipt;
    }));
    return this.queryReceipt(input, results);
  }
}
