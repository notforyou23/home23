import { createRequire } from 'node:module';

export interface LocalInferencePolicy {
  contextTokens: number;
  maxOutputTokens: number;
  keepAlive: string | 0;
  localOnly: boolean;
}
export interface OllamaToolCall {
  id?: string;
  type?: 'function';
  function: { name: string; arguments: Record<string, unknown>; index?: number };
}
export interface LocalOllamaOptions {
  baseURL?: string;
  apiKey?: string;
  model: string;
  messages: Array<Record<string, unknown>>;
  tools?: Array<Record<string, unknown>>;
  maxTokens: number;
  contextTokens?: number;
  localInference?: Partial<LocalInferencePolicy>;
  temperature?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
  reasoningParameters?: Record<string, unknown>;
  reasoningEffort?: string;
  format?: string | Record<string, unknown>;
  maxOutputChars?: number;
  onChunk?: (chunk: string) => void;
  onProviderActivity?: (sequence: number) => void;
}
export interface LocalOllamaResult {
  message: { role: 'assistant'; content: string; thinking?: string; tool_calls?: OllamaToolCall[] };
  usage: { tokensIn: number; tokensOut: number };
  contextTokens: number;
}

const local = createRequire(import.meta.url)('../../shared/local-inference.cjs') as {
  getLocalInferencePolicy(overrides?: Partial<LocalInferencePolicy>, home23Root?: string): LocalInferencePolicy;
  generateLocalOllama(opts: LocalOllamaOptions): Promise<LocalOllamaResult>;
};
export const getLocalInferencePolicy = local.getLocalInferencePolicy;
export const generateLocalOllama = local.generateLocalOllama;
