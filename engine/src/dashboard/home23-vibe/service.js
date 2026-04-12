'use strict';

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const yaml = require('js-yaml');
const { createImageProvider } = require('../../core/image-provider');

const DEFAULT_GALLERY_LIMIT = 60;
const DEFAULT_GENERATION_INTERVAL_HOURS = 12;
const DEFAULT_ROTATION_INTERVAL_SECONDS = 45;
const MIN_GENERATION_INTERVAL_HOURS = 1;
const MIN_ROTATION_INTERVAL_SECONDS = 15;
const AUTO_RETRY_BACKOFF_MS = 30 * 60 * 1000;

const DEFAULT_DREAM_LOOKBACK = 3;
const MAX_DREAM_LOOKBACK = 10;
const DREAM_TAIL_BYTES = 128 * 1024;
const MAX_MOTIFS = 5;

const DEFAULT_VIBE_CONFIG = Object.freeze({
  autoGenerate: true,
  generationIntervalHours: DEFAULT_GENERATION_INTERVAL_HOURS,
  rotationIntervalSeconds: DEFAULT_ROTATION_INTERVAL_SECONDS,
  galleryLimit: DEFAULT_GALLERY_LIMIT,
  dreams: {
    enabled: true,
    lookback: DEFAULT_DREAM_LOOKBACK,
    extraction: 'heuristic',
  },
});

// Heuristic stop-word list for motif extraction — drops filler so concrete
// nouns/adjectives surface from dream text.
const MOTIF_STOPWORDS = new Set([
  'the','a','an','and','or','but','if','while','when','then','than','that','this','these','those',
  'i','me','my','mine','you','your','he','she','it','its','we','us','our','they','them','their',
  'is','was','were','are','be','been','being','am','do','does','did','doing','have','has','had',
  'of','in','on','at','to','for','with','from','by','as','into','onto','upon','over','under','about',
  'up','down','out','off','through','between','around','against','within','without','across',
  'not','no','yes','so','too','very','just','only','also','still','even','ever','never','always',
  'here','there','where','why','how','what','which','who','whom','whose','can','could','should','would',
  'will','shall','may','might','must','ought','like','seems','feels','looks','felt','seemed','looked',
  'one','two','some','any','each','every','all','both','few','many','most','other','another',
  'thing','things','something','nothing','anything','everything','someone','anyone','everyone',
  'dream','dreams','dreamt','dreaming','moment','moments','time','times',
  'actually','really','perhaps','maybe','almost','nearly','mostly','often','sometimes','usually',
  'quite','rather','somewhat','truly','simply','suddenly','finally','again','already','instead',
  'next','last','first','second','third','another','chapter','part','section','existence',
]);

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
    this.getRecentThoughts = options.getRecentThoughts;
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

  get dreamsPath() {
    return path.join(this.home23Root, 'instances', this.agentName, 'brain', 'dreams.jsonl');
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

    const dreamsRaw = (config.dreams && typeof config.dreams === 'object') ? config.dreams : {};
    const dreamExtraction = String(dreamsRaw.extraction || 'heuristic').toLowerCase() === 'llm'
      ? 'llm'
      : 'heuristic';
    const dreams = {
      enabled: dreamsRaw.enabled !== false,
      lookback: Math.min(
        MAX_DREAM_LOOKBACK,
        Math.max(1, Math.floor(positiveNumber(dreamsRaw.lookback, DEFAULT_DREAM_LOOKBACK)))
      ),
      extraction: dreamExtraction,
    };

    return {
      autoGenerate: config.autoGenerate !== false,
      generationIntervalHours,
      generationIntervalMs: generationIntervalHours * 60 * 60 * 1000,
      rotationIntervalSeconds,
      rotationIntervalMs: rotationIntervalSeconds * 1000,
      galleryLimit,
      dreams,
    };
  }

  describePolicy(config) {
    return {
      autoGenerate: config.autoGenerate,
      generationIntervalHours: config.generationIntervalHours,
      rotationIntervalSeconds: config.rotationIntervalSeconds,
      galleryLimit: config.galleryLimit,
      dreams: config.dreams,
    };
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
    const resolvedLimit = Math.max(
      1,
      Math.min(
        config.galleryLimit,
        Math.floor(positiveNumber(limit, config.galleryLimit))
      )
    );
    const items = storedItems.slice(0, resolvedLimit).map(item => this.enrichItem(item));

    return {
      agentName: this.agentName,
      total: storedItems.length,
      generating: Boolean(this.generationPromise),
      policy: this.describePolicy(config),
      images: items,
    };
  }

  async getCurrent() {
    const config = this.getConfig();
    const manifest = await this.loadManifest();
    const storedItems = this.getStoredItems(manifest).slice(0, config.galleryLimit);
    const latest = storedItems[0] || null;
    const item = this.pickDisplayItem(storedItems, config);
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
      total: storedItems.length,
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
    const themeThought = await this.getLatestThoughtTheme();

    let dreamMotifs = [];
    let sourceDreamCount = 0;
    if (config.dreams.enabled) {
      const dreams = await this.getRecentDreams(config.dreams.lookback);
      sourceDreamCount = dreams.length;
      dreamMotifs = this.extractDreamMotifs(dreams);
    }

    this.logger.info?.('[Home23 Vibe] Starting CHAOS MODE generation', {
      agent: this.agentName,
      algorithm: 'chaos-mode',
      themeThought: themeThought?.slice(0, 120) || null,
      dreamMotifs,
      sourceDreamCount,
    });

    if (typeof this.imageProvider.generateChaos !== 'function') {
      throw new Error('Image provider does not expose generateChaos()');
    }

    const image = await withTimeout(
      this.imageProvider.generateChaos(themeThought || '', { dreamMotifs }),
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
    const caption = prompt || themeThought || 'CHAOS MODE';
    const item = {
      id,
      agentName: this.agentName,
      imagePath,
      generatedAt: image.generatedAt || isoNow(),
      createdAt: isoNow(),
      caption,
      prompt,
      thought: prompt || null,
      promptTemplate: dreamMotifs.length
        ? 'CHAOS MODE random category assembly plus latest-thought theme plus dream motifs'
        : 'CHAOS MODE random category assembly plus latest-thought theme',
      provider: image.provider,
      model: image.model,
      algorithm: dreamMotifs.length ? 'chaos-mode-dream-augmented' : 'chaos-mode',
      themeThought: themeThought || null,
      dreamMotifs: dreamMotifs.length ? dreamMotifs : null,
      sourceDreamCount: sourceDreamCount || null,
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
      algorithm: 'chaos-mode',
      themeThought: themeThought?.slice(0, 80) || null,
    });

    return this.enrichItem(item);
  }

  async getRecentDreams(n) {
    const limit = Math.min(MAX_DREAM_LOOKBACK, Math.max(1, Math.floor(n || DEFAULT_DREAM_LOOKBACK)));
    if (!fs.existsSync(this.dreamsPath)) return [];
    try {
      const stats = await fsp.stat(this.dreamsPath);
      const start = Math.max(0, stats.size - DREAM_TAIL_BYTES);
      const handle = await fsp.open(this.dreamsPath, 'r');
      try {
        const length = stats.size - start;
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, start);
        const text = buffer.toString('utf8');
        const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
        // If we seeked mid-line, drop the first partial line unless start was 0.
        const usable = start === 0 ? lines : lines.slice(1);
        const tail = usable.slice(-limit);
        const dreams = [];
        for (const line of tail) {
          try {
            const parsed = JSON.parse(line);
            if (parsed && typeof parsed.content === 'string' && parsed.content.trim()) {
              dreams.push({
                id: parsed.id || null,
                cycle: parsed.cycle || null,
                timestamp: parsed.timestamp || null,
                content: parsed.content,
              });
            }
          } catch { /* skip malformed */ }
        }
        return dreams;
      } finally {
        await handle.close();
      }
    } catch (error) {
      this.logger.warn?.('[Home23 Vibe] Failed to read dreams', { error: error.message });
      return [];
    }
  }

  extractDreamMotifs(dreams) {
    if (!Array.isArray(dreams) || dreams.length === 0) return [];
    const counts = new Map();
    const phraseHits = new Map();
    // Pass 1: two-word evocative adjective+noun phrases (lowercased), since
    // dream text is often rich in "quantum foam library" / "cold humming metal".
    const phraseRe = /([\p{L}]{4,})\s+([\p{L}]{4,})/giu;
    for (const dream of dreams) {
      const text = String(dream.content || '')
        .replace(/[*_`~]+/g, ' ')
        .replace(/[^\p{L}\s\-]/gu, ' ')
        .toLowerCase();
      let match;
      while ((match = phraseRe.exec(text)) !== null) {
        const [, a, b] = match;
        if (MOTIF_STOPWORDS.has(a) || MOTIF_STOPWORDS.has(b)) continue;
        const phrase = `${a} ${b}`;
        phraseHits.set(phrase, (phraseHits.get(phrase) || 0) + 1);
      }
      for (const word of text.split(/\s+/)) {
        if (word.length < 5) continue;
        if (MOTIF_STOPWORDS.has(word)) continue;
        counts.set(word, (counts.get(word) || 0) + 1);
      }
    }
    // Prefer repeated phrases first, then uncommon single tokens.
    const rankedPhrases = Array.from(phraseHits.entries())
      .filter(([, c]) => c >= 1)
      .sort((a, b) => b[1] - a[1])
      .map(([p]) => p);
    const rankedWords = Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([w]) => w);
    const merged = [];
    const seen = new Set();
    for (const token of [...rankedPhrases, ...rankedWords]) {
      if (merged.length >= MAX_MOTIFS) break;
      // Skip single-words that are already inside a chosen phrase.
      if (!token.includes(' ') && merged.some(m => m.includes(` ${token}`) || m.startsWith(`${token} `))) continue;
      if (seen.has(token)) continue;
      seen.add(token);
      merged.push(token);
    }
    return merged;
  }

  async getLatestThoughtTheme() {
    const recentThoughts = await this.getRecentThoughts(1).catch(() => []);
    const latest = recentThoughts[0] || null;
    return normalizeThought(
      latest?.thought
        || latest?.content
        || latest?.text
        || ''
    );
  }
}

module.exports = { Home23VibeService };
