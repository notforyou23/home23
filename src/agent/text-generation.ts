import Anthropic from '@anthropic-ai/sdk';
import { getCodexCredentials, getCodexHeaders, type CodexCredentials } from './codex-auth.js';

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
  codexCredentialsProvider?: () => Promise<CodexCredentials | null>;
}

export function inferTextGenerationProvider(model?: string, provider?: string): string {
  if (provider) return provider;
  const value = String(model || '');
  if (value.includes('claude')) return 'anthropic';
  if (value.includes('MiniMax')) return 'minimax';
  if (value.includes('grok')) return 'xai';
  if (value.startsWith('gpt')) return 'openai';
  return 'ollama-cloud';
}

export async function generateText(opts: TextGenerationOptions): Promise<string> {
  const provider = inferTextGenerationProvider(opts.model, opts.provider);
  const model = opts.model || defaultModelForProvider(provider);
  const maxTokens = opts.maxTokens ?? 800;
  const temperature = opts.temperature ?? 0.1;
  const timeoutMs = opts.timeoutMs ?? 60_000;

  if (provider === 'anthropic' || provider === 'minimax') {
    const client = opts.client || new Anthropic({
      apiKey: opts.apiKey || envApiKey(provider) || 'placeholder',
      ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
    });
    const response = await client.messages.create({
      model,
      max_tokens: maxTokens,
      temperature,
      ...(opts.system ? { system: opts.system } : {}),
      messages: [{ role: 'user', content: opts.prompt }],
    });
    return extractAnthropicText(response);
  }

  if (provider === 'openai-codex') {
    return generateCodexText({ ...opts, model, maxTokens, timeoutMs });
  }

  if (provider === 'ollama-cloud') {
    const apiKey = opts.apiKey || envApiKey(provider);
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
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`ollama-cloud HTTP ${res.status}: ${errText.slice(0, 300)}`);
    }
    const data = await res.json() as { message?: { content?: string } };
    return (data.message?.content || '').trim();
  }

  if (provider === 'openai' || provider === 'xai') {
    const apiKey = opts.apiKey || envApiKey(provider);
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
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`${provider} HTTP ${res.status}: ${errText.slice(0, 300)}`);
    }
    const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    return (data.choices?.[0]?.message?.content || '').trim();
  }

  throw new Error(`Unknown text-generation provider: ${provider}`);
}

function defaultModelForProvider(provider: string): string {
  if (provider === 'anthropic') return 'claude-haiku-4-5';
  if (provider === 'minimax') return 'MiniMax-M3';
  if (provider === 'openai') return 'gpt-5.4-mini';
  if (provider === 'openai-codex') return 'gpt-5.5';
  if (provider === 'xai') return 'grok-4.5';
  return 'kimi-k2.6';
}

function envApiKey(provider: string): string {
  if (provider === 'anthropic') return process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY || '';
  if (provider === 'minimax') return process.env.MINIMAX_API_KEY || '';
  if (provider === 'openai') return process.env.OPENAI_API_KEY || '';
  if (provider === 'xai') return process.env.XAI_API_KEY || '';
  if (provider === 'ollama-cloud') return process.env.OLLAMA_CLOUD_API_KEY || '';
  return '';
}

function extractAnthropicText(response: unknown): string {
  const content = (response as { content?: Array<{ type?: string; text?: string }> }).content || [];
  return content
    .filter(block => block.type === 'text' && block.text)
    .map(block => block.text)
    .join('\n')
    .trim();
}

async function generateCodexText(opts: Required<Pick<TextGenerationOptions, 'prompt'>> & TextGenerationOptions): Promise<string> {
  const credentialsProvider = opts.codexCredentialsProvider || getCodexCredentials;
  const creds = await credentialsProvider();
  if (!creds) throw new Error('openai-codex credentials not found');

  const body = {
    model: opts.model || 'gpt-5.5',
    instructions: opts.system || '',
    input: [{
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: opts.prompt }],
    }],
    max_output_tokens: opts.maxTokens ?? 800,
    stream: true,
    store: false,
  };

  const res = await fetch('https://chatgpt.com/backend-api/codex/responses', {
    method: 'POST',
    headers: getCodexHeaders(creds),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 90_000),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`codex HTTP ${res.status}: ${errText.slice(0, 300)}`);
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
