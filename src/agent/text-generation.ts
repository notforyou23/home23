import Anthropic from '@anthropic-ai/sdk';
import { createRequire } from 'node:module';
import { getCodexCredentials, getCodexHeaders, type CodexCredentials } from './codex-auth.js';
import { anthropicOAuthStealthHeaders } from './anthropic-headers.js';
import { combineRequestSignals } from './abort-signals.js';
import { inferProviderFromModel } from './model-resolution.js';
import { resolveProviderKey, isAuthError, refreshManagedOAuth } from './provider-credentials.js';
import {
  DEFAULT_REASONING_EFFORT,
  supportsResponsesReasoning,
  responsesReasoningConfig,
  providerReasoningParameters,
  type ReasoningEffort,
} from './reasoning-effort.js';

const requireCjs = createRequire(import.meta.url);
const fleetDefaults = requireCjs('../../shared/model-defaults.cjs') as {
  DEFAULT_MODEL_BY_PROVIDER: Record<string, string>;
  DEFAULT_CHAT_MODEL: string;
};

export interface TextGenerationOptions {
  provider?: string;
  model?: string;
  client?: Anthropic;
  apiKey?: string;
  baseURL?: string;
  system?: string;
  prompt: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  reasoningEffort?: ReasoningEffort;
  codexCredentialsProvider?: (
    signal?: AbortSignal,
    force?: boolean,
    staleAccessToken?: string,
  ) => Promise<CodexCredentials | null>;
  /** P2-17: real token usage, written by branches whose provider reports it
   * (anthropic/minimax, ollama-cloud/local, openai/xai). Values left at 0 mean
   * "not measured" — never an estimate. Lobe receipts consume this. */
  usageSink?: { tokensIn: number; tokensOut: number };
  /** Published-response callers require an actual provider terminal completion.
   * Older extraction callers retain their existing best-effort semantics. */
  requireComplete?: boolean;
  maxOutputChars?: number;
  /** Only actual received provider events/chunks renew the enclosing turn. */
  onProviderActivity?: (sequence: number) => void;
}

function boundedOutput(text: string, opts: TextGenerationOptions): string {
  const limit = opts.maxOutputChars;
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || text.length > limit)) {
    throw Object.assign(new Error('Text generation exceeded its output bound'), { code: 'provider_output_limit' });
  }
  return text;
}

function incompleteProvider(): Error {
  return Object.assign(new Error('Text generation did not reach a complete text response'), { code: 'provider_incomplete' });
}

async function providerJson(response: Response, opts: TextGenerationOptions): Promise<Record<string, any>> {
  if (!opts.requireComplete) return response.json() as Promise<Record<string, any>>;
  if (!response.body) throw incompleteProvider();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const maxBytes = Math.max(65_536, (opts.maxOutputChars ?? 32_768) * 4 + 65_536);
  let bytes = 0; let body = ''; let sequence = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw Object.assign(new Error('Provider response exceeded its transport bound'), { code: 'provider_output_limit' });
      body += decoder.decode(value, { stream: true });
      opts.onProviderActivity?.(++sequence);
    }
    body += decoder.decode();
    const data: unknown = JSON.parse(body);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw incompleteProvider();
    return data as Record<string, any>;
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/**
 * OAuth stealth headers — required to use an sk-ant-oat* token with the
 * Anthropic SDK. Mirrors createAnthropicRuntimeClient in src/agent/loop.ts.
 */
function oauthStealthHeaders(): Record<string, string> {
  // Single source: anthropic-headers.ts (P2-18 — was one of five copies).
  return anthropicOAuthStealthHeaders();
}

/**
 * Newer Anthropic models reject `temperature` outright ("deprecated for this
 * model"), so it must be omitted rather than defaulted for them.
 */
function anthropicSupportsTemperature(model: string): boolean {
  return !/^claude-(opus|sonnet|haiku)-(4-8|5)/.test(model || '');
}

export function inferTextGenerationProvider(model?: string, provider?: string): string {
  // LENIENT caller policy over the ONE canonical rule set (model-resolution):
  // bare unrecognized names route to ollama-cloud, the catch-all serving
  // tier. Strict callers use resolveModelOverride, which rejects instead —
  // same rules, declared failure modes (P2-12).
  const inferred = inferProviderFromModel(String(model || ''), provider || undefined);
  return inferred === 'unknown' ? 'ollama-cloud' : inferred;
}

export async function generateText(opts: TextGenerationOptions): Promise<string> {
  const provider = inferTextGenerationProvider(opts.model, opts.provider);
  // Codex owns its refresh/retry inside one request scope so the exact access
  // token rejected by the provider is carried into the locked refresh
  // transaction. That matters when several calls fail at once.
  if (provider === 'openai-codex') {
    return generateCodexText(opts);
  }
  // Read-at-use credentials + one fresh retry on auth failure: rotation is a
  // file write, never a restart list (the token class's wholesale fix,
  // 2026-08-10). A caller-pinned client can't be rebuilt — no retry there.
  //
  // Managed Anthropic OAuth refreshes through Home23 before the retry. Static
  // providers simply force-reread secrets.yaml.
  try {
    return await generateTextAttempt(opts, provider, false);
  } catch (error) {
    if (opts.client === undefined && isAuthError(error)) {
      // A 401 is proof the token is dead. Home23 mints managed Anthropic OAuth
      // here before the one retry. Static providers simply force-reread
      // secrets.yaml.
      await refreshManagedOAuth(provider);
      return generateTextAttempt(opts, provider, true);
    }
    throw error;
  }
}

async function generateTextAttempt(opts: TextGenerationOptions, provider: string, forceFreshCredential: boolean): Promise<string> {
  const model = opts.model || defaultModelForProvider(provider);
  const maxTokens = opts.maxTokens ?? 800;
  const temperature = opts.temperature ?? 0.1;
  const timeoutMs = opts.timeoutMs ?? 60_000;

  const requestSignal = combineRequestSignals(opts.signal, timeoutMs);

  if (provider === 'anthropic' || provider === 'minimax') {
    // Home23's managed Anthropic credential is an OAuth token (sk-ant-oat*),
    // which the SDK must send as a bearer `authToken` with Claude Code stealth
    // headers — NOT as `x-api-key` (that 401s). OAuth calls must also lead with
    // the Claude Code system block, or they are not recognized as subscription
    // traffic and land on a much tighter quota (observed: opus 429).
    const credential = resolveProviderKey(provider, opts.apiKey, forceFreshCredential);
    const isOAuth = provider === 'anthropic' && credential.startsWith('sk-ant-oat');
    const client = opts.client || (isOAuth
      ? new Anthropic({
          authToken: credential,
          ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
          defaultHeaders: oauthStealthHeaders(),
          dangerouslyAllowBrowser: true,
        })
      : new Anthropic({
          apiKey: credential || 'placeholder',
          ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
        }));

    const system = opts.system && isOAuth
      ? [
          { type: 'text' as const, text: "You are Claude Code, Anthropic's official CLI for Claude." },
          { type: 'text' as const, text: opts.system },
        ]
      : opts.system;

    const parameters = {
        model,
        max_tokens: maxTokens,
        ...(provider === 'anthropic' && !anthropicSupportsTemperature(model) ? {} : { temperature }),
        ...(system ? { system } : {}),
        messages: [{ role: 'user' as const, content: opts.prompt }],
        ...(opts.reasoningEffort ? providerReasoningParameters(provider, model, opts.reasoningEffort) : {}),
      };
    let response: Anthropic.Message;
    if (opts.requireComplete) {
      const stream = client.messages.stream(parameters, { signal: requestSignal });
      let sequence = 0; let outputChars = 0;
      try {
        for await (const event of stream) {
          opts.onProviderActivity?.(++sequence);
          if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
            outputChars += event.delta.text.length;
            if (opts.maxOutputChars !== undefined && outputChars > opts.maxOutputChars) {
              throw Object.assign(new Error('Text generation exceeded its output bound'), { code: 'provider_output_limit' });
            }
          }
        }
        response = await stream.finalMessage();
      } finally { stream.abort(); }
      if (response.stop_reason !== 'end_turn' || response.content.some(block => block.type === 'tool_use')) throw incompleteProvider();
    } else {
      response = await client.messages.create(parameters, { signal: requestSignal });
    }
    const anthropicUsage = (response as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;
    if (opts.usageSink && anthropicUsage) {
      opts.usageSink.tokensIn = anthropicUsage.input_tokens ?? 0;
      opts.usageSink.tokensOut = anthropicUsage.output_tokens ?? 0;
    }
    return boundedOutput(extractAnthropicText(response), opts);
  }

  if (provider === 'ollama-cloud' || provider === 'ollama-local') {
    const local = provider === 'ollama-local';
    const apiKey = resolveProviderKey(provider, opts.apiKey, forceFreshCredential);
    if (!apiKey && !local) throw new Error('OLLAMA_CLOUD_API_KEY not set');
    // Home configuration uses either an Ollama origin or its /v1 compatible
    // base. Text generation uses the native endpoint, as the cloud path has
    // always done, preserving any configured reverse-proxy prefix.
    const baseURL = opts.baseURL || (local
      ? process.env.LOCAL_LLM_BASE_URL || 'http://127.0.0.1:11434'
      : 'https://ollama.com');
    const ollamaRoot = baseURL.replace(/\/+$/, '').replace(/\/(?:v1|api\/chat)$/, '');
    const messages = [
      ...(opts.system ? [{ role: 'system', content: opts.system }] : []),
      { role: 'user', content: opts.prompt },
    ];
    const res = await fetch(`${ollamaRoot}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        ...(opts.reasoningEffort ? providerReasoningParameters(provider, model, opts.reasoningEffort) : {}),
        options: { num_ctx: 32768, temperature, ...(opts.requireComplete ? { num_predict: maxTokens } : {}) },
      }),
      signal: requestSignal,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`${provider} HTTP ${res.status}: ${errText.slice(0, 300)}`);
    }
    const data = await providerJson(res, opts);
    if (opts.requireComplete && (data.done !== true || data.done_reason !== 'stop' || data.message?.tool_calls?.length)) throw incompleteProvider();
    if (opts.usageSink) {
      opts.usageSink.tokensIn = data.prompt_eval_count ?? 0;
      opts.usageSink.tokensOut = data.eval_count ?? 0;
    }
    return boundedOutput(String(data.message?.content || '').trim(), opts);
  }

  if (provider === 'openai' || provider === 'xai') {
    const apiKey = resolveProviderKey(provider, opts.apiKey, forceFreshCredential);
    if (!apiKey) throw new Error(`${provider === 'xai' ? 'XAI_API_KEY' : 'OPENAI_API_KEY'} not set`);
    const baseURL = opts.baseURL || (provider === 'xai' ? 'https://api.x.ai/v1' : 'https://api.openai.com/v1');
    const messages = [
      ...(opts.system ? [{ role: 'system', content: opts.system }] : []),
      { role: 'user', content: opts.prompt },
    ];
    const modernOpenAI = provider === 'openai' && /^(?:gpt-?(?:[5-9]|[1-9]\d+)|o[1-9])/.test(model);
    const tokenParam = modernOpenAI
      ? { max_completion_tokens: maxTokens }
      : { max_tokens: maxTokens };
    const res = await fetch(`${baseURL.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages,
        ...tokenParam,
        ...(opts.reasoningEffort ? providerReasoningParameters(provider, model, opts.reasoningEffort) : {}),
        ...(!modernOpenAI ? { temperature } : {}),
      }),
      signal: requestSignal,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`${provider} HTTP ${res.status}: ${errText.slice(0, 300)}`);
    }
    const data = await providerJson(res, opts);
    if (opts.requireComplete && (data.choices?.length !== 1 || data.choices[0]?.finish_reason !== 'stop'
      || data.choices[0]?.message?.tool_calls?.length || data.choices[0]?.message?.refusal)) throw incompleteProvider();
    if (opts.usageSink && data.usage) {
      opts.usageSink.tokensIn = data.usage.prompt_tokens ?? 0;
      opts.usageSink.tokensOut = data.usage.completion_tokens ?? 0;
    }
    return boundedOutput(String(data.choices?.[0]?.message?.content || '').trim(), opts);
  }

  throw new Error(`Unknown text-generation provider: ${provider}`);
}

function defaultModelForProvider(provider: string): string {
  // Single source: shared/model-defaults.cjs (P2-13) — this table used to be
  // duplicated here, in the codex body default, and across the CLI.
  return fleetDefaults.DEFAULT_MODEL_BY_PROVIDER[provider] ?? fleetDefaults.DEFAULT_CHAT_MODEL;
}

// envApiKey is gone: frozen-env credential reads were the disease (see
// provider-credentials.ts). Env values survive only as the resolver's floor.

function extractAnthropicText(response: unknown): string {
  const content = (response as { content?: Array<{ type?: string; text?: string }> }).content || [];
  return content
    .filter(block => block.type === 'text' && block.text)
    .map(block => block.text)
    .join('\n')
    .trim();
}

async function generateCodexText(
  opts: Required<Pick<TextGenerationOptions, 'prompt'>> & TextGenerationOptions,
): Promise<string> {
  const credentialsProvider = opts.codexCredentialsProvider || getCodexCredentials;
  const initialCreds = await credentialsProvider(opts.signal, false);
  if (!initialCreds) throw new Error('openai-codex credentials not found');
  let creds = initialCreds;

  const body: Record<string, unknown> = {
    model: opts.model || fleetDefaults.DEFAULT_MODEL_BY_PROVIDER['openai-codex'],
    instructions: opts.system || '',
    input: [{
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: opts.prompt }],
    }],
    max_output_tokens: opts.maxTokens ?? 800,
    stream: true,
    store: false,
    ...(supportsResponsesReasoning(opts.model || '')
      ? { reasoning: responsesReasoningConfig(opts.reasoningEffort ?? DEFAULT_REASONING_EFFORT) }
      : {}),
  };

  let authRefreshSpent = false;
  const postCodex = async (): Promise<Response> => {
    const send = () => fetch('https://chatgpt.com/backend-api/codex/responses', {
      method: 'POST',
      headers: getCodexHeaders(creds),
      body: JSON.stringify(body),
      signal: combineRequestSignals(opts.signal, opts.timeoutMs ?? 90_000),
    });
    let response = await send();
    if (!authRefreshSpent && (response.status === 401 || response.status === 403)) {
      const rejectedToken = creds.accessToken;
      await response.body?.cancel().catch(() => {});
      authRefreshSpent = true;
      const refreshed = await credentialsProvider(opts.signal, true, rejectedToken);
      if (!refreshed) throw new Error(`codex HTTP ${response.status}: credential refresh failed`);
      creds = refreshed;
      response = await send();
    }
    return response;
  };

  let res = await postCodex();
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    // Newer codex models (gpt-5.6-terra era) reject max_output_tokens
    // outright. The rejection has been observed under BOTH 400 and 503, so
    // key on the error body, not the status. Retry once without the cap —
    // server-side defaults bound the response.
    const capRejected = errText.includes('max_output_tokens');
    if (capRejected) {
      delete body['max_output_tokens'];
      res = await postCodex();
    }
    if (!res.ok) {
      const retryText = capRejected ? await res.text().catch(() => '') : errText;
      throw new Error(`codex HTTP ${res.status}: ${retryText.slice(0, 300)}`);
    }
  }
  if (!res.body) throw new Error('codex response missing body');

  let text = ''; let complete = false; let sequence = 0;
  for await (const event of parseSSE(res.body, opts)) {
    opts.onProviderActivity?.(++sequence);
    if (event.type === 'response.output_text.delta') {
      text += String(event.delta ?? '');
    } else if (event.type === 'response.output_text.done') {
      text = String(event.text ?? text);
    } else if (event.type === 'response.output_item.done') {
      const item = event.item as { type?: string; content?: Array<{ type?: string; text?: string }> } | undefined;
      if (item?.type === 'message') {
        const parts = (item.content || [])
          .filter(part => part.type === 'output_text' && part.text)
          .map(part => part.text);
        if (parts.length) text = parts.join('\n');
      }
    } else if (event.type === 'response.completed') {
      const response = event.response as { status?: string; output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>; usage?: { input_tokens?: number; output_tokens?: number } } | undefined;
      if (opts.requireComplete && response?.status !== 'completed') throw incompleteProvider();
      if (opts.requireComplete && response?.output?.some(item => item.type === 'function_call')) throw incompleteProvider();
      const terminalText = response?.output?.filter(item => item.type === 'message')
        .flatMap(item => item.content ?? []).filter(part => part.type === 'output_text' && typeof part.text === 'string')
        .map(part => part.text).join('\n');
      if (terminalText) text = terminalText;
      if (opts.usageSink && response?.usage) {
        opts.usageSink.tokensIn = response.usage.input_tokens ?? 0;
        opts.usageSink.tokensOut = response.usage.output_tokens ?? 0;
      }
      complete = true;
    } else if (opts.requireComplete && (event.type === 'response.failed' || event.type === 'response.incomplete')) {
      throw incompleteProvider();
    }
    boundedOutput(text, opts);
  }
  if (opts.requireComplete && !complete) throw incompleteProvider();
  return boundedOutput(text.trim(), opts);
}

async function* parseSSE(stream: ReadableStream<Uint8Array>, opts: TextGenerationOptions): AsyncGenerator<Record<string, unknown>> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  let transportBytes = 0;
  try { while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    transportBytes += value.byteLength;
    if (opts.requireComplete && transportBytes > Math.max(262_144, (opts.maxOutputChars ?? 32_768) * 32)) {
      throw Object.assign(new Error('Provider stream exceeded its transport bound'), { code: 'provider_output_limit' });
    }
    buffer += decoder.decode(value, { stream: true });
    buffer = buffer.replace(/\r\n/g, '\n');

    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const raw = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const dataLines = raw
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trim());
      const data = dataLines.join('\n');
      if (data && data !== '[DONE]') {
        let parsed: Record<string, unknown> | undefined;
        try { parsed = JSON.parse(data) as Record<string, unknown>; } catch {
          // Skip malformed SSE payloads.
          if (opts.requireComplete) throw incompleteProvider();
        }
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) yield parsed;
        else if (opts.requireComplete) throw incompleteProvider();
      }
      boundary = buffer.indexOf('\n\n');
    }
  } } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
