import type { ApnsClient } from './apns-client.js';
import type { DeviceRegistry } from './device-registry.js';
import type { PushPayload } from './types.js';

export class ApnsPusher {
  constructor(private client: ApnsClient, private registry: DeviceRegistry, private agentName: string) {}

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
}
