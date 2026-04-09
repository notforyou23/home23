/**
 * COSMO Home 2.3 — Telegram Channel Adapter
 *
 * Long-polling adapter for Telegram Bot API.
 * Receives messages via getUpdates, sends via sendMessage.
 * No webhook — uses long-polling.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ChannelAdapter, IncomingMessage, OutgoingResponse } from './router.js';
import type { MediaAttachment } from '../types.js';

// ─── Config ─────────────────────────────────────────────────

export interface TelegramConfig {
  botToken: string;
  streaming: 'partial' | 'off';
  dmPolicy: string;
  groupPolicy: string;
  groups: Record<string, { requireMention?: boolean }>;
  ackReaction: boolean;
}

interface TgBotCommand {
  command: string;
  description: string;
}

const CANONICAL_TELEGRAM_COMMANDS: TgBotCommand[] = [
  { command: 'help', description: 'Show available commands' },
  { command: 'model', description: 'Switch model: /model <alias>' },
  { command: 'models', description: 'List available models' },
  { command: 'query', description: 'Fast brain query: /query <question>' },
  { command: 'deep', description: 'Deep brain query: /deep <question>' },
  { command: 'status', description: 'Health snapshot' },
  { command: 'stop', description: 'Interrupt current run' },
  { command: 'rebuild', description: 'Build + restart' },
  { command: 'restart', description: 'Restart without build' },
  { command: 'reset', description: 'Clear conversation' },
  { command: 'history', description: 'Show recent messages' },
  { command: 'compact', description: 'Compact conversation history' },
  { command: 'refresh', description: 'Refresh runtime context' },
  { command: 'prompt', description: 'Show current system prompt info' },
  { command: 'cleanup', description: 'Clean temp/runtime artifacts' },
  { command: 'extract', description: 'Extract session memory now' },
];

// ─── Telegram API Types (minimal) ───────────────────────────

interface TgUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

interface TgChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
}

interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  date: number;
  text?: string;
  photo?: Array<{ file_id: string; file_unique_id: string; width: number; height: number; file_size?: number }>;
  voice?: { file_id: string; file_unique_id: string; duration: number; mime_type?: string; file_size?: number };
  document?: { file_id: string; file_unique_id: string; file_name?: string; mime_type?: string; file_size?: number };
  caption?: string;
}

interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
}

interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

interface TgApiResponse<T> {
  ok: boolean;
  result: T;
  description?: string;
}

// ─── Constants ──────────────────────────────────────────────

const API_BASE = 'https://api.telegram.org/bot';
const POLL_TIMEOUT = 30;           // seconds for long-poll
const RETRY_DELAY_MS = 5000;       // wait after error
const MAX_MESSAGE_LENGTH = 4096;   // Telegram's limit

// ─── Adapter ────────────────────────────────────────────────

export class TelegramAdapter implements ChannelAdapter {
  readonly name = 'telegram';

  private config: TelegramConfig;
  private onMessage: (msg: IncomingMessage) => Promise<void>;
  private running = false;
  private pollAbort: AbortController | null = null;
  private offset: number;
  private offsetPath: string;

  constructor(
    config: TelegramConfig,
    onMessage: (msg: IncomingMessage) => Promise<void>,
    runtimeDir: string = process.env.COSMO_RUNTIME_DIR ?? '.',
  ) {
    this.config = config;
    this.onMessage = onMessage;

    // Offset persistence
    mkdirSync(runtimeDir, { recursive: true });
    this.offsetPath = join(runtimeDir, 'telegram-offset.json');
    this.offset = this.loadOffset();
  }

  // ── Lifecycle ───────────────────────────────────────────

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.registerCanonicalCommands();
    console.log('[telegram] Starting long-poll loop');
    this.pollLoop();              // fire-and-forget
  }

  async stop(): Promise<void> {
    console.log('[telegram] Stopping');
    this.running = false;
    this.pollAbort?.abort();
    this.saveOffset();
  }

  // ── Send ────────────────────────────────────────────────

  async send(response: OutgoingResponse): Promise<void> {
    // Send text chunks
    if (response.text) {
      const chunks = splitMessage(response.text);

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i]!;

        // Send directly — no placeholder/edit dance, no Markdown parse mode
        // (Telegram's Markdown parser chokes on LLM output with special chars)
        await this.apiCall<unknown>('sendMessage', {
          chat_id: response.chatId,
          text: chunk,
          ...(response.replyToMessageId && i === 0
            ? { reply_to_message_id: Number(response.replyToMessageId) }
            : {}),
          ...(response.replyMarkup && i === chunks.length - 1
            ? { reply_markup: JSON.stringify(response.replyMarkup) }
            : {}),
        });
      }
    }

    // Send media attachments
    if (response.media && response.media.length > 0) {
      for (const attachment of response.media) {
        try {
          switch (attachment.type) {
            case 'image':
              await this.sendPhoto(response.chatId, attachment.path, attachment.caption);
              break;
            case 'voice':
              await this.sendVoice(response.chatId, attachment.path);
              break;
            case 'document':
              await this.sendDocument(response.chatId, attachment.path, attachment.caption);
              break;
          }
        } catch (err) {
          console.error(`[telegram] Failed to send ${attachment.type} attachment:`, err);
        }
      }
    }
  }

  // ── Typing Indicator ──────────────────────────────────────

  async sendTyping(chatId: string): Promise<void> {
    await this.apiCall<unknown>('sendChatAction', {
      chat_id: chatId,
      action: 'typing',
    }).catch(() => {}); // Non-fatal
  }

  // ── Media Send Methods ────────────────────────────────────

  async sendPhoto(chatId: string, filePath: string, caption?: string): Promise<void> {
    const { readFileSync } = await import('node:fs');
    const form = new FormData();
    form.append('chat_id', chatId);
    form.append('photo', new Blob([readFileSync(filePath)]), 'photo.jpg');
    if (caption) form.append('caption', caption.slice(0, 1024));
    const url = `${API_BASE}${this.config.botToken}/sendPhoto`;
    const res = await fetch(url, { method: 'POST', body: form });
    if (!res.ok) throw new Error(`sendPhoto failed: ${res.status}`);
  }

  async sendVoice(chatId: string, filePath: string): Promise<void> {
    const { readFileSync } = await import('node:fs');
    const form = new FormData();
    form.append('chat_id', chatId);
    form.append('voice', new Blob([readFileSync(filePath)]), 'voice.ogg');
    const url = `${API_BASE}${this.config.botToken}/sendVoice`;
    const res = await fetch(url, { method: 'POST', body: form });
    if (!res.ok) throw new Error(`sendVoice failed: ${res.status}`);
  }

  async sendDocument(chatId: string, filePath: string, caption?: string): Promise<void> {
    const { readFileSync } = await import('node:fs');
    const { basename } = await import('node:path');
    const form = new FormData();
    form.append('chat_id', chatId);
    form.append('document', new Blob([readFileSync(filePath)]), basename(filePath));
    if (caption) form.append('caption', caption.slice(0, 1024));
    const url = `${API_BASE}${this.config.botToken}/sendDocument`;
    const res = await fetch(url, { method: 'POST', body: form });
    if (!res.ok) throw new Error(`sendDocument failed: ${res.status}`);
  }

  // ── File Download ──────────────────────────────────────

  private async downloadFile(fileId: string): Promise<string> {
    const fileInfo = await this.apiCall<{ file_path: string }>('getFile', { file_id: fileId });
    const fileUrl = `https://api.telegram.org/file/bot${this.config.botToken}/${fileInfo.file_path}`;
    const res = await fetch(fileUrl);
    if (!res.ok) throw new Error(`File download failed: ${res.status}`);
    const { writeFileSync, mkdirSync: mkdirSyncFs } = await import('node:fs');
    const { join: joinPath, extname } = await import('node:path');
    const tempDir = joinPath(process.env.COSMO_RUNTIME_DIR ?? '.', 'tmp');
    mkdirSyncFs(tempDir, { recursive: true });
    const ext = extname(fileInfo.file_path) || '.bin';
    const localPath = joinPath(tempDir, `tg-${Date.now()}${ext}`);
    const buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(localPath, buf);
    return localPath;
  }

  // ── Long-Polling Loop ───────────────────────────────────

  private async pollLoop(): Promise<void> {
    while (this.running) {
      try {
        const updates = await this.getUpdates();
        if (updates.length > 0) {
          console.log(`[telegram] Got ${updates.length} update(s)`);
        }
        for (const update of updates) {
          this.offset = update.update_id + 1;
          const updateDesc = update.callback_query
            ? `callback: "${update.callback_query.data}"`
            : `message: "${update.message?.text ?? '<no text>'}"`;
          console.log(`[telegram] Processing update ${update.update_id}, ${updateDesc}`);
          // Fire-and-forget — don't block the poll loop.
          // This allows /stop and other commands to be received
          // while a previous message's agent run is still in progress.
          this.handleUpdate(update).catch(err => {
            if (!this.running) return;
            console.error('[telegram] handleUpdate error:', err);
          });
        }
        this.saveOffset();
      } catch (err: unknown) {
        if (!this.running) break;   // abort during shutdown
        console.error('[telegram] Poll error, retrying in 5s:', err);
        await sleep(RETRY_DELAY_MS);
      }
    }
  }

  private async getUpdates(): Promise<TgUpdate[]> {
    this.pollAbort = new AbortController();
    const allowedUpdates = encodeURIComponent(JSON.stringify([
      'message', 'callback_query',
    ]));
    const url =
      `${API_BASE}${this.config.botToken}/getUpdates` +
      `?offset=${this.offset}&timeout=${POLL_TIMEOUT}&allowed_updates=${allowedUpdates}`;

    // Combine user-abort signal with a hard timeout (poll + 10s grace)
    // Prevents hanging forever on stalled TCP connections
    const res = await fetch(url, {
      signal: AbortSignal.any([
        this.pollAbort.signal,
        AbortSignal.timeout((POLL_TIMEOUT + 10) * 1000),
      ]),
    });

    if (!res.ok) {
      throw new Error(`getUpdates HTTP ${res.status}: ${await res.text()}`);
    }

    const body = (await res.json()) as TgApiResponse<TgUpdate[]>;
    if (!body.ok) {
      throw new Error(`getUpdates API error: ${body.description}`);
    }
    return body.result;
  }

  // ── Update Handler ──────────────────────────────────────

  private async handleUpdate(update: TgUpdate): Promise<void> {
    // ── Handle callback queries (inline keyboard button taps) ──
    if (update.callback_query) {
      const cb = update.callback_query;
      const data = cb.data;
      if (data?.startsWith('model:')) {
        const modelKey = data.slice(6); // e.g. "anthropic/claude-sonnet-4-20250514"
        // Answer the callback to dismiss the loading indicator
        await this.apiCall<unknown>('answerCallbackQuery', {
          callback_query_id: cb.id,
          text: `Switching to ${modelKey}...`,
        }).catch(() => {});
        // Route as a /model command
        if (cb.message?.chat) {
          const fakeMsg: IncomingMessage = {
            channel: 'telegram',
            chatId: String(cb.message.chat.id),
            senderId: String(cb.from.id),
            senderName: cb.from.first_name || 'User',
            text: `/model ${modelKey}`,
            timestamp: Date.now(),
          };
          await this.onMessage(fakeMsg);
        }
      }
      return;
    }

    const msg = update.message;
    if (!msg) return;

    const hasText = !!msg.text;
    const hasMedia = !!(msg.photo || msg.voice || msg.document);

    if (!hasText && !hasMedia) return;  // ignore stickers, etc.

    const chat = msg.chat;
    const from = msg.from;
    if (!from) return;                 // shouldn't happen, but be safe

    const isGroup = chat.type !== 'private';

    // ── Group policy ──
    if (isGroup) {
      if (this.config.groupPolicy === 'allowlist') {
        const chatIdStr = String(chat.id);
        if (!(chatIdStr in this.config.groups)) {
          return; // not in allowlist — ignore silently
        }
      }
    }

    // ── DM policy ──
    // pairing mode: only accept DMs from users who have previously been
    // seen in an allowed group, or whose userId is in a known-users set.
    // For initial deployment, all DMs are accepted (pairing is implicit
    // through Telegram's own contact system). This matches OpenClaw's
    // behavior where dmPolicy='pairing' accepted all DMs in practice.

    // ── Ack reaction ──
    if (this.config.ackReaction && isGroup) {
      this.sendAckReaction(chat.id, msg.message_id).catch((err) => {
        console.warn('[telegram] Failed to send ack reaction:', err);
      });
    }

    // ── Download media attachments ──
    const media: MediaAttachment[] = [];

    if (msg.photo && msg.photo.length > 0) {
      try {
        // Telegram sends multiple sizes — pick the largest (last element)
        const largest = msg.photo[msg.photo.length - 1]!;
        const localPath = await this.downloadFile(largest.file_id);
        media.push({ type: 'image', path: localPath, caption: msg.caption });
      } catch (err) {
        console.warn('[telegram] Failed to download photo:', err);
      }
    }

    if (msg.voice) {
      try {
        const localPath = await this.downloadFile(msg.voice.file_id);
        media.push({ type: 'voice', path: localPath, mimeType: msg.voice.mime_type });
      } catch (err) {
        console.warn('[telegram] Failed to download voice:', err);
      }
    }

    if (msg.document) {
      try {
        const localPath = await this.downloadFile(msg.document.file_id);
        media.push({
          type: 'document',
          path: localPath,
          mimeType: msg.document.mime_type,
          fileName: msg.document.file_name,
          caption: msg.caption,
        });
      } catch (err) {
        console.warn('[telegram] Failed to download document:', err);
      }
    }

    // ── Build IncomingMessage ──
    const incoming: IncomingMessage = {
      channel: 'telegram',
      chatId: String(chat.id),
      senderId: String(from.id),
      senderName: from.first_name + (from.last_name ? ` ${from.last_name}` : ''),
      text: msg.text ?? msg.caption ?? '',
      messageId: String(msg.message_id),
      timestamp: msg.date * 1000,     // Telegram gives Unix seconds
      metadata: {
        chatType: chat.type,
        chatTitle: chat.title,
        username: from.username,
      },
      ...(media.length > 0 ? { media } : {}),
    };

    try {
      console.log(`[telegram] → Routing message from ${incoming.senderName} (${incoming.chatId}): "${incoming.text}"${media.length > 0 ? ` [+${media.length} media]` : ''}`);
      await this.onMessage(incoming);
      console.log(`[telegram] ← Message handled successfully`);
    } catch (err) {
      console.error('[telegram] onMessage handler error:', err);
    }
  }

  // ── Ack Reaction ────────────────────────────────────────

  private async sendAckReaction(chatId: number, messageId: number): Promise<void> {
    await this.apiCall<unknown>('setMessageReaction', {
      chat_id: chatId,
      message_id: messageId,
      reaction: [{ type: 'emoji', emoji: '\uD83D\uDC40' }], // 👀
    });
  }

  private async registerCanonicalCommands(): Promise<void> {
    try {
      await this.apiCall<true>('setMyCommands', {
        commands: CANONICAL_TELEGRAM_COMMANDS,
      });
      console.log(`[telegram] Registered ${CANONICAL_TELEGRAM_COMMANDS.length} canonical commands`);
    } catch (err) {
      console.warn('[telegram] Failed to register canonical commands:', err);
    }
  }

  // ── Generic API Call ────────────────────────────────────

  private async apiCall<T>(method: string, body: Record<string, unknown>): Promise<T> {
    const url = `${API_BASE}${this.config.botToken}/${method}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Telegram ${method} HTTP ${res.status}: ${text}`);
    }

    const json = (await res.json()) as TgApiResponse<T>;
    if (!json.ok) {
      throw new Error(`Telegram ${method} API error: ${json.description}`);
    }
    return json.result;
  }

  // ── Offset Persistence ─────────────────────────────────

  private loadOffset(): number {
    try {
      const raw = readFileSync(this.offsetPath, 'utf-8');
      const data = JSON.parse(raw) as { offset?: number };
      return data.offset ?? 0;
    } catch {
      return 0;
    }
  }

  private saveOffset(): void {
    try {
      writeFileSync(this.offsetPath, JSON.stringify({ offset: this.offset }));
    } catch (err) {
      console.warn('[telegram] Failed to save offset:', err);
    }
  }
}

// ─── Helpers ────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Split a message into chunks that fit Telegram's 4096-char limit.
 * Tries to break at paragraph boundaries (\n\n), falls back to newlines,
 * then hard-cuts if necessary.
 */
function splitMessage(text: string): string[] {
  if (text.length <= MAX_MESSAGE_LENGTH) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > MAX_MESSAGE_LENGTH) {
    let cutAt = remaining.lastIndexOf('\n\n', MAX_MESSAGE_LENGTH);
    if (cutAt <= 0) cutAt = remaining.lastIndexOf('\n', MAX_MESSAGE_LENGTH);
    if (cutAt <= 0) cutAt = MAX_MESSAGE_LENGTH;

    chunks.push(remaining.slice(0, cutAt));
    remaining = remaining.slice(cutAt).replace(/^\n+/, '');
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}
