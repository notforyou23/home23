const { expect } = require('chai');

const {
  deriveResearchContract,
  evaluateResearchEvidence,
  collectResearchEvidence,
  extractWebSearchQueries
} = require('../../src/core/research-contract');

describe('ResearchContract', () => {
  it('detects explicit web-search/source-url research obligations', () => {
    const contract = deriveResearchContract({
      title: 'Execute fan anecdote searches',
      description: `Run web_search for "Legion of Mary Keystone Berkeley fan recollections".
        Save source_url, source_type, author, and anecdote_text for every finding.`,
      successCriteria: ['Every finding has a source_url']
    });

    expect(contract.required).to.equal(true);
    expect(contract.mode).to.equal('web_research');
    expect(contract.requiredQueries).to.deep.equal([
      'Legion of Mary Keystone Berkeley fan recollections'
    ]);
    expect(contract.reasonCodes).to.include('explicit_web_search');
    expect(contract.reasonCodes).to.include('source_url_required');
  });

  it('detects scraping/acquisition obligations separately from local file work', () => {
    const acquisition = deriveResearchContract({
      agentType: 'dataacquisition',
      description: 'Scrape Archive.org per-show comments and fetch every item page.'
    });

    const localOnly = deriveResearchContract({
      agentType: 'ide',
      description: 'Read @outputs/show-details.json and write @outputs/report.md.'
    });

    expect(acquisition.required).to.equal(true);
    expect(acquisition.mode).to.equal('source_acquisition');
    expect(localOnly.required).to.equal(false);
    expect(localOnly.mode).to.equal('none');
  });

  it('preserves explicit web_search queries with nested quote types', () => {
    const queries = extractWebSearchQueries(
      `(1) web_search for 'Jerry Merl Saunders Boarding House July 1975 "I'll Take a Melody" anecdote OR review'; ` +
      `(2) web_search for "Old In the Way Boarding House September 1973 banjo Garcia fan memory site:reddit.com OR site:archive.org"`
    );

    expect(queries).to.deep.equal([
      `Jerry Merl Saunders Boarding House July 1975 "I'll Take a Melody" anecdote OR review`,
      'Old In the Way Boarding House September 1973 banjo Garcia fan memory site:reddit.com OR site:archive.org'
    ]);
  });

  it('fails required research when all searches fail or no source evidence exists', () => {
    const contract = deriveResearchContract({
      description: 'Find fan anecdotes from forums with citations and source_url fields.'
    });

    const allFailed = evaluateResearchEvidence(contract, {
      queriesAttempted: 2,
      searchFailures: [{ query: 'a' }, { query: 'b' }],
      sourcesFound: 0
    });

    const noEvidence = evaluateResearchEvidence(contract, {
      commandsRun: 3,
      filesCreated: 2,
      sourcesFound: 0,
      successfulSources: 0,
      bytesAcquired: 0
    });

    expect(allFailed.passed).to.equal(false);
    expect(allFailed.reasonCode).to.equal('all_searches_failed');
    expect(noEvidence.passed).to.equal(false);
    expect(noEvidence.reasonCode).to.equal('missing_source_evidence');
  });

  it('passes a null-result research receipt when source contact actually happened', () => {
    const contract = deriveResearchContract({
      description: 'Search forums and record source_url even if no anecdotes are found.'
    });

    const result = evaluateResearchEvidence(contract, {
      queriesAttempted: 3,
      sourcesContacted: 4,
      successfulSources: 2,
      entriesFound: 0
    });

    expect(result.passed).to.equal(true);
    expect(result.reasonCode).to.equal('source_evidence_present');
  });

  it('collects evidence from agent state, final result metadata, and acquisition manifests', () => {
    const agentState = {
      agent: {
        agentId: 'agent_1',
        agentType: 'dataacquisition',
        acquisitionManifest: {
          sources: [
            { url: 'https://archive.org/a', status: 200, bytes: 1234 },
            { url: 'https://archive.org/b', status: 404 }
          ],
          pagesAcquired: 1,
          filesDownloaded: 0,
          bytesAcquired: 1234,
          errors: []
        },
        accomplishment: {
          metrics: {
            commandsRun: 2
          }
        }
      }
    };

    const evidence = collectResearchEvidence([agentState]);
    expect(evidence.sourcesContacted).to.equal(2);
    expect(evidence.successfulSources).to.equal(1);
    expect(evidence.bytesAcquired).to.equal(1234);
    expect(evidence.commandsRun).to.equal(2);
  });
});
