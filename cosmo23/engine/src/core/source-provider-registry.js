const { FreeWebSearch } = require('../tools/web-search-free');

class SourceProviderRegistry {
  constructor(logger = null, config = {}, options = {}) {
    this.logger = logger;
    this.config = config || {};
    this.fetchImpl = options.fetchImpl || global.fetch;
    this.webSearch = options.webSearch || null;
    this.now = options.now || (() => new Date().toISOString());
    this.defaultMaxResults = this.config.maxResults || 5;
  }

  listProviders() {
    return [
      'web.search',
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
      'feed.sitemap',
      'sitemap.xml'
    ];
  }

  selectProviders(query = '', context = {}) {
    const text = [
      query,
      context.mission?.description,
      context.mission?.expectedOutput,
      ...(context.mission?.successCriteria || [])
    ]
      .filter(Boolean)
      .join('\n')
      .toLowerCase();
    const providers = new Set();
    const explicitProviders = this.config.providers || this.config.enabledProviders;
    if (Array.isArray(explicitProviders) && explicitProviders.length > 0) {
      return explicitProviders.filter(id => this.listProviders().includes(id));
    }

    if (context.includeWebSearch === true) {
      providers.add('web.search');
    }
    if (/\b(archive\.org|internet archive|archive item|review thread|taper notes?)\b/.test(text)) {
      providers.add('archive.advancedsearch');
    }
    if (/archive\.org\/details\//.test(text)) {
      providers.add('archive.metadata');
    }
    if (/\b(archive reviews?|review thread|listener reviews?)\b/.test(text)) {
      providers.add('archive.reviews');
    }
    if (/\b(archive files?|download files?|file list|audio files?|ocr files?)\b/.test(text)) {
      providers.add('archive.files');
    }
    if (/\b(wayback|web archive|historical captures?|mementos?)\b/.test(text)) {
      providers.add('wayback.availability');
    }
    if (/\b(wayback cdx|cdx captures?|capture search)\b/.test(text)) {
      providers.add('wayback.cdx');
    }
    if (/\b(common crawl|warc|wet file|historical web crawl)\b/.test(text)) {
      providers.add('commoncrawl.cdx');
    }
    if (/\b(wikidata|knowledge graph|entity id|canonical entity|sparql)\b/.test(text)) {
      providers.add(text.includes('sparql') ? 'wikidata.sparql' : 'wikidata.entity_search');
    }
    if (/\b(openalex|scholarly|academic|literature review|citation graph)\b/.test(text)) {
      providers.add('openalex.works');
    }
    if (/\b(crossref|doi|journal article|publication metadata)\b/.test(text)) {
      providers.add('crossref.works');
    }
    if (/\b(semantic scholar|s2ag|corpus id)\b/.test(text)) {
      providers.add('semantic_scholar.paper_search');
    }
    if (/\b(arxiv|preprint)\b/.test(text)) {
      providers.add('arxiv.query');
    }
    if (/\b(pubmed|pmid|biomedical|ncbi)\b/.test(text)) {
      providers.add('pubmed.esearch_summary');
    }
    if (/\b(rss|atom feed|podcast feed)\b/.test(text)) {
      providers.add('rss.feed');
    }
    if (/\b(sitemap|site map)\b/.test(text)) {
      providers.add('feed.sitemap');
    }

    return [...providers];
  }

  async acquire(query, options = {}) {
    const providers = (options.providers || this.selectProviders(query, options))
      .filter(id => this.listProviders().includes(id));
    const maxResults = options.maxResults || this.defaultMaxResults;
    const attempts = [];
    const candidates = [];

    for (const providerId of providers) {
      const startedAt = Date.now();
      try {
        const providerCandidates = await this.runProvider(providerId, query, { ...options, maxResults });
        const normalized = providerCandidates
          .filter(candidate => candidate && candidate.url)
          .slice(0, maxResults)
          .map((candidate, index) => this.normalizeCandidate(providerId, candidate, index));
        candidates.push(...normalized);
        attempts.push({
          timestamp: this.now(),
          route: providerId,
          status: normalized.length > 0 ? 'accepted' : 'empty',
          result_count: normalized.length,
          url_count: normalized.filter(item => item.url).length,
          duration_ms: Date.now() - startedAt
        });
      } catch (error) {
        attempts.push({
          timestamp: this.now(),
          route: providerId,
          status: 'failed',
          result_count: 0,
          url_count: 0,
          error: error.message,
          duration_ms: Date.now() - startedAt
        });
        this.logger?.warn?.('Source provider failed', { providerId, error: error.message });
      }
    }

    return {
      success: candidates.length > 0,
      query,
      providerIds: providers,
      attempts,
      candidates
    };
  }

  async runProvider(providerId, query, options) {
    switch (providerId) {
      case 'web.search':
        return await this.searchWeb(query, options);
      case 'archive.advancedsearch':
        return await this.searchInternetArchive(query, options);
      case 'archive.metadata':
        return await this.fetchArchiveMetadata(query, options);
      case 'archive.reviews':
        return await this.fetchArchiveReviews(query, options);
      case 'archive.files':
        return await this.fetchArchiveFiles(query, options);
      case 'wayback.availability':
        return await this.queryWaybackAvailability(query, options);
      case 'wayback.cdx':
        return await this.queryWaybackCdx(query, options);
      case 'commoncrawl.cdx':
        return await this.queryCommonCrawl(query, options);
      case 'wikidata.entity_search':
        return await this.searchWikidataEntities(query, options);
      case 'wikidata.sparql':
        return await this.queryWikidataSparql(query, options);
      case 'openalex.works':
        return await this.searchOpenAlexWorks(query, options);
      case 'crossref.works':
        return await this.searchCrossrefWorks(query, options);
      case 'semantic_scholar.paper_search':
        return await this.searchSemanticScholarPapers(query, options);
      case 'arxiv.query':
        return await this.searchArxiv(query, options);
      case 'pubmed.esearch_summary':
        return await this.searchPubMed(query, options);
      case 'rss.feed':
        return await this.fetchRssFeed(query, options);
      case 'feed.sitemap':
      case 'sitemap.xml':
        return await this.fetchSitemap(query, options);
      default:
        throw new Error(`Unknown source provider: ${providerId}`);
    }
  }

  normalizeCandidate(providerId, candidate, index) {
    return {
      provider: providerId,
      sourceType: candidate.sourceType || this.defaultSourceType(providerId),
      title: candidate.title || candidate.url,
      url: candidate.url,
      snippet: candidate.snippet || '',
      position: candidate.position || index + 1,
      metadata: candidate.metadata || {},
      raw: candidate.raw || null
    };
  }

  defaultSourceType(providerId) {
    return {
      'web.search': 'web_result',
      'archive.advancedsearch': 'archive_item',
      'archive.metadata': 'archive_metadata',
      'archive.reviews': 'archive_review',
      'archive.files': 'archive_file',
      'wayback.availability': 'wayback_snapshot',
      'wayback.cdx': 'wayback_cdx_capture',
      'commoncrawl.cdx': 'commoncrawl_capture',
      'wikidata.entity_search': 'knowledge_entity',
      'wikidata.sparql': 'knowledge_graph_result',
      'openalex.works': 'scholarly_work',
      'crossref.works': 'scholarly_metadata',
      'semantic_scholar.paper_search': 'scholarly_work',
      'arxiv.query': 'preprint',
      'pubmed.esearch_summary': 'biomedical_article',
      'rss.feed': 'feed_item',
      'feed.sitemap': 'sitemap_url',
      'sitemap.xml': 'sitemap_url'
    }[providerId] || 'source_candidate';
  }

  async searchWeb(query, options = {}) {
    const searcher = this.webSearch || new FreeWebSearch(this.logger, {
      searxngUrl: this.config.searxngUrl,
      braveApiKey: this.config.braveApiKey,
      allowDuckDuckGoFallback: options.allowDuckDuckGoFallback !== false
    });
    const result = await searcher.search(query, { maxResults: options.maxResults || this.defaultMaxResults });
    return (result.results || []).map(item => ({
      title: item.title,
      url: item.url,
      snippet: item.snippet || item.description || '',
      sourceType: 'web_result',
      metadata: { backend: item.sourceBackend || item.engine || result.source },
      raw: item
    }));
  }

  async searchInternetArchive(query, options = {}) {
    const params = new URLSearchParams();
    params.set('q', query);
    params.set('output', 'json');
    params.set('rows', String(options.maxResults || this.defaultMaxResults));
    for (const field of ['identifier', 'title', 'description', 'creator', 'date', 'mediatype', 'collection']) {
      params.append('fl[]', field);
    }
    const data = await this.fetchJson(`https://archive.org/advancedsearch.php?${params.toString()}`);
    const docs = data?.response?.docs || [];
    return docs.map(doc => ({
      title: doc.title || doc.identifier,
      url: doc.identifier ? `https://archive.org/details/${encodeURIComponent(doc.identifier)}` : '',
      snippet: doc.description || [doc.creator, doc.date, doc.mediatype].filter(Boolean).join(' '),
      sourceType: 'archive_item',
      metadata: {
        identifier: doc.identifier,
        mediatype: doc.mediatype,
        date: doc.date,
        collection: doc.collection
      },
      raw: doc
    }));
  }

  async fetchArchiveMetadata(query, options = {}) {
    const identifiers = options.identifiers?.length
      ? options.identifiers
      : this.extractArchiveIdentifiers(query);
    const candidates = [];
    for (const identifier of identifiers.slice(0, options.maxResults || this.defaultMaxResults)) {
      const data = await this.fetchJson(`https://archive.org/metadata/${encodeURIComponent(identifier)}`);
      const metadata = data?.metadata || {};
      candidates.push({
        title: metadata.title || identifier,
        url: `https://archive.org/details/${encodeURIComponent(identifier)}`,
        snippet: metadata.description || metadata.creator || '',
        sourceType: 'archive_metadata',
        metadata: {
          identifier,
          mediatype: metadata.mediatype,
          fileCount: Array.isArray(data?.files) ? data.files.length : 0,
          reviews: data?.reviews?.length || 0
        },
        raw: data
      });
    }
    return candidates;
  }

  async fetchArchiveReviews(query, options = {}) {
    const identifiers = options.identifiers?.length
      ? options.identifiers
      : this.extractArchiveIdentifiers(query);
    const candidates = [];
    for (const identifier of identifiers.slice(0, options.maxResults || this.defaultMaxResults)) {
      const data = await this.fetchJson(`https://archive.org/metadata/${encodeURIComponent(identifier)}`);
      const reviews = Array.isArray(data?.reviews) ? data.reviews : [];
      for (const review of reviews.slice(0, options.maxResults || this.defaultMaxResults)) {
        const reviewId = review.review_id || review.id || review.createdate || '';
        candidates.push({
          title: review.title || `Archive review for ${identifier}`,
          url: `https://archive.org/details/${encodeURIComponent(identifier)}#reviews`,
          snippet: review.body || review.reviewbody || review.title || '',
          sourceType: 'archive_review',
          metadata: {
            identifier,
            reviewId,
            reviewer: review.reviewer || review.reviewer_itemname || null,
            createdAt: review.createdate || null
          },
          raw: review
        });
      }
    }
    return candidates.slice(0, options.maxResults || this.defaultMaxResults);
  }

  async fetchArchiveFiles(query, options = {}) {
    const identifiers = options.identifiers?.length
      ? options.identifiers
      : this.extractArchiveIdentifiers(query);
    const candidates = [];
    const formatPattern = options.formats?.length
      ? new RegExp(options.formats.map(item => String(item).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i')
      : null;
    for (const identifier of identifiers.slice(0, options.maxResults || this.defaultMaxResults)) {
      const data = await this.fetchJson(`https://archive.org/metadata/${encodeURIComponent(identifier)}`);
      const files = Array.isArray(data?.files) ? data.files : [];
      for (const file of files) {
        if (formatPattern && !formatPattern.test(file.format || file.name || '')) continue;
        const name = file.name || '';
        if (!name) continue;
        candidates.push({
          title: name,
          url: `https://archive.org/download/${encodeURIComponent(identifier)}/${name.split('/').map(part => encodeURIComponent(part)).join('/')}`,
          snippet: [file.format, file.size ? `${file.size} bytes` : null].filter(Boolean).join(' '),
          sourceType: 'archive_file',
          metadata: {
            identifier,
            fileName: name,
            fileFormat: file.format || null,
            fileSize: file.size ? Number(file.size) : null,
            md5: file.md5 || null,
            sha1: file.sha1 || null,
            validationStrategy: 'metadata_only',
            hashSource: file.md5 ? 'md5' : (file.sha1 ? 'sha1' : null)
          },
          raw: file
        });
        if (candidates.length >= (options.maxResults || this.defaultMaxResults)) break;
      }
    }
    return candidates.slice(0, options.maxResults || this.defaultMaxResults);
  }

  async queryWaybackAvailability(query, options = {}) {
    const urls = this.extractUrls(query).slice(0, options.maxResults || this.defaultMaxResults);
    const candidates = [];
    for (const url of urls) {
      const data = await this.fetchJson(`https://archive.org/wayback/available?url=${encodeURIComponent(url)}`);
      const closest = data?.archived_snapshots?.closest;
      if (closest?.available && closest.url) {
        candidates.push({
          title: `Wayback snapshot for ${url}`,
          url: closest.url,
          snippet: `Archived ${closest.timestamp || ''} status ${closest.status || ''}`.trim(),
          sourceType: 'wayback_snapshot',
          metadata: {
            originalUrl: url,
            timestamp: closest.timestamp,
            status: closest.status
          },
          raw: closest
        });
      }
    }
    return candidates;
  }

  async queryWaybackCdx(query, options = {}) {
    const urls = this.extractUrls(query).slice(0, options.maxResults || this.defaultMaxResults);
    const candidates = [];
    for (const url of urls) {
      const params = new URLSearchParams();
      params.set('url', url);
      params.set('output', 'json');
      params.set('fl', 'timestamp,original,statuscode,mimetype,digest');
      params.set('filter', 'statuscode:200');
      params.set('limit', String(options.maxResults || this.defaultMaxResults));
      const rows = await this.fetchJson(`https://web.archive.org/cdx?${params.toString()}`);
      const records = this.normalizeCdxRows(rows);
      for (const record of records) {
        candidates.push({
          title: `Wayback CDX capture for ${record.original || url}`,
          url: record.original || url,
          snippet: `Wayback ${record.timestamp || ''} ${record.mimetype || ''}`.trim(),
          sourceType: 'wayback_cdx_capture',
          metadata: {
            originalUrl: record.original || url,
            archivedTimestamp: record.timestamp,
            captureStatus: record.statuscode,
            mimetype: record.mimetype,
            digest: record.digest
          },
          raw: record
        });
      }
    }
    return candidates.slice(0, options.maxResults || this.defaultMaxResults);
  }

  normalizeCdxRows(rows) {
    if (!Array.isArray(rows) || rows.length === 0) return [];
    if (!Array.isArray(rows[0])) return rows;
    const headers = rows[0];
    return rows.slice(1).map(row => Object.fromEntries(headers.map((header, index) => [header, row[index]])));
  }

  async queryCommonCrawl(query, options = {}) {
    const urls = this.extractUrls(query);
    if (urls.length === 0) return [];
    const index = await this.resolveCommonCrawlIndex();
    const candidates = [];
    for (const url of urls.slice(0, options.maxResults || this.defaultMaxResults)) {
      const params = new URLSearchParams();
      params.set('url', url);
      params.set('output', 'json');
      params.set('filter', 'status:200');
      params.set('limit', String(options.maxResults || this.defaultMaxResults));
      const captures = await this.fetchJson(`${index.cdxApi}?${params.toString()}`);
      for (const capture of Array.isArray(captures) ? captures : []) {
        candidates.push({
          title: `Common Crawl capture for ${capture.url || url}`,
          url: capture.url || url,
          snippet: `Common Crawl ${index.id} ${capture.timestamp || ''} ${capture.mime || ''}`.trim(),
          sourceType: 'commoncrawl_capture',
          metadata: {
            index: index.id,
            timestamp: capture.timestamp,
            status: capture.status,
            mime: capture.mime,
            digest: capture.digest
          },
          raw: capture
        });
      }
    }
    return candidates.slice(0, options.maxResults || this.defaultMaxResults);
  }

  async resolveCommonCrawlIndex() {
    if (this.config.commoncrawlIndexUrl) {
      return { id: this.config.commoncrawlIndexId || 'configured', cdxApi: this.config.commoncrawlIndexUrl };
    }
    const indexes = await this.fetchJson('https://index.commoncrawl.org/collinfo.json');
    const latest = Array.isArray(indexes) ? indexes[0] : null;
    if (!latest?.['cdx-api']) {
      throw new Error('Common Crawl index discovery returned no cdx-api');
    }
    return { id: latest.id, cdxApi: latest['cdx-api'] };
  }

  async searchWikidataEntities(query, options = {}) {
    const params = new URLSearchParams({
      action: 'wbsearchentities',
      search: query,
      language: 'en',
      format: 'json',
      limit: String(options.maxResults || this.defaultMaxResults)
    });
    const data = await this.fetchJson(`https://www.wikidata.org/w/api.php?${params.toString()}`);
    return (data?.search || []).map(item => ({
      title: item.label || item.id,
      url: item.concepturi || (item.id ? `https://www.wikidata.org/wiki/${encodeURIComponent(item.id)}` : ''),
      snippet: item.description || '',
      sourceType: 'knowledge_entity',
      metadata: { id: item.id, match: item.match },
      raw: item
    }));
  }

  async queryWikidataSparql(query, options = {}) {
    const sparql = options.sparql || query;
    const params = new URLSearchParams({ query: sparql, format: 'json' });
    const data = await this.fetchJson(`https://query.wikidata.org/sparql?${params.toString()}`, {
      accept: 'application/sparql-results+json'
    });
    const vars = data?.head?.vars || [];
    const rows = data?.results?.bindings || [];
    return rows.slice(0, options.maxResults || this.defaultMaxResults).map((row, index) => {
      const firstUri = vars.map(name => row[name]?.value).find(value => /^https?:\/\//.test(value || ''));
      return {
        title: `Wikidata SPARQL result ${index + 1}`,
        url: firstUri || 'https://query.wikidata.org/',
        snippet: vars.map(name => `${name}: ${row[name]?.value || ''}`).join(' | '),
        sourceType: 'knowledge_graph_result',
        metadata: { vars },
        raw: row
      };
    });
  }

  async searchOpenAlexWorks(query, options = {}) {
    const params = new URLSearchParams({
      search: query,
      'per-page': String(options.maxResults || this.defaultMaxResults)
    });
    if (this.config.openAlexEmail) {
      params.set('mailto', this.config.openAlexEmail);
    }
    const data = await this.fetchJson(`https://api.openalex.org/works?${params.toString()}`);
    return (data?.results || []).map(work => ({
      title: work.display_name || work.title || work.id,
      url: work.primary_location?.landing_page_url || work.doi || work.id,
      snippet: [work.publication_year, work.type, work.doi].filter(Boolean).join(' '),
      sourceType: 'scholarly_work',
      metadata: {
        id: work.id,
        doi: work.doi,
        publicationYear: work.publication_year,
        citedByCount: work.cited_by_count
      },
      raw: work
    }));
  }

  async searchCrossrefWorks(query, options = {}) {
    const params = new URLSearchParams({
      query,
      rows: String(options.maxResults || this.defaultMaxResults)
    });
    if (this.config.crossrefMailto) {
      params.set('mailto', this.config.crossrefMailto);
    }
    const data = await this.fetchJson(`https://api.crossref.org/works?${params.toString()}`);
    return (data?.message?.items || []).map(item => ({
      title: Array.isArray(item.title) ? item.title[0] : item.DOI,
      url: item.URL || (item.DOI ? `https://doi.org/${item.DOI}` : ''),
      snippet: [item.publisher, item.type, item.issued?.['date-parts']?.[0]?.[0]].filter(Boolean).join(' '),
      sourceType: 'scholarly_metadata',
      metadata: { doi: item.DOI, type: item.type, publisher: item.publisher },
      raw: item
    }));
  }

  async searchSemanticScholarPapers(query, options = {}) {
    const params = new URLSearchParams({
      query,
      limit: String(options.maxResults || this.defaultMaxResults),
      fields: options.fields || 'title,url,abstract,year,venue,externalIds,citationCount'
    });
    const data = await this.fetchJson(`https://api.semanticscholar.org/graph/v1/paper/search?${params.toString()}`, {
      apiKey: this.config.semanticScholarApiKey
    });
    return (data?.data || []).map(item => ({
      title: item.title || item.paperId,
      url: item.url || (item.paperId ? `https://www.semanticscholar.org/paper/${encodeURIComponent(item.paperId)}` : ''),
      snippet: item.abstract || [item.year, item.venue].filter(Boolean).join(' '),
      sourceType: 'scholarly_work',
      metadata: {
        corpusId: item.corpusId,
        paperId: item.paperId,
        doi: item.externalIds?.DOI || null,
        arxivId: item.externalIds?.ArXiv || null,
        year: item.year,
        citationCount: item.citationCount
      },
      raw: item
    }));
  }

  async searchArxiv(query, options = {}) {
    const params = new URLSearchParams({
      search_query: options.searchQuery || `all:${query}`,
      start: '0',
      max_results: String(options.maxResults || this.defaultMaxResults),
      sortBy: options.sortBy || 'relevance'
    });
    const text = await this.fetchText(`https://export.arxiv.org/api/query?${params.toString()}`, {
      accept: 'application/atom+xml,application/xml,text/xml,*/*'
    });
    const entries = [...text.matchAll(/<entry\b[\s\S]*?<\/entry>/gi)].map(match => match[0]);
    return entries.slice(0, options.maxResults || this.defaultMaxResults).map((entry, index) => {
      const id = this.extractXmlValue(entry, 'id');
      const title = this.stripXml(this.extractXmlValue(entry, 'title')) || `arXiv result ${index + 1}`;
      return {
        title,
        url: id,
        snippet: this.stripXml(this.extractXmlValue(entry, 'summary')).slice(0, 500),
        sourceType: 'preprint',
        metadata: {
          arxivId: id ? id.split('/abs/')[1] || id : null,
          publishedAt: this.extractXmlValue(entry, 'published') || null
        },
        raw: { id, title }
      };
    });
  }

  async searchPubMed(query, options = {}) {
    const baseParams = {
      db: 'pubmed',
      retmode: 'json',
      retmax: String(options.maxResults || this.defaultMaxResults),
      term: query,
      tool: this.config.ncbiTool || 'home23-cosmo23'
    };
    if (this.config.ncbiEmail) baseParams.email = this.config.ncbiEmail;
    if (this.config.ncbiApiKey) baseParams.api_key = this.config.ncbiApiKey;
    const searchData = await this.fetchJson(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?${new URLSearchParams(baseParams).toString()}`);
    const ids = searchData?.esearchresult?.idlist || [];
    if (ids.length === 0) return [];
    const summaryParams = {
      db: 'pubmed',
      retmode: 'json',
      id: ids.join(','),
      tool: this.config.ncbiTool || 'home23-cosmo23'
    };
    if (this.config.ncbiEmail) summaryParams.email = this.config.ncbiEmail;
    if (this.config.ncbiApiKey) summaryParams.api_key = this.config.ncbiApiKey;
    const summaryData = await this.fetchJson(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?${new URLSearchParams(summaryParams).toString()}`);
    return (summaryData?.result?.uids || []).map(id => {
      const item = summaryData.result[id] || {};
      return {
        title: item.title || `PubMed ${id}`,
        url: `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
        snippet: [item.source, item.pubdate].filter(Boolean).join(' '),
        sourceType: 'biomedical_article',
        metadata: {
          pmid: id,
          source: item.source || null,
          pubdate: item.pubdate || null
        },
        raw: item
      };
    });
  }

  async fetchRssFeed(query, options = {}) {
    const feedUrls = this.extractUrls(query).filter(url => /\.(rss|xml|atom)(\?|$)/i.test(url));
    const candidates = [];
    for (const url of feedUrls.slice(0, options.maxResults || this.defaultMaxResults)) {
      const text = await this.fetchText(url, { accept: 'application/rss+xml,application/atom+xml,application/xml,text/xml,*/*' });
      const items = this.parseFeedItems(text, options.maxResults || this.defaultMaxResults);
      candidates.push(...items.map(item => ({
        ...item,
        sourceType: 'feed_item',
        metadata: { feedUrl: url }
      })));
    }
    return candidates.slice(0, options.maxResults || this.defaultMaxResults);
  }

  async fetchSitemap(query, options = {}) {
    const urls = this.extractUrls(query);
    const sitemapUrls = urls.length > 0
      ? urls.map(url => this.toSitemapUrl(url))
      : [];
    const candidates = [];
    for (const sitemapUrl of sitemapUrls.slice(0, options.maxResults || this.defaultMaxResults)) {
      const text = await this.fetchText(sitemapUrl, { accept: 'application/xml,text/xml,*/*' });
      const locs = [...text.matchAll(/<loc>([^<]+)<\/loc>/gi)]
        .map(match => match[1].trim())
        .slice(0, options.maxResults || this.defaultMaxResults);
      candidates.push(...locs.map((loc, index) => ({
        title: `Sitemap URL ${index + 1}`,
        url: loc,
        snippet: `Discovered in ${sitemapUrl}`,
        sourceType: 'sitemap_url',
        metadata: { sitemapUrl }
      })));
    }
    return candidates.slice(0, options.maxResults || this.defaultMaxResults);
  }

  parseFeedItems(text, maxResults) {
    const itemBlocks = [...text.matchAll(/<item\b[\s\S]*?<\/item>/gi)].map(match => match[0]);
    const entryBlocks = itemBlocks.length > 0
      ? itemBlocks
      : [...text.matchAll(/<entry\b[\s\S]*?<\/entry>/gi)].map(match => match[0]);
    return entryBlocks.slice(0, maxResults).map((block, index) => {
      const title = this.extractXmlValue(block, 'title') || `Feed item ${index + 1}`;
      const link = this.extractXmlValue(block, 'link') ||
        (block.match(/<link[^>]+href=["']([^"']+)["']/i)?.[1] || '');
      const description = this.extractXmlValue(block, 'description') ||
        this.extractXmlValue(block, 'summary') ||
        this.extractXmlValue(block, 'content') ||
        '';
      return {
        title: this.stripXml(title),
        url: link,
        snippet: this.stripXml(description).slice(0, 500),
        metadata: { published: this.extractXmlValue(block, 'pubDate') || this.extractXmlValue(block, 'updated') }
      };
    });
  }

  extractXmlValue(text, tag) {
    const match = text.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
    return match ? match[1].trim() : '';
  }

  stripXml(text = '') {
    return text.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  }

  toSitemapUrl(url) {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}/sitemap.xml`;
  }

  extractArchiveIdentifiers(text = '') {
    const ids = [];
    for (const match of text.matchAll(/archive\.org\/details\/([^/?#\s]+)/gi)) {
      ids.push(decodeURIComponent(match[1]));
    }
    return [...new Set(ids)];
  }

  extractUrls(text = '') {
    return [...new Set((text.match(/https?:\/\/[^\s<>"'`)]+/g) || [])
      .map(url => url.trim().replace(/[.,;:!?]+$/g, '')))];
  }

  async fetchJson(url, options = {}) {
    const response = await this.fetchUrl(url, options);
    return await response.json();
  }

  async fetchText(url, options = {}) {
    const response = await this.fetchUrl(url, options);
    return await response.text();
  }

  async fetchUrl(url, options = {}) {
    if (typeof this.fetchImpl !== 'function') {
      throw new Error('No fetch implementation available for source provider');
    }
    const response = await this.fetchImpl(url, {
      headers: {
        'Accept': options.accept || 'application/json,text/plain,*/*',
        'User-Agent': this.config.userAgent || 'Home23-COSMO23 SourceProviderRegistry',
        ...(options.apiKey ? { 'x-api-key': options.apiKey } : {})
      },
      signal: AbortSignal.timeout(options.timeoutMs || this.config.timeoutMs || 10000)
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return response;
  }
}

module.exports = { SourceProviderRegistry };
