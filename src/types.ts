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
  url?: string;
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

  media?: {
    imageGeneration?: {
      provider?: string;
      model?: string;
    };
    musicGeneration?: {
      provider?: string;
      model?: string;
    };
  };

  providers?: Record<string, unknown>;

  search?: {
    searxngUrl?: string;
  };

  channels: ChannelsConfig;
  sessions: SessionsConfig;
  scheduler: SchedulerConfig;
  deliveryProfiles?: DeliveryProfiles;
  sibling: SiblingConfig;
  acp: ACPConfig;
  browser: BrowserConfig;
  tts: TTSConfig;

  apns?: {
    team_id: string;
    key_id: string;
    key_path: string;
    bundle_id: string;
    default_env: 'sandbox' | 'production';
  };
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
  messageQueue: {
    mode: string;
    debounceMs: number;
    cap: number;
    overflowStrategy: string;
    adaptiveDebounce?: boolean;
    queueDuringRun?: boolean;
  };
}

export interface SchedulerConfig {
  timezone: string;
  jobsFile: string;
  runsDir: string;
}

export type DeliveryProfiles = Record<string, {
  channels: Array<{ channel: string; to: string }>;
}>;

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

// ─── Situational Awareness Engine Types ─────────────────

export type MemoryObjectType =
  | 'observation'
  | 'evidence_link'
  | 'insight'
  | 'uncertainty_item'
  | 'procedure'
  | 'correction'
  | 'breakdown_diagnostic'
  | 'hypothesis'
  | 'recommendation_state'
  | 'checkpoint'
  | 'handoff_receipt';

export type DeltaClass =
  | 'belief_change'
  | 'priority_change'
  | 'scope_change'
  | 'recommendation_change'
  | 'uncertainty_change'
  | 'action_change'
  | 'measurement_model_change'
  | 'no_change';

export type LifecycleLayer = 'raw' | 'working' | 'durable';

export type MemoryStatus = 'candidate' | 'approved' | 'challenged' | 'superseded' | 'expired' | 'rejected';

export type ReviewState = 'unreviewed' | 'self_reviewed' | 'peer_reviewed' | 'approved' | 'challenged' | 'rejected' | 'expired';

export type ThreadLevel = 'constitutional' | 'strategic' | 'tactical' | 'immediate';

export interface StateDelta {
  delta_class: DeltaClass;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  why: string;
}

export interface TriggerCondition {
  trigger_type: string;
  condition: string;
}

export interface MemoryObject {
  memory_id: string;
  type: MemoryObjectType;
  thread_id: string;
  session_id: string;
  lifecycle_layer: LifecycleLayer;
  status: MemoryStatus;
  title: string;
  statement: string;
  summary?: string;
  created_at: string;
  updated_at: string;
  actor: string;
  provenance: {
    source_refs: string[];
    session_refs: string[];
    generation_method: string;
  };
  evidence: {
    evidence_links: string[];
    grounding_strength: 'strong' | 'medium' | 'weak' | 'none';
    grounding_note?: string;
  };
  confidence: {
    score: number;
    basis: string;
  };
  state_delta: StateDelta;
  triggers: TriggerCondition[];
  scope: {
    applies_to: string[];
    excludes: string[];
  };
  review_state: ReviewState;
  supersedes?: string[];
  superseded_by?: string[];
  staleness_policy: {
    review_after_days?: number;
    expire_after_days?: number;
  };
  privacy_class?: 'internal' | 'personal' | 'sensitive';
  consent?: {
    consent_scope: 'this_session' | 'ongoing' | 'until_revoked';
    retention_basis: string;
    do_not_surface_without_trigger: boolean;
    user_confirmed?: boolean;
  };
  reuse_count: number;
  last_reactivated?: string;
  last_acted_on?: string;
}

export interface ProblemThread {
  thread_id: string;
  title: string;
  question: string;
  objective: string;
  level: ThreadLevel;
  status: 'open' | 'progressing' | 'blocked' | 'resolved' | 'archived';
  priority: 'high' | 'medium' | 'low';
  owner: string;
  parent_thread?: string;
  child_threads: string[];
  opened_at: string;
  closed_at?: string;
  current_state_summary: string;
  success_criteria: string[];
  related_threads: string[];
  context_boundaries: {
    applies_to: string[];
    does_not_apply_to: string[];
  };
  version: number;
}

export interface EventEnvelope {
  event_id: string;
  event_type: string;
  thread_id?: string;
  session_id: string;
  object_id?: string;
  timestamp: string;
  actor: string;
  invocation_id?: string;
  retry_of?: string;
  payload: Record<string, unknown>;
}

export interface AssemblyResult {
  block: string;
  degraded: boolean;
  brainCueCount: number;
  triggerCount: number;
  surfacesLoaded: string[];
  events: EventEnvelope[];
}
