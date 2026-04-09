const { expect } = require('chai');
const { getProviderOverlay, EXECUTION_VOICE_BLOCK, wrapSystemPrompt } = require('../../src/core/provider-prompts');

describe('provider-prompts', () => {
  describe('getProviderOverlay', () => {
    it('returns anthropic overlay for anthropic provider', () => {
      const overlay = getProviderOverlay('anthropic');
      expect(overlay).to.include('autonomous research agent');
      expect(overlay).to.include('Do not narrate tool usage');
      expect(overlay).to.not.include('Claude Code');
    });

    it('returns openai overlay with JSON discipline', () => {
      const overlay = getProviderOverlay('openai');
      expect(overlay).to.include('no markdown fences');
      expect(overlay).to.include('Do not hedge');
    });

    it('returns openai-codex overlay matching openai', () => {
      const codex = getProviderOverlay('openai-codex');
      const openai = getProviderOverlay('openai');
      expect(codex).to.equal(openai);
    });

    it('returns xai overlay with conciseness directive', () => {
      const overlay = getProviderOverlay('xai');
      expect(overlay).to.include('Dense findings');
    });

    it('returns ollama-cloud overlay with strongest guardrails', () => {
      const overlay = getProviderOverlay('ollama-cloud');
      expect(overlay).to.include('Do not invent or simulate tool responses');
      expect(overlay).to.include('Do not add extra fields');
    });

    it('returns local overlay matching ollama-cloud', () => {
      const local = getProviderOverlay('local');
      const cloud = getProviderOverlay('ollama-cloud');
      expect(local).to.equal(cloud);
    });

    it('returns generic fallback for unknown providers', () => {
      const overlay = getProviderOverlay('some-new-provider');
      expect(overlay).to.include('autonomous research agent');
      expect(overlay).to.include('valid JSON only');
      expect(overlay).to.not.include('Do not hedge');
    });
  });

  describe('EXECUTION_VOICE_BLOCK', () => {
    it('is a non-empty string', () => {
      expect(EXECUTION_VOICE_BLOCK).to.be.a('string');
      expect(EXECUTION_VOICE_BLOCK.length).to.be.greaterThan(100);
    });

    it('contains execution discipline header', () => {
      expect(EXECUTION_VOICE_BLOCK).to.include('## Execution Discipline');
    });

    it('contains key directives', () => {
      expect(EXECUTION_VOICE_BLOCK).to.include('executor, not an advisor');
      expect(EXECUTION_VOICE_BLOCK).to.include('When done, stop');
    });
  });

  describe('wrapSystemPrompt', () => {
    const originalPrompt = '# COSMO Cognitive Agent\nYou are a specialized module.';

    it('prepends overlay then voice then original', () => {
      const wrapped = wrapSystemPrompt(originalPrompt, 'anthropic');
      const overlayPos = wrapped.indexOf('autonomous research agent');
      const voicePos = wrapped.indexOf('## Execution Discipline');
      const originalPos = wrapped.indexOf('# COSMO Cognitive Agent');
      expect(overlayPos).to.be.lessThan(voicePos);
      expect(voicePos).to.be.lessThan(originalPos);
    });

    it('preserves original prompt content exactly', () => {
      const wrapped = wrapSystemPrompt(originalPrompt, 'openai');
      expect(wrapped).to.include(originalPrompt);
    });

    it('uses different overlays for different providers', () => {
      const anthropic = wrapSystemPrompt(originalPrompt, 'anthropic');
      const ollama = wrapSystemPrompt(originalPrompt, 'ollama-cloud');
      expect(anthropic).to.not.equal(ollama);
      expect(anthropic).to.include('Do not narrate tool usage');
      expect(ollama).to.include('Do not invent or simulate tool responses');
    });

    it('handles empty provider gracefully', () => {
      const wrapped = wrapSystemPrompt(originalPrompt, '');
      expect(wrapped).to.include(originalPrompt);
      expect(wrapped).to.include('## Execution Discipline');
    });
  });
});
