/**
 * Home23-side lobe transport for the Substrate Seed.
 *
 * This is the ONE place the Seed's model recruitment meets Home23's provider
 * contracts. It lives in src/ (harness territory) deliberately: the substrate
 * package holds no credentials and knows no endpoints — its ModelLobe takes
 * this transport as an injected function. Endpoints and credentials resolve
 * from the owning installation at invocation time, like other Home23 calls.
 * Receipt usage is measured when returned by the provider; 0 means unmeasured.
 */

import { generateText, inferTextGenerationProvider } from '../agent/text-generation.js';
import { loadHomeConfig } from '../config.js';

export interface SeedModelReceipt {
  modelId: string;
  provider: string;
  invokedAt: string;
  durationMs: number;
  tokensIn: number;
  tokensOut: number;
  requestId?: string;
}

export interface SeedLobeTransportOptions {
  model: string;
  provider?: string;
  maxTokens?: number;
  timeoutMs?: number;
}

export type SeedLobeTransport = (prompt: string) => Promise<{ text: string; modelReceipt: SeedModelReceipt }>;

export function createSeedLobeTransport(opts: SeedLobeTransportOptions): SeedLobeTransport {
  const provider = opts.provider ?? inferTextGenerationProvider(opts.model);
  return async (prompt: string) => {
    const startedMs = Date.now();
    const invokedAt = new Date().toISOString();
    const providers = loadHomeConfig().providers as Record<string, { baseUrl?: string; apiKey?: string }> | undefined;
    const configured = providers?.[provider];
    // MiniMax speaks the Anthropic protocol at its own endpoint. Letting an
    // absent base URL fall through would send its key/model to Anthropic.
    const baseURL = configured?.baseUrl || (provider === 'minimax' ? 'https://api.minimax.io/anthropic' : undefined);
    // Real usage when the provider reports it (P2-17) — 0 still means "not
    // measured", never "free" and never an estimate.
    const usageSink = { tokensIn: 0, tokensOut: 0 };
    // Default cap sized to the lobe response contract (4 arrays × 8 items,
    // claims ≤500 chars ≈ up to ~8k tokens of JSON). The old 1200 truncated
    // real responses mid-array — 21 wasted recruitments on bobby's ledger.
    const text = await generateText({
      model: opts.model,
      provider,
      baseURL,
      apiKey: configured?.apiKey,
      prompt,
      maxTokens: opts.maxTokens ?? 8192,
      temperature: 0.2,
      timeoutMs: opts.timeoutMs ?? 45_000,
      usageSink,
    });
    return {
      text,
      modelReceipt: {
        modelId: opts.model,
        provider,
        invokedAt,
        durationMs: Date.now() - startedMs,
        tokensIn: usageSink.tokensIn,
        tokensOut: usageSink.tokensOut,
      },
    };
  };
}
