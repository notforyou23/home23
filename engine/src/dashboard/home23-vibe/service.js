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

const DEFAULT_VIBE_CONFIG = Object.freeze({
  autoGenerate: true,
  generationIntervalHours: DEFAULT_GENERATION_INTERVAL_HOURS,
  rotationIntervalSeconds: DEFAULT_ROTATION_INTERVAL_SECONDS,
  galleryLimit: DEFAULT_GALLERY_LIMIT,
});

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
    };
  }

  describePolicy(config) {
    return {
      autoGenerate: config.autoGenerate,
      generationIntervalHours: config.generationIntervalHours,
      rotationIntervalSeconds: config.rotationIntervalSeconds,
      galleryLimit: config.galleryLimit,
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

    this.logger.info?.('[Home23 Vibe] Starting CHAOS MODE generation', {
      agent: this.agentName,
      algorithm: 'chaos-mode',
      themeThought: themeThought?.slice(0, 120) || null,
    });

    if (typeof this.imageProvider.generateChaos !== 'function') {
      throw new Error('Image provider does not expose generateChaos()');
    }

    const image = await withTimeout(
      this.imageProvider.generateChaos(themeThought || '', {}),
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
      promptTemplate: 'CHAOS MODE random category assembly plus latest-thought theme',
      provider: image.provider,
      model: image.model,
      algorithm: 'chaos-mode',
      themeThought: themeThought || null,
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
