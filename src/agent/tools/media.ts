/**
 * Media tools — image generation and text-to-speech.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolDefinition, ToolContext, ToolResult } from '../types.js';

export const generateImageTool: ToolDefinition = {
  name: 'generate_image',
  description: 'Generate an image from a text prompt using DALL-E. The image will be automatically sent to the Telegram chat.',
  input_schema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'Image generation prompt' },
      size: { type: 'string', enum: ['1024x1024', '1792x1024', '1024x1792'], description: 'Image size (default: 1024x1024)' },
    },
    required: ['prompt'],
  },

  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const prompt = input.prompt as string;
    const size = (input.size as string) || '1024x1024';

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return { content: 'Image generation unavailable — OPENAI_API_KEY not configured.', is_error: true };
    }

    try {
      const res = await fetch('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'dall-e-3',
          prompt,
          n: 1,
          size,
          response_format: 'b64_json',
        }),
        signal: AbortSignal.timeout(60_000),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        return { content: `DALL-E error: HTTP ${res.status} — ${errText.slice(0, 300)}`, is_error: true };
      }

      const data = await res.json() as { data: Array<{ b64_json: string; revised_prompt?: string }> };
      const imgData = data.data[0];
      if (!imgData) return { content: 'No image returned from DALL-E.', is_error: true };

      const buf = Buffer.from(imgData.b64_json, 'base64');
      const filePath = join(ctx.tempDir, `dalle-${Date.now()}.png`);
      writeFileSync(filePath, buf);

      return {
        content: `Image generated${imgData.revised_prompt ? ` (revised prompt: "${imgData.revised_prompt}")` : ''}`,
        media: [{ type: 'image', path: filePath, mimeType: 'image/png', caption: prompt.slice(0, 200) }],
      };
    } catch (err) {
      return { content: `Image generation error: ${err instanceof Error ? err.message : String(err)}`, is_error: true };
    }
  },
};

export const ttsTool: ToolDefinition = {
  name: 'tts',
  description: 'Convert text to speech using ElevenLabs. The voice message will be automatically sent to the Telegram chat.',
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
