const DEFAULT_CHAT_PROVIDER = 'ollama-cloud';
const DEFAULT_CHAT_MODEL = 'kimi-k2.6';
const DEFAULT_ENGINE_MODEL = 'MiniMax-M3';

function buildFeederWatchPaths(instanceDir, ingestPaths = []) {
  return [
    { path: `${instanceDir}/workspace/sessions`, label: 'conversation_sessions' },
    { path: `${instanceDir}/workspace/memory`, label: 'memory_snapshots' },
    { path: `${instanceDir}/workspace/projects`, label: 'projects' },
    { path: `${instanceDir}/workspace/reports`, label: 'reports' },
    { path: `${instanceDir}/workspace/research-runs`, label: 'research_runs' },
    { path: `${instanceDir}/workspace/research`, label: 'compiled_research' },
    ...ingestPaths,
  ];
}

function buildAgentConfig(options = {}) {
  const {
    name,
    displayName,
    ownerName = 'owner',
    ownerTelegramId = '',
    personalFacts = [],
    timezone = 'America/New_York',
    ports = {},
    purpose = '',
    home23Version = '1.0.0',
    provider = DEFAULT_CHAT_PROVIDER,
    model = DEFAULT_CHAT_MODEL,
    instanceDir,
    ingestPaths = [],
    botToken = '',
  } = options;

  const resolvedProvider = provider || DEFAULT_CHAT_PROVIDER;
  const resolvedModel = model || DEFAULT_CHAT_MODEL;
  const resolvedFacts = Array.isArray(personalFacts) ? personalFacts.filter(Boolean) : [];

  return {
    agent: {
      name,
      displayName,
      purpose,
      owner: {
        name: ownerName,
        telegramId: ownerTelegramId || undefined,
        facts: resolvedFacts.length ? resolvedFacts : undefined,
      },
      timezone,
      maxSubAgents: 3,
    },
    ports,
    engine: {
      thought: DEFAULT_ENGINE_MODEL,
      consolidation: DEFAULT_ENGINE_MODEL,
      dreaming: DEFAULT_ENGINE_MODEL,
      query: DEFAULT_ENGINE_MODEL,
    },
    feeder: {
      additionalWatchPaths: buildFeederWatchPaths(instanceDir, ingestPaths),
      excludePatterns: [
        '**/node_modules/**',
        '**/dist/**',
        '**/.git/**',
        '**/.DS_Store',
        '**/research-runs/*/brain/**',
        '**/research-runs/*/*.jsonl',
      ],
    },
    channels: {
      telegram: botToken
        ? { enabled: true, streaming: 'partial', dmPolicy: 'open', groupPolicy: 'restricted', groups: {}, ackReaction: true }
        : { enabled: false },
    },
    system: { name: 'home23', version: home23Version, workspace: 'workspace' },
    chat: {
      provider: resolvedProvider,
      model: resolvedModel,
      defaultProvider: resolvedProvider,
      defaultModel: resolvedModel,
      maxTokens: 4096,
      temperature: 0.7,
      historyDepth: 20,
      historyBudget: 400000,
      sessionGapMs: 1800000,
      memorySearch: { enabled: true, timeoutMs: 10000, topK: 5 },
      identityFiles: ['SOUL.md', 'MISSION.md', 'HEARTBEAT.md', 'LEARNINGS.md', 'GOOD_LIFE.md', 'COSMO_RESEARCH.md'],
      heartbeatRefreshMs: 60000,
    },
    sessions: {
      threadBindings: { enabled: true, idleHours: 24 },
      messageQueue: {
        mode: 'collect',
        debounceMs: 3000,
        adaptiveDebounce: true,
        cap: 10,
        overflowStrategy: 'summarize',
        queueDuringRun: true,
      },
    },
    scheduler: { timezone, jobsFile: 'cron-jobs.json', runsDir: 'cron-runs' },
    sibling: {
      enabled: false,
      name: '',
      remoteUrl: '',
      token: '',
      rateLimits: { maxPerMinute: 5, retries: 2, dedupWindowSeconds: 300 },
      ackMode: false,
      bridgeChat: { enabled: false, dbPath: '', telegramBotToken: '', telegramTargetId: '' },
    },
    acp: { enabled: false, defaultAgent: '', allowedAgents: [], permissionMode: 'ask' },
    browser: { enabled: true, headless: true, cdpUrl: 'http://localhost:9222' },
    tts: { enabled: false, auto: 'off', provider: '', apiKey: '', voiceId: '', modelId: '' },
  };
}

function buildFeederConfig(name) {
  return {
    member: name,
    state_file: `../instances/${name}/brain/state.json.gz`,
    watch: [{ path: `../instances/${name}/workspace`, label: 'workspace', glob: '*.md' }],
    ollama: { endpoint: 'http://127.0.0.1:11434', model: 'nomic-embed-text', dims: 768 },
    flush_interval_seconds: 300,
    flush_batch_size: 20,
  };
}

module.exports = {
  DEFAULT_CHAT_PROVIDER,
  DEFAULT_CHAT_MODEL,
  DEFAULT_ENGINE_MODEL,
  buildAgentConfig,
  buildFeederConfig,
  buildFeederWatchPaths,
};
