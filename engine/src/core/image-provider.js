// image-provider.js — CHAOS MODE image pipeline
// Preserves the exact algorithm from ARCHITECTURE_SPEC_v2.md §17
// Uses chat.completions throughout (NOT responses.create — not Ollama-compatible)
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const OpenAI = require('openai');
const yaml = require('js-yaml');
const { v4: uuidv4 } = require('uuid');
const { getOpenAIClient } = require('./openai-client');

// Config path relative to engine root
const CONFIG_PATH = path.join(__dirname, '..', '..', 'config', 'image.json');
const IMAGES_DIR = path.join(__dirname, '..', '..', 'data', 'images');

const DEFAULT_CONFIG = {
  active: 'openai',
  promptEngine: {
    provider: 'openai',
    model: 'gpt-4o-mini',
    fallback: { provider: 'openai', model: 'gpt-4o-mini' }
  },
  commentaryEngine: {
    provider: 'openai',
    model: 'gpt-4o-mini',
    fallback: { provider: 'openai', model: 'gpt-4o-mini' }
  },
  providers: {
    openai: { model: 'gpt-image-2', size: 'auto', quality: 'auto' }
  }
};

function deepMerge(target, source) {
  const result = { ...(target || {}) };
  for (const [key, value] of Object.entries(source || {})) {
    if (
      result[key] && value &&
      typeof result[key] === 'object' && typeof value === 'object' &&
      !Array.isArray(result[key]) && !Array.isArray(value)
    ) {
      result[key] = deepMerge(result[key], value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function loadYamlFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return {};
  try {
    return yaml.load(fs.readFileSync(filePath, 'utf8')) || {};
  } catch {
    return {};
  }
}

function normalizeRemoteProvider(provider) {
  const value = String(provider || '').trim().toLowerCase();
  if (value === 'openai' || value === 'ollama-cloud' || value === 'minimax') return value;
  return null;
}

function pickFirstString(values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function resolveSystemRemoteProvider(homeConfig, agentConfig) {
  return normalizeRemoteProvider(
    agentConfig?.chat?.provider ||
    agentConfig?.chat?.defaultProvider ||
    homeConfig?.chat?.provider ||
    homeConfig?.chat?.defaultProvider
  );
}

function resolveModelForProvider(provider, engineConfig, homeConfig, agentConfig) {
  const engineProvider = normalizeRemoteProvider(engineConfig?.provider);
  if (engineProvider === provider && typeof engineConfig?.model === 'string' && engineConfig.model.trim()) {
    return engineConfig.model.trim();
  }

  const agentProvider = normalizeRemoteProvider(agentConfig?.chat?.provider || agentConfig?.chat?.defaultProvider);
  if (agentProvider === provider) {
    const agentModel = pickFirstString([agentConfig?.chat?.model, agentConfig?.chat?.defaultModel]);
    if (agentModel) return agentModel;
  }

  const homeProvider = normalizeRemoteProvider(homeConfig?.chat?.provider || homeConfig?.chat?.defaultProvider);
  if (homeProvider === provider) {
    const homeModel = pickFirstString([homeConfig?.chat?.model, homeConfig?.chat?.defaultModel]);
    if (homeModel) return homeModel;
  }

  const providerDefaults = Array.isArray(homeConfig?.providers?.[provider]?.defaultModels)
    ? homeConfig.providers[provider].defaultModels
    : [];
  const defaultModel = pickFirstString(providerDefaults);
  if (defaultModel) return defaultModel;

  return provider === 'ollama-cloud' ? 'kimi-k2.6' : 'gpt-4o-mini';
}

function resolveEngineConfig(engineConfig, homeConfig, agentConfig) {
  const selectedProvider =
    resolveSystemRemoteProvider(homeConfig, agentConfig) ||
    normalizeRemoteProvider(engineConfig?.provider) ||
    'openai';

  const selectedModel = resolveModelForProvider(selectedProvider, engineConfig, homeConfig, agentConfig);
  const baseFallback = engineConfig?.fallback || {};
  const fallbackProvider =
    (normalizeRemoteProvider(baseFallback.provider) && normalizeRemoteProvider(baseFallback.provider) !== selectedProvider)
      ? normalizeRemoteProvider(baseFallback.provider)
      : (selectedProvider === 'openai' ? 'ollama-cloud' : 'openai');

  const resolved = {
    ...(engineConfig || {}),
    provider: selectedProvider,
    model: selectedModel,
    fallback: {
      ...baseFallback,
      provider: fallbackProvider,
      model: resolveModelForProvider(fallbackProvider, baseFallback, homeConfig, agentConfig),
    },
  };

  const ollamaCloudBaseUrl = homeConfig?.providers?.['ollama-cloud']?.baseUrl || 'https://ollama.com/v1';
  if (resolved.provider === 'ollama-cloud') {
    resolved.baseUrl = resolved.baseUrl || ollamaCloudBaseUrl;
  }
  if (resolved.fallback.provider === 'ollama-cloud') {
    resolved.fallback.baseUrl = resolved.fallback.baseUrl || ollamaCloudBaseUrl;
  }

  return resolved;
}

function applyHome23ImageGenerationConfig(config, homeConfig) {
  const configured = homeConfig?.media?.imageGeneration || {};
  const provider = pickFirstString([configured.provider, config.active, 'openai']) || 'openai';
  const defaultModel = provider === 'minimax' ? 'image-01' : 'gpt-image-2';
  const model = pickFirstString([
    configured.model,
    config.providers?.[provider]?.model,
    defaultModel,
  ]) || defaultModel;

  config.active = provider;
  config.providers = config.providers || {};
  config.providers[provider] = {
    ...(config.providers[provider] || {}),
    model,
  };
}

// ─── CHAOS MODE Category Pools ────────────────────────────────────────────────
// Expanded from original 86 to 250+ subjects. Mix of concrete, abstract,
// surreal, scientific, cultural, and genuinely weird. The CHAOS PROMPT ENGINE
// remixes these — the stranger the seed, the wilder the output.
const IMAGE_CATEGORIES = {
  subjects: [
    // ── original pool (curated down) ──
    'vintage typewriter','lighthouse','bicycle','tree house','sailing ship',
    'hot air balloon','waterfall','mountain cabin','old bookstore',
    'windmill','clock tower','fountain','train station','coffee shop',
    'forest path','city street','flower market',
    'coral reef','desert dune','canyon','northern lights','thunderstorm',
    'butterfly','sea turtle','owl','fox','whale','peacock','hummingbird',
    'violin','piano keys','vinyl record','telescope',
    'compass','hourglass','lantern','chess pieces',
    'origami crane','pottery wheel','music box',
    'stained glass','mosaic','tapestry','sculpture',
    'tea ceremony','autumn leaves','spring blossoms',
    'canyon sunset','ocean sunrise','starry night',
    'geometric shapes','flowing fabric','smoke patterns',
    // ── machines + engineering ──
    'steam engine','tesla coil','clockwork automaton','gyroscope','astrolabe',
    'diesel locomotive','vacuum tube amplifier','mechanical calculator',
    'cathode ray tube','antikythera mechanism','difference engine','pipe organ',
    'radio telescope','particle accelerator','wind tunnel','loom shuttle',
    // ── science + nature deep cuts ──
    'tardigrade','axolotl','cuttlefish','venus flytrap','bioluminescent jellyfish',
    'praying mantis','bombardier beetle','leafcutter ant colony','mycelium network',
    'lichen on granite','tidal pool','volcanic vent','glacial crevasse',
    'stalactite cave','petrified forest','geode cross-section','obsidian flow',
    'solar flare','nebula nursery','pulsar beam','black hole accretion disk',
    'comet tail','meteor shower','ring system','tectonic fault line',
    // ── surreal + abstract ──
    'melting staircase','inside-out room','infinite corridor','floating island chain',
    'upside-down city','glass tornado','liquid metal sphere','fractal coastline',
    'impossible triangle','tesseract shadow','penrose stairs','klein bottle',
    'mandelbrot zoom','cellular automaton','reaction-diffusion pattern',
    'voronoi tessellation','strange attractor','lissajous curve',
    'crystal lattice','standing wave','interference pattern',
    'double pendulum trail','ferrofluid sculpture','cymatics pattern',
    // ── cultural artifacts ──
    'torii gate','minaret','gothic flying buttress','art deco elevator door',
    'neon-lit ramen shop','souq spice stall','venetian mask workshop',
    'mexican day of the dead altar','thai spirit house','moroccan zellige tile',
    'japanese rock garden','balinese offering','navajo loom','persian carpet detail',
    'west african kente cloth','scottish standing stone','inuit soapstone carving',
    'maori meeting house','aboriginal dot painting','tibetan prayer wheel',
    // ── urban + industrial ──
    'subway tunnel curve','fire escape shadow','water tower silhouette',
    'container ship deck','oil refinery at night','abandoned factory floor',
    'graffiti wall','rooftop garden','neon sign repair','laundromat at 2am',
    'parking garage spiral','construction crane ballet','power line geometry',
    'railroad switch yard','grain elevator','rust pattern on hull',
    // ── food + craft (specific, not generic) ──
    'sourdough scoring pattern','espresso crema','hand-thrown raku bowl',
    'blown glass in progress','blacksmith forge','letterpress type case',
    'bookbinding spine','darkroom enlarger','vinyl pressing plant',
    'cheese cave','fermentation crock','hand-rolled pasta shapes',
    'road-worn electric guitar','hollow-body guitar','amp stack glow',
    'concert handbill','tie-dyed parking lot','tape reel machine',
    // ── human experience ──
    'hands on piano keys','shadow on curtain','footprints in fresh snow',
    'breath in cold air','candlelit dinner for one','rain on window glass',
    'abandoned shoes on shore','kite caught in tree','chalk hopscotch fading',
    'swing set at dusk','tire swing over creek','campfire embers',
    // ── time + decay ──
    'rust eating iron','lichen reclaiming wall','roots splitting concrete',
    'sand reclaiming road','ice forming on chain','paint peeling in layers',
    'tide eroding cliff','termite architecture','coral bleaching',
    'patina on bronze','moss on tombstone','vine consuming building',
    // ── miniatures + scale ──
    'ant carrying leaf 100x its size','raindrop on spider web macro',
    'snowflake crystal macro','pollen grain electron microscope',
    'circuit board city from above','marble run kinetic sculpture',
    'bonsai forest','ship in bottle','terrarium ecosystem',
  ],
  styles: [
    'photorealistic','oil painting','watercolor','pencil sketch','ink drawing','charcoal',
    'impressionist','post-impressionist','art nouveau','art deco','minimalist','maximalist',
    'vintage photograph','polaroid','film noir','cinematic','documentary','portrait style',
    'landscape photography','macro photography','aerial view','wide angle','bokeh',
    'pastel colors','muted tones','vibrant colors','monochromatic','complementary colors',
    'japanese woodblock','chinese ink wash','persian miniature','mexican folk art',
    'scandinavian design','mid-century modern','bauhaus','arts and crafts','gothic',
    'renaissance','baroque','rococo','romantic','realist','surrealist','cubist',
    'studio ghibli style','pixar style','vintage poster','travel poster','botanical illustration'
  ],
  lighting: [
    'golden hour','blue hour','harsh midday sun','soft morning light','warm afternoon glow',
    'dramatic shadows','backlit','silhouette','rim lighting','dappled light',
    'overcast soft light','foggy atmosphere','misty','hazy','clear and bright',
    'candlelight','firelight','string lights','neon signs','moonlight','starlight',
    'diffused light','directional light','ambient light','volumetric rays','god rays'
  ],
  moods: [
    'peaceful','energetic','contemplative','joyful','mysterious','whimsical',
    'nostalgic','serene','dramatic','playful','elegant','cozy','fresh',
    'dreamy','crisp','warm','cool','intimate','grand','quiet','lively'
  ],
  compositions: [
    'centered','rule of thirds','symmetrical','asymmetrical','diagonal composition',
    'leading lines','framing','negative space','tight crop','wide shot',
    "bird's eye view","worm's eye view",'eye level','dutch angle','straight on'
  ],
  motifs: [
    'ritual', 'transmission', 'pilgrimage', 'surveillance', 'devotion',
    'signal loss', 'threshold', 'archive', 'afterimage', 'omens',
    'rehearsal', 'static prayer', 'countercurrent memory', 'transit shrine',
  ],
  materiality: [
    'wet glass', 'oxidized brass', 'velvet dust', 'paper grain',
    'smoked chrome', 'cracked porcelain', 'sun-bleached wood',
    'fogged mirror', 'static haze', 'frosted metal',
    'aged lacquer', 'tape hiss residue', 'cedar heat', 'road grit',
  ],
  temporalStates: [
    'just before opening', 'after the storm', 'mid-evaporation',
    'abandoned but warm', 'caught in rehearsal', 'end of summer',
    'minutes before dawn', 'half-remembered', 'post-impact silence',
    'after the encore', 'between soundcheck and nightfall', 'still cooling down',
  ],
  symbolicCharges: [
    'longing', 'containment', 'invocation', 'misdirection',
    'private ceremony', 'public signal', 'reconstruction', 'witness',
    'return', 'convergence', 'vigil', 'release',
  ],
  culturalSignals: [
    'Jerry Garcia guitar phrasing',
    'Grateful Dead parking-lot residue',
    'rose-and-lightning iconography',
    'amp glow and tape hiss',
    'counterculture relic atmosphere',
    'faded concert handbill energy',
    'traveling-carnival Americana',
    'rehearsal-room devotion',
  ]
};

const AXIS_HISTORY_LIMITS = Object.freeze({
  subject: 60,
  style: 24,
  lighting: 24,
  mood: 24,
  composition: 24,
  motif: 18,
  materiality: 18,
  temporal_state: 18,
  symbolic_charge: 18,
  cultural_signal: 18,
});

const axisHistory = Object.fromEntries(
  Object.keys(AXIS_HISTORY_LIMITS).map((axis) => [axis, []]),
);

function randomInt(n) { return crypto.randomInt(n); }
function randomPick(arr) { return arr[randomInt(arr.length)]; }

function chance(probability) {
  return Math.random() < probability;
}

function rememberAxis(axis, value) {
  if (!value || !axisHistory[axis]) return;
  axisHistory[axis].push(value);
  const limit = AXIS_HISTORY_LIMITS[axis] || 18;
  while (axisHistory[axis].length > limit) axisHistory[axis].shift();
}

function recentCount(axis, value) {
  const history = axisHistory[axis] || [];
  return history.filter((entry) => entry === value).length;
}

function clampText(text, maxLen = 120) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  return clean.length > maxLen ? `${clean.slice(0, maxLen).trim()}...` : clean;
}

function normalizeNegative(text) {
  const clean = clampText(text, 140);
  if (!clean) return '';
  return clean.replace(/^avoid\s+/i, '').trim();
}

function negativeInstruction(text) {
  const negative = normalizeNegative(text);
  if (!negative) return '';
  if (/^no\s+/i.test(negative)) return `Exclude ${negative.replace(/^no\s+/i, '').trim()}`;
  return `Avoid ${negative}`;
}

function tokenize(text) {
  return new Set(
    String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length > 2),
  );
}

function hasAnyToken(signalSet, tokens) {
  return tokens.some((token) => signalSet.has(token));
}

function weightedChoice(items, getWeight) {
  const weighted = [];
  let total = 0;
  for (const item of items) {
    const weight = Math.max(0, Number(getWeight(item)) || 0);
    if (weight <= 0) continue;
    weighted.push({ item, weight });
    total += weight;
  }
  if (!weighted.length || total <= 0) return null;
  let cursor = Math.random() * total;
  for (const entry of weighted) {
    cursor -= entry.weight;
    if (cursor <= 0) return entry.item;
  }
  return weighted[weighted.length - 1].item;
}

function buildSignalSet({ thought, brainContext, sensorPoetics }) {
  const combined = [
    thought,
    brainContext?.latestThought,
    brainContext?.theme,
    ...(brainContext?.themeSupport || []),
    ...(brainContext?.topConcepts || []),
    ...(brainContext?.activeGoals || []),
    ...(brainContext?.dreamMotifs || []),
    sensorPoetics,
    'jerry garcia grateful dead guitar americana tape amp rose lightning',
  ].filter(Boolean).join(' ');
  return tokenize(combined);
}

function contextWeight(axis, item, signalSet) {
  const itemTokens = [...tokenize(item)];
  if (!itemTokens.length) return 1;
  let weight = 1;
  const overlap = itemTokens.filter((token) => signalSet.has(token)).length;
  if (overlap > 0) weight += overlap * 0.65;

  const deadSignal = hasAnyToken(signalSet, ['jerry', 'garcia', 'grateful', 'dead', 'guitar', 'americana', 'amp', 'lightning']);

  const lower = item.toLowerCase();
  if ((lower.includes('guitar') || lower.includes('amp') || lower.includes('concert') || lower.includes('parking-lot')) &&
      deadSignal) {
    weight *= axis === 'subject' ? 3.1 : 2.3;
  }
  if (axis === 'cultural_signal' && deadSignal) {
    weight *= 2.8;
  }
  if (axis === 'temporal_state' && deadSignal &&
      (lower.includes('encore') || lower.includes('soundcheck') || lower.includes('rehearsal'))) {
    weight *= 2.0;
  }
  if (axis === 'materiality' && deadSignal &&
      (lower.includes('tape hiss') || lower.includes('road grit') || lower.includes('aged lacquer') || lower.includes('cedar heat'))) {
    weight *= 1.8;
  }
  if ((lower.includes('archive') || lower.includes('afterimage') || lower.includes('paper') || lower.includes('handbill')) &&
      (signalSet.has('archive') || signalSet.has('memory') || signalSet.has('remembered') || signalSet.has('borrowed'))) {
    weight *= 1.4;
  }
  if ((lower.includes('warm') || lower.includes('firelight') || lower.includes('cedar')) &&
      (signalSet.has('warmth') || signalSet.has('sauna') || signalSet.has('heat'))) {
    weight *= 1.35;
  }
  if ((lower.includes('cold') || lower.includes('mist') || lower.includes('frost')) &&
      (signalSet.has('cold') || signalSet.has('chill') || signalSet.has('storm') || signalSet.has('dormant'))) {
    weight *= 1.35;
  }
  return weight;
}

function chooseAxis(axis, items, signalSet) {
  const choice = weightedChoice(items, (item) => {
    let weight = contextWeight(axis, item, signalSet);
    const repeats = recentCount(axis, item);
    if (repeats > 0) {
      weight *= axis === 'subject' ? 0.08 : 0.32 / repeats;
    }
    return weight;
  }) || randomPick(items);
  rememberAxis(axis, choice);
  return choice;
}

function sensorDataToPoetics(sensorData) {
  if (!sensorData || typeof sensorData !== 'object') return null;

  const phrases = [];
  const outdoor = sensorData.weather?.outdoor || {};
  const wind = sensorData.weather?.wind || {};
  const solar = sensorData.weather?.solar || {};
  const sauna = sensorData.sauna || {};
  const pressure = sensorData.pressure || {};

  const temp = Number(outdoor.temperature);
  const humidity = Number(outdoor.humidity);
  const windSpeed = Number(wind.speed);
  const uv = Number(solar.uv);
  const pressureInhg = Number(pressure.pressure_inhg);

  if (Number.isFinite(temp)) {
    if (temp <= 42) phrases.push('outside chill held in clear air');
    else if (temp <= 55) phrases.push('cold clear air with dormant light');
    else if (temp >= 82) phrases.push('heat hanging in the air');
  }
  if (Number.isFinite(humidity)) {
    if (humidity >= 75) phrases.push('heavy damp atmosphere');
    else if (humidity <= 32) phrases.push('dry static air');
  }
  if (Number.isFinite(windSpeed)) {
    if (windSpeed >= 16) phrases.push('restless wind working the edges');
    else if (windSpeed >= 8) phrases.push('light movement in the air');
  }
  if (Number.isFinite(uv)) {
    if (uv <= 1) phrases.push('dormant light');
    else if (uv >= 6) phrases.push('hard bright light');
  }
  if (Number.isFinite(pressureInhg)) {
    if (pressureInhg <= 29.75) phrases.push('storm-pressure tension');
    else if (pressureInhg >= 30.1) phrases.push('settled barometric calm');
  }

  if (sauna.isHeating) {
    phrases.push('sealed cedar warmth against the outside chill');
  } else if (sauna.isLocked) {
    phrases.push('occupied heat held behind wood and glass');
  } else if (Number(sauna.temperature) > 145) {
    phrases.push('stored heat fading from cedar walls');
  }

  const unique = [...new Set(phrases)].slice(0, 3);
  return unique.length ? unique.join(', ') : null;
}

const CHAOS_PROMPT_ENGINE_SYSTEM = `You are a visual prompt composer.

You receive structured ingredients for an image. Turn them into one coherent, vivid, non-generic image prompt.

Rules:
- Keep one dominant object or setting.
- Use the thought only as thematic pressure, never literal illustration.
- Convert live context into atmosphere.
- Do not mention telemetry, temperatures, humidity, pressure, UV, or raw numbers.
- Do not introduce people, children, musicians, or characters unless the selected subject explicitly requires a human figure.
- Prefer one surprising concrete detail, not a pile of weirdness.
- Avoid generic fantasy/cosmic adjectives unless directly earned by the ingredients.
- Keep the image physically legible.
- Output valid JSON only.

Return:
{
  "prompt": "final image prompt, 140-220 chars",
  "emphasis": "one strange concrete detail",
  "negative": "things to avoid",
  "title": "short internal label",
  "used": {
    "subject": "",
    "style": "",
    "lighting": "",
    "mood": "",
    "composition": "",
    "motif": "",
    "materiality": "",
    "temporal_state": "",
    "symbolic_charge": "",
    "sensor_poetics": "",
    "brain_theme": "",
    "cultural_signal": ""
  }
}`;

/**
 * Load image config from config/image.json (falls back to defaults if missing)
 */
function loadConfig(runtime = {}) {
  let config = deepMerge(DEFAULT_CONFIG, {});
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const fileConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      config = deepMerge(config, fileConfig);
    }
  } catch (e) {
    // Malformed JSON — fall through to defaults
  }

  if (runtime.home23Root) {
    const homeConfig = loadYamlFile(path.join(runtime.home23Root, 'config', 'home.yaml'));
    const agentConfig = runtime.agentName
      ? loadYamlFile(path.join(runtime.home23Root, 'instances', runtime.agentName, 'config.yaml'))
      : {};
    config.promptEngine = resolveEngineConfig(config.promptEngine, homeConfig, agentConfig);
    config.commentaryEngine = resolveEngineConfig(config.commentaryEngine, homeConfig, agentConfig);
    applyHome23ImageGenerationConfig(config, homeConfig);
  }

  return config;
}

/**
 * Strip <think>...</think> tags from Ollama qwen3 output before JSON parsing
 */
function stripThinkTags(text) {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

/**
 * Call Ollama chat endpoint directly via fetch (avoids OpenAI SDK baseURL issues)
 */
async function callOllama(model, messages, options = {}) {
  const body = JSON.stringify({ model, messages, options, stream: false });
  const response = await fetch((process.env.OLLAMA_URL || 'http://127.0.0.1:11434') + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal: AbortSignal.timeout(30000)
  });
  if (!response.ok) throw new Error(`Ollama HTTP ${response.status}`);
  const data = await response.json();
  return data.message?.content ?? '';
}

async function callOpenAICompatibleChat({ apiKey, baseURL, model, messages }) {
  const client = new OpenAI({ apiKey, baseURL });
  const completion = await client.chat.completions.create({ model, messages });
  return completion.choices[0]?.message?.content ?? '';
}

async function runTextEngine(engineConfig, messages) {
  const provider = String(engineConfig?.provider || 'openai').toLowerCase();
  const model = engineConfig?.model || 'gpt-4o-mini';

  if (provider === 'openai') {
    const client = getOpenAIClient();
    const completion = await client.chat.completions.create({ model, messages });
    return completion.choices[0]?.message?.content ?? '';
  }

  if (provider === 'ollama-cloud') {
    const apiKey = engineConfig?.apiKey || process.env.OLLAMA_CLOUD_API_KEY;
    const baseURL = engineConfig?.baseUrl || process.env.OLLAMA_CLOUD_BASE_URL || 'https://ollama.com/v1';
    if (!apiKey) throw new Error('OLLAMA_CLOUD_API_KEY missing');
    return callOpenAICompatibleChat({ apiKey, baseURL, model, messages });
  }

  if (provider === 'ollama' || provider === 'ollama-local') {
    throw new Error('Local Ollama is disabled for Home23 Vibe. Use ollama-cloud or openai.');
  }

  throw new Error(`Unsupported prompt engine provider: ${provider}`);
}

/**
 * createImageProvider() — factory that returns a provider instance
 */
function createImageProvider(runtime = {}) {
  const getConfig = () => loadConfig(runtime);

  /**
   * callPromptEngine(systemPrompt, userPrompt, jsonMode)
   * Uses the resolved remote text provider (`ollama-cloud` or `openai`) with a remote fallback.
   * jsonMode: if true, strips think tags and JSON.parses the result (throws on failure)
   */
  async function callPromptEngine(systemPrompt, userPrompt, jsonMode = false) {
    const config = getConfig();
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ];
    let text;
    try {
      text = await runTextEngine(config.promptEngine, messages);
    } catch (_promptErr) {
      text = await runTextEngine(config.promptEngine.fallback || { provider: 'openai', model: 'gpt-4o-mini' }, messages);
    }

    if (jsonMode) {
      const cleaned = stripThinkTags(text);
      try {
        return JSON.parse(cleaned);
      } catch (e) {
        throw new Error(`Prompt engine returned non-JSON: ${cleaned.slice(0, 200)}`);
      }
    }
    return text;
  }

  /**
   * callCommentaryEngine(systemPrompt, userPrompt)
   * Same remote-only provider pattern as prompt engine, always returns string.
   */
  async function callCommentaryEngine(systemPrompt, userPrompt) {
    const config = getConfig();
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ];
    try {
      return await runTextEngine(config.commentaryEngine, messages);
    } catch (_commentaryErr) {
      return await runTextEngine(config.commentaryEngine.fallback || { provider: 'openai', model: 'gpt-4o-mini' }, messages);
    }
  }

  /**
   * generate(prompt, options)
   * Calls OpenAI images.generate with the configured GPT Image / DALL-E model.
   * Saves PNG locally to data/images/{uuid}.png (no Supabase).
   * Returns normalized result: { url, b64, mimeType, provider, model, prompt, generatedAt, localPath }
   */
  function sizeToAspectRatio(size) {
    if (!size) return undefined;
    const map = {
      '1024x1024': '1:1', '1536x1024': '3:2', '1024x1536': '2:3',
      '1792x1024': '16:9', '1024x1792': '9:16',
      '16:9': '16:9', '9:16': '9:16', '4:3': '4:3', '3:4': '3:4',
      '1:1': '1:1', '3:2': '3:2', '2:3': '2:3', '21:9': '21:9',
    };
    return map[size] || undefined;
  }

  async function downloadImageToLocal(url) {
    fs.mkdirSync(IMAGES_DIR, { recursive: true });
    const filename = `${uuidv4()}.png`;
    const localPath = path.join(IMAGES_DIR, filename);
    const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error(`Image download failed: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(localPath, buf);
    return localPath;
  }

  async function generateMiniMax(prompt, options = {}) {
    const config = getConfig();
    const providerCfg = config.providers?.minimax || {};
    const model = options.model || providerCfg.model || 'image-01';
    const apiKey = process.env.MINIMAX_API_KEY || '';
    if (!apiKey) throw new Error('MINIMAX_API_KEY not configured');

    const body = { model, prompt, n: 1, response_format: 'url' };
    const aspect = sizeToAspectRatio(options.size || providerCfg.size);
    if (aspect) body.aspect_ratio = aspect;

    const res = await fetch('https://api.minimax.io/v1/image_generation', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120000),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`MiniMax Image API error: HTTP ${res.status} — ${errText.slice(0, 300)}`);
    }

    const data = await res.json();
    const imageUrl = data.data?.image_urls?.[0];
    if (!imageUrl) throw new Error('No image URL in MiniMax response');

    const localPath = await downloadImageToLocal(imageUrl);

    if (localPath) {
      const metaPath = localPath.replace(/\.(png|jpg|jpeg)$/, '.json');
      fs.writeFileSync(metaPath, JSON.stringify({
        thought: prompt, generatedAt: new Date().toISOString(),
        provider: 'minimax', model,
      }));
    }

    return {
      url: imageUrl, b64: null, mimeType: 'image/png',
      provider: 'minimax', model, prompt,
      generatedAt: new Date().toISOString(), localPath,
    };
  }

  async function generate(prompt, options = {}) {
    const config = getConfig();
    const active = options.provider || config.active || 'openai';

    if (active === 'minimax') {
      return generateMiniMax(prompt, options);
    }

    const providerCfg = config.providers?.[active] || {};
    const model = options.model || providerCfg.model || 'gpt-image-2';
    const size = options.size || providerCfg.size || 'auto';
    const quality = options.quality || providerCfg.quality || 'auto';

    const client = getOpenAIClient();
    const response = await client.images.generate({
      model,
      prompt,
      size,
      quality,
      output_format: 'png',
      n: 1
    });

    const imgData = response.data?.[0];
    const b64 = imgData?.b64_json ?? null;
    const url = imgData?.url ?? null;
    const mimeType = 'image/png';

    let localPath = null;
    if (b64) {
      fs.mkdirSync(IMAGES_DIR, { recursive: true });
      const filename = `${uuidv4()}.png`;
      localPath = path.join(IMAGES_DIR, filename);
      fs.writeFileSync(localPath, Buffer.from(b64, 'base64'));
    } else if (url) {
      localPath = await downloadImageToLocal(url);
    }

    // Write companion metadata file for dashboard caption
    if (localPath) {
      const metaPath = localPath.replace(/\.(png|jpg|jpeg)$/, '.json');
      fs.writeFileSync(metaPath, JSON.stringify({ thought: prompt, generatedAt: new Date().toISOString(), provider: active, model }));
    }

    return {
      url,
      b64,
      mimeType,
      provider: active,
      model,
      prompt,
      generatedAt: new Date().toISOString(),
      localPath
    };
  }

  /**
   * generateChaos(thought, opts) — Full CHAOS MODE pipeline (§17)
   * thought: optional — blended in as emphasis context for the CHAOS PROMPT ENGINE
   * opts.sensorContext: optional — real weather/sauna string (replaces random weather overlay)
   * Uses the 5-dimension + 4-overlay assembly + CHAOS PROMPT ENGINE LLM call.
   * Saves locally, writes metadata JSON.
   */
async function generateChaos(thought, opts = {}) {
    const brainContext = opts.brainContext || {};
    const sensorPoetics = chance(0.4) ? sensorDataToPoetics(opts.sensorData || brainContext.sensorData) : null;
    const signalSet = buildSignalSet({ thought, brainContext, sensorPoetics });
    const deadSignal = hasAnyToken(signalSet, ['jerry', 'garcia', 'grateful', 'dead', 'guitar', 'americana', 'amp', 'lightning']);

    const subject = chooseAxis('subject', IMAGE_CATEGORIES.subjects, signalSet);
    const style = chooseAxis('style', IMAGE_CATEGORIES.styles, signalSet);
    const lighting = chooseAxis('lighting', IMAGE_CATEGORIES.lighting, signalSet);
    const mood = chooseAxis('mood', IMAGE_CATEGORIES.moods, signalSet);
    const composition = chooseAxis('composition', IMAGE_CATEGORIES.compositions, signalSet);

    const motif = chance(0.30) ? chooseAxis('motif', IMAGE_CATEGORIES.motifs, signalSet) : null;
    const materiality = chance(0.45) ? chooseAxis('materiality', IMAGE_CATEGORIES.materiality, signalSet) : null;
    const temporalState = chance(0.35) ? chooseAxis('temporal_state', IMAGE_CATEGORIES.temporalStates, signalSet) : null;
    const symbolicCharge = chance(0.25) ? chooseAxis('symbolic_charge', IMAGE_CATEGORIES.symbolicCharges, signalSet) : null;
    const culturalSignal = chance(deadSignal ? 0.55 : 0.30)
      ? chooseAxis('cultural_signal', IMAGE_CATEGORIES.culturalSignals, signalSet)
      : null;

    const contextHints = [];
    if (sensorPoetics) contextHints.push(sensorPoetics);
    const locationContexts = ['urban cityscape', 'peaceful countryside', 'rugged mountains', 'quiet roadside town', 'neon roadside lot', 'quiet library'];
    if (chance(0.35)) contextHints.push(randomPick(locationContexts));
    const atmosphereContexts = ['a held-breath stillness', 'after-hours calm', 'soft public glow', 'private ceremony', 'restless anticipation'];
    if (chance(0.35)) contextHints.push(randomPick(atmosphereContexts));

    const brainTheme = clampText(brainContext.theme || thought || '', 120);
    const support = (brainContext.themeSupport || []).map((item) => clampText(item, 60)).filter(Boolean).slice(0, 3);
    const dreamMotifs = chance(0.15)
      ? (brainContext.dreamMotifs || []).map((item) => clampText(item, 60)).filter(Boolean).slice(0, 1)
      : [];

    const ingredients = {
      subject,
      style,
      lighting,
      mood,
      composition,
      motif,
      materiality,
      temporal_state: temporalState,
      symbolic_charge: symbolicCharge,
      sensor_poetics: sensorPoetics,
      brain_theme: brainTheme || null,
      cultural_signal: culturalSignal,
      support,
      dream_motifs: dreamMotifs,
      context_hints: contextHints,
    };

    const userPrompt = `Compose one image prompt from these ingredients.

Core axes:
- Subject: ${subject}
- Style: ${style}
- Lighting: ${lighting}
- Mood: ${mood}
- Composition: ${composition}

Optional modifiers:
- Motif: ${motif || '(omit)'}
- Materiality: ${materiality || '(omit)'}
- Temporal state: ${temporalState || '(omit)'}
- Symbolic charge: ${symbolicCharge || '(omit)'}
- Cultural signal: ${culturalSignal || '(omit)'}
- Sensor poetics: ${sensorPoetics || '(omit)'}
- Brain theme: ${brainTheme || '(omit)'}
- Theme support: ${support.length ? support.join(', ') : '(omit)'}
- Dream motifs (low priority): ${dreamMotifs.length ? dreamMotifs.join(', ') : '(omit)'}
- Context hints: ${contextHints.length ? contextHints.join(', ') : '(omit)'}

Anti-slop constraints:
- Do not illustrate the thought literally.
- Do not mention numbers or telemetry.
- Do not invent people or children unless the subject is explicitly human.
- Treat dream motifs as faint background tint only.
- Prefer one dominant scene.
- Prefer one surprising detail, not five.
- Avoid generic fantasy mush.
- Keep the scene physically legible.`;

    let finalPrompt;
    let chaosMeta;
    try {
      const result = await callPromptEngine(CHAOS_PROMPT_ENGINE_SYSTEM, userPrompt, true);
      const used = {
        subject,
        style,
        lighting,
        mood,
        composition,
        motif,
        materiality,
        temporal_state: temporalState,
        symbolic_charge: symbolicCharge,
        sensor_poetics: sensorPoetics,
        brain_theme: brainTheme || null,
        cultural_signal: culturalSignal,
      };
      if (result?.used && typeof result.used === 'object') {
        for (const [key, value] of Object.entries(result.used)) {
          if (used[key]) continue;
          const cleaned = clampText(value, 120);
          if (cleaned) used[key] = cleaned;
        }
      }
      const emphasis = clampText(result?.emphasis || '', 100);
      const negative = normalizeNegative(result?.negative || '');
      finalPrompt = clampText(result?.prompt || '', 320);
      if (emphasis) finalPrompt = `${finalPrompt}. ${emphasis}`;
      if (negative) finalPrompt = `${finalPrompt}. ${negativeInstruction(negative)}`;
      chaosMeta = {
        version: 'chaos-v2',
        title: clampText(result?.title || '', 80) || 'Chaos V2',
        negative,
        used,
        ingredients,
      };
    } catch (err) {
      finalPrompt = `A ${mood} ${style} ${subject} in ${lighting}, ${composition}${motif ? `, shaped by ${motif}` : ''}${materiality ? `, with ${materiality}` : ''}${temporalState ? `, ${temporalState}` : ''}${symbolicCharge ? `, carrying ${symbolicCharge}` : ''}${culturalSignal ? `, touched by ${culturalSignal}` : ''}${sensorPoetics ? `, inside ${sensorPoetics}` : ''}`;
      chaosMeta = {
        version: 'chaos-v2',
        title: clampText(subject, 80) || 'Chaos V2',
        negative: 'generic fantasy mush, literal illustration, cluttered symbolism',
        used: {
          subject,
          style,
          lighting,
          mood,
          composition,
          motif,
          materiality,
          temporal_state: temporalState,
          symbolic_charge: symbolicCharge,
          sensor_poetics: sensorPoetics,
          brain_theme: brainTheme || null,
          cultural_signal: culturalSignal,
        },
        ingredients,
      };
    }

    const image = await generate(finalPrompt, {});
    return {
      ...image,
      chaos: chaosMeta,
    };
  }

  return { generate, generateChaos, callPromptEngine, callCommentaryEngine };
}

module.exports = { createImageProvider };
