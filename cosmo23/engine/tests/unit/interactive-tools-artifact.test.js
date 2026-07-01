const { expect } = require('chai');

const { executeTool } = require('../../src/interactive/interactive-tools');

describe('InteractiveTools artifact grounding', () => {
  it('prefixes brain_query results with current artifact truth', async () => {
    const result = await executeTool('brain_query', { query: 'fan anecdotes', limit: 1 }, {
      orchestrator: {
        memory: {
          query: async () => [{
            concept: 'prior-claim',
            summary: 'Graph memory says there may be anecdotes.',
            score: 0.91
          }]
        },
        liveStatusProvider: () => ({
          artifactInventory: {
            answerSubstrate: 'meta_only',
            sourceEvidence: { routeReceiptFiles: ['outputs/research/a/source_attempts.jsonl'] },
            categories: {
              rawAnecdotes: { files: 0, records: 0 },
              extractedRecords: { files: 0, records: 0 }
            },
            totals: { invalidJsonFiles: 1 },
            warnings: ['raw_anecdotes_missing']
          }
        })
      },
      logger: { error: () => {} }
    });

    expect(result).to.match(/^Artifact truth \(checked before brain memory\):/);
    expect(result).to.include('Answer substrate: meta_only');
    expect(result).to.include('Source receipt files: 1');
    expect(result).to.include('Invalid JSON files: 1');
    expect(result).to.include('Warnings: raw_anecdotes_missing');
    expect(result).to.include('[prior-claim]');
  });
});
