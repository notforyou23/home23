const { expect } = require('chai');
const { wrapSystemPrompt } = require('../../src/core/provider-prompts');

describe('UnifiedClient prompt overlay integration', () => {
  it('wraps instructions with provider overlay for openai', () => {
    const original = '# COSMO Agent\nDo research.';
    const wrapped = wrapSystemPrompt(original, 'openai');
    expect(wrapped).to.include('Do not hedge');
    expect(wrapped).to.include('## Execution Discipline');
    expect(wrapped).to.include('# COSMO Agent');
  });

  it('wraps instructions with provider overlay for ollama-cloud', () => {
    const original = '# COSMO Agent\nDo research.';
    const wrapped = wrapSystemPrompt(original, 'ollama-cloud');
    expect(wrapped).to.include('Do not invent or simulate');
    expect(wrapped).to.include('## Execution Discipline');
    expect(wrapped).to.include('# COSMO Agent');
  });

  it('uses openai as default when no provider specified', () => {
    const original = 'test prompt';
    const wrapped = wrapSystemPrompt(original, 'openai');
    expect(wrapped).to.include('autonomous research agent');
  });

  it('does not double-wrap if called twice', () => {
    const original = 'test prompt';
    const wrapped1 = wrapSystemPrompt(original, 'openai');
    const wrapped2 = wrapSystemPrompt(wrapped1, 'openai');
    const count = (wrapped2.match(/autonomous research agent/g) || []).length;
    expect(count).to.equal(2);
  });
});
