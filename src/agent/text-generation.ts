import Anthropic from '@anthropic-ai/sdk';
import { createRequire } from 'node:module';
import { getCodexCredentials, getCodexHeaders, type CodexCredentials } from './codex-auth.js';
import { anthropicOAuthStealthHeaders } from './anthropic-headers.js';
import { combineRequestSignals } from './abort-signals.js';
import { inferProviderFromModel } from './model-resolution.js';
import { resolveProviderKey, isAuthError, refreshFromBroker } from './provider-credentials.js';
import {
  DEFAULT_REASONING_EFFORT,
  isGpt56Model,
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
  codexCredentialsProvider?: (signal?: AbortSignal, force?: boolean) => Promise<CodexCredentials | null>;
  /** P2-17: real token usage, written by branches whose provider reports it
   * (anthropic/minimax, ollama-cloud, openai/xai). Values left at 0 mean
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
  // Read-at-use credentials + one fresh retry on auth failure: rotation is a
  // file write, never a restart list (the token class's wholesale fix,
  // 2026-08-10). A caller-pinned client can't be rebuilt — no retry there.
  //
  // EVERY provider goes through this, codex included. Codex used to return
  // before this try/catch and so had no recovery from a revoked token at all
  // — the one gap in the token-rotation fix, and the exact failure that took
  // the fleet down on 2026-07-27 and 2026-08-08/09. Its "fresh credential"
  // means a forced refresh through codex-auth.ts (its own OAuth store), not
  // a secrets.yaml re-read, but the shape is deliberately identical.
  try {
    return await generateTextAttempt(opts, provider, false);
  } catch (error) {
    if (opts.client === undefined && isAuthError(error)) {
      // A 401 is proof the token is dead. Re-reading secrets.yaml is not
      // enough: only the dashboard's 30-min poller writes that file, and its
      // raw-token fetch is what makes cosmo23 mint. So ASK THE BROKER first —
      // otherwise the "fresh" retry re-reads the same dead token for up to
      // half an hour (jerry, 2026-08-13: 401 at 17:11:43Z, recovery 17:42:10Z,
      // exactly one poller cycle, one thought lost). Broker unreachable is not
      // fatal — the retry then behaves exactly as it did before.
      await refreshFromBroker(provider);
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

  if (provider === 'openai-codex') {
    return generateCodexText({ ...opts, model, maxTokens, timeoutMs }, forceFreshCredential);
  }

  const requestSignal = combineRequestSignals(opts.signal, timeoutMs);

  if (provider === 'anthropic' || provider === 'minimax') {
    // Home23's brokered Anthropic credential is an OAuth token (sk-ant-oat*),
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

  if (provider === 'ollama-cloud') {
    const apiKey = resolveProviderKey(provider, opts.apiKey, forceFreshCredential);
    if (!apiKey) throw new Error('OLLAMA_CLOUD_API_KEY not set');
    const messages = [
      ...(opts.system ? [{ role: 'system', content: opts.system }] : []),
      { role: 'user', content: opts.prompt },
    ];
    const res = await fetch('https://ollama.com/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
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
      throw new Error(`ollama-cloud HTTP ${res.status}: ${errText.slice(0, 300)}`);
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
  forceFreshCredential = false,
): Promise<string> {
  const credentialsProvider = opts.codexCredentialsProvider || getCodexCredentials;
  const creds = await credentialsProvider(opts.signal, forceFreshCredential);
  if (!creds) throw new Error('openai-codex credentials not found');

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
    ...(isGpt56Model(opts.model || '')
      ? { reasoning: { effort: opts.reasoningEffort ?? DEFAULT_REASONING_EFFORT } }
      : {}),
  };

  let res = await fetch('https://chatgpt.com/backend-api/codex/responses', {
    method: 'POST',
    headers: getCodexHeaders(creds),
    body: JSON.stringify(body),
    signal: combineRequestSignals(opts.signal, opts.timeoutMs ?? 90_000),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    // Newer codex models (gpt-5.6-terra era) reject max_output_tokens
    // outright. The rejection has been observed under BOTH 400 and 503, so
    // key on the error body, not the status. Retry once without the cap —
    // server-side defaults bound the response.
    const capRejected = errText.includes('max_output_tokens');
    if (capRejected) {
      delete body['max_output_tokens'];
      res = await fetch('https://chatgpt.com/backend-api/codex/responses', {
        method: 'POST',
        headers: getCodexHeaders(creds),
        body: JSON.stringify(body),
        signal: combineRequestSignals(opts.signal, opts.timeoutMs ?? 90_000),
      });
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
