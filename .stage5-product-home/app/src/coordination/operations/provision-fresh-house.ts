import Database from "better-sqlite3";
import { existsSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { openCoordinationDatabase } from "../db/index.js";
import { createBotDirectory, SqliteBotDirectoryRepository } from "../bots/index.js";
import { createChannelService, SqliteBotConversationBindingAdapter, SqliteMessagingRepository } from "../channels/index.js";
import { generateCoordinationId } from "../ids/index.js";
import { COORDINATION_CANONICAL_WRITER } from "../epochs/index.js";
import { HOUSE_RESIDENT_CAPABILITIES } from "../house-resident-capabilities.js";
import { M11MessageProvenanceAuthority } from "../work/index.js";

const CLAIM_KEY = "home23.fresh-house.claim.v1";
const RECEIPT_KEY = "home23.fresh-house.receipt.v1";
const CAPABILITIES = ["messages", "roster", "unread", "search", "attachments", "activity", "bot_lifecycle"] as const;

export interface FreshHouseInput {
  databasePath: string;
  home: { id: string; name: string };
  resident: { slug: string; name: string; purpose: string };
  now?: () => Date;
}
export interface FreshHouseReceipt {
  home: { id: string; name: string };
  residentBinding: string;
  botId: string;
  channelId: string;
  conversationId: string;
  authorityCapabilities: readonly string[];
  replayed: boolean;
}

/**
 * Birth of a new, independent canonical home. This is not an upgrade/cutover
 * operation: an existing database without our fresh-home claim is refused.
 * The durable claim allows interruption recovery and same-input replay while
 * retaining all subsequently acquired identity, messages and authority history.
 * Credentials stay in installation secrets; availability requires the real
 * resident's signed registration after startup, never a provisioner's assertion.
 */
export async function provisionFreshHouse(input: FreshHouseInput): Promise<FreshHouseReceipt> {
  if (!isAbsolute(input.databasePath) || input.databasePath.includes("\0")) throw new TypeError("fresh house database path must be absolute");
  if (!/^home_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input.home.id)) throw new TypeError("fresh house ID is invalid");
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(input.resident.slug) || input.resident.slug.startsWith("bot-")) throw new TypeError("fresh house resident slug is invalid");
  for (const [label, value, limit] of [["home name", input.home.name, 256], ["resident name", input.resident.name, 128], ["resident purpose", input.resident.purpose, 512]] as const) {
    if (typeof value !== "string" || !value.trim() || value.length > limit || value.includes("\0")) throw new TypeError(`fresh house ${label} is invalid`);
  }
  const definition = { home: { ...input.home }, resident: { ...input.resident } };
  const digest = createHash("sha256").update(JSON.stringify(definition)).digest("hex");
  if (existsSync(input.databasePath) && statSync(input.databasePath).size > 0) {
    const preflight = new Database(input.databasePath, { readonly: true, fileMustExist: true });
    try {
      const tables = new Set((preflight.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {name:string}[]).map(row => row.name));
      const claim = tables.has("kernel_meta") ? preflight.prepare("SELECT value FROM kernel_meta WHERE key=?").get(CLAIM_KEY) as {value:string}|undefined : undefined;
      if (claim && claim.value !== digest) throw new Error("fresh house input differs from the existing home claim");
      if (!claim) {
        for (const table of ["events", "bots", "channels", "messages", "authority_epochs", "pairing_sessions", "devices", "client_sessions"]) {
          if (tables.has(table) && (preflight.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {count:number}).count !== 0) throw new Error("fresh house provisioning refuses an existing home");
        }
      }
    } finally { preflight.close(); }
  }
  const database = openCoordinationDatabase({ path: input.databasePath, applicationVersion: "home23-fresh-house-v1", now: input.now });
  const at = () => (input.now?.() ?? new Date()).toISOString();
  const event = (type: string, aggregateKind: string, aggregateId: string, aggregateVersion: number, payload: Record<string, string | number>) => ({
    type, aggregateKind, aggregateId, aggregateVersion, channelId: null, actorPrincipalId: "user_owner",
    requestId: generateCoordinationId("request"), correlationId: generateCoordinationId("correlation"), payload, createdAt: at(),
  });
  try {
    const claim = database.readOne<{ value: string }>("SELECT value FROM kernel_meta WHERE key = ?", CLAIM_KEY);
    if (claim && claim.value !== digest) throw new Error("fresh house input differs from the existing home claim");
    if (!claim) {
      // Refuse any preexisting user/runtime activity, including a legacy home.
      for (const table of ["events", "bots", "channels", "messages", "authority_epochs", "pairing_sessions", "devices", "client_sessions"]) {
        if (database.readOne<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`)!.count !== 0) throw new Error("fresh house provisioning refuses an existing home");
      }
      database.mutateWithEvent(tx => {
        tx.run("INSERT INTO kernel_meta (key,value,updated_at) VALUES (?,?,?)", CLAIM_KEY, digest, at());
        return { value: null, event: event("home.provisioning_started", "homeProvision", input.home.id, 1, { definitionDigest: digest }) };
      });
    }
    const prior = database.readOne<{ value: string }>("SELECT value FROM kernel_meta WHERE key = ?", RECEIPT_KEY);
    if (prior) return { ...JSON.parse(prior.value) as FreshHouseReceipt, replayed: true };

    const repository = new SqliteBotDirectoryRepository(database);
    const directory = createBotDirectory({ repository, availabilityPolicy: { degradedAfterMs: 30_000, offlineAfterMs: 120_000 }, now: input.now });
    const ids = { principalId: "user_owner" as const, requestId: generateCoordinationId("request"), correlationId: generateCoordinationId("correlation") };
    const bot = await directory.ensurePersistentBinding({ residentBinding: input.resident.slug, name: input.resident.name,
      purpose: input.resident.purpose, continuingIdentity: true, durableMailbox: true,
      requiredCapabilities: HOUSE_RESIDENT_CAPABILITIES, aliases: [{ namespace: "name", value: input.resident.name }] }, ids);
    const channels = createChannelService({
      repository: new SqliteMessagingRepository(database, { botConversationBinding: new SqliteBotConversationBindingAdapter(), messageProvenanceAuthorization: new M11MessageProvenanceAuthority() }),
      participantDirectory: { listVisibleBots: directory.listVisibleBots, resolveAlias: directory.resolveAlias, getBotByResidentBinding: slug => repository.getBotByResidentBinding(slug) },
      cursorSigningKey: createHash("sha256").update(`fresh-house-channel:${digest}`).digest(), now: input.now,
    });
    const direct = await channels.createDirectConversation({
      context: { ...ids, identity: { kind: "owner", auth: { principalId: "user_owner", deviceId: generateCoordinationId("device"), sessionId: generateCoordinationId("clientSession"), scopes: ["product:read", "message:send"] } } },
      memberBotIds: [bot.id], pinned: true, idempotencyKey: `fresh-house-direct:${digest}`,
    });
    // Retain the existing three-epoch contract without pretending that an
    // imported resident or prior live writer existed. The fresh-only claim is
    // the authority for this genesis; migration/cutover validators are unchanged.
    for (const capability of CAPABILITIES) {
      for (const epoch of [1, 2, 3]) {
        const current = database.readOne<{ receipt: string }>("SELECT receipt_json AS receipt FROM authority_epochs WHERE capability=? AND epoch=?", capability, epoch);
        if (current) {
          if (JSON.parse(current.receipt).freshHouseDigest !== digest) throw new Error("fresh house authority history has changed");
          continue;
        }
        const mode = epoch === 1 ? "legacy" : epoch === 2 ? "shadow" : "canonical";
        const writer = epoch === 3 ? COORDINATION_CANONICAL_WRITER : "home23-fresh-house-uninitialized";
        const sequence = database.readOne<{ sequence: number }>("SELECT COALESCE(MAX(sequence),0) AS sequence FROM events")!.sequence;
        database.mutateWithEvent(tx => {
          tx.run("INSERT INTO authority_epochs (capability,epoch,mode,writer,effective_at_event_sequence,rollback_epoch,receipt_json,created_at) VALUES (?,?,?,?,?,?,?,?)",
            capability, epoch, mode, writer, epoch === 3 ? sequence : null, epoch === 3 ? 1 : null,
            JSON.stringify({ kind: "fresh-house-genesis", freshHouseDigest: digest, source: "empty-home" }), at());
          return { value: null, event: event("authority.epoch_changed", "authorityEpoch", `authority:${capability}`, epoch, { capability, epoch, mode, writer }) };
        });
      }
    }
    const receipt: FreshHouseReceipt = { home: definition.home, residentBinding: input.resident.slug, botId: bot.id,
      channelId: direct.channel.id, conversationId: direct.channel.conversationId, authorityCapabilities: CAPABILITIES, replayed: false };
    database.mutateWithEvent(tx => {
      tx.run("INSERT INTO kernel_meta (key,value,updated_at) VALUES (?,?,?)", RECEIPT_KEY, JSON.stringify(receipt), at());
      return { value: null, event: event("home.provisioned", "homeProvision", input.home.id, 2, { definitionDigest: digest, botId: bot.id }) };
    });
    return receipt;
  } finally {
    database.close();
  }
}
