const { expect } = require('chai');

const { FreeWebSearch } = require('../../src/tools/web-search-free');

describe('FreeWebSearch backend selection', () => {
  const logger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {}
  };

  it('defaults to the Home23 local SearXNG endpoint when no URL is configured', () => {
    const searcher = new FreeWebSearch(logger, {});

    expect(searcher.searxngUrl).to.equal('http://localhost:8888');
  });

  it('can refuse DuckDuckGo fallback for source-required research', async () => {
    const searcher = new FreeWebSearch(logger, { allowDuckDuckGoFallback: false });

    searcher.searchSearXNG = async () => [];
    searcher.searchBrave = async () => [];
    searcher.searchDuckDuckGo = async () => {
      throw new Error('DuckDuckGo fallback should not run');
    };

    const result = await searcher.search('Legion of Mary fan recollections', { maxResults: 3 });

    expect(result.success).to.equal(false);
    expect(result.error).to.equal('Authoritative search backend unavailable');
    expect(result.source).to.equal('authoritative-search');
  });

  it('aggregates Brave and SearXNG results before falling back', async () => {
    const calls = [];
    const searcher = new FreeWebSearch(logger, {
      braveApiKey: 'test-brave-key',
      searxngUrl: 'http://localhost:8888'
    });

    searcher.searchBrave = async () => {
      calls.push('brave');
      return [
        { title: 'Brave source', url: 'https://example.com/brave', snippet: 'from Brave', position: 1, engine: 'brave' },
        { title: 'Duplicate source', url: 'https://example.com/shared', snippet: 'from Brave', position: 2, engine: 'brave' }
      ];
    };
    searcher.searchSearXNG = async () => {
      calls.push('searxng');
      return [
        { title: 'SearXNG source', url: 'https://example.com/searxng', snippet: 'from SearXNG', position: 1, engine: 'searxng' },
        { title: 'Duplicate source', url: 'https://example.com/shared', snippet: 'from SearXNG', position: 2, engine: 'searxng' }
      ];
    };
    searcher.searchDuckDuckGo = async () => {
      throw new Error('DuckDuckGo should not run when authoritative backends returned results');
    };

    const result = await searcher.search('Legion of Mary fan recollections', { maxResults: 10 });

    expect(calls).to.deep.equal(['brave', 'searxng']);
    expect(result.success).to.equal(true);
    expect(result.source).to.equal('brave+searxng');
    expect(result.results.map(item => item.url)).to.deep.equal([
      'https://example.com/brave',
      'https://example.com/shared',
      'https://example.com/searxng'
    ]);
  });
});
