import { createHash } from "node:crypto";

interface AuthSchemaColumnProposal {
  name: string;
  affinity: "TEXT" | "INTEGER";
  nullable: boolean;
  primaryKey?: true;
  unique?: true;
  check?: string;
  references?: string;
}

interface AuthSchemaTableProposal {
  name: string;
  strict: true;
  columns: readonly AuthSchemaColumnProposal[];
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
    if (!Number.isFinite(value)) throw new Error("auth schema delta contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!value || typeof value !== "object") {
    throw new Error("auth schema delta contains a non-JSON value");
  }
  const entries = Object.entries(value)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`);
  return `{${entries.join(",")}}`;
}

const tables: readonly AuthSchemaTableProposal[] = [
  {
    name: "principals",
    strict: true,
    columns: [
      { name: "id", affinity: "TEXT", nullable: false, primaryKey: true },
      {
        name: "kind",
        affinity: "TEXT",
        nullable: false,
        check: "kind IN ('owner', 'bot')",
      },
      { name: "created_at", affinity: "TEXT", nullable: false, check: "length(created_at) = 24" },
    ],
    tableChecks: [
      "(id = 'user_owner' AND kind = 'owner') OR (id LIKE 'bot_%' AND kind = 'bot')",
    ],
  },
  {
    name: "pairing_sessions",
    strict: true,
    columns: [
      { name: "id", affinity: "TEXT", nullable: false, primaryKey: true },
      { name: "requested_device_name", affinity: "TEXT", nullable: false, check: "length(requested_device_name) BETWEEN 1 AND 128" },
      { name: "code_verifier", affinity: "TEXT", nullable: false, check: "length(code_verifier) = 83 AND code_verifier LIKE 'scrypt$16384$8$1$%'" },
      { name: "state", affinity: "TEXT", nullable: false, check: "state IN ('pending', 'redeemed', 'expired', 'locked')" },
      { name: "failed_attempts", affinity: "INTEGER", nullable: false, check: "failed_attempts BETWEEN 0 AND 5" },
      { name: "created_at", affinity: "TEXT", nullable: false, check: "length(created_at) = 24" },
      { name: "expires_at", affinity: "TEXT", nullable: false, check: "length(expires_at) = 24" },
      { name: "redeemed_at", affinity: "TEXT", nullable: true, check: "redeemed_at IS NULL OR length(redeemed_at) = 24" },
    ],
    tableChecks: [
      "(state = 'redeemed' AND redeemed_at IS NOT NULL) OR (state <> 'redeemed' AND redeemed_at IS NULL)",
    ],
  },
  {
    name: "devices",
    strict: true,
    columns: [
      { name: "id", affinity: "TEXT", nullable: false, primaryKey: true },
      { name: "principal_id", affinity: "TEXT", nullable: false, references: "principals(id)", check: "principal_id = 'user_owner'" },
      { name: "platform", affinity: "TEXT", nullable: false, check: "platform IN ('macos', 'ios')" },
      { name: "name", affinity: "TEXT", nullable: false, check: "length(name) BETWEEN 1 AND 128" },
      { name: "app_build", affinity: "TEXT", nullable: false, check: "length(app_build) BETWEEN 1 AND 64" },
      { name: "status", affinity: "TEXT", nullable: false, check: "status IN ('active', 'revoked')" },
      { name: "created_at", affinity: "TEXT", nullable: false, check: "length(created_at) = 24" },
      { name: "last_seen_at", affinity: "TEXT", nullable: false, check: "length(last_seen_at) = 24" },
      { name: "revoked_at", affinity: "TEXT", nullable: true, check: "revoked_at IS NULL OR length(revoked_at) = 24" },
    ],
    tableChecks: [
      "(status = 'revoked' AND revoked_at IS NOT NULL) OR (status = 'active' AND revoked_at IS NULL)",
    ],
  },
  {
    name: "client_sessions",
    strict: true,
    columns: [
      { name: "id", affinity: "TEXT", nullable: false, primaryKey: true },
      { name: "device_id", affinity: "TEXT", nullable: false, references: "devices(id)" },
      { name: "principal_id", affinity: "TEXT", nullable: false, references: "principals(id)", check: "principal_id = 'user_owner'" },
      { name: "family_id", affinity: "TEXT", nullable: false, check: "length(family_id) = 22" },
      { name: "state", affinity: "TEXT", nullable: false, check: "state IN ('pairing_pending', 'paired', 'active', 'expired', 'revoked', 'rotated')" },
      { name: "scopes_json", affinity: "TEXT", nullable: false, check: "json_valid(scopes_json) AND json_type(scopes_json) = 'array'" },
      { name: "access_expires_at", affinity: "TEXT", nullable: false, check: "length(access_expires_at) = 24" },
      { name: "refresh_expires_at", affinity: "TEXT", nullable: false, check: "length(refresh_expires_at) = 24" },
      { name: "created_at", affinity: "TEXT", nullable: false, check: "length(created_at) = 24" },
      { name: "rotated_at", affinity: "TEXT", nullable: true, check: "rotated_at IS NULL OR length(rotated_at) = 24" },
      { name: "rotated_to_session_id", affinity: "TEXT", nullable: true, references: "client_sessions(id)" },
      { name: "revoked_at", affinity: "TEXT", nullable: true, check: "revoked_at IS NULL OR length(revoked_at) = 24" },
      { name: "revoke_reason", affinity: "TEXT", nullable: true, check: "revoke_reason IS NULL OR revoke_reason IN ('refresh_replay', 'session_revoke', 'device_revoke')" },
    ],
    tableChecks: [
      "(state = 'rotated' AND rotated_at IS NOT NULL AND rotated_to_session_id IS NOT NULL) OR state <> 'rotated'",
      "(state = 'revoked' AND revoked_at IS NOT NULL AND revoke_reason IS NOT NULL) OR state <> 'revoked'",
    ],
  },
  {
    name: "session_refresh_tokens",
    strict: true,
    columns: [
      { name: "token_id", affinity: "TEXT", nullable: false, primaryKey: true, check: "length(token_id) = 22" },
      { name: "family_id", affinity: "TEXT", nullable: false, check: "length(family_id) = 22" },
      { name: "session_id", affinity: "TEXT", nullable: false, unique: true, references: "client_sessions(id)" },
      { name: "token_digest", affinity: "TEXT", nullable: false, unique: true, check: "length(token_digest) = 64" },
      { name: "state", affinity: "TEXT", nullable: false, check: "state IN ('active', 'expired', 'revoked', 'rotated')" },
      { name: "created_at", affinity: "TEXT", nullable: false, check: "length(created_at) = 24" },
      { name: "expires_at", affinity: "TEXT", nullable: false, check: "length(expires_at) = 24" },
      { name: "rotated_at", affinity: "TEXT", nullable: true, check: "rotated_at IS NULL OR length(rotated_at) = 24" },
      { name: "rotated_to_token_id", affinity: "TEXT", nullable: true, references: "session_refresh_tokens(token_id)" },
      { name: "revoked_at", affinity: "TEXT", nullable: true, check: "revoked_at IS NULL OR length(revoked_at) = 24" },
      { name: "revoke_reason", affinity: "TEXT", nullable: true, check: "revoke_reason IS NULL OR revoke_reason IN ('refresh_replay', 'session_revoke', 'device_revoke')" },
    ],
    tableChecks: [
      "(state = 'rotated' AND rotated_at IS NOT NULL AND rotated_to_token_id IS NOT NULL) OR state <> 'rotated'",
      "(state = 'revoked' AND revoked_at IS NOT NULL AND revoke_reason IS NOT NULL) OR state <> 'revoked'",
    ],
  },
  {
    name: "idempotency_records",
    strict: true,
    columns: [
      { name: "principal_id", affinity: "TEXT", nullable: false, references: "principals(id)", check: "principal_id = 'user_owner'" },
      { name: "operation", affinity: "TEXT", nullable: false, check: "operation IN ('pairing.issue', 'pairing.redeem', 'session.refresh', 'session.revoke', 'device.revoke')" },
      { name: "idempotency_key_digest", affinity: "TEXT", nullable: false, check: "length(idempotency_key_digest) = 64" },
      { name: "request_digest", affinity: "TEXT", nullable: false, check: "length(request_digest) = 64" },
      { name: "result_kind", affinity: "TEXT", nullable: false, check: "result_kind IN ('pairing', 'pairing_failure', 'redemption', 'refresh', 'refresh_failure', 'revoke')" },
      { name: "result_ref_json", affinity: "TEXT", nullable: false, check: "json_valid(result_ref_json) AND json_type(result_ref_json) = 'object'" },
      { name: "request_id", affinity: "TEXT", nullable: false, check: "request_id LIKE 'req_%'" },
      { name: "correlation_id", affinity: "TEXT", nullable: false, check: "correlation_id LIKE 'cor_%'" },
      { name: "created_at", affinity: "TEXT", nullable: false, check: "length(created_at) = 24" },
    ],
    uniqueConstraints: [["principal_id", "operation", "idempotency_key_digest"]],
  },
];

export const AUTH_SCHEMA_DELTA_PROPOSAL = deepFreeze({
  proposalVersion: 1,
  packageId: "M06",
  name: "coordination-auth-v1",
  landing: {
    owner: "M04",
    status: "proposal_only",
    m06MustNotApply: true,
  },
  requires: {
    coordinationSchemaVersion: 1,
    coordinationSchemaChecksum:
      "0ce5eee85db7fe852a6e5ef970cf81d2bbc90352cd8bf4b5e09d3d02991c7dc9",
    connectedAgentsContractVersion: 1,
    connectedAgentsContractPackSha256:
      "fbc20017304aed66e579a2b95facbda6bbcf8572038f7f1c0c824423c65d6be2",
  },
  tables,
  indexes: [
    { name: "pairing_sessions_state_expiry", table: "pairing_sessions", columns: ["state", "expires_at"] },
    { name: "devices_principal_status", table: "devices", columns: ["principal_id", "status"] },
    { name: "client_sessions_device_state", table: "client_sessions", columns: ["device_id", "state"] },
    { name: "client_sessions_family_state", table: "client_sessions", columns: ["family_id", "state"] },
    { name: "session_refresh_tokens_family_state", table: "session_refresh_tokens", columns: ["family_id", "state"] },
    { name: "idempotency_records_created_at", table: "idempotency_records", columns: ["created_at"] },
  ],
  transactionRequirements: [
    "every mutation resolves principal_id, operation, and the keyed idempotency_key_digest before terminal or replay handling: the same request_digest returns original stable references, while a different digest returns idempotency_conflict",
    "the idempotency result, auth state mutation, and authoritative event with request_id and correlation_id commit in one transaction; response reconstruction stores no raw code or token",
    "pairing redemption compares pending state and expiry, marks the pairing redeemed, and inserts device, session, and refresh digest atomically",
    "pairing failure compares pending state and expiry, increments exactly once per idempotency claim, and locks at five failures atomically",
    "an expired pairing redemption atomically persists pending to expired before returning pairing_expired",
    "refresh rotation compares token_id and token_digest, rotates the current token and session, and inserts their successors atomically",
    "a matching rotated-token replay revokes every active token and session in the family atomically",
    "session revoke revokes its refresh family atomically; device revoke also revokes every active session and family for that device",
    "authorization reads session, device, and family revocation state from one consistent database snapshot",
    "the owner principal is inserted idempotently as user_owner before the first device redemption",
  ],
  storageRequirements: [
    "idempotency result_ref_json contains only the non-secret response projection: stable resource metadata, terminal reason codes, and timestamps",
    "pairing codes and access or refresh tokens are reconstructed from domain-separated server keys and are never persisted in idempotency results",
  ],
  retentionRequirements: [
    "idempotency records are retained for at least the 30-day refresh-family lifetime; cleanup is an M04 policy and may remove only expired results that no supported client retry can reference",
  ],
  forbiddenStoredColumns: [
    "pairing_code",
    "access_token",
    "refresh_token",
    "signing_key",
    "key_material",
    "refresh_digest_key",
    "idempotency_response",
    "idempotency_key",
    "response_body",
  ],
  rollback: {
    beforeLanding: "remove this unconsumed proposal with the M06 package",
    afterLanding:
      "disable public auth/API admission; preserve inert pairing, device, session, and digest rows; use an M04-owned corrective migration rather than dropping live auth data",
  },
});

export const AUTH_SCHEMA_DELTA_CANONICAL_JSON = canonicalJson(
  AUTH_SCHEMA_DELTA_PROPOSAL,
);

export const AUTH_SCHEMA_DELTA_SHA256 =
  "265444e615e74e5a824776da2083b198e283ad19bfa8d58db2b526c85bc9b795" as const;

export function computeAuthSchemaDeltaDigest(): string {
  return createHash("sha256")
    .update(AUTH_SCHEMA_DELTA_CANONICAL_JSON, "utf8")
    .digest("hex");
}
