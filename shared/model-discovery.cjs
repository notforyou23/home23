'use strict';

// Installation-owned, non-secret provider snapshots. This module never writes
// home.yaml, changes defaults, pulls a local model, or starts a provider turn.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const yaml = require('js-yaml');
const { createHome23OAuthBroker, extractOpenAIAccountId } = require('./home23-oauth.cjs');
const { registerModelCapabilities, reviewedReasoningCapabilities } = require('./responses-reasoning.cjs');
const { createCodexCatalogVersionDetector, fetchCodexRegistryVersion, maxStableVersion, parseCodexVersion } = require('./cli-binary.cjs');
const MAX_AGE_MS = 15 * 60 * 1000;
const CACHE_VERSION = 2;
const LEGACY_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];
const PROVIDERS = ['openai', 'openai-codex', 'anthropic', 'xai', 'minimax', 'ollama-cloud', 'ollama-local'];
const ENV_KEYS = { openai: ['OPENAI_API_KEY'], 'openai-codex': ['OPENAI_CODEX_AUTH_TOKEN', 'OPENAI_OAUTH_TOKEN'], anthropic: ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'], xai: ['XAI_API_KEY'], minimax: ['MINIMAX_API_KEY'], 'ollama-cloud': ['OLLAMA_CLOUD_API_KEY', 'OLLAMA_API_KEY'] };
const LABELS = { openai: 'OpenAI', 'openai-codex': 'OpenAI Codex', anthropic: 'Anthropic', xai: 'xAI', minimax: 'MiniMax', 'ollama-cloud': 'Ollama Cloud', 'ollama-local': 'Ollama Local' };
const services = new Map();
const text = value => typeof value === 'string' && value.trim() && !/[\0\r\n]/u.test(value) ? value.trim() : null;
const effort = value => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(value);
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function readYaml(file) { try { return yaml.load(fs.readFileSync(file, 'utf8')) || {}; } catch (error) { if (error.code === 'ENOENT') return {}; throw error; } }
function originBase(provider, config, env) {
  const defaults = { openai: 'https://api.openai.com/v1', 'openai-codex': 'https://chatgpt.com/backend-api/codex', anthropic: 'https://api.anthropic.com', xai: 'https://api.x.ai/v1', minimax: 'https://api.minimax.io', 'ollama-cloud': 'https://ollama.com', 'ollama-local': env.LOCAL_LLM_BASE_URL || 'http://127.0.0.1:11434' };
  return (text(config.baseUrl) || text(config.baseURL) || defaults[provider]).replace(/\/+$/, '').replace(/\/(?:anthropic(?:\/v1)?|v1)$/, '');
}
function descriptor(provider, config, secrets, env) {
  const entry = secrets.providers?.[provider] || {};
  const pinned = text(config.apiKey) || text(config.authToken);
  const token = pinned && !pinned.startsWith('sk-ant-oat') && !pinned.startsWith('eyJ') ? pinned
    : text(entry.apiKey) || pinned || (ENV_KEYS[provider] || []).map(name => text(env[name])).find(Boolean) || '';
  const authMode = provider === 'openai-codex' || token.startsWith('sk-ant-oat') || entry.oauthManaged === true ? 'oauth' : 'api-key';
  const account = text(config.accountId) || text(entry.oauth?.accountId) || (provider === 'openai-codex' ? extractOpenAIAccountId(token) : null);
  const base = originBase(provider, config, env);
  // Hash the actual credential as well as account/config: a new API key can
  // have different project permissions even inside the same account.
  const identity = hash({ provider, base, authMode, account, token, config });
  return { provider, base, authMode, account, token, identity, managed: entry.oauthManaged === true, configured: config.enabled !== false && (provider === 'ollama-local' || Boolean(token)) };
}
function modalities(row, key) { return (row[key] || row.modalities?.[key.replace('_modalities', '')] || []).map(v => typeof v === 'string' ? v : v.type); }
function normalize(provider, raw) {
  const id = text(raw.slug) || text(raw.id) || text(raw.model) || text(raw.name);
  if (!id) throw Object.assign(new Error('Invalid provider model identity'), { code: 'model_snapshot_invalid' });
  if (raw.lifecycle === 'retired' || raw.status === 'retired' || raw.available === false) return null;
  let eligible = false;
  const caps = raw.capabilities;
  const capList = Array.isArray(caps) ? caps : [];
  const excluded = /(?:embed|tts|transcrib|whisper|audio|realtime|image|dall-e|sora|moderation|rerank|instruct|completions)/i.test(id);
  if (provider === 'openai-codex') eligible = raw.supported_in_api !== false && raw.visibility !== 'hide' && raw.visibility !== 'none';
  else if (provider === 'anthropic') eligible = raw.type === 'model' && caps?.tool_use?.supported !== false;
  else if (provider === 'xai') eligible = modalities(raw, 'output_modalities').includes('text') && modalities(raw, 'input_modalities').includes('text');
  else if (provider.startsWith('ollama-')) eligible = capList.includes('completion') && capList.includes('tools');
  // These list APIs expose identity, not capability metadata. Restrict to
  // adapter-reviewed text families and collect unknown IDs for diagnosis.
  else if (provider === 'openai') eligible = !excluded && (caps?.chat?.supported === true
    || (modalities(raw, 'output_modalities').includes('text') && caps?.tool_use?.supported === true)
    || /^(?:gpt-(?:[4-9]|[1-9]\d+)(?:o|[.\-]|$)|gpt-3\.5-turbo(?:-|$)|o[1-9](?:-|$)|chatgpt-4o(?:-|$)|ft:(?:gpt-|o[1-9]))/.test(id));
  else if (provider === 'minimax') eligible = !excluded && (caps?.chat?.supported === true || /^MiniMax-(?:M\d|Text)/.test(id));
  if (!eligible) return { id, eligible: false };
  let options = raw.supported_reasoning_levels || raw.supported_reasoning_efforts || raw.reasoning_efforts || [];
  options = options.map(v => typeof v === 'string' ? v : v.effort).filter(effort);
  let reasoningTransport = options.length && ['openai', 'openai-codex', 'xai'].includes(provider) ? 'responses' : null;
  if (provider === 'anthropic' && caps?.effort?.supported && caps?.thinking?.types?.adaptive?.supported) {
    options = Object.entries(caps.effort).filter(([key, value]) => key !== 'supported' && value?.supported === true).map(([key]) => key).filter(effort);
    reasoningTransport = 'anthropic-adaptive';
  } else if (provider === 'anthropic' && caps?.thinking?.types?.enabled?.supported) {
    options = LEGACY_EFFORTS.slice(); reasoningTransport = 'anthropic-budget';
  }
  let thinkingValues = null;
  if (provider.startsWith('ollama-') && Array.isArray(raw.thinking?.values)) {
    thinkingValues = raw.thinking.values;
    options = thinkingValues.filter(effort);
    if (thinkingValues.includes(false)) options.unshift('none');
    if (thinkingValues.includes(true)) options.push('high');
    reasoningTransport = 'ollama-think';
  }
  // Missing metadata is unknown. Only an explicit negative capability can
  // establish that this model has no configurable reasoning.
  let reasoningCapabilitiesKnown = Boolean(reasoningTransport && options.length);
  if (!reasoningCapabilitiesKnown) options = [];
  const reviewed = !reasoningCapabilitiesKnown ? reviewedReasoningCapabilities(provider, id) : null;
  if (reviewed) { options = reviewed.reasoningEffortOptions; reasoningCapabilitiesKnown = true; reasoningTransport = reviewed.reasoningTransport; }
  const explicitlyNoReasoning = raw.supports_reasoning === false || caps?.thinking?.supported === false
    || (Array.isArray(raw.thinking?.values) && raw.thinking.values.length === 1 && raw.thinking.values[0] === false);
  if (explicitlyNoReasoning) { options = ['none']; reasoningCapabilitiesKnown = true; }
  const advertisedDefault = text(raw.default_reasoning_level) || text(raw.default_reasoning_effort)
    || (effort(raw.thinking?.default) ? raw.thinking.default : null)
    || null;
  const defaultReasoningEffortAdvertised = options.includes(advertisedDefault);
  const defaultOption = defaultReasoningEffortAdvertised ? advertisedDefault : options.includes('medium') ? 'medium' : options[0] || null;
  return { id, model: id, label: text(raw.display_name) || id, eligible: true,
    reasoningCapabilitiesKnown, reasoningEffortOptions: [...new Set(options)], defaultReasoningEffortOption: defaultOption,
    defaultReasoningEffortAdvertised,
    reasoningEfforts: options.filter(v => LEGACY_EFFORTS.includes(v)),
    reasoningTransport, thinkingValues,
    contextWindowTokens: raw.context_window || raw.max_input_tokens || null,
    maxOutputTokens: raw.max_output_tokens || raw.max_tokens || null };
}
function createModelDiscovery({ home23Root, fetchImpl = globalThis.fetch, now = Date.now, env = process.env, intervalMs = 60_000, autoStart = true, cachePath = path.join(home23Root, 'instances', '.house', 'model-catalog-cache.json'), credentialsProvider, codexVersionDetector = createCodexCatalogVersionDetector({ env }), codexRegistryFetchImpl = globalThis.fetch } = {}) {
  if (!path.isAbsolute(home23Root || '')) throw new TypeError('Absolute home23Root required');
  let entries = {}; let revision = 0; let diskStamp = null; let timer;
  const pending = new Map();
  let codexVersionHint = null; let versionHintPending;
  const broker = createHome23OAuthBroker({ home23Root });
  function discoveryDescriptor(provider, config, secrets, home) {
    const desc = descriptor(provider, config, secrets, env);
    if (provider === 'openai-codex' && desc.configured) {
      const detected = codexVersionDetector(home.acp?.backends?.codex?.bin);
      desc.catalogVersion = maxStableVersion(detected.version, codexVersionHint?.version,
        entries[provider]?.identity === desc.identity ? entries[provider].catalogVersion : null);
      desc.catalogErrorCode = detected.errorCode;
      // Auth/account scope stays separate so a protocol change preserves the
      // previous complete snapshot as stale while its replacement is fetched.
      desc.catalogIdentity = hash({ ...detected, version: desc.catalogVersion });
    }
    return desc;
  }
  const sameCatalog = (entry, desc) => desc.provider !== 'openai-codex' || entry?.catalogIdentity === desc.catalogIdentity;
  const sameRequest = (left, right) => left.identity === right.identity && left.catalogIdentity === right.catalogIdentity;
  function syncDisk() {
    try {
      const stat = fs.statSync(cachePath); const stamp = `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
      if (stamp !== diskStamp) {
        const disk = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
        if (disk.version === CACHE_VERSION && disk.providers && typeof disk.providers === 'object') {
          const hint = disk.codexVersionHint;
          if (hint && parseCodexVersion(hint.version) === hint.version && typeof hint.checkedAt === 'number'
              && (!codexVersionHint || hint.checkedAt > codexVersionHint.checkedAt)) {
            codexVersionHint = { ...hint, version: maxStableVersion(codexVersionHint?.version, hint.version) };
          }
          for (const [provider, value] of Object.entries(disk.providers)) {
            if (PROVIDERS.includes(provider) && Array.isArray(value.models) && typeof value.identity === 'string'
                && (!entries[provider] || value.checkedAt > entries[provider].checkedAt)) entries[provider] = value;
          }
          revision = Math.max(revision, disk.revision || 0); diskStamp = stamp;
        }
      }
    } catch (error) { if (error.code !== 'ENOENT') { /* A damaged cache cannot change configuration. */ } }
  }
  function persist() {
    syncDisk();
    fs.mkdirSync(path.dirname(cachePath), { recursive: true, mode: 0o700 });
    const temporary = `${cachePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try { fs.writeFileSync(temporary, JSON.stringify({ version: CACHE_VERSION, revision: ++revision, providers: entries, codexVersionHint }), { mode: 0o600 }); fs.renameSync(temporary, cachePath); diskStamp = null; }
    finally { try { fs.unlinkSync(temporary); } catch {} }
  }
  function configuration() { return { home: readYaml(path.join(home23Root, 'config', 'home.yaml')), secrets: readYaml(env.HOME23_SECRETS_PATH || path.join(home23Root, 'config', 'secrets.yaml')) }; }
  function refreshCodexVersionHint() {
    if (versionHintPending) return versionHintPending;
    if (codexVersionHint && now() - (codexVersionHint.attemptedAt || codexVersionHint.checkedAt) < (codexVersionHint.error ? 60_000 : MAX_AGE_MS)) return Promise.resolve();
    versionHintPending = (async () => {
      try {
        const version = await fetchCodexRegistryVersion(codexRegistryFetchImpl);
        codexVersionHint = { version: maxStableVersion(codexVersionHint?.version, version), checkedAt: now(), attemptedAt: now() };
      } catch {
        codexVersionHint = { version: maxStableVersion(codexVersionHint?.version), checkedAt: codexVersionHint?.checkedAt || 0, attemptedAt: now(), error: true };
      }
      try { persist(); } catch { /* Retain the non-secret version hint in memory on read-only homes. */ }
    })().finally(() => { versionHintPending = null; });
    return versionHintPending;
  }
  async function request(url, headers, body) {
    const response = await fetchImpl(url, { method: body ? 'POST' : 'GET', headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(12_000), redirect: 'error' });
    if (!response.ok) throw Object.assign(new Error('Provider model discovery failed'), { code: response.status === 401 || response.status === 403 ? 'model_discovery_auth' : `model_discovery_http_${response.status}` });
    return response.json();
  }
  async function discover(desc) {
    let token = desc.token; let account = desc.account;
    if (credentialsProvider) { const creds = await credentialsProvider(desc); token = creds?.accessToken || token; account = creds?.accountId || account; }
    else if (desc.managed && ['anthropic', 'openai-codex'].includes(desc.provider)) {
      const creds = await broker.credentials(desc.provider); token = creds?.accessToken || token; account = creds?.accountId || account;
    }
    const headers = token ? { authorization: `Bearer ${token}` } : {};
    if (desc.provider === 'anthropic') {
      headers['anthropic-version'] = '2023-06-01';
      if (desc.authMode === 'oauth') Object.assign(headers, { 'anthropic-beta': 'oauth-2025-04-20', 'user-agent': 'claude-cli/2.1.32 (external, cli)', 'x-app': 'cli', 'anthropic-dangerous-direct-browser-access': 'true' });
      else { delete headers.authorization; headers['x-api-key'] = token; }
    }
    if (desc.provider === 'openai-codex' && account) headers['chatgpt-account-id'] = account;
    let url = `${desc.base}${desc.provider === 'openai-codex' ? `/models?client_version=${encodeURIComponent(desc.catalogVersion)}` : desc.provider.startsWith('ollama-') ? '/api/tags' : desc.provider === 'xai' ? '/v1/language-models' : '/v1/models'}`;
    const rows = []; const cursors = new Set();
    for (let page = 0; page < 100; page++) {
      const wire = await request(url, headers);
      const list = wire.data || wire.models;
      if (!Array.isArray(list)) throw Object.assign(new Error('Invalid provider snapshot'), { code: 'model_snapshot_invalid' });
      rows.push(...list);
      if (!wire.has_more && !wire.next_page && !wire.next_cursor) break;
      const cursor = wire.last_id || wire.next_cursor || wire.next_page;
      if (!text(cursor) || cursors.has(cursor) || page === 99) throw Object.assign(new Error('Incomplete provider snapshot'), { code: 'model_snapshot_incomplete' });
      cursors.add(cursor); const next = new URL(url); next.searchParams.set('after_id', cursor); url = next.href;
    }
    if (desc.provider.startsWith('ollama-')) {
      // /show only reads installed/hosted metadata. A missing show result makes
      // the snapshot partial, so a transient metadata failure removes nothing.
      for (let i = 0; i < rows.length; i += 6) await Promise.all(rows.slice(i, i + 6).map(async row => {
        Object.assign(row, await request(`${desc.base}/api/show`, headers, { model: row.model || row.name }));
      }));
    }
    const normalized = rows.map(row => normalize(desc.provider, row)).filter(Boolean);
    const unique = new Map(normalized.map(row => [row.id, row]));
    return { models: [...unique.values()].filter(row => row.eligible), unclassifiedIds: [...unique.values()].filter(row => !row.eligible).map(row => row.id) };
  }
  function refresh(desc, force = false) {
    const old = entries[desc.provider];
    const requestIdentity = `${desc.identity}:${desc.catalogIdentity || ''}`;
    const sameAttempt = desc.provider !== 'openai-codex' || old?.attemptedCatalogIdentity === desc.catalogIdentity;
    if (!desc.configured || pending.has(requestIdentity) || (!force && old?.identity === desc.identity && sameAttempt && now() - (old.attemptedAt || 0) < (old.errorCode ? 60_000 : MAX_AGE_MS))) return pending.get(requestIdentity) || Promise.resolve();
    const operation = (async () => {
      try {
        const snapshot = await discover(desc);
        // A refresh started for a previous account must never replace its successor.
        const cfg = configuration(); const current = discoveryDescriptor(desc.provider, cfg.home.providers?.[desc.provider] || {}, cfg.secrets, cfg.home);
        if (!sameRequest(current, desc)) return;
        entries[desc.provider] = { identity: desc.identity,
          ...(desc.catalogIdentity ? { catalogIdentity: desc.catalogIdentity, attemptedCatalogIdentity: desc.catalogIdentity, catalogVersion: desc.catalogVersion } : {}),
          checkedAt: now(), attemptedAt: now(), ...snapshot };
      } catch (error) {
        try {
          const cfg = configuration(); const current = discoveryDescriptor(desc.provider, cfg.home.providers?.[desc.provider] || {}, cfg.secrets, cfg.home);
          if (!sameRequest(current, desc)) return;
        } catch {
          // A torn settings read must not let an older failure overwrite a
          // successful refresh that has already replaced its captured entry.
          if (entries[desc.provider] !== old) return;
        }
        entries[desc.provider] = { ...(old?.identity === desc.identity ? old : { identity: desc.identity, models: [], unclassifiedIds: [] }),
          ...(desc.catalogIdentity ? { attemptedCatalogIdentity: desc.catalogIdentity } : {}),
          attemptedAt: now(), errorCode: /^model_[a-z0-9_]+$/.test(error.code || '') ? error.code : 'model_discovery_unavailable' };
      }
      try { persist(); } catch { /* Read-only filesystems retain an in-memory snapshot. */ }
    })().finally(() => pending.delete(requestIdentity));
    pending.set(requestIdentity, operation); return operation;
  }
  function snapshot({ homeConfig, agentConfig = {}, refreshAutomatically = true } = {}) {
    syncDisk(); const cfg = configuration(); const home = homeConfig || cfg.home;
    const models = []; const providerStates = {}; const aliases = Object.create(null); const unavailableSelections = [];
    for (const provider of PROVIDERS) {
      if (!home.providers?.[provider]) continue;
      const config = home.providers[provider]; const desc = discoveryDescriptor(provider, config, cfg.secrets, home);
      const cached = entries[provider]?.identity === desc.identity ? entries[provider] : null;
      if (refreshAutomatically && provider === 'openai-codex' && desc.configured) void refreshCodexVersionHint().then(() => {
        const current = configuration();
        return refresh(discoveryDescriptor(provider, current.home.providers?.[provider] || {}, current.secrets, current.home));
      }).catch(() => {});
      if (refreshAutomatically) void refresh(desc).catch(() => {});
      const fresh = Boolean(cached?.checkedAt && !cached.errorCode && sameCatalog(cached, desc) && now() - cached.checkedAt < MAX_AGE_MS);
      providerStates[provider] = { state: !desc.configured ? 'unconfigured' : fresh ? 'fresh' : cached?.checkedAt ? 'stale' : 'loading', checkedAt: cached?.checkedAt ? new Date(cached.checkedAt).toISOString() : null, expiresAt: cached?.checkedAt ? new Date(cached.checkedAt + MAX_AGE_MS).toISOString() : null, errorCode: cached?.errorCode || null, modelCount: cached?.models.length || 0, unclassifiedCount: cached?.unclassifiedIds?.length || 0 };
      const fallback = (config.defaultModels || []).map(id => {
        const reviewed = reviewedReasoningCapabilities(provider, id);
        return { id, model: id, label: id, reasoningCapabilitiesKnown: false, reasoningEffortOptions: [], reasoningEfforts: [], defaultReasoningEffortOption: null, ...reviewed,
          ...(reviewed ? { reasoningEfforts: reviewed.reasoningEffortOptions.filter(v => LEGACY_EFFORTS.includes(v)) } : {}) };
      });
      const selected = desc.configured ? cached?.checkedAt ? cached.models : fallback : [];
      for (const row of selected) {
        const alias = `${provider}/${row.id}`;
        const publicRow = { ...row, provider, providerLabel: text(config.label) || LABELS[provider], kind: 'chat', alias, available: true, source: cached?.checkedAt ? 'provider-discovery' : 'configured', stale: !fresh };
        models.push(publicRow);
        aliases[alias] = { provider, model: row.id };
        registerModelCapabilities(provider, row.id, row);
      }
    }
    const scopedAliases = { ...home.models?.aliases };
    for (const [alias, value] of Object.entries(agentConfig.models?.aliases || {})) scopedAliases[alias] = { ...scopedAliases[alias], ...value };
    for (const [alias, pair] of Object.entries(scopedAliases)) {
      const row = models.find(value => value.provider === pair.provider && value.model === pair.model);
      if (row && (row.reasoningCapabilitiesKnown === false || !pair.reasoningEffort || row.reasoningEffortOptions.includes(pair.reasoningEffort))) aliases[alias] = { ...pair };
      else unavailableSelections.push({ ...pair, alias, available: false });
    }
    for (const chat of [home.chat, agentConfig.chat]) {
      const provider = chat?.defaultProvider || chat?.provider; const model = chat?.defaultModel || chat?.model;
      if (provider && model && !models.some(row => row.provider === provider && row.model === model) && !unavailableSelections.some(row => row.provider === provider && row.model === model)) unavailableSelections.push({ provider, model, available: false });
    }
    return { models, aliases, unavailableSelections, discovery: { revision: hash({ revision, models, providerStates }), refreshing: pending.size > 0, providers: providerStates } };
  }
  async function refreshAll({ force = false } = {}) {
    syncDisk(); let cfg = configuration();
    if (cfg.home.providers?.['openai-codex'] && descriptor('openai-codex', cfg.home.providers['openai-codex'], cfg.secrets, env).configured) {
      await refreshCodexVersionHint(); cfg = configuration();
    }
    await Promise.all(PROVIDERS.filter(p => cfg.home.providers?.[p]).map(p => refresh(discoveryDescriptor(p, cfg.home.providers[p], cfg.secrets, cfg.home), force)));
    return snapshot({ refreshAutomatically: false });
  }
  if (autoStart) { timer = setInterval(() => { try { snapshot(); } catch {} }, Math.min(intervalMs, MAX_AGE_MS)); timer.unref(); }
  return { snapshot, refreshAll, close() { clearInterval(timer); }, cachePath };
}
function getModelDiscovery(home23Root) { const root = path.resolve(home23Root); if (!services.has(root)) services.set(root, createModelDiscovery({ home23Root: root })); return services.get(root); }
function resolveProviderRequestConfig({ provider, home23Root = process.env.HOME23_ROOT || path.resolve(__dirname, '..'), fallbackConfig = {}, env = process.env } = {}) {
  const home = readYaml(path.join(home23Root, 'config', 'home.yaml'));
  const secrets = readYaml(env.HOME23_SECRETS_PATH || path.join(home23Root, 'config', 'secrets.yaml'));
  const value = descriptor(provider, home.providers?.[provider] || fallbackConfig, secrets, env);
  return { apiKey: value.token, baseUrl: value.base, identity: value.identity, accountId: value.account };
}
module.exports = { createModelDiscovery, getModelDiscovery, resolveProviderRequestConfig, normalizeProviderModel: normalize, MAX_AGE_MS, LEGACY_EFFORTS };
