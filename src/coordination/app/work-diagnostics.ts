import type { CoordinationTurnOrigin } from '../../agent/types.js';
import type { M11Database } from '../work/types.js';
import type { createResidentAssignments } from './resident-assignments.js';
import { workTerminalEvidence } from './resident-outcomes.js';

/** Resident-fenced diagnostic reads; authorization remains with channel operations. */
export function createWorkDiagnostics(options: {
  database: M11Database;
  assignments: Pick<ReturnType<typeof createResidentAssignments>, 'list' | 'direction'>;
}) {
  const database = options.database, residentAssignments = options.assignments;
  return (principalId: string, args: Record<string, unknown>, origin: CoordinationTurnOrigin) => {
    const id = typeof args.work_id === 'string' ? args.work_id.trim() || null : null;
    if (args.operation === 'work_status' && !id) throw new Error('work_id is required');
    const limit = Math.min(100, Math.max(1, Math.floor(Number(args.limit) || 20)));
    const rows = database.readAll<Record<string, unknown>>(`SELECT w.id, w.channel_id AS channelId, w.state,
      w.terminal_reason AS terminalReason, w.current_attempt_id AS attemptId,
      p.parent_work_id AS parentWorkId, json_extract(p.assignment_json, '$.toolName') AS toolName,
      coalesce(t.title, substr(m.body_text,1,160), 'Work') AS title,
      coalesce(t.summary, m.body_text) AS summary, m.id AS originMessageId,
      m.body_text AS originalRequest, w.created_at AS createdAt, w.terminal_at AS terminalAt
      FROM works w LEFT JOIN work_planned_invocations p ON p.work_id = w.id
      LEFT JOIN work_thread_presentations t ON t.work_id=w.id
      LEFT JOIN messages m ON m.id=w.origin_message_id
      WHERE w.target_principal_id = ? ${id ? 'AND w.id = ?' : args.include_terminal === true ? '' : "AND w.state NOT IN ('succeeded','failed','cancelled')"}
      ${!id && args.assignments_only === true ? "AND (w.kind='resident_work_thread' OR t.work_id IS NOT NULL)" : ''}
      ORDER BY w.created_at DESC LIMIT ?`, principalId, ...(id ? [id] : []), limit);
    const unseenOwnerMessages = database.readAll<Record<string, unknown>>(`SELECT m.id AS messageId,m.channel_sequence AS sequence,m.body_text AS text,m.created_at AS createdAt
      FROM works w JOIN context_manifests c ON c.id=w.context_manifest_id
      JOIN messages m ON m.channel_id=w.channel_id AND m.channel_sequence>c.channel_watermark
      WHERE w.id=? AND m.author_kind='owner' AND m.kind='text' AND m.stored_visibility='visible'
        AND NOT EXISTS(SELECT 1 FROM events e WHERE e.aggregate_kind='scheduled_channel_run'
          AND e.aggregate_version=1 AND json_extract(e.payload_json,'$.messageId')=m.id)
      ORDER BY m.channel_sequence`, origin.workId);
    // An exact status read is independent of the resident's assignment backlog.
    const assignments = id ? [] : residentAssignments.list(principalId, args.include_terminal === true, limit);
    const ownerContact = database.readOne<{ messageId: string; text: string; channelId: string;
      channelKind: 'direct' | 'group'; channelSequence: number; sourceSequence: number;
      previousAssistantMessageId: string | null; createdAt: string }>(`SELECT m.id AS messageId,m.body_text AS text,
      m.channel_id AS channelId,c.kind AS channelKind,m.channel_sequence AS channelSequence,m.created_at AS createdAt,e.sequence AS sourceSequence,
      (SELECT a.id FROM messages a WHERE a.channel_id=m.channel_id AND a.channel_sequence<m.channel_sequence
        AND a.author_principal_id=w.target_principal_id AND a.author_kind='bot' AND a.kind IN ('text','result')
        AND a.stored_visibility='visible' AND a.body_text IS NOT NULL ORDER BY a.channel_sequence DESC LIMIT 1) AS previousAssistantMessageId
      FROM works w JOIN messages m ON m.id=w.origin_message_id JOIN channels c ON c.id=m.channel_id
      JOIN events e ON e.aggregate_kind='message' AND e.aggregate_id=m.id AND e.aggregate_version=1 WHERE w.id=?
      AND w.kind IN ('resident_turn','channel.bot_turn') AND m.author_kind='owner' AND m.kind='text' AND m.body_text IS NOT NULL AND m.stored_visibility='visible'
      AND NOT EXISTS(SELECT 1 FROM resident_outcomes o WHERE o.review_work_id=w.id)
      AND NOT EXISTS(SELECT 1 FROM events e WHERE e.aggregate_kind='scheduled_channel_run'
        AND e.aggregate_version=1 AND json_extract(e.payload_json,'$.messageId')=m.id)`, origin.workId);
    const lookup = id ? { status: rows.length ? 'found' : 'not_found', workId: id,
      ...(rows.length ? {} : { message: 'Work was not found in this resident scope. The record may have been archived or removed.' }) } : undefined;
    return { registry: 'canonical', ...(lookup ? { lookup } : {}), work: !id && args.assignments_only === true ? assignments : id ? rows.map(row => ({ ...row, terminalEvidence: workTerminalEvidence(database, id) })) : rows,
      assignments, unseenOwnerMessages, ...residentAssignments.direction(origin.workId), ownerContact: ownerContact ?? null };
  };
}
