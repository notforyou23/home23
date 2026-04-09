/**
 * COSMO Home 2.3 — Telegram Slash Command Handler
 *
 * All slash commands are handled pre-AgentLoop — fast, no LLM roundtrip.
 * Returns OutgoingResponse for matched commands, null to fall through to AgentLoop.
 */

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, statSync, unlinkSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentLoop } from '../agent/loop.js';
import type { CompactionManager } from '../agent/compaction.js';
import type { ConversationHistory } from '../agent/history.js';
import type { ContextManager } from '../agent/context.js';
import type { CronScheduler } from '../scheduler/cron.js';
import type { ToolContext } from '../agent/types.js';
import type { OutgoingResponse } from '../channels/router.js';
import type { StoredMessage } from '../agent/history.js';

// ─── Types ───────────────────────────────────────────────────

export interface CommandContext {
  agent: AgentLoop;
  history: ConversationHistory;
  contextManager: ContextManager;
  scheduler: CronScheduler | null;
  toolContext: ToolContext;
  projectRoot: string;
  enginePort: number;
  runtimeDir: string;
  workspacePath: string;
  modelAliases: Record<string, { provider: string; model: string }>;
  compaction: CompactionManager | null;
}

// ─── Command Handler ─────────────────────────────────────────

export class CommandHandler {
  private ctx: CommandContext;

  constructor(ctx: CommandContext) {
    this.ctx = ctx;
  }

  /** Try to handle a slash command. Returns response or null to fall through. */
  async handle(text: string, chatId: string, channel: string): Promise<OutgoingResponse | null> {
    const trimmed = text.trim();
    if (!trimmed.startsWith('/')) return null;

    const spaceIdx = trimmed.indexOf(' ');
    const cmd = (spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)).toLowerCase();
    const arg = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();

    this.logCommand(chatId, channel, cmd, arg);

    const reply = (t: string): OutgoingResponse => ({ text: t, channel, chatId });

    switch (cmd) {
      case '/help':    return reply(this.cmdHelp());
      case '/reset':   return reply(this.cmdReset(chatId));
      case '/model':   return reply(this.cmdModel(arg));
      case '/query':   return arg ? reply(await this.cmdQuery(arg, 'normal')) : reply('Usage: /query <question>');
      case '/deep':    return arg ? reply(await this.cmdQuery(arg, 'deep')) : reply('Usage: /deep <question>');
      case '/status':  return reply(await this.cmdStatus());
      case '/compact': return reply(await this.cmdCompact(chatId));
      case '/refresh': return reply(this.cmdRefresh());
      case '/history': return reply(this.cmdHistory(chatId, arg));
      case '/prompt':  return reply(this.cmdPrompt());
      case '/cleanup': return reply(this.cmdCleanup());
      case '/extract': return reply(this.cmdExtract());
      case '/models':  return this.cmdModelsInteractive(channel, chatId);
      case '/restart': return reply('⚠️ /restart disabled. Use: pm2 restart cosmo23-coz (from shell)');
      case '/rebuild': return reply('⚠️ /rebuild disabled. Use: npm run build && pm2 restart cosmo23-coz (from shell)');
      case '/stop':    return reply(this.cmdStop(chatId, arg));
      default:         return null; // Not a recognized command — fall through to AgentLoop
    }
  }

  // ─── Command Implementations ─────────────────────────────

  private cmdHelp(): string {
    return [
      'Models:',
      '  /model <alias> — switch model',
      '  /models — list all available models',
      '',
      'Brain:',
      '  /query <q> — fast brain query',
      '  /deep <q> — deep brain query',
      '',
      'System:',
      '  /status — health snapshot',
      '  /stop — interrupt current run',
      '  /rebuild — build + restart',
      '  /restart — restart (no build)',
      '',
      'History:',
      '  /reset — clear conversation',
      '  /history [N] — last N messages',
      '  /compact — trim history to disk',
      '  /extract — run memory extraction',
      '',
      'Other:',
      '  /refresh — reload identity files',
      '  /prompt — show system prompt',
      '  /cleanup — remove old temp files',
    ].join('\n');
  }

  private cmdReset(chatId: string): string {
    this.captureSessionMemory(chatId);
    this.ctx.history.compact(chatId, []);
    return 'Conversation cleared.';
  }

  private logCommand(chatId: string, channel: string, command: string, arg: string): void {
    try {
      const logDir = join(this.ctx.runtimeDir, 'command-logs');
      mkdirSync(logDir, { recursive: true });
      const logPath = join(logDir, `${new Date().toISOString().split('T')[0]}.jsonl`);
      appendFileSync(logPath, `${JSON.stringify({ ts: new Date().toISOString(), chatId, channel, command, arg, instance: process.env.COSMO_INSTANCE ?? 'unknown' })}\n`, 'utf-8');
    } catch { /* non-fatal */ }
  }

  private captureSessionMemory(chatId: string): void {
    try {
      const records = this.ctx.history.load(chatId);
      const messages = records.filter((r): r is StoredMessage => !('type' in r && r.type === 'session_boundary'));
      if (messages.length === 0) return;

      const snapshotDir = join(this.ctx.workspacePath, 'memory', 'session-memory');
      mkdirSync(snapshotDir, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const snapshotPath = join(snapshotDir, `${ts}-${chatId.replace(/[^a-zA-Z0-9_-]/g, '_')}.md`);
      const transcript = messages.slice(-30).map(m => {
        const role = m.role === 'user' ? 'Human' : 'Assistant';
        const content = typeof m.content === 'string'
          ? m.content
          : Array.isArray(m.content)
            ? m.content.filter((b): b is { type: 'text'; text: string } => b.type === 'text' && 'text' in b).map(b => b.text).join(' ')
            : String(m.content);
        return `### ${role}\n${content}`;
      }).join('\n\n');
      writeFileSync(snapshotPath, `---\nchatId: ${chatId}\ntrigger: /reset\ndate: ${new Date().toISOString()}\n---\n\n# Session Memory Snapshot\n\n${transcript}\n`, 'utf-8');

      const model = this.ctx.agent.getModel();
      this.ctx.agent.getMemory().extractAndSave(chatId, messages, model).catch(() => {});
    } catch { /* non-fatal */ }
  }

  private cmdModel(arg: string): string {
    if (!arg) {
      const current = this.ctx.agent.getModel();
      const provider = this.ctx.agent.getProvider();
      return `${current} (${provider})\n/models for full list`;
    }

    // Check for "provider/model" syntax (from inline keyboard callbacks)
    if (arg.includes('/')) {
      const slashIdx = arg.indexOf('/');
      const provider = arg.slice(0, slashIdx);
      const model = arg.slice(slashIdx + 1);
      this.ctx.agent.setModel(model, provider);
      this.persistModel(model, provider);
      return `${model} (${provider})`;
    }

    // Check for "provider model" syntax (e.g., "/model ollama-cloud llama3:70b")
    const parts = arg.split(/\s+/);
    if (parts.length >= 2) {
      const [provider, ...modelParts] = parts;
      const model = modelParts.join(' ');
      this.ctx.agent.setModel(model, provider);
      this.persistModel(model, provider!);
      return `${model} (${provider})`;
    }

    const alias = this.ctx.modelAliases[arg.toLowerCase()];
    if (alias) {
      this.ctx.agent.setModel(alias.model, alias.provider);
      this.persistModel(alias.model, alias.provider);
      return `${alias.model} (${alias.provider})`;
    }

    // Unknown alias — set as-is
    this.ctx.agent.setModel(arg);
    return `${arg} (unknown provider)`;
  }

  /** Persist model choice so it survives restarts. */
  private persistModel(model: string, provider: string): void {
    try {
      const filePath = join(this.ctx.runtimeDir, 'default-model.json');
      writeFileSync(filePath, JSON.stringify({ model, provider }));
    } catch { /* non-fatal */ }
  }

  private async cmdModels(): Promise<string> {
    const current = this.ctx.agent.getModel();
    const lines: string[] = [];

    // Deduplicate: group by model, collect aliases
    const modelToAliases: Record<string, { provider: string; aliases: string[] }> = {};
    for (const [alias, info] of Object.entries(this.ctx.modelAliases)) {
      const key = `${info.provider}:${info.model}`;
      if (!modelToAliases[key]) {
        modelToAliases[key] = { provider: info.provider, aliases: [] };
      }
      modelToAliases[key].aliases.push(alias);
    }

    // Group by provider
    const byProvider: Record<string, Array<{ model: string; aliases: string[] }>> = {};
    for (const [key, val] of Object.entries(modelToAliases)) {
      const model = key.split(':').slice(1).join(':');
      (byProvider[val.provider] ??= []).push({ model, aliases: val.aliases });
    }

    // Render each provider
    const providerOrder = ['anthropic', 'openai', 'xai', 'ollama-cloud'];
    for (const p of providerOrder) {
      const entries = byProvider[p];
      if (!entries) continue;
      lines.push(`${p}:`);
      for (const e of entries) {
        const marker = e.model === current ? ' <<' : '';
        lines.push(`  ${e.aliases.join(', ')} → ${e.model}${marker}`);
      }
    }

    // Fetch live Ollama Cloud catalog
    const apiKey = process.env.OLLAMA_CLOUD_API_KEY;
    if (apiKey) {
      try {
        const res = await fetch('https://ollama.com/v1/models', {
          headers: { 'Authorization': `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(5_000),
        });
        if (res.ok) {
          const data = await res.json() as { data?: Array<{ id: string }> };
          const models = data.data ?? [];
          // Filter out models that already have aliases
          const aliasedModels = new Set(
            Object.values(this.ctx.modelAliases)
              .filter(a => a.provider === 'ollama-cloud')
              .map(a => a.model),
          );
          const extra = models.filter(m => !aliasedModels.has(m.id));
          if (extra.length > 0) {
            lines.push('', `ollama-cloud (more):`);
            for (const m of extra.slice(0, 15)) {
              const marker = m.id === current ? ' <<' : '';
              lines.push(`  /model ollama-cloud ${m.id}${marker}`);
            }
            if (extra.length > 15) lines.push(`  ...(${extra.length - 15} more)`);
          }
        }
      } catch { /* silent */ }
    }

    return lines.join('\n');
  }

  private async cmdQuery(question: string, mode: string): Promise<string> {
    const url = `http://localhost:${this.ctx.enginePort}/api/query`;
    const timeoutMs = mode === 'deep' ? 120_000 : 30_000;

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: question, mode, backendOverride: 'openai' }),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        return `Engine error: HTTP ${res.status} — ${errText.slice(0, 200)}`;
      }

      const data = await res.json() as Record<string, unknown>;
      const answer = (data.answer ?? data.response ?? data.text ?? '(no answer)') as string;
      return answer.slice(0, 4000);
    } catch (err) {
      return `Query failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  private async cmdStatus(): Promise<string> {
    const parts: string[] = ['⚡ Status:'];

    // Model
    parts.push(`Model: ${this.ctx.agent.getModel()}`);

    // Engine
    try {
      const res = await fetch(`http://localhost:${this.ctx.enginePort}/api/state`, {
        signal: AbortSignal.timeout(15000),
      });
      if (res.ok) {
        const data = await res.json() as Record<string, unknown>;
        const mem = data.memory as Record<string, unknown> | undefined;
        const nodes = Array.isArray(mem?.nodes) ? (mem!.nodes as unknown[]).length : '?';
        const edges = Array.isArray(mem?.edges) ? (mem!.edges as unknown[]).length : '?';
        const mode = (data.cognitiveState as Record<string, unknown>)?.mode ?? '?';
        parts.push(`Engine: online (${nodes} nodes, ${edges} edges, cycle ${data.cycleCount ?? '?'}, mode: ${mode})`);
      } else {
        parts.push(`Engine: error (HTTP ${res.status})`);
      }
    } catch {
      parts.push('Engine: offline');
    }

    // PM2
    try {
      const pm2Path = existsSync('/opt/homebrew/bin/pm2') ? '/opt/homebrew/bin/pm2' : 'pm2';
      const pm2Raw = execSync(`${pm2Path} jlist`, { timeout: 5000, encoding: 'utf-8' });
      const pm2List = JSON.parse(pm2Raw) as Array<{ name: string; pm2_env?: { status?: string } }>;
      const cosmoProcs = pm2List.filter(p => p.name.startsWith('cosmo23-'));
      const statuses = cosmoProcs.map(p => `${p.name}: ${p.pm2_env?.status ?? 'unknown'}`);
      parts.push(`PM2: ${statuses.join(', ')}`);
    } catch {
      parts.push('PM2: unavailable');
    }

    // Disk
    try {
      const df = execSync("df -h / | tail -1 | awk '{print $5}'", { timeout: 3000, encoding: 'utf-8' }).trim();
      parts.push(`Disk: ${df} used`);
    } catch {
      parts.push('Disk: unavailable');
    }

    // Scheduler
    if (this.ctx.scheduler) {
      const jobs = this.ctx.scheduler.getJobs();
      const enabled = jobs.filter(j => j.enabled);
      const nextJob = enabled.reduce((earliest, j) => {
        if (!earliest || j.state.nextRunAtMs < earliest.state.nextRunAtMs) return j;
        return earliest;
      }, null as typeof jobs[0] | null);
      const nextStr = nextJob ? `next: ${nextJob.name} at ${new Date(nextJob.state.nextRunAtMs).toLocaleTimeString()}` : 'none scheduled';
      parts.push(`Scheduler: ${enabled.length} jobs (${nextStr})`);
    }

    // Conversations
    try {
      const convDir = join(this.ctx.runtimeDir, 'conversations');
      if (existsSync(convDir)) {
        const files = readdirSync(convDir).filter(f => f.endsWith('.jsonl'));
        const totalSize = files.reduce((sum, f) => sum + statSync(join(convDir, f)).size, 0);
        parts.push(`Conversations: ${files.length} chats, ${(totalSize / 1024).toFixed(0)} KB`);
      }
    } catch { /* ignore */ }

    // Memory extraction
    try {
      const statePath = join(this.ctx.runtimeDir, 'memory-extraction-state.json');
      if (existsSync(statePath)) {
        const state = JSON.parse(readFileSync(statePath, 'utf-8'));
        parts.push(`Memory: ${state.stats?.total_sessions_extracted ?? 0} sessions extracted, ${state.stats?.total_facts_extracted ?? 0} facts`);
      }
    } catch { /* ignore */ }

    return parts.join('\n');
  }

  private async cmdCompact(chatId: string): Promise<string> {
    const records = this.ctx.history.load(chatId);

    if (this.ctx.compaction) {
      try {
        const { result } = await this.ctx.compaction.compact(chatId, records);
        if (!result.compacted) return `No compaction needed (${result.reason})`;
        const parts = [`Compacted: ${result.tokensBefore} → ${result.tokensAfter} chars`];
        if (result.extractedLearnings) parts.push('Learnings extracted to daily memory');
        if (result.summary) parts.push(`Summary: ${result.summary.slice(0, 100)}...`);
        return parts.join('\n');
      } catch (err) {
        return `Compaction failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    // Fallback: dumb truncation
    const truncated = this.ctx.history.truncate(records);
    this.ctx.history.compact(chatId, truncated);
    return `Compacted: ${records.length} → ${truncated.length} records`;
  }

  private cmdRefresh(): string {
    this.ctx.contextManager.invalidate();
    const prompt = this.ctx.contextManager.getSystemPrompt();
    return `Refreshed system prompt (${prompt.length} chars)`;
  }

  private cmdHistory(chatId: string, arg: string): string {
    const limit = parseInt(arg) || 5;
    const records = this.ctx.history.load(chatId);
    const messages = records.filter((r): r is StoredMessage => !('type' in r && r.type === 'session_boundary'));

    if (messages.length === 0) return 'No messages in history.';

    const last = messages.slice(-limit);
    return last.map(m => {
      const role = m.role.toUpperCase();
      const content = typeof m.content === 'string'
        ? m.content.slice(0, 200)
        : `[${Array.isArray(m.content) ? m.content.map(b => b.type).join(', ') : 'complex'}]`;
      const ts = m.ts ? ` (${new Date(m.ts).toLocaleTimeString()})` : '';
      return `${role}${ts}: ${content}${content.length >= 200 ? '...' : ''}`;
    }).join('\n---\n');
  }

  private cmdPrompt(): string {
    const prompt = this.ctx.contextManager.getSystemPrompt();
    const sourceInfo = this.ctx.contextManager.getPromptSourceInfo();
    const provenance = [
      '[PROMPT_SOURCE]',
      `Generated: ${sourceInfo.generatedAt}`,
      `Sections: ${sourceInfo.totalSections}`,
      ...sourceInfo.loadedFiles.map(file => {
        const status = file.included ? 'loaded' : (file.exists ? 'skipped' : 'missing');
        return `L${file.layerIndex + 1} ${file.label}: ${status} — ${file.filePath}`;
      }),
      '',
    ].join('\n');

    const combined = `${provenance}${prompt}`;
    if (combined.length <= 4000) return combined;
    return combined.slice(0, 4000) + `\n\n...(truncated, ${combined.length} chars total)`;
  }

  private cmdCleanup(): string {
    const tmpDir = join(this.ctx.runtimeDir, 'tmp');
    if (!existsSync(tmpDir)) return 'No temp directory found.';

    const maxAge = 7 * 24 * 60 * 60 * 1000; // 7 days
    const now = Date.now();
    const files = readdirSync(tmpDir);
    let removed = 0;

    for (const file of files) {
      try {
        const filePath = join(tmpDir, file);
        const stat = statSync(filePath);
        if (now - stat.mtimeMs > maxAge) {
          unlinkSync(filePath);
          removed++;
        }
      } catch { /* skip files that can't be removed */ }
    }

    return `Cleaned up ${removed} temp file(s) older than 7 days (${files.length - removed} remaining).`;
  }

  private cmdExtract(): string {
    if (!this.ctx.scheduler) return 'Scheduler not available.';

    const job = this.ctx.scheduler.getJob('session-summarizer');
    if (!job) return 'Session-summarizer job not found in scheduler.';
    if (job.payload.kind !== 'agentTurn') return 'Session-summarizer job has unexpected payload kind.';

    // Fire-and-forget — runs in background with isolated chat history
    const cronChatId = `cron-${job.id}`;
    this.ctx.agent.run(cronChatId, job.payload.message).catch(err => {
      console.error('[extract] Manual extraction failed:', err);
    });

    return 'Session extraction started (running in background).';
  }

  private cmdStop(chatId: string, arg: string): string {
    if (arg === 'all') {
      const { stopped, chatIds } = this.ctx.agent.stop();
      if (!stopped) return 'Nothing running.';
      return `Stopped ${chatIds.length} run(s): ${chatIds.join(', ')}`;
    }

    // Target a specific chatId if provided, otherwise stop this chat
    const targetId = arg || chatId;
    const { stopped } = this.ctx.agent.stop(targetId);
    if (!stopped) {
      // Show what IS running, if anything
      const active = this.ctx.agent.getActiveRuns();
      if (active.length === 0) return 'Nothing running.';
      return `Nothing running for this chat. Active runs: ${active.join(', ')}\nUse /stop all to stop everything.`;
    }
    return 'Stopping...';
  }

  private cmdRebuild(arg: string): string {
    const all = arg === 'all';
    const instance = process.env.COSMO_INSTANCE;
    if (!instance) {
      return 'Error: COSMO_INSTANCE not set. Cannot determine rebuild target.';
    }

    const target = all ? 'ecosystem.config.cjs' : (instance === 'coz' ? 'cosmo23-coz' : 'cosmo23-home');

    // Fire build + restart in background so the response reaches Telegram first
    setTimeout(() => {
      try {
        const pm2Path = existsSync('/opt/homebrew/bin/pm2') ? '/opt/homebrew/bin/pm2' : 'pm2';
        console.log('[rebuild] Running npm run build...');
        execSync('npm run build', {
          timeout: 120_000,
          cwd: this.ctx.projectRoot,
          shell: '/bin/bash',
          env: { ...process.env, PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin' }
        });
        console.log('[rebuild] Build complete, restarting...');
        execSync(`${pm2Path} restart ${target}`, {
          timeout: 30_000,
          cwd: this.ctx.projectRoot,
          shell: '/bin/bash',
          env: { ...process.env, PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin' }
        });
        console.log('[rebuild] Success');
      } catch (err) {
        console.error('[rebuild] Failed:', err instanceof Error ? err.message : String(err));
      }
    }, 1000);

    return all
      ? `Building + restarting all processes (${target})...`
      : `Building + restarting ${target}...`;
  }

  private cmdRestart(): string {
    const instance = process.env.COSMO_INSTANCE;
    if (!instance) {
      return 'Error: COSMO_INSTANCE not set. Cannot determine restart target.';
    }

    const target = instance === 'coz' ? 'cosmo23-coz' : 'cosmo23-home';

    // Schedule restart after 2 seconds so this response reaches Telegram
    setTimeout(() => {
      try {
        const pm2Path = existsSync('/opt/homebrew/bin/pm2') ? '/opt/homebrew/bin/pm2' : 'pm2';
        console.log(`[restart] Restarting ${target} via ${pm2Path}...`);
        execSync(`${pm2Path} restart ${target}`, {
          timeout: 30_000,
          cwd: this.ctx.projectRoot,
          shell: '/bin/bash',
          env: { ...process.env, PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin' }
        });
        console.log('[restart] Success');
      } catch (err) {
        console.error('[restart] Failed:', err instanceof Error ? err.message : String(err));
      }
    }, 2000);

    return `Restarting ${target} in 2 seconds...`;
  }

  private cmdModelsInteractive(channel: string, chatId: string): OutgoingResponse {
    const current = this.ctx.agent.getModel();
    const currentProvider = this.ctx.agent.getProvider();

    // Build model list grouped by provider
    const modelToInfo: Record<string, { provider: string; model: string; alias: string }> = {};
    for (const [alias, info] of Object.entries(this.ctx.modelAliases)) {
      const key = `${info.provider}/${info.model}`;
      if (!modelToInfo[key]) {
        modelToInfo[key] = { provider: info.provider, model: info.model, alias };
      }
    }

    // Group by provider, build buttons
    const byProvider: Record<string, Array<{ provider: string; model: string; alias: string; key: string }>> = {};
    for (const [key, val] of Object.entries(modelToInfo)) {
      (byProvider[val.provider] ??= []).push({ provider: val.provider, model: val.model, alias: val.alias, key });
    }

    const providerOrder = ['anthropic', 'openai-codex', 'openai', 'xai', 'ollama-cloud'];
    const rows: Array<Array<{ text: string; callback_data: string }>> = [];

    for (const p of providerOrder) {
      const entries = byProvider[p];
      if (!entries) continue;

      // Provider header row
      rows.push([{ text: `── ${p.toUpperCase()} ──`, callback_data: 'noop' }]);

      // Model buttons — 2 per row
      for (let i = 0; i < entries.length; i += 2) {
        const row: Array<{ text: string; callback_data: string }> = [];
        for (let j = i; j < Math.min(i + 2, entries.length); j++) {
          const e = entries[j]!;
          const isCurrent = e.model === current && e.provider === currentProvider;
          const label = isCurrent ? `${e.model} ✓` : e.model;
          row.push({ text: label, callback_data: `model:${e.key}` });
        }
        rows.push(row);
      }
    }

    return {
      text: `Current: ${current} (${currentProvider})\nTap to switch:`,
      channel,
      chatId,
      replyMarkup: { inline_keyboard: rows },
    };
  }
}
