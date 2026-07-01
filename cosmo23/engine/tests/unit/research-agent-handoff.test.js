const { expect } = require('chai');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-openai-key';

const { ResearchAgent } = require('../../src/agents/research-agent');
const { validateExpectedOutputFile } = require('../../src/core/task-completion-validator');

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
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cosmo-research-agent-blocked-'));
    const agent = new ResearchAgent(
      {
        goalId: 'goal-source-required',
        description: 'Recover fan anecdotes from forums. For each result, record source_url, source_type, author, and anecdote_text. Required expectedOutput: @outputs/raw-anecdotes/forum-social-candidates.json.',
        expectedOutput: '@outputs/raw-anecdotes/forum-social-candidates.json',
        successCriteria: ['Every finding must include a source_url']
      },
      {
        logsDir: tempDir,
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
    agent.addFinding = async () => ({ id: 'node-blocked' });

    const result = await agent.execute();

    expect(result.success).to.equal(false);
    expect(result.status).to.equal('blocked_search_failed');
    expect(result.queriesAttempted).to.equal(2);
    expect(result.searchFailures).to.have.length(2);
    const receiptPath = path.join(tempDir, 'outputs', 'raw-anecdotes', 'forum-social-candidates.json');
    const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
    expect(receipt.status).to.equal('no_candidates_found');
    expect(receipt.negative_receipts[0].reason).to.equal('search_routes_completed_without_extractable_forum_social_candidate');
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

  it('rewrites instruction-style web_search source scopes into targeted Jerry side-project queries', async () => {
    const agent = new ResearchAgent(
      {
        goalId: 'goal-forum-social',
        description: 'Use web_search for secondary sources, fan forums, Reddit, review blogs, Dead/Jerry discussion archives, and search X/Twitter via Home23 x-research where available. Queries must target Jerry Garcia side projects: Legion of Mary, Jerry Garcia Band, Old & In the Way, Reconstruction, New Riders of the Purple Sage, fan anecdotes, listener reviews, tapes, taper notes, and recollections. Do not use primary-source-only framing. Extract candidate anecdotes with source_url, source_type, project, date/show reference, excerpt, and confidence. Expected output: @outputs/raw-anecdotes/forum-social-candidates.json',
        expectedOutput: '@outputs/raw-anecdotes/forum-social-candidates.json',
        successCriteria: ['Every candidate must include a source_url']
      },
      {
        models: { enableWebSearch: true }
      },
      logger
    );

    agent.gpt5.generateFast = async () => {
      throw new Error('LLM query generation should not run for instruction-style explicit web_search missions');
    };

    const queries = await agent.generateResearchQueries();

    expect(queries).to.have.length.greaterThan(3);
    expect(queries.some(query => query.includes('Legion of Mary'))).to.equal(true);
    expect(queries.some(query => query.includes('Old & In the Way'))).to.equal(true);
    expect(queries.every(query => query.length < 512)).to.equal(true);
    expect(queries.some(query => /expected output|source_url|queries must target/i.test(query))).to.equal(false);
  });

  it('rejects generic dictionary results for Jerry-targeted source searches', () => {
    const agent = new ResearchAgent(
      {
        goalId: 'goal-quality',
        description: 'Find Jerry Garcia side project fan anecdotes with source_url fields',
        successCriteria: ['Every finding must include a source_url']
      },
      {
        models: { enableWebSearch: true }
      },
      logger
    );

    const quality = agent.assessSearchQuality(
      '"Legion of Mary" "Jerry Garcia" fan recollection review',
      [{
        title: 'Definition of SECONDARY - Merriam-Webster',
        url: 'https://www.merriam-webster.com/dictionary/secondary',
        snippet: 'of second rank, importance, or value'
      }]
    );

    expect(quality.acceptable).to.equal(false);
    expect(quality.reason).to.equal('results_do_not_match_query_terms');
  });

  it('exports forum/social candidates with a schema the completion gate can validate', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cosmo-research-agent-forum-social-'));
    const outputsRoot = path.join(tempDir, 'outputs');
    const sourceUrl = 'https://lostlivedead.blogspot.com/2012/03/legion-of-mary-1974-1975.html';
    const agent = new ResearchAgent(
      {
        goalId: 'goal-forum-social-export',
        description: 'Use web_search for fan forums and review blogs about Jerry Garcia side projects. Expected output: @outputs/raw-anecdotes/forum-social-candidates.json',
        expectedOutput: '@outputs/raw-anecdotes/forum-social-candidates.json',
        successCriteria: ['Every candidate must include source_url, source_type, project, excerpt, and confidence']
      },
      {
        logsDir: tempDir,
        models: { enableWebSearch: true }
      },
      logger
    );

    agent.searchQueries = ['"Legion of Mary" "Jerry Garcia" fan recollection review'];
    agent.sourcesFound = [sourceUrl];
    agent.searchEvidence = [{
      timestamp: '2026-06-30T00:00:00.000Z',
      query: agent.searchQueries[0],
      executedQuery: agent.searchQueries[0],
      backend: 'web.search',
      resultCount: 1,
      urls: [sourceUrl],
      quality: {
        acceptable: true,
        reason: 'relevant_results_found',
        relevantResults: 1,
        resultCount: 1,
        relevantUrls: [sourceUrl]
      },
      sourceValidation: [{
        url: sourceUrl,
        ok: true,
        status: 200,
        contentType: 'text/html',
        bytes: 4096,
        contentHash: 'hash-forum-social'
      }],
      results: [{
        title: 'Legion of Mary 1974-1975',
        url: sourceUrl,
        snippet: 'Legion of Mary shows with Jerry Garcia generated listener discussion, review-blog context, and recollections about the band during 1974 and 1975.',
        sourceType: 'web_result'
      }]
    }];

    await agent.exportResearchCorpus(
      {
        summary: 'Forum/social source acquisition complete.',
        findings: ['A review-blog source has candidate listener-recollection context for Legion of Mary.'],
        successAssessment: 'Complete'
      },
      []
    );

    const rawPath = path.join(outputsRoot, 'raw-anecdotes', 'forum-social-candidates.json');
    const data = JSON.parse(await fs.readFile(rawPath, 'utf8'));
    expect(data.candidates).to.have.length(1);
    expect(data.candidates[0]).to.include({
      source_url: sourceUrl,
      source_type: 'blog_review',
      project: 'Legion of Mary'
    });

    const validation = await validateExpectedOutputFile(rawPath, {
      label: '@outputs/raw-anecdotes/forum-social-candidates.json'
    }, { outputRoot: outputsRoot });
    expect(validation.passed).to.equal(true);
  });

  it('does not use Archive typed providers for secondary forum/social acquisition missions', () => {
    const agent = new ResearchAgent(
      {
        goalId: 'goal-secondary-social-providers',
        description: 'Use web_search for secondary sources, fan forums, Reddit, review blogs, and search X/Twitter via Home23 x-research where available. Do not use primary-source-only framing. Required expectedOutput: @outputs/raw-anecdotes/forum-social-candidates.json',
        expectedOutput: '@outputs/raw-anecdotes/forum-social-candidates.json',
        successCriteria: ['Every candidate must include a source_url']
      },
      {
        models: { enableWebSearch: true }
      },
      logger
    );

    const registry = {
      listProviders: () => ['web.search', 'archive.advancedsearch', 'archive.metadata', 'archive.reviews', 'home23.skill.x_research.search'],
      selectProviders: () => ['web.search', 'archive.advancedsearch', 'archive.metadata', 'archive.reviews', 'home23.skill.x_research.search']
    };

    const providerIds = agent.getTypedSourceProviderIds('"Jerry Garcia Band" fan review', registry);

    expect(providerIds).to.include('web.search');
    expect(providerIds).to.not.include('archive.advancedsearch');
    expect(providerIds).to.not.include('archive.metadata');
    expect(providerIds).to.not.include('archive.reviews');
  });

  it('does not infer a forum/social candidate project from the query when the result is unrelated', () => {
    const agent = new ResearchAgent(
      {
        goalId: 'goal-no-query-leak-candidate',
        description: 'Use web_search for secondary sources, fan forums, Reddit, review blogs, and search X/Twitter via Home23 x-research where available. Do not use primary-source-only framing. Required expectedOutput: @outputs/raw-anecdotes/forum-social-candidates.json',
        expectedOutput: '@outputs/raw-anecdotes/forum-social-candidates.json',
        successCriteria: ['Every candidate must include a source_url']
      },
      {
        models: { enableWebSearch: true }
      },
      logger
    );

    agent.searchEvidence = [{
      query: '"Jerry Garcia Band" fan review taper notes',
      backend: 'archive.advancedsearch',
      quality: {
        acceptable: true,
        relevantUrls: ['https://archive.org/details/gd77-06-09.akg-bertrando.winters.26450.sbeok.shnf']
      },
      sourceValidation: [{
        url: 'https://archive.org/details/gd77-06-09.akg-bertrando.winters.26450.sbeok.shnf',
        ok: true
      }],
      results: [{
        title: 'Grateful Dead Live at Winterland on 1977-06-09',
        url: 'https://archive.org/details/gd77-06-09.akg-bertrando.winters.26450.sbeok.shnf',
        snippet: 'Mississippi Half Step, Jack Straw, They Love Each Other, Cassidy, Sunrise, Deal',
        sourceType: 'archive_item'
      }]
    }];

    expect(agent.buildForumSocialCandidates()).to.deep.equal([]);
  });

  it('can extract a forum/social candidate from a validated direct secondary-source fetch sample', () => {
    const sourceUrl = 'https://lostlivedead.blogspot.com/2012/03/august-20-1975-great-american-music.html';
    const agent = new ResearchAgent(
      {
        goalId: 'goal-direct-source-candidate',
        description: 'Use web_search for secondary sources, fan forums, Reddit, review blogs, and social sources. Do not use primary-source-only framing. Required expectedOutput: @outputs/raw-anecdotes/forum-social-candidates.json',
        expectedOutput: '@outputs/raw-anecdotes/forum-social-candidates.json',
        successCriteria: ['Every candidate must include source_url']
      },
      {
        models: { enableWebSearch: true }
      },
      logger
    );

    agent.searchEvidence = [{
      query: sourceUrl,
      backend: 'direct-source-fetch',
      quality: {
        acceptable: true,
        relevantUrls: [sourceUrl]
      },
      sourceValidation: [{
        url: sourceUrl,
        ok: true
      }],
      results: [{
        title: 'Direct source validated',
        url: sourceUrl,
        snippet: 'Lost Live Dead: August 20, 1975 Great American Music Hall. The Legion Of Mary and The Jerry Garcia Band, Summer 1975, with review-blog context and listener discussion.',
        sourceType: 'direct_source'
      }]
    }];

    const candidates = agent.buildForumSocialCandidates();

    expect(candidates).to.have.length(1);
    expect(candidates[0]).to.include({
      source_url: sourceUrl,
      source_type: 'blog_review',
      project: 'Legion of Mary'
    });
  });

  it('extracts readable candidate text from direct-fetched Blogspot HTML instead of raw markup', () => {
    const sourceUrl = 'https://lostlivedead.blogspot.com/2009/12/may-13-1975-keystone-berkeley-lucky.html';
    const agent = new ResearchAgent(
      {
        goalId: 'goal-readable-direct-source-candidate',
        description: 'Use web_search for secondary sources, fan forums, Reddit, review blogs, and social sources. Required expectedOutput: @outputs/raw-anecdotes/forum-social-candidates.json',
        expectedOutput: '@outputs/raw-anecdotes/forum-social-candidates.json',
        successCriteria: ['Every candidate must include source_url']
      },
      {
        models: { enableWebSearch: true }
      },
      logger
    );

    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>Lost Live Dead: May 13, 1975 Keystone Berkeley Lucky Strike (Legion Of Mary)</title>
          <meta content="blogger">
          <style>.hidden { color: red; }</style>
        </head>
        <body>
          <article>
            <h1>May 13, 1975 Keystone Berkeley Lucky Strike (Legion Of Mary)</h1>
            <p>The significant clue here is that according to the Jerry Site, Deadbase lists a Legion Of Mary show at Keystone Berkeley on May 12, 1975, complete with setlist.</p>
            <p>6 comments: Fate Music December 14, 2009 at 8:23 PM Absolutely fascinating posts. I plan on digging further into this.</p>
          </article>
        </body>
      </html>`;
    const sample = agent.extractReadableSourceSample(html, 'text/html; charset=UTF-8', sourceUrl);

    agent.searchEvidence = [{
      query: sourceUrl,
      backend: 'direct-source-fetch',
      quality: {
        acceptable: true,
        relevantUrls: [sourceUrl]
      },
      sourceValidation: [{
        url: sourceUrl,
        ok: true,
        status: 200,
        sample
      }],
      results: [{
        title: 'Direct source validated',
        url: sourceUrl,
        snippet: 'status=200 content-type=text/html; charset=UTF-8 bytes=129743 sample=<!DOCTYPE html> <html><head>',
        sourceType: 'direct_source'
      }]
    }];

    const candidates = agent.buildForumSocialCandidates();

    expect(sample).to.include('Legion Of Mary');
    expect(sample).to.not.include('<!DOCTYPE html>');
    expect(candidates).to.have.length(1);
    expect(candidates[0].project).to.equal('Legion of Mary');
    expect(candidates[0].excerpt).to.include('Absolutely fascinating posts');
    expect(candidates[0].excerpt).to.not.match(/^status=200/);
  });

  it('does not treat predecessor artifact input paths as requested output deliverables', () => {
    const agent = new ResearchAgent(
      {
        goalId: 'goal-output-paths',
        description: [
          'Use web_search for fan forums. Required expectedOutput: @outputs/raw-anecdotes/forum-social-candidates.json.',
          '',
          '## Available Predecessor Artifacts',
          '- `outputs/research/agent_123/archive-org-comments.json` (36KB)',
          '- `outputs/research/agent_123/source_attempts.jsonl` (8KB)',
          'Use the exact relative paths shown above when reading these files.'
        ].join('\n'),
        expectedOutput: '@outputs/raw-anecdotes/forum-social-candidates.json',
        successCriteria: []
      },
      {
        models: { enableWebSearch: true }
      },
      logger
    );

    expect(agent.extractRequestedOutputPaths()).to.deep.equal([
      '@outputs/raw-anecdotes/forum-social-candidates.json'
    ]);
  });

  it('allows fallback metasearch routes in source-required mode while keeping source validation', async () => {
    const agent = new ResearchAgent(
      {
        goalId: 'goal-source-required-fallback-search',
        description: 'Find fan anecdotes with source_url fields from review blogs.',
        successCriteria: ['Every finding must include a source_url']
      },
      {
        models: { enableWebSearch: true },
        sourceProviders: { enabled: false }
      },
      logger
    );

    const calls = [];
    agent.mcpClient = {
      callTool: async (tool, args) => {
        calls.push({ tool, args });
        return {
          content: [{
            text: JSON.stringify({
              success: true,
              source: 'duckduckgo',
              query: args.query,
              results: [{
                title: 'Lost Live Dead: Legion of Mary and Jerry Garcia',
                url: 'https://lostlivedead.blogspot.com/2012/03/august-20-1975-great-american-music.html',
                snippet: 'The Legion Of Mary and The Jerry Garcia Band, Summer 1975, with review-blog context.'
              }]
            })
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
        bytes: 1000
      }))
    };
    agent.gpt5 = {
      generate: async () => ({ content: 'Validated fallback metasearch source.' })
    };

    const result = await agent.performLocalWebSearch('site:lostlivedead.blogspot.com "Legion of Mary" "Jerry Garcia"');

    expect(result).to.equal('Validated fallback metasearch source.');
    expect(calls[0].args).to.include({
      sourceRequired: true,
      allowDuckDuckGoFallback: true
    });
    expect(agent.sourcesFound).to.deep.equal([
      'https://lostlivedead.blogspot.com/2012/03/august-20-1975-great-american-music.html'
    ]);
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

  it('blocks source backbone continuation when a required source route was never attempted', () => {
    const agent = new ResearchAgent(
      {
        goalId: 'goal-missing-required-route',
        description: 'Use the supplied research contract to acquire typed sources.',
        metadata: {
          researchContract: {
            required: true,
            mode: 'source_acquisition',
            sourceProviderHints: ['crossref.works']
          }
        }
      },
      { models: { enableWebSearch: true } },
      logger
    );

    agent.searchQueries = ['generic publication source_url'];
    agent.sourcesFound = ['https://example.com/generic'];
    agent.searchEvidence = [{
      timestamp: '2026-06-30T00:00:00.000Z',
      query: 'generic publication source_url',
      executedQuery: 'generic publication source_url',
      backend: 'web.search',
      resultCount: 1,
      urls: ['https://example.com/generic'],
      quality: { acceptable: true, reason: 'typed_source_candidates_found', relevantResults: 1 },
      sourceValidation: [{ url: 'https://example.com/generic', ok: true, status: 200 }],
      results: []
    }];

    const receipts = agent.buildSourceBackboneReceipts({ findings: [] }, [], []);

    expect(receipts.status.productive_sources).to.equal(1);
    expect(receipts.status.can_continue).to.equal(false);
    expect(receipts.status.required_routes).to.deep.equal(['crossref.works']);
    expect(receipts.status.attempted_routes).to.deep.equal(['web.search']);
    expect(receipts.status.missing_required_routes).to.deep.equal(['crossref.works']);
    expect(receipts.status.next_allowed_action).to.equal('attempt_missing_required_source_routes');
  });

  it('blocks source backbone continuation when a required source route failed', () => {
    const agent = new ResearchAgent(
      {
        goalId: 'goal-failed-required-route',
        description: 'Use the supplied research contract to acquire typed sources.',
        metadata: {
          researchContract: {
            required: true,
            mode: 'source_acquisition',
            sourceProviderHints: ['crossref.works']
          }
        }
      },
      { models: { enableWebSearch: true } },
      logger
    );

    agent.searchQueries = ['generic publication source_url'];
    agent.sourcesFound = ['https://example.com/generic'];
    agent.searchEvidence = [
      {
        timestamp: '2026-06-30T00:00:00.000Z',
        query: 'generic publication source_url',
        executedQuery: 'generic publication source_url',
        backend: 'web.search',
        resultCount: 1,
        urls: ['https://example.com/generic'],
        quality: { acceptable: true, reason: 'typed_source_candidates_found', relevantResults: 1 },
        sourceValidation: [{ url: 'https://example.com/generic', ok: true, status: 200 }],
        results: []
      },
      {
        timestamp: '2026-06-30T00:00:01.000Z',
        query: 'generic publication source_url',
        executedQuery: 'generic publication source_url',
        backend: 'crossref.works',
        resultCount: 0,
        urls: [],
        quality: { acceptable: false, reason: 'provider_failed', relevantResults: 0 },
        providerAttempt: { route: 'crossref.works', status: 'failed', error: 'HTTP 500' },
        sourceValidation: [],
        results: []
      }
    ];

    const receipts = agent.buildSourceBackboneReceipts({ findings: [] }, [], []);

    expect(receipts.status.productive_sources).to.equal(1);
    expect(receipts.status.can_continue).to.equal(false);
    expect(receipts.status.attempted_routes).to.include.members(['web.search', 'crossref.works']);
    expect(receipts.status.failed_required_routes).to.deep.equal(['crossref.works']);
    expect(receipts.status.next_allowed_action).to.equal('repair_failed_required_source_routes');
  });

  it('allows continuation when a required source route has an accepted empty receipt and another route has source evidence', () => {
    const agent = new ResearchAgent(
      {
        goalId: 'goal-empty-required-route',
        description: 'Use the supplied research contract to acquire typed sources.',
        metadata: {
          researchContract: {
            required: true,
            mode: 'source_acquisition',
            sourceProviderHints: ['crossref.works']
          }
        }
      },
      { models: { enableWebSearch: true } },
      logger
    );

    agent.searchQueries = ['generic publication source_url'];
    agent.sourcesFound = ['https://example.com/generic'];
    agent.searchEvidence = [
      {
        timestamp: '2026-06-30T00:00:00.000Z',
        query: 'generic publication source_url',
        executedQuery: 'generic publication source_url',
        backend: 'web.search',
        resultCount: 1,
        urls: ['https://example.com/generic'],
        quality: { acceptable: true, reason: 'typed_source_candidates_found', relevantResults: 1 },
        sourceValidation: [{ url: 'https://example.com/generic', ok: true, status: 200 }],
        results: []
      },
      {
        timestamp: '2026-06-30T00:00:01.000Z',
        query: 'generic publication source_url',
        executedQuery: 'generic publication source_url',
        backend: 'crossref.works',
        resultCount: 0,
        urls: [],
        quality: { acceptable: false, reason: 'no_validated_typed_source_candidates', relevantResults: 0 },
        providerAttempt: { route: 'crossref.works', status: 'empty' },
        sourceValidation: [],
        results: []
      }
    ];

    const receipts = agent.buildSourceBackboneReceipts({ findings: [] }, [], []);

    expect(receipts.status.can_continue).to.equal(true);
    expect(receipts.status.accepted_empty_routes).to.deep.equal(['crossref.works']);
    expect(receipts.status.failed_routes).to.deep.equal([]);
    expect(receipts.status.next_allowed_action).to.equal('continue');
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
        search: { supplementProviderNative: true },
        sourceProviders: { enabled: false }
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
        search: { supplementProviderNative: true },
        sourceProviders: { enabled: false }
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
        search: { supplementProviderNative: true },
        sourceProviders: { enabled: false }
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

  it('exports Archive.org review outputs as extracted records with route receipts', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cosmo-research-agent-archive-'));
    const outputsRoot = path.join(tempDir, 'outputs');
    const identifiers = [
      'legion-of-mary-the-bottom-line-nyc-1975',
      'legion-of-mary-oriental-theatre-wi-1975-wzmf'
    ];
    const agent = new ResearchAgent(
      {
        goalId: 'goal-archive-comments',
        description: `Fetch Archive.org reviews for identifiers: ${identifiers.join(', ')}. Required expectedOutput @outputs/raw-anecdotes/archive-org-comments.json.`,
        expectedOutput: '@outputs/raw-anecdotes/archive-org-comments.json',
        successCriteria: ['Route receipts must include archive.metadata and archive.reviews']
      },
      {
        logsDir: tempDir,
        models: { enableWebSearch: true }
      },
      logger
    );

    agent.searchQueries = [`Fetch Archive.org reviews for identifiers: ${identifiers.join(', ')}`];
    agent.sourcesFound = [
      `https://archive.org/details/${identifiers[0]}#reviews`,
      `https://archive.org/details/${identifiers[1]}`
    ];
    agent.searchEvidence = [
      {
        timestamp: '2026-06-30T00:00:00.000Z',
        query: agent.searchQueries[0],
        executedQuery: agent.searchQueries[0],
        backend: 'archive.metadata',
        resultCount: 2,
        urls: identifiers.map(id => `https://archive.org/details/${id}`),
        quality: { acceptable: true, reason: 'typed_source_candidates_found' },
        sourceValidation: identifiers.map(id => ({ url: `https://archive.org/details/${id}`, ok: true, status: 'metadata_only' })),
        results: [
          {
            title: identifiers[0],
            url: `https://archive.org/details/${identifiers[0]}`,
            sourceType: 'archive_metadata',
            metadata: { identifier: identifiers[0], reviews: 1 },
            raw: { metadata: { identifier: identifiers[0] }, reviews: [{}] }
          },
          {
            title: identifiers[1],
            url: `https://archive.org/details/${identifiers[1]}`,
            sourceType: 'archive_metadata',
            metadata: { identifier: identifiers[1], reviews: 0 },
            raw: { metadata: { identifier: identifiers[1] }, reviews: [] }
          }
        ]
      },
      {
        timestamp: '2026-06-30T00:00:01.000Z',
        query: agent.searchQueries[0],
        executedQuery: agent.searchQueries[0],
        backend: 'archive.reviews',
        resultCount: 1,
        urls: [
          `https://archive.org/details/${identifiers[0]}#reviews`,
          `https://archive.org/details/${identifiers[1]}#reviews`
        ],
        quality: { acceptable: true, reason: 'typed_source_candidates_found' },
        sourceValidation: [
          { url: `https://archive.org/details/${identifiers[0]}#reviews`, ok: true, status: 'metadata_only' },
          { url: `https://archive.org/details/${identifiers[1]}#reviews`, ok: true, status: 'metadata_only' }
        ],
        results: [
          {
            title: 'Great night',
            url: `https://archive.org/details/${identifiers[0]}#reviews`,
            snippet: 'A first-person listener memory from the Archive review.',
            sourceType: 'archive_review',
            metadata: {
              identifier: identifiers[0],
              reviewId: 'review-1',
              reviewer: 'listener',
              createdAt: '2026-01-02'
            },
            raw: {
              review_id: 'review-1',
              reviewer: 'listener',
              title: 'Great night',
              body: 'A first-person listener memory from the Archive review.',
              createdate: '2026-01-02'
            }
          },
          {
            title: `No Archive reviews for ${identifiers[1]}`,
            url: `https://archive.org/details/${identifiers[1]}#reviews`,
            snippet: 'Archive metadata reviews array was checked and contained no review records.',
            sourceType: 'archive_review_status',
            metadata: {
              identifier: identifiers[1],
              reviews: 0,
              status: 'no_reviews_found',
              validationStrategy: 'metadata_only'
            },
            raw: {
              metadata: { identifier: identifiers[1] },
              reviews: []
            }
          }
        ]
      },
      {
        timestamp: '2026-06-30T00:00:02.000Z',
        query: 'generic archive metadata reviews API endpoint identifier',
        executedQuery: 'generic archive metadata reviews API endpoint identifier',
        backend: 'archive.metadata',
        resultCount: 2,
        urls: [
          `https://archive.org/details/${identifiers[0]}`,
          'https://archive.org/details/unrelated-archive-identifier-2026'
        ],
        quality: { acceptable: false, reason: 'results_do_not_match_query_terms' },
        sourceValidation: [],
        results: [
          {
            title: identifiers[0],
            url: `https://archive.org/details/${identifiers[0]}`,
            sourceType: 'archive_metadata',
            metadata: { identifier: identifiers[0], reviews: 0 },
            raw: { metadata: { identifier: identifiers[0] }, reviews: [] }
          },
          {
            title: 'unrelated-archive-identifier-2026',
            url: 'https://archive.org/details/unrelated-archive-identifier-2026',
            sourceType: 'archive_metadata',
            metadata: { identifier: 'unrelated-archive-identifier-2026', reviews: 0 },
            raw: { metadata: { identifier: 'unrelated-archive-identifier-2026' }, reviews: [] }
          }
        ]
      }
    ];

    await agent.exportResearchCorpus(
      {
        summary: 'Archive review extraction complete.',
        findings: ['One Archive review record was extracted.'],
        successAssessment: 'Complete'
      },
      []
    );

    const rawPath = path.join(outputsRoot, 'raw-anecdotes', 'archive-org-comments.json');
    const data = JSON.parse(await fs.readFile(rawPath, 'utf8'));

    expect(data.entries).to.have.length(1);
    expect(data.entries[0]).to.include({
      identifier: identifiers[0],
      source_type: 'archive_review',
      review_id: 'review-1',
      route: 'archive.reviews'
    });
    expect(data.entries[0].review_body).to.include('first-person listener memory');
    expect(data.required_identifiers).to.deep.equal(identifiers);
    expect(data.identifier_statuses.map(item => item.identifier)).to.deep.equal(identifiers);
    expect(data.identifier_statuses.find(item => item.identifier === identifiers[0]).metadata_route).to.equal('accepted');
    expect(data.identifier_statuses.find(item => item.identifier === identifiers[0]).review_route).to.equal('accepted');
    expect(data.identifier_statuses.find(item => item.identifier === identifiers[0]).status).to.equal('reviews_extracted');
    expect(data.identifier_statuses.find(item => item.identifier === identifiers[1]).metadata_route).to.equal('accepted');
    expect(data.identifier_statuses.find(item => item.identifier === identifiers[1]).review_route).to.equal('accepted');
    expect(data.identifier_statuses.find(item => item.identifier === identifiers[1]).status).to.equal('no_reviews_found');
    expect(data.route_receipts.attempts.map(item => item.route)).to.include.members(['archive.metadata', 'archive.reviews']);
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
      allowDuckDuckGoFallback: true
    });
  });
});
