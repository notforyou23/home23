const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-key';
const { MetaCoordinator } = require('../../../engine/src/coordinator/meta-coordinator');

function createCoordinator() {
  return new MetaCoordinator({
    logsDir: '/tmp/home23-test',
    coordinator: {
      maxTokens: 3000,
      reasoningEffort: 'low',
      verbosity: 'low',
    },
  }, {
    info() {},
    warn() {},
    error() {},
    debug() {},
  });
}

test('goal portfolio review honors configured coordinator LLM budget', async () => {
  const coordinator = createCoordinator();
  let captured = null;
  coordinator.gpt5 = {
    async generateWithRetry(args) {
      captured = args;
      return { content: '1. goal_1 - keep moving', reasoning: null };
    },
  };

  await coordinator.evaluateGoals({
    active: [['goal_1', {
      id: 'goal_1',
      description: 'Produce a small operational report.',
      priority: 0.4,
      progress: 0.1,
      pursuitCount: 1,
    }]],
  }, []);

  assert.equal(captured.maxTokens, 3000);
  assert.equal(captured.reasoningEffort, 'low');
  assert.equal(captured.verbosity, 'low');
});

test('strategic decision review honors configured coordinator LLM budget', async () => {
  const coordinator = createCoordinator();
  let captured = null;
  coordinator.gpt5 = {
    async generateWithRetry(args) {
      captured = args;
      return {
        content: [
          'TOP 5 GOALS TO PRIORITIZE',
          '1. goal_1 - continue',
          'KEY INSIGHTS',
          '- keep operator loop grounded',
          'STRATEGIC DIRECTIVES',
          '- close verified work before adding more',
        ].join('\n'),
        reasoning: null,
      };
    },
  };

  await coordinator.makeStrategicDecisions({
    cognitiveAnalysis: { content: 'Cognition is current.' },
    goalEvaluation: {
      content: 'goal_1 is the only active goal.',
      prioritizedGoals: [{ id: 'goal_1', description: 'one goal' }],
    },
    memoryAnalysis: { content: 'Memory is connected.' },
    agentResults: { agentCount: 0, agentSummaries: [], insights: [], findings: [] },
    deliverables: { totalFiles: 0, byAgentType: {}, recentFiles: [], gaps: [] },
    systemHealth: { cognitiveState: { curiosity: 1, mood: 1, energy: 1 } },
    previousContext: [],
  });

  assert.equal(captured.maxTokens, 3000);
  assert.equal(captured.reasoningEffort, 'low');
  assert.equal(captured.verbosity, 'low');
});

test('agent result analysis uses a bounded recent sample', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-coordinator-results-'));
  fs.mkdirSync(path.join(dir, 'coordinator'), { recursive: true });
  const queuePath = path.join(dir, 'coordinator', 'results_queue.jsonl');
  const rows = [];
  for (let i = 0; i < 8; i += 1) {
    rows.push(JSON.stringify({
      agentId: `agent_${i}`,
      agentType: 'AnalysisAgent',
      status: 'completed',
      startTime: `2026-05-10T10:0${i}:00.000Z`,
      endTime: `2026-05-10T10:0${i}:30.000Z`,
      durationFormatted: '30s',
      mission: { description: `Mission ${i} ${'x'.repeat(120)}` },
      results: [
        { type: 'insight', content: `Insight ${i} ${'a'.repeat(500)}` },
        { type: 'finding', content: `Finding ${i} ${'b'.repeat(500)}` },
      ],
    }));
    rows.push(JSON.stringify({ type: 'integration_marker', agentId: `agent_${i}`, timestamp: `2026-05-10T10:0${i}:31.000Z` }));
  }
  fs.writeFileSync(queuePath, `${rows.join('\n')}\n`);

  const coordinator = new MetaCoordinator({
    logsDir: dir,
    coordinator: {
      agentResultsMaxBytes: 1024 * 1024,
      agentResultsMaxResults: 3,
      agentResultsMaxSummaries: 2,
      agentResultsMaxInsights: 4,
      agentResultsMaxFindings: 2,
      agentResultSampleChars: 120,
    },
  }, {
    info() {},
    warn() {},
    error() {},
    debug() {},
  });

  const result = await coordinator.analyzeAgentResults(0);
  assert.equal(result.sourceStats.reviewedResults, 3);
  assert.equal(result.agentSummaries.length, 2);
  assert.equal(result.insights.length, 3);
  assert.equal(result.findings.length, 2);
  assert.ok(result.insights.every((item) => item.content.length <= 120));

  const report = await coordinator.generateReport({
    cycleRange: [1, 2],
    cognitiveAnalysis: {},
    goalEvaluation: {},
    memoryAnalysis: {},
    agentResults: result,
    deliverables: {},
    systemHealth: {},
    decisions: {},
    reviewDuration: 10,
  });
  assert.equal(report.agentWork.agentSummaries.length, 2);
  assert.equal(report.agentWork.sourceStats.reviewedResults, 3);
  assert.ok(Buffer.byteLength(JSON.stringify(report)) < 20_000);
});
