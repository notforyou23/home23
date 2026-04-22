'use strict';

const fs = require('fs');
const fsp = require('fs').promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const yaml = require('js-yaml');
const { createImageProvider } = require('../../core/image-provider');

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const DEFAULT_GALLERY_LIMIT = 60;
const DEFAULT_GENERATION_INTERVAL_HOURS = 12;
const DEFAULT_ROTATION_INTERVAL_SECONDS = 45;
const MIN_GENERATION_INTERVAL_HOURS = 1;
const MIN_ROTATION_INTERVAL_SECONDS = 15;
const AUTO_RETRY_BACKOFF_MS = 30 * 60 * 1000;

const DEFAULT_VIBE_CONFIG = Object.freeze({
  autoGenerate: true,
  generationIntervalHours: DEFAULT_GENERATION_INTERVAL_HOURS,
  rotationIntervalSeconds: DEFAULT_ROTATION_INTERVAL_SECONDS,
  galleryLimit: DEFAULT_GALLERY_LIMIT,
  sourcePaths: [],
  dreams: {
    enabled: true,
    lookback: 3,
    extraction: 'heuristic',
  },
});

const JSONL_TAIL_BYTES = 256 * 1024;
const DREAM_INFLUENCE_CHANCE = 0.15;
const DREAM_MOTIF_LIMIT = 1;
const STOP_WORDS = new Set([
  'a', 'an', 'of', 'on', 'to', 'in', 'at', 'for', 'by', 'off', 'out', 'up',
  'the', 'and', 'that', 'with', 'from', 'into', 'your', 'their', 'this', 'there', 'where',
  'have', 'been', 'were', 'what', 'when', 'just', 'like', 'through', 'between', 'would',
  'about', 'because', 'while', 'after', 'before', 'under', 'over', 'against', 'still',
  'somewhere', 'someone', 'something', 'everything', 'nothing', 'yesterday', 'today',
  'ordinary', 'really', 'could', 'should', 'does', 'doing', 'being', 'itself', 'it', 'its',
  'you', 'are', 'was', 'him', 'her', 'his', 'hers', 'they', 'them', 'our', 'ours', 'yourself',
  'ourselves', 'myself', 'mine', 'ours', 'also', 'than', 'then', 'them', 'those', 'these',
  'very', 'more', 'most', 'ever', 'only', 'even', 'here', 'across', 'inside', 'outside',
  'which', 'while', 'each', 'other', 'another', 'same', 'exactly', 'again', 'finally',
  'became', 'become', 'until', 'toward', 'towards', 'onto', 'upon', 'some', 'many', 'much',
  'such', 'place', 'thing', 'things', 'kind', 'part', 'parts', 'form', 'forms', 'body',
  'name', 'names', 'dream', 'dreamed', 'dreaming', 'dreams',
  'tried', 'read',
]);
const MOTIF_BLOCKLIST = new Set([
  'i', 'me', 'my', 'mine', 'we', 'us', 'our', 'ours', 'you', 'your', 'yours',
  'he', 'him', 'his', 'she', 'her', 'hers', 'they', 'them', 'their', 'theirs',
  'who', 'whom', 'whose', 'both', 'either', 'neither',
  'holding', 'trying', 'tried', 'read', 'reading', 'looked', 'looking',
  'walked', 'walking', 'said', 'saying', 'felt', 'feeling',
]);
const HUMAN_HINT_WORDS = new Set([
  'child', 'children', 'kid', 'kids', 'boy', 'girl', 'woman', 'women', 'man', 'men',
  'person', 'people', 'musician', 'father', 'mother', 'grandmother', 'grandfather',
  'stranger', 'visitor', 'curator', 'cathedral', 'pigeons',
]);
const ACTION_HINT_WORDS = new Set([
  'is', 'are', 'was', 'were', 'be', 'being', 'been',
  'running', 'turning', 'plays', 'playing', 'asked', 'asking', 'holding', 'carrying',
  'remembering', 'forgetting', 'dreaming', 'listening', 'walking', 'woke', 'waking',
  'looks', 'looking', 'watched', 'watching', 'arrive', 'arriving', 'leave', 'leaving',
]);

function expandPath(p) {
  if (!p || typeof p !== 'string') return '';
  const trimmed = p.trim();
  if (!trimmed) return '';
  if (trimmed === '~') return os.homedir();
  if (trimmed.startsWith('~/')) return path.join(os.homedir(), trimmed.slice(2));
  return trimmed;
}

function normalizeSourcePaths(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const seen = new Set();
  const out = [];
  for (const entry of list) {
    const expanded = expandPath(entry);
    if (!expanded) continue;
    const resolved = path.resolve(expanded);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    out.push(resolved);
  }
  return out;
}

function toArray(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return Object.values(value);
  return [];
}

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
  if (!fs.existsSync(filePath)) return {};
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return yaml.load(raw) || {};
  } catch {
    return {};
  }
}

function positiveNumber(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : fallback;
}

function normalizeThought(text, maxLen = 200) {
  const clean = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > maxLen ? `${clean.slice(0, maxLen).trim()}...` : clean;
}

function isoNow() {
  return new Date().toISOString();
}

function readJsonFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

async function readLastJsonLines(filePath, limit = 1, windowBytes = JSONL_TAIL_BYTES) {
  if (!fs.existsSync(filePath) || limit <= 0) return [];
  let handle;
  try {
    const stat = await fsp.stat(filePath);
    const readStart = Math.max(0, stat.size - windowBytes);
    const readLength = stat.size - readStart;
    const buffer = Buffer.alloc(readLength);
    handle = await fsp.open(filePath, 'r');
    await handle.read(buffer, 0, readLength, readStart);
    const text = buffer.toString('utf8');
    const lines = text.split('\n').filter((line) => line.trim());
    if (readStart > 0 && lines.length) lines.shift();
    const parsed = [];
    for (const line of lines.slice(-Math.max(limit * 4, limit))) {
      try {
        parsed.push(JSON.parse(line));
      } catch {
        // Ignore malformed trailing lines.
      }
    }
    return parsed.slice(-limit);
  } catch {
    return [];
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

function cleanText(text, maxLen = 180) {
  const cleaned = String(text || '')
    .replace(/^#+\s*/gm, '')
    .replace(/(^|\s)#+\s*/g, '$1')
    .replace(/`{1,3}/g, '')
    .replace(/\[(?:AGENT INSIGHT|CONSOLIDATED|ANALYSIS INSIGHT|NOTIFY|ACTION|QUESTION)[^\]]*\]\s*/gi, '')
    .replace(/\*\*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';
  return cleaned.length > maxLen ? `${cleaned.slice(0, maxLen).trim()}...` : cleaned;
}

function uniquePhrases(values, max = 6) {
  const seen = new Set();
  const out = [];
  for (const value of values || []) {
    const cleaned = cleanText(value, 120);
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
    if (out.length >= max) break;
  }
  return out;
}

function isUsefulContextPhrase(text) {
  const value = cleanText(text, 140).toLowerCase();
  if (!value) return false;
  if (value.includes('outputs/digest-')) return false;
  if (value.includes('[agent')) return false;
  if (value.includes('tag=')) return false;
  if (value.includes('goal_')) return false;
  if (value.includes('agent_')) return false;
  if (value.startsWith('context gathering response')) return false;
  if (value.startsWith('generalized abstract statement')) return false;
  if (value.startsWith('based on the multiple context')) return false;
  if (value.startsWith('implication ')) return false;
  if (value.startsWith('question:')) return false;
  if (value.startsWith('a general taxonomy')) return false;
  if (value.length > 100 && /[:;]/.test(value)) return false;
  return true;
}

function scoreMotifPhrase(phrase) {
  const words = phrase.split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 5) return 0;
  if (words.some((word) => STOP_WORDS.has(word))) return 0;
  if (words.some((word) => MOTIF_BLOCKLIST.has(word))) return 0;
  if (!words.some((word) => word.length >= 5)) return 0;
  let score = words.length;
  if (phrase.includes(' of ')) score += 1.5;
  if (phrase.includes(' between ')) score += 1;
  if (/(?:my|our|your|their|who|both|tried|read|holding)/.test(phrase)) return 0;
  return score;
}

function isAtmosphericVisualHint(text) {
  const phrase = cleanText(text, 80).toLowerCase();
  if (!phrase) return false;
  const words = phrase.split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 5) return false;
  if (words.some((word) => HUMAN_HINT_WORDS.has(word))) return false;
  if (words.some((word) => ACTION_HINT_WORDS.has(word))) return false;
  if (words.some((word) => MOTIF_BLOCKLIST.has(word))) return false;
  if (/\b(?:my|our|your|their|someone|somebody|nobody|everyone|everything)\b/.test(phrase)) return false;
  return true;
}

function pickAtmosphericHints(values, max = 3) {
  return uniquePhrases(values, max * 3)
    .filter(isAtmosphericVisualHint)
    .slice(0, max);
}

function sampleDreamInfluence(values, max = DREAM_MOTIF_LIMIT, probability = DREAM_INFLUENCE_CHANCE) {
  if (Math.random() >= probability) return [];
  return pickAtmosphericHints(values, max);
}

function extractDreamMotifsHeuristic(texts, max = 5) {
  const scores = new Map();
  for (const raw of texts || []) {
    const text = String(raw || '').toLowerCase();
    if (!text) continue;

    const phraseMatches = [
      ...text.matchAll(/\b([a-z][a-z'-]+(?: [a-z][a-z'-]+){0,2} of [a-z][a-z'-]+(?: [a-z][a-z'-]+){0,2})\b/g),
      ...text.matchAll(/\b([a-z][a-z'-]+(?: [a-z][a-z'-]+){0,2} between [a-z][a-z'-]+(?: [a-z][a-z'-]+){0,2})\b/g),
      ...text.matchAll(/\b([a-z][a-z'-]+ [a-z][a-z'-]+ [a-z][a-z'-]+)\b/g),
      ...text.matchAll(/\b([a-z][a-z'-]+ [a-z][a-z'-]+)\b/g),
    ];

    for (const match of phraseMatches) {
      const phrase = match[1].trim().replace(/\s+/g, ' ');
      const score = scoreMotifPhrase(phrase);
      if (score <= 0) continue;
      scores.set(phrase, (scores.get(phrase) || 0) + score);
    }
  }

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([phrase]) => phrase)
    .slice(0, max);
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]);
}

class Home23VibeService {
  constructor(options) {
    this.home23Root = options.home23Root;
    this.agentName = options.agentName;
    this.loadState = options.loadState;
    this.logger = options.logger || console;
    this.imageProvider = createImageProvider({
      home23Root: this.home23Root,
      agentName: this.agentName,
    });
    this.generationPromise = null;
    this.lastAutoGenerationRequestedAt = 0;
  }

  get workspaceDir() {
    return path.join(this.home23Root, 'instances', this.agentName, 'workspace');
  }

  get vibeDir() {
    return path.join(this.workspaceDir, 'vibe');
  }

  get imagesDir() {
    return path.join(this.vibeDir, 'images');
  }

  get manifestPath() {
    return path.join(this.vibeDir, 'manifest.json');
  }

  get homeConfigPath() {
    return path.join(this.home23Root, 'config', 'home.yaml');
  }

  get agentConfigPath() {
    return path.join(this.home23Root, 'instances', this.agentName, 'config.yaml');
  }

  get brainDir() {
    return path.join(this.home23Root, 'instances', this.agentName, 'brain');
  }

  get thoughtsPath() {
    return path.join(this.brainDir, 'thoughts.jsonl');
  }

  get pulseRemarksPath() {
    return path.join(this.brainDir, 'pulse-remarks.jsonl');
  }

  get dreamsPath() {
    return path.join(this.brainDir, 'dreams.jsonl');
  }

  get sensorCachePath() {
    return path.join(this.home23Root, 'engine', 'data', 'sensor-cache.json');
  }

  async ensureDirs() {
    await fsp.mkdir(this.imagesDir, { recursive: true });
  }

  mediaUrl(filePath) {
    return `/home23/api/media?path=${encodeURIComponent(filePath)}`;
  }

  galleryUrl() {
    return '/home23/vibe-gallery';
  }

  async loadManifest() {
    await this.ensureDirs();

    if (!fs.existsSync(this.manifestPath)) {
      return { version: 1, agentName: this.agentName, items: [] };
    }

    try {
      const raw = await fsp.readFile(this.manifestPath, 'utf8');
      const parsed = JSON.parse(raw);
      const items = Array.isArray(parsed.items) ? parsed.items : [];
      return {
        version: 1,
        agentName: this.agentName,
        items: items.filter(item => item && typeof item === 'object'),
      };
    } catch (error) {
      this.logger.warn?.('[Home23 Vibe] Failed to parse manifest, resetting', { error: error.message });
      return { version: 1, agentName: this.agentName, items: [] };
    }
  }

  async saveManifest(manifest) {
    await this.ensureDirs();
    await fsp.writeFile(this.manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  }

  enrichItem(item) {
    if (!item) return null;
    return {
      ...item,
      url: this.mediaUrl(item.imagePath),
      galleryUrl: this.galleryUrl(),
    };
  }

  getConfig() {
    const homeConfig = loadYamlFile(this.homeConfigPath);
    const agentConfig = loadYamlFile(this.agentConfigPath);
    const homeVibe = homeConfig?.dashboard?.vibe || {};
    const agentVibe = agentConfig?.dashboard?.vibe || {};
    const merged = deepMerge(deepMerge({}, DEFAULT_VIBE_CONFIG), homeVibe);
    const config = deepMerge(merged, agentVibe);

    const generationIntervalHours = Math.max(
      MIN_GENERATION_INTERVAL_HOURS,
      positiveNumber(config.generationIntervalHours, DEFAULT_GENERATION_INTERVAL_HOURS)
    );
    const rotationIntervalSeconds = Math.max(
      MIN_ROTATION_INTERVAL_SECONDS,
      positiveNumber(config.rotationIntervalSeconds, DEFAULT_ROTATION_INTERVAL_SECONDS)
    );
    const galleryLimit = Math.max(
      1,
      Math.floor(positiveNumber(config.galleryLimit, DEFAULT_GALLERY_LIMIT))
    );

    return {
      autoGenerate: config.autoGenerate !== false,
      generationIntervalHours,
      generationIntervalMs: generationIntervalHours * 60 * 60 * 1000,
      rotationIntervalSeconds,
      rotationIntervalMs: rotationIntervalSeconds * 1000,
      galleryLimit,
      sourcePaths: normalizeSourcePaths(config.sourcePaths),
      dreams: {
        enabled: config?.dreams?.enabled !== false,
        lookback: Math.max(1, Math.min(10, Math.floor(positiveNumber(config?.dreams?.lookback, 3)))),
        extraction: String(config?.dreams?.extraction || 'heuristic').toLowerCase() === 'llm' ? 'llm' : 'heuristic',
      },
    };
  }

  describePolicy(config) {
    return {
      autoGenerate: config.autoGenerate,
      generationIntervalHours: config.generationIntervalHours,
      rotationIntervalSeconds: config.rotationIntervalSeconds,
      galleryLimit: config.galleryLimit,
      sourcePaths: config.sourcePaths,
      dreams: config.dreams,
    };
  }

  async readLatestThought() {
    const entries = await readLastJsonLines(this.thoughtsPath, 4);
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const entry = entries[i];
      const text = cleanText(entry?.thought || entry?.content || entry?.text || '', 220);
      if (text) return text;
    }
    return '';
  }

  async readLatestPulseRemark() {
    const entries = await readLastJsonLines(this.pulseRemarksPath, 2);
    const latest = entries[entries.length - 1] || null;
    if (!latest || typeof latest !== 'object') return null;
    return latest;
  }

  async readRecentDreamTexts(limit = 3) {
    const entries = await readLastJsonLines(this.dreamsPath, limit);
    return entries
      .map((entry) => cleanText(entry?.content || entry?.thought || '', 1000))
      .filter(Boolean)
      .slice(-limit);
  }

  async readSensorData() {
    return readJsonFile(this.sensorCachePath);
  }

  async readStateGoalDescriptions(limit = 4) {
    if (typeof this.loadState !== 'function') return [];
    try {
      const state = await this.loadState();
      const active = state?.goals?.active || [];
      return uniquePhrases(active.map((goal) =>
        goal?.description || goal?.title || goal?.goal || goal?.name || goal?.summary || ''
      ).filter(isUsefulContextPhrase), limit);
    } catch {
      return [];
    }
  }

  async extractDreamMotifs(texts, extractionMode = 'heuristic') {
    const heuristic = pickAtmosphericHints(extractDreamMotifsHeuristic(texts, 8), 5);
    if (extractionMode !== 'llm' || typeof this.imageProvider.callPromptEngine !== 'function') {
      return heuristic;
    }

    try {
      const result = await this.imageProvider.callPromptEngine(
        'You extract symbolic visual motifs from dream text. Output JSON only: {"motifs":["motif one","motif two"]}. Keep motifs short, concrete, and evocative. No explanations.',
        `Dream excerpts:\n${texts.map((text, idx) => `${idx + 1}. ${text}`).join('\n\n')}\n\nExtract 3-5 motifs.`,
        true,
      );
      const motifs = pickAtmosphericHints(Array.isArray(result?.motifs) ? result.motifs : [], 5);
      return motifs.length ? motifs : heuristic;
    } catch {
      return heuristic;
    }
  }

  async distillBrainTheme(context) {
    const latestThought = cleanText(context.latestThought, 220);
    const pulseText = cleanText(context.pulseText, 180);
    const topConcepts = uniquePhrases(context.topConcepts, 4);
    const activeGoals = uniquePhrases(context.activeGoals, 4);
    const dreamMotifs = pickAtmosphericHints(context.dreamMotifs, DREAM_MOTIF_LIMIT);

    if (typeof this.imageProvider.callPromptEngine === 'function') {
      try {
        const result = await this.imageProvider.callPromptEngine(
          'You compress live agent context into non-literal visual pressure. Output JSON only: {"theme":"4-14 word phrase","support":["motif","motif"]}. Prefer concrete atmospheric language over abstract slogans. If the source is technical, translate it into physical or symbolic pressure. Avoid title-case phrases like "Evolving Harmony" unless the words are truly earned. Support items must be atmospheric nouns or material cues, never people, characters, or actions. Dreams are faint background hints only and should not dominate the theme unless they strongly reinforce the live thought.',
          `Latest thought: ${latestThought || '(none)'}\nPulse remark: ${pulseText || '(none)'}\nTop active concepts:\n${topConcepts.map((item) => `- ${item}`).join('\n') || '- none'}\nActive goals:\n${activeGoals.map((item) => `- ${item}`).join('\n') || '- none'}\nLow-priority dream hint:\n${dreamMotifs.map((item) => `- ${item}`).join('\n') || '- none'}\n\nReturn one non-literal theme phrase and up to 3 supporting motifs. The theme should be driven by current thought/goals first, not dreams.`,
          true,
        );

        const support = pickAtmosphericHints(Array.isArray(result?.support) ? result.support : [], 3);
        const theme = cleanText(result?.theme || '', 96);
        if (theme) {
          return { theme, support };
        }
      } catch {
        // Fall through to heuristic theme assembly.
      }
    }

    const fallbackParts = [latestThought, pulseText, ...activeGoals, ...topConcepts, ...dreamMotifs]
      .filter(Boolean)
      .map((item) => cleanText(item, 64));
    return {
      theme: fallbackParts[0] || '',
      support: pickAtmosphericHints(fallbackParts.slice(1), 3),
    };
  }

  async buildBrainContext(config) {
    const [latestThought, pulse, stateGoals, dreamTexts, sensorData] = await Promise.all([
      this.readLatestThought(),
      this.readLatestPulseRemark(),
      this.readStateGoalDescriptions(4),
      config.dreams.enabled ? this.readRecentDreamTexts(config.dreams.lookback) : Promise.resolve([]),
      this.readSensorData(),
    ]);

    const pulseText = cleanText(pulse?.text || '', 180);
    const pulseTopActive = uniquePhrases(
      (pulse?.brief?.brain?.topActive || []).map((entry) => entry?.concept || '').filter(isUsefulContextPhrase),
      4,
    );
    const pulseGoals = uniquePhrases((pulse?.brief?.goals?.activeDescriptions || []).filter(isUsefulContextPhrase), 4);
    const extractedDreamMotifs = config.dreams.enabled
      ? await this.extractDreamMotifs(dreamTexts, config.dreams.extraction)
      : [];
    const dreamMotifs = sampleDreamInfluence(extractedDreamMotifs);
    const activeGoals = uniquePhrases([...pulseGoals, ...stateGoals], 4);
    const distilled = await this.distillBrainTheme({
      latestThought,
      pulseText,
      topConcepts: pulseTopActive,
      activeGoals,
      dreamMotifs,
    });

    return {
      latestThought,
      pulseText,
      topConcepts: pulseTopActive,
      activeGoals,
      dreamMotifs,
      theme: distilled.theme || '',
      themeSupport: pickAtmosphericHints(distilled.support || [], 3),
      sensorData,
    };
  }

  isPathAllowed(absolutePath) {
    if (!absolutePath || typeof absolutePath !== 'string') return false;
    const resolved = path.resolve(absolutePath);
    const sourcePaths = this.getConfig().sourcePaths || [];
    for (const root of sourcePaths) {
      if (resolved === root) return true;
      if (resolved.startsWith(root + path.sep)) return true;
    }
    return false;
  }

  async getExternalItems(config) {
    const roots = config.sourcePaths || [];
    if (!roots.length) return [];

    const items = [];
    for (const root of roots) {
      if (!fs.existsSync(root)) continue;
      let stat;
      try { stat = await fsp.stat(root); } catch { continue; }
      if (!stat.isDirectory()) continue;

      // Look for a manifest.json in the parent or same directory — it carries
      // the real metadata (prompt / thought / generatedAt) for each image.
      const manifestLookup = await this._loadExternalManifest(root);

      let entries;
      try { entries = await fsp.readdir(root); } catch { continue; }

      for (const name of entries) {
        const ext = path.extname(name).toLowerCase();
        if (!IMAGE_EXTENSIONS.has(ext)) continue;
        const abs = path.join(root, name);
        let fileStat;
        try { fileStat = await fsp.stat(abs); } catch { continue; }
        if (!fileStat.isFile()) continue;

        const baseName = path.basename(name, ext);
        const meta = manifestLookup.get(baseName);

        items.push({
          id: `ext:${crypto.createHash('sha1').update(abs).digest('hex').slice(0, 16)}`,
          agentName: this.agentName,
          imagePath: abs,
          generatedAt: meta?.generatedAt || fileStat.mtime.toISOString(),
          createdAt: meta?.generatedAt || fileStat.mtime.toISOString(),
          caption: meta?.thought || '',
          prompt: meta?.thought || '',
          source: 'external',
          sourceRoot: root,
        });
      }
    }
    return items;
  }

  /**
   * Load a manifest.json from the parent directory of an images folder.
   * Returns a Map keyed by image id (UUID filename without extension).
   */
  async _loadExternalManifest(imagesDir) {
    const lookup = new Map();
    // manifest.json sits one level above the images/ folder
    const parentDir = path.dirname(imagesDir);
    const manifestPath = path.join(parentDir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) return lookup;
    try {
      const raw = await fsp.readFile(manifestPath, 'utf8');
      const parsed = JSON.parse(raw);
      const entries = Array.isArray(parsed.images) ? parsed.images : (Array.isArray(parsed.items) ? parsed.items : []);
      for (const entry of entries) {
        if (entry?.id) lookup.set(entry.id, entry);
      }
    } catch (err) {
      this.logger.warn?.('[Home23 Vibe] Failed to load external manifest', { path: manifestPath, error: err.message });
    }
    return lookup;
  }

  mergeItems(storedItems, externalItems) {
    // Local (agent-generated) images first; external images fill the tail.
    // Within each group, newest first.
    const byDate = (a, b) => {
      const ta = new Date(a.generatedAt || a.createdAt || 0).getTime();
      const tb = new Date(b.generatedAt || b.createdAt || 0).getTime();
      return tb - ta;
    };
    return [...storedItems].sort(byDate).concat([...externalItems].sort(byDate));
  }

  getStoredItems(manifest) {
    return toArray(manifest?.items)
      .filter(item => item?.imagePath && fs.existsSync(item.imagePath));
  }

  isGenerationDue(item, config) {
    if (!config.autoGenerate) return false;
    if (!item?.generatedAt) return true;
    const ts = new Date(item.generatedAt).getTime();
    if (!Number.isFinite(ts)) return true;
    return (Date.now() - ts) >= config.generationIntervalMs;
  }

  shouldAutoGenerate(latestItem, config) {
    if (!config.autoGenerate || this.generationPromise) return false;
    if (!this.isGenerationDue(latestItem, config)) return false;
    if (!this.lastAutoGenerationRequestedAt) return true;

    const elapsed = Date.now() - this.lastAutoGenerationRequestedAt;
    const backoffMs = Math.min(config.generationIntervalMs, AUTO_RETRY_BACKOFF_MS);
    return elapsed >= backoffMs;
  }

  pickDisplayItem(items, config) {
    if (!items.length) return null;
    if (items.length === 1) return items[0];

    // Rotate deterministically so the dashboard cycles through the archive.
    const bucket = Math.floor(Date.now() / config.rotationIntervalMs);
    return items[bucket % items.length];
  }

  async listGallery(limit = null) {
    const config = this.getConfig();
    const manifest = await this.loadManifest();
    const storedItems = this.getStoredItems(manifest);
    const externalItems = await this.getExternalItems(config);
    const allItems = this.mergeItems(storedItems, externalItems);
    const resolvedLimit = Math.max(
      1,
      Math.min(
        config.galleryLimit,
        Math.floor(positiveNumber(limit, config.galleryLimit))
      )
    );
    const items = allItems.slice(0, resolvedLimit).map(item => this.enrichItem(item));

    return {
      agentName: this.agentName,
      total: allItems.length,
      storedTotal: storedItems.length,
      externalTotal: externalItems.length,
      generating: Boolean(this.generationPromise),
      policy: this.describePolicy(config),
      images: items,
    };
  }

  async getCurrent() {
    const config = this.getConfig();
    const manifest = await this.loadManifest();
    const storedItems = this.getStoredItems(manifest);
    const externalItems = await this.getExternalItems(config);
    const allItems = this.mergeItems(storedItems, externalItems).slice(0, config.galleryLimit);
    // Generation cadence is driven only by agent-generated images, not external mirrors.
    const latest = storedItems[0] || null;
    const item = this.pickDisplayItem(allItems, config);
    const generationDue = this.isGenerationDue(latest, config);

    if (this.shouldAutoGenerate(latest, config)) {
      this.ensureFreshInBackground();
    }

    return {
      agentName: this.agentName,
      generating: Boolean(this.generationPromise),
      status: item
        ? (generationDue ? (this.generationPromise ? 'refreshing' : 'stale') : 'ready')
        : (this.generationPromise ? 'generating' : 'empty'),
      total: allItems.length,
      storedTotal: storedItems.length,
      externalTotal: externalItems.length,
      generationDue,
      policy: this.describePolicy(config),
      latestItem: latest ? this.enrichItem(latest) : null,
      item: item ? this.enrichItem(item) : null,
    };
  }

  requestGeneration({ swallowErrors = false, auto = false } = {}) {
    if (this.generationPromise) return this.generationPromise;
    if (auto) this.lastAutoGenerationRequestedAt = Date.now();

    this.generationPromise = this.generateNow()
      .catch(error => {
        this.logger.warn?.('[Home23 Vibe] Generation failed', { error: error.message });
        if (!swallowErrors) throw error;
        return null;
      })
      .finally(() => {
        this.generationPromise = null;
      });

    return this.generationPromise;
  }

  ensureFreshInBackground() {
    return this.requestGeneration({ swallowErrors: true, auto: true });
  }

  async generateNow() {
    const config = this.getConfig();
    const brainContext = await this.buildBrainContext(config);

    this.logger.info?.('[Home23 Vibe] Starting CHAOS MODE generation', {
      agent: this.agentName,
      algorithm: 'chaos-v2',
      theme: brainContext.theme || null,
    });

    if (typeof this.imageProvider.generateChaos !== 'function') {
      throw new Error('Image provider does not expose generateChaos()');
    }

    const image = await withTimeout(
      this.imageProvider.generateChaos(brainContext.theme || '', {
        brainContext,
        sensorData: brainContext.sensorData,
      }),
      120_000,
      'Image generation'
    );
    this.logger.info?.('[Home23 Vibe] Image generation complete', {
      agent: this.agentName,
      localPath: image?.localPath || null,
    });

    if (!image?.localPath || !fs.existsSync(image.localPath)) {
      throw new Error('Image pipeline did not return a local file');
    }

    await this.ensureDirs();

    const id = crypto.randomUUID();
    const ext = path.extname(image.localPath) || '.png';
    const imagePath = path.join(this.imagesDir, `${id}${ext}`);
    await fsp.copyFile(image.localPath, imagePath);

    const prompt = String(image.prompt || '').trim();
    const caption = image?.chaos?.title || prompt || 'CHAOS MODE';
    const item = {
      id,
      agentName: this.agentName,
      imagePath,
      generatedAt: image.generatedAt || isoNow(),
      createdAt: isoNow(),
      caption,
      prompt,
      thought: prompt || null,
      title: image?.chaos?.title || null,
      negative: image?.chaos?.negative || null,
      used: image?.chaos?.used || null,
      ingredients: image?.chaos?.ingredients || null,
      brainContext: {
        theme: brainContext.theme || null,
        themeSupport: brainContext.themeSupport || [],
        latestThought: brainContext.latestThought || null,
        topConcepts: brainContext.topConcepts || [],
        activeGoals: brainContext.activeGoals || [],
        dreamMotifs: brainContext.dreamMotifs || [],
      },
      promptTemplate: 'CHAOS V2 weighted axes + brain pressure + sensor poetics',
      provider: image.provider,
      model: image.model,
      algorithm: image?.chaos?.version || 'chaos-v2',
    };

    await fsp.writeFile(
      path.join(this.imagesDir, `${id}.json`),
      JSON.stringify(item, null, 2),
      'utf8'
    );

    const manifest = await this.loadManifest();
    manifest.items = [item, ...manifest.items.filter(existing => existing?.id !== item.id)].slice(0, config.galleryLimit);
    await this.saveManifest(manifest);

    this.logger.info?.('[Home23 Vibe] Generated new vibe image', {
      agent: this.agentName,
      imagePath,
      algorithm: item.algorithm,
      title: item.title,
    });

    return this.enrichItem(item);
  }
}

module.exports = { Home23VibeService };
