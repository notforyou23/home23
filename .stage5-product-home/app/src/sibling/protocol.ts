/**
 * COSMO Home 2.3 — Sibling Protocol
 *
 * Handles COZ <-> Axiom communication over HTTP webhooks.
 * Rate-limited, deduped, retried. Never throws on send failure.
 */

import { createHash } from 'node:crypto';

// ─── Types ───────────────────────────────────────────────────

export interface SiblingProtocolConfig {
  localInstance: string;
  remoteUrl: string;
  token: string;
  rateLimits: {
    maxPerMinute: number;
    retries: number;
    dedupWindowSeconds: number;
  };
  ackMode: boolean;
}

export interface SiblingMessage {
  from: string;
  text: string;
  timestamp: string;
}

export interface SiblingStats {
  messagesSent: number;
  messagesReceived: number;
  lastSendAt?: string;
  lastReceiveAt?: string;
  consecutiveFailures: number;
}

// ─── Protocol ────────────────────────────────────────────────

export class SiblingProtocol {
  private config: SiblingProtocolConfig;
  private sendTimestamps: number[] = [];
  private recentHashes: Map<string, number> = new Map(); // hash → timestamp
  private stats: SiblingStats = {
    messagesSent: 0,
    messagesReceived: 0,
    consecutiveFailures: 0,
  };
  private receiveCallbacks: Array<(message: SiblingMessage) => void> = [];

  constructor(config: SiblingProtocolConfig) {
    this.config = config;
  }

  /**
   * Send an operational/coordination message to the sibling.
   */
  async sendMessage(text: string, from?: string): Promise<boolean> {
    return this.doSend('/hooks/sibling', text, from);
  }

  /**
   * Send a relationship/letter message to the sibling.
   */
  async sendLetter(text: string, from?: string): Promise<boolean> {
    return this.doSend('/hooks/letter', text, from);
  }

  /**
   * Get protocol statistics.
   */
  getStats(): SiblingStats {
    return { ...this.stats };
  }

  /**
   * Register a callback for incoming sibling messages.
   * Called by the webhook adapter when a message arrives.
   */
  onReceive(callback: (message: SiblingMessage) => void): void {
    this.receiveCallbacks.push(callback);
  }

  /**
   * Dispatch an incoming message to all registered callbacks.
   * Called by the webhook adapter layer.
   */
  dispatchReceived(message: SiblingMessage): void {
    this.stats.messagesReceived++;
    this.stats.lastReceiveAt = new Date().toISOString();
    for (const cb of this.receiveCallbacks) {
      try {
        cb(message);
      } catch (err) {
        console.error('[sibling] Receive callback error:', err);
      }
    }
  }

  // ─── Internal ────────────────────────────────────────────────

  private async doSend(path: string, text: string, from?: string): Promise<boolean> {
    const sender = from ?? this.config.localInstance;

    // Rate limit check
    if (!this.checkRateLimit()) {
      console.warn('[sibling] Rate limit exceeded, dropping message');
      return false;
    }

    // Dedup check
    if (this.isDuplicate(text, sender)) {
      console.warn('[sibling] Duplicate message within dedup window, skipping');
      return false;
    }

    const url = `${this.config.remoteUrl}${path}`;
    const body = JSON.stringify({ message: text, from: sender });

    // Retry loop with exponential backoff
    const maxAttempts = this.config.rateLimits.retries + 1;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0) {
        const delayMs = 1000 * Math.pow(2, attempt - 1); // 1s, 2s, 4s...
        await this.sleep(delayMs);
      }

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.config.token}`,
          },
          body,
        });

        if (response.ok) {
          this.recordSend();
          this.recordHash(text, sender);
          this.stats.messagesSent++;
          this.stats.lastSendAt = new Date().toISOString();
          this.stats.consecutiveFailures = 0;
          return true;
        }

        console.warn(`[sibling] Send attempt ${attempt + 1} failed: HTTP ${response.status}`);
      } catch (err) {
        console.warn(`[sibling] Send attempt ${attempt + 1} error:`, err);
      }
    }

    this.stats.consecutiveFailures++;
    return false;
  }

  private checkRateLimit(): boolean {
    const now = Date.now();
    const windowStart = now - 60_000;

    // Prune old timestamps
    this.sendTimestamps = this.sendTimestamps.filter(t => t > windowStart);

    return this.sendTimestamps.length < this.config.rateLimits.maxPerMinute;
  }

  private recordSend(): void {
    this.sendTimestamps.push(Date.now());
  }

  private isDuplicate(text: string, from: string): boolean {
    const hash = this.hashMessage(text, from);
    const now = Date.now();
    const windowMs = this.config.rateLimits.dedupWindowSeconds * 1000;

    // Prune expired hashes
    for (const [h, ts] of this.recentHashes) {
      if (now - ts > windowMs) {
        this.recentHashes.delete(h);
      }
    }

    return this.recentHashes.has(hash);
  }

  private recordHash(text: string, from: string): void {
    const hash = this.hashMessage(text, from);
    this.recentHashes.set(hash, Date.now());
  }

  private hashMessage(text: string, from: string): string {
    return createHash('sha256').update(`${from}:${text}`).digest('hex').slice(0, 16);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
