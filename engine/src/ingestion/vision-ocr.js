'use strict';

/**
 * Vision OCR for the document feeder, sent to the provider that owns the
 * configured converter.visionModel.
 *
 * convert-file.py used to build an OpenAI client from OPENAI_API_KEY and call
 * whatever model the provider-agnostic picker had chosen. Forrest's
 * MiniMax-M3 therefore failed with model_not_found on every image (and
 * Jerry's earlier grok and glm picks the same way), and each failure was
 * quarantined as if the file were broken.
 */

const { resolveProviderForModel } = require('./document-compiler');
const { resolveProviderKey } = require('../core/provider-credentials');
const { getOpenAICodexClient } = require('../services/openai-codex-oauth-engine');

// Same routing as the document compiler: these providers speak the
// Anthropic messages API, openai-codex its OAuth Responses API, and every
// other provider the OpenAI chat API at its configured baseUrl.
const ANTHROPIC_COMPAT_PROVIDERS = new Set(['minimax', 'anthropic']);
const KEYLESS_PROVIDERS = new Set(['ollama-local']);
const OPENAI_BASE_URL = 'https://api.openai.com/v1';
const REQUEST_TIMEOUT_MS = 120000;

const IMAGE_OCR_PROMPT = (
  'Transcribe all text in this image to clean markdown, preserving reading '
  + 'order, headings, lists and tables. Then describe any non-text content '
  + '(photos, diagrams, charts) in a short section headed "Description". '
  + 'Do not add commentary.'
);

const PAGE_OCR_PROMPT = (
  'Transcribe this scanned document page to clean markdown. Preserve the '
  + 'reading order, headings, lists, and tables. Transcribe exactly what is '
  + 'on the page; do not summarize and do not add commentary. If the page '
  + 'is blank, output nothing.'
);

/**
 * Resolve where a vision model lives. A model no provider lists (the
 * historical gpt-4o-mini default) keeps the converter's original OpenAI
 * routing. The credential is resolved at use time and never logged.
 */
function resolveVisionTarget(model, { resolveProvider = resolveProviderForModel, resolveKey = resolveProviderKey } = {}) {
  const resolved = resolveProvider(model) || null;
  const provider = resolved?.providerName || 'openai';
  const api = provider === 'openai-codex'
    ? 'codex'
    : ANTHROPIC_COMPAT_PROVIDERS.has(provider) ? 'anthropic' : 'openai';
  const baseURL = resolved?.baseUrl || (provider === 'openai' ? OPENAI_BASE_URL : undefined);
  const credential = resolveKey(provider) || resolved?.apiKey || '';
  return {
    model,
    provider,
    api,
    baseURL,
    apiKey: api === 'codex' ? null : credential || null,
    credential,
    hasCredentials: Boolean(credential) || KEYLESS_PROVIDERS.has(provider),
    listed: Boolean(resolved),
  };
}

/**
 * One image in, the model's transcription out. Throws the provider's error
 * unchanged so the caller can classify it.
 */
async function callVisionModel({ target, prompt, mimeType, base64, signal, logger = null }) {
  const dataUrl = `data:${mimeType};base64,${base64}`;
  if (target.api === 'codex') {
    const client = getOpenAICodexClient({ providers: { 'openai-codex': { baseURL: target.baseURL } } }, logger);
    const response = await client.generate({
      model: target.model,
      input: [{
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: prompt },
          { type: 'input_image', image_url: dataUrl },
        ],
      }],
    });
    return response.content || '';
  }
  if (target.api === 'anthropic') {
    const Anthropic = require('@anthropic-ai/sdk');
    // Anthropic OAuth tokens need the same headers the unified client sends.
    const auth = String(target.apiKey || '').startsWith('sk-ant-oat')
      ? { authToken: target.apiKey, defaultHeaders: require('../core/unified-client').getAnthropicStealthHeaders() }
      : { apiKey: target.apiKey };
    const client = new Anthropic({ ...auth, baseURL: target.baseURL, timeout: REQUEST_TIMEOUT_MS, maxRetries: 0 });
    const response = await client.messages.create({
      model: target.model,
      max_tokens: 4096,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } },
          { type: 'text', text: prompt },
        ],
      }],
    }, { signal });
    // Reasoning models put a thinking block first; keep only text.
    return (response.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n');
  }
  const OpenAI = require('openai');
  const client = new OpenAI({
    apiKey: target.apiKey || 'ollama',
    baseURL: target.baseURL,
    timeout: REQUEST_TIMEOUT_MS,
    maxRetries: 0,
  });
  const response = await client.chat.completions.create({
    model: target.model,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: dataUrl } },
      ],
    }],
  }, { signal });
  return response.choices?.[0]?.message?.content || '';
}

// A provider error is a fact about the configuration or the service, not
// about the file. Only an error that names the image itself quarantines.
const FILE_ERROR = /invalid image|could not process (?:the )?image|image (?:is )?too large|image_parse_error|failed to decode|unsupported image (?:format|type)|image format/i;
const TRANSIENT_ERROR = /rate.?limit|overloaded|timed? ?out|timeout|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|fetch failed|connection error|APIConnectionError|APITimeoutError|RateLimitError|InternalServerError|temporarily unavailable/i;

/**
 * Classify an error from a vision call: 'file' (the image itself is bad),
 * 'transient' (retry soon) or 'misconfigured' (credential, model or
 * provider problem; the default, so nothing is quarantined on a guess).
 */
function classifyVisionError(err) {
  const message = String(err?.message || err || '');
  const status = Number(err?.status ?? err?.statusCode
    ?? /(?:Error code|status(?: code)?|OpenAI Codex)[: ]+(\d{3})\b/i.exec(message)?.[1]);
  if (FILE_ERROR.test(message)) return 'file';
  if (status === 429 || (status >= 500 && status < 600) || TRANSIENT_ERROR.test(message)) return 'transient';
  return 'misconfigured';
}

// Python tracebacks carry line numbers, so their provider errors are matched
// by exception class and the SDK's "Error code: NNN" text only.
const PYTHON_CONFIG_ERROR = /openai\.(?:AuthenticationError|PermissionDeniedError|NotFoundError)|Error code: (?:401|403|404)\b|model_not_found|invalid_api_key/;
const PYTHON_TRANSIENT_ERROR = /openai\.(?:RateLimitError|APIConnectionError|APITimeoutError|InternalServerError)|Error code: (?:429|5\d\d)\b/;

function classifyPythonProviderError(stderr) {
  const text = String(stderr || '');
  if (PYTHON_CONFIG_ERROR.test(text)) return 'misconfigured';
  if (PYTHON_TRANSIENT_ERROR.test(text)) return 'transient';
  return null;
}

module.exports = {
  IMAGE_OCR_PROMPT,
  PAGE_OCR_PROMPT,
  callVisionModel,
  classifyPythonProviderError,
  classifyVisionError,
  resolveVisionTarget,
};
