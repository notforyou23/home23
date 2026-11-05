import { createHash } from "node:crypto";

import type Database from "better-sqlite3";

import { CANONICAL_SEARCH_INDEX_REBUILD_SQL } from "../search/schema-delta.js";
import {
  COORDINATION_SEARCH_ATTACHMENT_SCHEMA_DEPENDENCIES,
} from "../migrations/index.js";

interface SearchRebuildRow {
  sourceClass: "coordination.messages";
  sourceEventSequence: number;
  indexedThroughEventSequence: number;
  sourceRows: number;
  indexedRows: number;
  crossedRows: number;
}

export interface CanonicalSearchRebuildReceipt {
  sourceClass: "coordination.messages";
  sourceEventSequence: number;
  indexedThroughEventSequence: number;
  sourceRows: number;
  indexedRows: number;
  rebuildSqlSha256: string;
}

function rebuildSqlSha256(): string {
  return createHash("sha256")
    .update(CANONICAL_SEARCH_INDEX_REBUILD_SQL, "utf8")
    .digest("hex");
}

export function rebuildCanonicalSearchIndex(
  database: Database.Database,
): CanonicalSearchRebuildReceipt {
  const checksum = rebuildSqlSha256();
  if (
    checksum !== COORDINATION_SEARCH_ATTACHMENT_SCHEMA_DEPENDENCIES.m09SearchRebuildSql
  ) {
    throw new Error("canonical search rebuild SQL differs from the reviewed M09 dependency");
  }
  const rebuild = database.transaction(() => {
    database.exec(CANONICAL_SEARCH_INDEX_REBUILD_SQL);
    const row = database.prepare<[], SearchRebuildRow>(
      `SELECT
         watermark.source_class AS sourceClass,
         watermark.source_event_sequence AS sourceEventSequence,
         watermark.indexed_through_event_sequence AS indexedThroughEventSequence,
         watermark.source_rows AS sourceRows,
         watermark.indexed_rows AS indexedRows,
         (SELECT count(*)
          FROM messages message
          JOIN message_fts
            ON message_fts.rowid = message.rowid
           AND message_fts.message_id = message.id
           AND message_fts.body_text = message.body_text
          WHERE message.body_text IS NOT NULL
            AND message.stored_visibility = 'visible'
            AND message.tombstones_message_id IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM messages tombstone
              WHERE tombstone.tombstones_message_id = message.id
            )) AS crossedRows
       FROM search_watermarks watermark
       WHERE watermark.source_class = 'coordination.messages'`,
    ).get();
    if (!row) throw new Error("canonical search rebuild produced no watermark");
    if (
      row.sourceEventSequence !== row.indexedThroughEventSequence ||
      row.sourceRows !== row.indexedRows ||
      row.sourceRows !== row.crossedRows
    ) {
      throw new Error("canonical search rebuild did not produce an exact source crossing");
    }
    return Object.freeze({
      sourceClass: row.sourceClass,
      sourceEventSequence: row.sourceEventSequence,
      indexedThroughEventSequence: row.indexedThroughEventSequence,
      sourceRows: row.sourceRows,
      indexedRows: row.indexedRows,
      rebuildSqlSha256: checksum,
    });
  });
  return rebuild.immediate();
}
