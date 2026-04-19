#!/usr/bin/env node
/**
 * Backfill historical conversation JSONL into workspace-ingestable markdown.
 *
 * Walks every agent's instances/<agent>/conversations/*.jsonl and
 * conversations/sessions/*.jsonl, extracts user + assistant text, writes
 * workspace/sessions/backfill-<chatId>.md — where the feeder picks them up
 * automatically on its next scan.
 *
 * Idempotent — rewrites only when the source JSONL is newer than the
 * existing backfill file, so repeated runs skip already-handled chats.
 *
 * Usage:
 *   node cli/lib/backfill-conversations.js
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const INSTANCES = path.join(REPO_ROOT, 'instances');

/** Pull plain user/assistant text out of an Anthropic-style content value. */
function extractText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
    // tool_use / tool_result / thinking / redacted_thinking / image — skipped
    // (noisy for brain ingestion; compiled session transcripts follow the
    // same policy in src/agent/loop.ts#compileSessionTranscript).
  }
  return parts.join('\n').trim();
}

function compileJsonlToMarkdown(lines, chatId, source) {
  const messages = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    // Skip envelope/event/boundary records — they're not dialogue.
    if (r && typeof r === 'object' && 'type' in r) {
      if (r.type === 'turn' || r.type === 'event' || r.type === 'session_boundary') continue;
    }
    if (!r || !r.role) continue;
    const text = extractText(r.content);
    if (!text) continue;
    messages.push({ role: r.role, text, ts: r.ts || null });
  }
  if (messages.length < 2) return null;

  const first = messages[0].ts;
  const last = messages[messages.length - 1].ts;
  const header = [
    '# Conversation Transcript (backfill)',
    '',
    `- **chatId:** ${chatId}`,
    `- **source:** ${source}`,
    `- **messages:** ${messages.length}`,
    first ? `- **first:** ${first}` : null,
    last ? `- **last:** ${last}` : null,
    '',
    '---',
    '',
  ].filter(Boolean).join('\n');

  const body = messages.map(m => {
    const role = m.role === 'user' ? 'User' : 'Assistant';
    const tsSuffix = m.ts ? ` *(${m.ts})*` : '';
    return `## ${role}${tsSuffix}\n\n${m.text}\n`;
  }).join('\n');

  return header + '\n' + body;
}

async function processAgent(agentDir) {
  const agent = path.basename(agentDir);
  const convDir = path.join(agentDir, 'conversations');
  const sessionsOutDir = path.join(agentDir, 'workspace', 'sessions');

  try { await fs.access(convDir); } catch { return { agent, wrote: 0, skipped: 0, errors: 0 }; }
  await fs.mkdir(sessionsOutDir, { recursive: true });

  const files = [];
  for (const entry of await fs.readdir(convDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      files.push({ path: path.join(convDir, entry.name), source: 'harness' });
    }
  }
  const sessionsSubdir = path.join(convDir, 'sessions');
  try {
    for (const entry of await fs.readdir(sessionsSubdir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        files.push({ path: path.join(sessionsSubdir, entry.name), source: 'thread_session' });
      }
    }
  } catch { /* no sessions subdir — that's fine */ }

  let wrote = 0, skipped = 0, errors = 0;
  for (const f of files) {
    const base = path.basename(f.path, '.jsonl');
    // Strip the harness's namespace prefix (agent__<chatId> → <chatId>).
    // Handles legacy double-prefixed files too.
    let chatId = base;
    const nsPrefix = `${agent}__`;
    while (chatId.startsWith(nsPrefix)) chatId = chatId.slice(nsPrefix.length);
    const outPath = path.join(sessionsOutDir, `backfill-${chatId}.md`);

    try {
      const inStat = await fs.stat(f.path);
      const outStat = await fs.stat(outPath).catch(() => null);
      if (outStat && outStat.mtime.getTime() >= inStat.mtime.getTime()) {
        skipped++;
        continue;
      }
      const raw = await fs.readFile(f.path, 'utf8');
      const md = compileJsonlToMarkdown(raw.split('\n'), chatId, f.source);
      if (!md) { skipped++; continue; }
      await fs.writeFile(outPath, md);
      wrote++;
    } catch (err) {
      console.error(`  [${agent}] ${path.basename(f.path)}: ${err.message}`);
      errors++;
    }
  }
  return { agent, wrote, skipped, errors };
}

async function main() {
  console.log(`Backfilling conversations from ${INSTANCES}`);
  const entries = await fs.readdir(INSTANCES, { withFileTypes: true });
  const agents = entries.filter(e => e.isDirectory()).map(e => e.name);
  if (agents.length === 0) { console.error('No agents under instances/. Abort.'); process.exit(1); }
  console.log(`Agents: ${agents.join(', ')}\n`);

  let totalWrote = 0, totalSkipped = 0, totalErrors = 0;
  for (const agent of agents) {
    const r = await processAgent(path.join(INSTANCES, agent));
    console.log(`  ${r.agent}: wrote ${r.wrote}, skipped ${r.skipped}${r.errors ? `, errors ${r.errors}` : ''}`);
    totalWrote += r.wrote;
    totalSkipped += r.skipped;
    totalErrors += r.errors;
  }
  console.log(`\nDone. Total: wrote ${totalWrote}, skipped ${totalSkipped}${totalErrors ? `, errors ${totalErrors}` : ''}.`);
  console.log('Feeder will ingest new files on its next scan (automatic within seconds).');
}

main().catch(err => { console.error(err); process.exit(1); });
