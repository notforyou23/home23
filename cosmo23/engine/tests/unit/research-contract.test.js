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

  it('derives executable source provider hints for typed research obligations', () => {
    const contract = deriveResearchContract({
      description: [
        'Collect Internet Archive review threads and archive file lists.',
        'Check Wayback CDX and Common Crawl captures for the original URL.',
        'Resolve Wikidata knowledge graph entities, DOI/Crossref/OpenAlex literature, arXiv preprints, PubMed PMIDs, RSS feeds, and sitemaps.'
      ].join(' ')
    });

    expect(contract.required).to.equal(true);
    expect(contract.mode).to.equal('source_acquisition');
    expect(contract.reasonCodes).to.include.members([
      'archive_research',
      'archive_file_research',
      'historical_web_research',
      'knowledge_graph_research',
      'scholarly_research',
      'preprint_research',
      'biomedical_research',
      'feed_research'
    ]);
    expect(contract.sourceProviderHints).to.include.members([
      'archive.advancedsearch',
      'archive.metadata',
      'archive.reviews',
      'archive.files',
      'wayback.availability',
      'wayback.cdx',
      'commoncrawl.cdx',
      'wikidata.entity_search',
      'wikidata.sparql',
      'openalex.works',
      'crossref.works',
      'semantic_scholar.paper_search',
      'arxiv.query',
      'pubmed.esearch_summary',
      'rss.feed',
      'feed.sitemap'
    ]);
  });

  it('preserves explicit source provider hints from supplied research contracts', () => {
    const contract = deriveResearchContract({
      metadata: {
        researchContract: {
          required: true,
          mode: 'source_acquisition',
          sourceProviderHints: ['wikidata.sparql', 'wikidata.sparql', 'openalex.works']
        }
      }
    });

    expect(contract.sourceProviderHints).to.deep.equal(['wikidata.sparql', 'openalex.works']);
  });

  it('maps X/Twitter discourse research to the Home23 x-research skill provider', () => {
    const contract = deriveResearchContract({
      description: 'Find what people are saying on X/Twitter about Home23 research skills.',
      successCriteria: ['Return tweet URLs and source evidence']
    });

    expect(contract.required).to.equal(true);
    expect(contract.reasonCodes).to.include('social_research');
    expect(contract.sourceProviderHints).to.include('home23.skill.x_research.search');
  });

  it('does not leak archive or X providers into a Reddit-only source scope', () => {
    const contract = deriveResearchContract({
      agentType: 'dataacquisition',
      description: 'Scrape Reddit fan recollection threads and save raw thread JSON.',
      sourceScope: 'Reddit r/gratefuldead only',
      metadata: {
        sourceScope: 'Reddit r/gratefuldead only',
        researchDigest: {
          priorityGaps: [
            'Archive.org review scraping is a separate phase',
            'X/Twitter discourse is a separate phase'
          ]
        }
      }
    });

    expect(contract.required).to.equal(true);
    expect(contract.sourceProviderHints).to.not.include('archive.advancedsearch');
    expect(contract.sourceProviderHints).to.not.include('archive.metadata');
    expect(contract.sourceProviderHints).to.not.include('archive.reviews');
    expect(contract.sourceProviderHints).to.not.include('home23.skill.x_research.search');
  });

  it('does not turn local-memory missions into external source obligations', () => {
    const contract = deriveResearchContract({
      agentType: 'ide',
      description: `Query all local memory and cognitive systems for existing Jerry Garcia side project anecdotes.
        Execute query_memory with query strings including 'side project fan stories' and 'jerry garcia interview quotes'.
        Record query_string, result_count, key_excerpts, and source_type in @outputs/garcia-memory-query-results.json.`,
      sourceScope: 'Local memory system — all internal cognitive stores (memory, journal, thoughts, dreams, graph)',
      metadata: {
        sourceScope: 'Local memory system — all internal cognitive stores (memory, journal, thoughts, dreams, graph)'
      }
    });

    expect(contract.required).to.equal(false);
    expect(contract.mode).to.equal('none');
    expect(contract.requiredEvidence).to.deep.equal([]);
    expect(contract.sourceProviderHints).to.deep.equal([]);
    expect(contract.reasonCodes).to.deep.equal([]);
  });

  it('does not schedule source acquisition for explicit no-acquisition gap inventories', () => {
    const contract = deriveResearchContract({
      agentType: 'ide',
      description: `Create a local gap inventory from @outputs/garcia-anecdotes-extracted.json.
        Include an external source map with fan forums, Archive.org reviews, Reddit threads,
        interview compilations, podcast transcripts, and specific web_search queries to use later
        when web access becomes available.`,
      sourceScope: 'Synthesis and gap analysis — no source data acquisition, purely analytical framework based on local findings',
      metadata: {
        sourceScope: 'Synthesis and gap analysis — no source data acquisition, purely analytical framework based on local findings'
      }
    });

    expect(contract.required).to.equal(false);
    expect(contract.mode).to.equal('none');
    expect(contract.requiredEvidence).to.deep.equal([]);
    expect(contract.sourceProviderHints).to.deep.equal([]);
    expect(contract.reasonCodes).to.deep.equal([]);
  });

  it('local-only scope overrides malformed supplied research contracts on resumed tasks', () => {
    const contract = deriveResearchContract({
      agentType: 'ide',
      description: 'Query local memory for fan stories and interview quotes.',
      sourceScope: 'Local memory system — all internal cognitive stores (memory, journal, thoughts, dreams, graph)',
      metadata: {
        sourceScope: 'Local memory system — all internal cognitive stores (memory, journal, thoughts, dreams, graph)',
        researchContract: {
          required: true,
          mode: 'web_research',
          requiredEvidence: ['successful_source_contact'],
          reasonCodes: ['social_research'],
          sourceProviderHints: ['home23.skill.x_research.search']
        }
      }
    });

    expect(contract.required).to.equal(false);
    expect(contract.mode).to.equal('none');
    expect(contract.requiredEvidence).to.deep.equal([]);
    expect(contract.sourceProviderHints).to.deep.equal([]);
    expect(contract.reasonCodes).to.deep.equal([]);
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

  it('does not treat bytes alone as successful source evidence', () => {
    const contract = deriveResearchContract({
      agentType: 'dataacquisition',
      description: 'Scrape Reddit fan recollection threads and save source_url evidence.',
      sourceScope: 'Reddit r/gratefuldead only'
    });

    const result = evaluateResearchEvidence(contract, {
      bytesAcquired: 80000,
      sourcesFound: 0,
      sourcesContacted: 0,
      successfulSources: 0,
      pagesAcquired: 0,
      filesDownloaded: 0
    });

    expect(result.passed).to.equal(false);
    expect(result.reasonCode).to.equal('missing_source_evidence');
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
