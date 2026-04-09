// image-provider.js — CHAOS MODE image pipeline
// Preserves the exact algorithm from ARCHITECTURE_SPEC_v2.md §17
// Uses chat.completions throughout (NOT responses.create — not Ollama-compatible)
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { getOpenAIClient } = require('./openai-client');

// Config path relative to engine root
const CONFIG_PATH = path.join(__dirname, '..', '..', 'config', 'image.json');
const IMAGES_DIR = path.join(__dirname, '..', '..', 'data', 'images');

const DEFAULT_CONFIG = {
  active: 'openai',
  promptEngine: {
    provider: 'ollama',
    model: 'qwen3.5:4b',
    ollamaOptions: { think: false },
    fallback: { provider: 'openai', model: 'gpt-4o-mini' }
  },
  commentaryEngine: {
    provider: 'ollama',
    model: 'qwen3.5:4b',
    ollamaOptions: { think: false },
    fallback: { provider: 'openai', model: 'gpt-4o-mini' }
  },
  providers: {
    openai: { model: 'gpt-image-1', size: 'auto', quality: 'auto' }
  }
};

// ─── CHAOS MODE Category Pools (§17 — preserved verbatim) ─────────────────────
const IMAGE_CATEGORIES = {
  subjects: [
    'vintage typewriter','teacup','lighthouse','bicycle','tree house','sailing ship',
    'hot air balloon','library','waterfall','mountain cabin','garden gate','old bookstore',
    'wooden bridge','windmill','clock tower','fountain','train station','coffee shop',
    'beach pier','forest path','city street','park bench','flower market','bakery window',
    'coral reef','desert dune','canyon','northern lights','thunderstorm','rainbow',
    'butterfly','sea turtle','owl','fox','whale','peacock','hummingbird','koi fish',
    'violin','piano keys','vinyl record','paint brushes','camera','telescope',
    'compass','vintage map','hourglass','lantern','globe','chess pieces',
    'origami crane','pottery wheel','loom','vintage radio','film reel','music box',
    'stained glass','mosaic','tapestry','sculpture','architectural detail','doorway',
    'sushi plate','pasta dish','fruit bowl','herb garden','bread basket','tea ceremony',
    'autumn leaves','spring blossoms','winter frost','summer meadow','rain drops','dewdrops',
    'canyon sunset','ocean sunrise','mountain vista','city lights','starry night','moon phases',
    'abstract pattern','geometric shapes','flowing fabric','rippling water','flowing sand','smoke patterns'
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

// Subject history guard — in-memory, resets on restart (acceptable per §17)
const SUBJECT_HISTORY_LIMIT = 50;
const SUBJECT_MAX_ATTEMPTS = 5;
const subjectHistory = [];

function randomInt(n) { return crypto.randomInt(n); }
function randomPick(arr) { return arr[randomInt(arr.length)]; }

function selectRandomSubject() {
  const subjects = IMAGE_CATEGORIES.subjects;
  const maxAttempts = Math.min(SUBJECT_MAX_ATTEMPTS, subjects.length);
  let attempt = 0, subject;
  do {
    subject = subjects[randomInt(subjects.length)];
    attempt++;
  } while (subjectHistory.includes(subject) && attempt < maxAttempts);
  subjectHistory.push(subject);
  if (subjectHistory.length > SUBJECT_HISTORY_LIMIT) subjectHistory.shift();
  return subject;
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
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
    }
  } catch (e) {
    // Malformed JSON — fall through to defaults
  }
  return DEFAULT_CONFIG;
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

/**
 * createImageProvider() — factory that returns a provider instance
 */
function createImageProvider() {
  const config = loadConfig();

  /**
   * callPromptEngine(systemPrompt, userPrompt, jsonMode)
   * Uses Ollama (qwen3.5:4b) with think:false; falls back to gpt-4o-mini if Ollama unavailable.
   * jsonMode: if true, strips think tags and JSON.parses the result (throws on failure)
   */
  async function callPromptEngine(systemPrompt, userPrompt, jsonMode = false) {
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ];
    let text;
    try {
      text = await callOllama(
        config.promptEngine.model,
        messages,
        config.promptEngine.ollamaOptions || { think: false }
      );
    } catch (_ollamaErr) {
      // Ollama unavailable — fallback to OpenAI chat completions
      const fallbackModel = config.promptEngine.fallback?.model || 'gpt-4o-mini';
      const client = getOpenAIClient();
      const completion = await client.chat.completions.create({
        model: fallbackModel,
        messages
      });
      text = completion.choices[0]?.message?.content ?? '';
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
   * Same Ollama-first pattern as prompt engine, always returns string.
   */
  async function callCommentaryEngine(systemPrompt, userPrompt) {
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ];
    try {
      return await callOllama(
        config.commentaryEngine.model,
        messages,
        config.commentaryEngine.ollamaOptions || { think: false }
      );
    } catch (_ollamaErr) {
      const fallbackModel = config.commentaryEngine.fallback?.model || 'gpt-4o-mini';
      const client = getOpenAIClient();
      const completion = await client.chat.completions.create({
        model: fallbackModel,
        messages
      });
      return completion.choices[0]?.message?.content ?? '';
    }
  }

  /**
   * generate(prompt, options)
   * Calls OpenAI images.generate with gpt-image-1.
   * Saves PNG locally to data/images/{uuid}.png (no Supabase).
   * Returns normalized result: { url, b64, mimeType, provider, model, prompt, generatedAt, localPath }
   */
  async function generate(prompt, options = {}) {
    const active = options.provider || config.active || 'openai';
    const providerCfg = config.providers?.[active] || {};
    const model = options.model || providerCfg.model || 'gpt-image-1';
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
      // Download from URL if no b64
      const https = require('https');
      const http2 = require('http');
      const fetchLib = url.startsWith('https') ? https : http2;
      await new Promise((resolve, reject) => {
        fs.mkdirSync(IMAGES_DIR, { recursive: true });
        const filename = `${uuidv4()}.png`;
        localPath = path.join(IMAGES_DIR, filename);
        const file = fs.createWriteStream(localPath);
        fetchLib.get(url, (res) => res.pipe(file).on('finish', resolve).on('error', reject)).on('error', reject);
      });
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
    const { sensorContext } = opts;

    // Step 2: Select subject with history guard
    const subject    = selectRandomSubject();
    const style      = randomPick(IMAGE_CATEGORIES.styles);
    const lighting   = randomPick(IMAGE_CATEGORIES.lighting);
    const mood       = randomPick(IMAGE_CATEGORIES.moods);
    const composition = randomPick(IMAGE_CATEGORIES.compositions);

    // Step 3: 4 optional context overlays, each 40% chance
    // Weather overlay: use REAL sensor data if available, else random
    const contextHints = [];
    const timeContexts = ['dawn','morning','noon','afternoon','dusk','evening','midnight','night'];
    if (Math.random() < 0.4) contextHints.push(`time: ${randomPick(timeContexts)}`);

    // Sensor data (weather/sauna) is brain cognitive context only — not used in image prompts.
    // Use random evocative weather hints instead so temperatures never appear in images.
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

    // Brain thought adds a subtle thematic layer (not the literal subject)
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
