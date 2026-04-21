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
    openai: { model: 'gpt-image-1.5', size: 'auto', quality: 'auto' }
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
  const defaultModel = provider === 'minimax' ? 'image-01' : 'gpt-image-1.5';
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
  ]
};

// Subject dedup — shuffle-without-replacement. Goes through the entire
// pool before any subject can repeat. Resets only when fully exhausted.
let shuffledSubjects = [];
let shuffleIndex = 0;

function randomInt(n) { return crypto.randomInt(n); }
function randomPick(arr) { return arr[randomInt(arr.length)]; }

function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function selectRandomSubject() {
  if (shuffleIndex >= shuffledSubjects.length) {
    shuffledSubjects = shuffleArray(IMAGE_CATEGORIES.subjects);
    shuffleIndex = 0;
  }
  return shuffledSubjects[shuffleIndex++];
}

// CHAOS PROMPT ENGINE system prompt (§17 — preserved verbatim)
const CHAOS_PROMPT_ENGINE_SYSTEM = `You are CHAOS PROMPT ENGINE - wildly unpredictable but must output valid JSON.

Create bizarre, unexpected combinations by mixing the given elements in strange ways. Be creative and surprising, but keep it coherent enough for image generation.

Output as JSON with this structure:
{
  "prompt": "chaotic but valid description mixing elements creatively (150-200 chars)",
  "emphasis": "strange visual detail to emphasize"
}

Be unpredictable. Surprise with creativity. But output must be valid JSON.`;

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
    const model = options.model || providerCfg.model || 'gpt-image-1.5';
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
    // Step 2: Select subject with history guard
    const subject    = selectRandomSubject();
    const style      = randomPick(IMAGE_CATEGORIES.styles);
    const lighting   = randomPick(IMAGE_CATEGORIES.lighting);
    const mood       = randomPick(IMAGE_CATEGORIES.moods);
    const composition = randomPick(IMAGE_CATEGORIES.compositions);

    // Step 3: 4 optional context overlays, each 40% chance
    const contextHints = [];
    const timeContexts = ['dawn','morning','noon','afternoon','dusk','evening','midnight','night'];
    if (Math.random() < 0.4) contextHints.push(`time: ${randomPick(timeContexts)}`);

    if (Math.random() < 0.4) {
      const weatherContexts = ['crisp autumn air','sweltering summer heat','fresh spring breeze','bitter winter cold',
        'tropical humidity','desert dryness','mountain freshness','coastal mist'];
      contextHints.push(randomPick(weatherContexts));
    }

    const locationContexts = ['urban cityscape','peaceful countryside','rugged mountains','sandy beach',
      'dense forest','windswept plains','bustling marketplace','quiet library'];
    if (Math.random() < 0.4) contextHints.push(randomPick(locationContexts));

    const atmosphereContexts = ['sense of wonder','feeling of solitude','air of mystery','touch of magic',
      'hint of nostalgia','spark of creativity','whisper of adventure','echo of memories'];
    if (Math.random() < 0.4) contextHints.push(randomPick(atmosphereContexts));

    const thoughtHint = thought && thought.length > 20
      ? `\nTheme (subtle inspiration, do not illustrate literally): ${thought.slice(0, 120)}`
      : '';

    // Step 4: CHAOS PROMPT ENGINE — LLM assembles the final prompt
    const userPrompt = `Create an image prompt with these elements:

Subject: ${subject}
Style: ${style}
Lighting: ${lighting}
Mood: ${mood}
Composition: ${composition}${contextHints.length ? '\nContext: ' + contextHints.join(', ') : ''}${thoughtHint}

Combine these into a vivid, specific scene description. Respond in JSON format.`;

    let finalPrompt;
    try {
      const result = await callPromptEngine(CHAOS_PROMPT_ENGINE_SYSTEM, userPrompt, true);
      finalPrompt = `${result.prompt}. ${result.emphasis}`;
    } catch (err) {
      // Fallback: assemble prompt directly if LLM fails
      finalPrompt = `A ${mood} ${style} of ${subject} in ${lighting}${contextHints.length ? ', ' + contextHints[0] : ''}`;
    }

    // Step 5: Generate image via OpenAI
    return await generate(finalPrompt, {});
  }

  return { generate, generateChaos, callPromptEngine, callCommentaryEngine };
}

module.exports = { createImageProvider };
