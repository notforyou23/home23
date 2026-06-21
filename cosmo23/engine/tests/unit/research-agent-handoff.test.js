const { expect } = require('chai');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-openai-key';

const { ResearchAgent } = require('../../src/agents/research-agent');

describe('ResearchAgent handoff generation', () => {
  const logger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {}
  };

  it('emits a structured handoff with artifact refs, findings, and follow-up goals', () => {
    const agent = new ResearchAgent(
      {
        goalId: 'goal-1',
        description: 'Research payer network expansion',
        successCriteria: []
      },
      { ideFirst: { enabled: true } },
      logger
    );

    agent.lastSynthesis = {
      summary: 'Summary of findings',
      findings: ['Finding 1', 'Finding 2', 'Finding 3']
    };
    agent.exportedFiles = [
      {
        filename: 'research_findings.json',
        path: '/tmp/research_findings.json',
        relativePath: '@outputs/research_findings.json',
        size: 128
      },
      {
        filename: 'sources.json',
        path: '/tmp/sources.json',
        relativePath: '@outputs/sources.json',
        size: 96
      }
    ];
    agent.followUpDirections = ['Validate payer contract timelines'];
    agent.sourcesFound = ['https://example.com/source-a', 'https://example.com/source-b'];

    const handoff = agent.generateHandoffSpec();

    expect(handoff).to.exist;
    expect(handoff.type).to.equal('HANDOFF');
    expect(handoff.toAgentType).to.equal('ide');
    expect(handoff.artifactRefs).to.have.length(2);
    expect(handoff.artifactRefs[0].relativePath).to.equal('@outputs/research_findings.json');
    expect(handoff.sourceRefs.map(item => item.label)).to.include('sources.json');
    expect(handoff.topFindings).to.deep.equal(['Finding 1', 'Finding 2', 'Finding 3']);
    expect(handoff.followUpGoals).to.deep.equal(['Validate payer contract timelines']);
    expect(handoff.sourceUrls).to.deep.equal(['https://example.com/source-a', 'https://example.com/source-b']);
  });

  it('fails closed when a source-required mission has no successful web searches', async () => {
    const agent = new ResearchAgent(
      {
        goalId: 'goal-source-required',
        description: 'Recover fan anecdotes from forums. For each result, record source_url, source_type, author, and anecdote_text.',
        successCriteria: ['Every finding must include a source_url']
      },
      {
        models: { enableWebSearch: true },
        providers: { 'ollama-cloud': { enabled: true } }
      },
      logger
    );

    agent.gatherPreFlightContext = async () => ({});
    agent.memory = { query: async () => [] };
    agent.exploreMemoryConnections = async () => [];
    agent.getHotTopics = async () => [];
    agent.checkExistingKnowledge = async () => ({ hasKnowledge: false });
    agent.generateResearchQueries = async () => [
      'site:archive.org "Legion of Mary" "Boarding House" 1975',
      'site:reddit.com/r/gratefuldead "Legion of Mary" 1975'
    ];
    agent.performWebSearch = async (query) => {
      throw new Error(`400 invalid_request_error for ${query}`);
    };
    agent.generateKnowledgeBasedResearch = async () => {
      throw new Error('knowledge fallback should not be used for source-required missions');
    };
    agent.reportProgress = async () => {};

    const result = await agent.execute();

    expect(result.success).to.equal(false);
    expect(result.status).to.equal('blocked_search_failed');
    expect(result.queriesAttempted).to.equal(2);
    expect(result.searchFailures).to.have.length(2);
  });

  it('treats explicit researchContract metadata as source-required', () => {
    const agent = new ResearchAgent(
      {
        goalId: 'goal-contract-required',
        description: 'Collect field notes for the topic.',
        successCriteria: [],
        metadata: {
          researchContract: {
            required: true,
            mode: 'web_research',
            minSuccessfulSources: 1,
            requiredEvidence: ['successful_source_contact'],
            reasonCodes: ['operator_required_sources']
          }
        }
      },
      {
        models: { enableWebSearch: true }
      },
      logger
    );

    expect(agent.requiresVerifiedSources()).to.equal(true);
  });

  it('executes explicit web_search queries from the mission instead of regenerating fewer broad queries', async () => {
    const agent = new ResearchAgent(
      {
        goalId: 'goal-explicit-searches',
        description: [
          "Execute these searches: (1) web_search for 'Legion of Mary December 1974 Keystone Berkeley fan recollections site:reddit.com OR site:archive.org'",
          "(2) web_search for 'Jerry Merl Saunders Boarding House July 1975 \"I'll Take a Melody\" anecdote OR review'",
          "(3) web_search for 'Old In the Way Boarding House September 1973 banjo Garcia fan memory site:reddit.com OR site:archive.org'",
          "(4) web_search for 'Legion of Mary personnel change Vitt Tutt drummer 1974 1975 fan discussion'",
          "(5) web_search for 'Reconstruction 1979 Jerry Garcia jazz fusion show review fan forum'"
        ].join('; '),
        successCriteria: ['Execute all five searches']
      },
      {
        models: { enableWebSearch: true }
      },
      logger
    );

    agent.gpt5.generateFast = async () => {
      throw new Error('LLM query generation should not run for explicit web_search missions');
    };

    const queries = await agent.generateResearchQueries();

    expect(queries).to.have.length(5);
    expect(queries[0]).to.equal('Legion of Mary December 1974 Keystone Berkeley fan recollections site:reddit.com OR site:archive.org');
    expect(queries[4]).to.equal('Reconstruction 1979 Jerry Garcia jazz fusion show review fan forum');
  });

  it('repairs low-quality local search results before counting a source-required search as successful', async () => {
    const agent = new ResearchAgent(
      {
        goalId: 'goal-search-repair',
        description: 'Find fan anecdotes with source_url fields',
        successCriteria: ['Every finding must include a source_url']
      },
      {
        models: { enableWebSearch: true },
        providers: { 'ollama-cloud': { enabled: true } }
      },
      logger
    );

    const calls = [];
    agent.searchBackend = {
      search: async (query) => {
        calls.push(query);
        if (calls.length === 1) {
          return {
            success: true,
            query,
            source: 'duckduckgo',
            resultCount: 1,
            results: [{
              title: 'Internet Archive: Digital Library',
              url: 'https://archive.org/',
              snippet: 'No description available'
            }]
          };
        }
        return {
          success: true,
          query,
          source: 'duckduckgo',
          resultCount: 1,
          results: [{
            title: 'Legion of Mary fan recollection for 1974-12-06 Keystone, Berkeley CA',
            url: 'https://jerrygarcia.com/show/1974-12-06-keystone-berkeley-ca/',
            snippet: 'Legion of Mary December 1974 Keystone Berkeley fan recollection show details'
          }]
        };
      }
    };
    agent.gpt5 = {
      generate: async () => ({ content: 'Relevant repaired search result summary.' })
    };
    agent.sourceValidator = {
      validate: async (urls) => urls.map(url => ({
        url,
        ok: true,
        status: 200,
        contentType: 'text/html',
        bytes: 1000
      }))
    };

    const result = await agent.performLocalWebSearch(
      'Legion of Mary December 1974 Keystone Berkeley fan recollections site:reddit.com OR site:archive.org'
    );

    expect(result).to.equal('Relevant repaired search result summary.');
    expect(calls).to.have.length.greaterThan(1);
    expect(calls[1]).to.equal('Legion of Mary December 1974 Keystone Berkeley fan recollections');
    expect(agent.sourcesFound).to.deep.equal(['https://jerrygarcia.com/show/1974-12-06-keystone-berkeley-ca/']);
    expect(agent.searchEvidence[0].quality.acceptable).to.equal(true);
  });

  it('does not count source-required search URLs that cannot be fetched', async () => {
    const agent = new ResearchAgent(
      {
        goalId: 'goal-source-validation',
        description: 'Find fan anecdotes with source_url fields',
        successCriteria: ['Every finding must include a source_url']
      },
      {
        models: { enableWebSearch: true },
        providers: { 'ollama-cloud': { enabled: true } }
      },
      logger
    );

    agent.searchBackend = {
      search: async (query) => ({
        success: true,
        query,
        source: 'searxng',
        resultCount: 1,
        results: [{
          title: 'Legion of Mary fan recollection',
          url: 'https://example.invalid/source',
          snippet: 'Legion of Mary December 1974 Keystone Berkeley recollection'
        }]
      })
    };
    agent.gpt5 = {
      generate: async () => ({ content: 'This should not become successful.' })
    };
    agent.sourceValidator = {
      validate: async (urls) => urls.map(url => ({
        url,
        ok: false,
        status: 0,
        error: 'fetch failed'
      }))
    };

    try {
      await agent.performLocalWebSearch('Legion of Mary December 1974 Keystone Berkeley fan recollections');
      throw new Error('Expected source validation failure');
    } catch (error) {
      expect(error.code).to.equal('SOURCE_VALIDATION_FAILED');
      expect(agent.sourcesFound).to.deep.equal([]);
    }
  });

  it('repairs a source-required search when the first relevant URLs fail validation', async () => {
    const agent = new ResearchAgent(
      {
        goalId: 'goal-validation-repair',
        description: 'Find fan anecdotes with source_url fields',
        successCriteria: ['Every finding must include a source_url']
      },
      {
        models: { enableWebSearch: true },
        providers: { 'ollama-cloud': { enabled: true } }
      },
      logger
    );

    const calls = [];
    agent.searchBackend = {
      search: async (query) => {
        calls.push(query);
        if (calls.length === 1) {
          return {
            success: true,
            query,
            source: 'searxng',
            resultCount: 1,
            results: [{
              title: 'Legion of Mary fan recollection',
              url: 'https://reddit.example/blocked',
              snippet: 'Legion of Mary December 1974 Keystone Berkeley fan recollection'
            }]
          };
        }
        return {
          success: true,
          query,
          source: 'searxng',
          resultCount: 1,
          results: [{
            title: 'Legion of Mary fan recollection mirror',
            url: 'https://archive.example/valid',
            snippet: 'Legion of Mary December 1974 Keystone Berkeley fan recollection'
          }]
        };
      }
    };
    agent.gpt5 = {
      generate: async () => ({ content: 'Repaired source summary.' })
    };
    agent.sourceValidator = {
      validate: async (urls) => urls.map(url => ({
        url,
        ok: url.includes('valid'),
        status: url.includes('valid') ? 200 : 200,
        blockedReason: url.includes('valid') ? null : 'verification_interstitial'
      }))
    };

    const result = await agent.performLocalWebSearch(
      'Legion of Mary December 1974 Keystone Berkeley fan recollections site:reddit.com OR site:archive.org'
    );

    expect(result).to.equal('Repaired source summary.');
    expect(calls).to.have.length.greaterThan(1);
    expect(agent.sourcesFound).to.deep.equal(['https://archive.example/valid']);
    expect(agent.searchEvidence[0].executedQuery).to.equal('Legion of Mary December 1974 Keystone Berkeley fan recollections');
    expect(agent.searchEvidence[0].repairedFrom).to.include('site:reddit.com');
  });

  it('writes mission-requested raw search evidence files, not only generic research summaries', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cosmo23-research-export-'));
    const outputsRoot = path.join(tmp, 'outputs');
    const agent = new ResearchAgent(
      {
        goalId: 'goal-raw-output',
        description: 'Save all raw findings to @outputs/raw-anecdotes/web-search-results.json. Also save a human-readable markdown summary to @outputs/raw-anecdotes/web-search-findings.md.',
        expectedOutput: '@outputs/raw-anecdotes/web-search-results.json and @outputs/raw-anecdotes/web-search-findings.md',
        successCriteria: []
      },
      {
        logsDir: tmp,
        runName: 'unit-test-run'
      },
      logger
    );

    agent.pathResolver = { getOutputsRoot: () => outputsRoot };
    agent.addFinding = async () => ({ id: 'node-1' });
    agent.searchQueries = ['Legion of Mary December 1974 Keystone Berkeley fan recollections'];
    agent.sourcesFound = ['https://jerrygarcia.com/show/1974-12-06-keystone-berkeley-ca/'];
    agent.searchEvidence = [{
      query: agent.searchQueries[0],
      backend: 'duckduckgo',
      resultCount: 1,
      results: [{
        title: '1974-12-06 Keystone, Berkeley CA - Jerry Garcia',
        url: 'https://jerrygarcia.com/show/1974-12-06-keystone-berkeley-ca/',
        snippet: 'Legion of Mary December 1974 Keystone Berkeley show details'
      }],
      quality: { acceptable: true, relevantResults: 1 }
    }];

    await agent.exportResearchCorpus(
      {
        summary: 'Summary',
        findings: ['Finding'],
        successAssessment: 'Complete'
      },
      [{ query: agent.searchQueries[0], result: 'summary' }]
    );

    const rawJson = path.join(outputsRoot, 'raw-anecdotes', 'web-search-results.json');
    const rawMd = path.join(outputsRoot, 'raw-anecdotes', 'web-search-findings.md');
    const rawJsonData = JSON.parse(await fs.readFile(rawJson, 'utf8'));
    const rawMdText = await fs.readFile(rawMd, 'utf8');

    expect(rawJsonData.searchEvidence).to.have.length(1);
    expect(rawJsonData.searchEvidence[0].results[0].url).to.equal(agent.sourcesFound[0]);
    expect(rawMdText).to.include('Legion of Mary December 1974 Keystone Berkeley fan recollections');
    expect(agent.exportedFiles.map(file => file.relativePath)).to.include('outputs/raw-anecdotes/web-search-results.json');
    expect(agent.exportedFiles.map(file => file.relativePath)).to.include('outputs/raw-anecdotes/web-search-findings.md');
  });

  it('writes source backbone proof-gate receipts for downstream confirmation', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cosmo23-source-backbone-'));
    const outputsRoot = path.join(tmp, 'outputs');
    const agent = new ResearchAgent(
      {
        goalId: 'goal-proof-gates',
        description: 'Find fan anecdotes with source_url fields',
        successCriteria: ['Every finding must include a source_url']
      },
      {
        logsDir: tmp,
        runName: 'unit-test-run'
      },
      logger
    );

    agent.pathResolver = { getOutputsRoot: () => outputsRoot };
    agent.searchQueries = ['Legion of Mary December 1974 Keystone Berkeley fan recollections'];
    agent.sourcesFound = ['https://jerrygarcia.com/show/1974-12-06-keystone-berkeley-ca/'];
    agent.searchEvidence = [{
      timestamp: '2026-06-21T00:00:00.000Z',
      query: agent.searchQueries[0],
      executedQuery: agent.searchQueries[0],
      backend: 'searxng',
      resultCount: 1,
      urls: agent.sourcesFound,
      quality: { acceptable: true, reason: 'relevant_results_found', relevantResults: 1 },
      sourceValidation: [{
        url: agent.sourcesFound[0],
        ok: true,
        status: 200,
        contentType: 'text/html',
        bytes: 1000,
        contentHash: 'abc123'
      }],
      results: [{
        position: 1,
        title: '1974-12-06 Keystone, Berkeley CA - Jerry Garcia',
        url: agent.sourcesFound[0],
        snippet: 'Legion of Mary show details',
        engine: 'searxng'
      }]
    }];

    await agent.exportResearchCorpus(
      {
        summary: 'Summary',
        findings: ['Finding'],
        successAssessment: 'Complete'
      },
      [{ query: agent.searchQueries[0], result: 'summary' }]
    );

    const proofDir = path.join(outputsRoot, 'research', agent.agentId);
    const attemptsPath = path.join(proofDir, 'source_attempts.jsonl');
    const crossingPath = path.join(proofDir, 'source_crossing.jsonl');
    const statusPath = path.join(proofDir, 'source_backbone_status.json');
    const attempts = (await fs.readFile(attemptsPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const crossings = (await fs.readFile(crossingPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const status = JSON.parse(await fs.readFile(statusPath, 'utf8'));

    expect(attempts[0]).to.include({
      route: 'searxng',
      status: 'accepted',
      result_count: 1
    });
    expect(crossings[0]).to.include({
      url: agent.sourcesFound[0],
      route: 'searxng',
      status: 200,
      bytes: 1000,
      content_hash: 'abc123'
    });
    expect(status.can_continue).to.equal(true);
    expect(status.productive_sources).to.equal(1);
    expect(status.next_allowed_action).to.equal('continue');
    expect(agent.exportedFiles.map(file => file.relativePath)).to.include(`outputs/research/${agent.agentId}/source_backbone_status.json`);
  });

  it('supplements provider-native web search with local search for source-required missions', async () => {
    const agent = new ResearchAgent(
      {
        goalId: 'goal-native-plus-local',
        description: 'Find fan anecdotes with source_url fields using all available search avenues.',
        successCriteria: ['Every finding must include a source_url']
      },
      {
        models: { enableWebSearch: true },
        search: { supplementProviderNative: true }
      },
      logger
    );

    agent.gpt5 = {
      generateWithWebSearch: async () => ({
        content: 'Native model search found one source.',
        webSearchSources: [{
          title: 'Native source',
          url: 'https://native.example/source'
        }],
        citations: []
      }),
      generate: async () => ({ content: 'Local metasearch found another source.' })
    };
    agent.searchBackend = {
      search: async (query) => ({
        success: true,
        query,
        source: 'searxng',
        resultCount: 1,
        results: [{
          title: 'Legion of Mary fan recollection local source',
          url: 'https://local.example/source',
          snippet: 'Legion of Mary fan recollection anecdote source_url'
        }]
      })
    };
    agent.sourceValidator = {
      validate: async (urls) => urls.map(url => ({
        url,
        ok: true,
        status: 200,
        contentType: 'text/html',
        bytes: 1200
      }))
    };

    const result = await agent.performWebSearch('Legion of Mary fan recollection source_url');

    expect(result).to.include('Native model search found one source.');
    expect(result).to.include('Local metasearch found another source.');
    expect(agent.sourcesFound).to.deep.equal([
      'https://native.example/source',
      'https://local.example/source'
    ]);
    expect(agent.searchEvidence.map(entry => entry.backend)).to.deep.equal([
      'provider-native',
      'searxng'
    ]);
    expect(agent.searchEvidence[0].sourceValidation[0].ok).to.equal(true);
  });

  it('does not accept failed provider-native source validation when local search can rescue the query', async () => {
    const agent = new ResearchAgent(
      {
        goalId: 'goal-native-validation-rescue',
        description: 'Find fan anecdotes with source_url fields using all available search avenues.',
        successCriteria: ['Every finding must include a source_url']
      },
      {
        models: { enableWebSearch: true },
        search: { supplementProviderNative: true }
      },
      logger
    );

    agent.gpt5 = {
      generateWithWebSearch: async () => ({
        content: 'Native model search returned a blocked result.',
        webSearchSources: [{
          title: 'Blocked source',
          url: 'https://blocked.example/source'
        }],
        citations: []
      }),
      generate: async () => ({ content: 'Local metasearch rescued the source set.' })
    };
    agent.searchBackend = {
      search: async (query) => ({
        success: true,
        query,
        source: 'brave',
        resultCount: 1,
        results: [{
          title: 'Legion of Mary fan recollection mirror',
          url: 'https://valid.example/source',
          snippet: 'Legion of Mary fan recollection anecdote source_url'
        }]
      })
    };
    agent.sourceValidator = {
      validate: async (urls) => urls.map(url => ({
        url,
        ok: !url.includes('blocked'),
        status: url.includes('blocked') ? 403 : 200,
        blockedReason: url.includes('blocked') ? 'captcha_or_javascript_gate' : null,
        contentType: 'text/html',
        bytes: url.includes('blocked') ? 300 : 1200
      }))
    };

    const result = await agent.performWebSearch('Legion of Mary fan recollection source_url');

    expect(result).to.include('Local metasearch rescued the source set.');
    expect(agent.sourcesFound).to.deep.equal(['https://valid.example/source']);
    expect(agent.searchEvidence[0].backend).to.equal('provider-native');
    expect(agent.searchEvidence[0].sourceValidation[0].ok).to.equal(false);
    expect(agent.searchEvidence[1].backend).to.equal('brave');
    expect(agent.searchEvidence[1].sourceValidation[0].ok).to.equal(true);
  });

  it('validates explicit source URLs directly even when search providers fail', async () => {
    const agent = new ResearchAgent(
      {
        goalId: 'goal-direct-source',
        description: 'Fetch the provided source_url and cite it.',
        successCriteria: ['Every finding must include a source_url']
      },
      {
        models: { enableWebSearch: true },
        search: { supplementProviderNative: true }
      },
      logger
    );

    agent.gpt5 = {
      generateWithWebSearch: async () => {
        const error = new Error('native web search unavailable');
        error.code = 'NATIVE_UNAVAILABLE';
        throw error;
      },
      generate: async () => ({ content: 'not used' })
    };
    agent.searchBackend = {
      search: async (query) => ({
        success: false,
        query,
        source: 'searxng',
        resultCount: 0,
        results: [],
        error: 'search unavailable'
      })
    };
    agent.sourceValidator = {
      validate: async (urls) => urls.map(url => ({
        url,
        ok: true,
        status: 200,
        contentType: 'text/html',
        bytes: 2048,
        sample: 'Direct source page content sample'
      }))
    };

    const result = await agent.performWebSearch('Review this source_url https://archive.example/details/show-1975-07-05');

    expect(result).to.include('Direct source validation');
    expect(agent.sourcesFound).to.deep.equal(['https://archive.example/details/show-1975-07-05']);
    expect(agent.searchEvidence[0].backend).to.equal('direct-source-fetch');
    expect(agent.searchEvidence[0].sourceValidation[0].ok).to.equal(true);
    expect(agent.searchEvidence.map(entry => entry.backend)).to.include('provider-native');
    expect(agent.searchEvidence.map(entry => entry.backend)).to.include('local-search');
  });

  it('uses typed source providers as acquisition avenues for source-required missions', async () => {
    const agent = new ResearchAgent(
      {
        goalId: 'goal-source-provider-registry',
        description: 'Recover fan anecdotes from Archive and web corpora with source_url fields.',
        successCriteria: ['Every finding must include a source_url']
      },
      {
        models: { enableWebSearch: true },
        search: { supplementProviderNative: false },
        sourceProviders: {
          enabled: true,
          providers: ['archive.advancedsearch']
        }
      },
      logger
    );

    agent.gpt5 = {
      generateWithWebSearch: async () => ({
        content: 'Native model did not find source URLs.',
        webSearchSources: [],
        citations: []
      })
    };
    agent.sourceProviderRegistry = {
      acquire: async (query, options) => ({
        success: true,
        query,
        providerIds: options.providers,
        attempts: [{
          timestamp: '2026-06-21T00:00:00.000Z',
          route: 'archive.advancedsearch',
          status: 'accepted',
          result_count: 1,
          url_count: 1
        }],
        candidates: [{
          provider: 'archive.advancedsearch',
          sourceType: 'archive_item',
          title: 'Legion of Mary at Keystone',
          url: 'https://archive.org/details/legion-of-mary-keystone',
          snippet: 'Archive item for Legion of Mary Keystone',
          metadata: { identifier: 'legion-of-mary-keystone' }
        }]
      })
    };
    agent.sourceValidator = {
      validate: async (urls) => urls.map(url => ({
        url,
        ok: true,
        status: 200,
        contentType: 'text/html',
        bytes: 4096,
        contentHash: 'hash123'
      }))
    };

    const result = await agent.performWebSearch('Legion of Mary Keystone archive.org source_url');

    expect(result).to.include('Typed source providers found');
    expect(agent.sourcesFound).to.deep.equal(['https://archive.org/details/legion-of-mary-keystone']);
    expect(agent.searchEvidence.map(entry => entry.backend)).to.include('archive.advancedsearch');
    const providerEvidence = agent.searchEvidence.find(entry => entry.backend === 'archive.advancedsearch');
    expect(providerEvidence.quality.acceptable).to.equal(true);
    expect(providerEvidence.sourceValidation[0].contentHash).to.equal('hash123');
  });

  it('uses typed source providers in local-search mode instead of returning before the registry', async () => {
    const agent = new ResearchAgent(
      {
        goalId: 'goal-local-source-provider-registry',
        description: 'Recover fan anecdotes from Archive with source_url fields.',
        successCriteria: ['Every finding must include a source_url']
      },
      {
        models: { enableWebSearch: true },
        providers: { 'ollama-cloud': { enabled: true } },
        sourceProviders: {
          enabled: true,
          providers: ['archive.advancedsearch']
        }
      },
      logger
    );

    agent.useLocalSearch = true;
    agent.sourceProviderRegistry = {
      acquire: async () => ({
        success: true,
        attempts: [{
          timestamp: '2026-06-21T00:00:00.000Z',
          route: 'archive.advancedsearch',
          status: 'accepted',
          result_count: 1,
          url_count: 1
        }],
        candidates: [{
          provider: 'archive.advancedsearch',
          sourceType: 'archive_item',
          title: 'Legion of Mary at Keystone',
          url: 'https://archive.org/details/legion-of-mary-keystone',
          snippet: 'Archive item for Legion of Mary Keystone'
        }]
      })
    };
    agent.sourceValidator = {
      validate: async (urls) => urls.map(url => ({
        url,
        ok: true,
        status: 200,
        contentType: 'text/html',
        bytes: 4096,
        contentHash: 'hash123'
      }))
    };
    agent.performLocalWebSearch = async () => {
      const error = new Error('local search unavailable');
      error.code = 'NO_SEARCH_RESULTS';
      throw error;
    };

    const result = await agent.performWebSearch('Legion of Mary Keystone archive.org source_url');

    expect(result).to.include('Typed source providers found');
    expect(agent.sourcesFound).to.deep.equal(['https://archive.org/details/legion-of-mary-keystone']);
    expect(agent.searchEvidence.map(entry => entry.backend)).to.include('archive.advancedsearch');
    expect(agent.searchEvidence.map(entry => entry.backend)).to.include('local-search');
  });

  it('accepts metadata-only provider candidates without downloading large files', async () => {
    const agent = new ResearchAgent(
      {
        goalId: 'goal-metadata-only-provider',
        description: 'Collect Archive file candidates with source_url fields.',
        successCriteria: ['Every finding must include a source_url']
      },
      {
        models: { enableWebSearch: true },
        search: { supplementProviderNative: false },
        sourceProviders: {
          enabled: true,
          providers: ['archive.files']
        }
      },
      logger
    );

    agent.gpt5 = {
      generateWithWebSearch: async () => ({
        content: 'Native model did not find source URLs.',
        webSearchSources: [],
        citations: []
      })
    };
    agent.sourceProviderRegistry = {
      acquire: async () => ({
        success: true,
        attempts: [{
          timestamp: '2026-06-21T00:00:00.000Z',
          route: 'archive.files',
          status: 'accepted',
          result_count: 1,
          url_count: 1
        }],
        candidates: [{
          provider: 'archive.files',
          sourceType: 'archive_file',
          title: 'show.flac',
          url: 'https://archive.org/download/show/show.flac',
          snippet: 'FLAC file candidate',
          metadata: {
            identifier: 'show',
            fileName: 'show.flac',
            fileSize: 123456789,
            md5: 'md5hash',
            validationStrategy: 'metadata_only',
            hashSource: 'md5'
          }
        }]
      })
    };
    agent.sourceValidator = {
      validate: async () => {
        throw new Error('Metadata-only file candidate should not be fetched');
      }
    };

    const result = await agent.performWebSearch('archive.org/details/show archive files source_url');

    expect(result).to.include('Typed source providers found');
    expect(agent.sourcesFound).to.deep.equal(['https://archive.org/download/show/show.flac']);
    const evidence = agent.searchEvidence.find(entry => entry.backend === 'archive.files');
    expect(evidence.sourceValidation[0]).to.include({
      url: 'https://archive.org/download/show/show.flac',
      ok: true,
      status: 'metadata_only',
      bytes: 123456789,
      contentHash: 'md5hash'
    });
    expect(evidence.sourceValidation[0].hashSource).to.equal('md5');
  });

  it('honors researchContract source provider hints when query text has no provider cues', async () => {
    const agent = new ResearchAgent(
      {
        goalId: 'goal-contract-provider-hints',
        description: 'Use the supplied research contract to acquire sources.',
        successCriteria: ['Every finding must include source evidence'],
        metadata: {
          researchContract: {
            required: true,
            mode: 'source_acquisition',
            sourceProviderHints: ['crossref.works']
          }
        }
      },
      {
        models: { enableWebSearch: true },
        sourceProviders: { enabled: true }
      },
      logger
    );

    agent.useLocalSearch = true;
    let providersSeen = [];
    agent.sourceProviderRegistry = {
      listProviders: () => ['crossref.works'],
      selectProviders: () => [],
      acquire: async (query, options) => {
        providersSeen = options.providers;
        return {
          success: true,
          query,
          providerIds: options.providers,
          attempts: [{
            timestamp: '2026-06-21T00:00:00.000Z',
            route: 'crossref.works',
            status: 'accepted',
            result_count: 1,
            url_count: 1
          }],
          candidates: [{
            provider: 'crossref.works',
            sourceType: 'scholarly_metadata',
            title: 'Crossref work',
            url: 'https://doi.org/10.1234/example',
            snippet: 'DOI metadata candidate',
            metadata: { doi: '10.1234/example' }
          }]
        };
      }
    };
    agent.sourceValidator = {
      validate: async (urls) => urls.map(url => ({
        url,
        ok: true,
        status: 200,
        contentType: 'text/html',
        bytes: 2048,
        contentHash: 'doi-hash'
      }))
    };
    agent.performLocalWebSearch = async () => {
      const error = new Error('local search unavailable');
      error.code = 'NO_SEARCH_RESULTS';
      throw error;
    };

    const result = await agent.performWebSearch('generic target source_url');

    expect(providersSeen).to.deep.equal(['crossref.works']);
    expect(result).to.include('Typed source providers found');
    expect(agent.sourcesFound).to.deep.equal(['https://doi.org/10.1234/example']);
    expect(agent.searchEvidence.map(entry => entry.backend)).to.include('crossref.works');
  });

  it('fails a source-required query even if an earlier query already found sources', async () => {
    const agent = new ResearchAgent(
      {
        goalId: 'goal-per-query-source-gate',
        description: 'Find fan anecdotes with source_url fields.',
        successCriteria: ['Every executed query must produce source_url evidence']
      },
      {
        models: { enableWebSearch: true },
        search: { supplementProviderNative: false }
      },
      logger
    );

    agent.sourcesFound = ['https://previous.example/source'];
    agent.gpt5 = {
      generateWithWebSearch: async () => ({
        content: 'Native model returned prose with no usable source.',
        webSearchSources: [],
        citations: []
      })
    };
    agent.sourceValidator = {
      validate: async () => []
    };

    try {
      await agent.performWebSearch('Legion of Mary fan recollection source_url');
      throw new Error('Expected query-level source acquisition failure');
    } catch (error) {
      expect(error.code).to.equal('SOURCE_ACQUISITION_FAILED');
      expect(agent.sourcesFound).to.deep.equal(['https://previous.example/source']);
      expect(agent.searchEvidence[0].backend).to.equal('provider-native');
      expect(agent.searchEvidence[0].quality.acceptable).to.equal(false);
    }
  });

  it('passes source-required strict mode through MCP web_search', async () => {
    const calls = [];
    const agent = new ResearchAgent(
      {
        goalId: 'goal-mcp-strict-search',
        description: 'Find fan anecdotes with source_url fields.',
        successCriteria: ['Every executed query must produce source_url evidence']
      },
      {
        models: { enableWebSearch: true }
      },
      logger
    );

    agent.mcpClient = {
      callTool: async (name, args) => {
        calls.push({ name, args });
        return {
          content: [{
            text: JSON.stringify({
              success: false,
              query: args.query,
              resultCount: 0,
              results: [],
              source: 'authoritative-search'
            })
          }]
        };
      }
    };

    await agent.runLocalSearch('Legion of Mary fan recollection source_url');

    expect(calls[0].name).to.equal('web_search');
    expect(calls[0].args).to.include({
      query: 'Legion of Mary fan recollection source_url',
      maxResults: 10,
      sourceRequired: true,
      allowDuckDuckGoFallback: false
    });
  });
});
