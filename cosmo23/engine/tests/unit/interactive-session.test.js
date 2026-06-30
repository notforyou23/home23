const { expect } = require('chai');

const { InteractiveSession } = require('../../src/interactive/interactive-session');
const { executeTool } = require('../../src/interactive/interactive-tools');

describe('InteractiveSession live run context', () => {
  const logger = { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} };

  function staleHydratedOrchestrator() {
    return {
      runtimePath: '/tmp/cosmo23/stale-run',
      cycleCount: 7,
      running: false,
      memory: {
        nodes: new Map(Array.from({ length: 43 }, (_, i) => [`node_${i}`, { id: `node_${i}` }])),
        edges: new Map(Array.from({ length: 132 }, (_, i) => [`edge_${i}`, { id: `edge_${i}` }]))
      },
      config: {
        architecture: {
          roleSystem: {
            guidedFocus: {
              domain: 'stale domain',
              context: 'stale topic'
            }
          }
        }
      },
      agentExecutor: null
    };
  }

  it('builds the prompt from live status instead of stale hydrated state', () => {
    const session = new InteractiveSession({}, staleHydratedOrchestrator(), logger, {
      client: { createCompletion: async () => ({ choices: [{ message: { content: 'ok' } }] }) },
      liveStatusProvider: () => ({
        running: true,
        lifecycle: 'running',
        cycle: 11,
        memoryNodes: 70,
        memoryEdges: 220,
        activeAgents: 2,
        domain: 'live domain',
        topic: 'live topic',
        energy: 0.52,
        coherence: 0.91,
        generatedAt: '2026-06-30T15:30:00.000Z',
        source: 'live_status'
      })
    });

    const prompt = session.buildSystemPrompt();

    expect(prompt).to.include('- Status: running');
    expect(prompt).to.include('- Domain: live domain');
    expect(prompt).to.include('- Topic: live topic');
    expect(prompt).to.include('- Cycle: 11');
    expect(prompt).to.include('- Memory: 70 nodes, 220 edges');
    expect(prompt).to.include('- Active agents: 2');
    expect(prompt).to.include('- Status source: live_status');
    expect(prompt).to.not.include('Cycle: 7');
    expect(prompt).to.not.include('43 nodes, 132 edges');
  });

  it('reports get_run_status from the live status provider when available', async () => {
    const result = await executeTool('get_run_status', {}, {
      orchestrator: staleHydratedOrchestrator(),
      runtimePath: '/tmp/cosmo23/stale-run',
      logger,
      liveStatusProvider: () => ({
        running: true,
        lifecycle: 'running',
        cycle: 12,
        memoryNodes: 75,
        memoryEdges: 230,
        activeAgents: 3,
        sleeping: false,
        domain: 'live domain',
        generatedAt: '2026-06-30T15:31:00.000Z',
        source: 'live_status'
      })
    });

    const status = JSON.parse(result);
    expect(status.running).to.equal(true);
    expect(status.lifecycle).to.equal('running');
    expect(status.cycle).to.equal(12);
    expect(status.memoryNodes).to.equal(75);
    expect(status.memoryEdges).to.equal(230);
    expect(status.activeAgents).to.equal(3);
    expect(status.source).to.equal('live_status');
  });

  it('reports brain_stats from the live status provider when available', async () => {
    const result = await executeTool('brain_stats', {}, {
      orchestrator: staleHydratedOrchestrator(),
      runtimePath: '/tmp/cosmo23/stale-run',
      logger,
      liveStatusProvider: () => ({
        cycle: 13,
        memoryNodes: 80,
        memoryEdges: 240,
        coherence: 0.82,
        source: 'live_status'
      })
    });

    const stats = JSON.parse(result);
    expect(stats.nodes).to.equal(80);
    expect(stats.edges).to.equal(240);
    expect(stats.cycle).to.equal(13);
    expect(stats.coherence).to.equal(0.82);
    expect(stats.source).to.equal('live_status');
  });
});
