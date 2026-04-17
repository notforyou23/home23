const { expect } = require('chai');
const { validateDoneWhen, DEFAULT_VAGUENESS_CONFIG } = require('../../src/goals/done-when-gate');

describe('done-when-gate', () => {
  const knownTypes = ['file_exists', 'file_created_after', 'memory_node_tagged',
                      'memory_node_matches', 'output_count_since', 'judged'];

  it('accepts a well-formed doneWhen with a file_exists criterion', () => {
    const r = validateDoneWhen({
      version: 1,
      criteria: [{ type: 'file_exists', path: 'outputs/x.md' }]
    }, { knownTypes });
    expect(r.valid).to.equal(true);
  });

  it('rejects missing doneWhen', () => {
    const r = validateDoneWhen(undefined, { knownTypes });
    expect(r.valid).to.equal(false);
    expect(r.reason).to.match(/missing/i);
  });

  it('rejects empty criteria array', () => {
    const r = validateDoneWhen({ version: 1, criteria: [] }, { knownTypes });
    expect(r.valid).to.equal(false);
    expect(r.reason).to.match(/empty/i);
  });

  it('rejects unknown criterion type', () => {
    const r = validateDoneWhen({
      version: 1,
      criteria: [{ type: 'astrology_says_yes' }]
    }, { knownTypes });
    expect(r.valid).to.equal(false);
    expect(r.reason).to.match(/unknown/i);
  });

  it('rejects judged criterion shorter than min length', () => {
    const r = validateDoneWhen({
      version: 1,
      criteria: [{ type: 'judged', criterion: 'too short' }]
    }, { knownTypes, ...DEFAULT_VAGUENESS_CONFIG });
    expect(r.valid).to.equal(false);
    expect(r.reason).to.match(/short|vague/i);
  });

  it('rejects judged criterion with no concreteness anchor', () => {
    const r = validateDoneWhen({
      version: 1,
      criteria: [{ type: 'judged',
        criterion: 'deep thinking happens across many dimensions of thought' }]
    }, { knownTypes, ...DEFAULT_VAGUENESS_CONFIG });
    expect(r.valid).to.equal(false);
    expect(r.reason).to.match(/anchor|vague/i);
  });

  it('accepts judged criterion with an anchor keyword', () => {
    const r = validateDoneWhen({
      version: 1,
      criteria: [{ type: 'judged',
        criterion: 'An output file exists containing at least three concrete examples tied to sensor readings.' }]
    }, { knownTypes, ...DEFAULT_VAGUENESS_CONFIG });
    expect(r.valid).to.equal(true);
  });

  it('rejects file_exists without a path', () => {
    const r = validateDoneWhen({
      version: 1,
      criteria: [{ type: 'file_exists' }]
    }, { knownTypes });
    expect(r.valid).to.equal(false);
    expect(r.reason).to.match(/path/i);
  });
});
