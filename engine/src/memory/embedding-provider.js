'use strict';

const path = require('node:path');
const { readFileSync } = require('node:fs');
const yaml = require('js-yaml');
const {
  OWNED_EMBEDDING_PROFILE,
  OWNED_EMBEDDING_RECIPE_ID,
} = require('../../../shared/semantic-encoder-contract.cjs');

const LEGACY_EMBEDDER_ID = 'ollama:nomic-embed-text:768';
const OWNED_EMBEDDER_ID = `owned-onnx:${OWNED_EMBEDDING_PROFILE}:768`;
const PROVIDERS = new Set(['ollama', 'gemini', 'owned-onnx']);

function embeddingError(code, message, status) {
  const error = new Error(message);
  error.code = code;
  Object.defineProperty(error, '_memoryEmbeddingSafe', { value: true });
  if (Number.isInteger(status)) error.status = status;
  return error;
}

function positiveInteger(value, defaultValue, name, max = Number.MAX_SAFE_INTEGER) {
  const number = value === undefined || value === null || value === '' ? defaultValue : Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > max) {
    throw embeddingError('EMBEDDING_CONFIG_INVALID', `Embedding ${name} must be a positive integer no greater than ${max}.`);
  }
  return number;
}

function providerName(value) {
  if (value === 'home23-owned') return 'owned-onnx';
  if (typeof value === 'string' && value.startsWith('ollama')) return 'ollama';
  return value;
}

/** Explicit memory provider selection must not inherit a Seed's model or endpoint. */
function resolveEmbeddingConfig(raw = {}, env = process.env) {
  const explicitProvider = raw.provider !== undefined && raw.provider !== '';
  if (explicitProvider && !PROVIDERS.has(raw.provider)) {
    throw embeddingError('EMBEDDING_CONFIG_INVALID', 'Embedding provider must be ollama, gemini or owned-onnx.');
  }
  const legacyDefault = !explicitProvider || raw.provider === 'ollama' && (!raw.model || raw.model === 'nomic-embed-text');
  const envProvider = providerName(env.EMBEDDING_PROVIDER);
  const provider = legacyDefault && env.EMBEDDING_PROVIDER
    ? PROVIDERS.has(envProvider) ? envProvider : 'ollama'
    : raw.provider || 'ollama';
  const useEmbeddingEnv = legacyDefault || envProvider === provider
    || (!env.EMBEDDING_PROVIDER && provider === 'ollama');
  const defaultModel = provider === 'gemini' ? 'gemini-embedding-2'
    : provider === 'owned-onnx' ? OWNED_EMBEDDING_PROFILE : 'nomic-embed-text';
  const configuredModel = legacyDefault && env.EMBEDDING_PROVIDER && provider === 'owned-onnx'
    && raw.model === 'nomic-embed-text' ? undefined : raw.model;
  let model = String((legacyDefault && env.EMBEDDING_MODEL) || configuredModel
    || (useEmbeddingEnv && env.EMBEDDING_MODEL) || defaultModel).trim();
  if (provider === 'owned-onnx' && model === OWNED_EMBEDDING_RECIPE_ID) model = OWNED_EMBEDDING_PROFILE;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(model)) {
    throw embeddingError('EMBEDDING_CONFIG_INVALID', 'Embedding model must be a valid model identifier.');
  }
  if (provider === 'gemini') model = model.replace(/^models\//, '');
  const rawDimensions = typeof raw.dimensions === 'object' ? raw.dimensions?.default : raw.dimensions;
  const dimensionsValue = legacyDefault && env.EMBEDDING_DIMENSIONS ? env.EMBEDDING_DIMENSIONS
    : rawDimensions ?? (useEmbeddingEnv ? env.EMBEDDING_DIMENSIONS : undefined);
  const dimensions = positiveInteger(dimensionsValue, 768, 'dimensions');
  if (provider === 'owned-onnx' && (model !== OWNED_EMBEDDING_PROFILE || dimensions !== 768)) {
    throw embeddingError('EMBEDDING_CONFIG_INVALID', 'The owned ONNX provider requires its owned-nomic-v1.5-onnx-fp32-mean-noprefix profile and 768 dimensions.');
  }
  const fallback = raw.fallback || 'none';
  if (fallback !== 'none' && fallback !== 'owned-onnx') {
    throw embeddingError('EMBEDDING_CONFIG_INVALID', 'Embedding fallback must be owned-onnx or none.');
  }
  const maxBatchSize = provider === 'gemini' ? 100 : 2048;
  const batchSize = Math.min(positiveInteger(raw.batchSize, maxBatchSize, 'batchSize'), maxBatchSize);
  const maxRetries = Number(raw.maxRetries ?? raw.retries ?? 3);
  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 20) {
    throw embeddingError('EMBEDDING_CONFIG_INVALID', 'Embedding maxRetries must be an integer from 0 through 20.');
  }
  const inheritedBaseUrl = useEmbeddingEnv ? env.EMBEDDING_BASE_URL : undefined;
  const baseUrl = raw.baseUrl || raw.baseURL || inheritedBaseUrl
    || (provider === 'gemini' ? 'https://generativelanguage.googleapis.com/v1beta'
      : provider === 'ollama' ? 'http://127.0.0.1:11434/v1' : env.HOME23_OWNED_EMBEDDING_BASE_URL || '');
  const ownedBaseUrl = raw.ownedBaseUrl || raw.fallbackBaseUrl || env.HOME23_OWNED_EMBEDDING_BASE_URL
    || (providerName(env.EMBEDDING_PROVIDER) === 'owned-onnx' ? env.EMBEDDING_BASE_URL : '') || '';
  const configuredRate = raw.requestsPerMinute ?? raw.rateLimitPerMinute ?? 60;
  const requestsPerMinute = positiveInteger(configuredRate, 60, 'requestsPerMinute');
  const pricePerMillionTokens = Number(raw.pricePerMillionTokens ?? raw.pricePer1MTokens ?? 0.20);
  if (!Number.isFinite(pricePerMillionTokens) || pricePerMillionTokens < 0) {
    throw embeddingError('EMBEDDING_CONFIG_INVALID', 'Embedding pricePerMillionTokens must be a nonnegative finite number.');
  }
  return {
    provider, model, dimensions, fallback, batchSize, baseUrl: String(baseUrl), ownedBaseUrl: String(ownedBaseUrl),
    timeoutMs: positiveInteger(raw.timeoutMs, 30_000, 'timeoutMs'),
    maxRetries,
    retryBaseMs: positiveInteger(raw.retryBaseMs ?? raw.retryBaseDelayMs, 500, 'retryBaseMs'),
    retryMaxMs: positiveInteger(raw.retryMaxMs ?? raw.retryMaxDelayMs, 30_000, 'retryMaxMs'),
    requestsPerMinute, pricePerMillionTokens,
  };
}

function embeddingId(config) {
  return `${config.provider}:${config.model}:${config.dimensions}`;
}

function assertEmbeddingId(configuredId, recordedId) {
  const expected = recordedId || LEGACY_EMBEDDER_ID;
  if (configuredId !== expected) {
    throw embeddingError('EMBEDDER_ID_MISMATCH',
      `Memory embedder ${configuredId} differs from the brain's recorded embedder ${expected}. Run node cli/home23.js brain re-embed before writing vectors.`);
  }
}

/** Never retain SDK/fetch errors: their causes, stacks and request objects can carry credentials. */
function sanitizeEmbeddingError(error) {
  const safeCodes = new Set(['EMBEDDER_ID_MISMATCH', 'EMBEDDING_CONFIG_INVALID', 'EMBEDDING_KEY_MISSING',
    'EMBEDDING_TIMEOUT', 'EMBEDDING_CANCELLED', 'EMBEDDING_RESPONSE_INVALID', 'EMBEDDING_REQUEST_FAILED']);
  if (error?._memoryEmbeddingSafe === true && safeCodes.has(error.code)) return error;
  return embeddingError('EMBEDDING_REQUEST_FAILED', 'Embedding request failed.',
    Number.isInteger(error?.status) ? error.status : undefined);
}

function safeError(code, message, status) {
  return embeddingError(code, message, status);
}

function normalizeVector(vector, dimensions) {
  if (!Array.isArray(vector) || vector.length !== dimensions || vector.some(value => typeof value !== 'number' || !Number.isFinite(value))) {
    throw safeError('EMBEDDING_RESPONSE_INVALID', `Embedding response must contain ${dimensions} finite dimensions.`);
  }
  const scale = vector.reduce((maximum, value) => Math.max(maximum, Math.abs(value)), 0);
  if (!scale) throw safeError('EMBEDDING_RESPONSE_INVALID', 'Embedding response contains a zero vector.');
  // Scale first to avoid overflow with otherwise finite provider values.
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + (value / scale) ** 2, 0));
  return vector.map(value => (value / scale) / norm);
}

function resolveGeminiKey(env, deps) {
  if (deps.resolveKey) return deps.resolveKey('google');
  try {
    const secrets = deps.secrets || yaml.load((deps.readFileSync || readFileSync)(
      env.HOME23_SECRETS_PATH || path.resolve(__dirname, '..', '..', '..', 'config', 'secrets.yaml'), 'utf8'));
    const value = secrets?.providers?.google?.apiKey || secrets?.GEMINI_API_KEY;
    if (typeof value === 'string' && value.trim()) return value.trim();
  } catch { /* A missing/unreadable secrets file retains the environment floor. */ }
  return typeof env.GEMINI_API_KEY === 'string' ? env.GEMINI_API_KEY.trim() : '';
}

function checkedBaseUrl(value, owned = false) {
  let url;
  try { url = new URL(value); } catch {
    throw safeError('EMBEDDING_CONFIG_INVALID', owned
      ? 'The owned embedder requires its configured local baseUrl; Host starts the existing sidecar separately.'
      : 'The embedding baseUrl is invalid.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
      || (owned && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) {
    throw safeError('EMBEDDING_CONFIG_INVALID', owned
      ? 'The owned embedder baseUrl must be a credential-free loopback URL.'
      : 'The embedding baseUrl must be HTTP(S) with no credentials, query or fragment.');
  }
  return url.href.replace(/\/$/, '');
}

/** Memory graph adapter only. No Seed configuration, model downloads or process lifecycle. */
function createEmbeddingProvider(raw = {}, deps = {}) {
  const env = deps.env || process.env;
  const config = resolveEmbeddingConfig(raw, env);
  const id = embeddingId(config);
  const fetchRequest = deps.fetch || globalThis.fetch;
  const random = deps.random || Math.random;
  const explicitSdkBaseUrl = Boolean(raw.baseUrl || raw.baseURL);
  let configuredSdkClient;

  function ollamaClient() {
    if (!explicitSdkBaseUrl) {
      return (deps.getEmbeddingClient || require('../core/openai-client').getEmbeddingClient)();
    }
    if (!configuredSdkClient) {
      checkedBaseUrl(config.baseUrl);
      if (deps.createOllamaClient) configuredSdkClient = deps.createOllamaClient(config);
      else if (deps.getEmbeddingClient) configuredSdkClient = deps.getEmbeddingClient(config);
      else {
        const OpenAI = require('openai');
        configuredSdkClient = new OpenAI({
          baseURL: config.baseUrl,
          apiKey: env.EMBEDDING_API_KEY || 'ollama',
          timeout: config.timeoutMs,
        });
      }
    }
    return configuredSdkClient;
  }

  function assertNotCancelled(signal) {
    if (signal?.aborted) throw safeError('EMBEDDING_CANCELLED', 'Embedding request was cancelled.');
  }

  async function pause(ms, signal) {
    assertNotCancelled(signal);
    let timer;
    let cancel;
    const cancellation = new Promise((_resolve, reject) => {
      cancel = () => reject(safeError('EMBEDDING_CANCELLED', 'Embedding request was cancelled.'));
      signal?.addEventListener('abort', cancel, { once: true });
    });
    try {
      await Promise.race([cancellation, deps.sleep ? deps.sleep(ms) : new Promise(resolve => { timer = setTimeout(resolve, ms); })]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
    }
  }

  async function requestJson(url, body, headers, signal) {
    assertNotCancelled(signal);
    const controller = new AbortController();
    let timer;
    let cancel;
    const cancellation = new Promise((_resolve, reject) => {
      cancel = () => {
        controller.abort();
        reject(safeError('EMBEDDING_CANCELLED', 'Embedding request was cancelled.'));
      };
      signal?.addEventListener('abort', cancel, { once: true });
    });
    const timeout = new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(safeError('EMBEDDING_TIMEOUT', 'Embedding request timed out.'));
      }, config.timeoutMs);
    });
    try {
      return await Promise.race([timeout, cancellation, (async () => {
        const response = await fetchRequest(url, {
          method: 'POST', headers: { 'content-type': 'application/json', ...headers },
          body: JSON.stringify(body), signal: controller.signal,
        });
        if (!response.ok) throw safeError('EMBEDDING_REQUEST_FAILED',
          `Embedding endpoint returned HTTP ${Number(response.status) || 0}.`, response.status);
        return await response.json();
      })()]);
    } catch (error) {
      throw sanitizeEmbeddingError(error);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
    }
  }

  async function geminiBatch(texts, signal) {
    let apiKey;
    try { apiKey = await resolveGeminiKey(env, deps); } catch {
      throw safeError('EMBEDDING_KEY_MISSING', 'Gemini API key could not be resolved.');
    }
    if (typeof apiKey !== 'string' || !apiKey.trim()) {
      throw safeError('EMBEDDING_KEY_MISSING', 'Gemini API key missing: set providers.google.apiKey or GEMINI_API_KEY in secrets.yaml, or env GEMINI_API_KEY.');
    }
    const endpoint = `${checkedBaseUrl(config.baseUrl)}/models/${encodeURIComponent(config.model)}:batchEmbedContents`;
    const body = { requests: texts.map(text => ({
      model: `models/${config.model}`,
      content: { parts: [{ text: String(text ?? '') }] },
      outputDimensionality: config.dimensions,
    })) };
    for (let attempt = 0; ; attempt += 1) {
      assertNotCancelled(signal);
      try {
        const response = await requestJson(endpoint, body, { 'x-goog-api-key': apiKey }, signal);
        if (!Array.isArray(response?.embeddings) || response.embeddings.length !== texts.length) {
          throw safeError('EMBEDDING_RESPONSE_INVALID', 'Gemini returned a different number of embeddings than requested.');
        }
        return response.embeddings.map(row => normalizeVector(row?.values, config.dimensions));
      } catch (error) {
        if (attempt >= config.maxRetries || !(error.status === 429 || error.status >= 500 && error.status <= 599)) throw error;
        assertNotCancelled(signal);
        const baseDelay = Math.min(config.retryMaxMs, config.retryBaseMs * 2 ** attempt);
        await pause(Math.min(config.retryMaxMs, baseDelay + baseDelay * 0.25 * random()), signal);
      }
    }
  }

  async function ownedBatch(texts, baseUrl, signal) {
    const base = checkedBaseUrl(baseUrl, true).replace(/\/v1$/, '');
    const response = await requestJson(`${base}/v1/embeddings`, {
      model: OWNED_EMBEDDING_PROFILE, input: texts.map(text => String(text ?? '')),
      encoding_format: 'float', dimensions: 768,
    }, undefined, signal);
    const rows = response?.data;
    if (!Array.isArray(rows) || rows.length !== texts.length) {
      throw safeError('EMBEDDING_RESPONSE_INVALID', 'Owned embedder returned a different number of embeddings than requested.');
    }
    const output = new Array(texts.length);
    for (const row of rows) {
      if (!Number.isInteger(row?.index) || row.index < 0 || row.index >= texts.length || output[row.index]) {
        throw safeError('EMBEDDING_RESPONSE_INVALID', 'Owned embedder returned invalid embedding indexes.');
      }
      output[row.index] = normalizeVector(row.embedding, 768);
    }
    return output;
  }

  function sdkParams(input) {
    const params = { model: config.model, input };
    // Preserve the existing OpenAI-compatible SDK request convention.
    const ollamaEndpoint = explicitSdkBaseUrl ? config.baseUrl.includes('11434')
      : (env.EMBEDDING_PROVIDER || '').includes('ollama')
        || (env.EMBEDDING_BASE_URL || '').includes('11434');
    if (!ollamaEndpoint) Object.assign(params, { encoding_format: 'float', dimensions: config.dimensions });
    return params;
  }

  async function ollamaBatch(texts, single = false, signal) {
    const client = await ollamaClient();
    const params = sdkParams(single ? String(texts[0] ?? '') : texts.map(text => String(text ?? '')));
    const response = signal ? await client.embeddings.create(params, { signal }) : await client.embeddings.create(params);
    const output = new Array(texts.length);
    for (const row of response?.data || []) {
      const index = single ? 0 : row?.index;
      if (Number.isInteger(index) && index >= 0 && index < texts.length && !output[index] && Array.isArray(row.embedding)) {
        output[index] = row.embedding;
      }
    }
    if (output.some(row => !row) || output.filter(Boolean).length !== texts.length) {
      throw safeError('EMBEDDING_RESPONSE_INVALID', 'Embedding endpoint returned missing or invalid embeddings.');
    }
    return output;
  }

  async function embedBatch(texts, options = {}, single = false) {
    if (!Array.isArray(texts) || !texts.length) return [];
    assertNotCancelled(options.signal);
    // An absent per-call recordedId means this provider is used for a new brain/copy.
    if (Object.prototype.hasOwnProperty.call(options, 'recordedId')) assertEmbeddingId(id, options.recordedId);
    const output = [];
    for (let offset = 0; offset < texts.length; offset += config.batchSize) {
      const batch = texts.slice(offset, offset + config.batchSize);
      assertNotCancelled(options.signal);
      try {
        const vectors = config.provider === 'gemini' ? await geminiBatch(batch, options.signal)
          : config.provider === 'owned-onnx' ? await ownedBatch(batch, config.baseUrl, options.signal)
            : await ollamaBatch(batch, single, options.signal);
        output.push(...vectors);
      } catch (error) {
        assertNotCancelled(options.signal);
        if (config.fallback !== 'owned-onnx') throw sanitizeEmbeddingError(error);
        // Both identities must agree before even contacting the fallback sidecar.
        assertEmbeddingId(OWNED_EMBEDDER_ID, options.recordedId || id);
        assertEmbeddingId(OWNED_EMBEDDER_ID, id);
        try { output.push(...await ownedBatch(batch, config.ownedBaseUrl || config.baseUrl, options.signal)); } catch (fallbackError) {
          throw sanitizeEmbeddingError(fallbackError);
        }
      }
    }
    return output;
  }

  return {
    id, config,
    embed: async (text, options = {}) => (await embedBatch([text], options, true))[0],
    embedBatch,
  };
}

module.exports = {
  LEGACY_EMBEDDER_ID, OWNED_EMBEDDER_ID,
  resolveEmbeddingConfig, embeddingId, assertEmbeddingId,
  createEmbeddingProvider, normalizeVector, sanitizeEmbeddingError,
};
