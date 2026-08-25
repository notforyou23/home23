import Database from "better-sqlite3";

import {
  BOT_DIRECTORY_SCHEMA_DELTA_PROPOSAL,
  createBotDirectory,
  type BotDirectoryRecord,
  type BotProjection,
  type CommitResidentHeartbeatInput,
  type CommitResidentHeartbeatResult,
  type CommitResidentRegistrationInput,
  type CommitResidentRegistrationResult,
  type GeneratedBotDirectoryIdKind,
} from "../../../src/coordination/bots/index.js";
import { AUTH_SCHEMA_DELTA_PROPOSAL } from "../../../src/coordination/auth/index.js";
import {
  MESSAGING_SCHEMA_DELTA_SQL,
  MessagingError,
  SqliteBotConversationBindingAdapter,
  SqliteMessagingRepository,
  type MessagingActorContext,
} from "../../../src/coordination/channels/index.js";
import {
  runMutationWithEvent,
  type CoordinationTransaction,
} from "../../../src/coordination/db/transaction.js";
import type {
  MessageProvenance,
  MessageProvenanceAuthorizationTransactionPort,
} from "../../../src/coordination/messages/index.js";
import { COORDINATION_SPINE_MIGRATION_SQL } from "../../../src/coordination/migrations/0001-coordination-spine.js";

import { TestBotDirectoryRepository } from "../bots/test-repository.js";

export const OWNER_ID = "user_owner" as const;

const PREFIX_BY_KIND = {
  alias: "alias",
  bot: "bot",
  channel: "chn",
  clientSession: "ses",
  conversation: "cnv",
  correlation: "cor",
  message: "msg",
  request: "req",
  round: "rnd",
  work: "wrk",
} as const;

export function fixtureId(
  kind: keyof typeof PREFIX_BY_KIND,
  suffix: number,
): string {
  return `${PREFIX_BY_KIND[kind]}_0198d95f-6c00-7000-8000-${String(suffix).padStart(12, "0")}`;
}

export interface FixtureClock {
  value: Date;
}

interface SchemaColumn {
  name: string;
  affinity: "TEXT" | "INTEGER";
  nullable: boolean;
  primaryKey?: true;
  unique?: true;
  check?: string;
  references?: string;
}

interface SchemaTable {
  name: string;
  strict: true;
  columns: readonly SchemaColumn[];
  tableChecks?: readonly string[];
  uniqueConstraints?: readonly (readonly string[])[];
}

interface SchemaProposal {
  tables: readonly SchemaTable[];
  indexes: readonly {
    name: string;
    table: string;
    columns: readonly string[];
    unique?: boolean;
  }[];
}

function applyAcceptedProposal(
  database: Database.Database,
  proposal: SchemaProposal,
): void {
  for (const table of proposal.tables) {
    const definitions = table.columns.map((column) => [
      column.name,
      column.affinity,
      column.primaryKey ? "PRIMARY KEY" : "",
      column.nullable ? "" : "NOT NULL",
      column.unique ? "UNIQUE" : "",
      column.references ? `REFERENCES ${column.references}` : "",
      column.check ? `CHECK (${column.check})` : "",
    ].filter(Boolean).join(" "));
    for (const unique of table.uniqueConstraints ?? []) {
      definitions.push(`UNIQUE (${unique.join(", ")})`);
    }
    for (const check of table.tableChecks ?? []) {
      definitions.push(`CHECK (${check})`);
    }
    database.exec(
      `CREATE TABLE ${table.name} (${definitions.join(",\n")})${table.strict ? " STRICT" : ""};`,
    );
  }
  for (const index of proposal.indexes) {
    database.exec(
      `CREATE ${index.unique ? "UNIQUE " : ""}INDEX ${index.name} ON ${index.table} (${index.columns.join(", ")});`,
    );
  }
}

export class TestMessagingDatabase {
  readonly raw = new Database(":memory:");
  private botSeedReceipt = 9_000;

  constructor(applyMessagingProposal = true) {
    this.raw.pragma("foreign_keys = ON");
    this.raw.exec(COORDINATION_SPINE_MIGRATION_SQL);
    applyAcceptedProposal(
      this.raw,
      AUTH_SCHEMA_DELTA_PROPOSAL as unknown as SchemaProposal,
    );
    applyAcceptedProposal(
      this.raw,
      BOT_DIRECTORY_SCHEMA_DELTA_PROPOSAL as unknown as SchemaProposal,
    );
    if (applyMessagingProposal) this.raw.exec(MESSAGING_SCHEMA_DELTA_SQL);
  }

  seedPrincipal(principalId: string, kind: "owner" | "bot"): void {
    this.raw.prepare(
      "INSERT INTO principals (id, kind, created_at) VALUES (?, ?, ?)",
    ).run(principalId, kind, "2026-08-25T12:00:00.000Z");
  }

  seedBot(bot: BotProjection): void {
    const receipt = this.botSeedReceipt++;
    this.mutateWithEvent((transaction) => {
      transaction.run(
        `INSERT INTO bots (
          id, principal_id, name, purpose, lifecycle, conversation_id,
          resident_binding, continuing_identity, durable_mailbox,
          required_capabilities_json, active_instance_id, active_key_version,
          resident_protocol_version, resident_capabilities_json,
          resident_registered_at, last_heartbeat_at, reported_availability,
          version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'active', NULL, ?, 1, 1, '["messages"]',
                  NULL, NULL, NULL, '[]', NULL, NULL, NULL, 1, ?, ?)`,
        bot.id,
        bot.principalId,
        bot.name,
        bot.purpose,
        bot.residentBinding,
        bot.createdAt,
        bot.updatedAt,
      );
      return {
        value: undefined,
        event: {
          type: "bot.created",
          aggregateKind: "bot",
          aggregateId: bot.id,
          aggregateVersion: 1,
          channelId: null,
          actorPrincipalId: OWNER_ID,
          requestId: fixtureId("request", receipt),
          correlationId: fixtureId("correlation", receipt),
          payload: { botId: bot.id, botVersion: 1 },
          createdAt: bot.createdAt,
        },
      };
    });
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
    this.raw.close();
  }
}

class MessagingBotDirectoryRepository extends TestBotDirectoryRepository {
  constructor(private readonly database: TestMessagingDatabase) {
    super();
  }

  private readBot(botId: string): BotDirectoryRecord | null {
    const row = this.database.readOne<{
      id: string;
      principalId: string;
      name: string;
      purpose: string;
      lifecycle: BotDirectoryRecord["lifecycle"];
      conversationId: string | null;
      residentBinding: string;
      continuingIdentity: number;
      durableMailbox: number;
      requiredCapabilitiesJson: string;
      activeInstanceId: string | null;
      activeKeyVersion: number | null;
      residentProtocolVersion: number | null;
      residentCapabilitiesJson: string;
      residentRegisteredAt: string | null;
      lastHeartbeatAt: string | null;
      reportedAvailability: BotDirectoryRecord["reportedAvailability"];
      version: number;
      createdAt: string;
      updatedAt: string;
    }>(
      `SELECT id, principal_id AS principalId, name, purpose, lifecycle,
              conversation_id AS conversationId, resident_binding AS residentBinding,
              continuing_identity AS continuingIdentity,
              durable_mailbox AS durableMailbox,
              required_capabilities_json AS requiredCapabilitiesJson,
              active_instance_id AS activeInstanceId,
              active_key_version AS activeKeyVersion,
              resident_protocol_version AS residentProtocolVersion,
              resident_capabilities_json AS residentCapabilitiesJson,
              resident_registered_at AS residentRegisteredAt,
              last_heartbeat_at AS lastHeartbeatAt,
              reported_availability AS reportedAvailability,
              version, created_at AS createdAt, updated_at AS updatedAt
       FROM bots WHERE id = ?`,
      botId,
    );
    if (!row) return null;
    return {
      ...row,
      continuingIdentity: row.continuingIdentity === 1,
      durableMailbox: row.durableMailbox === 1,
      requiredCapabilities: JSON.parse(row.requiredCapabilitiesJson) as string[],
      residentCapabilities: JSON.parse(row.residentCapabilitiesJson) as string[],
    };
  }

  override async getBotByResidentBinding(
    residentBinding: string,
  ): Promise<BotDirectoryRecord | null> {
    const row = this.database.readOne<{ id: string }>(
      "SELECT id FROM bots WHERE resident_binding = ?",
      residentBinding,
    );
    return row ? this.readBot(row.id) : null;
  }

  override async getBotById(botId: string): Promise<BotDirectoryRecord | null> {
    return this.readBot(botId);
  }

  override async listPersistentBots(): Promise<readonly BotDirectoryRecord[]> {
    return this.database.readAll<{ id: string }>("SELECT id FROM bots ORDER BY id")
      .map((row) => this.readBot(row.id)!)
      .filter(Boolean);
  }

  override async commitResidentRegistration(
    input: CommitResidentRegistrationInput,
  ): Promise<CommitResidentRegistrationResult> {
    const mapCurrent = this.bots.get(input.botId);
    if (!mapCurrent) return { outcome: "not_found" };
    const mapResult = await super.commitResidentRegistration({
      ...input,
      expectedVersion: mapCurrent.version,
    });
    if (mapResult.outcome !== "registered") return mapResult;
    const stored = this.readBot(input.botId);
    if (!stored || stored.version !== input.expectedVersion) return { outcome: "conflict" };
    this.database.mutateWithEvent((transaction) => {
      const update = transaction.run(
        `UPDATE bots SET
          active_instance_id = ?, active_key_version = ?, resident_protocol_version = ?,
          resident_capabilities_json = ?, resident_registered_at = ?, last_heartbeat_at = ?,
          reported_availability = ?, version = version + 1, updated_at = ?
         WHERE id = ? AND version = ?`,
        input.instanceId,
        input.keyVersion,
        input.protocolVersion,
        JSON.stringify(input.capabilities),
        input.registeredAt,
        input.registeredAt,
        input.reportedAvailability,
        input.registeredAt,
        input.botId,
        input.expectedVersion,
      );
      if (update.changes !== 1) throw new Error("Bot registration fixture lost its version race");
      return {
        value: undefined,
        event: {
          type: "bot.updated",
          aggregateKind: "bot",
          aggregateId: input.botId,
          aggregateVersion: input.expectedVersion + 1,
          channelId: null,
          actorPrincipalId: input.actorPrincipalId,
          requestId: input.requestId,
          correlationId: input.correlationId,
          payload: { botId: input.botId, botVersion: input.expectedVersion + 1 },
          createdAt: input.registeredAt,
        },
      };
    });
    return { outcome: "registered", bot: this.readBot(input.botId)! };
  }

  override async commitResidentHeartbeat(
    input: CommitResidentHeartbeatInput,
  ): Promise<CommitResidentHeartbeatResult> {
    const mapCurrent = this.bots.get(input.botId);
    if (!mapCurrent) return { outcome: "not_found" };
    const mapResult = await super.commitResidentHeartbeat({
      ...input,
      expectedVersion: mapCurrent.version,
    });
    if (mapResult.outcome !== "recorded") return mapResult;
    const stored = this.readBot(input.botId);
    if (!stored || stored.version !== input.expectedVersion) return { outcome: "conflict" };
    this.database.mutateWithEvent((transaction) => {
      const update = transaction.run(
        `UPDATE bots SET last_heartbeat_at = ?, reported_availability = ?,
                         version = version + 1, updated_at = ?
         WHERE id = ? AND version = ?`,
        input.heartbeatAt,
        input.reportedAvailability,
        input.heartbeatAt,
        input.botId,
        input.expectedVersion,
      );
      if (update.changes !== 1) throw new Error("Bot heartbeat fixture lost its version race");
      return {
        value: undefined,
        event: {
          type: "bot.updated",
          aggregateKind: "bot",
          aggregateId: input.botId,
          aggregateVersion: input.expectedVersion + 1,
          channelId: null,
          actorPrincipalId: input.actorPrincipalId,
          requestId: input.requestId,
          correlationId: input.correlationId,
          payload: { botId: input.botId, botVersion: input.expectedVersion + 1 },
          createdAt: input.heartbeatAt,
        },
      };
    });
    return { outcome: "recorded", bot: this.readBot(input.botId)! };
  }
}

function botIdGenerator() {
  let bot = 1;
  let alias = 101;
  return (kind: GeneratedBotDirectoryIdKind): string =>
    fixtureId(kind, kind === "bot" ? bot++ : alias++);
}

class TestMessageProvenanceAuthority
implements MessageProvenanceAuthorizationTransactionPort {
  private readonly bindings = new Set<string>();

  allow(input: {
    principalId: string;
    channelId: string;
    provenance: MessageProvenance;
  }): void {
    this.bindings.add(this.key(input));
  }

  assertAuthorized(
    transaction: CoordinationTransaction,
    input: {
      actor: { principalId: string };
      channelId: string;
      provenance: MessageProvenance;
    },
  ): void {
    if (!this.bindings.has(this.key({
      principalId: input.actor.principalId,
      channelId: input.channelId,
      provenance: input.provenance,
    }))) {
      throw new MessagingError("invalid_relation");
    }
    const member = transaction.readOne<{ present: number }>(
      `SELECT 1 AS present FROM channel_members
       WHERE channel_id = ? AND principal_id = ? AND active = 1`,
      input.channelId,
      input.actor.principalId,
    );
    if (!member) throw new MessagingError("invalid_relation");
  }

  private key(input: {
    principalId: string;
    channelId: string;
    provenance: MessageProvenance;
  }): string {
    return JSON.stringify([
      input.principalId,
      input.channelId,
      input.provenance.roundId,
      input.provenance.workId,
    ]);
  }
}

export async function createMessagingFixture() {
  const database = new TestMessagingDatabase();
  const botRepository = new MessagingBotDirectoryRepository(database);
  const clock: FixtureClock = {
    value: new Date("2026-08-25T12:00:00.000Z"),
  };
  const directoryService = createBotDirectory({
    repository: botRepository,
    availabilityPolicy: { degradedAfterMs: 30_000, offlineAfterMs: 90_000 },
    now: () => clock.value,
    idGenerator: botIdGenerator(),
  });
  const directory = Object.freeze({
    ensurePersistentBinding: directoryService.ensurePersistentBinding,
    listVisibleBots: directoryService.listVisibleBots,
    resolveAlias: directoryService.resolveAlias,
    registerResident: directoryService.registerResident,
    heartbeatResident: directoryService.heartbeatResident,
    getBotByResidentBinding: (residentBinding: string) =>
      botRepository.getBotByResidentBinding(residentBinding),
  });
  database.seedPrincipal(OWNER_ID, "owner");

  async function addBot(
    residentBinding: string,
    name: string,
    receiptSuffix: number,
  ): Promise<BotProjection> {
    const bot = await directory.ensurePersistentBinding({
      residentBinding,
      name,
      purpose: `${name} persistent household Bot.`,
      continuingIdentity: true,
      durableMailbox: true,
      requiredCapabilities: ["messages"],
      aliases: [],
    }, {
      principalId: OWNER_ID,
      requestId: fixtureId("request", receiptSuffix),
      correlationId: fixtureId("correlation", receiptSuffix),
    });
    database.seedPrincipal(bot.principalId, "bot");
    database.seedBot(bot);
    const registrationContext = residentContext(
      bot,
      residentBinding,
      receiptSuffix + 1000,
    );
    if (registrationContext.identity.kind !== "resident") {
      throw new Error("resident context construction failed");
    }
    await directory.registerResident({
      context: registrationContext.identity.resident,
      botBinding: residentBinding,
      protocolVersion: 1,
      capabilities: ["messages"],
    });
    return (await directory.resolveAlias("resident", residentBinding))!;
  }

  const bots = {
    jerry: await addBot("jerry", "Jerry", 201),
    forrest: await addBot("forrest", "Forrest", 202),
    records: await addBot("records-specialist", "Records", 203),
  };
  const provenanceAuthority = new TestMessageProvenanceAuthority();
  const repositoryOptions = Object.freeze({
    botConversationBinding: new SqliteBotConversationBindingAdapter(),
    messageProvenanceAuthorization: provenanceAuthority,
  });
  const repository = new SqliteMessagingRepository(database, repositoryOptions);

  return {
    database,
    repository,
    directory,
    residentAuthority: botRepository,
    botRepository,
    bots,
    clock,
    repositoryOptions,
    allowMessageProvenance: (input: {
      principalId: string;
      channelId: string;
      provenance: MessageProvenance;
    }) => provenanceAuthority.allow(input),
    close: () => database.close(),
  };
}

export function ownerContext(
  suffix: number,
  scopes: readonly ("product:read" | "message:send" | "attachment:write")[] = [
    "product:read",
    "message:send",
  ],
): MessagingActorContext {
  return {
    principalId: OWNER_ID,
    requestId: fixtureId("request", suffix),
    correlationId: fixtureId("correlation", suffix),
    identity: {
      kind: "owner",
      auth: {
        principalId: OWNER_ID,
        deviceId: `dev_0198d95f-6c00-7000-8000-${String(suffix).padStart(12, "0")}`,
        sessionId: fixtureId("clientSession", suffix),
        scopes,
      },
    },
  };
}

export function residentContext(
  bot: BotProjection,
  residentSlug: string,
  suffix: number,
  binding: { instanceId?: string; keyVersion?: number } = {},
): MessagingActorContext {
  const requestId = fixtureId("request", suffix);
  const correlationId = fixtureId("correlation", suffix);
  return {
    principalId: bot.principalId,
    requestId,
    correlationId,
    identity: {
      kind: "resident",
      resident: {
        credential: {
          residentSlug,
          role: "resident",
          instanceId: binding.instanceId ?? `${residentSlug}-instance-1`,
          keyVersion: binding.keyVersion ?? 1,
        },
        requestId,
        correlationId,
      },
    },
  };
}
