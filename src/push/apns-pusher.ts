import type { ApnsClient } from './apns-client.js';
import type { DeviceRegistry } from './device-registry.js';
import type {
  PushPayload,
  QueryNotificationDeliveryReceipt,
  QueryPushPayload,
  QueryTerminalState,
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
}

export class ApnsPusher {
  private readonly queryDeliveries = new Map<string, Promise<QueryTerminalNotificationReceipt>>();
  private readonly queryTimeoutMs: number;

  constructor(
    private client: ApnsClient,
    private registry: DeviceRegistry,
    private agentName: string,
    options: ApnsPusherOptions = {},
  ) {
    this.queryTimeoutMs = options.queryTimeoutMs ?? 5_000;
    if (!Number.isSafeInteger(this.queryTimeoutMs)
        || this.queryTimeoutMs < 1 || this.queryTimeoutMs > 30_000) {
      throw new TypeError('query_apns_timeout_invalid');
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
        let result;
        try {
          result = await Promise.race([
            this.client.send(device.device_token, payload, device.env, {
              signal: controller.signal,
            }),
            timeout,
          ]);
        } finally {
          if (timer) clearTimeout(timer);
          controller.abort();
        }
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
