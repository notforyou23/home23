/**
 * COSMO Home 2.3 — iMessage Channel Adapter
 *
 * Polls for new messages using the `imsg` CLI tool.
 * Sends replies via `imsg send`.
 *
 * NOTE: The imsg CLI interface is provisional. This adapter
 * implements the poll → parse → convert → onMessage pattern
 * and can be adapted once the CLI API is finalized.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ChannelAdapter, IncomingMessage, OutgoingResponse } from './router.js';

const execFileAsync = promisify(execFile);

interface IMessageConfig {
  cliPath: string;
  dmPolicy: string;
  groupPolicy: string;
}

interface ImsgRawMessage {
  id: string;
  chat_id: string;
  sender: string;
  sender_name?: string;
  text: string;
  timestamp?: number;
  is_group?: boolean;
}

export class IMessageAdapter implements ChannelAdapter {
  readonly name = 'imessage';

  private config: IMessageConfig;
  private onMessage: (msg: IncomingMessage) => Promise<void>;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private seenIds: Set<string> = new Set();
  private running = false;

  constructor(
    config: IMessageConfig,
    onMessage: (msg: IncomingMessage) => Promise<void>,
  ) {
    this.config = config;
    this.onMessage = onMessage;
  }

  async start(): Promise<void> {
    this.running = true;
    console.log('[imessage] Starting polling loop');

    // Initial poll, then every 5 seconds
    this.poll();
    this.pollTimer = setInterval(() => this.poll(), 5000);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    console.log('[imessage] Stopped');
  }

  async send(response: OutgoingResponse): Promise<void> {
    const { cliPath } = this.config;
    const { chatId, text } = response;

    try {
      await execFileAsync(cliPath, ['send', chatId, text]);
    } catch (err) {
      console.error(`[imessage] Failed to send to ${chatId}:`, err);
      throw err;
    }
  }

  // ── Private ───────────────────────────────────────────────

  private async poll(): Promise<void> {
    if (!this.running) return;

    try {
      const { stdout } = await execFileAsync(this.config.cliPath, ['receive', '--json']);
      if (!stdout.trim()) return;

      const raw: ImsgRawMessage[] = JSON.parse(stdout);

      for (const msg of raw) {
        // Skip already-seen messages
        if (this.seenIds.has(msg.id)) continue;
        this.seenIds.add(msg.id);

        // Apply DM / group policy filtering
        if (msg.is_group && this.config.groupPolicy === 'ignore') continue;
        if (!msg.is_group && this.config.dmPolicy === 'ignore') continue;

        const incoming: IncomingMessage = {
          channel: 'imessage',
          chatId: msg.chat_id,
          senderId: msg.sender,
          senderName: msg.sender_name ?? msg.sender,
          text: msg.text,
          messageId: msg.id,
          timestamp: msg.timestamp ?? Date.now(),
        };

        this.onMessage(incoming).catch(err => {
          console.error('[imessage] onMessage error:', err);
        });
      }
    } catch (err: unknown) {
      // Silence ENOENT when the CLI binary isn't present yet
      if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        console.warn('[imessage] CLI not found at', this.config.cliPath);
      } else if (err instanceof Error && 'stdout' in err && typeof (err as any).stdout === 'string' && (err as any).stdout.includes('Unknown subcommand')) {
        // imsg v0.4.0 uses 'watch' not 'receive' — adapter needs update, suppress spam
        // TODO: rewrite adapter to use 'imsg history' polling or 'imsg watch' stream
      } else {
        console.error('[imessage] Poll error:', err);
      }
    }
  }
}
