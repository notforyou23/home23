import { createHash } from "node:crypto";

interface BotDirectorySchemaColumnProposal {
  name: string;
  affinity: "TEXT" | "INTEGER";
  nullable: boolean;
  primaryKey?: true;
  unique?: true;
  check?: string;
  references?: string;
}

interface BotDirectorySchemaTableProposal {
  name: string;
  strict: true;
  columns: readonly BotDirectorySchemaColumnProposal[];
  tableChecks?: readonly string[];
  uniqueConstraints?: readonly (readonly string[])[];
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Bot directory schema delta contains a non-finite number");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!value || typeof value !== "object") {
    throw new Error("Bot directory schema delta contains a non-JSON value");
  }
  const entries = Object.entries(value)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`);
  return `{${entries.join(",")}}`;
}

const tables: readonly BotDirectorySchemaTableProposal[] = [
  {
    name: "bots",
    strict: true,
    columns: [
      { name: "id", affinity: "TEXT", nullable: false, primaryKey: true, check: "id LIKE 'bot_%'" },
      { name: "principal_id", affinity: "TEXT", nullable: false, unique: true, references: "principals(id)" },
      { name: "name", affinity: "TEXT", nullable: false, check: "length(name) BETWEEN 1 AND 128" },
      { name: "purpose", affinity: "TEXT", nullable: false, check: "length(purpose) BETWEEN 1 AND 512" },
      { name: "lifecycle", affinity: "TEXT", nullable: false, check: "lifecycle IN ('provisioning', 'active', 'archived', 'failed')" },
      { name: "conversation_id", affinity: "TEXT", nullable: true, check: "conversation_id IS NULL OR conversation_id LIKE 'cnv_%'" },
      { name: "resident_binding", affinity: "TEXT", nullable: false, unique: true, check: "length(resident_binding) BETWEEN 1 AND 63" },
      { name: "continuing_identity", affinity: "INTEGER", nullable: false, check: "continuing_identity = 1" },
      { name: "durable_mailbox", affinity: "INTEGER", nullable: false, check: "durable_mailbox = 1" },
      { name: "required_capabilities_json", affinity: "TEXT", nullable: false, check: "json_valid(required_capabilities_json) AND json_type(required_capabilities_json) = 'array'" },
      { name: "active_instance_id", affinity: "TEXT", nullable: true, check: "active_instance_id IS NULL OR length(active_instance_id) BETWEEN 1 AND 128" },
      { name: "active_key_version", affinity: "INTEGER", nullable: true, check: "active_key_version IS NULL OR active_key_version >= 1" },
      { name: "resident_protocol_version", affinity: "INTEGER", nullable: true, check: "resident_protocol_version IS NULL OR resident_protocol_version = 1" },
      { name: "resident_capabilities_json", affinity: "TEXT", nullable: false, check: "json_valid(resident_capabilities_json) AND json_type(resident_capabilities_json) = 'array'" },
      { name: "resident_registered_at", affinity: "TEXT", nullable: true, check: "resident_registered_at IS NULL OR length(resident_registered_at) = 24" },
      { name: "last_heartbeat_at", affinity: "TEXT", nullable: true, check: "last_heartbeat_at IS NULL OR length(last_heartbeat_at) = 24" },
      { name: "reported_availability", affinity: "TEXT", nullable: true, check: "reported_availability IS NULL OR reported_availability IN ('starting', 'available', 'busy', 'degraded')" },
      { name: "version", affinity: "INTEGER", nullable: false, check: "version >= 1" },
      { name: "created_at", affinity: "TEXT", nullable: false, check: "length(created_at) = 24" },
      { name: "updated_at", affinity: "TEXT", nullable: false, check: "length(updated_at) = 24" },
    ],
    tableChecks: [
      "principal_id = id",
      "(active_instance_id IS NULL AND active_key_version IS NULL AND resident_protocol_version IS NULL AND resident_registered_at IS NULL AND last_heartbeat_at IS NULL AND reported_availability IS NULL) OR (active_instance_id IS NOT NULL AND active_key_version IS NOT NULL AND resident_protocol_version IS NOT NULL AND resident_registered_at IS NOT NULL AND last_heartbeat_at IS NOT NULL AND reported_availability IS NOT NULL)",
    ],
  },
  {
    name: "aliases",
    strict: true,
    columns: [
      { name: "id", affinity: "TEXT", nullable: false, primaryKey: true, check: "id LIKE 'alias_%'" },
      { name: "namespace", affinity: "TEXT", nullable: false, check: "length(namespace) BETWEEN 1 AND 64" },
      { name: "alias_digest", affinity: "TEXT", nullable: false, check: "length(alias_digest) = 64" },
      { name: "target_type", affinity: "TEXT", nullable: false, check: "length(target_type) BETWEEN 1 AND 32" },
      { name: "target_id", affinity: "TEXT", nullable: false, check: "length(target_id) BETWEEN 1 AND 64" },
      { name: "active", affinity: "INTEGER", nullable: false, check: "active IN (0, 1)" },
      { name: "created_at", affinity: "TEXT", nullable: false, check: "length(created_at) = 24" },
      { name: "updated_at", affinity: "TEXT", nullable: false, check: "length(updated_at) = 24" },
    ],
    uniqueConstraints: [["namespace", "alias_digest"]],
  },
];

export const BOT_DIRECTORY_SCHEMA_DELTA_PROPOSAL = deepFreeze({
  proposalVersion: 1,
  packageId: "M07",
  name: "persistent-bot-directory-v1",
  landing: {
    owner: "M04",
    status: "proposal_only",
    m07MustNotApply: true,
  },
  requires: {
    coordinationSchemaVersion: 1,
    coordinationSchemaChecksum:
      "0ce5eee85db7fe852a6e5ef970cf81d2bbc90352cd8bf4b5e09d3d02991c7dc9",
    m06AuthSchemaDeltaSha256:
      "265444e615e74e5a824776da2083b198e283ad19bfa8d58db2b526c85bc9b795",
    connectedAgentsContractVersion: 1,
    connectedAgentsContractPackSha256:
      "fbc20017304aed66e579a2b95facbda6bbcf8572038f7f1c0c824423c65d6be2",
  },
  tables,
  indexes: [
    { name: "bots_lifecycle_name", table: "bots", columns: ["lifecycle", "name", "id"] },
    { name: "bots_heartbeat", table: "bots", columns: ["last_heartbeat_at"] },
    { name: "aliases_target", table: "aliases", columns: ["target_type", "target_id", "active"] },
  ],
  transactionRequirements: [
    "insert user_owner and the matching bot principal idempotently before inserting a Bot",
    "ensure one Bot per resident_binding and never replace an existing Bot id during registration or restart",
    "insert a Bot and all approved aliases atomically; a namespace and alias_digest collision aborts the whole change",
    "registration preserves request and correlation ids, compares the bound resident, active key version, and Bot version, rejects every lower key version, and permits an equal-key replacement only when the prior heartbeat projection is offline",
    "heartbeat preserves request and correlation ids and compares the active instance, active key version, and Bot version before updating projection inputs",
    "Bot and alias mutations append the matching authoritative event in the same M04-owned transaction",
  ],
  projectionRequirements: [
    "only rows with continuing_identity and durable_mailbox are eligible for roster publication",
    "offline and stale availability are derived from server time and persisted heartbeat inputs; they never delete a Bot, principal, alias, or conversation reference",
    "required capability absence projects degraded and active instance identifiers stay outside public Bot projections",
  ],
  forbiddenStoredColumns: [
    "alias_value",
    "resident_key",
    "resident_context",
    "mailbox_content",
    "message_content",
    "workspace_path",
  ],
  rollback: {
    beforeLanding: "remove this unconsumed proposal with the M07 package",
    afterLanding:
      "disable roster publication and resident registration; preserve inert Bot ids, principal ids, aliases, and conversation references for later re-enable",
  },
});

export const BOT_DIRECTORY_SCHEMA_DELTA_CANONICAL_JSON = canonicalJson(
  BOT_DIRECTORY_SCHEMA_DELTA_PROPOSAL,
);

export const BOT_DIRECTORY_SCHEMA_DELTA_SHA256 =
  "2da835b11fca4d1cadb7f98eac6cec30128a84b7f205348f718ffabc3136df6f" as const;

export function computeBotDirectorySchemaDeltaDigest(): string {
  return createHash("sha256")
    .update(BOT_DIRECTORY_SCHEMA_DELTA_CANONICAL_JSON, "utf8")
    .digest("hex");
}
