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
import { execSync, exec } from 'node:child_process';
import { unprivilegedChildEnv } from './security/child-process-env.js';
import { promisify } from 'node:util';
import { setDefaultResultOrder } from 'node:dns';
import { createRequire } from 'node:module';

// Async exec for cron shell-jobs. execSync blocks the harness's main event
// loop for the entire duration of the script — Telegram polls timeout, SSE
// streams stall, /health stops responding. Each shell-cron firing was
// causing visible chat drops. Async exec runs in a worker subprocess and
// resolves via callback, leaving the event loop free.
const execAsync = promisify(exec);
setDefaultResultOrder('ipv4first');
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
import { anthropicOAuthStealthHeaders } from './agent/anthropic-headers.js';
import { resolveModelOverride } from './agent/model-resolution.js';
import { resolveProviderKey } from './agent/provider-credentials.js';
import { executeTrackedTurn } from './agent/turn-entrypoint.js';
import { ContextManager } from './agent/context.js';
import { ConversationHistory } from './agent/history.js';
import { createToolRegistry } from './agent/tools/index.js';
import { ACPBridge, normalizeBridgeConfig } from './acp/bridge.js';
import type { CodingJobRecord, CodingJobReceipt } from './acp/types.js';
import { WorkStore } from './work/work-store.js';
import { WorkRegistry } from './work/registry.js';
import { requestAsyncWorkCancel } from './work/cancel.js';
import { handleWorkCompletion, type CompletionDeps } from './work/completion.js';
import type { ReceiptSinks } from './work/receipt-delivery.js';
import type { AsyncWorkRecord } from './work/types.js';
import { createAsyncWorkRouter } from './routes/async-work.js';
import { AttentionGate, type OutboundSignal } from './agent/attention/attention-gate.js';
import type { ToolContext, SubAgentTracker } from './agent/types.js';
import { BrainOperationsClient } from './agent/brain-operations/client.js';
import {
  preserveCronBrainQueryDeliveryFailure,
  runCronBrainQueryJob,
} from './agent/cron-brain-query.js';
import { TTSService } from './observability/tts.js';
import { BrowserController } from './browser/cdp.js';
import type { HomeConfig } from './types.js';
import { CommandHandler, type CommandContext } from './commands/handler.js';
import {
  createEvobrewChatHandler,
  createHealthHandler,
  createStopHandler,
  startBridgeWithRecovery,
} from './routes/evobrew-bridge.js';
import { ShutdownGuard } from './shutdown-guard.js';
import {
  createTurnStartHandler,
  createModelsHandler,
  createTurnStreamHandler,
  createTurnStopHandler,
  createTurnStatusHandler,
  createPendingTurnsHandler,
} from './routes/chat-turn.js';
import { EngineEventListener } from './engine-events.js';
import { DeviceRegistry } from './push/device-registry.js';
import { ApnsClient } from './push/apns-client.js';
import { ApnsPusher } from './push/apns-pusher.js';
import {
  createListDevicesHandler,
  createQueryCredentialHandler,
  createQueryCredentialJsonParser,
  createRegisterDeviceHandler,
  createUnregisterDeviceHandler,
} from './routes/device.js';
import {
  createQueryNotificationJsonParser,
  createQueryTerminalNotificationHandler,
} from './routes/query-notifications.js';
import { createChatHistoryHandler, createChatListHandler } from './routes/chat-history.js';
import { resolveQueryNotebookBridgeToken } from './query-notebook-credential-config.js';
import { syncSharedSkillsRegistry } from './skills/runtime.js';
import { PromoterWorker } from './workers/promoter.js';
import { createWorkerRouter } from './workers/connector.js';
import {
  buildCronResultPacket,
  buildIncomingMessagePacket,
  buildOutgoingResponsePacket,
} from './agency/world-stream.js';
import {
  auditExistingRecurringCronJobsForAgency,
  mergeExternalCronJobPreservingAgency,
  reviewBoundRecurringCronJobsForAgency,
} from './agency/cron-bootcamp.js';

// ─── Constants ──────────────────────────────────────────────

const requireCjs = createRequire(import.meta.url);
const { assertPm2AgentIdentity } = requireCjs('../scripts/lib/pm2-agent-identity-guard.cjs');
const { createQueryNotebookCredentialAuthority } = requireCjs('../shared/query-notebook-credential.cjs');
assertPm2AgentIdentity();

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
    signal: AbortSignal.timeout(opts?.timeoutMs ?? 300_000),
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
    identityBudgets: config.chat.identityBudgets,
    heartbeatRefreshMs: config.chat.heartbeatRefreshMs,
    enginePort: DASHBOARD_PORT,
    ownerName: config.agent?.owner?.name,
    ownerTelegramId: config.agent?.owner?.telegramId,
  });

  // ── Conversation History ──
  const history = new ConversationHistory(CONVERSATIONS_DIR, config.chat.historyBudget ?? 400_000, AGENT_NAME);

  // ── Tool Registry ──
  const providersCfg = config.providers as Record<string, { apiKey?: string }> | undefined;
  const braveApiKey = providersCfg?.brave?.apiKey || process.env.BRAVE_API_KEY || process.env.BRAVE_SEARCH_API_KEY;
  const searxngUrl = (config.search as { searxngUrl?: string } | undefined)?.searxngUrl || process.env.SEARXNG_URL;
  const registry = createToolRegistry({ web: { braveApiKey, searxngUrl } });
  console.log(`[home] Tool registry: ${registry.size} tools (brave=${braveApiKey ? 'yes' : 'no'}, searxng=${searxngUrl || 'default'})`);

  // ── Temp dir for media ──
  const tempDir = join(RUNTIME_DIR, 'tmp');
  mkdirSync(tempDir, { recursive: true });

  let agencyKernelPromise: Promise<any> | null = null;
  const getAgencyKernel = async () => {
    if (!agencyKernelPromise) {
      agencyKernelPromise = (async () => {
        const mod = await import(resolve(PROJECT_ROOT, 'engine/src/agency/resident-kernel.js'));
        const agencyCfg = config.agency || { enabled: true, mode: 'live' };
        const charterPath = agencyCfg.charterPath
          ? resolve(PROJECT_ROOT, agencyCfg.charterPath)
          : resolve(PROJECT_ROOT, 'agency/charter.yaml');
        return new mod.AgencyKernel({
          brainDir: BRAIN_DIR,
          agentName: AGENT_NAME,
          charterPath,
          config: agencyCfg,
          logger: console,
        });
      })();
    }
    return agencyKernelPromise;
  };

  async function assimilateCronResult(job: CronJob, jobResult: JobResult): Promise<void> {
    if (config.agency?.enabled === false) return;
    try {
      const kernel = await getAgencyKernel();
      await kernel.intakeWorldStream(buildCronResultPacket(job, jobResult));
    } catch (err) {
      console.warn(`[agency] cron assimilation failed for ${job.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function assimilateIncomingMessage(message: IncomingMessage, text: string): Promise<void> {
    if (config.agency?.enabled === false) return;
    try {
      const kernel = await getAgencyKernel();
      await kernel.intakeWorldStream(buildIncomingMessagePacket(message, text));
    } catch (err) {
      console.warn(`[agency] inbound message assimilation failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function assimilateOutgoingResponse(message: IncomingMessage, response: OutgoingResponse): Promise<void> {
    if (config.agency?.enabled === false) return;
    try {
      const kernel = await getAgencyKernel();
      await kernel.intakeWorldStream(buildOutgoingResponsePacket(message, response));
    } catch (err) {
      console.warn(`[agency] outbound response assimilation failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── TTS Service (lazy) ──
  // If TTS is configured for a known provider but the apiKey is empty,
  // hydrate it from the corresponding providers.<name>.apiKey block.
  const ttsCfg = { ...config.tts };
  if (ttsCfg.enabled && !ttsCfg.apiKey && ttsCfg.provider) {
    const providers = config.providers as Record<string, { apiKey?: string }> | undefined;
    const key = providers?.[ttsCfg.provider]?.apiKey;
    if (key) ttsCfg.apiKey = key;
  }
  const ttsService = ttsCfg.enabled && ttsCfg.apiKey ? new TTSService(ttsCfg) : null;
  if (ttsCfg.enabled && !ttsService) {
    console.warn(`[home] TTS enabled but no apiKey resolved for provider=${ttsCfg.provider}`);
  } else if (ttsService) {
    console.log(`[home] TTS ready — provider=${ttsCfg.provider}, voice=${ttsCfg.voiceId}, auto=${ttsCfg.auto}`);
  }

  // ── Browser Controller (lazy) ──
  const browser = config.browser.enabled ? new BrowserController(config.browser) : null;

  // ── Sub-agent tracker ──
  const subAgentTracker: SubAgentTracker = { active: 0, maxConcurrent: config.agent?.maxSubAgents ?? 3, queue: [] };

  // Model aliases — loaded from config
  const MODEL_ALIASES: Record<string, { provider: string; model: string }> = config.models?.aliases ?? {};

  // ── Telegram adapter ref (captured during adapter creation) ──
  let telegramAdapterRef: TelegramAdapter | null = null;

  // Brain target resolution is fresh and requester-bound inside BrainOperationsClient.
  const agentName = process.env.HOME23_AGENT || 'unknown';
  const cosmo23Port = Number(process.env.COSMO23_PORT || 43210);
  const cosmo23BaseUrl = `http://localhost:${cosmo23Port}`;

  const brainOperations = new BrainOperationsClient({
    baseUrl: `http://127.0.0.1:${DASHBOARD_PORT}`,
    callerAgent: agentName,
  });

  // ── Tool Context (pre-wired, agent loop + scheduler added below) ──
  const toolContext: ToolContext = {
    scheduler: null,
    ttsService,
    browser,
    projectRoot: PROJECT_ROOT,
    enginePort: DASHBOARD_PORT,
    agentName,
    cosmo23BaseUrl,
    brainRoute: null,
    workspacePath,
    tempDir,
    contextManager,
    subAgentTracker,
    modelAliases: MODEL_ALIASES,
    chatId: '',
    telegramAdapter: null,   // wired after adapter creation
    runAgentLoop: null,       // wired after agent creation
    brainOperations,
    turnRuntime: null,
  };

  // ── Model from config.yaml (single source of truth; shared floor) ──
  const fleetDefaults = requireCjs('../shared/model-defaults.cjs') as { DEFAULT_CHAT_MODEL: string; DEFAULT_CHAT_PROVIDER: string };
  const startupModel = config.chat.defaultModel ?? config.chat.model ?? fleetDefaults.DEFAULT_CHAT_MODEL;
  const startupProvider = config.chat.defaultProvider ?? config.chat.provider ?? fleetDefaults.DEFAULT_CHAT_PROVIDER;
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
  // openai-codex resolves its OAuth token inside the codex client, not via
  // resolveApiKey — the banner must not print a false MISSING for it (that
  // false MISSING misdirected the 2026-08-09 outage investigation).
  const bannerAuth = authToken
    || (startupProvider === 'openai-codex'
      ? ((config.providers as Record<string, { apiKey?: string }> | undefined)?.['openai-codex']?.apiKey ?? '')
      : '');
  console.log(`[home] Provider: ${startupProvider}, auth: ${bannerAuth ? bannerAuth.slice(0, 15) + '...' : 'MISSING'}`);

  // ── Agent Loop ──
  // Anthropic client shared by compaction + the promoter worker. Read-at-use
  // (2026-08-11): the boot-frozen client here was the last E8 rotation gap —
  // the Proxy re-resolves the credential (mtime-cached, cheap) on access and
  // rebuilds the SDK client when the token rotated. An empty re-resolution
  // keeps the current client (never downgrade mid-flight to 'placeholder').
  const AnthropicSDK = (await import('@anthropic-ai/sdk')).default;
  const buildCompactionClient = (token: string, baseURL: string | undefined) =>
    token.startsWith('sk-ant-oat')
      ? new AnthropicSDK({
          authToken: token,
          ...(baseURL ? { baseURL } : {}),
          defaultHeaders: anthropicOAuthStealthHeaders(),
          dangerouslyAllowBrowser: true,
        })
      : new AnthropicSDK({
          apiKey: token || 'placeholder',
          ...(baseURL ? { baseURL } : {}),
        });
  const resolveCompactionCredential = (): { token: string; baseURL: string | undefined } => {
    const providersCfg = config.providers as Record<string, { apiKey?: string }> | undefined;
    const anth = resolveProviderKey('anthropic', providersCfg?.anthropic?.apiKey);
    if (anth) return { token: anth, baseURL: undefined };
    if (startupProvider === 'minimax') {
      const mm = resolveProviderKey('minimax', providersCfg?.minimax?.apiKey);
      if (mm) return { token: mm, baseURL: startupBaseURL };
    }
    return { token: '', baseURL: undefined };
  };
  let compactionCred = { token: compactionToken, baseURL: compactionBaseURL };
  let compactionClient = buildCompactionClient(compactionCred.token, compactionCred.baseURL);
  const anthropicClient = new Proxy(compactionClient, {
    get(_target, prop) {
      const fresh = resolveCompactionCredential();
      if (fresh.token !== '' && fresh.token !== compactionCred.token) {
        compactionCred = fresh;
        compactionClient = buildCompactionClient(fresh.token, fresh.baseURL);
        console.log('[home] compaction/promoter anthropic client rebuilt — credential rotated');
      }
      return Reflect.get(compactionClient, prop, compactionClient);
    },
  }) as InstanceType<typeof AnthropicSDK>;

  // ── Compaction Manager ──
  const compaction = new CompactionManager({
    client: anthropicClient,
    history,
    memory: null as unknown as import('./agent/memory.js').MemoryManager, // wired after agent creation
    provider: startupProvider,
    model: startupModel,
    apiKey: authToken,
    baseURL: startupBaseURL,
  });

  const agent = new AgentLoop({
    apiKey: authToken,
    baseURL: startupBaseURL,
    model: startupModel,
    provider: startupProvider,
    // Note: providerMap set via setProviderMap below, after construction.
    maxTokens: 8192,
    temperature: config.chat.temperature,
    registry,
    contextManager,
    history,
    toolContext,
    workspacePath,
    compaction,
    sessionGapMs: config.chat.sessionGapMs,
    situationalAwareness: config.situationalAwareness,
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
  toolContext.runAgentLoop = async (_systemPrompt, userMessage, _tools, ctx, options) => {
    return (await executeTrackedTurn(agent, ctx.chatId, userMessage, { modelOverride: options?.modelOverride })).response;
  };

  // Give AgentLoop the provider map so runtime setModel can rebuild the client
  // with the correct apiKey + baseURL when switching between anthropic-SDK providers.
  agent.setProviderMap({
    anthropic: { apiKey: resolveApiKey('anthropic'), baseURL: resolveBaseUrl('anthropic') },
    minimax: { apiKey: resolveApiKey('minimax'), baseURL: resolveBaseUrl('minimax') },
    openai: { apiKey: resolveApiKey('openai'), baseURL: resolveBaseUrl('openai') },
    'openai-codex': { apiKey: resolveApiKey('openai-codex'), baseURL: resolveBaseUrl('openai-codex') },
    xai: { apiKey: resolveApiKey('xai'), baseURL: resolveBaseUrl('xai') },
    'ollama-cloud': { apiKey: resolveApiKey('ollama-cloud'), baseURL: resolveBaseUrl('ollama-cloud') },
  });

  const CHAT_TURN_ORPHAN_MAX_AGE_MS = 10 * 60 * 1000;
  const CHAT_TURN_ORPHAN_SWEEP_MS = 60 * 1000;
  const logRecoveredTurns = (source: string, recovered: Array<{ chatId: string; turnId: string }>): void => {
    if (recovered.length === 0) return;
    const sample = recovered.slice(0, 5).map(t => `${t.chatId}/${t.turnId}`).join(', ');
    const suffix = recovered.length > 5 ? `, +${recovered.length - 5} more` : '';
    console.warn(`[chat-turn] ${source} recovered ${recovered.length} stale pending turn(s): ${sample}${suffix}`);
  };
  logRecoveredTurns('startup', agent.recoverStaleTurns(CHAT_TURN_ORPHAN_MAX_AGE_MS));
  const chatTurnRecoveryInterval = setInterval(() => {
    logRecoveredTurns('janitor', agent.recoverStaleTurns(CHAT_TURN_ORPHAN_MAX_AGE_MS));
  }, CHAT_TURN_ORPHAN_SWEEP_MS);
  chatTurnRecoveryInterval.unref?.();

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
    await assimilateIncomingMessage(message, text);

    // Slash commands — handled pre-AgentLoop, no LLM.
    // This includes /stop, which fires instantly even while the agent is busy.
    const cmdResult = await commandHandler.handle(text, message.chatId, message.channel);
    if (cmdResult) {
      await assimilateOutgoingResponse(message, cmdResult);
      return cmdResult;
    }

    // Safety net: if somehow a message reaches here while agent is busy
    // (should not happen with queueDuringRun, but defensive)
    if (agent.isRunning(message.chatId)) {
      const busyResponse = {
        text: "I'm still working on something. Send /stop to interrupt me.",
        channel: message.channel,
        chatId: message.chatId,
      };
      await assimilateOutgoingResponse(message, busyResponse);
      return busyResponse;
    }

    // Track active run so router holds incoming messages during processing
    const routerKey = `${message.channel}:${message.chatId}`;
    router.markRunActive(routerKey);

    try {
      const { response: result } = await executeTrackedTurn(
        agent,
        message.chatId,
        text,
        { media: message.media },
      );
      const response = {
        text: result.text,
        channel: message.channel,
        chatId: message.chatId,
        media: result.media,
      };
      await assimilateOutgoingResponse(message, response);
      return response;
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
    // Per-agent config is authoritative — env is only a last-resort fallback.
    // (Env-first precedence caused a cross-agent token leak on 2026-04-18 when
    // pm2 child processes inherited a TELEGRAM_BOT_TOKEN from a polluted shell.)
    const telegramBotToken = tc.botToken || process.env.TELEGRAM_BOT_TOKEN;
    if (!telegramBotToken) {
      throw new Error('[home] Telegram enabled but no botToken found in config or TELEGRAM_BOT_TOKEN env');
    }
    console.log(`[home] Telegram bot token: ${telegramBotToken.slice(0, 10)}... (config=${tc.botToken?.slice(0, 10)}..., env=${!!process.env.TELEGRAM_BOT_TOKEN})`);
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

  // ── Attention gate (Step 30) — notice broadly, interrupt narrowly on
  // autonomous, resident-originated outbound. Shared across the scheduler
  // delivery path and the /api/notify escalation path. User replies never
  // touch it (they flow through the channel router, not these paths).
  const attentionCfg = config.attention ?? {};
  const attentionGate = attentionCfg.enabled === false
    ? null
    : new AttentionGate({
        dedupeWindowMs: attentionCfg.dedupeWindowMs,
        aggregateFlushCount: attentionCfg.aggregateFlushCount,
        aggregateFlushMs: attentionCfg.aggregateFlushMs,
      });

  // ── Delivery Manager & Cron Scheduler ──
  const delivery = new DeliveryManager(adapterMap, config.deliveryProfiles ?? {}, attentionGate);
  let scheduler: CronScheduler | null = null;

  if (config.scheduler) {
    const cronHandler = async (job: CronJob): Promise<JobResult> => {
      const startMs = Date.now();
      const cronChatId = `cron-${job.id}`;

      try {
        if (job.payload.kind === 'agentTurn') {
          // Full AgentLoop — 19 tools, isolated chat history per job
          const timeoutMs = (job.payload.timeoutSeconds ?? 21_600) * 1000;

          // Resolve message: prefer messagePath if set (and readable), else inline message.
          let resolvedMessage = job.payload.message ?? '';
          if (job.payload.messagePath) {
            const abs = job.payload.messagePath.startsWith('/')
              ? job.payload.messagePath
              : resolve(PROJECT_ROOT, job.payload.messagePath);
            try {
              resolvedMessage = readFileSync(abs, 'utf-8');
            } catch (err) {
              const errMsg = err instanceof Error ? err.message : String(err);
              const durationMs = Date.now() - startMs;
              return {
                status: 'error',
                error: `Cannot read messagePath "${job.payload.messagePath}": ${errMsg}`,
                durationMs,
              };
            }
          }
          if (!resolvedMessage.trim()) {
            const durationMs = Date.now() - startMs;
            return { status: 'error', error: 'agentTurn payload has neither message nor readable messagePath', durationMs };
          }

          if (job.payload.sessionHistory === 'fresh') {
            agent.getHistory().rotate(cronChatId);
          }
          // payload.model was declared on agentTurn jobs and silently ignored
          // (2026-08-11 audit D5 — only `query` jobs honored it). It now
          // routes the turn; an unresolvable model fails the job loudly
          // instead of running on the wrong brain.
          let cronModelOverride: { model: string; provider?: string } | undefined;
          if (job.payload.model) {
            const resolved = resolveModelOverride(job.payload.model, MODEL_ALIASES);
            if (!resolved) {
              const durationMs = Date.now() - startMs;
              return { status: 'error', error: `agentTurn model "${job.payload.model}" is not a known alias or routable model`, durationMs };
            }
            cronModelOverride = resolved;
          }
          const { response: result } = await executeTrackedTurn(
            agent,
            cronChatId,
            resolvedMessage,
            { hardDurationMs: timeoutMs, ...(cronModelOverride ? { modelOverride: cronModelOverride } : {}) },
          );
          const durationMs = Date.now() - startMs;

          const jobResult: JobResult = { status: 'ok', response: result.text, durationMs };
          delivery.lastDeliveryError = null;
          await delivery.deliver(job, jobResult);
          if (delivery.lastDeliveryError) {
            jobResult.status = 'error';
            jobResult.error = `Delivery failed: ${delivery.lastDeliveryError}`;
          }
          await assimilateCronResult(job, jobResult);
          return jobResult;
        }

        if (job.payload.kind === 'exec') {
          const timeoutMs = (job.payload.timeoutSeconds ?? 60) * 1000;
          const execCwd = (job.payload as Record<string, unknown>).cwd as string | undefined;
          const { stdout } = await execAsync(job.payload.command, {
            timeout: timeoutMs,
            encoding: 'utf-8',
            cwd: execCwd || PROJECT_ROOT,
            env: unprivilegedChildEnv(),
            maxBuffer: 10 * 1024 * 1024,
          });
          const durationMs = Date.now() - startMs;

          const jobResult: JobResult = { status: 'ok', response: stdout.trim(), durationMs };
          delivery.lastDeliveryError = null;
          await delivery.deliver(job, jobResult);
          if (delivery.lastDeliveryError) {
            jobResult.status = 'error';
            jobResult.error = `Delivery failed: ${delivery.lastDeliveryError}`;
          }
          await assimilateCronResult(job, jobResult);
          return jobResult;
        }

        if (job.payload.kind === 'query') {
          const outcome = await runCronBrainQueryJob(
            brainOperations,
            job.payload,
            MODEL_ALIASES,
          );
          const durationMs = Date.now() - startMs;

          const jobResult: JobResult = {
            ...outcome,
            durationMs,
          };
          delivery.lastDeliveryError = null;
          await delivery.deliver(job, jobResult);
          if (delivery.lastDeliveryError) {
            const deliveryFailure = preserveCronBrainQueryDeliveryFailure(
              outcome,
              delivery.lastDeliveryError,
            );
            jobResult.status = deliveryFailure.status;
            jobResult.error = deliveryFailure.error;
            jobResult.semanticStatus = deliveryFailure.semanticStatus;
          }
          await assimilateCronResult(job, jobResult);
          return jobResult;
        }

        if (job.payload.kind === 'systemEvent') {
          console.log(`[scheduler] System event: ${job.payload.text}`);
          const durationMs = Date.now() - startMs;
          const jobResult: JobResult = { status: 'ok', response: job.payload.text, durationMs };
          await assimilateCronResult(job, jobResult);
          return jobResult;
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
        let updated = 0;
        for (const job of externalJobs) {
          const existing = scheduler.getJob(job.id);
          if (!existing) {
            scheduler.addJob(job);
            added++;
          } else {
            scheduler.saveJob(mergeExternalCronJobPreservingAgency(existing, job));
            updated++;
          }
        }
        console.log(`[home] Loaded ${added} new and updated ${updated} cron job(s) from config/cron-jobs.json (${externalJobs.length} total in file)`);
      } catch (err) {
        console.error('[home] Failed to load external cron jobs:', err);
      }
    }

    const bootcampScheduler = scheduler;
    const runCronBootcampAudit = async (activeScheduler: CronScheduler): Promise<void> => {
      if (config.agency?.enabled === false) return;
      try {
        const kernel = await getAgencyKernel();
        const audit = await auditExistingRecurringCronJobsForAgency({ scheduler: activeScheduler, kernel });
        const review = await reviewBoundRecurringCronJobsForAgency({ scheduler: activeScheduler, kernel });
        if (audit.bound > 0 || audit.failed.length > 0) {
          console.log(`[agency] Cron bootcamp audit: checked=${audit.checked} bound=${audit.bound} alreadyBound=${audit.skippedAlreadyBound} failed=${audit.failed.length}`);
        }
        if (review.retired > 0 || review.proposed > 0 || review.failed.length > 0) {
          console.log(`[agency] Cron bootcamp review: checked=${review.checked} retired=${review.retired} proposed=${review.proposed} kept=${review.kept} failed=${review.failed.length}`);
        }
      } catch (err) {
        console.warn(`[agency] Cron bootcamp audit failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    };

    if (config.agency?.enabled !== false && config.agency?.cronBootcamp?.startupAudit === true) {
      const bootcampTimer = setTimeout(() => {
        void runCronBootcampAudit(bootcampScheduler);
      }, 30_000);
      bootcampTimer.unref?.();
      console.log('[agency] Cron bootcamp audit scheduled after startup');
    } else {
      console.log('[agency] Cron bootcamp startup audit disabled');
    }

    console.log('[home] Scheduler initialized');
  }

  // Wire scheduler into tool context
  toolContext.scheduler = scheduler;

  // Wire scheduler into command context
  commandCtx.scheduler = scheduler;

  // ── Async work registry (Step 31) ──
  // One durable contract for detached work: coding jobs + sub-agents. Records
  // live under instances/<agent>/async-work/; delivery routes on the ROOT
  // origin conversation via the completion pipeline.
  const workStore = new WorkStore(join(INSTANCE_DIR, 'async-work'));
  const workRegistry = new WorkRegistry({ store: workStore, agent: AGENT_NAME });
  toolContext.workRegistry = workRegistry;

  const asyncWorkRaw = (config as { asyncWork?: { review?: { coding?: boolean; subagent?: boolean }; reviewIdleTimeoutMs?: number } }).asyncWork ?? {};
  const workReview = {
    coding: asyncWorkRaw.review?.coding ?? true,
    subagent: asyncWorkRaw.review?.subagent ?? false,
  };

  // Sinks are built per delivery, so an unconfigured token / not-yet-installed
  // APNs pusher (e.g. during recovery before setPusher) degrades to
  // history-only with no throw.
  const buildWorkSinks = (): ReceiptSinks => {
    const sinks: ReceiptSinks = {
      appendHistory: (chatId, text) => {
        try {
          history.append(chatId, [{ role: 'assistant', content: text, ts: new Date().toISOString() }]);
        } catch (err) {
          console.warn(`[work] history delivery failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    };
    if (process.env.TELEGRAM_BOT_TOKEN) {
      sinks.sendTelegram = (chatId, text) => {
        fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text }),
        }).catch((err) => console.warn(`[work] Telegram delivery failed: ${err instanceof Error ? err.message : String(err)}`));
      };
    }
    const pusher = agent.getPusher();
    if (pusher) {
      sinks.pushWork = (input) => {
        pusher.notifyAsyncWork({ chatId: input.chatId, workId: input.workId, status: input.status, body: input.body })
          .catch((err) => console.warn(`[work] iOS push failed: ${err instanceof Error ? err.message : String(err)}`));
      };
    }
    return sinks;
  };

  const completionDeps = (): CompletionDeps => ({
    registry: workRegistry,
    sinks: buildWorkSinks(),
    review: workReview,
    isChatBusy: (chatId) => agent.isRunning(chatId),
    waitForIdleMs: asyncWorkRaw.reviewIdleTimeoutMs ?? 120_000,
    idlePollMs: 10_000,
    runReviewTurn: async (chatId, prompt) =>
      (await executeTrackedTurn(agent, chatId, prompt, { inactivityMs: 5 * 60_000 })).response.text,
  });

  const codingReceiptText = (work: AsyncWorkRecord, job: CodingJobRecord, receipt: CodingJobReceipt | undefined): string => {
    const tail = receipt?.resultTail ? `\n\n${receipt.resultTail.slice(0, 1500)}` : '';
    return `[Async work ${work.status}] ${work.label}${tail}\n(work ${work.workId}; job ${job.id}; coding_result for full output)`;
  };

  toolContext.onWorkTerminal = (workId, resultText) => {
    const work = workRegistry.get(workId);
    if (!work) return;
    void handleWorkCompletion(work, resultText, completionDeps());
  };

  // ── Coding-backend bridge (Step 29) ──
  // Durable coding jobs delegated to headless Claude Code / Codex CLIs.
  // Result delivery flows through the async-work completion pipeline (Step 31).
  let codingBridge: ACPBridge | null = null;
  const acpConfig = normalizeBridgeConfig((config as { acp?: unknown }).acp);
  if (acpConfig.enabled) {
    codingBridge = new ACPBridge({
      config: acpConfig,
      jobsDir: join(INSTANCE_DIR, 'coding-jobs'),
      projectRoot: PROJECT_ROOT,
    });
    toolContext.codingBridge = codingBridge;
    codingBridge.addListener((event) => {
      if (event.type === 'job_started') {
        console.log(`[coding] job ${event.job.id} started (${event.job.backend}) in ${event.job.cwd}`);
        return;
      }
      if (event.type === 'job_event') {
        // Throttled progress note on the work record (meaningful milestones,
        // not tool-call confetti — the registry writes at most every 15s).
        const work = workRegistry.findByJobId(event.jobId);
        if (work) {
          const e = event.event;
          const note = e.kind === 'tool_use' ? `tool: ${e.tool}` : e.kind;
          workRegistry.noteProgress(work.workId, note);
        }
        return;
      }
      // job_finished — terminal transition + delivery via the completion
      // pipeline. The work record's originChatId is the ROOT conversation
      // (resolved at creation), so results from subagent-launched jobs reach
      // the real owner instead of the hidden sub-chat. Jobs started before
      // Step 31 (no work record) get one backfilled here from requestedBy.
      const { job, receipt } = event;
      console.log(`[coding] job ${job.id} ${job.status} (${job.backend}, ${Math.round(receipt.durationMs / 1000)}s)`);
      const work = workRegistry.findByJobId(job.id)
        ?? workRegistry.create({
          kind: 'coding',
          originChatId: job.requestedBy ?? 'unknown',
          label: job.label ?? job.prompt.slice(0, 100),
          resultHandle: { type: 'coding_job', jobId: job.id },
        });
      const done = workRegistry.complete(work.workId, job.status as AsyncWorkRecord['status'], job.error);
      void handleWorkCompletion(done, codingReceiptText(done, job, receipt), completionDeps());
    });
    try {
      const recovered = await codingBridge.recover();
      console.log(`[coding] bridge recovery: ${recovered.resumed.length} resumed, ${recovered.finalized.length} finalized`);
    } catch (err) {
      console.warn(`[coding] bridge recovery failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  toolContext.requestWorkCancel = (workId) => requestAsyncWorkCancel({
    registry: workRegistry,
    cancelCodingJob: async (jobId) => {
      if (codingBridge) await codingBridge.cancelJob(jobId);
    },
    stopChat: (chatId) => agent.stop(chatId).stopped,
  }, workId);

  // ── Async-work boot reconciliation (Step 31) ──
  // Runs even when the coding bridge is disabled so lost sub-agents are still
  // marked interrupted. Lost sub-agents → interrupted + notice; jobs that
  // finished while the harness was down → deliver their receipts now; running
  // jobs without records → backfill.
  try {
    const reconciled = workRegistry.reconcileOnBoot({ jobs: codingBridge?.listJobs() ?? [] });
    if (reconciled.interrupted.length || reconciled.backfilled.length || reconciled.needsDelivery.length) {
      console.log(`[work] boot reconcile: ${reconciled.interrupted.length} interrupted, ${reconciled.backfilled.length} backfilled, ${reconciled.needsDelivery.length} to deliver`);
    }
    for (const work of reconciled.needsDelivery) {
      let text = `[Async work ${work.status}] ${work.label}\n(work ${work.workId})`;
      if (work.resultHandle.type === 'coding_job' && codingBridge) {
        const job = codingBridge.getJob(work.resultHandle.jobId);
        const receipt = codingBridge.getReceipt(work.resultHandle.jobId);
        if (job) text = codingReceiptText(work, job, receipt);
      }
      if (work.status === 'interrupted') {
        text = `[Async work interrupted] ${work.label} — the harness restarted while this was running.` +
          (work.resultHandle.type === 'coding_job' ? ` Job ${work.resultHandle.jobId} may be resumable via coding_continue.` : '') +
          `\n(work ${work.workId})`;
      }
      void handleWorkCompletion(work, text, completionDeps());
    }
  } catch (err) {
    console.warn(`[work] boot reconcile failed: ${err instanceof Error ? err.message : String(err)}`);
  }

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

  // ── Promoter worker ──
  // Drains cognition's NOTIFY stream into live-problems via LLM classification
  // + verifier dry-run. Unverified concerns get empirically tested before they
  // become tracked problems; vague/subjective ones get dropped. See
  // src/workers/promoter.ts for the full contract.
  try {
    // Classification uses a fixed small model regardless of the agent's chat
    // default. Reason: we need well-behaved structured JSON output; haiku is
    // reliable and cheap. anthropicClient is already configured for Anthropic
    // (OAuth or API key), so this always resolves correctly.
    const promoter = new PromoterWorker({
      brainDir: BRAIN_DIR,
      dashboardBaseUrl: ENGINE_BASE,
      client: anthropicClient,
      model: 'claude-haiku-4-5',
      logger: {
        info: (m) => console.log(m),
        warn: (m) => console.warn(m),
        error: (m) => console.error(m),
      },
    });
    promoter.start();
    console.log('[home] Promoter worker started');
  } catch (err) {
    console.warn('[home] Promoter worker start failed:', err instanceof Error ? err.message : String(err));
  }

  // ── Push notifications (APNs) — optional ──
  const apnsConfig = config.apns;
  const deviceRegistryPath = join(process.env.COSMO_RUNTIME_DIR ?? process.cwd(), 'device-registry.json');
  const deviceRegistry = new DeviceRegistry(deviceRegistryPath);
  let apnsPusher: ApnsPusher | undefined;

  if (apnsConfig?.team_id && apnsConfig?.key_id && apnsConfig?.key_path && apnsConfig?.bundle_id) {
    try {
      const apnsClient = new ApnsClient({
        team_id: apnsConfig.team_id,
        key_id: apnsConfig.key_id,
        key_path: apnsConfig.key_path,
        bundle_id: apnsConfig.bundle_id,
        default_env: apnsConfig.default_env ?? 'production',
      });
      apnsPusher = new ApnsPusher(apnsClient, deviceRegistry, AGENT_NAME);
      agent.setPusher(apnsPusher);
      console.log(`[home] APNs pusher installed — bundle=${apnsConfig.bundle_id}, env=${apnsConfig.default_env ?? 'production'}`);
    } catch (err) {
      console.warn('[home] APNs pusher init failed:', err instanceof Error ? err.message : err);
    }
  } else {
    console.log('[home] APNs pusher not configured — push disabled');
  }

  // ── Evobrew Bridge (standalone Express server) ──
  const BRIDGE_PORT = config.ports?.bridge ?? 5004;
  const bridgeToken = resolveQueryNotebookBridgeToken(config, process.env);
  let queryCredentialAuthority;
  try {
    queryCredentialAuthority = bridgeToken
      ? createQueryNotebookCredentialAuthority({
        bridgeToken,
        requesterAgent: AGENT_NAME,
      })
      : undefined;
  } catch {
    console.warn('[home] Query notebook credential enrollment unavailable: bridge token configuration is invalid');
  }
  const express = (await import('express')).default;
  const bridgeApp = express();
  const deviceConfig = {
    agentName: AGENT_NAME,
    registry: deviceRegistry,
    token: bridgeToken || undefined,
    queryCredentialAuthority,
  };

  // CORS for evobrew
  bridgeApp.use((_req: any, res: any, next: any) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    if (_req.method === 'OPTIONS') { res.sendStatus(200); return; }
    next();
  });

  // Query credential exchange stays small even though Chat accepts large media payloads.
  bridgeApp.post(
    '/api/device/query-credential',
    createQueryCredentialJsonParser(),
    createQueryCredentialHandler(deviceConfig),
  );
  bridgeApp.post(
    '/api/query-notifications/terminal',
    createQueryNotificationJsonParser(),
    createQueryTerminalNotificationHandler({
      agentName: AGENT_NAME,
      bridgeToken: bridgeToken || undefined,
      pusher: apnsPusher,
    }),
  );
  bridgeApp.use(express.json({ limit: '90mb' }));

  const bridgeConfig = {
    agent,
    token: bridgeToken,
    agentName: AGENT_NAME,
  };
  bridgeApp.use(createWorkerRouter({
    projectRoot: PROJECT_ROOT,
    ctx: toolContext
  }));

  // Async-work surface (Step 31): durable list/status/receipt/cancel for
  // coding jobs + sub-agents, consumed by the iOS/Mac apps.
  bridgeApp.use('/api/work', createAsyncWorkRouter({
    registry: workRegistry,
    token: bridgeToken,
    cancelCodingJob: async (jobId) => { if (codingBridge) await codingBridge.cancelJob(jobId); },
    stopChat: (chatId) => agent.stop(chatId).stopped,
    readReceiptDetail: (work) => {
      if (work.resultHandle.type === 'coding_job' && codingBridge) {
        return {
          receipt: codingBridge.getReceipt(work.resultHandle.jobId) ?? null,
          events: codingBridge.readEventsTail(work.resultHandle.jobId, 30),
        };
      }
      if (work.resultHandle.type === 'subagent_chat') {
        try { return { messages: history.load(work.resultHandle.chatId).slice(-5) }; } catch { return { messages: [] }; }
      }
      return null;
    },
  }));

  bridgeApp.get('/api/agency/state', async (_req: any, res: any) => {
    try {
      const kernel = await getAgencyKernel();
      res.json(kernel.state());
    } catch (err: any) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });
  bridgeApp.get('/api/agency/brief', async (_req: any, res: any) => {
    try {
      const kernel = await getAgencyKernel();
      res.json(kernel.brief());
    } catch (err: any) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });
  bridgeApp.get('/api/agency/inspector', async (req: any, res: any) => {
    try {
      const kernel = await getAgencyKernel();
      res.json(kernel.inspector({
        filter: req.query?.filter || 'all',
        limit: Number(req.query?.limit || 50),
      }));
    } catch (err: any) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });
  bridgeApp.get('/api/agency/inbox', async (req: any, res: any) => {
    try {
      const kernel = await getAgencyKernel();
      res.json({ inbox: kernel.inbox({ limit: Number(req.query?.limit || 100) }) });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });
  bridgeApp.get('/api/agency/pursuits', async (req: any, res: any) => {
    try {
      const kernel = await getAgencyKernel();
      res.json({ pursuits: kernel.pursuits({ status: req.query?.status || null, limit: Number(req.query?.limit || 100) }) });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });
  bridgeApp.get('/api/agency/pursuits/:id', async (req: any, res: any) => {
    try {
      const kernel = await getAgencyKernel();
      const pursuit = kernel.pursuit(req.params.id);
      if (!pursuit) {
        res.status(404).json({ error: `Pursuit not found: ${req.params.id}` });
        return;
      }
      res.json({ pursuit });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });
  bridgeApp.post('/api/agency/intake', async (req: any, res: any) => {
    try {
      const kernel = await getAgencyKernel();
      res.json(await kernel.intake(req.body || {}));
    } catch (err: any) {
      res.status(400).json({ error: err?.message || String(err) });
    }
  });
  bridgeApp.post('/api/agency/world-stream', async (req: any, res: any) => {
    try {
      const kernel = await getAgencyKernel();
      res.json(await kernel.intakeWorldStream(req.body || {}));
    } catch (err: any) {
      res.status(400).json({ error: err?.message || String(err) });
    }
  });
  bridgeApp.post('/api/agency/tick', async (req: any, res: any) => {
    try {
      const kernel = await getAgencyKernel();
      res.json(await kernel.tick(req.body || {}));
    } catch (err: any) {
      res.status(400).json({ error: err?.message || String(err) });
    }
  });
  bridgeApp.post('/api/agency/claims', async (req: any, res: any) => {
    try {
      const kernel = await getAgencyKernel();
      res.json({ claim: kernel.recordClaim(req.body || {}) });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || String(err) });
    }
  });
  bridgeApp.post('/api/agency/deltas', async (req: any, res: any) => {
    try {
      const kernel = await getAgencyKernel();
      res.json(kernel.proposeDelta(req.body || {}));
    } catch (err: any) {
      res.status(400).json({ error: err?.message || String(err) });
    }
  });
  bridgeApp.post('/api/agency/pursuits/:id/transition', async (req: any, res: any) => {
    try {
      const kernel = await getAgencyKernel();
      res.json(kernel.transition(req.params.id, req.body || {}));
    } catch (err: any) {
      res.status(400).json({ error: err?.message || String(err) });
    }
  });
  bridgeApp.get('/api/agency/events', async (req: any, res: any) => {
    try {
      const kernel = await getAgencyKernel();
      res.json(kernel.events({ limit: Number(req.query?.limit || 100) }));
    } catch (err: any) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });
  bridgeApp.get('/api/agency/scratch', async (req: any, res: any) => {
    try {
      const kernel = await getAgencyKernel();
      res.json(kernel.scratch({ limit: Number(req.query?.limit || 100) }));
    } catch (err: any) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });
  bridgeApp.post('/api/agency/scratch', async (req: any, res: any) => {
    try {
      const kernel = await getAgencyKernel();
      res.json({ scratch: kernel.recordScratch(req.body || {}) });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || String(err) });
    }
  });
  bridgeApp.get('/api/agency/questions', async (req: any, res: any) => {
    try {
      const kernel = await getAgencyKernel();
      res.json(kernel.questions({ limit: Number(req.query?.limit || 100) }));
    } catch (err: any) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });
  bridgeApp.post('/api/agency/questions', async (req: any, res: any) => {
    try {
      const kernel = await getAgencyKernel();
      res.json({ question: kernel.raiseQuestion(req.body || {}) });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || String(err) });
    }
  });
  bridgeApp.get('/api/agency/tasks', async (req: any, res: any) => {
    try {
      const kernel = await getAgencyKernel();
      res.json(kernel.tasks({ status: req.query?.status || null, limit: Number(req.query?.limit || 100) }));
    } catch (err: any) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });
  bridgeApp.post('/api/agency/tasks', async (req: any, res: any) => {
    try {
      const kernel = await getAgencyKernel();
      res.json({ task: kernel.recordTask(req.body || {}) });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || String(err) });
    }
  });
  bridgeApp.post('/api/agency/tasks/:id/transition', async (req: any, res: any) => {
    try {
      const kernel = await getAgencyKernel();
      const status = req.body?.status || req.body?.transition;
      if (status !== 'closed') {
        res.status(400).json({ error: 'Only closed task transition is supported' });
        return;
      }
      res.json({ task: kernel.closeTask(req.params.id, req.body || {}) });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || String(err) });
    }
  });

  bridgeApp.post('/api/chat', createEvobrewChatHandler(bridgeConfig));
  bridgeApp.post('/api/stop', createStopHandler(bridgeConfig));
  bridgeApp.get('/health', createHealthHandler({ agentName: AGENT_NAME, agent }));

  bridgeApp.get('/api/house/state', async (_req: any, res: any) => {
    const haUrl = config.homeAssistant?.url?.replace(/\/+$/, '');
    const haToken = config.homeAssistant?.token;
    if (!haUrl || !haToken) {
      res.status(503).json({ ok: false, error: 'homeAssistant not configured' });
      return;
    }

    try {
      const startedAt = Date.now();
      const [apiRes, statesRes] = await Promise.all([
        fetch(`${haUrl}/api/`, {
          headers: { Authorization: `Bearer ${haToken}`, 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(5000),
        }),
        fetch(`${haUrl}/api/states`, {
          headers: { Authorization: `Bearer ${haToken}`, 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(8000),
        }),
      ]);

      if (!apiRes.ok) throw new Error(`Home Assistant API HTTP ${apiRes.status}`);
      if (!statesRes.ok) throw new Error(`Home Assistant states HTTP ${statesRes.status}`);

      const states = await statesRes.json() as Array<any>;
      const now = Date.now();
      const staleAfterMs = 6 * 60 * 60 * 1000;
      const interesting = /garage|door|lock|leak|water|smoke|carbon|co\b|motion|person|camera|eufy|meross|battery|thermostat|temperature|humidity|homekit/i;
      const matched = states
        .filter((s) => interesting.test(String(s.entity_id ?? '')) || interesting.test(String(s.attributes?.friendly_name ?? '')))
        .map((s) => {
          const updatedAt = s.last_updated ? new Date(s.last_updated).getTime() : 0;
          return {
            entity_id: s.entity_id,
            name: s.attributes?.friendly_name ?? s.entity_id,
            state: s.state,
            domain: String(s.entity_id ?? '').split('.')[0] ?? 'unknown',
            updated_at: s.last_updated,
            stale: updatedAt > 0 ? now - updatedAt > staleAfterMs : true,
          };
        })
        .sort((a, b) => String(a.entity_id).localeCompare(String(b.entity_id)));

      const unavailable = matched.filter((s) => ['unavailable', 'unknown'].includes(String(s.state)));
      const stale = matched.filter((s) => s.stale);
      const open = matched.filter((s) => /garage|door|lock/i.test(`${s.entity_id} ${s.name}`) && ['open', 'opening', 'unlocked'].includes(String(s.state)));

      res.json({
        ok: true,
        source: 'home-assistant',
        url: haUrl,
        response_ms: Date.now() - startedAt,
        entity_count: states.length,
        matched_count: matched.length,
        alerts: [
          ...open.map((s) => ({ severity: 'alert', kind: 'open_access_point', entity_id: s.entity_id, state: s.state })),
          ...unavailable.map((s) => ({ severity: 'warn', kind: 'unavailable', entity_id: s.entity_id, state: s.state })),
          ...stale.map((s) => ({ severity: 'warn', kind: 'stale', entity_id: s.entity_id, updated_at: s.updated_at })),
        ],
        entities: matched,
      });
    } catch (err) {
      res.status(502).json({ ok: false, source: 'home-assistant', url: haUrl, error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── Prompt-composition inspection (Step 30, Piece 1) — a developer/debug
  // view of exactly which identity sources and sections reached the last turn,
  // their sizes, and anything omitted to fit budget. Bearer-token gated: this
  // exposes private identity content, so it must never be reachable
  // unauthenticated. Metadata-only by default; the full prompt text is returned
  // only with ?includeText=1 (still behind the same token).
  bridgeApp.get('/api/prompt-composition', (req: any, res: any) => {
    if (bridgeToken) {
      const header = req.headers.authorization || '';
      const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
      if (provided !== bridgeToken) {
        res.status(401).json({ error: 'unauthorized' });
        return;
      }
    }
    const info = contextManager.getPromptSourceInfo();
    const body: Record<string, unknown> = {
      agent: AGENT_NAME,
      generatedAt: info.generatedAt,
      totalSections: info.totalSections,
      systemPromptBytes: info.systemPromptBytes,
      anyTruncated: info.anyTruncated,
      layers: info.loadedFiles,
    };
    if (String(req.query?.includeText || '') === '1') {
      body.systemPrompt = contextManager.getSystemPrompt();
    }
    res.json(body);
  });

  // ── Notify endpoint — the engine's live-problems loop calls this when
  // autonomous remediation has been exhausted. Routes the message to the
  // owner's default channel (Telegram DM for now). Bearer-token gated so
  // only the local engine can fire it.
  bridgeApp.post('/api/notify', async (req: any, res: any) => {
    if (bridgeToken) {
      const header = req.headers.authorization || '';
      const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
      if (provided !== bridgeToken) {
        res.status(401).json({ error: 'unauthorized' });
        return;
      }
    }
    const { text, severity = 'normal', source = 'engine', requiresAction, isFailure, jtrRhythm, kind } = req.body || {};
    if (!text || typeof text !== 'string') {
      res.status(400).json({ error: 'text required' });
      return;
    }

    const ownerTelegramId = config.agent?.owner?.telegramId || null;
    const telegramAdapter = adapterMap.get('telegram');

    // Attention gate (Step 30). Live-problems only POSTs here after autonomous
    // remediation is exhausted (fuse-box critical/emergency), so most traffic is
    // high-materiality and surfaces. Routine low-severity engine pings with no
    // action are aggregated into a digest or suppressed, so the notify channel
    // never becomes a notification center. chatId is intentionally NOT set: the
    // owner's Telegram id is the DESTINATION, and setting it would falsely trip
    // the numeric-chatId user-reply guard and neuter the gate.
    const sevMap: Record<string, OutboundSignal['severity']> = {
      low: 'info', normal: 'notice', info: 'info', notice: 'notice',
      alert: 'alert', urgent: 'urgent', critical: 'critical', emergency: 'emergency',
    };
    const signal: OutboundSignal = {
      origin: source === 'live-problems' ? 'live-problems' : 'unknown',
      text,
      severity: sevMap[String(severity).toLowerCase()] ?? 'notice',
      requiresAction: requiresAction === true || source === 'live-problems',
      // A live-problems notify fires only after autonomous remediation is
      // exhausted — a still-blocking failure. Mark it isFailure so it bypasses
      // dedup (rule 3, before dedup): a repeated still-blocking escalation must
      // stay visible. The engine already rate-limits notify_jtr (fuse-box
      // cooldown), so this does not spam.
      isFailure: isFailure === true || source === 'live-problems',
      jtrRhythm: typeof jtrRhythm === 'string' ? jtrRhythm : undefined,
      kind: typeof kind === 'string' ? kind : undefined,
      dedupeKey: `notify:${source}:${text}`,
    };
    const verdict = attentionGate ? attentionGate.evaluate(signal) : { decision: 'surface' as const, reason: 'gate_disabled' };

    const sendToOwner = async (body: string): Promise<{ delivered: string[]; failed: Array<{channel: string; error: string}> }> => {
      const delivered: string[] = [];
      const failed: Array<{channel: string; error: string}> = [];
      if (telegramAdapter && ownerTelegramId) {
        try {
          await telegramAdapter.send({ channel: 'telegram', chatId: String(ownerTelegramId), text: body });
          delivered.push('telegram');
        } catch (err) {
          failed.push({ channel: 'telegram', error: err instanceof Error ? err.message : String(err) });
        }
      }
      return { delivered, failed };
    };

    // Opportunistically flush the held-digest when it is due, so aggregated
    // low-materiality updates still reach jtr as a single message. If delivery
    // fails, re-enqueue the drained items rather than lose them silently.
    const flushDigestIfDue = async (): Promise<void> => {
      if (attentionGate && attentionGate.shouldFlushAggregate()) {
        const held = attentionGate.drainAggregate();
        if (held.length === 0) return;
        const { delivered } = await sendToOwner(`🗒️ ${attentionGate.buildDigest(held)}`);
        if (delivered.length === 0) {
          for (const s of held) attentionGate.enqueueAggregate(s);
          console.warn(`[notify] digest flush failed to deliver; re-queued ${held.length} held item(s)`);
        }
      }
    };

    if (verdict.decision === 'suppress') {
      console.log(`[notify] suppressed by attention gate (${verdict.reason}) from ${source}`);
      res.json({ ok: true, gated: 'suppress', reason: verdict.reason, delivered: [] });
      return;
    }
    if (verdict.decision === 'aggregate') {
      attentionGate!.enqueueAggregate(signal);
      console.log(`[notify] aggregated by attention gate (${verdict.reason}) from ${source}; ${attentionGate!.pendingAggregateCount()} held`);
      await flushDigestIfDue();
      res.json({ ok: true, gated: 'aggregate', reason: verdict.reason, pending: attentionGate!.pendingAggregateCount() });
      return;
    }

    // surface
    const sigil = signal.severity === 'critical' || signal.severity === 'emergency' ? '🚨'
      : signal.severity === 'alert' ? '🚨' : signal.severity === 'info' ? '·' : '⚠️';
    const { delivered, failed } = await sendToOwner(`${sigil} [${source}] ${text}`);
    if (delivered.length > 0 && attentionGate) attentionGate.record(signal);
    await flushDigestIfDue();

    if (delivered.length === 0) {
      res.status(503).json({
        error: 'no channel delivered',
        tried: failed,
        hint: telegramAdapter ? 'owner.telegramId not configured' : 'telegram adapter not enabled',
      });
      return;
    }
    res.json({ ok: true, gated: verdict.reason, delivered, failed });
  });

  // ── Diagnose endpoint — Tier 3 of live-problems. Engine POSTs a problem
  // here when the rigid remediation plan didn't resolve it. We launch a
  // normal agent turn with a focused diagnostic mission and return the
  // turnId immediately (fire-and-forget from the engine's POV; budget
  // tracking lives in the engine's loop). The agent uses its standard
  // toolbox: shell, files, cron, brain, web.
  const parseDiagnosticCompletion = (text: string, toolCallCount: number) => {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    const pick = (re: RegExp) => {
      const m = clean.match(re);
      return m && m[1] ? m[1].trim().toLowerCase() : '';
    };
    let verifierStatus = pick(/VERIFIER_STATUS:\s*(pass|fail|unknown)/i);
    let dispatchOutcome = pick(/DISPATCH_OUTCOME:\s*(fixed|failed|blocked|unknown|not_fixed)/i);
    const summaryMatch = clean.match(/SUMMARY:\s*(.+)$/i);
    const lower = clean.toLowerCase();

    if (dispatchOutcome === 'not_fixed') dispatchOutcome = 'failed';
    if (!verifierStatus) {
      if (/\bverifier(?: now)? passes\b|\bverifier passed\b/i.test(clean)) verifierStatus = 'pass';
      else if (/\bverifier(?: still)? fails\b|\bverifier failed\b|\bdoes not pass\b|\bdoesn't pass\b/i.test(clean)) verifierStatus = 'fail';
      else verifierStatus = 'unknown';
    }
    if (!dispatchOutcome) {
      if (verifierStatus === 'pass') dispatchOutcome = 'fixed';
      else if (
        lower.includes('operation was aborted due to timeout')
        || lower.includes('error calling ')
        || lower.includes('timed out')
        || (toolCallCount === 0 && lower.includes('error'))
      ) dispatchOutcome = 'failed';
      else dispatchOutcome = 'unknown';
    }

    return {
      verifierStatus,
      dispatchOutcome,
      summary: (summaryMatch?.[1] || clean || 'agent run completed').slice(0, 500),
    };
  };

  bridgeApp.post('/api/diagnose', async (req: any, res: any) => {
    if (bridgeToken) {
      const header = req.headers.authorization || '';
      const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
      if (provided !== bridgeToken) {
        res.status(401).json({ error: 'unauthorized' });
        return;
      }
    }
    const { problem, budgetHours = 12 } = req.body || {};
    if (!problem || !problem.id || !problem.claim) {
      res.status(400).json({ error: 'problem with id+claim required' });
      return;
    }

    // Dedicated chatId namespace so diagnostic runs don't collide with
    // user chat or with each other.
    const chatId = `diagnose:${problem.id}`;

    // If the agent is already running something for this problem, short-circuit.
    if (agent.isRunning(chatId)) {
      res.status(409).json({ error: 'diagnosis already in progress for ' + problem.id });
      return;
    }

    // Build the mission message. Explicit, structured, includes prior attempts
    // so the agent doesn't repeat what's already been tried.
    const priorAttempts = Array.isArray(problem.remediationLog) && problem.remediationLog.length > 0
      ? problem.remediationLog.map((r: any, i: number) =>
          `  ${i + 1}. step ${r.step} ${r.type}: ${r.outcome} — ${r.detail}`).join('\n')
      : '  (none)';
    const verifierSpec = problem.verifier
      ? `${problem.verifier.type}(${JSON.stringify(problem.verifier.args || {})})`
      : '(none)';
    // Prior fix recipe — what worked the last time this problem was dispatched.
    // Gives the agent a strong head start instead of starting from scratch.
    const priorRecipe = problem.fixRecipe?.summary
      ? [
          '',
          'Prior successful fix recipe (last time this problem was dispatched):',
          `  ${String(problem.fixRecipe.summary).slice(0, 500)}`,
          '  → try this approach first; if conditions have changed, investigate why.',
        ].join('\n')
      : '';

    const mission = [
      `SYSTEM DIAGNOSTIC REQUEST — Live Problem: ${problem.id}`,
      '',
      'The rigid remediation plan for this problem did not resolve it. You are being',
      'handed this to diagnose and attempt a real fix using your full toolbox (shell,',
      'files, cron, brain, web, subagent). You have autonomy to investigate root',
      'cause, try fixes, and verify.',
      '',
      `Claim: ${problem.claim}`,
      `Verifier: ${verifierSpec}`,
      `  → this is how you know if the fix worked. Re-run the equivalent check`,
      `    yourself after any attempted fix; only claim success if it passes.`,
      '',
      'Prior remediation attempts (already tried, do not repeat):',
      priorAttempts,
      priorRecipe,
      '',
      `Budget: ~${budgetHours}h wall clock. You don't need to rush, but don't loop either.`,
      '',
      'DO:',
      '  - investigate the actual state of the system (shell, file reads, pings)',
      '  - look for siblings that work (e.g. a related cron, a related bridge)',
      '    and clone the pattern if that\'s the gap',
      '  - write scripts, register crons, fix configs, restart processes as needed',
      '  - verify with the verifier\'s check before declaring done',
      '  - if you can\'t fix it (needs physical access, jtr\'s decision, unknown',
      '    component), explain clearly why and what jtr would need to do',
      '',
      'DO NOT:',
      '  - notify jtr — that happens automatically if you can\'t fix it within budget',
      '  - do destructive operations without a verified need (no pm2 delete all,',
      '    no rm -rf on user data, no force pushes)',
      '  - pretend it\'s fixed when the verifier still fails',
      '',
      'End your session with 2-3 sentences plus this exact trailer:',
      '  VERIFIER_STATUS: pass|fail|unknown',
      '  DISPATCH_OUTCOME: fixed|failed|blocked|unknown',
      '  SUMMARY: one sentence on what happened',
    ].join('\n');

    try {
      const { turnId, response } = await agent.runWithTurn(chatId, mission);
      const postFixRecipe = async (payload: Record<string, unknown>) => {
        await fetch(`${ENGINE_BASE}/api/live-problems/${encodeURIComponent(problem.id)}/fix-recipe`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
      };
      // Detach. The engine tracks budget separately via wall clock.
      // When the agent finishes, capture a fix-recipe back to the engine so
      // (a) the dashboard Signals tile can show it, and (b) the next dispatch
      // for this same problem gets it injected into the mission prompt.
      response.then(async (resp: import('./agent/types.js').AgentResponse) => {
        try {
          const minutes = Math.max(1, Math.round(resp.durationMs / 60000));
          const report = parseDiagnosticCompletion(resp.text, resp.toolCallCount);
          const summary = `agent ran ${resp.toolCallCount} tool calls in ~${minutes}min (model=${resp.model}). ${report.summary}`;
          await postFixRecipe({
            summary,
            turnId,
            toolCallCount: resp.toolCallCount,
            durationMs: resp.durationMs,
            dispatchOutcome: report.dispatchOutcome,
            verifierStatus: report.verifierStatus,
          });
          console.log(`[diagnose] ${problem.id} turn ${turnId} → fix-recipe captured (${resp.toolCallCount} tools, ${minutes}m)`);
        } catch (err: any) {
          console.warn(`[diagnose] ${problem.id} fix-recipe post failed:`, err?.message || err);
        }
      }).catch((err: any) => {
        console.error(`[diagnose] ${problem.id} turn ${turnId} error:`, err?.message || err);
        postFixRecipe({
          summary: `agent turn failed before completion: ${String(err?.message || err).slice(0, 500)}`,
          turnId,
          toolCallCount: 0,
          durationMs: 0,
          dispatchOutcome: 'failed',
          verifierStatus: 'unknown',
        }).catch((postErr: any) => {
          console.warn(`[diagnose] ${problem.id} failure post failed:`, postErr?.message || postErr);
        });
      });
      console.log(`[diagnose] ${problem.id}: dispatched agent turn ${turnId}`);
      res.json({ ok: true, turnId, chatId, problemId: problem.id, budgetHours });
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      console.error(`[diagnose] ${problem.id} dispatch error:`, m);
      res.status(500).json({ error: m });
    }
  });

  // Resumable chat routes — turn-based protocol for backgrounding/reconnect
  const chatTurnConfig = {
    agentName: AGENT_NAME,
    agent,
    history,
    token: bridgeToken || undefined,
    modelAliases: MODEL_ALIASES,
    instanceDir: INSTANCE_DIR,
  };
  bridgeApp.post('/api/chat/turn', createTurnStartHandler(chatTurnConfig));
  bridgeApp.get('/api/chat/stream', createTurnStreamHandler(chatTurnConfig));
  bridgeApp.post('/api/chat/stop-turn', createTurnStopHandler(chatTurnConfig));
  bridgeApp.get('/api/chat/turn-status', createTurnStatusHandler(chatTurnConfig));
  bridgeApp.get('/api/chat/pending', createPendingTurnsHandler(chatTurnConfig));
  bridgeApp.get('/api/chat/models', createModelsHandler(chatTurnConfig));
  bridgeApp.get('/api/chat/media', async (req, res) => {
    const filePath = req.query.path;
    if (!filePath || typeof filePath !== 'string') {
      res.status(400).json({ error: 'path required' });
      return;
    }

    const resolved = resolve(filePath);
    if (!resolved.startsWith(PROJECT_ROOT) && !resolved.startsWith('/tmp/')) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    if (!existsSync(resolved)) {
      res.status(404).json({ error: 'File not found' });
      return;
    }

    res.sendFile(resolved);
  });

  // Device registration routes (iOS push)
  bridgeApp.post('/api/device/register', createRegisterDeviceHandler(deviceConfig));
  bridgeApp.delete('/api/device/register', createUnregisterDeviceHandler(deviceConfig));
  bridgeApp.get('/api/device/registry', createListDevicesHandler(deviceConfig));

  // Chat history routes (iOS initial load + conversation list)
  const historyRouteConfig = { agentName: AGENT_NAME, history, token: bridgeToken || undefined };
  bridgeApp.get('/api/chat/history', createChatHistoryHandler(historyRouteConfig));
  bridgeApp.get('/api/chat/conversations', createChatListHandler(historyRouteConfig));

  // Step 24 — Bridge-chat inject route for the engine-side publisher.
  // The engine's BridgeChatPublisher POSTs salient observations here so
  // they land on a bridge-chat lane without the engine needing direct
  // SQLite / bridge-chat access (cross-process boundary).
  bridgeApp.post('/api/bridge-chat/inject', async (req: any, res: any) => {
    try {
      if (!bridgeChat) {
        res.status(503).json({ error: 'bridge-chat not configured' });
        return;
      }
      const { lane = 'observations', from = 'os-engine', text } = req.body || {};
      if (!text || typeof text !== 'string') {
        res.status(400).json({ error: 'text required' });
        return;
      }
      const messageId = await bridgeChat.sendToLane(lane, from, text);
      res.json({ ok: true, messageId });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  // Step 24 — Neighbor protocol public state surface.
  // Returns a cached, minimal snapshot of this agent's state so peers can
  // ingest it as UNCERTIFIED observations via their own NeighborChannel.
  // See docs/design/STEP24-OS-ENGINE-REDESIGN.md §Neighbor Protocol.
  let publicStateCache: unknown = null;
  let publicStateAt = 0;
  const PUBLIC_STATE_CACHE_MS = 60_000;
  bridgeApp.get('/__state/public.json', async (_req: any, res: any) => {
    try {
      const now = Date.now();
      if (!publicStateCache || now - publicStateAt > PUBLIC_STATE_CACHE_MS) {
        const brainDir = process.env.COSMO_RUNTIME_DIR
          ? resolve(process.env.COSMO_RUNTIME_DIR)
          : '';
        let recentObservations: unknown[] = [];
        let lastMemoryWrite = '';
        if (brainDir) {
          try {
            const receiptsPath = join(brainDir, 'crystallization-receipts.jsonl');
            if (existsSync(receiptsPath)) {
              const raw = readFileSync(receiptsPath, 'utf8').trim().split('\n').slice(-20);
              recentObservations = raw.map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
              const last = recentObservations[recentObservations.length - 1] as any;
              if (last?.at) lastMemoryWrite = last.at;
            }
          } catch { /* best-effort */ }
        }
        publicStateCache = {
          agent: AGENT_NAME,
          origin: {
            agent: AGENT_NAME,
            protocol: 'home23-neighbor-state',
            protocolVersion: 1,
          },
          activeGoals: [],        // Goals live engine-side; not exposed in Phase 8.
          recentObservations,     // Last 20 crystallization receipts.
          currentFocus: config.agent?.displayName ?? AGENT_NAME,
          dispatchState: 'idle',
          lastMemoryWrite,
          snapshotAt: new Date(now).toISOString(),
        };
        publicStateAt = now;
      }
      res.type('application/json').send(JSON.stringify(publicStateCache));
    } catch (err: any) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  const bridge = await startBridgeWithRecovery(bridgeApp, BRIDGE_PORT, {
    log: (message) => console.error(message),
  });
  if (bridge.isDegraded()) {
    console.error(`[home] BRIDGE DEGRADED — port ${BRIDGE_PORT} is held by another process; channels and agent loop stay live, bridge binds when the port frees`);
  } else {
    console.log(`[home] Evobrew bridge listening on port ${BRIDGE_PORT} (/api/chat, /api/stop, /api/chat/turn, /api/chat/stream, /api/chat/pending, /api/chat/stop-turn, /api/chat/history, /api/chat/conversations, /api/device/register, /api/device/registry, /api/device/query-credential, /api/query-notifications/terminal, /health)`);
  }

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
  // Watchdog must stay below the harness PM2 kill_timeout (30s) so a hung
  // shutdown self-terminates before PM2 has to SIGKILL; a repeated signal
  // force-exits instead of being swallowed.
  const shutdownGuard = new ShutdownGuard({
    watchdogMs: 15_000,
    log: (message) => console.error(message),
    exit: (code) => process.exit(code),
  });

  const shutdown = async (signal: string): Promise<void> => {
    if (!shutdownGuard.begin(signal)) return;

    console.log(`\n[home] Received ${signal}, shutting down...`);

    engineEvents.stop();

    if (scheduler) {
      scheduler.stop();
    }

    try {
      codingBridge?.dispose();
    } catch (err) {
      console.error('[home] Error disposing coding bridge:', err);
    }

    try {
      await bridge.stop();
    } catch (err) {
      console.error('[home] Error closing bridge server:', err);
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
