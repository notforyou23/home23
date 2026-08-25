import { assertStoredActorBinding } from "../channels/mutation.js";
import { CanonicalSearchError } from "./errors.js";
import type {
  CanonicalSearchDatabase,
  SearchCompleteness,
  SearchRepositoryResult,
  SearchResult,
  SearchScope,
} from "./types.js";

interface SearchEvidenceRow {
  throughEventSequence: number;
  sourceEventSequence: number;
  indexedThroughEventSequence: number;
  sourceRows: number;
  indexedRows: number;
}

interface SearchRow extends Omit<SearchResult, "type"> {}

const ELIGIBLE_SOURCE = `
  m.body_text IS NOT NULL
  AND m.stored_visibility = 'visible'
  AND m.tombstones_message_id IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM messages tombstone
    WHERE tombstone.tombstones_message_id = m.id
  )`;

const EXACT_INDEX_CROSSING = `
  message_fts.message_id = m.id
  AND message_fts.body_text = m.body_text`;

function channelId(scope: SearchScope): string | null {
  return scope.kind === "channel" ? scope.channelId : null;
}

export class SqliteCanonicalSearchRepository {
  constructor(private readonly database: CanonicalSearchDatabase) {}

  search(input: Parameters<import("./types.js").CanonicalSearchRepository["search"]>[0]): SearchRepositoryResult {
    assertStoredActorBinding(this.database, input.actor);
    const requestedChannelId = channelId(input.scope);
    if (requestedChannelId !== null && !this.database.readOne<{ present: number }>(
      `SELECT 1 AS present FROM channel_members
       WHERE channel_id = ? AND principal_id = ? AND active = 1`,
      requestedChannelId,
      input.actor.principalId,
    )) {
      throw new CanonicalSearchError("scope_denied");
    }

    const boundarySql = input.boundary
      ? "AND (m.created_at < ? OR (m.created_at = ? AND m.id > ?))"
      : "";
    const parameters: Array<string | number | null> = [
      input.actor.principalId,
      input.ftsQuery,
      requestedChannelId,
      requestedChannelId,
    ];
    if (input.boundary) {
      parameters.push(
        input.boundary.createdAt,
        input.boundary.createdAt,
        input.boundary.messageId,
      );
    }
    parameters.push(input.limit + 1);
    const rows = this.database.readAll<SearchRow>(
      `SELECT
         m.id,
         h.id AS conversationId,
         m.channel_id AS channelId,
         c.title,
         snippet(message_fts, 1, '', '', '…', 24) AS excerpt,
         m.channel_sequence AS sequence,
         m.created_at AS createdAt
       FROM message_fts
       JOIN messages m ON m.rowid = message_fts.rowid
       JOIN conversation_handles h ON h.channel_id = m.channel_id
       JOIN channels c ON c.id = m.channel_id
       JOIN channel_members member
         ON member.channel_id = m.channel_id
        AND member.principal_id = ?
        AND member.active = 1
       WHERE message_fts MATCH ?
         AND ${ELIGIBLE_SOURCE}
         AND ${EXACT_INDEX_CROSSING}
         AND (? IS NULL OR m.channel_id = ?)
         ${boundarySql}
       ORDER BY m.created_at DESC, m.id ASC
       LIMIT ?`,
      ...parameters,
    );
    const page = rows.slice(0, input.limit);
    const results = page.map((row) => Object.freeze({
      type: "message" as const,
      ...row,
    }));
    const last = page.at(-1);
    const nextBoundary = rows.length > input.limit && last
      ? Object.freeze({ createdAt: last.createdAt, messageId: last.id })
      : null;

    const evidence = this.database.readOne<SearchEvidenceRow>(
      `SELECT
         coalesce((SELECT seq FROM sqlite_sequence WHERE name = 'events'), 0)
           AS throughEventSequence,
         coalesce((SELECT max(sequence) FROM events WHERE type = 'message.appended'), 0)
           AS sourceEventSequence,
         coalesce((SELECT indexed_through_event_sequence FROM search_watermarks
                   WHERE source_class = 'coordination.messages'), 0)
           AS indexedThroughEventSequence,
         (SELECT count(*)
          FROM messages m
          JOIN channel_members member
            ON member.channel_id = m.channel_id
           AND member.principal_id = ?
           AND member.active = 1
          WHERE ${ELIGIBLE_SOURCE}
            AND (? IS NULL OR m.channel_id = ?)) AS sourceRows,
         (SELECT count(*)
          FROM message_fts
          JOIN messages m ON m.rowid = message_fts.rowid
          JOIN channel_members member
            ON member.channel_id = m.channel_id
           AND member.principal_id = ?
           AND member.active = 1
          WHERE ${ELIGIBLE_SOURCE}
            AND ${EXACT_INDEX_CROSSING}
            AND (? IS NULL OR m.channel_id = ?)) AS indexedRows`,
      input.actor.principalId,
      requestedChannelId,
      requestedChannelId,
      input.actor.principalId,
      requestedChannelId,
      requestedChannelId,
    );
    if (!evidence) throw new Error("canonical search evidence query returned no row");
    const canaryFtsQuery = input.canary ? toFtsQuery(input.canary.query) : null;
    const canaryFound = input.canary !== null && this.database.readOne<{ present: number }>(
      `SELECT 1 AS present
       FROM message_fts
       JOIN messages m ON m.rowid = message_fts.rowid
       JOIN channel_members member
         ON member.channel_id = m.channel_id
        AND member.principal_id = ?
        AND member.active = 1
       WHERE message_fts MATCH ?
         AND message_fts.message_id = ?
         AND (? IS NULL OR m.channel_id = ?)
         AND ${ELIGIBLE_SOURCE}
         AND ${EXACT_INDEX_CROSSING}
       LIMIT 1`,
      input.actor.principalId,
      canaryFtsQuery!,
      input.canary.messageId,
      requestedChannelId,
      requestedChannelId,
    ) !== undefined;
    const routeBlind = !canaryFound ||
      evidence.sourceRows !== evidence.indexedRows ||
      evidence.sourceEventSequence !== evidence.indexedThroughEventSequence;
    const verdict: SearchCompleteness["verdict"] = routeBlind
      ? "route_blind"
      : results.length === 0 ? "scoped_empty" : "complete";
    const reason = routeBlind
      ? "The indexed route, watermark, crossing counts, or same-path canary is incomplete; this zero does not prove reality is empty."
      : results.length === 0
        ? "No message in the authorized canonical scope matched through the reported index watermark."
        : "Canonical authorized Messages crossed the SQLite FTS path through the reported watermark.";
    const completeness: SearchCompleteness = Object.freeze({
      status: routeBlind ? "partial" as const : "complete" as const,
      respondingRoute: "/api/v1/search" as const,
      authoritativeSource: "coordination.messages" as const,
      sourceEventSequence: evidence.sourceEventSequence,
      indexRoute: "sqlite_fts5" as const,
      indexedThroughEventSequence: evidence.indexedThroughEventSequence,
      crossingProof: Object.freeze({
        sourceRows: evidence.sourceRows,
        indexedRows: evidence.indexedRows,
        checkedAt: input.checkedAt,
      }),
      filters: Object.freeze({
        principalId: input.actor.principalId,
        scope: input.scope.kind,
        channelId: requestedChannelId,
        sourceClasses: Object.freeze(["coordination.messages"] as const),
        membership: "active" as const,
        visibility: "visible_not_tombstoned" as const,
      }),
      samePathCanary: Object.freeze({
        id: input.canary?.id ?? "unconfigured",
        found: canaryFound,
        checkedAt: input.checkedAt,
      }),
      importCoverage: Object.freeze({ bodyImported: 0 as const, referenceOnly: 0 as const }),
      verdict,
      reason,
    });
    return Object.freeze({
      results: Object.freeze(results),
      nextBoundary,
      completeness,
      throughEventSequence: evidence.throughEventSequence,
    });
  }
}

export function toFtsQuery(query: string): string {
  const terms = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
  if (terms.length === 0) throw new CanonicalSearchError("request_invalid");
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" ");
}
