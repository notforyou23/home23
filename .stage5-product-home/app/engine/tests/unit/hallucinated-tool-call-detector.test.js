const { expect } = require('chai');
const {
  hasHallucinatedToolCall,
  countHallucinatedToolCalls,
} = require('../../src/cognition/hallucinated-tool-call-detector');

describe('hallucinated-tool-call-detector', () => {
  it('detects [TOOL_CALL: name] text', () => {
    expect(hasHallucinatedToolCall('I will [TOOL_CALL: query_brain] to check')).to.equal(true);
  });

  it('detects lowercase [tool_call: name]', () => {
    expect(hasHallucinatedToolCall('Running [tool_call: get_active_goals]')).to.equal(true);
  });

  it('detects variations: [TOOL: name] and [TOOL_CALL name]', () => {
    expect(hasHallucinatedToolCall('[TOOL: read_surface]')).to.equal(true);
    expect(hasHallucinatedToolCall('[tool call: something]')).to.equal(true);
  });

  it('counts multiple occurrences', () => {
    const text = '[TOOL_CALL: a] [TOOL_CALL: b] [tool_call: c]';
    expect(countHallucinatedToolCalls(text)).to.equal(3);
  });

  it('returns 0 for prose with no tool-call syntax', () => {
    expect(countHallucinatedToolCalls('The moon is bright tonight.')).to.equal(0);
    expect(hasHallucinatedToolCall('The moon is bright tonight.')).to.equal(false);
  });

  it('does NOT match code-style function invocations', () => {
    expect(hasHallucinatedToolCall('query_brain() returns a result')).to.equal(false);
    expect(hasHallucinatedToolCall('call query_brain with arg')).to.equal(false);
  });

  it('handles empty/non-string inputs', () => {
    expect(hasHallucinatedToolCall('')).to.equal(false);
    expect(hasHallucinatedToolCall(null)).to.equal(false);
    expect(countHallucinatedToolCalls(undefined)).to.equal(0);
  });
});
