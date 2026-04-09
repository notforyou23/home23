/**
 * COSMO Home 2.3 — Text-to-Speech Service
 *
 * Wraps TTS providers (currently ElevenLabs) to produce
 * audio buffers from text. Caller decides what to do with output.
 */

import type { TTSConfig } from '../types.js';

// ─── TTS Service ─────────────────────────────────────────────

export class TTSService {
  private config: TTSConfig;

  constructor(config: TTSConfig) {
    this.config = config;
  }

  /**
   * Convert text to speech audio.
   *
   * If config.auto === 'tagged' and tagged is not true, returns null
   * (only speaks explicitly tagged messages).
   *
   * Returns an audio/mpeg buffer on success, or null if skipped.
   */
  async speak(text: string, tagged?: boolean): Promise<Buffer | null> {
    if (!this.isEnabled()) return null;

    // In 'tagged' mode, only speak messages that are explicitly tagged
    if (this.config.auto === 'tagged' && !tagged) {
      return null;
    }

    if (this.config.provider === 'elevenlabs') {
      return this.speakElevenLabs(text);
    }

    console.warn(`[tts] Unknown provider: ${this.config.provider}`);
    return null;
  }

  /**
   * Whether TTS is enabled and has credentials.
   */
  isEnabled(): boolean {
    return this.config.enabled && !!this.config.apiKey;
  }

  // ─── Provider Implementations ─────────────────────────────

  private async speakElevenLabs(text: string): Promise<Buffer> {
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${this.config.voiceId}`;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'xi-api-key': this.config.apiKey!,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text,
        model_id: this.config.modelId,
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
        },
      }),
    });

    if (!res.ok) {
      throw new Error(`[tts] ElevenLabs ${res.status}: ${await res.text()}`);
    }

    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }
}
