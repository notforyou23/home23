import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";

import { runMutationWithEvent } from "../../../src/coordination/db/transaction.js";
import { COORDINATION_SPINE_MIGRATION_SQL } from "../../../src/coordination/migrations/0001-coordination-spine.js";
import { CONNECTED_AGENTS_PRODUCT_SCHEMA_MIGRATION_SQL } from "../../../src/coordination/migrations/0002-connected-agents-product-schema.js";
import { WORK_SCHEMA_DELTA_SQL } from "../../../src/coordination/work/schema-delta.js";

const PREFIX = {
  attempt: "att",
  bot: "bot",
  channel: "chn",
  contextManifest: "ctx",
  correlation: "cor",
  delivery: "dlv",
  event: "evt",
  lease: "lse",
  message: "msg",
  outbox: "obx",
  request: "req",
  round: "rnd",
  work: "wrk",
  workObservation: "obs",
} as const;

export type FixtureIdKind = keyof typeof PREFIX;

export function fixtureId(kind: FixtureIdKind, suffix: number): string {
  return `${PREFIX[kind]}_0198d95f-6c00-7000-8000-${String(suffix).padStart(12, "0")}`;
}

export const OWNER_ID = "user_owner";
export const BOT_ID = fixtureId("bot", 1);
export const CHANNEL_ID = fixtureId("channel", 1);
export const MESSAGE_ID = fixtureId("message", 1);
export const AT = "2026-08-25T16:00:00.000Z";

export class M11TestDatabase {
  raw: Database.Database;

  constructor(readonly path: string, initialize = true) {
    this.raw = new Database(path);
    this.raw.pragma("foreign_keys = ON");
    if (initialize) {
      this.raw.exec(COORDINATION_SPINE_MIGRATION_SQL);
      this.raw.exec(CONNECTED_AGENTS_PRODUCT_SCHEMA_MIGRATION_SQL);
      this.raw.exec(WORK_SCHEMA_DELTA_SQL);
      this.seedProductRows();
    }
  }

  static temporary(): M11TestDatabase {
    const directory = mkdtempSync(join(tmpdir(), "home23-m11-"));
    return new M11TestDatabase(join(directory, "coordination.sqlite"));
  }

  reopen(): void {
    this.raw.close();
    this.raw = new Database(this.path);
    this.raw.pragma("foreign_keys = ON");
  }

  readOne<T>(sql: string, ...parameters: Array<string | number | bigint | Buffer | null>): T | undefined {
    return this.raw.prepare(sql).get(...parameters) as T | undefined;
  }

  readAll<T>(sql: string, ...parameters: Array<string | number | bigint | Buffer | null>): T[] {
    return this.raw.prepare(sql).all(...parameters) as T[];
  }

  mutateWithEvent<T>(mutate: Parameters<typeof runMutationWithEvent<T>>[1]) {
    return runMutationWithEvent(this.raw, mutate);
  }

  close(): void {
    if (this.raw.open) this.raw.close();
  }

  private seedProductRows(): void {
    this.raw.prepare("INSERT INTO principals (id, kind, created_at) VALUES (?, 'owner', ?)")
      .run(OWNER_ID, AT);
    this.raw.prepare("INSERT INTO principals (id, kind, created_at) VALUES (?, 'bot', ?)")
      .run(BOT_ID, AT);
    this.raw.prepare(
      `INSERT INTO bots (
        id, principal_id, name, purpose, lifecycle, conversation_id,
        resident_binding, continuing_identity, durable_mailbox,
        required_capabilities_json, active_instance_id, active_key_version,
        resident_protocol_version, resident_capabilities_json,
        resident_registered_at, last_heartbeat_at, reported_availability,
        version, created_at, updated_at
      ) VALUES (?, ?, 'Jerry', 'Persistent resident', 'active', NULL,
                'jerry', 1, 1, '["messages"]', 'resident-1', 1, 1,
                '["messages"]', ?, ?, 'available', 1, ?, ?)`,
    ).run(BOT_ID, BOT_ID, AT, AT, AT, AT);
    this.raw.prepare(
      `INSERT INTO channels (
        id, kind, title, purpose, owner_principal_id, responder_mode,
        coordinator_bot_id, response_order, max_bot_turns, lifecycle, pinned,
        version, next_message_sequence, created_at, updated_at
      ) VALUES (?, 'direct', 'Jerry', '', 'user_owner', 'mentions_only',
                NULL, 'parallel', 1, 'active', 0, 1, 2, ?, ?)`,
    ).run(CHANNEL_ID, AT, AT);
    this.raw.prepare(
      `INSERT INTO channel_members (
        channel_id, principal_id, kind, role, active, joined_at, left_at
      ) VALUES (?, 'user_owner', 'owner', 'owner', 1, ?, NULL),
               (?, ?, 'bot', 'member', 1, ?, NULL)`,
    ).run(CHANNEL_ID, AT, CHANNEL_ID, BOT_ID, AT);
    this.raw.prepare(
      `INSERT INTO messages (
        id, channel_id, channel_sequence, author_principal_id, author_kind,
        author_display_name, kind, body_text, stored_visibility,
        client_message_id, reply_to_message_id, tombstones_message_id,
        round_id, work_id, created_at
      ) VALUES (?, ?, 1, 'user_owner', 'owner', 'Owner', 'text', 'not exposed',
                'visible', NULL, NULL, NULL, NULL, NULL, ?)`,
    ).run(MESSAGE_ID, CHANNEL_ID, AT);
  }
}

export function createFixtureIdGenerator(start = 1_000) {
  let next = start;
  return (kind: FixtureIdKind): string => fixtureId(kind, next++);
}

export function manifestInput(overrides: Record<string, unknown> = {}) {
  return {
    privacy: "channel_only",
    channelId: CHANNEL_ID,
    messageIds: [MESSAGE_ID],
    artifactIds: [] as string[],
    counts: { messages: 1, artifacts: 0 },
    watermarks: { channelSequence: 1, eventSequence: 0 },
    digests: { context: "a".repeat(64), source: "b".repeat(64) },
    ...overrides,
  };
}
