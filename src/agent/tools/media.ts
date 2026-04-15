/**
 * Media tools — image generation and text-to-speech.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolDefinition, ToolContext, ToolResult } from '../types.js';
import { loadConfig } from '../../config.js';

type ImageGeneratorConfig = {
  provider: string;
  model: string;
  apiKey: string;
  baseUrl: string;
};

function resolveImageGeneratorConfig(): ImageGeneratorConfig {
  const agentName = process.env.HOME23_AGENT ?? 'test-agent';
  const config = loadConfig(agentName);
  const configured = config.media?.imageGeneration || {};
  const provider = typeof configured.provider === 'string' && configured.provider.trim()
    ? configured.provider.trim()
    : 'openai';
  const model = typeof configured.model === 'string' && configured.model.trim()
    ? configured.model.trim()
    : 'gpt-image-1.5';

  if (provider !== 'openai') {
    return { provider, model, apiKey: '', baseUrl: '' };
  }

  const openaiProvider = (config.providers as Record<string, { apiKey?: string; baseUrl?: string }> | undefined)?.openai;
  return {
    provider,
    model,
    apiKey: openaiProvider?.apiKey ?? process.env.OPENAI_API_KEY ?? '',
    baseUrl: openaiProvider?.baseUrl ?? process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
  };
}

function isGptImageModel(model: string): boolean {
  return model.startsWith('gpt-image-');
}

export const generateImageTool: ToolDefinition = {
  name: 'generate_image',
  description: 'Generate an image from a text prompt using Home23\'s configured image generator. The image is returned to the current channel when that channel supports media.',
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

    if (imageConfig.provider !== 'openai') {
      return {
        content: `Image generation unavailable — provider "${imageConfig.provider}" is not implemented yet. Set Image Generation provider to "openai" in Home23 Settings.`,
        is_error: true,
      };
    }

    if (!imageConfig.apiKey) {
      return { content: 'Image generation unavailable — OpenAI API key not configured.', is_error: true };
    }

    try {
      const body: Record<string, unknown> = {
        model: imageConfig.model,
        prompt,
        n: 1,
      };
      if (size) body.size = size;
      if (isGptImageModel(imageConfig.model)) {
        body.output_format = 'png';
      } else {
        body.response_format = 'b64_json';
      }

      const res = await fetch(`${imageConfig.baseUrl.replace(/\/$/, '')}/images/generations`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${imageConfig.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        return { content: `Image API error (${imageConfig.model}): HTTP ${res.status} — ${errText.slice(0, 300)}`, is_error: true };
      }

      const data = await res.json() as { data: Array<{ b64_json?: string; url?: string; revised_prompt?: string }> };
      const imgData = data.data[0];
      if (!imgData) return { content: `No image returned from ${imageConfig.model}.`, is_error: true };

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

      if (!buf) return { content: `No image bytes returned from ${imageConfig.model}.`, is_error: true };

      const filePath = join(ctx.tempDir, `dalle-${Date.now()}.png`);
      writeFileSync(filePath, buf);

      return {
        content: `Image generated via ${imageConfig.provider}/${imageConfig.model}${imgData.revised_prompt ? ` (revised prompt: "${imgData.revised_prompt}")` : ''}`,
        media: [{ type: 'image', path: filePath, mimeType: 'image/png', caption: prompt.slice(0, 200) }],
      };
    } catch (err) {
      return { content: `Image generation error: ${err instanceof Error ? err.message : String(err)}`, is_error: true };
    }
  },
};

export const ttsTool: ToolDefinition = {
  name: 'tts',
  description: 'Convert text to speech using ElevenLabs. The voice file is returned to the current channel when that channel supports media.',
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
