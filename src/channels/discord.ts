/**
 * COSMO Home 2.3 — Discord Channel Adapter
 *
 * Connects directly to the Discord Gateway WebSocket.
 * No discord.js dependency — raw Gateway v10 protocol.
 *
 * Handles: HELLO → heartbeat, IDENTIFY, MESSAGE_CREATE dispatch.
 * Sends replies via REST POST to /channels/{id}/messages.
 */

import WebSocket from 'ws';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { ChannelAdapter, IncomingMessage, OutgoingResponse } from './router.js';

// ─── Config ──────────────────────────────────────────────────

export interface DiscordConfig {
  token: string;
  streaming: string;
  groupPolicy: string;
  guilds: Record<string, { requireMention?: boolean; users?: string[] }>;
  threadBindings: boolean;
}

// ─── Gateway payload types ───────────────────────────────────

interface GatewayPayload {
  op: number;
  d: unknown;
  s: number | null;
  t: string | null;
}

interface HelloData {
  heartbeat_interval: number;
}

interface MessageCreateData {
  id: string;
  channel_id: string;
  guild_id?: string;
  content: string;
  author: {
    id: string;
    username: string;
    bot?: boolean;
  };
  timestamp: string;
}

// ─── Adapter ─────────────────────────────────────────────────

export class DiscordAdapter implements ChannelAdapter {
  readonly name = 'discord';

  private config: DiscordConfig;
  private onMessage: (msg: IncomingMessage) => Promise<void>;
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastSequence: number | null = null;
  private running = false;

  constructor(
    config: DiscordConfig,
    onMessage: (msg: IncomingMessage) => Promise<void>,
  ) {
    this.config = config;
    this.onMessage = onMessage;
  }

  async start(): Promise<void> {
    this.running = true;

    // Fetch gateway URL from REST API
    const gatewayUrl = await this.fetchGatewayUrl();
    console.log(`[discord] Connecting to gateway: ${gatewayUrl}`);

    this.ws = new WebSocket(`${gatewayUrl}/?v=10&encoding=json`);

    this.ws.on('message', (data: WebSocket.Data) => {
      this.handleGatewayMessage(data);
    });

    this.ws.on('close', (code, reason) => {
      console.log(`[discord] WebSocket closed: ${code} ${reason}`);
      this.stopHeartbeat();
      if (this.running) {
        console.log('[discord] Reconnecting in 5s...');
        setTimeout(() => this.start(), 5000);
      }
    });

    this.ws.on('error', (err) => {
      console.error('[discord] WebSocket error:', err);
    });
  }

  async stop(): Promise<void> {
    this.running = false;
    this.stopHeartbeat();
    if (this.ws) {
      this.ws.close(1000, 'Shutting down');
      this.ws = null;
    }
    console.log('[discord] Stopped');
  }

  async send(response: OutgoingResponse): Promise<void> {
    const url = `https://discord.com/api/v10/channels/${response.chatId}/messages`;
    if (response.text) {
      await this.sendJsonMessage(url, { content: response.text });
    }

    for (const attachment of response.media ?? []) {
      const form = new FormData();
      const payload = attachment.caption ? { content: attachment.caption } : {};
      form.append('payload_json', JSON.stringify(payload));
      form.append(
        'files[0]',
        new Blob([readFileSync(attachment.path)], { type: attachment.mimeType || 'application/octet-stream' }),
        attachment.fileName || basename(attachment.path),
      );
      await this.sendMultipartMessage(url, form);
    }
  }

  private async sendJsonMessage(url: string, body: Record<string, unknown>): Promise<void> {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bot ${this.config.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (res.status === 429) {
      const retryAfter = parseFloat(res.headers.get('Retry-After') ?? '1') * 1000;
      console.warn(`[discord] Rate limited, retrying after ${retryAfter}ms`);
      await new Promise(r => setTimeout(r, retryAfter));
      return this.sendJsonMessage(url, body);
    }

    if (!res.ok) {
      throw new Error(`[discord] Send failed: ${res.status} ${await res.text()}`);
    }
  }

  private async sendMultipartMessage(url: string, body: FormData): Promise<void> {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bot ${this.config.token}`,
      },
      body,
    });

    if (res.status === 429) {
      const retryAfter = parseFloat(res.headers.get('Retry-After') ?? '1') * 1000;
      console.warn(`[discord] Rate limited on attachment, retrying after ${retryAfter}ms`);
      await new Promise(r => setTimeout(r, retryAfter));
      return this.sendMultipartMessage(url, body);
    }

    if (!res.ok) {
      throw new Error(`[discord] Attachment send failed: ${res.status} ${await res.text()}`);
    }
  }

  // ── Private ───────────────────────────────────────────────

  private async fetchGatewayUrl(): Promise<string> {
    const res = await fetch('https://discord.com/api/v10/gateway', {
      headers: { 'Authorization': `Bot ${this.config.token}` },
    });
    if (!res.ok) throw new Error(`[discord] Failed to fetch gateway: ${res.status}`);
    const data = await res.json() as { url: string };
    return data.url;
  }

  private handleGatewayMessage(raw: WebSocket.Data): void {
    const payload: GatewayPayload = JSON.parse(raw.toString());

    if (payload.s !== null) {
      this.lastSequence = payload.s;
    }

    switch (payload.op) {
      case 10: // HELLO
        this.handleHello(payload.d as HelloData);
        break;

      case 11: // HEARTBEAT_ACK
        // All good — server acknowledged our heartbeat
        break;

      case 0: // DISPATCH
        this.handleDispatch(payload.t!, payload.d);
        break;

      default:
        break;
    }
  }

  private handleHello(data: HelloData): void {
    // Start heartbeating
    const interval = data.heartbeat_interval;
    console.log(`[discord] HELLO — heartbeat interval ${interval}ms`);

    this.startHeartbeat(interval);

    // Send IDENTIFY
    // Intents: GUILDS (1) + GUILD_MESSAGES (512) + MESSAGE_CONTENT (32768) = 33281
    const identify = {
      op: 2,
      d: {
        token: this.config.token,
        intents: 33281,
        properties: {
          os: 'linux',
          browser: 'cosmo-home',
          device: 'cosmo-home',
        },
      },
    };
    this.ws!.send(JSON.stringify(identify));
  }

  private startHeartbeat(intervalMs: number): void {
    this.stopHeartbeat();

    // Send first heartbeat immediately with jitter
    const jitter = Math.random() * intervalMs;
    setTimeout(() => {
      this.sendHeartbeat();
      this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), intervalMs);
    }, jitter);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private sendHeartbeat(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ op: 1, d: this.lastSequence }));
  }

  private handleDispatch(eventName: string, data: unknown): void {
    if (eventName !== 'MESSAGE_CREATE') return;

    const msg = data as MessageCreateData;

    // Ignore bot messages
    if (msg.author.bot) return;

    // Guild allowlist filter
    if (msg.guild_id) {
      const guildConfig = this.config.guilds[msg.guild_id];
      if (!guildConfig) {
        // Guild not in allowlist — skip
        return;
      }
      // User filter within guild
      if (guildConfig.users && !guildConfig.users.includes(msg.author.id)) {
        return;
      }
    }

    const incoming: IncomingMessage = {
      channel: 'discord',
      chatId: msg.channel_id,
      senderId: msg.author.id,
      senderName: msg.author.username,
      text: msg.content,
      messageId: msg.id,
      timestamp: new Date(msg.timestamp).getTime(),
      metadata: {
        guildId: msg.guild_id,
      },
    };

    this.onMessage(incoming).catch(err => {
      console.error('[discord] onMessage error:', err);
    });
  }
}
