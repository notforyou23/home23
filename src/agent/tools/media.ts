/**
 * Media tools — image generation, music generation, and text-to-speech.
 */

import { writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { ToolDefinition, ToolContext, ToolResult } from '../types.js';
import { loadConfig } from '../../config.js';

type ImageGeneratorConfig = {
  provider: string;
  model: string;
  apiKey: string;
  baseUrl: string;
};

type MusicGeneratorConfig = {
  provider: string;
  model: string;
  apiKey: string;
  baseUrl: string;
  textBaseUrl: string;
  textModel: string;
};

function normalizeMiniMaxApiBase(baseUrl?: string): string {
  const raw = typeof baseUrl === 'string' && baseUrl.trim()
    ? baseUrl.trim()
    : 'https://api.minimax.io';
  return raw.replace(/\/+$/, '').replace(/\/anthropic(?:\/v1)?$/, '');
}

function normalizeAnthropicCompatibleBase(baseUrl?: string): string {
  const raw = typeof baseUrl === 'string' && baseUrl.trim()
    ? baseUrl.trim()
    : 'https://api.minimax.io/anthropic';
  return raw.replace(/\/+$/, '').replace(/\/v1$/, '');
}

function resolveImageGeneratorConfig(): ImageGeneratorConfig {
  const agentName = process.env.HOME23_AGENT ?? 'test-agent';
  const config = loadConfig(agentName);
  const configured = config.media?.imageGeneration || {};
  const provider = typeof configured.provider === 'string' && configured.provider.trim()
    ? configured.provider.trim()
    : 'openai';
  const model = typeof configured.model === 'string' && configured.model.trim()
    ? configured.model.trim()
    : provider === 'minimax' ? 'image-01' : 'gpt-image-2';

  const providers = config.providers as Record<string, { apiKey?: string; baseUrl?: string }> | undefined;

  if (provider === 'minimax') {
    return {
      provider,
      model,
      apiKey: providers?.minimax?.apiKey ?? process.env.MINIMAX_API_KEY ?? '',
      baseUrl: normalizeMiniMaxApiBase(providers?.minimax?.baseUrl),
    };
  }

  const openaiProvider = providers?.openai;
  return {
    provider,
    model,
    apiKey: openaiProvider?.apiKey ?? process.env.OPENAI_API_KEY ?? '',
    baseUrl: openaiProvider?.baseUrl ?? process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
  };
}

function resolveMusicGeneratorConfig(): MusicGeneratorConfig {
  const agentName = process.env.HOME23_AGENT ?? 'test-agent';
  const config = loadConfig(agentName);
  const configured = config.media?.musicGeneration || {};
  const provider = typeof configured.provider === 'string' && configured.provider.trim()
    ? configured.provider.trim()
    : 'minimax';
  const model = typeof configured.model === 'string' && configured.model.trim()
    ? configured.model.trim()
    : 'music-2.6';

  const providers = config.providers as Record<string, { apiKey?: string; baseUrl?: string }> | undefined;
  const textBaseUrl = normalizeAnthropicCompatibleBase(providers?.minimax?.baseUrl);
  const textModel = config.chat?.defaultProvider === 'minimax'
    ? (config.chat?.defaultModel || 'MiniMax-M2.7')
    : 'MiniMax-M2.7';

  if (provider === 'minimax') {
    return {
      provider,
      model,
      apiKey: providers?.minimax?.apiKey ?? process.env.MINIMAX_API_KEY ?? '',
      baseUrl: normalizeMiniMaxApiBase(providers?.minimax?.baseUrl),
      textBaseUrl,
      textModel,
    };
  }

  return {
    provider,
    model,
    apiKey: '',
    baseUrl: '',
    textBaseUrl: '',
    textModel,
  };
}

function isGptImageModel(model: string): boolean {
  return model.startsWith('gpt-image-');
}

function sizeToAspectRatio(size?: string): string | undefined {
  if (!size) return undefined;
  const map: Record<string, string> = {
    '1024x1024': '1:1', '1536x1024': '3:2', '1024x1536': '2:3',
    '1792x1024': '16:9', '1024x1792': '9:16',
    '16:9': '16:9', '9:16': '9:16', '4:3': '4:3', '3:4': '3:4',
    '1:1': '1:1', '3:2': '3:2', '2:3': '2:3', '21:9': '21:9',
  };
  return map[size] ?? undefined;
}

async function generateMiniMaxImage(
  prompt: string, size: string | undefined,
  cfg: ImageGeneratorConfig, ctx: ToolContext,
): Promise<ToolResult> {
  const body: Record<string, unknown> = {
    model: cfg.model,
    prompt,
    n: 1,
    response_format: 'url',
  };
  const aspect = sizeToAspectRatio(size);
  if (aspect) body.aspect_ratio = aspect;

  const res = await fetch(`${cfg.baseUrl.replace(/\/$/, '')}/v1/image_generation`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${cfg.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    return { content: `MiniMax Image API error: HTTP ${res.status} — ${errText.slice(0, 300)}`, is_error: true };
  }

  const data = await res.json() as { data?: { image_urls?: string[] }; metadata?: { failed_count?: number } };
  const urls = data.data?.image_urls;
  const imageUrl = urls?.[0];
  if (!imageUrl) {
    return { content: `No image returned from MiniMax ${cfg.model}.`, is_error: true };
  }

  const fileRes = await fetch(imageUrl, { signal: AbortSignal.timeout(60_000) });
  if (!fileRes.ok) {
    return { content: `Image download failed: HTTP ${fileRes.status}`, is_error: true };
  }
  const buf = Buffer.from(await fileRes.arrayBuffer());
  const filePath = join(ctx.tempDir, `minimax-${Date.now()}.png`);
  writeFileSync(filePath, buf);

  return {
    content: `Image generated via minimax/${cfg.model}${aspect ? ` (${aspect})` : ''}`,
    media: [{ type: 'image', path: filePath, mimeType: 'image/png', caption: prompt.slice(0, 200) }],
  };
}

async function generateOpenAIImage(
  prompt: string, size: string | undefined,
  cfg: ImageGeneratorConfig, ctx: ToolContext,
): Promise<ToolResult> {
  const body: Record<string, unknown> = {
    model: cfg.model,
    prompt,
    n: 1,
  };
  if (size) body.size = size;
  if (isGptImageModel(cfg.model)) {
    body.output_format = 'png';
  } else {
    body.response_format = 'b64_json';
  }

  const res = await fetch(`${cfg.baseUrl.replace(/\/$/, '')}/images/generations`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${cfg.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    return { content: `Image API error (${cfg.model}): HTTP ${res.status} — ${errText.slice(0, 300)}`, is_error: true };
  }

  const data = await res.json() as { data: Array<{ b64_json?: string; url?: string; revised_prompt?: string }> };
  const imgData = data.data[0];
  if (!imgData) return { content: `No image returned from ${cfg.model}.`, is_error: true };

  let buf: Buffer | null = null;
  if (imgData.b64_json) {
    buf = Buffer.from(imgData.b64_json, 'base64');
  } else if (imgData.url) {
    const fileRes = await fetch(imgData.url, { signal: AbortSignal.timeout(60_000) });
    if (!fileRes.ok) {
      return { content: `Image download failed: HTTP ${fileRes.status}`, is_error: true };
    }
    buf = Buffer.from(await fileRes.arrayBuffer());
  }

  if (!buf) return { content: `No image bytes returned from ${cfg.model}.`, is_error: true };

  const filePath = join(ctx.tempDir, `openai-${Date.now()}.png`);
  writeFileSync(filePath, buf);

  return {
    content: `Image generated via openai/${cfg.model}${imgData.revised_prompt ? ` (revised prompt: "${imgData.revised_prompt}")` : ''}`,
    media: [{ type: 'image', path: filePath, mimeType: 'image/png', caption: prompt.slice(0, 200) }],
  };
}

function inferAudioExtension(url: string | undefined, mimeType: string | null): string {
  const normalizedMime = mimeType?.split(';')[0]?.trim().toLowerCase() ?? '';
  if (normalizedMime === 'audio/mpeg' || normalizedMime === 'audio/mp3') return '.mp3';
  if (normalizedMime === 'audio/wav' || normalizedMime === 'audio/x-wav') return '.wav';
  if (normalizedMime === 'audio/flac') return '.flac';
  if (normalizedMime === 'audio/ogg') return '.ogg';
  if (normalizedMime === 'audio/aac') return '.aac';
  if (url) {
    try {
      const parsed = new URL(url);
      const ext = extname(parsed.pathname);
      if (ext && ext.length <= 5) return ext;
    } catch {
      // Ignore malformed URLs and fall back to a safe default.
    }
  }
  return '.mp3';
}

function inferAudioMime(ext: string, fallback?: string | null): string {
  const normalizedFallback = fallback?.split(';')[0]?.trim();
  if (normalizedFallback) return normalizedFallback;
  switch (ext.toLowerCase()) {
    case '.wav':
      return 'audio/wav';
    case '.flac':
      return 'audio/flac';
    case '.ogg':
      return 'audio/ogg';
    case '.aac':
      return 'audio/aac';
    case '.mp3':
    default:
      return 'audio/mpeg';
  }
}

function formatMusicDuration(rawDuration?: number): string | null {
  if (!rawDuration || !Number.isFinite(rawDuration)) return null;
  const seconds = rawDuration > 1000 ? rawDuration / 1000 : rawDuration;
  return `${Math.round(seconds * 10) / 10}s`;
}

async function draftMiniMaxLyrics(prompt: string, cfg: MusicGeneratorConfig): Promise<string> {
  const res = await fetch(`${cfg.textBaseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${cfg.apiKey}`,
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: cfg.textModel,
      max_tokens: 1200,
      temperature: 0.8,
      system: 'You write concise, singable song lyrics for music generation APIs. Return only lyrics with section tags like [Verse 1], [Chorus], [Verse 2], [Bridge]. Do not include commentary or markdown fences.',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Write original lyrics for this song request:\n\n${prompt}\n\nRequirements:\n- 2 verses, 1 chorus, optional bridge\n- vivid but concise\n- keep it easy to sing\n- return only the final tagged lyrics`,
            },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(120_000),
  });

  if (!res.ok) {
    throw new Error(`MiniMax lyric draft failed: HTTP ${res.status} — ${(await res.text().catch(() => '')).slice(0, 300)}`);
  }

  const body = await res.json() as {
    content?: Array<{ type?: string; text?: string }>;
    error?: { message?: string };
  };
  if (body.error?.message) {
    throw new Error(`MiniMax lyric draft failed: ${body.error.message}`);
  }

  const text = (body.content ?? [])
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text?.trim() || '')
    .filter(Boolean)
    .join('\n\n')
    .trim();

  if (!text) {
    throw new Error('MiniMax lyric draft returned no text');
  }

  return text;
}

async function generateMiniMaxMusic(
  input: {
    prompt?: string;
    lyrics?: string;
    instrumental?: boolean;
    autoLyrics?: boolean;
    referenceAudioUrl?: string;
    model?: string;
  },
  cfg: MusicGeneratorConfig,
  ctx: ToolContext,
): Promise<ToolResult> {
  const prompt = input.prompt?.trim();
  const referenceAudioUrl = input.referenceAudioUrl?.trim();
  const model = input.model?.trim() || (referenceAudioUrl ? 'music-cover' : cfg.model);
  let lyrics = input.lyrics?.trim();

  if (!prompt && !lyrics && !referenceAudioUrl) {
    return {
      content: 'Music generation requires at least one of: prompt, lyrics, or referenceAudioUrl.',
      is_error: true,
    };
  }

  let generatedLyrics = false;
  if (!lyrics && !input.instrumental && prompt) {
    lyrics = await draftMiniMaxLyrics(prompt, cfg);
    generatedLyrics = true;
  }

  const body: Record<string, unknown> = {
    model,
    output_format: 'url',
  };
  if (prompt) body.prompt = prompt;
  if (lyrics) body.lyrics = lyrics;
  if (input.instrumental) body.is_instrumental = true;
  const shouldAutoGenerateLyrics = Boolean(input.autoLyrics && !lyrics);
  if (shouldAutoGenerateLyrics) body.lyrics_optimizer = true;
  if (referenceAudioUrl) body.audio_url = referenceAudioUrl;

  const res = await fetch(`${cfg.baseUrl}/v1/music_generation`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${cfg.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(240_000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    return { content: `MiniMax Music API error: HTTP ${res.status} — ${errText.slice(0, 300)}`, is_error: true };
  }

  const data = await res.json() as {
    data?: { audio?: string; status?: number };
    extra_info?: { music_duration?: number; music_sample_rate?: number };
    base_resp?: { status_code?: number; status_msg?: string };
  };
  if (data.base_resp?.status_code && data.base_resp.status_code !== 0) {
    return { content: `MiniMax Music API error: ${data.base_resp.status_msg ?? 'unknown error'}`, is_error: true };
  }

  const audioValue = data.data?.audio;
  if (!audioValue) {
    return { content: `No audio returned from MiniMax ${model}.`, is_error: true };
  }

  let buf: Buffer;
  let mimeType: string | null = null;
  let sourceUrl: string | undefined;

  if (/^https?:\/\//i.test(audioValue)) {
    sourceUrl = audioValue;
    const fileRes = await fetch(audioValue, { signal: AbortSignal.timeout(120_000) });
    if (!fileRes.ok) {
      return { content: `Music download failed: HTTP ${fileRes.status}`, is_error: true };
    }
    mimeType = fileRes.headers.get('content-type');
    buf = Buffer.from(await fileRes.arrayBuffer());
  } else {
    buf = Buffer.from(audioValue, 'hex');
  }

  const ext = inferAudioExtension(sourceUrl, mimeType);
  const resolvedMimeType = inferAudioMime(ext, mimeType);
  const filePath = join(ctx.tempDir, `music-${Date.now()}${ext}`);
  writeFileSync(filePath, buf);

  const details = [
    `model=${model}`,
    input.instrumental ? 'instrumental' : 'vocal',
    generatedLyrics ? 'lyrics=drafted' : null,
    formatMusicDuration(data.extra_info?.music_duration) ? `duration=${formatMusicDuration(data.extra_info?.music_duration)}` : null,
    data.extra_info?.music_sample_rate ? `sample_rate=${data.extra_info.music_sample_rate}` : null,
  ].filter(Boolean).join(', ');

  return {
    content: `Music generated via minimax/${model}${details ? ` (${details})` : ''}`,
    media: [{
      type: 'document',
      path: filePath,
      mimeType: resolvedMimeType,
      fileName: `home23-${model}${ext}`,
      caption: prompt?.slice(0, 200) || 'MiniMax music generation',
    }],
  };
}

export const generateImageTool: ToolDefinition = {
  name: 'generate_image',
  description: 'Generate an image from a text prompt. Supports OpenAI (gpt-image-2, GPT Image legacy models, DALL-E) and MiniMax (image-01). The image is returned to the current channel when that channel supports media. Size can be dimensions (1024x1024) or aspect ratio (16:9).',
  input_schema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'Image generation prompt' },
      size: { type: 'string', description: 'Optional image size override (for example: auto, 1024x1024, 1536x1024, 1024x1536)' },
    },
    required: ['prompt'],
  },

  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const prompt = input.prompt as string;
    const size = typeof input.size === 'string' && input.size.trim() ? input.size.trim() : undefined;
    const imageConfig = resolveImageGeneratorConfig();

      if (!imageConfig.apiKey) {
      return { content: `Image generation unavailable — ${imageConfig.provider} API key not configured.`, is_error: true };
    }

    try {
      if (imageConfig.provider === 'minimax') {
        return await generateMiniMaxImage(prompt, size, imageConfig, ctx);
      }
      if (imageConfig.provider === 'openai') {
        return await generateOpenAIImage(prompt, size, imageConfig, ctx);
      }
      return {
        content: `Image generation unavailable — provider "${imageConfig.provider}" is not implemented. Use "openai" or "minimax" in Settings.`,
        is_error: true,
      };
    } catch (err) {
      return { content: `Image generation error: ${err instanceof Error ? err.message : String(err)}`, is_error: true };
    }
  },
};

export const generateMusicTool: ToolDefinition = {
  name: 'generate_music',
  description: 'Generate music via MiniMax Music. Supports original songs, instrumentals, and cover generation from a reference audio URL. Returns the generated track as an audio file attachment.',
  input_schema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'Style, mood, or song concept. Example: cinematic outlaw ballad with dusty guitars and a female vocal.' },
      lyrics: { type: 'string', description: 'Optional lyrics. MiniMax works best with section tags like [Verse], [Chorus], [Bridge].' },
      instrumental: { type: 'boolean', description: 'Set true to generate an instrumental track.' },
      autoLyrics: { type: 'boolean', description: 'Set true to have MiniMax generate/refine lyrics from the prompt. If omitted, Home23 enables this automatically for prompt-only vocal requests.' },
      referenceAudioUrl: { type: 'string', description: 'Optional reference audio URL for cover mode. If provided, the tool defaults to MiniMax music-cover.' },
      model: { type: 'string', description: 'Optional MiniMax music model override. Defaults to music-2.6, or music-cover when referenceAudioUrl is provided.' },
    },
  },

  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const musicConfig = resolveMusicGeneratorConfig();

    if (!musicConfig.apiKey) {
      return { content: `Music generation unavailable — ${musicConfig.provider} API key not configured.`, is_error: true };
    }
    if (musicConfig.provider !== 'minimax') {
      return {
        content: `Music generation unavailable — provider "${musicConfig.provider}" is not implemented. Use "minimax" in config.`,
        is_error: true,
      };
    }

    try {
      return await generateMiniMaxMusic({
        prompt: typeof input.prompt === 'string' ? input.prompt : undefined,
        lyrics: typeof input.lyrics === 'string' ? input.lyrics : undefined,
        instrumental: input.instrumental === true,
        autoLyrics: input.autoLyrics === true,
        referenceAudioUrl: typeof input.referenceAudioUrl === 'string' ? input.referenceAudioUrl : undefined,
        model: typeof input.model === 'string' ? input.model : undefined,
      }, musicConfig, ctx);
    } catch (err) {
      return { content: `Music generation error: ${err instanceof Error ? err.message : String(err)}`, is_error: true };
    }
  },
};

export const ttsTool: ToolDefinition = {
  name: 'tts',
  description: 'Convert text to speech using the configured TTS provider. The voice file is returned to the current channel when that channel supports media.',
  input_schema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Text to speak' },
    },
    required: ['text'],
  },

  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const text = input.text as string;

    if (!ctx.ttsService) {
      return { content: 'TTS not available — service not configured.', is_error: true };
    }

    try {
      const buf = await ctx.ttsService.speak(text, true);
      if (!buf) return { content: 'TTS returned no audio.', is_error: true };

      const filePath = join(ctx.tempDir, `tts-${Date.now()}.mp3`);
      writeFileSync(filePath, buf);

      return {
        content: `Voice message generated (${buf.length} bytes)`,
        media: [{ type: 'voice', path: filePath, mimeType: 'audio/mpeg' }],
      };
    } catch (err) {
      return { content: `TTS error: ${err instanceof Error ? err.message : String(err)}`, is_error: true };
    }
  },
};
