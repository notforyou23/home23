/**
 * Home23-side lobe transport for the Substrate Seed.
 *
 * This is the ONE place the Seed's model recruitment meets Home23's provider
 * contracts. It lives in src/ (harness territory) deliberately: the substrate
 * package holds no credentials and knows no endpoints — its ModelLobe takes
 * this transport as an injected function. Keys arrive the same way every other
 * Home23 process gets them (PM2 env injection from secrets.yaml).
 *
 * The receipt's tokensIn/tokensOut are 0 because generateText() does not
 * surface usage — 0 here means "not measured", never "free". Wire real usage
 * accounting when generateText grows a usage return.
 */

import { generateText, inferTextGenerationProvider } from '../agent/text-generation.js';

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
    const text = await generateText({
      model: opts.model,
      provider,
      prompt,
      maxTokens: opts.maxTokens ?? 1200,
      temperature: 0.2,
      timeoutMs: opts.timeoutMs ?? 45_000,
    });
    return {
      text,
      modelReceipt: {
        modelId: opts.model,
        provider,
        invokedAt,
        durationMs: Date.now() - startedMs,
        tokensIn: 0,
        tokensOut: 0,
      },
    };
  };
}
