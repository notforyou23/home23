const { expect } = require('chai');

const { SourceProviderRegistry } = require('../../src/core/source-provider-registry');

describe('SourceProviderRegistry', () => {
  const logger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {}
  };

  function jsonResponse(data, status = 200) {
    return {
      ok: status >= 200 && status < 400,
      status,
      headers: { get: () => 'application/json' },
      json: async () => data,
      text: async () => JSON.stringify(data)
    };
  }

  function textResponse(text, status = 200, contentType = 'application/xml') {
    return {
      ok: status >= 200 && status < 400,
      status,
      headers: { get: () => contentType },
      json: async () => JSON.parse(text),
      text: async () => text
    };
  }

  it('aggregates typed source providers into normalized candidates and attempts', async () => {
    const calls = [];
    const fetchImpl = async (url) => {
      const value = String(url);
      calls.push(value);
      if (value.includes('archive.org/advancedsearch.php')) {
        return jsonResponse({
          response: {
            docs: [{
              identifier: 'gd1974-12-31',
              title: 'December 31, 1974 Keystone Berkeley',
              description: 'Garcia Saunders Legion of Mary show',
              mediatype: 'audio',
              date: '1974-12-31'
            }]
          }
        });
      }
      if (value.includes('wikidata.org/w/api.php')) {
        return jsonResponse({
          search: [{
            id: 'Q123',
            label: 'Legion of Mary',
            description: 'Jerry Garcia band',
            concepturi: 'http://www.wikidata.org/entity/Q123'
          }]
        });
      }
      if (value.includes('api.openalex.org/works')) {
        return jsonResponse({
          results: [{
            id: 'https://openalex.org/W123',
            display_name: 'A scholarly history of Bay Area live music',
            publication_year: 2024,
            doi: 'https://doi.org/10.1234/example',
            primary_location: { landing_page_url: 'https://journal.example/work' }
          }]
        });
      }
      throw new Error(`Unexpected URL: ${value}`);
    };

    const registry = new SourceProviderRegistry(logger, {}, { fetchImpl });
    const result = await registry.acquire('Legion of Mary Keystone Berkeley source_url', {
      providers: ['archive.advancedsearch', 'wikidata.entity_search', 'openalex.works'],
      maxResults: 2
    });

    expect(result.success).to.equal(true);
    expect(result.attempts.map(item => item.route)).to.deep.equal([
      'archive.advancedsearch',
      'wikidata.entity_search',
      'openalex.works'
    ]);
    expect(result.attempts.every(item => item.status === 'accepted')).to.equal(true);
    expect(result.candidates.map(item => item.provider)).to.deep.equal([
      'archive.advancedsearch',
      'wikidata.entity_search',
      'openalex.works'
    ]);
    expect(result.candidates.map(item => item.sourceType)).to.deep.equal([
      'archive_item',
      'knowledge_entity',
      'scholarly_work'
    ]);
    expect(result.candidates.map(item => item.url)).to.deep.equal([
      'https://archive.org/details/gd1974-12-31',
      'http://www.wikidata.org/entity/Q123',
      'https://journal.example/work'
    ]);
    expect(calls).to.have.length(3);
  });

  it('queries historical web corpora for explicit URLs', async () => {
    const fetchImpl = async (url) => {
      const value = String(url);
      if (value.includes('wayback/available')) {
        return jsonResponse({
          archived_snapshots: {
            closest: {
              available: true,
              url: 'https://web.archive.org/web/20200101000000/https://example.com/page',
              timestamp: '20200101000000',
              status: '200'
            }
          }
        });
      }
      if (value.includes('index.commoncrawl.org/collinfo.json')) {
        return jsonResponse([{ id: 'CC-MAIN-2026-18', 'cdx-api': 'https://index.commoncrawl.org/CC-MAIN-2026-18-index' }]);
      }
      if (value.includes('CC-MAIN-2026-18-index')) {
        return jsonResponse([{
          url: 'https://example.com/page',
          timestamp: '20260101000000',
          status: '200',
          mime: 'text/html',
          digest: 'ABC123'
        }]);
      }
      throw new Error(`Unexpected URL: ${value}`);
    };

    const registry = new SourceProviderRegistry(logger, {}, { fetchImpl });
    const result = await registry.acquire('Check https://example.com/page', {
      providers: ['wayback.availability', 'commoncrawl.cdx'],
      maxResults: 3
    });

    expect(result.success).to.equal(true);
    expect(result.candidates.map(item => item.sourceType)).to.deep.equal([
      'wayback_snapshot',
      'commoncrawl_capture'
    ]);
    expect(result.candidates[0].metadata.timestamp).to.equal('20200101000000');
    expect(result.candidates[1].metadata.index).to.equal('CC-MAIN-2026-18');
  });

  it('records provider failures without discarding successful providers', async () => {
    const fetchImpl = async (url) => {
      const value = String(url);
      if (value.includes('archive.org/advancedsearch.php')) {
        throw new Error('archive unavailable');
      }
      if (value.includes('wikidata.org/w/api.php')) {
        return jsonResponse({
          search: [{
            id: 'Q123',
            label: 'Legion of Mary',
            description: 'Jerry Garcia band',
            concepturi: 'http://www.wikidata.org/entity/Q123'
          }]
        });
      }
      throw new Error(`Unexpected URL: ${value}`);
    };

    const registry = new SourceProviderRegistry(logger, {}, { fetchImpl });
    const result = await registry.acquire('Legion of Mary', {
      providers: ['archive.advancedsearch', 'wikidata.entity_search'],
      maxResults: 1
    });

    expect(result.success).to.equal(true);
    expect(result.attempts.map(item => item.status)).to.deep.equal(['failed', 'accepted']);
    expect(result.attempts[0].error).to.equal('archive unavailable');
    expect(result.candidates).to.have.length(1);
  });

  it('selects a broad source mesh for source-required fan anecdote research', () => {
    const registry = new SourceProviderRegistry(logger, {}, {});
    const providers = registry.selectProviders('Find fan anecdotes and listener reviews for Jerry Garcia side project shows', {
      sourceRequired: true,
      mission: {
        description: 'Extract fan recollections, source_url fields, and forum memories.',
        metadata: {
          researchContract: {
            required: true,
            sourceProviderHints: ['archive.reviews']
          }
        }
      }
    });

    expect(providers).to.include('web.search');
    expect(providers).to.include('archive.advancedsearch');
    expect(providers).to.include('archive.reviews');
  });

  it('does not leave generic source-required research with only one route', () => {
    const registry = new SourceProviderRegistry(logger, {}, {});
    const providers = registry.selectProviders('Research the history of a local music venue', {
      sourceRequired: true,
      mission: {
        metadata: {
          researchContract: { required: true }
        }
      }
    });

    expect(providers).to.include('web.search');
    expect(providers).to.include('archive.advancedsearch');
    expect(providers).to.include('wikidata.entity_search');
    expect(providers.length).to.be.greaterThan(1);
  });

  it('extracts Internet Archive reviews and file candidates from metadata', async () => {
    const fetchImpl = async (url) => {
      const value = String(url);
      if (value.includes('archive.org/metadata/show-1975')) {
        return jsonResponse({
          metadata: { identifier: 'show-1975', title: 'Show 1975', mediatype: 'audio' },
          reviews: [{
            review_id: 'review-1',
            reviewer: 'listener',
            title: 'Great night',
            body: 'A first-person memory of the show.'
          }],
          files: [{
            name: 'show-1975_vbr.mp3',
            format: 'VBR MP3',
            size: '12345',
            md5: 'md5hash',
            sha1: 'sha1hash'
          }]
        });
      }
      throw new Error(`Unexpected URL: ${value}`);
    };

    const registry = new SourceProviderRegistry(logger, {}, { fetchImpl });
    const result = await registry.acquire('https://archive.org/details/show-1975', {
      providers: ['archive.reviews', 'archive.files'],
      maxResults: 5
    });

    expect(result.success).to.equal(true);
    expect(result.candidates.map(item => item.sourceType)).to.deep.equal([
      'archive_review',
      'archive_file'
    ]);
    expect(result.candidates[0].metadata.reviewId).to.equal('review-1');
    expect(result.candidates[1].url).to.equal('https://archive.org/download/show-1975/show-1975_vbr.mp3');
    expect(result.candidates[1].metadata.validationStrategy).to.equal('metadata_only');
  });

  it('extracts bare Internet Archive identifiers and keeps review results per identifier', async () => {
    const identifiers = [
      'legion-of-mary-the-bottom-line-nyc-1975',
      'legion-of-mary-oriental-theatre-wi-1975-wzmf'
    ];
    const fetchImpl = async (url) => {
      const value = String(url);
      const identifier = identifiers.find(id => value.includes(`archive.org/metadata/${id}`));
      if (identifier) {
        return jsonResponse({
          metadata: { identifier, title: identifier, mediatype: 'audio' },
          reviews: [{
            review_id: `${identifier}-review`,
            reviewer: 'listener',
            title: `Review for ${identifier}`,
            body: `A listener memory for ${identifier}.`
          }]
        });
      }
      throw new Error(`Unexpected URL: ${value}`);
    };

    const registry = new SourceProviderRegistry(logger, {}, { fetchImpl });
    const providers = registry.selectProviders(
      `Fetch archive reviews for identifiers: ${identifiers.join(', ')}`,
      { sourceRequired: true, mission: { description: 'Archive review extraction' } }
    );
    const result = await registry.acquire(`Fetch archive reviews for identifiers: ${identifiers.join(', ')}`, {
      providers: ['archive.metadata', 'archive.reviews'],
      maxResults: 1
    });

    expect(providers).to.include('archive.metadata');
    expect(providers).to.include('archive.reviews');
    expect(registry.extractArchiveIdentifiers(`identifiers: ${identifiers.join(', ')}`)).to.deep.equal(identifiers);
    expect(result.success).to.equal(true);
    expect(result.candidates.filter(item => item.sourceType === 'archive_review').map(item => item.metadata.identifier)).to.deep.equal(identifiers);
    expect(result.attempts.map(item => item.route)).to.deep.equal(['archive.metadata', 'archive.reviews']);
  });

  it('emits per-identifier empty review status receipts', async () => {
    const identifiers = [
      'legion-of-mary-the-bottom-line-nyc-1975',
      'legion-of-mary-oriental-theatre-wi-1975-wzmf'
    ];
    const fetchImpl = async (url) => {
      const value = String(url);
      const identifier = identifiers.find(id => value.includes(`archive.org/metadata/${id}`));
      if (identifier === identifiers[0]) {
        return jsonResponse({
          metadata: { identifier, title: identifier, mediatype: 'audio' },
          reviews: []
        });
      }
      if (identifier === identifiers[1]) {
        return jsonResponse({
          metadata: { identifier, title: identifier, mediatype: 'audio' },
          reviews: [{
            review_id: `${identifier}-review`,
            reviewer: 'listener',
            title: `Review for ${identifier}`,
            body: `A listener memory for ${identifier}.`
          }]
        });
      }
      throw new Error(`Unexpected URL: ${value}`);
    };

    const registry = new SourceProviderRegistry(logger, {}, { fetchImpl });
    const result = await registry.acquire(`Fetch archive reviews for identifiers: ${identifiers.join(', ')}`, {
      providers: ['archive.reviews'],
      maxResults: 1
    });

    const emptyReceipt = result.candidates.find(item => item.metadata.identifier === identifiers[0]);
    const reviewEntry = result.candidates.find(item => item.metadata.identifier === identifiers[1]);

    expect(emptyReceipt).to.include({
      provider: 'archive.reviews',
      sourceType: 'archive_review_status'
    });
    expect(emptyReceipt.metadata).to.include({
      status: 'no_reviews_found',
      validationStrategy: 'metadata_only'
    });
    expect(reviewEntry.sourceType).to.equal('archive_review');
    expect(result.attempts[0]).to.include({
      route: 'archive.reviews',
      status: 'accepted',
      result_count: 2
    });
  });

  it('queries Wayback CDX captures and feed sitemaps', async () => {
    const fetchImpl = async (url) => {
      const value = String(url);
      if (value.includes('web.archive.org/cdx')) {
        return jsonResponse([
          ['timestamp', 'original', 'statuscode', 'mimetype', 'digest'],
          ['20200101000000', 'https://example.com/page', '200', 'text/html', 'DIGEST1']
        ]);
      }
      if (value === 'https://example.com/sitemap.xml') {
        return textResponse('<urlset><url><loc>https://example.com/a</loc></url><url><loc>https://example.com/b</loc></url></urlset>');
      }
      throw new Error(`Unexpected URL: ${value}`);
    };

    const registry = new SourceProviderRegistry(logger, {}, { fetchImpl });
    const result = await registry.acquire('Check https://example.com/page', {
      providers: ['wayback.cdx', 'feed.sitemap'],
      maxResults: 3
    });

    expect(result.success).to.equal(true);
    expect(result.candidates.map(item => item.sourceType)).to.deep.equal([
      'wayback_cdx_capture',
      'sitemap_url',
      'sitemap_url'
    ]);
    expect(result.candidates[0].metadata.digest).to.equal('DIGEST1');
    expect(result.candidates[1].url).to.equal('https://example.com/a');
  });

  it('normalizes scholarly provider candidates across Crossref, Semantic Scholar, arXiv, and PubMed', async () => {
    const fetchImpl = async (url) => {
      const value = String(url);
      if (value.includes('api.crossref.org/works')) {
        return jsonResponse({
          message: {
            items: [{
              DOI: '10.1234/crossref',
              URL: 'https://doi.org/10.1234/crossref',
              title: ['Crossref result'],
              type: 'journal-article',
              publisher: 'Journal'
            }]
          }
        });
      }
      if (value.includes('api.semanticscholar.org/graph/v1/paper/search')) {
        return jsonResponse({
          data: [{
            paperId: 'S2-1',
            title: 'Semantic Scholar result',
            url: 'https://semanticscholar.org/paper/S2-1',
            abstract: 'Paper abstract',
            year: 2025,
            externalIds: { DOI: '10.1234/s2' }
          }]
        });
      }
      if (value.includes('export.arxiv.org/api/query')) {
        return textResponse('<feed><entry><id>http://arxiv.org/abs/2501.00001</id><title>arXiv result</title><summary>Preprint summary</summary><published>2025-01-01T00:00:00Z</published></entry></feed>');
      }
      if (value.includes('esearch.fcgi')) {
        return jsonResponse({ esearchresult: { idlist: ['12345'] } });
      }
      if (value.includes('esummary.fcgi')) {
        return jsonResponse({
          result: {
            uids: ['12345'],
            12345: {
              uid: '12345',
              title: 'PubMed result',
              source: 'PMID Journal',
              pubdate: '2025'
            }
          }
        });
      }
      throw new Error(`Unexpected URL: ${value}`);
    };

    const registry = new SourceProviderRegistry(logger, {}, { fetchImpl });
    const result = await registry.acquire('music cognition literature review', {
      providers: ['crossref.works', 'semantic_scholar.paper_search', 'arxiv.query', 'pubmed.esearch_summary'],
      maxResults: 2
    });

    expect(result.success).to.equal(true);
    expect(result.candidates.map(item => item.provider)).to.deep.equal([
      'crossref.works',
      'semantic_scholar.paper_search',
      'arxiv.query',
      'pubmed.esearch_summary'
    ]);
    expect(result.candidates.map(item => item.sourceType)).to.deep.equal([
      'scholarly_metadata',
      'scholarly_work',
      'preprint',
      'biomedical_article'
    ]);
    expect(result.candidates[3].url).to.equal('https://pubmed.ncbi.nlm.nih.gov/12345/');
  });

  it('runs Home23 x-research skill as a typed social source provider', async () => {
    const skillCalls = [];
    const skillRuntime = {
      executeSkill: async (skillId, action, params, context) => {
        skillCalls.push({ skillId, action, params, context });
        return {
          success: true,
          query: params.query,
          resultCount: 1,
          tweets: [{
            id: '2052408306116010040',
            username: 'researcher',
            name: 'Researcher',
            text: 'Home23 source routing is getting interesting.',
            created_at: '2026-06-21T12:00:00.000Z',
            metrics: { likes: 23, retweets: 2, replies: 1, quotes: 0, impressions: 1000 },
            urls: ['https://example.com/source'],
            tweet_url: 'https://x.com/researcher/status/2052408306116010040'
          }],
          savedMarkdownTo: '/tmp/x-research.md'
        };
      }
    };

    const registry = new SourceProviderRegistry(logger, {
      home23ProjectRoot: '/Users/jtr/_JTR23_/release/home23'
    }, {
      skillRuntime,
      now: () => '2026-06-21T00:00:00.000Z'
    });

    expect(registry.selectProviders('What are people saying on X about Home23 skills?'))
      .to.include('home23.skill.x_research.search');

    const result = await registry.acquire('What are people saying on X about Home23 skills?', {
      providers: ['home23.skill.x_research.search'],
      maxResults: 3,
      workspacePath: '/tmp/cosmo-run'
    });

    expect(result.success).to.equal(true);
    expect(result.attempts[0]).to.include({
      route: 'home23.skill.x_research.search',
      status: 'accepted',
      result_count: 1,
      url_count: 1
    });
    expect(skillCalls[0]).to.deep.include({
      skillId: 'x-research',
      action: 'search'
    });
    expect(skillCalls[0].params).to.include({
      query: 'What are people saying on X about Home23 skills?',
      quick: true,
      includeData: true,
      saveMarkdown: false
    });
    expect(skillCalls[0].params.limit).to.equal(3);
    expect(skillCalls[0].context.projectRoot).to.equal('/Users/jtr/_JTR23_/release/home23');
    expect(skillCalls[0].context.workspacePath).to.equal('/tmp/cosmo-run');
    expect(result.candidates[0]).to.include({
      provider: 'home23.skill.x_research.search',
      sourceType: 'social_post',
      title: '@researcher on X',
      url: 'https://x.com/researcher/status/2052408306116010040'
    });
    expect(result.candidates[0].metadata).to.include({
      skillId: 'x-research',
      action: 'search',
      tweetId: '2052408306116010040',
      savedMarkdownTo: '/tmp/x-research.md'
    });
    expect(result.candidates[0].metadata.expandedUrls).to.deep.equal(['https://example.com/source']);
  });

  it('passes browser context through to Home23 skill providers', async () => {
    const skillCalls = [];
    const browser = { kind: 'browser-session' };
    const registry = new SourceProviderRegistry(logger, {
      home23ProjectRoot: '/Users/jtr/_JTR23_/release/home23'
    }, {
      skillRuntime: {
        executeSkill: async (skillId, action, params, context) => {
          skillCalls.push({ skillId, action, params, context });
          return { success: true, tweets: [] };
        }
      }
    });

    await registry.acquire('Search X for browser-backed research', {
      providers: ['home23.skill.x_research.search'],
      browser,
      workspacePath: '/tmp/cosmo-run'
    });

    expect(skillCalls[0].context.browser).to.equal(browser);
  });
});
