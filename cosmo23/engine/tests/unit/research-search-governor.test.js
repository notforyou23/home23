'use strict';

/**
 * Search governor contract.
 *
 * A live run must never starve on broken search:
 * - each backend gets bounded attempts per run, then its circuit opens and
 *   it is not retried on every query;
 * - every attempt runs under a hard timeout — no repeated 20-second waits;
 * - a near-duplicate of an already-failed search is blocked BEFORE any
 *   backend is touched;
 * - the model gets a structured result naming the unavailable backends and
 *   forcing a strategy change (direct URLs via shell, coding backend,
 *   native knowledge);
 * - the governor is shared per run across parallel workers;
 * - successful searches still leave source receipts.
 */

const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  SearchGovernor,
  getSearchGovernor,
  DEFAULT_ATTEMPT_TIMEOUT_MS
} = require('../../src/agent/search-governor');
const { executeTool } = require('../../src/agent/tools');

const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function tempRuntime() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cosmo-search-gov-'));
}

/**
 * Orchestrator stub: one per "run" — the governor lives on it, shared by
 * every worker context of that run. Only the MCP backend is configured
 * unless a test opts into more.
 */
function makeRun({ callTool, search = {} } = {}) {
  return {
    logsDir: null,
    mcp: callTool ? { callTool } : undefined,
    config: {
      search: {
        maxBackendFailures: 2,
        attemptTimeoutMs: 150,
        allowDuckDuckGoFallback: false,
        ...search
      }
    }
  };
}

function makeContext(orchestrator, runtimePath) {
  return { orchestrator, runtimePath, logger };
}

describe('SearchGovernor: bounded backend attempts', () => {
  it('a failing backend is tried at most maxBackendFailures times per run, then never again', async () => {
    let calls = 0;
    const orchestrator = makeRun({
      callTool: async () => {
        calls += 1;
        throw new Error('SearXNG upstream 502');
      }
    });
    const runtimePath = tempRuntime();

    // Ten DISTINCT queries — without the breaker each would re-hit the dead
    // backend. Distinct enough to defeat the duplicate detector.
    const queries = [
      'garcia interview stanford 1967 acid tests',
      'wembley 1972 setlist europe recordings',
      'palo alto guitar shop apprenticeship dana morgan',
      'stinson beach 1970 workingman lyrics sessions',
      'egypt 1978 pyramid concerts logistics visas',
      'broadcast fm simulcast winterland closing 1978',
      'banjo bluegrass period black mountain boys',
      'watkins glen soundcheck jam 1973 crowd',
      'radio city 1980 acoustic sets recordings',
      'merl saunders keystone berkeley tapes 1973'
    ];
    for (const query of queries) {
      await executeTool('web_search', { query }, makeContext(orchestrator, runtimePath));
    }

    expect(calls).to.equal(2); // maxBackendFailures — never retried after the circuit opened
    const governor = orchestrator._searchGovernor;
    expect(governor.isOpen('mcp')).to.equal(true);
  });

  it('a dead backend is skipped while a healthy one still serves the query', async () => {
    let mcpCalls = 0;
    let searxngCalls = 0;
    const orchestrator = makeRun({
      callTool: async () => {
        mcpCalls += 1;
        throw new Error('mcp search dead');
      },
      search: { searxngUrl: 'http://localhost:9999' }
    });
    const runtimePath = tempRuntime();
    const context = {
      ...makeContext(orchestrator, runtimePath),
      createSearcher: () => ({
        async searchSearXNG(query) {
          searxngCalls += 1;
          return [{ title: 'Hit', url: 'https://archive.org/details/hit', snippet: 'found' }];
        },
        async searchBrave() { return []; },
        async searchDuckDuckGo() { return []; }
      })
    };

    const queriesUnique = [
      'garcia interview stanford 1967 acid tests',
      'wembley 1972 setlist europe recordings',
      'palo alto guitar shop apprenticeship dana morgan',
      'stinson beach 1970 workingman lyrics sessions'
    ];
    const outputs = [];
    for (const query of queriesUnique) {
      outputs.push(await executeTool('web_search', { query }, context));
    }

    expect(mcpCalls).to.equal(2);          // bounded, then circuit open
    expect(searxngCalls).to.equal(4);      // healthy backend keeps serving
    for (const output of outputs) {
      expect(output).to.include('archive.org/details/hit');
    }
  });
});

describe('SearchGovernor: no repeated long waits', () => {
  it('a hanging backend is cut off by the hard attempt timeout, not awaited for ~20s', async function () {
    this.timeout(5000);
    const orchestrator = makeRun({
      callTool: () => new Promise(() => {}) // hangs forever, like DDG on a bad day
    });
    const runtimePath = tempRuntime();

    const startedAt = Date.now();
    const result = await executeTool(
      'web_search',
      { query: 'garcia interview stanford 1967 acid tests' },
      makeContext(orchestrator, runtimePath)
    );
    const elapsed = Date.now() - startedAt;

    expect(elapsed).to.be.lessThan(2000); // attemptTimeoutMs is 150 here
    expect(result).to.include('timed out');
    expect(orchestrator._searchGovernor.backendState('mcp').failures).to.equal(1);
  });

  it('the default attempt timeout is well under the old 20-second stall', () => {
    expect(DEFAULT_ATTEMPT_TIMEOUT_MS).to.be.lessThan(10000);
  });
});

describe('SearchGovernor: duplicate-query anti-loop', () => {
  it('a near-duplicate of a failed search is blocked without touching any backend', async () => {
    let calls = 0;
    const orchestrator = makeRun({
      callTool: async () => {
        calls += 1;
        throw new Error('down');
      },
      search: { maxBackendFailures: 5 }
    });
    const runtimePath = tempRuntime();
    const context = makeContext(orchestrator, runtimePath);

    await executeTool('web_search', {
      query: 'Jerry Garcia 1973 Winterland disputed venue anecdote'
    }, context);
    expect(calls).to.equal(1);

    // Near-duplicate phrasing of the same failed hunt: blocked pre-backend.
    const blocked = await executeTool('web_search', {
      query: 'Jerry Garcia disputed 1973 Winterland venue anecdote'
    }, context);
    expect(calls).to.equal(1); // backend untouched
    const payload = JSON.parse(blocked);
    expect(payload.web_search).to.equal('blocked');
    expect(payload.reason).to.include('near-duplicate');
  });

  it('a genuinely different query may still try a live backend', async () => {
    let calls = 0;
    const orchestrator = makeRun({
      callTool: async ({ }) => {
        calls += 1;
        if (calls === 1) throw new Error('down once');
        return { content: [{ text: 'RESULTS: https://www.jerrygarcia.com/interviews/1972' }] };
      },
      search: { maxBackendFailures: 5 }
    });
    const runtimePath = tempRuntime();
    const context = makeContext(orchestrator, runtimePath);

    await executeTool('web_search', { query: 'garcia 1973 winterland disputed venue' }, context);
    const output = await executeTool('web_search', {
      query: 'merl saunders keystone berkeley residency tapes'
    }, context);

    expect(calls).to.equal(2);
    expect(output).to.include('jerrygarcia.com');
  });
});

describe('SearchGovernor: the strategy-change instruction', () => {
  it('names the unavailable backends and forces a concrete strategy change', async () => {
    const orchestrator = makeRun({
      callTool: async () => { throw new Error('SearXNG upstream 502'); }
    });
    const runtimePath = tempRuntime();
    const context = makeContext(orchestrator, runtimePath);

    await executeTool('web_search', { query: 'garcia interview stanford 1967 acid tests' }, context);
    await executeTool('web_search', { query: 'wembley 1972 setlist europe recordings' }, context);
    // Circuit now open; a third distinct query gets the structured block.
    const result = await executeTool('web_search', {
      query: 'palo alto guitar shop apprenticeship dana morgan'
    }, context);

    const payload = JSON.parse(result);
    expect(payload.web_search).to.equal('blocked');
    expect(payload.backends.mcp).to.include('unavailable');
    expect(payload.backends.mcp).to.include('circuit open');
    const strategy = payload.change_strategy.join(' ');
    expect(strategy).to.include('Do NOT issue another web_search');
    expect(strategy).to.include('curl');
    expect(strategy).to.include('coding_run');
    expect(strategy).to.include('own knowledge');
  });

  it('zero hits from a healthy backend says change the query, not the backend', async () => {
    const orchestrator = makeRun({
      callTool: async () => ({ content: [] }), // healthy-but-empty MCP path counts as failure
      search: { searxngUrl: 'http://localhost:9999', maxBackendFailures: 10 }
    });
    const runtimePath = tempRuntime();
    const context = {
      ...makeContext(orchestrator, runtimePath),
      createSearcher: () => ({
        async searchSearXNG() { return []; },
        async searchBrave() { return []; },
        async searchDuckDuckGo() { return []; }
      })
    };

    const result = await executeTool('web_search', {
      query: 'garcia obscure 1961 chateau recording'
    }, context);
    const payload = JSON.parse(result);
    expect(payload.web_search).to.equal('no_results');
    expect(payload.instruction).to.include('change the query substantially');
    // The healthy backend's breaker did not trip on empty results.
    expect(orchestrator._searchGovernor.isOpen('searxng')).to.equal(false);
  });
});

describe('SearchGovernor: shared per run, receipts preserved', () => {
  it('parallel workers share one governor — failures accumulate per RUN', async () => {
    let calls = 0;
    const orchestrator = makeRun({
      callTool: async () => {
        calls += 1;
        throw new Error('down');
      }
    });
    const runtimePath = tempRuntime();

    // Two different worker contexts of the SAME run.
    const workerA = { ...makeContext(orchestrator, runtimePath), loop: { drill: { workerId: 'w1' } } };
    const workerB = { ...makeContext(orchestrator, runtimePath), loop: { drill: { workerId: 'w2' } } };

    await executeTool('web_search', { query: 'garcia interview stanford 1967 acid tests' }, workerA);
    await executeTool('web_search', { query: 'wembley 1972 setlist europe recordings' }, workerB);
    // Breaker opened by w1+w2 jointly; w1's next distinct query is blocked.
    await executeTool('web_search', { query: 'palo alto guitar shop apprenticeship dana morgan' }, workerA);

    expect(calls).to.equal(2);
    expect(getSearchGovernor(workerA)).to.equal(getSearchGovernor(workerB));
  });

  it('successful searches still journal source receipts with drill provenance', async () => {
    const orchestrator = makeRun({
      callTool: async () => ({
        content: [{ text: 'Top hit: https://archive.org/details/gd1973 and https://www.jerrygarcia.com/interviews' }]
      })
    });
    const runtimePath = tempRuntime();
    const context = {
      ...makeContext(orchestrator, runtimePath),
      loop: { drill: { cycle: 4, workerId: 'w4', goalNumber: 2, phaseNumber: 1 } }
    };

    const result = await executeTool('web_search', { query: 'garcia 1973 archive recordings' }, context);
    expect(result).to.include('archive.org');

    const receipts = fs.readFileSync(path.join(runtimePath, 'outputs', 'sources.jsonl'), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line));
    expect(receipts).to.have.length(1);
    expect(receipts[0].query).to.equal('garcia 1973 archive recordings');
    expect(receipts[0].urls.join(' ')).to.include('archive.org/details/gd1973');
    expect(receipts[0].workerId).to.equal('w4');
    expect(receipts[0].goalNumber).to.equal(2);
    expect(receipts[0].phaseNumber).to.equal(1);
  });
});

describe('SearchGovernor unit behavior', () => {
  it('duplicate detection is word-overlap based, order-insensitive', () => {
    const governor = new SearchGovernor({ logger });
    governor.recordFailedQuery('jerry garcia winterland 1973 disputed venue');
    expect(governor.isNearDuplicateOfFailed('disputed venue winterland jerry garcia 1973')).to.be.a('string');
    expect(governor.isNearDuplicateOfFailed('merl saunders keystone berkeley residency')).to.equal(null);
  });

  it('checkQuery blocks when every configured backend is circuit-broken', () => {
    const governor = new SearchGovernor({ logger, maxBackendFailures: 1 });
    governor.recordFailure('searxng', new Error('down'));
    governor.recordFailure('duckduckgo', new Error('timeout'));
    const gate = governor.checkQuery('anything new at all', ['searxng', 'duckduckgo']);
    expect(gate.blocked).to.equal(true);
    expect(gate.reason).to.include('circuit-broken');
    // A backend that recovers via success closes its failure count.
    governor.recordSuccess('searxng');
    expect(governor.backendState('searxng').failures).to.equal(0);
  });
});
