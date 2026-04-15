/**
 * Home23 — Agent Harness Entry Point
 *
 * Wires the TypeScript channel/scheduler/sibling modules to the
 * COSMO engine via HTTP (dashboard API) and WebSocket (realtime events).
 *
 * Usage:
 *   HOME23_AGENT=test-agent node dist/home.js
 */

import { readFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { loadConfig } from './config.js';
import { CompactionManager } from './agent/compaction.js';
import { TelegramAdapter } from './channels/telegram.js';
import { DiscordAdapter } from './channels/discord.js';
import { IMessageAdapter } from './channels/imessage.js';
import { WebhookServer } from './channels/webhooks.js';
import { SessionRouter, type IncomingMessage, type OutgoingResponse, type ChannelAdapter } from './channels/router.js';
import { CronScheduler, type CronJob, type JobResult } from './scheduler/cron.js';
import { DeliveryManager } from './scheduler/delivery.js';
import { SiblingProtocol } from './sibling/protocol.js';
import { BridgeChat } from './sibling/bridge-chat.js';
import { AgentLoop } from './agent/loop.js';
import { ContextManager } from './agent/context.js';
import { ConversationHistory } from './agent/history.js';
import { createToolRegistry } from './agent/tools/index.js';
import type { ToolContext, SubAgentTracker } from './agent/types.js';
import { TTSService } from './observability/tts.js';
import { BrowserController } from './browser/cdp.js';
import type { HomeConfig } from './types.js';
import { CommandHandler, type CommandContext } from './commands/handler.js';
import { createEvobrewChatHandler, createHealthHandler, createStopHandler } from './routes/evobrew-bridge.js';
import {
  createTurnStartHandler,
  createTurnStreamHandler,
  createTurnStopHandler,
  createPendingTurnsHandler,
} from './routes/chat-turn.js';
import { EngineEventListener } from './engine-events.js';
import { DeviceRegistry } from './push/device-registry.js';
import { ApnsClient } from './push/apns-client.js';
import { ApnsPusher } from './push/apns-pusher.js';
import { createRegisterDeviceHandler, createUnregisterDeviceHandler, createListDevicesHandler } from './routes/device.js';
import { createChatHistoryHandler, createChatListHandler } from './routes/chat-history.js';
import { syncSharedSkillsRegistry } from './skills/runtime.js';

// ─── Constants ──────────────────────────────────────────────

const AGENT_NAME = process.env.HOME23_AGENT ?? 'test-agent';
const HOME23_ROOT = resolve(import.meta.dirname, '..');
const PROJECT_ROOT = HOME23_ROOT;
const INSTANCE_DIR = join(HOME23_ROOT, 'instances', AGENT_NAME);
const WORKSPACE_PATH = join(INSTANCE_DIR, 'workspace');
const BRAIN_DIR = join(INSTANCE_DIR, 'brain');
const CONVERSATIONS_DIR = join(INSTANCE_DIR, 'conversations');
const SESSIONS_DIR = join(CONVERSATIONS_DIR, 'sessions');
const LOGS_DIR = join(INSTANCE_DIR, 'logs');
const RUNTIME_DIR = CONVERSATIONS_DIR; // backwards compat for modules that use RUNTIME_DIR
const HOME_PORT = parseInt(process.env.HOME_PORT ?? '4610', 10);
const CACHE_DIAGNOSTICS_ENABLED = /^(1|true|yes|on)$/i.test(process.env.CACHE_DIAGNOSTICS ?? '');

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function serializePromptBlocks(prompt: string | Array<{ text: string }>): string {
  return typeof prompt === 'string'
    ? prompt
    : prompt.map(block => block.text).join('\n\n');
}

function writeCacheDiagnostic(runtimeDir: string, event: Record<string, unknown>): void {
  const diagnosticsDir = join(runtimeDir, 'cache-diagnostics');
  mkdirSync(diagnosticsDir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const path = join(diagnosticsDir, `${date}.jsonl`);
  appendFileSync(path, `${JSON.stringify(event)}\n`, 'utf-8');
}

// ─── Engine HTTP Client ─────────────────────────────────────

let ENGINE_BASE = 'http://localhost:5002'; // set after config load

async function queryEngine(
  text: string,
  mode: string = 'normal',
  opts?: { model?: string; timeoutMs?: number },
): Promise<{ answer: string; model?: string; durationMs: number }> {
  const url = `${ENGINE_BASE}/api/query`;
  const body = JSON.stringify({
    query: text,
    mode,
    backendOverride: 'openai',
    ...(opts?.model ? { model: opts.model } : {}),
  });

  const startMs = Date.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal: AbortSignal.timeout(opts?.timeoutMs ?? 120_000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Engine query failed: HTTP ${res.status} — ${errText}`);
  }

  const data = await res.json() as Record<string, unknown>;
  const answer = (data.answer ?? data.response ?? data.text ?? '') as string;
  const durationMs = Date.now() - startMs;

  console.log(`[engine] Query took ${durationMs}ms, answer length=${answer.length}, model=${data.model ?? 'unknown'}`);
  console.log(`[engine] Answer preview: "${answer.slice(0, 150)}"`);

  return { answer, model: data.model as string | undefined, durationMs };
}

// ─── Main ───────────────────────────────────────────────────

async function main(): Promise<void> {
  // ── Load config ──
  const config = loadConfig(AGENT_NAME);
  console.log(`[home] Config loaded for agent: ${AGENT_NAME}`);

  // ── Resolve ports and ENGINE_BASE from config ──
  const DASHBOARD_PORT = config.ports?.dashboard ?? 5002;
  const ENGINE_WS_PORT = config.ports?.engine ?? 5001;
  ENGINE_BASE = `http://localhost:${DASHBOARD_PORT}`;

  console.log('');
  console.log('═══════════════════════════════════════════════════');
  console.log(`  Home23 — ${config.agent?.displayName ?? AGENT_NAME}`);
  console.log('═══════════════════════════════════════════════════');
  console.log(`  Dashboard:    ${ENGINE_BASE}`);
  console.log(`  Engine WS:    ws://localhost:${ENGINE_WS_PORT}`);
  console.log(`  Instance:     ${INSTANCE_DIR}`);
  console.log('');

  // Ensure directories exist
  mkdirSync(CONVERSATIONS_DIR, { recursive: true });
  mkdirSync(SESSIONS_DIR, { recursive: true });

  const sharedSkillsRegistry = await syncSharedSkillsRegistry(PROJECT_ROOT).catch((err) => {
    console.warn(`[home] Shared skills registry sync failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  });
  if (sharedSkillsRegistry) {
    console.log('[home] Shared skills registry synced');
  }

  // ── Context Manager (identity + system prompt) ──
  const workspacePath = WORKSPACE_PATH;
  const bootPath = join(workspacePath, 'BOOT.md');
  const identityFiles = [...config.chat.identityFiles];
  if (existsSync(bootPath) && !identityFiles.includes('BOOT.md')) {
    identityFiles.push('BOOT.md');
    console.log('[home] BOOT.md detected — adding to startup identity load');
  }

  const contextManager = new ContextManager({
    workspacePath,
    identityFiles,
    identityLayers: config.chat.identityLayers,
    heartbeatRefreshMs: config.chat.heartbeatRefreshMs,
    enginePort: DASHBOARD_PORT,
    ownerName: config.agent?.owner?.name,
    ownerTelegramId: config.agent?.owner?.telegramId,
  });

  // ── Conversation History ──
  const history = new ConversationHistory(CONVERSATIONS_DIR, config.chat.historyBudget ?? 400_000, AGENT_NAME);

  // ── Tool Registry ──
  const registry = createToolRegistry();
  console.log(`[home] Tool registry: ${registry.size} tools`);

  // ── Temp dir for media ──
  const tempDir = join(RUNTIME_DIR, 'tmp');
  mkdirSync(tempDir, { recursive: true });

  // ── TTS Service (lazy) ──
  const ttsService = config.tts.enabled ? new TTSService(config.tts) : null;

  // ── Browser Controller (lazy) ──
  const browser = config.browser.enabled ? new BrowserController(config.browser) : null;

  // ── Sub-agent tracker ──
  const subAgentTracker: SubAgentTracker = { active: 0, maxConcurrent: config.agent?.maxSubAgents ?? 3, queue: [] };

  // Model aliases — loaded from config
  const MODEL_ALIASES: Record<string, { provider: string; model: string }> = config.models?.aliases ?? {};

  // ── Telegram adapter ref (captured during adapter creation) ──
  let telegramAdapterRef: TelegramAdapter | null = null;

  // ── Tool Context (pre-wired, agent loop + scheduler added below) ──
  const toolContext: ToolContext = {
    scheduler: null,
    ttsService,
    browser,
    projectRoot: PROJECT_ROOT,
    enginePort: DASHBOARD_PORT,
    workspacePath,
    tempDir,
    contextManager,
    subAgentTracker,
    chatId: '',
    telegramAdapter: null,   // wired after adapter creation
    runAgentLoop: null,       // wired after agent creation
  };

  // ── Model from config.yaml (single source of truth) ──
  const startupModel = config.chat.defaultModel ?? config.chat.model ?? 'kimi-k2.5';
  const startupProvider = config.chat.defaultProvider ?? config.chat.provider ?? 'ollama-cloud';
  console.log(`[home] Model: ${startupModel} (${startupProvider}) — from config.yaml`);

  // ── Auth tokens ──
  function resolveApiKey(provider: string): string {
    const providers = config.providers as Record<string, { apiKey?: string; baseUrl?: string }> | undefined;
    if (provider === 'anthropic') return providers?.anthropic?.apiKey ?? process.env.ANTHROPIC_AUTH_TOKEN ?? process.env.ANTHROPIC_API_KEY ?? '';
    if (provider === 'minimax') return providers?.minimax?.apiKey ?? process.env.MINIMAX_API_KEY ?? '';
    if (provider === 'openai') return providers?.openai?.apiKey ?? process.env.OPENAI_API_KEY ?? '';
    if (provider === 'xai') return providers?.xai?.apiKey ?? process.env.XAI_API_KEY ?? '';
    if (provider === 'ollama-cloud') return providers?.['ollama-cloud']?.apiKey ?? process.env.OLLAMA_CLOUD_API_KEY ?? '';
    return '';
  }
  function resolveBaseUrl(provider: string): string | undefined {
    const providers = config.providers as Record<string, { baseUrl?: string }> | undefined;
    return providers?.[provider]?.baseUrl;
  }
  const authToken = resolveApiKey(startupProvider);
  const anthropicToken = resolveApiKey('anthropic');
  const startupBaseURL = resolveBaseUrl(startupProvider);
  const compactionToken = anthropicToken || (startupProvider === 'minimax' ? authToken : '');
  const compactionBaseURL = !anthropicToken && startupProvider === 'minimax' ? startupBaseURL : undefined;
  console.log(`[home] Provider: ${startupProvider}, auth: ${authToken ? authToken.slice(0, 15) + '...' : 'MISSING'}`);

  // ── Agent Loop ──
  // Create Anthropic client for shared use (agent + compaction)
  const isOAuth = anthropicToken.startsWith('sk-ant-oat');
  const anthropicClient = isOAuth
    ? new (await import('@anthropic-ai/sdk')).default({
        authToken: compactionToken,
        ...(compactionBaseURL ? { baseURL: compactionBaseURL } : {}),
        defaultHeaders: {
          'anthropic-dangerous-direct-browser-access': 'true',
          'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,extended-cache-ttl-2025-04-11',
        },
        dangerouslyAllowBrowser: true,
      })
    : new (await import('@anthropic-ai/sdk')).default({
        apiKey: compactionToken || 'placeholder',
        ...(compactionBaseURL ? { baseURL: compactionBaseURL } : {}),
      });

  // ── Compaction Manager ──
  const compaction = new CompactionManager({
    client: anthropicClient,
    history,
    memory: null as unknown as import('./agent/memory.js').MemoryManager, // wired after agent creation
  });

  const agent = new AgentLoop({
    apiKey: authToken,
    baseURL: startupBaseURL,
    model: startupModel,
    provider: startupProvider,
    maxTokens: 8192,
    temperature: config.chat.temperature,
    registry,
    contextManager,
    history,
    toolContext,
    workspacePath,
    compaction,
    sessionGapMs: config.chat.sessionGapMs,
    cacheDiagnostics: CACHE_DIAGNOSTICS_ENABLED
      ? {
          enabled: true,
          runtimeDir: RUNTIME_DIR,
          logger: (event) => writeCacheDiagnostic(RUNTIME_DIR, event),
        }
      : undefined,
  });

  // Wire compaction's memory reference now that agent exists
  (compaction as unknown as { memory: import('./agent/memory.js').MemoryManager }).memory = agent.getMemory();

  // Wire sub-agent runner
  toolContext.runAgentLoop = async (_systemPrompt, userMessage, _tools, ctx) => {
    return agent.run(ctx.chatId, userMessage);
  };

  // ── Command Handler ──
  const commandCtx: CommandContext = {
    agent,
    history,
    contextManager,
    scheduler: null, // wired after scheduler creation
    toolContext,
    projectRoot: PROJECT_ROOT,
    enginePort: DASHBOARD_PORT,
    runtimeDir: RUNTIME_DIR,
    workspacePath,
    modelAliases: MODEL_ALIASES,
    compaction,
  };
  const commandHandler = new CommandHandler(commandCtx);

  if (CACHE_DIAGNOSTICS_ENABLED) {
    try {
      const promptSource = contextManager.getPromptSourceInfo();
      const systemPrompt = contextManager.getSystemPrompt();
      const toolNames = registry.getAnthropicTools().map(tool => tool.name);
      writeCacheDiagnostic(RUNTIME_DIR, {
        type: 'startup',
        timestamp: new Date().toISOString(),
        provider: startupProvider,
        model: startupModel,
        systemPromptHash: hashText(systemPrompt),
        systemPromptLength: systemPrompt.length,
        loadedIdentityFiles: promptSource.loadedFiles
          .filter(file => file.included)
          .map(file => ({ label: file.label, filePath: file.filePath })),
        toolNames,
        toolsHash: hashText(JSON.stringify(toolNames)),
      });
    } catch (err) {
      console.warn('[cache-diagnostics] Failed to write startup diagnostics:', err);
    }
  }

  // ── Message handler ──
  const messageHandler = async (message: IncomingMessage): Promise<OutgoingResponse> => {
    const text = message.text.trim();

    // Slash commands — handled pre-AgentLoop, no LLM.
    // This includes /stop, which fires instantly even while the agent is busy.
    const cmdResult = await commandHandler.handle(text, message.chatId, message.channel);
    if (cmdResult) return cmdResult;

    // Safety net: if somehow a message reaches here while agent is busy
    // (should not happen with queueDuringRun, but defensive)
    if (agent.isRunning(message.chatId)) {
      return {
        text: "I'm still working on something. Send /stop to interrupt me.",
        channel: message.channel,
        chatId: message.chatId,
      };
    }

    // Track active run so router holds incoming messages during processing
    const routerKey = `${message.channel}:${message.chatId}`;
    router.markRunActive(routerKey);

    try {
      const result = await agent.run(message.chatId, text, message.media);
      return {
        text: result.text,
        channel: message.channel,
        chatId: message.chatId,
        media: result.media,
      };
    } finally {
      router.markRunComplete(routerKey);
      // Process any messages that arrived during the run
      await router.drainPending(routerKey);
    }
  };

  // ── Create SessionRouter ──
  const router = new SessionRouter(config.sessions, messageHandler, SESSIONS_DIR);

  // ── Bound message handler for adapters ──
  const routerHandler = (msg: IncomingMessage): Promise<void> => router.handleMessage(msg);

  // ── Create channel adapters ──
  // Collected in a shared map so both the router and DeliveryManager
  // have access to the same adapter instances.
  const adapterMap = new Map<string, ChannelAdapter>();
  const enabledAdapters: string[] = [];

  if (config.channels?.telegram?.enabled) {
    const tc = config.channels.telegram;
    // Env var takes precedence — allows per-instance bot tokens via PM2 config
    const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN || tc.botToken;
    console.log(`[home] Telegram bot token: ${telegramBotToken.slice(0, 10)}... (env=${!!process.env.TELEGRAM_BOT_TOKEN}, config=${tc.botToken?.slice(0, 10)}...)`);
    const adapter = new TelegramAdapter(
      {
        botToken: telegramBotToken,
        streaming: tc.streaming as 'partial' | 'off',
        dmPolicy: tc.dmPolicy,
        groupPolicy: tc.groupPolicy,
        groups: tc.groups,
        ackReaction: tc.ackReaction,
      },
      routerHandler,
      RUNTIME_DIR,
    );
    router.registerAdapter(adapter);
    adapterMap.set(adapter.name, adapter);
    enabledAdapters.push('telegram');
    telegramAdapterRef = adapter;
    process.env.TELEGRAM_BOT_TOKEN = telegramBotToken;
  }

  // Wire telegram adapter into tool context now that it exists
  toolContext.telegramAdapter = telegramAdapterRef;

  if (config.channels?.discord?.enabled) {
    const dc = config.channels.discord;
    const adapter = new DiscordAdapter(
      {
        token: dc.token,
        streaming: dc.streaming,
        groupPolicy: dc.groupPolicy,
        guilds: dc.guilds,
        threadBindings: dc.threadBindings,
      },
      routerHandler,
    );
    router.registerAdapter(adapter);
    adapterMap.set(adapter.name, adapter);
    enabledAdapters.push('discord');
  }

  if (config.channels?.imessage?.enabled) {
    const ic = config.channels.imessage;
    const adapter = new IMessageAdapter(
      {
        cliPath: ic.cliPath,
        dmPolicy: ic.dmPolicy,
        groupPolicy: ic.groupPolicy,
      },
      routerHandler,
    );
    router.registerAdapter(adapter);
    adapterMap.set(adapter.name, adapter);
    enabledAdapters.push('imessage');
  }

  let webhookAdapter: InstanceType<typeof WebhookServer> | null = null;
  let webhookToken = '';
  if (config.channels?.webhooks?.enabled) {
    const wc = config.channels.webhooks;
    webhookToken = wc.token;
    const adapter = new WebhookServer(
      {
        port: wc.port ?? HOME_PORT,
        path: wc.path,
        token: wc.token,
        mappings: wc.mappings,
        sessionApi: {
          enabled: true,
          historyDir: SESSIONS_DIR,
          getBindings: () => router.getBindingsSnapshot(),
          getBindingByKey: (key: string) => router.getBindingByKey(key),
        },
      },
      routerHandler,
    );
    router.registerAdapter(adapter);
    adapterMap.set(adapter.name, adapter);
    enabledAdapters.push('webhook');
    webhookAdapter = adapter;
  }

  console.log(`[home] Adapters: ${enabledAdapters.length > 0 ? enabledAdapters.join(', ') : 'none'}`);

  // ── Sibling Protocol ──
  let sibling: SiblingProtocol | null = null;
  let bridgeChat: BridgeChat | null = null;

  if (config.sibling?.enabled) {
    const sc = config.sibling;
    sibling = new SiblingProtocol({
      localInstance: AGENT_NAME,
      remoteUrl: sc.remoteUrl,
      token: sc.token,
      rateLimits: sc.rateLimits,
      ackMode: sc.ackMode,
    });

    // When a sibling message arrives, route it through the engine
    // and send the response back to the sibling
    const siblingRef = sibling;
    sibling.onReceive(async (msg) => {
      console.log(`[home] Sibling message from ${msg.from}: ${msg.text.slice(0, 80)}...`);
      try {
        const result = await queryEngine(`[sibling:${msg.from}] ${msg.text}`, 'normal');
        await siblingRef.sendMessage(result.answer, AGENT_NAME);
      } catch (err) {
        console.error('[home] Failed to handle sibling message:', err);
      }
    });

    console.log('[home] Sibling protocol initialized');

    // ── Bridge Chat ──
    if (sc.bridgeChat.enabled) {
      const dbPath = resolve(PROJECT_ROOT, sc.bridgeChat.dbPath);
      bridgeChat = new BridgeChat({
        dbPath,
        telegramBotToken: sc.bridgeChat.telegramBotToken || undefined,
        telegramTargetId: sc.bridgeChat.telegramTargetId || undefined,
      });
      bridgeChat.init();
      console.log(`[home] Bridge chat initialized (${dbPath})`);
    }
  }

  // ── Delivery Manager & Cron Scheduler ──
  const delivery = new DeliveryManager(adapterMap);
  let scheduler: CronScheduler | null = null;

  if (config.scheduler) {
    const cronHandler = async (job: CronJob): Promise<JobResult> => {
      const startMs = Date.now();
      const cronChatId = `cron-${job.id}`;

      try {
        if (job.payload.kind === 'agentTurn') {
          // Full AgentLoop — 19 tools, isolated chat history per job
          const timeoutMs = (job.payload.timeoutSeconds ?? 300) * 1000;
          let timeoutId: ReturnType<typeof setTimeout>;
          const timeoutPromise = new Promise<never>((_, reject) => {
            timeoutId = setTimeout(() => {
              // Actually stop the agent — don't just stop waiting
              agent.stop(cronChatId);
              reject(new Error(`Cron agent timeout after ${timeoutMs}ms`));
            }, timeoutMs);
          });

          try {
            const agentPromise = agent.run(cronChatId, job.payload.message);
            const result = await Promise.race([agentPromise, timeoutPromise]);
            clearTimeout(timeoutId!);
            const durationMs = Date.now() - startMs;

            const jobResult: JobResult = { status: 'ok', response: result.text, durationMs };
            await delivery.deliver(job, jobResult);
            return jobResult;
          } catch (err) {
            clearTimeout(timeoutId!);
            throw err;
          }
        }

        if (job.payload.kind === 'exec') {
          // Direct shell execution — no LLM
          const timeoutMs = (job.payload.timeoutSeconds ?? 60) * 1000;
          const output = execSync(job.payload.command, {
            timeout: timeoutMs,
            encoding: 'utf-8',
            cwd: PROJECT_ROOT,
            env: { ...process.env },
          });
          const durationMs = Date.now() - startMs;

          const jobResult: JobResult = { status: 'ok', response: output.trim(), durationMs };
          await delivery.deliver(job, jobResult);
          return jobResult;
        }

        if (job.payload.kind === 'query') {
          // Lightweight brain query via engine API — no tools
          const timeoutMs = (job.payload.timeoutSeconds ?? 120) * 1000;
          const result = await queryEngine(job.payload.message, job.payload.mode ?? 'normal', {
            model: job.payload.model,
            timeoutMs,
          });
          const durationMs = Date.now() - startMs;

          const jobResult: JobResult = { status: 'ok', response: result.answer, durationMs };
          await delivery.deliver(job, jobResult);
          return jobResult;
        }

        if (job.payload.kind === 'systemEvent') {
          console.log(`[scheduler] System event: ${job.payload.text}`);
          const durationMs = Date.now() - startMs;
          return { status: 'ok', response: job.payload.text, durationMs };
        }

        const durationMs = Date.now() - startMs;
        return { status: 'error', error: 'Unknown payload kind', durationMs };
      } catch (err) {
        const durationMs = Date.now() - startMs;
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.error(`[scheduler] Job ${job.id} error:`, errorMsg);
        return { status: 'error', error: errorMsg, durationMs };
      }
    };

    scheduler = new CronScheduler(config.scheduler, cronHandler, RUNTIME_DIR);

    // Load external cron jobs from config dir if file exists
    const externalJobsPath = join(PROJECT_ROOT, 'config', 'cron-jobs.json');
    if (existsSync(externalJobsPath)) {
      try {
        const raw = readFileSync(externalJobsPath, 'utf-8');
        const externalJobs: CronJob[] = JSON.parse(raw);
        let added = 0;
        for (const job of externalJobs) {
          if (!scheduler.getJob(job.id)) {
            scheduler.addJob(job);
            added++;
          }
        }
        console.log(`[home] Loaded ${added} new cron job(s) from config/cron-jobs.json (${externalJobs.length} total in file)`);
      } catch (err) {
        console.error('[home] Failed to load external cron jobs:', err);
      }
    }

    console.log('[home] Scheduler initialized');
  }

  // Wire scheduler into tool context
  toolContext.scheduler = scheduler;

  // Wire scheduler into command context
  commandCtx.scheduler = scheduler;

  // ── Engine WebSocket Event Listener ──
  const engineEvents = new EngineEventListener(ENGINE_WS_PORT);
  engineEvents.start();

  // ── Start everything ──
  try {
    await router.startAll();
    console.log('[home] All adapters started');
  } catch (err) {
    console.error('[home] Failed to start adapters:', err);
  }

  if (scheduler) {
    scheduler.start();
    console.log('[home] Scheduler started');
  }

  // ── Push notifications (APNs) — optional ──
  const apnsConfig = config.apns;
  const deviceRegistryPath = join(process.env.COSMO_RUNTIME_DIR ?? process.cwd(), 'device-registry.json');
  const deviceRegistry = new DeviceRegistry(deviceRegistryPath);

  if (apnsConfig?.team_id && apnsConfig?.key_id && apnsConfig?.key_path && apnsConfig?.bundle_id) {
    try {
      const apnsClient = new ApnsClient({
        team_id: apnsConfig.team_id,
        key_id: apnsConfig.key_id,
        key_path: apnsConfig.key_path,
        bundle_id: apnsConfig.bundle_id,
        default_env: apnsConfig.default_env ?? 'production',
      });
      const pusher = new ApnsPusher(apnsClient, deviceRegistry, AGENT_NAME);
      agent.setPusher(pusher);
      console.log(`[home] APNs pusher installed — bundle=${apnsConfig.bundle_id}, env=${apnsConfig.default_env ?? 'production'}`);
    } catch (err) {
      console.warn('[home] APNs pusher init failed:', err instanceof Error ? err.message : err);
    }
  } else {
    console.log('[home] APNs pusher not configured — push disabled');
  }

  // ── Evobrew Bridge (standalone Express server) ──
  const BRIDGE_PORT = config.ports?.bridge ?? 5004;
  const bridgeToken = config.channels?.webhooks?.token ?? process.env.BRIDGE_TOKEN ?? '';
  const bridgeApp = (await import('express')).default();
  bridgeApp.use((await import('express')).default.json({ limit: '10mb' }));

  // CORS for evobrew
  bridgeApp.use((_req: any, res: any, next: any) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    if (_req.method === 'OPTIONS') { res.sendStatus(200); return; }
    next();
  });

  const bridgeConfig = {
    agent,
    token: bridgeToken,
    agentName: AGENT_NAME,
  };
  bridgeApp.post('/api/chat', createEvobrewChatHandler(bridgeConfig));
  bridgeApp.post('/api/stop', createStopHandler(bridgeConfig));
  bridgeApp.get('/health', createHealthHandler({ agentName: AGENT_NAME, agent }));

  // Resumable chat routes — turn-based protocol for backgrounding/reconnect
  const chatTurnConfig = {
    agentName: AGENT_NAME,
    agent,
    history,
    token: bridgeToken || undefined,
  };
  bridgeApp.post('/api/chat/turn', createTurnStartHandler(chatTurnConfig));
  bridgeApp.get('/api/chat/stream', createTurnStreamHandler(chatTurnConfig));
  bridgeApp.post('/api/chat/stop-turn', createTurnStopHandler(chatTurnConfig));
  bridgeApp.get('/api/chat/pending', createPendingTurnsHandler(chatTurnConfig));

  // Device registration routes (iOS push)
  const deviceConfig = { agentName: AGENT_NAME, registry: deviceRegistry, token: bridgeToken || undefined };
  bridgeApp.post('/api/device/register', createRegisterDeviceHandler(deviceConfig));
  bridgeApp.delete('/api/device/register', createUnregisterDeviceHandler(deviceConfig));
  bridgeApp.get('/api/device/registry', createListDevicesHandler(deviceConfig));

  // Chat history routes (iOS initial load + conversation list)
  const historyRouteConfig = { agentName: AGENT_NAME, history, token: bridgeToken || undefined };
  bridgeApp.get('/api/chat/history', createChatHistoryHandler(historyRouteConfig));
  bridgeApp.get('/api/chat/conversations', createChatListHandler(historyRouteConfig));

  bridgeApp.listen(BRIDGE_PORT, () => {
    console.log(`[home] Evobrew bridge listening on port ${BRIDGE_PORT} (/api/chat, /api/stop, /api/chat/turn, /api/chat/stream, /api/chat/pending, /api/chat/stop-turn, /api/chat/history, /api/chat/conversations, /api/device/register, /api/device/registry, /health)`);
  });

  // ── Startup banner ──
  console.log('');
  console.log('───────────────────────────────────────────────────');
  console.log(`  Home23 — ${config.agent?.displayName ?? AGENT_NAME} is LIVE`);
  console.log(`  Agent:     ${AGENT_NAME}`);
  console.log(`  Instance:  ${INSTANCE_DIR}`);
  console.log(`  Channels:  ${enabledAdapters.join(', ') || 'none'}`);
  console.log(`  Dashboard: ${ENGINE_BASE}`);
  console.log(`  Engine WS: ws://localhost:${ENGINE_WS_PORT}`);
  console.log(`  Bridge:    http://localhost:${BRIDGE_PORT}`);
  console.log(`  Cron:      ${scheduler ? `${scheduler.getJobs().length} job(s)` : 'disabled'}`);
  console.log(`  Tools:     ${registry.size}`);
  console.log(`  Model:     ${agent.getModel()} (${agent.getProvider()})`);
  console.log('───────────────────────────────────────────────────');
  console.log('');

  // ── Graceful shutdown ──
  let shutdownInProgress = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shutdownInProgress) return;
    shutdownInProgress = true;

    console.log(`\n[home] Received ${signal}, shutting down...`);

    engineEvents.stop();

    if (scheduler) {
      scheduler.stop();
    }

    try {
      await router.stopAll();
    } catch (err) {
      console.error('[home] Error stopping adapters:', err);
    }

    console.log('[home] Shutdown complete');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// ── Run ──

main().catch((err) => {
  console.error('[home] Fatal error:', err);
  process.exit(1);
});
