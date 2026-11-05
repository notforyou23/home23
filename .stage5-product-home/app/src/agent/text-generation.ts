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

    const response = await client.messages.create(
      {
        model,
        max_tokens: maxTokens,
        ...(provider === 'anthropic' && !anthropicSupportsTemperature(model) ? {} : { temperature }),
        ...(system ? { system } : {}),
        messages: [{ role: 'user', content: opts.prompt }],
      },
      { signal: requestSignal },
    );
    const anthropicUsage = (response as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;
    if (opts.usageSink && anthropicUsage) {
      opts.usageSink.tokensIn = anthropicUsage.input_tokens ?? 0;
      opts.usageSink.tokensOut = anthropicUsage.output_tokens ?? 0;
    }
    return extractAnthropicText(response);
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
        options: { num_ctx: 32768, temperature },
      }),
      signal: requestSignal,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`${provider} HTTP ${res.status}: ${errText.slice(0, 300)}`);
    }
    const data = await res.json() as { message?: { content?: string }; prompt_eval_count?: number; eval_count?: number };
    if (opts.usageSink) {
      opts.usageSink.tokensIn = data.prompt_eval_count ?? 0;
      opts.usageSink.tokensOut = data.eval_count ?? 0;
    }
    return (data.message?.content || '').trim();
  }

  if (provider === 'openai' || provider === 'xai') {
    const apiKey = resolveProviderKey(provider, opts.apiKey, forceFreshCredential);
    if (!apiKey) throw new Error(`${provider === 'xai' ? 'XAI_API_KEY' : 'OPENAI_API_KEY'} not set`);
    const baseURL = opts.baseURL || (provider === 'xai' ? 'https://api.x.ai/v1' : 'https://api.openai.com/v1');
    const messages = [
      ...(opts.system ? [{ role: 'system', content: opts.system }] : []),
      { role: 'user', content: opts.prompt },
    ];
    const tokenParam = model.includes('gpt-5') || model.includes('gpt5')
      ? { max_completion_tokens: maxTokens }
      : { max_tokens: maxTokens };
    const res = await fetch(`${baseURL.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages,
        ...tokenParam,
        temperature,
      }),
      signal: requestSignal,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`${provider} HTTP ${res.status}: ${errText.slice(0, 300)}`);
    }
    const data = await res.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    if (opts.usageSink && data.usage) {
      opts.usageSink.tokensIn = data.usage.prompt_tokens ?? 0;
      opts.usageSink.tokensOut = data.usage.completion_tokens ?? 0;
    }
    return (data.choices?.[0]?.message?.content || '').trim();
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

  let text = '';
  for await (const event of parseSSE(res.body)) {
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
    }
  }
  return text.trim();
}

async function* parseSSE(stream: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, unknown>> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

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
        try {
          yield JSON.parse(data) as Record<string, unknown>;
        } catch {
          // Skip malformed SSE payloads.
        }
      }
      boundary = buffer.indexOf('\n\n');
    }
  }
}
