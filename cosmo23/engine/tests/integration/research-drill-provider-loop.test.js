'use strict';

const { expect } = require('chai');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const { UnifiedClient } = require('../../src/core/unified-client');
const { DrillLoop } = require('../../src/drill/drill-loop');

const logger = { info() {}, warn() {}, error() {}, debug() {} };

function readJsonl(filePath) {
  return fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean)
    .map(line => JSON.parse(line));
}

function sse(res, chunks) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive'
  });
  chunks.forEach(chunk => res.write(`data: ${JSON.stringify(chunk)}\n\n`));
  res.write('data: [DONE]\n\n');
  res.end();
}

function completionChunk({ id, model, delta, finishReason = null }) {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }]
  };
}

describe('Research drill through an OpenAI-compatible provider', () => {
  it('runs parallel phase workers through real provider/tool translation and settles files, tapes, and plan state', async function () {
    this.timeout(20000);
    let requestCount = 0;
    const provider = http.createServer((req, res) => {
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
        res.writeHead(404).end();
        return;
      }
      let raw = '';
      req.on('data', chunk => { raw += chunk; });
      req.on('end', () => {
        requestCount += 1;
        const body = JSON.parse(raw);
        const model = body.model || 'test-local';
        const id = `chatcmpl-${requestCount}`;
        const toolNames = (body.tools || []).map(tool => tool.function?.name).filter(Boolean);
        if (toolNames.length > 0) {
          const prompt = JSON.stringify(body.messages || []);
          const matchedPath = prompt.match(/outputs\/(drill\/goal-\d+\/phase-\d+-[a-z0-9-]+\.md)/i);
          const writePath = matchedPath?.[1] || `drill/provider-phase-${requestCount}.md`;
          const phase = Number(writePath.match(/phase-(\d+)/)?.[1]) || requestCount;
          const calls = [
            {
              index: 0,
              id: `write-${requestCount}`,
              type: 'function',
              function: {
                name: 'write_file',
                arguments: JSON.stringify({
                  path: writePath,
                  content: `# Provider phase ${phase}\n\nA concrete finding from provider-translated phase ${phase}.`
                })
              }
            },
            {
              index: 1,
              id: `remember-${requestCount}`,
              type: 'function',
              function: {
                name: 'remember',
                arguments: JSON.stringify({
                  content: `Provider-translated finding for phase ${phase}.`
                })
              }
            },
            {
              index: 2,
              id: `finish-${requestCount}`,
              type: 'function',
              function: {
                name: 'finish',
                arguments: JSON.stringify({
                  summary: `Phase ${phase} wrote ${writePath}.`
                })
              }
            }
          ];
          sse(res, [
            completionChunk({ id, model, delta: { role: 'assistant', tool_calls: calls } }),
            completionChunk({ id, model, delta: {}, finishReason: 'tool_calls' })
          ]);
          return;
        }
        sse(res, [
          completionChunk({
            id,
            model,
            delta: {
              role: 'assistant',
              content: JSON.stringify({ summary: 'Both provider phases landed.', gaps: [] })
            }
          }),
          completionChunk({ id, model, delta: {}, finishReason: 'stop' })
        ]);
      });
    });
    await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
    const address = provider.address();
    const runtimePath = fs.mkdtempSync(path.join(os.tmpdir(), 'cosmo-provider-drill-'));
    const stateCalls = [];
    const config = {
      logsDir: runtimePath,
      models: { primary: 'test-local', fast: 'test-local' },
      modelAssignments: {
        default: { provider: 'local', model: 'test-local' },
        coordinator: { provider: 'local', model: 'test-local' }
      },
      providers: {
        local: {
          enabled: true,
          baseURL: `http://127.0.0.1:${address.port}/v1`,
          apiKey: 'test-only',
          defaultModel: 'test-local',
          modelMapping: {},
          supportsTools: true,
          supportsStreaming: true
        }
      },
      drill: {
        cycles: 2,
        maxConcurrent: 2,
        workerTurnsPerCycle: 4,
        workerCallTimeoutMs: 5000
      }
    };
    const client = new UnifiedClient(config, logger);
    const memory = {
      nodes: new Map(),
      async addNode(concept, tag, embedding, metadata) {
        this.nodes.set(`${tag}-${this.nodes.size}`, { concept, tag, metadata });
        return { id: `n${this.nodes.size}` };
      }
    };
    const orchestrator = {
      logsDir: runtimePath,
      memory,
      clusterStateStore: {
        async completeTask(id, patch) { stateCalls.push({ type: 'task', id, patch }); },
        async getMilestone() { return { id: 'ms:research', title: 'Provider drill', order: 1 }; },
        async upsertMilestone(value) { stateCalls.push({ type: 'milestone', value }); },
        async updatePlan(id, patch) { stateCalls.push({ type: 'plan', id, patch }); }
      },
      requestRunCompletion(reason) { this.completionReason = reason; },
      async saveState() { this.saves = (this.saves || 0) + 1; },
      _getEvents() { return { emitEvent() {} }; }
    };
    const drill = new DrillLoop({
      orchestrator,
      logger,
      client,
      config,
      plan: {
        shortPlan: {
          goal: 'Provider integration drill',
          constraints: [],
          seedPhases: [
            { title: 'Lane alpha', mission: 'Research lane alpha.' },
            { title: 'Lane beta', mission: 'Research lane beta.' }
          ]
        }
      }
    });

    try {
      drill.start();
      await drill._promise;
    } finally {
      await new Promise(resolve => provider.close(resolve));
    }

    expect(drill.mode).to.equal('done');
    expect(drill.doneReason).to.equal('cycles_exhausted');
    expect(drill.cyclesUsed).to.equal(2);
    expect(orchestrator.completionReason).to.equal('drill_cycles_exhausted');
    expect(orchestrator.saves).to.be.greaterThan(0);
    expect(requestCount).to.be.at.least(3);

    const writeups = fs.readdirSync(path.join(runtimePath, 'outputs', 'drill', 'goal-1'));
    expect(writeups.filter(file => file.endsWith('.md'))).to.have.length(2);
    const sources = readJsonl(path.join(runtimePath, 'outputs', 'sources.jsonl'));
    expect(sources.filter(row => row.tool === 'write_file')).to.have.length(2);
    const stream = readJsonl(path.join(runtimePath, 'outputs', 'stream.jsonl'));
    expect(stream.filter(row => row.kind === 'writeup')).to.have.length(2);
    expect(stream.some(row => row.kind === 'finding')).to.equal(true);
    expect(stateCalls.map(call => call.type)).to.deep.equal(['task', 'milestone', 'plan']);
  });
});
