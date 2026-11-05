import type {
  BootstrapAvailabilityPolicy,
  BootstrapBotProjection,
  BootstrapChannelProjection,
  BootstrapConversationProjection,
  BootstrapProjectionBoundary,
  BootstrapReadDatabase,
} from "./types.js";

interface BootstrapBoundaryRow {
  throughEventSequence: number;
  botsJson: string;
  channelsJson: string;
  conversationsJson: string;
}

interface StoredBotProjection extends Omit<BootstrapBotProjection, "availability"> {
  reportedAvailability: BootstrapBotProjection["availability"] | null;
  lastHeartbeatAt: string | null;
  continuingIdentity: number;
  durableMailbox: number;
  requiredCapabilitiesJson: string;
  residentCapabilitiesJson: string;
}

const BOOTSTRAP_PROJECTION_SQL = `
WITH boundary AS (
  SELECT coalesce((SELECT seq FROM sqlite_sequence WHERE name = 'events'), 0)
    AS through_event_sequence
), authorized_channels AS (
  SELECT c.*
  FROM channels c
  JOIN channel_members member
    ON member.channel_id = c.id
   AND member.principal_id = ?
   AND member.active = 1
)
SELECT
  boundary.through_event_sequence AS throughEventSequence,
  (
    SELECT coalesce(json_group_array(json_object(
      'id', ordered.id,
      'name', ordered.name,
      'lifecycle', ordered.lifecycle,
      'conversationId', ordered.conversationId,
      'version', ordered.version,
      'reportedAvailability', ordered.reportedAvailability,
      'lastHeartbeatAt', ordered.lastHeartbeatAt,
      'continuingIdentity', ordered.continuingIdentity,
      'durableMailbox', ordered.durableMailbox,
      'requiredCapabilitiesJson', ordered.requiredCapabilitiesJson,
      'residentCapabilitiesJson', ordered.residentCapabilitiesJson
    )), '[]')
    FROM (
      SELECT id, name, lifecycle, conversation_id AS conversationId, version,
             reported_availability AS reportedAvailability,
             last_heartbeat_at AS lastHeartbeatAt,
             continuing_identity AS continuingIdentity,
             durable_mailbox AS durableMailbox,
             required_capabilities_json AS requiredCapabilitiesJson,
             resident_capabilities_json AS residentCapabilitiesJson
      FROM bots
      ORDER BY name COLLATE NOCASE ASC, id ASC
    ) ordered
  ) AS botsJson,
  (
    SELECT coalesce(json_group_array(json_object(
      'id', ordered.id,
      'conversationId', ordered.conversationId,
      'kind', ordered.kind,
      'title', ordered.title,
      'lifecycle', ordered.lifecycle,
      'version', ordered.version
    )), '[]')
    FROM (
      SELECT c.id, h.id AS conversationId, c.kind, c.title, c.lifecycle, c.version
      FROM authorized_channels c
      JOIN conversation_handles h ON h.channel_id = c.id
      ORDER BY c.updated_at DESC, c.id ASC
    ) ordered
  ) AS channelsJson,
  (
    SELECT coalesce(json_group_array(json_object(
      'id', ordered.id,
      'channelId', ordered.channelId,
      'latestSequence', ordered.latestSequence,
      'unreadCount', ordered.unreadCount,
      'version', ordered.version
    )), '[]')
    FROM (
      SELECT
        h.id,
        c.id AS channelId,
        c.next_message_sequence - 1 AS latestSequence,
        (
          SELECT count(*)
          FROM messages m
          WHERE m.channel_id = c.id
            AND m.channel_sequence > coalesce((
              SELECT cursor.read_through_sequence
              FROM read_cursors cursor
              WHERE cursor.channel_id = c.id AND cursor.principal_id = ?
            ), 0)
            AND m.author_principal_id <> ?
            AND m.stored_visibility = 'visible'
            AND NOT EXISTS (
              SELECT 1 FROM messages tombstone
              WHERE tombstone.tombstones_message_id = m.id
            )
        ) AS unreadCount,
        c.version
      FROM authorized_channels c
      JOIN conversation_handles h ON h.channel_id = c.id
      ORDER BY c.updated_at DESC, c.id ASC
    ) ordered
  ) AS conversationsJson
FROM boundary`;

function availability(
  bot: StoredBotProjection,
  atMs: number,
  policy: BootstrapAvailabilityPolicy,
): BootstrapBotProjection["availability"] {
  if (
    bot.lifecycle !== "active" ||
    bot.lastHeartbeatAt === null ||
    bot.reportedAvailability === null
  ) {
    return "offline";
  }
  const heartbeatMs = Date.parse(bot.lastHeartbeatAt);
  if (!Number.isFinite(heartbeatMs)) return "degraded";
  const age = atMs - heartbeatMs;
  if (age >= policy.offlineAfterMs) return "offline";
  const requiredCapabilities = parseCapabilities(
    bot.requiredCapabilitiesJson,
    bot.id,
    "required",
  );
  const residentCapabilities = new Set(parseCapabilities(
    bot.residentCapabilitiesJson,
    bot.id,
    "resident",
  ));
  if (
    age < 0 ||
    age >= policy.degradedAfterMs ||
    requiredCapabilities.some((capability) => !residentCapabilities.has(capability))
  ) {
    return "degraded";
  }
  return bot.reportedAvailability;
}

function parseCapabilities(
  json: string,
  botId: string,
  label: "required" | "resident",
): string[] {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error(`bootstrap Bot ${botId} ${label} capabilities are malformed`);
  }
  if (!Array.isArray(value) || value.some((capability) => typeof capability !== "string")) {
    throw new Error(`bootstrap Bot ${botId} ${label} capabilities are malformed`);
  }
  return value;
}

function isVisible(bot: StoredBotProjection): boolean {
  return (
    bot.lifecycle !== "archived" &&
    bot.continuingIdentity === 1 &&
    bot.durableMailbox === 1
  );
}

function parseArray<T>(json: string, label: string): T[] {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error(`bootstrap ${label} projection is malformed`);
  }
  if (!Array.isArray(value)) throw new Error(`bootstrap ${label} projection is not an array`);
  return value as T[];
}

export class SqliteBootstrapRepository {
  constructor(private readonly database: BootstrapReadDatabase) {}

  readProjection(input: {
    principalId: string;
    at: string;
    availabilityPolicy: BootstrapAvailabilityPolicy;
  }): BootstrapProjectionBoundary {
    const atMs = Date.parse(input.at);
    if (!Number.isFinite(atMs) || new Date(atMs).toISOString() !== input.at) {
      throw new TypeError("bootstrap boundary timestamp must be UTC ISO-8601 with milliseconds");
    }
    const { degradedAfterMs, offlineAfterMs } = input.availabilityPolicy;
    if (
      !Number.isSafeInteger(degradedAfterMs) || degradedAfterMs < 1 ||
      !Number.isSafeInteger(offlineAfterMs) || offlineAfterMs <= degradedAfterMs
    ) {
      throw new TypeError("bootstrap availability thresholds are invalid");
    }
    const rows = this.database.readAll<BootstrapBoundaryRow>(
      BOOTSTRAP_PROJECTION_SQL,
      input.principalId,
      input.principalId,
      input.principalId,
    );
    const row = rows[0];
    if (!row || !Number.isSafeInteger(row.throughEventSequence)) {
      throw new Error("bootstrap projection boundary is missing");
    }
    const storedBots = parseArray<StoredBotProjection>(row.botsJson, "Bot");
    const bots = storedBots
      .filter(isVisible)
      .map((bot) => Object.freeze({
        id: bot.id,
        name: bot.name,
        lifecycle: bot.lifecycle,
        availability: availability(bot, atMs, input.availabilityPolicy),
        conversationId: bot.conversationId,
        version: bot.version,
      }))
      .sort((left, right) =>
        left.name < right.name ? -1 : left.name > right.name ? 1 :
          left.id < right.id ? -1 : left.id > right.id ? 1 : 0
      );
    const channels = parseArray<BootstrapChannelProjection>(
      row.channelsJson,
      "Channel",
    ).map((channel) => Object.freeze(channel));
    const conversations = parseArray<BootstrapConversationProjection>(
      row.conversationsJson,
      "Conversation",
    ).map((conversation) => Object.freeze(conversation));
    const snapshot = Object.freeze({
      bots: Object.freeze(bots),
      channels: Object.freeze(channels),
      conversations: Object.freeze(conversations),
      unreadTotal: conversations.reduce(
        (total, conversation) => total + conversation.unreadCount,
        0,
      ),
    });
    return Object.freeze({
      snapshot,
      throughEventSequence: row.throughEventSequence,
    });
  }
}
