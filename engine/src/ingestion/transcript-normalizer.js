/**
 * Session transcripts under workspace/sessions/ are mostly structure, not
 * knowledge: streamed operational events, tool-call markers and tool output.
 * Chunked raw, each line became its own memory node (half of jerry's brain on
 * 2026-09-21). This reduces a transcript to what is worth remembering.
 *
 * Returns { action: 'ingest', text } | { action: 'skip', reason }
 * | { action: 'unchanged' } for files that are not session transcripts.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const TOOL_MARKER = /^\[Used tools?:[^\]]*\]$/;
const TOOL_OUTPUT = /^[a-z][a-z0-9_]*: /; // "shell: STDOUT: ...", "read_file: ..."
const NOISE = /^\[Async work (completed|failed)\]/;

function sessionFile(filePath) {
  const normalized = String(filePath).replace(/\\/g, '/');
  if (!normalized.includes('/workspace/sessions/')) return null;
  const name = path.basename(normalized);
  let match = /^backfill-(.+)\.md$/.exec(name);
  if (match) return { kind: 'backfill', chatId: match[1], dir: path.dirname(filePath) };
  match = /^session-live-(.+)\.md$/.exec(name);
  if (match) return { kind: 'live', chatId: match[1], dir: path.dirname(filePath) };
  // Older live exports: session-<timestamp>.md, same **User:**/**Agent:** format.
  match = /^session-(\d{4}-\d{2}-\d{2}T.+)\.md$/.exec(name);
  if (match) return { kind: 'live', chatId: match[1], dir: path.dirname(filePath) };
  return null;
}

// Backfill: "## User *(ts)*" / "## Assistant *(ts)*" sections.
// Live: "**User:** text" / "**Agent:** text" lines with continuation lines.
function parseTurns(text, kind) {
  const turns = [];
  let current = null;
  for (const line of text.split('\n')) {
    const header = kind === 'backfill'
      ? /^## (User|Assistant)\b/.exec(line)
      : /^\*\*(User|Agent):\*\*\s?(.*)$/.exec(line);
    if (header) {
      current = { role: header[1] === 'User' ? 'User' : 'Agent', lines: [] };
      turns.push(current);
      if (kind === 'live' && header[2]) current.lines.push(header[2]);
      continue;
    }
    if (kind === 'backfill' && /^## /.test(line)) { current = null; continue; }
    if (current) current.lines.push(line);
  }
  for (const turn of turns) {
    // Tool receipt lines ("shell: STDOUT: ...") only follow a tool marker.
    const usedTools = turn.lines.some((line) => TOOL_MARKER.test(line.trim()));
    turn.text = turn.lines
      .map((line) => line.trimEnd())
      .filter((line) => {
        const trimmed = line.trim();
        return !TOOL_MARKER.test(trimmed) && !NOISE.test(trimmed)
          && !(usedTools && TOOL_OUTPUT.test(trimmed));
      })
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    delete turn.lines;
  }
  return turns.filter((turn) => turn.text);
}

function normalizeTranscript(filePath, text, { exists = fs.existsSync } = {}) {
  const session = sessionFile(filePath);
  if (!session) return { action: 'unchanged' };

  if (session.kind === 'backfill'
      && exists(path.join(session.dir, `session-live-${session.chatId}.md`))) {
    return { action: 'skip', reason: 'live export covers this chat' };
  }

  const turns = parseTurns(text, session.kind);
  if (turns.length === 0) {
    // A backfill export with no dialogue is only operational events. Any
    // other unrecognized layout keeps current behavior rather than drop it.
    if (session.kind === 'backfill' && text.startsWith('# Conversation Transcript (backfill)')) {
      return { action: 'skip', reason: 'no dialogue' };
    }
    return { action: 'unchanged' };
  }

  if (/^cron-/.test(session.chatId)) {
    const outcome = [...turns].reverse().find((turn) => turn.role === 'Agent');
    if (!outcome) return { action: 'skip', reason: 'cron run without an outcome' };
    return { action: 'ingest', text: `# Cron run ${session.chatId}\n\n${outcome.text}` };
  }

  return {
    action: 'ingest',
    text: `# Conversation ${session.chatId}\n\n${turns.map((turn) => `${turn.role}: ${turn.text}`).join('\n\n')}`,
  };
}

module.exports = { normalizeTranscript };
