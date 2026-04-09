/**
 * COSMO Home 2.3 — Session & Message Router
 *
 * The central routing layer. All incoming messages from any channel
 * flow through here. Handles:
 *   - Thread bindings (channel:chatId → sessionId)
 *   - Message queue with debounce (collect mode)
 *   - Routing to QueryEngine for responses
 *   - Response delivery back to originating channel
 *
 * Core principle: Everything flows through one system.
 * Message arrives → router processes → response goes back.
 */

import { randomUUID, createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionsConfig, SessionRecord, ContentBlock, MediaAttachment } from '../types.js';

// ─── Types ───────────────────────────────────────────────────

export interface IncomingMessage {
  channel: string;         // 'telegram' | 'imessage' | 'discord' | 'webhook'
  chatId: string;          // Channel-specific chat/conversation ID
  senderId: string;        // Sender identifier
  senderName: string;      // Human-readable sender name
  text: string;            // Message text
  messageId?: string;      // Channel message ID (for ack/reply)
  timestamp: number;       // Unix ms
  metadata?: Record<string, unknown>;
  media?: MediaAttachment[];
}

export interface OutgoingResponse {
  text: string;
  channel: string;
  chatId: string;
  replyToMessageId?: string;
  model?: string;
  mode?: string;
  durationMs?: number;
  media?: MediaAttachment[];
  replyMarkup?: Record<string, unknown>;
}

export interface ChannelAdapter {
  name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  send(response: OutgoingResponse): Promise<void>;
}

type MessageHandler = (message: IncomingMessage) => Promise<OutgoingResponse>;

// ─── Thread Binding ──────────────────────────────────────────

interface ThreadBinding {
  sessionId: string;
  lastActivity: number;    // Unix ms
  channel: string;
  chatId: string;
}

// ─── Message Queue Item ──────────────────────────────────────

interface QueuedMessage {
  message: IncomingMessage;
  enqueuedAt: number;
}

interface TurnLogEntry {
  turnId: string;
  timestamp: string;
  channel: string;
  chatId: string;
  sessionId?: string;
  messageId?: string;
  status: 'running' | 'completed' | 'delivered' | 'failed';
  responseHash?: string;
  error?: string;
}

// ─── Session Router ──────────────────────────────────────────

export class SessionRouter {
  private config: SessionsConfig;
  private handler: MessageHandler;
  private adapters: Map<string, ChannelAdapter> = new Map();
  private bindings: Map<string, ThreadBinding> = new Map(); // "channel:chatId" → binding
  private queues: Map<string, QueuedMessage[]> = new Map(); // "channel:chatId" → pending messages
  private debounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private sessionsDir: string;
  private bindingsPath: string;
  private turnsDir: string;
  private deliveryReceiptsPath: string;

  constructor(config: SessionsConfig, handler: MessageHandler, sessionsDir: string) {
    this.config = config;
    this.handler = handler;
    this.sessionsDir = sessionsDir;
    this.bindingsPath = join(sessionsDir, 'thread-bindings.json');
    this.turnsDir = join(sessionsDir, 'turns');
    this.deliveryReceiptsPath = join(sessionsDir, 'delivery-receipts.jsonl');
    mkdirSync(sessionsDir, { recursive: true });
    mkdirSync(this.turnsDir, { recursive: true });
    this.loadBindings();
  }

  /**
   * Register a channel adapter.
   */
  registerAdapter(adapter: ChannelAdapter): void {
    this.adapters.set(adapter.name, adapter);
  }

  /**
   * Start all registered adapters.
   */
  async startAll(): Promise<void> {
    for (const [name, adapter] of this.adapters) {
      try {
        await adapter.start();
        console.log(`[router] Channel started: ${name}`);
      } catch (err) {
        console.error(`[router] Failed to start channel ${name}:`, err);
      }
    }
  }

  /**
   * Stop all registered adapters.
   */
  async stopAll(): Promise<void> {
    // Clear all debounce timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    for (const [name, adapter] of this.adapters) {
      try {
        await adapter.stop();
        console.log(`[router] Channel stopped: ${name}`);
      } catch (err) {
        console.error(`[router] Failed to stop channel ${name}:`, err);
      }
    }
  }

  /**
   * Handle an incoming message from any channel.
   * This is the main entry point — channel adapters call this.
   */
  async handleMessage(message: IncomingMessage): Promise<void> {
    const key = `${message.channel}:${message.chatId}`;

    // Resolve binding first so logToSession has a valid binding for new sessions
    this.resolveBinding(key, message);

    // Log the incoming message to session JSONL
    this.logToSession(key, message);

    if (this.config.messageQueue.mode === 'collect') {
      // Collect mode: queue messages and debounce
      this.enqueue(key, message);
    } else {
      // Direct mode: process immediately
      await this.processMessage(message);
    }
  }

  /**
   * Enqueue a message and reset the debounce timer.
   */
  private enqueue(key: string, message: IncomingMessage): void {
    let queue = this.queues.get(key);
    if (!queue) {
      queue = [];
      this.queues.set(key, queue);
    }

    queue.push({ message, enqueuedAt: Date.now() });

    // Enforce cap
    const { cap, overflowStrategy } = this.config.messageQueue;
    if (queue.length > cap) {
      if (overflowStrategy === 'summarize') {
        // Keep first and last, mark middle as summarized
        const first = queue[0]!;
        const last = queue[queue.length - 1]!;
        const droppedCount = queue.length - 2;
        const summaryMessage: IncomingMessage = {
          ...first.message,
          text: `[${droppedCount} messages collected]\n\n${first.message.text}\n...\n${last.message.text}`,
        };
        queue.length = 0;
        queue.push({ message: summaryMessage, enqueuedAt: Date.now() });
      } else {
        // Drop oldest
        queue.splice(0, queue.length - cap);
      }
    }

    // Reset debounce timer
    const existingTimer = this.debounceTimers.get(key);
    if (existingTimer) clearTimeout(existingTimer);

    const timer = setTimeout(() => {
      this.debounceTimers.delete(key);
      this.flushQueue(key).catch(err => {
        console.error(`[router] Queue flush error for ${key}:`, err);
      });
    }, this.config.messageQueue.debounceMs);

    this.debounceTimers.set(key, timer);
  }

  /**
   * Flush queued messages: combine into one and process.
   */
  private async flushQueue(key: string): Promise<void> {
    const queue = this.queues.get(key);
    if (!queue || queue.length === 0) return;

    // Combine queued messages into one
    const messages = queue.splice(0);
    let combinedText: string;

    if (messages.length === 1) {
      combinedText = messages[0]!.message.text;
    } else {
      combinedText = messages
        .map((m, i) => `[${i + 1}/${messages.length}] ${m.message.text}`)
        .join('\n\n');
    }

    // Use the latest message as the base, with combined text
    const latestMsg = messages[messages.length - 1]!.message;
    const combined: IncomingMessage = {
      ...latestMsg,
      text: combinedText,
    };

    await this.processMessage(combined);
  }

  /**
   * Process a single message: resolve session, call handler, deliver response.
   */
  private async processMessage(message: IncomingMessage): Promise<void> {
    const key = `${message.channel}:${message.chatId}`;
    const binding = this.bindings.get(key);
    const turnId = randomUUID();

    this.appendTurnLog({
      turnId,
      timestamp: new Date().toISOString(),
      channel: message.channel,
      chatId: message.chatId,
      sessionId: binding?.sessionId,
      messageId: message.messageId,
      status: 'running',
    });

    try {
      const response = await this.handler(message);

      this.appendTurnLog({
        turnId,
        timestamp: new Date().toISOString(),
        channel: message.channel,
        chatId: message.chatId,
        sessionId: binding?.sessionId,
        messageId: message.messageId,
        status: 'completed',
        responseHash: this.hashResponse(response),
      });

      this.logResponseToSession(key, response);

      const adapter = this.adapters.get(message.channel);
      if (adapter) {
        if (this.hasDeliveryReceipt(message.channel, message.chatId, turnId)) {
          console.warn(`[router] Skipping duplicate delivery for ${message.channel}:${message.chatId} turn ${turnId}`);
          return;
        }

        await adapter.send(response);
        this.appendDeliveryReceipt(message.channel, message.chatId, turnId, response);
        this.appendTurnLog({
          turnId,
          timestamp: new Date().toISOString(),
          channel: message.channel,
          chatId: message.chatId,
          sessionId: binding?.sessionId,
          messageId: message.messageId,
          status: 'delivered',
          responseHash: this.hashResponse(response),
        });
      } else {
        console.warn(`[router] No adapter for channel: ${message.channel}`);
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.appendTurnLog({
        turnId,
        timestamp: new Date().toISOString(),
        channel: message.channel,
        chatId: message.chatId,
        sessionId: binding?.sessionId,
        messageId: message.messageId,
        status: 'failed',
        error: errorMsg,
      });

      console.error(`[router] Error processing message from ${key}:`, err);

      const adapter = this.adapters.get(message.channel);
      if (adapter) {
        try {
          await adapter.send({
            text: 'An error occurred processing your message. Check the logs.',
            channel: message.channel,
            chatId: message.chatId,
            // Don't reply-to-message — it creates threads in Telegram DMs
          });
        } catch {
          // Can't even send the error — just log
        }
      }
    }
  }

  /**
   * Persist thread bindings to disk.
   */
  private saveBindings(): void {
    try {
      const obj: Record<string, ThreadBinding> = {};
      for (const [k, v] of this.bindings) obj[k] = v;
      writeFileSync(this.bindingsPath, JSON.stringify(obj, null, 2));
    } catch (err) {
      console.warn('[router] Failed to save thread bindings:', err);
    }
  }

  /**
   * Load thread bindings from disk on startup.
   */
  private loadBindings(): void {
    try {
      if (existsSync(this.bindingsPath)) {
        const raw = JSON.parse(readFileSync(this.bindingsPath, 'utf8'));
        for (const [k, v] of Object.entries(raw)) {
          this.bindings.set(k, v as ThreadBinding);
        }
        console.log(`[router] Loaded ${this.bindings.size} thread binding(s) from disk`);
      }
    } catch (err) {
      console.warn('[router] Failed to load thread bindings:', err);
    }
  }

  /**
   * Resolve thread binding: find existing session or create new.
   */
  private resolveBinding(key: string, message: IncomingMessage): ThreadBinding {
    const existing = this.bindings.get(key);

    if (existing) {
      const idleMs = Date.now() - existing.lastActivity;
      const idleHours = idleMs / (1000 * 60 * 60);

      if (idleHours < this.config.threadBindings.idleHours) {
        // Still active — update last activity
        existing.lastActivity = Date.now();
        this.saveBindings();
        return existing;
      }

      // Expired — create new binding
      console.log(`[router] Thread binding expired for ${key} (idle ${idleHours.toFixed(1)}h)`);
    }

    // Create new binding
    const binding: ThreadBinding = {
      sessionId: randomUUID(),
      lastActivity: Date.now(),
      channel: message.channel,
      chatId: message.chatId,
    };
    this.bindings.set(key, binding);
    console.log(`[router] New thread binding: ${key} → ${binding.sessionId}`);
    this.saveBindings();
    return binding;
  }

  /**
   * Log incoming message to session JSONL file.
   */
  private logToSession(key: string, message: IncomingMessage): void {
    const binding = this.bindings.get(key);
    if (!binding) return;

    const record: SessionRecord = {
      type: 'message',
      id: randomUUID().slice(0, 8),
      timestamp: new Date(message.timestamp).toISOString(),
      message: {
        role: 'user',
        content: [{ type: 'text', text: `[${message.channel} ${message.senderName}] ${message.text}` }],
      },
    };

    const sessionFile = join(this.sessionsDir, `${binding.sessionId}.jsonl`);
    appendFileSync(sessionFile, JSON.stringify(record) + '\n');
  }

  /**
   * Log outgoing response to session JSONL file.
   */
  private logResponseToSession(key: string, response: OutgoingResponse): void {
    const binding = this.bindings.get(key);
    if (!binding) return;

    const record: SessionRecord = {
      type: 'message',
      id: randomUUID().slice(0, 8),
      timestamp: new Date().toISOString(),
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: response.text }],
        model: response.model,
      },
    };

    const sessionFile = join(this.sessionsDir, `${binding.sessionId}.jsonl`);
    appendFileSync(sessionFile, JSON.stringify(record) + '\n');
  }

  private getTurnLogPath(): string {
    const day = new Date().toISOString().slice(0, 10);
    return join(this.turnsDir, `${day}.jsonl`);
  }

  private appendTurnLog(entry: TurnLogEntry): void {
    try {
      appendFileSync(this.getTurnLogPath(), JSON.stringify(entry) + '\n');
    } catch (err) {
      console.warn('[router] Failed to append turn log:', err);
    }
  }

  private hashResponse(response: OutgoingResponse): string {
    const payload = JSON.stringify({
      text: response.text,
      chatId: response.chatId,
      channel: response.channel,
      media: response.media ?? [],
      replyMarkup: response.replyMarkup ?? null,
    });
    return createHash('sha256').update(payload).digest('hex');
  }

  private hasDeliveryReceipt(channel: string, chatId: string, turnId: string): boolean {
    if (!existsSync(this.deliveryReceiptsPath)) {
      return false;
    }

    try {
      const lines = readFileSync(this.deliveryReceiptsPath, 'utf8')
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean);

      for (const line of lines) {
        const receipt = JSON.parse(line) as { channel?: string; chatId?: string; turnId?: string };
        if (receipt.channel === channel && receipt.chatId === chatId && receipt.turnId === turnId) {
          return true;
        }
      }
    } catch (err) {
      console.warn('[router] Failed to read delivery receipts:', err);
    }

    return false;
  }

  private appendDeliveryReceipt(channel: string, chatId: string, turnId: string, response: OutgoingResponse): void {
    try {
      appendFileSync(this.deliveryReceiptsPath, JSON.stringify({
        timestamp: new Date().toISOString(),
        channel,
        chatId,
        turnId,
        responseHash: this.hashResponse(response),
      }) + '\n');
    } catch (err) {
      console.warn('[router] Failed to append delivery receipt:', err);
    }
  }

  /**
   * Get active binding count.
   */
  get activeBindings(): number {
    return this.bindings.size;
  }

  /**
   * Get pending queue sizes.
   */
  get queueSizes(): Map<string, number> {
    const sizes = new Map<string, number>();
    for (const [key, queue] of this.queues) {
      if (queue.length > 0) sizes.set(key, queue.length);
    }
    return sizes;
  }

  /**
   * Read-only snapshot of current thread bindings for observability/API use.
   */
  getBindingsSnapshot(): Array<{
    key: string;
    sessionId: string;
    lastActivity: number;
    channel: string;
    chatId: string;
  }> {
    return Array.from(this.bindings.entries()).map(([key, binding]) => ({
      key,
      sessionId: binding.sessionId,
      lastActivity: binding.lastActivity,
      channel: binding.channel,
      chatId: binding.chatId,
    }));
  }

  /**
   * Resolve a single binding by its canonical router key.
   */
  getBindingByKey(key: string): {
    key: string;
    sessionId: string;
    lastActivity: number;
    channel: string;
    chatId: string;
  } | null {
    const binding = this.bindings.get(key);
    if (!binding) return null;
    return {
      key,
      sessionId: binding.sessionId,
      lastActivity: binding.lastActivity,
      channel: binding.channel,
      chatId: binding.chatId,
    };
  }
}
