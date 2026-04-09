/**
 * COSMO Home 2.3 — Bridge Chat
 *
 * SQLite-backed message bus with optional Telegram mirror.
 * Provides lane-based messaging for sibling coordination.
 */

import Database from 'better-sqlite3';

// ─── Types ───────────────────────────────────────────────────

export interface BridgeChatConfig {
  dbPath: string;
  telegramBotToken?: string;
  telegramTargetId?: string;
}

export interface Message {
  id: number;
  lane: string;
  from: string;
  text: string;
  timestamp: number;
  createdAt: string;
}

export interface Lane {
  id: string;
  mirrorMode: string;
  description: string;
}

// ─── Bridge Chat ─────────────────────────────────────────────

export class BridgeChat {
  private db: Database.Database;
  private config: BridgeChatConfig;

  constructor(config: BridgeChatConfig) {
    this.config = config;
    this.db = new Database(config.dbPath);
    this.db.pragma('journal_mode = WAL');
  }

  /**
   * Create tables if they don't exist.
   */
  init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS lanes (
        id TEXT PRIMARY KEY,
        mirror_mode TEXT DEFAULT 'all',
        description TEXT
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        lane TEXT NOT NULL,
        "from" TEXT NOT NULL,
        text TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        created_at TEXT NOT NULL
      )
    `);
  }

  /**
   * Send a message to a lane. Mirrors to Telegram if configured.
   * Returns the new message ID.
   */
  async sendToLane(lane: string, from: string, text: string): Promise<number> {
    const now = Date.now();
    const createdAt = new Date(now).toISOString();

    const stmt = this.db.prepare(
      'INSERT INTO messages (lane, "from", text, timestamp, created_at) VALUES (?, ?, ?, ?, ?)'
    );
    const result = stmt.run(lane, from, text, now, createdAt);
    const messageId = Number(result.lastInsertRowid);

    // Check if lane should mirror to Telegram
    const laneRow = this.db.prepare('SELECT mirror_mode FROM lanes WHERE id = ?').get(lane) as
      | { mirror_mode: string }
      | undefined;

    if (
      laneRow?.mirror_mode === 'all' &&
      this.config.telegramBotToken &&
      this.config.telegramTargetId
    ) {
      await this.mirrorToTelegram(lane, from, text);
    }

    return messageId;
  }

  /**
   * Get messages from a lane, optionally filtered.
   */
  getMessages(lane: string, opts?: { since?: number; limit?: number }): Message[] {
    const since = opts?.since ?? 0;
    const limit = opts?.limit ?? 100;

    const rows = this.db
      .prepare(
        'SELECT id, lane, "from" as "from", text, timestamp, created_at FROM messages WHERE lane = ? AND timestamp > ? ORDER BY timestamp ASC LIMIT ?'
      )
      .all(lane, since, limit) as Array<{
      id: number;
      lane: string;
      from: string;
      text: string;
      timestamp: number;
      created_at: string;
    }>;

    return rows.map(row => ({
      id: row.id,
      lane: row.lane,
      from: row.from,
      text: row.text,
      timestamp: row.timestamp,
      createdAt: row.created_at,
    }));
  }

  /**
   * Get all lanes.
   */
  getLanes(): Lane[] {
    const rows = this.db
      .prepare('SELECT id, mirror_mode, description FROM lanes')
      .all() as Array<{ id: string; mirror_mode: string; description: string }>;

    return rows.map(row => ({
      id: row.id,
      mirrorMode: row.mirror_mode,
      description: row.description,
    }));
  }

  /**
   * Create a new lane.
   */
  createLane(id: string, description?: string, mirrorMode?: string): void {
    this.db
      .prepare('INSERT OR IGNORE INTO lanes (id, description, mirror_mode) VALUES (?, ?, ?)')
      .run(id, description ?? '', mirrorMode ?? 'all');
  }

  /**
   * Mirror a message to Telegram.
   */
  private async mirrorToTelegram(lane: string, from: string, text: string): Promise<void> {
    const { telegramBotToken, telegramTargetId } = this.config;
    if (!telegramBotToken || !telegramTargetId) return;

    const url = `https://api.telegram.org/bot${telegramBotToken}/sendMessage`;
    const formatted = `*[${lane}]* ${from}: ${text}`;

    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: telegramTargetId,
          text: formatted,
          parse_mode: 'Markdown',
        }),
      });
    } catch (err) {
      console.error('[bridge-chat] Telegram mirror failed:', err);
    }
  }
}
