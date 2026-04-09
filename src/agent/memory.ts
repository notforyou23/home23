/**
 * COSMO Home 2.3 — MemoryManager
 *
 * Three memory systems for Althea:
 *
 * A) extractAndSave   — session end: extract learnings via Claude, write to daily file + MEMORY.md
 * B) buildRecoveryBundle — post-compaction: reinject last 24h memory into system prompt
 * C) semanticRecall   — pre-turn: FAISS search over memory chunks, inject top hits
 */

import Anthropic from '@anthropic-ai/sdk';
import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  existsSync,
  readdirSync,
  mkdirSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import type { StoredMessage } from './history.js';

// Derive search script path from project root (workspace/../memory-pipeline/search.py)
// Falls back gracefully — existsSync check in semanticRecall handles missing script
const SEARCH_SCRIPT_NAME = 'memory-pipeline/search.py';
const MEMORY_DIR_NAME = 'memory';
const MEMORY_FILE = 'MEMORY.md';
const MAX_RECOVERY_CHARS = 2000;
const MAX_RECALL_CHARS = 2000;
const SEMANTIC_TIMEOUT_MS = 500;

// ─── Types ───────────────────────────────────────────────────

interface SearchResult {
  source_file: string;
  score: number;
  preview: string;
}

// ─── MemoryManager ───────────────────────────────────────────

export class MemoryManager {
  private client: Anthropic;
  private model: string;
  private workspacePath: string;
  private memoryDir: string;
  private searchScript: string;

  constructor(opts: {
    client: Anthropic;
    model: string;
    workspacePath: string;
  }) {
    this.client = opts.client;
    this.model = opts.model;
    this.workspacePath = opts.workspacePath;
    this.memoryDir = join(opts.workspacePath, MEMORY_DIR_NAME);
    this.searchScript = join(opts.workspacePath, '..', SEARCH_SCRIPT_NAME);
    mkdirSync(this.memoryDir, { recursive: true });
  }

  // ── A) Extract and Save ──────────────────────────────────

  /**
   * Extract learnings from conversation history and persist.
   * Fire-and-forget — never call with await in the hot path.
   */
  async extractAndSave(
    chatId: string,
    messages: Array<{ role: string; content: unknown }>,
    currentModel?: string,
  ): Promise<void> {
    try {
      if (messages.length < 4) return; // Not enough to be worth extracting
      // Build a condensed transcript (last 30 messages max)
      const recent = messages.slice(-30);
      const transcript = recent
        .map(m => {
          const role = m.role === 'user' ? 'Human' : 'Assistant';
          const content = typeof m.content === 'string'
            ? m.content
            : Array.isArray(m.content)
              ? (m.content as Array<{ type: string; text?: string }>)
                  .filter(b => b.type === 'text' && b.text)
                  .map(b => b.text)
                  .join(' ')
              : String(m.content);
          return `${role}: ${content.slice(0, 500)}`;
        })
        .join('\n\n');

      const response = await this.client.messages.create({
        model: 'claude-haiku-4-5',
        max_tokens: 500,
        system: 'You are a memory extraction assistant. Extract only concrete facts, decisions, and context worth remembering. Be terse. No fluff.',
        messages: [
          {
            role: 'user',
            content: `Extract the key facts, decisions, and important context from this conversation that should be remembered for future sessions. Focus on: what was built/changed, what was decided, what was learned, what is in progress. Be concise — bullet points only.\n\n${transcript}`,
          },
        ],
      });

      const extracted = response.content
        .filter(b => b.type === 'text')
        .map(b => (b as { text: string }).text)
        .join('\n')
        .trim();

      if (!extracted) return;

      const dateStr = new Date().toISOString().split('T')[0]!;
      const timeStr = new Date().toLocaleTimeString('en-US', {
        timeZone: 'America/New_York',
        hour: '2-digit',
        minute: '2-digit',
      });

      // Write to daily memory file
      const dailyPath = join(this.memoryDir, `${dateStr}.md`);
      const dailyEntry = `\n## Session ${timeStr} ET — chat:${chatId}\n\n${extracted}\n`;
      appendFileSync(dailyPath, dailyEntry, 'utf-8');

      // Append condensed version to MEMORY.md under ## Recent Sessions
      const memoryPath = join(this.workspacePath, MEMORY_FILE);
      const memoryContent = existsSync(memoryPath)
        ? readFileSync(memoryPath, 'utf-8')
        : '';

      const sessionLine = `\n### ${dateStr} ${timeStr} ET\n${extracted.split('\n').slice(0, 5).join('\n')}\n`;

      if (memoryContent.includes('## Recent Sessions')) {
        // Insert after the ## Recent Sessions header
        const updated = memoryContent.replace(
          '## Recent Sessions',
          `## Recent Sessions\n${sessionLine}`,
        );
        writeFileSync(memoryPath, updated, 'utf-8');
      } else {
        // Append new section
        appendFileSync(memoryPath, `\n## Recent Sessions\n${sessionLine}`, 'utf-8');
      }

      console.log(`[memory] Extracted and saved session memory for ${chatId} (${dateStr})`);
    } catch (err) {
      // Never crash — memory extraction is best-effort
      console.warn('[memory] extractAndSave failed:', err instanceof Error ? err.message : err);
    }
  }

  /**
   * Extract structured learnings from messages about to be compacted.
   * Called BEFORE compaction so nothing is lost.
   */
  async preCompactionExtract(
    chatId: string,
    messages: StoredMessage[],
    currentModel?: string,
  ): Promise<string | null> {
    try {
      if (messages.length < 3) return null;
      if (!(currentModel ?? this.model).includes('claude')) return null;

      const transcript = messages
        .map(m => {
          const role = m.role === 'user' ? 'Human' : 'Assistant';
          const content = typeof m.content === 'string'
            ? m.content
            : Array.isArray(m.content)
              ? (m.content as Array<{ type: string; text?: string }>)
                  .filter(b => b.type === 'text' && b.text)
                  .map(b => b.text)
                  .join(' ')
              : String(m.content);
          return `${role}: ${content.slice(0, 300)}`;
        })
        .join('\n');

      const response = await this.client.messages.create({
        model: 'claude-haiku-4-5',
        max_tokens: 600,
        system: 'Extract structured learnings from this conversation segment. Be terse. Bullet points only.',
        messages: [{
          role: 'user',
          content: `Extract learnings from this conversation in these 5 categories:\n\n1. DECISIONS MADE\n2. WHAT WORKED\n3. WHAT FAILED/BLOCKED\n4. FACTS LEARNED\n5. OPEN QUESTIONS\n\nSkip any category with nothing notable. Be concise.\n\n${transcript}`,
        }],
      });

      const extracted = response.content
        .filter(b => b.type === 'text')
        .map(b => (b as { text: string }).text)
        .join('\n')
        .trim();

      if (!extracted) return null;

      // Save to daily memory file
      const dateStr = new Date().toISOString().split('T')[0]!;
      const timeStr = new Date().toLocaleTimeString('en-US', {
        timeZone: 'America/New_York',
        hour: '2-digit',
        minute: '2-digit',
      });
      const dailyPath = join(this.memoryDir, `${dateStr}.md`);
      const entry = `\n## Pre-Compaction Extract ${timeStr} ET — chat:${chatId}\n\n${extracted}\n`;
      appendFileSync(dailyPath, entry, 'utf-8');

      console.log(`[memory] Pre-compaction extraction for ${chatId}: ${extracted.length} chars`);
      return extracted;
    } catch (err) {
      console.warn('[memory] preCompactionExtract failed:', err instanceof Error ? err.message : err);
      return null;
    }
  }

  // ── B) Recovery Bundle ───────────────────────────────────

  /**
   * Build a recovery bundle from recent memory files.
   * Called after compaction to restore context.
   */
  buildRecoveryBundle(): string | null {
    try {
      const cutoff = Date.now() - 24 * 60 * 60 * 1000; // 24 hours ago

      const files = readdirSync(this.memoryDir)
        .filter(f => f.endsWith('.md') && /^\d{4}-\d{2}-\d{2}/.test(f))
        .map(f => join(this.memoryDir, f))
        .filter(f => {
          try {
            return statSync(f).mtime.getTime() > cutoff;
          } catch {
            return false;
          }
        })
        .sort((a, b) => statSync(b).mtime.getTime() - statSync(a).mtime.getTime())
        .slice(0, 3); // Max 3 files

      if (files.length === 0) return null;

      const chunks: string[] = [];
      let totalChars = 0;

      for (const file of files) {
        const content = readFileSync(file, 'utf-8').trim();
        const filename = file.split('/').pop()!;
        const entry = `**${filename}:**\n${content}`;
        if (totalChars + entry.length > MAX_RECOVERY_CHARS) {
          // Truncate this entry to fit
          const remaining = MAX_RECOVERY_CHARS - totalChars;
          if (remaining > 100) {
            chunks.push(entry.slice(0, remaining) + '\n...(truncated)');
          }
          break;
        }
        chunks.push(entry);
        totalChars += entry.length;
      }

      if (chunks.length === 0) return null;

      return `## Memory Recovery Bundle\n*Recent session context restored after compaction*\n\n${chunks.join('\n\n---\n\n')}\n\n---`;
    } catch (err) {
      console.warn('[memory] buildRecoveryBundle failed:', err instanceof Error ? err.message : err);
      return null;
    }
  }

  // ── C) Semantic Recall ───────────────────────────────────

  /**
   * Search memory for relevant context before an agent turn.
   * Hard 500ms timeout — returns null silently on timeout or error.
   */
  async semanticRecall(query: string): Promise<string | null> {
    if (!query.trim()) return null;
    if (!existsSync(this.searchScript)) return null;

    return new Promise(resolve => {
      const timer = setTimeout(() => {
        resolve(null);
      }, SEMANTIC_TIMEOUT_MS);

      // Sanitize query for shell — strip quotes and newlines
      const safeQuery = query.replace(/['"]/g, ' ').replace(/\n/g, ' ').slice(0, 200);

      execFile(
        'python3',
        [this.searchScript, safeQuery, '--top', '3', '--min-score', '0.50', '--json'],
        { timeout: SEMANTIC_TIMEOUT_MS },
        (err, stdout, _stderr) => {
          clearTimeout(timer);

          if (err || !stdout.trim()) {
            resolve(null);
            return;
          }

          try {
            // Find JSON array in output
            const jsonStart = stdout.indexOf('[');
            const jsonEnd = stdout.lastIndexOf(']');
            if (jsonStart < 0 || jsonEnd < 0) {
              resolve(null);
              return;
            }

            const results = JSON.parse(stdout.slice(jsonStart, jsonEnd + 1)) as SearchResult[];

            if (!results.length) {
              resolve(null);
              return;
            }

            const formatted = results
              .map(r => `**${r.source_file}** (score: ${r.score.toFixed(2)})\n${r.preview}`)
              .join('\n\n');

            const truncated = formatted.length > MAX_RECALL_CHARS
              ? formatted.slice(0, MAX_RECALL_CHARS) + '\n...'
              : formatted;

            resolve(`## Memory Recall\n*Relevant context from past sessions*\n\n${truncated}\n\n---`);
          } catch {
            resolve(null);
          }
        },
      );
    });
  }
}
