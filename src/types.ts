/**
 * COSMO Home 2.3 — Type Definitions for the Home Bridge Layer
 *
 * These types cover the channel/scheduler/sibling/ACP/browser modules.
 * The engine (JS) manages its own types internally.
 */

// ─── Channel Types ──────────────────────────────────────────

export interface IncomingMessage {
  id: string;
  channel: string;           // 'telegram' | 'discord' | 'imessage' | 'webhook'
  chatId: string;
  userId: string;
  userName: string;
  text: string;
  timestamp: number;         // epoch ms
  raw?: unknown;             // channel-specific raw payload
  sessionKey?: string;       // for webhook session routing
}

export interface OutgoingResponse {
  text: string;
  channel?: string;
  chatId?: string;
  replyToId?: string;
}

export interface MediaAttachment {
  type: 'image' | 'voice' | 'document';
  path: string;
  mimeType?: string;
  fileName?: string;
  caption?: string;
}

export interface ChannelAdapter {
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  send(response: OutgoingResponse): Promise<void>;
  onMessage(handler: (msg: IncomingMessage) => void): void;
}

// ─── Session Types ──────────────────────────────────────────

export interface SessionRecord {
  type: 'session' | 'message' | 'model_change' | 'thinking_level_change' | 'custom';
  id: string;
  parentId?: string;
  timestamp: string;
  message?: {
    role: 'user' | 'assistant' | 'system';
    content: ContentBlock[];
    model?: string;
    provider?: string;
    usage?: { input: number; output: number; totalTokens: number };
    stopReason?: string;
    timestamp?: number;
  };
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'toolCall'; name: string; input: unknown }
  | { type: 'toolResult'; name: string; output: unknown };

// ─── Config Types ───────────────────────────────────────────

export interface IdentityLayerConfig {
  basePath: string;
  files: string[];
}

export interface EmbeddedAgentConfig {
  name: string;
  identity:
    | {
        basePath: string;
        files: string[];
      }
    | Array<{
        basePath: string;
        files: string[];
      }>;
  shared?: Array<{
    basePath: string;
    files: string[];
  }>;
}

export interface HomeConfig {
  home?: { name: string; version: string };
  system: { name: string; version: string; workspace: string };

  agent?: {
    name: string;
    displayName?: string;
    owner?: { name: string; telegramId?: string };
    timezone?: string;
    maxSubAgents?: number;
  };

  ports?: {
    engine: number;
    dashboard: number;
    mcp?: number;
    bridge?: number;
  };

  chat: {
    provider: string;
    model: string;
    defaultProvider?: string;
    defaultModel?: string;
    maxTokens: number;
    temperature: number;
    historyDepth: number;
    historyBudget?: number;
    sessionGapMs?: number;
    memorySearch: { enabled: boolean; timeoutMs: number; topK: number };
    identityFiles: string[];
    identityLayers?: IdentityLayerConfig[];
    embeddedAgent?: EmbeddedAgentConfig;
    heartbeatRefreshMs: number;
  };

  models?: {
    aliases?: Record<string, { provider: string; model: string }>;
  };

  providers?: Record<string, unknown>;

  channels: ChannelsConfig;
  sessions: SessionsConfig;
  scheduler: SchedulerConfig;
  sibling: SiblingConfig;
  acp: ACPConfig;
  browser: BrowserConfig;
  tts: TTSConfig;
}

export interface ChannelsConfig {
  telegram: TelegramConfig;
  imessage: IMessageConfig;
  discord: DiscordConfig;
  webhooks: WebhookConfig;
}

export interface TelegramConfig {
  enabled: boolean;
  botToken: string;
  streaming: string;
  dmPolicy: string;
  groupPolicy: string;
  groups: Record<string, { requireMention: boolean }>;
  ackReaction: boolean;
}

export interface IMessageConfig {
  enabled: boolean;
  cliPath: string;
  dmPolicy: string;
  groupPolicy: string;
}

export interface DiscordConfig {
  enabled: boolean;
  token: string;
  streaming: string;
  groupPolicy: string;
  guilds: Record<string, { requireMention: boolean; users?: string[] }>;
  threadBindings: boolean;
}

export interface WebhookConfig {
  enabled: boolean;
  path: string;
  port?: number;
  token: string;
  mappings: WebhookMapping[];
}

export interface WebhookMapping {
  id: string;
  match: { path: string };
  action: string;
  wakeMode: string;
  nameTemplate: string;
  sessionKey: string;
  messageTemplate: string;
  deliver: boolean;
}

export interface SessionsConfig {
  threadBindings: { enabled: boolean; idleHours: number };
  messageQueue: { mode: string; debounceMs: number; cap: number; overflowStrategy: string };
}

export interface SchedulerConfig {
  timezone: string;
  jobsFile: string;
  runsDir: string;
}

export interface SiblingConfig {
  enabled: boolean;
  name: string;
  remoteUrl: string;
  token: string;
  rateLimits: { maxPerMinute: number; retries: number; dedupWindowSeconds: number };
  ackMode: boolean;
  bridgeChat: { enabled: boolean; dbPath: string; telegramBotToken: string; telegramTargetId: string };
}

export interface ACPConfig {
  enabled: boolean;
  defaultAgent: string;
  allowedAgents: string[];
  permissionMode: string;
}

export interface BrowserConfig {
  enabled: boolean;
  headless: boolean;
  cdpUrl: string;
}

export interface TTSConfig {
  enabled: boolean;
  auto: string;
  provider: string;
  apiKey: string;
  voiceId: string;
  modelId: string;
}
