#!/usr/bin/env node
/**
 * Backfill historical conversation JSONL into workspace-ingestable markdown.
 *
 * Walks an agent's instances/<agent>/conversations/*.jsonl and
 * conversations/sessions/*.jsonl, extracts user + assistant text, writes
 * workspace/sessions/backfill-<chatId>.md — where the feeder picks them up
 * automatically on its next scan. When HOME23_AGENT is set by a harness, only
 * that agent is processed; manual shell runs without HOME23_AGENT process all
 * agents unless --agent is supplied.
 *
 * Idempotent — rewrites only when the source JSONL is newer than the
 * existing backfill file, so repeated runs skip already-handled chats.
 *
 * Usage:
 *   node cli/lib/backfill-conversations.js
 *   node cli/lib/backfill-conversations.js --agent jerry
 *   node cli/lib/backfill-conversations.js --all
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const INSTANCES = path.join(REPO_ROOT, 'instances');

function parseArgs(argv) {
  const args = [...argv];
  let agent = process.env.HOME23_AGENT || '';
  let all = false;

  while (args.length > 0) {
    const arg = args.shift();
    if (arg === '--all') {
      all = true;
      agent = '';
      continue;
    }
    if (arg === '--agent') {
      agent = args.shift() || '';
      continue;
    }
    if (arg?.startsWith('--agent=')) {
      agent = arg.slice('--agent='.length);
      continue;
    }
  }

  return { agent: agent.trim(), all };
}

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
  const entries = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if (!r || typeof r !== 'object') continue;

    if (r.role) {
      const text = extractText(r.content);
      if (text) entries.push({ kind: 'message', role: r.role, text, ts: r.ts || null });
      continue;
    }

    // A session with only tool/event records was previously dropped on the
    // floor. Preserve a compact operational receipt so every source JSONL has
    // an ingestable artifact without dumping noisy raw tool-result payloads.
    if (r.type === 'event' && r.kind) {
      const data = r.data && typeof r.data === 'object' ? r.data : {};
      const tool = data.tool ? ` — ${data.tool}` : '';
      const outcome = data.success === false ? ' (failed)' : '';
      entries.push({
        kind: 'event',
        text: `Operational event: ${r.kind}${tool}${outcome}`,
        ts: r.ts || null,
      });
    } else if (r.type === 'turn') {
      const status = r.status ? ` (${r.status})` : '';
      entries.push({ kind: 'event', text: `Turn receipt${status}`, ts: r.ended_at || r.ts || null });
    } else if (r.type === 'session_boundary') {
      entries.push({ kind: 'event', text: `Session boundary${r.trigger ? ` — ${r.trigger}` : ''}`, ts: r.ts || null });
    }
  }
  if (entries.length === 0) return null;

  const first = entries.find(entry => entry.ts)?.ts;
  const last = [...entries].reverse().find(entry => entry.ts)?.ts;
  const dialogueCount = entries.filter(entry => entry.kind === 'message').length;
  const header = [
    '# Conversation Transcript (backfill)',
    '',
    `- **chatId:** ${chatId}`,
    `- **source:** ${source}`,
    `- **entries:** ${entries.length}`,
    `- **dialogue messages:** ${dialogueCount}`,
    first ? `- **first:** ${first}` : null,
    last ? `- **last:** ${last}` : null,
    '',
    '---',
    '',
  ].filter(Boolean).join('\n');

  const body = entries.map(entry => {
    const tsSuffix = entry.ts ? ` *(${entry.ts})*` : '';
    if (entry.kind === 'message') {
      const role = entry.role === 'user' ? 'User' : 'Assistant';
      return `## ${role}${tsSuffix}\n\n${entry.text}\n`;
    }
    return `- ${entry.text}${tsSuffix}`;
  }).join('\n\n');

  return header + '\n' + body + '\n';
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
  const args = parseArgs(process.argv.slice(2));
  const entries = await fs.readdir(INSTANCES, { withFileTypes: true });
  const availableAgents = entries.filter(e => e.isDirectory()).map(e => e.name);
  const agents = args.agent && !args.all ? availableAgents.filter(name => name === args.agent) : availableAgents;
  if (args.agent && agents.length === 0) {
    console.error(`Agent "${args.agent}" not found under instances/. Abort.`);
    process.exit(1);
  }
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
