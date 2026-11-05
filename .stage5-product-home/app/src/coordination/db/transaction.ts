import { createHash } from "node:crypto";

import type Database from "better-sqlite3";

import {
  assertCoordinationId,
  generateCoordinationId,
} from "../ids/index.js";
import { CONNECTED_AGENTS_CONTRACT_VERSION } from "../schema/contract-registry.js";

export type SqliteValue = string | number | bigint | Buffer | null;

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface CoordinationEventInput {
  type: string;
  aggregateKind: string;
  aggregateId: string;
  aggregateVersion: number;
  channelId: string | null;
  actorPrincipalId: string | null;
  requestId: string;
  correlationId: string;
  payload: { [key: string]: JsonValue };
  createdAt: string;
}

export interface StoredCoordinationEvent {
  sequence: number;
  id: string;
  schemaVersion: number;
  type: string;
  durability: "durable";
  aggregateKind: string;
  aggregateId: string;
  aggregateVersion: number;
  channelId: string | null;
  actorPrincipalId: string | null;
  requestId: string;
  correlationId: string;
  payloadJson: string;
  payloadDigest: string;
  createdAt: string;
}

export interface CoordinationSingleEventMutation<T> {
  value: T;
  event: CoordinationEventInput;
  events?: never;
}

export interface CoordinationEventSetMutation<T> {
  value: T;
  event?: never;
  events: readonly [CoordinationEventInput, ...CoordinationEventInput[]];
}

export type CoordinationMutation<T> =
  | CoordinationSingleEventMutation<T>
  | CoordinationEventSetMutation<T>;

export interface CoordinationMutationResult<T> {
  value: T;
  /** The final event is the backward-compatible mutation receipt event. */
  event: StoredCoordinationEvent;
  events: readonly StoredCoordinationEvent[];
}

const TRANSACTION_CONTROL_TOKENS = new Set([
  "ATTACH",
  "BEGIN",
  "COMMIT",
  "DETACH",
  "END",
  "PRAGMA",
  "RELEASE",
  "ROLLBACK",
  "SAVEPOINT",
  "VACUUM",
]);
const SCHEMA_MUTATION_TOKENS = new Set(["ALTER", "CREATE", "DROP", "REINDEX"]);

function firstSqlToken(sql: string): string {
  let offset = 0;
  while (offset < sql.length) {
    while (/\s/.test(sql[offset] ?? "")) offset += 1;
    if (sql.startsWith("--", offset)) {
      const newline = sql.indexOf("\n", offset + 2);
      offset = newline === -1 ? sql.length : newline + 1;
      continue;
    }
    if (sql.startsWith("/*", offset)) {
      const end = sql.indexOf("*/", offset + 2);
      if (end === -1) throw new Error("coordination mutation SQL has an unterminated comment");
      offset = end + 2;
      continue;
    }
    break;
  }
  return /^[A-Za-z]+/.exec(sql.slice(offset))?.[0]?.toUpperCase() ?? "";
}

function assertMutationStatement(sql: string): void {
  const token = firstSqlToken(sql);
  if (!token) throw new Error("coordination mutation SQL is empty or invalid");
  if (TRANSACTION_CONTROL_TOKENS.has(token)) {
    throw new Error(`coordination mutation refused transaction-control statement ${token}`);
  }
  if (SCHEMA_MUTATION_TOKENS.has(token)) {
    throw new Error(`coordination mutation refused schema statement ${token}`);
  }
}

function assertReadStatement(sql: string): void {
  const token = firstSqlToken(sql);
  if (!token) throw new Error("coordination transaction read SQL is empty or invalid");
  if (TRANSACTION_CONTROL_TOKENS.has(token) || SCHEMA_MUTATION_TOKENS.has(token)) {
    throw new Error(
      `coordination transaction read helper refused a mutating statement ${token}`,
    );
  }
}

export class CoordinationTransaction {
  private active = true;

  constructor(private readonly database: Database.Database) {}

  run(sql: string, ...parameters: SqliteValue[]): Database.RunResult {
    this.assertActive();
    assertMutationStatement(sql);
    const result = this.database.prepare<SqliteValue[]>(sql).run(...parameters);
    this.assertActive();
    return result;
  }

  readOne<T>(sql: string, ...parameters: SqliteValue[]): T | undefined {
    this.assertActive();
    assertReadStatement(sql);
    const statement = this.database.prepare<SqliteValue[], T>(sql);
    if (!statement.readonly) {
      throw new Error("coordination transaction read helper refused a mutating statement");
    }
    const result = statement.get(...parameters);
    this.assertActive();
    return result;
  }

  readAll<T>(sql: string, ...parameters: SqliteValue[]): T[] {
    this.assertActive();
    assertReadStatement(sql);
    const statement = this.database.prepare<SqliteValue[], T>(sql);
    if (!statement.readonly) {
      throw new Error("coordination transaction read helper refused a mutating statement");
    }
    const result = statement.all(...parameters);
    this.assertActive();
    return result;
  }

  invalidate(): void {
    this.active = false;
  }

  private assertActive(): void {
    if (!this.active || !this.database.inTransaction) {
      throw new Error("coordination transaction context is no longer active");
    }
  }
}

export function canonicalCoordinationJson(
  value: JsonValue,
  ancestors = new Set<object>(),
): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("event payload contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new Error("event payload contains a circular array");
    ancestors.add(value);
    try {
      const entries: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new Error(`event payload contains a sparse array at index ${index}`);
        }
        entries.push(canonicalCoordinationJson(value[index] as JsonValue, ancestors));
      }
      return `[${entries.join(",")}]`;
    } finally {
      ancestors.delete(value);
    }
  }
  if (typeof value !== "object") {
    throw new Error(`event payload contains unsupported ${typeof value} value`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("event payload contains a non-JSON object");
  }
  if (ancestors.has(value)) throw new Error("event payload contains a circular object");
  ancestors.add(value);
  try {
    const entries = Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalCoordinationJson(value[key] as JsonValue, ancestors)}`,
      );
    return `{${entries.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function assertEventInput(event: CoordinationEventInput): void {
  if (event.type.length < 3) throw new Error("coordination event type is too short");
  if (event.aggregateKind.length < 1 || event.aggregateId.length < 1) {
    throw new Error("coordination event aggregate is required");
  }
  if (!Number.isSafeInteger(event.aggregateVersion) || event.aggregateVersion < 1) {
    throw new Error("coordination event aggregate version must be a positive integer");
  }
  if (event.channelId !== null) assertCoordinationId("channel", event.channelId);
  if (event.actorPrincipalId !== null) {
    assertCoordinationId("principal", event.actorPrincipalId);
  }
  assertCoordinationId("request", event.requestId);
  assertCoordinationId("correlation", event.correlationId);
  const parsed = new Date(event.createdAt);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== event.createdAt) {
    throw new Error("coordination event timestamp must be UTC ISO-8601 with milliseconds");
  }
}

function orderedEventInputs<T>(outcome: CoordinationMutation<T>): readonly CoordinationEventInput[] {
  const event = outcome.event;
  const events = outcome.events;
  if (event !== undefined && events !== undefined) {
    throw new Error("coordination mutation must return one event or one ordered event set");
  }
  if (event !== undefined) return Object.freeze([event]);
  if (!Array.isArray(events) || events.length === 0) {
    throw new Error("coordination mutation requires a nonempty ordered event set");
  }
  return Object.freeze([...events]);
}

function assertEventSetIdentity(events: readonly CoordinationEventInput[]): void {
  const first = events[0]!;
  for (const event of events.slice(1)) {
    if (
      event.requestId !== first.requestId ||
      event.correlationId !== first.correlationId
    ) {
      throw new Error(
        "coordination mutation events must share request and correlation IDs",
      );
    }
  }
}

function assertNextAggregateVersion(
  database: Database.Database,
  input: CoordinationEventInput,
): void {
  const row = database
    .prepare<[string, string], { aggregateVersion: number | null }>(
      `SELECT max(aggregate_version) AS aggregateVersion
       FROM events WHERE aggregate_kind = ? AND aggregate_id = ?`,
    )
    .get(input.aggregateKind, input.aggregateId);
  const current = row?.aggregateVersion ?? 0;
  const expected = current + 1;
  if (input.aggregateVersion !== expected) {
    throw new Error(
      `coordination event aggregate version is not gap-free: expected ${expected}, received ${input.aggregateVersion}`,
    );
  }
}

function appendEvent(
  database: Database.Database,
  input: CoordinationEventInput,
): StoredCoordinationEvent {
  assertEventInput(input);
  assertNextAggregateVersion(database, input);
  const id = generateCoordinationId("event");
  const payloadJson = canonicalCoordinationJson(input.payload);
  const payloadDigest = createHash("sha256").update(payloadJson, "utf8").digest("hex");
  const result = database
    .prepare(
      `INSERT INTO events (
        id, schema_version, type, durability, aggregate_kind, aggregate_id,
        aggregate_version, channel_id, actor_principal_id, request_id,
        correlation_id, payload_json, payload_digest, created_at
      ) VALUES (?, ?, ?, 'durable', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      CONNECTED_AGENTS_CONTRACT_VERSION,
      input.type,
      input.aggregateKind,
      input.aggregateId,
      input.aggregateVersion,
      input.channelId,
      input.actorPrincipalId,
      input.requestId,
      input.correlationId,
      payloadJson,
      payloadDigest,
      input.createdAt,
    );
  const sequence = Number(result.lastInsertRowid);
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new Error("coordination event sequence exceeds the safe integer range");
  }
  return {
    sequence,
    id,
    schemaVersion: CONNECTED_AGENTS_CONTRACT_VERSION,
    type: input.type,
    durability: "durable",
    aggregateKind: input.aggregateKind,
    aggregateId: input.aggregateId,
    aggregateVersion: input.aggregateVersion,
    channelId: input.channelId,
    actorPrincipalId: input.actorPrincipalId,
    requestId: input.requestId,
    correlationId: input.correlationId,
    payloadJson,
    payloadDigest,
    createdAt: input.createdAt,
  };
}

export function runMutationWithEvent<T>(
  database: Database.Database,
  mutate: (transaction: CoordinationTransaction) => CoordinationMutation<T>,
): CoordinationMutationResult<T> {
  const transaction = database.transaction(() => {
    const context = new CoordinationTransaction(database);
    let outcome: CoordinationMutation<T>;
    try {
      outcome = mutate(context);
    } finally {
      context.invalidate();
    }
    const inputs = orderedEventInputs(outcome);
    assertEventSetIdentity(inputs);
    const events = Object.freeze(inputs.map((input) => appendEvent(database, input)));
    return {
      value: outcome.value,
      event: events[events.length - 1]!,
      events,
    };
  });
  return transaction.immediate();
}
