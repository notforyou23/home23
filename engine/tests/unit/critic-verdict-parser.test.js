const { expect } = require('chai');
const { hasVerdictTag } = require('../../src/cognition/critic-verdict-parser');

describe('critic-verdict-parser.hasVerdictTag', () => {
  it('detects INVESTIGATE tag', () => {
    expect(hasVerdictTag('Something concerning.\nINVESTIGATE: the logs')).to.equal(true);
  });

  it('detects NOTIFY tag', () => {
    expect(hasVerdictTag('Important.\nNOTIFY: jtr about the leak')).to.equal(true);
  });

  it('detects NO_ACTION tag', () => {
    expect(hasVerdictTag('Reflection only.\nNO_ACTION')).to.equal(true);
  });

  it('detects OBSERVE tag', () => {
    expect(hasVerdictTag('Good sign.\nOBSERVE: baseline is stable')).to.equal(true);
  });

  it('detects ACT tag', () => {
    expect(hasVerdictTag('Time to move.\nACT: {"action":"x"}')).to.equal(true);
  });

  it('detects VERDICT: keep/revise/discard', () => {
    expect(hasVerdictTag('Analysis...\nVERDICT: discard')).to.equal(true);
    expect(hasVerdictTag('Analysis...\nVERDICT: keep')).to.equal(true);
    expect(hasVerdictTag('Analysis...\nVERDICT: revise')).to.equal(true);
  });

  it('returns false for prose-poem output with no verdict', () => {
    const text = `The moon is a pocket-watch that keeps ticking backward,
      and every Tuesday is a door that forgets it was once a window.`;
    expect(hasVerdictTag(text)).to.equal(false);
  });

  it('returns false for empty or non-string inputs', () => {
    expect(hasVerdictTag('')).to.equal(false);
    expect(hasVerdictTag(null)).to.equal(false);
    expect(hasVerdictTag(undefined)).to.equal(false);
    expect(hasVerdictTag(42)).to.equal(false);
  });

  it('is case-insensitive', () => {
    expect(hasVerdictTag('result\ninvestigate: something')).to.equal(true);
  });
});
