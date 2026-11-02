'use strict';

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

// Operational limits are independent of a model's advertised maximum context.
// These defaults preserve the existing context setting; they are not a RAM-fit claim.
const DEFAULT_LOCAL_INFERENCE = Object.freeze({ contextTokens: 32768, maxOutputTokens: 8192, keepAlive: '5m', localOnly: false });
const slots = new Map();
const fail = (code, message) => Object.assign(new Error(message), { code });
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const httpFailure = (status, metadata = false) => fail(status === 412 ? 'local_inference_runtime_incompatible'
  : status === 404 ? 'local_inference_model_unavailable' : metadata ? 'local_inference_metadata_unavailable' : 'provider_http_error',
  `Local ${metadata ? 'model metadata' : 'inference'} HTTP ${status}`);

function normalizeLocalInferencePolicy(value = {}) {
  if (!record(value)) throw fail('local_inference_config_invalid', 'Local inference policy must be an object');
  const policy = { ...DEFAULT_LOCAL_INFERENCE, ...value };
  if (!Number.isSafeInteger(policy.contextTokens) || policy.contextTokens < 1024 || policy.contextTokens > 1048576
      || !Number.isSafeInteger(policy.maxOutputTokens) || policy.maxOutputTokens < 1 || policy.maxOutputTokens >= policy.contextTokens
      || typeof policy.localOnly !== 'boolean'
      || !(policy.keepAlive === 0 || typeof policy.keepAlive === 'string' && /^(?:0|\d+(?:ms|s|m|h))$/.test(policy.keepAlive))) {
    throw fail('local_inference_config_invalid', 'Invalid local inference context, output, keep-alive or locality limit');
  }
  return { contextTokens: policy.contextTokens, maxOutputTokens: policy.maxOutputTokens, keepAlive: policy.keepAlive, localOnly: policy.localOnly };
}

function getLocalInferencePolicy(overrides = {}, home23Root = process.env.HOME23_ROOT || path.resolve(__dirname, '..')) {
  let configured = {};
  try {
    const home = yaml.load(fs.readFileSync(path.join(home23Root, 'config', 'home.yaml'), 'utf8'));
    configured = home?.providers?.['ollama-local']?.inference ?? {};
  } catch (error) {
    if (error.code !== 'ENOENT') throw fail('local_inference_config_invalid', 'Cannot read the local inference policy');
  }
  if (!record(configured) || !record(overrides)) throw fail('local_inference_config_invalid', 'Local inference policy must be an object');
  return normalizeLocalInferencePolicy({ ...configured, ...overrides });
}

function isRemoteOllamaModel(model, metadata = {}) {
  return /(?::cloud|-cloud)$/i.test(String(model).trim())
    || Boolean(metadata.remote_host || metadata.remote_model);
}

function assertLocalOllamaTarget(baseURL, model, metadata = {}, localOnly = false) {
  let url;
  try { url = new URL(baseURL || 'http://127.0.0.1:11434'); } catch { throw fail('local_inference_endpoint_invalid', 'Invalid local model endpoint'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw fail('local_inference_endpoint_invalid', 'Invalid local model endpoint');
  }
  if (localOnly && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw fail('local_inference_endpoint_refused', 'Local-only inference requires a loopback endpoint');
  }
  if (isRemoteOllamaModel(model, metadata)) throw fail('local_inference_remote_model', 'The selected Ollama model delegates inference to a remote host');
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/(?:v1|api\/(?:chat|show))$/, '');
  return url.href.replace(/\/+$/, '');
}

function ollamaModelContextTokens(metadata) {
  const info = metadata?.model_info;
  const architecture = info?.['general.architecture'];
  const n = typeof architecture === 'string' ? info[`${architecture}.context_length`] : undefined;
  return Number.isSafeInteger(n) && n >= 1024 ? n : null;
}

async function boundedBody(response, signal, maxBytes) {
  if (!response.body) throw fail('provider_incomplete', 'Local model response has no body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let body = ''; let bytes = 0;
  const abort = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    for (;;) {
      const part = await reader.read(); signal.throwIfAborted();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > maxBytes) throw fail('provider_output_limit', 'Local model metadata exceeded its transport bound');
      body += decoder.decode(part.value, { stream: true });
    }
    return body + decoder.decode();
  } finally { signal.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

async function checkLocalOllamaModel({ baseURL, model, signal = AbortSignal.timeout(10000), apiKey, localOnly = false }) {
  const base = assertLocalOllamaTarget(baseURL, model, {}, localOnly);
  signal.throwIfAborted();
  const response = await fetch(`${base}/api/show`, {
    method: 'POST', redirect: 'error', signal,
    headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
    body: JSON.stringify({ model, verbose: false }),
  });
  if (!response.ok) { await response.body?.cancel().catch(() => {}); throw httpFailure(response.status, true); }
  let metadata;
  try { metadata = JSON.parse(await boundedBody(response, signal, 2 * 1024 * 1024)); }
  catch (error) { if (signal.aborted || error.code) throw error; throw fail('local_inference_metadata_invalid', 'Invalid local model metadata'); }
  if (!record(metadata) || !Array.isArray(metadata.capabilities) || !metadata.capabilities.includes('completion')) {
    throw fail('local_inference_metadata_invalid', 'The selected local model does not advertise text completion');
  }
  assertLocalOllamaTarget(base, model, metadata, localOnly);
  return { baseURL: base, metadata, contextTokens: ollamaModelContextTokens(metadata) };
}

// Serializes this process's local calls. Host-wide admission remains a separate contract.
function acquireSlot(key, signal) {
  signal.throwIfAborted();
  let state = slots.get(key);
  if (!state) { state = { active: false, queue: [] }; slots.set(key, state); }
  return new Promise((resolve, reject) => {
    const waiter = { grant: null, abort: null };
    waiter.abort = () => {
      state.queue = state.queue.filter(item => item !== waiter);
      signal.removeEventListener('abort', waiter.abort);
      reject(signal.reason);
      if (!state.active && !state.queue.length) slots.delete(key);
    };
    waiter.grant = () => {
      signal.removeEventListener('abort', waiter.abort);
      if (signal.aborted) { waiter.abort(); return false; }
      state.active = true;
      let released = false;
      resolve(() => {
        if (released) return;
        released = true; state.active = false;
        while (state.queue.length) if (state.queue.shift().grant()) return;
        slots.delete(key);
      });
      return true;
    };
    if (!state.active) waiter.grant();
    else { state.queue.push(waiter); signal.addEventListener('abort', waiter.abort, { once: true }); }
  });
}

function toolCall(value) {
  if (!record(value) || !record(value.function) || typeof value.function.name !== 'string' || !value.function.name.trim()
      || !record(value.function.arguments) || value.id !== undefined && (typeof value.id !== 'string' || !value.id)) {
    throw fail('provider_invalid_tool_call', 'Local model returned an invalid structured tool call');
  }
  return { ...(value.id ? { id: value.id } : {}), type: 'function', function: { name: value.function.name, arguments: value.function.arguments,
    ...(Number.isSafeInteger(value.function.index) ? { index: value.function.index } : {}) } };
}

function localReasoningParameters(opts, metadata) {
  const values = Array.isArray(metadata.thinking?.values) ? metadata.thinking.values : null;
  const thinking = metadata.capabilities.includes('thinking') || values !== null;
  if (opts.reasoningParameters && Object.hasOwn(opts.reasoningParameters, 'think')) {
    const value = opts.reasoningParameters.think;
    if (value !== null && typeof value !== 'boolean' && typeof value !== 'string'
        || value !== null && values?.length && !values.includes(value)) {
      throw fail('local_inference_reasoning_unsupported', 'The local model does not support the requested thinking setting');
    }
    return { think: value };
  }
  const effort = opts.reasoningEffort;
  if (!effort || !thinking) return {};
  const value = effort === 'none' ? false : values?.includes(effort) ? effort : true;
  if (values?.length && !values.includes(value)) throw fail('local_inference_reasoning_unsupported', 'The local model does not support the requested thinking setting');
  return { think: value };
}

async function generateLocalOllama(opts) {
  const policy = getLocalInferencePolicy({ ...opts.localInference, ...(opts.contextTokens === undefined ? {} : { contextTokens: opts.contextTokens }) });
  if (!Number.isSafeInteger(opts.maxTokens) || opts.maxTokens < 1) throw fail('local_inference_config_invalid', 'Local output token limit must be positive');
  const maxTokens = Math.min(opts.maxTokens, policy.maxOutputTokens);
  const signal = AbortSignal.any([...(opts.signal ? [opts.signal] : []), AbortSignal.timeout(opts.timeoutMs ?? 300000)]);
  const base = assertLocalOllamaTarget(opts.baseURL, opts.model, {}, policy.localOnly);
  const release = await acquireSlot(base, signal);
  try {
    const inspected = await checkLocalOllamaModel({ baseURL: base, model: opts.model, signal, apiKey: opts.apiKey, localOnly: policy.localOnly });
    const contextTokens = Math.min(policy.contextTokens, inspected.contextTokens ?? policy.contextTokens);
    if (maxTokens >= contextTokens) throw fail('local_inference_config_invalid', 'Local output reserve exceeds the model context');
    if (opts.tools?.length && !inspected.metadata.capabilities.includes('tools')) throw fail('local_inference_tools_unsupported', 'The selected local model does not support tools');
    if (opts.messages.some(message => message.images?.length) && !inspected.metadata.capabilities.includes('vision')) throw fail('local_inference_images_unsupported', 'The selected local model does not support images');
    const reasoningParameters = localReasoningParameters(opts, inspected.metadata);
    const response = await fetch(`${base}/api/chat`, {
      method: 'POST', redirect: 'error', signal,
      headers: { 'Content-Type': 'application/json', ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}) },
      body: JSON.stringify({ model: opts.model, messages: opts.messages, ...(opts.tools?.length ? { tools: opts.tools } : {}), stream: true,
        // Supported by Ollama 0.20.6 onward: refuse rendered-prompt overflow
        // rather than silently dropping history or shifting the context.
        truncate: false, shift: false,
        ...reasoningParameters,
        ...(opts.format ? { format: opts.format } : {}), keep_alive: policy.keepAlive,
        options: { num_ctx: contextTokens, num_predict: maxTokens, ...(opts.temperature === undefined ? {} : { temperature: opts.temperature }) } }),
    });
    if (!response.ok) { await response.body?.cancel().catch(() => {}); throw httpFailure(response.status); }
    if (!response.body) throw fail('provider_incomplete', 'Local inference did not return a response stream');
    const reader = response.body.getReader(); const decoder = new TextDecoder();
    const maxOutputChars = opts.maxOutputChars ?? Math.max(32768, maxTokens * 32);
    const maxBytes = Math.max(262144, maxOutputChars * 8 + 65536);
    let bytes = 0; let pending = ''; let content = ''; let thinking = ''; let sequence = 0; let terminal = null;
    const calls = []; const callIds = new Set();
    const abort = () => { void reader.cancel(signal.reason).catch(() => {}); };
    signal.addEventListener('abort', abort, { once: true });
    const consume = line => {
      if (!line.trim()) return;
      if (terminal) throw fail('provider_incomplete', 'Local inference returned data after completion');
      let event;
      try { event = JSON.parse(line); } catch { throw fail('provider_incomplete', 'Local inference returned malformed stream data'); }
      if (!record(event) || event.error || event.done !== true && event.done !== false) throw fail('provider_incomplete', 'Local inference returned an invalid stream event');
      assertLocalOllamaTarget(base, opts.model, event, policy.localOnly);
      opts.onProviderActivity?.(++sequence);
      signal.throwIfAborted();
      if (event.message !== undefined) {
        const message = event.message;
        if (!record(message) || message.role !== undefined && message.role !== 'assistant'
            || message.content !== undefined && typeof message.content !== 'string'
            || message.thinking !== undefined && typeof message.thinking !== 'string'
            || message.tool_calls !== undefined && !Array.isArray(message.tool_calls)) throw fail('provider_incomplete', 'Local inference returned an invalid message');
        content += message.content || ''; thinking += message.thinking || '';
        if (content.length > maxOutputChars || thinking.length > maxOutputChars * 4) throw fail('provider_output_limit', 'Local inference exceeded its output bound');
        for (const item of message.tool_calls || []) {
          const call = toolCall(item);
          if (call.id && callIds.has(call.id)) throw fail('provider_invalid_tool_call', 'Local inference repeated a tool call identifier');
          if (call.id) callIds.add(call.id);
          calls.push(call);
          if (calls.length > 128) throw fail('provider_output_limit', 'Local inference exceeded its tool-call bound');
        }
        if (message.content) opts.onChunk?.(message.content);
        signal.throwIfAborted();
      }
      if (event.done) {
        if (event.done_reason !== 'stop') throw fail('provider_incomplete', 'Local inference stopped before a complete response');
        terminal = event;
      }
    };
    try {
      signal.throwIfAborted();
      while (!terminal) {
        const part = await reader.read(); signal.throwIfAborted();
        if (part.done) { pending += decoder.decode(); consume(pending); pending = ''; break; }
        bytes += part.value.byteLength;
        if (bytes > maxBytes) throw fail('provider_output_limit', 'Local inference exceeded its transport bound');
        pending += decoder.decode(part.value, { stream: true });
        let newline;
        while ((newline = pending.indexOf('\n')) !== -1) { const line = pending.slice(0, newline); pending = pending.slice(newline + 1); consume(line); }
        if (terminal && pending.trim()) throw fail('provider_incomplete', 'Local inference returned data after completion');
      }
      if (!terminal || !content.trim() && !calls.length) throw fail('provider_incomplete', 'Local inference did not reach a complete response');
      signal.throwIfAborted();
      return { message: { role: 'assistant', content, ...(thinking ? { thinking } : {}), ...(calls.length ? { tool_calls: calls } : {}) },
        usage: { tokensIn: Number.isSafeInteger(terminal.prompt_eval_count) ? terminal.prompt_eval_count : 0,
          tokensOut: Number.isSafeInteger(terminal.eval_count) ? terminal.eval_count : 0 }, contextTokens };
    } finally { signal.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
  } finally { release(); }
}

module.exports = { DEFAULT_LOCAL_INFERENCE, normalizeLocalInferencePolicy, getLocalInferencePolicy, isRemoteOllamaModel,
  assertLocalOllamaTarget, ollamaModelContextTokens, checkLocalOllamaModel, generateLocalOllama };
