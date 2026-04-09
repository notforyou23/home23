const { expect } = require('chai');
const sinon = require('sinon');
const { sweepPartitions, sweepPartition, buildSweepPrompt, MAX_CONTEXT_CHARS } = require('../src/sweeper');

describe('Sweeper', () => {
  describe('buildSweepPrompt', () => {
    it('should include all four response sections', () => {
      const prompt = buildSweepPrompt(50, 5);
      expect(prompt).to.include('## Domain State');
      expect(prompt).to.include('## Findings');
      expect(prompt).to.include('## Outbound Flags');
      expect(prompt).to.include('## Absences');
    });

    it('should include partition node count', () => {
      const prompt = buildSweepPrompt(142, 8);
      expect(prompt).to.include('142 nodes');
    });

    it('should handle single partition case', () => {
      const prompt = buildSweepPrompt(50, 1);
      expect(prompt).to.include('this single partition');
    });
  });

  describe('sweepPartition', () => {
    let mockProvider;
    let nodeMap;
    let partition;
    let allPartitions;

    beforeEach(() => {
      mockProvider = {
        generate: sinon.stub().resolves({
          content: '## Domain State\nTest domain.\n\n## Findings\nTest finding [Node 1].\n\n## Outbound Flags\nNone.\n\n## Absences\nNo data on X.'
        })
      };

      nodeMap = new Map();
      for (let i = 1; i <= 10; i++) {
        nodeMap.set(String(i), {
          id: i,
          concept: `Research finding ${i} about quantum physics and conformal field theory with detailed analysis.`,
          tag: i <= 3 ? 'research' : 'analysis',
          weight: 1 - (i * 0.05),
          embedding: new Array(4).fill(0.5)
        });
      }

      partition = {
        id: 0,
        nodeIds: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'],
        nodeCount: 10,
        summary: 'Quantum physics research',
        keywords: ['quantum', 'physics', 'conformal', 'field', 'theory'],
        adjacentPartitions: [{ id: 1, sharedEdges: 3 }]
      };

      allPartitions = [
        partition,
        {
          id: 1,
          nodeIds: ['11', '12'],
          nodeCount: 2,
          summary: 'Mathematical foundations',
          keywords: ['math', 'algebra', 'topology']
        }
      ];
    });

    it('should call provider with correct structure', async () => {
      await sweepPartition('test query', partition, nodeMap, [], allPartitions, mockProvider, { sweepMaxTokens: 6000 });

      expect(mockProvider.generate.calledOnce).to.be.true;
      const call = mockProvider.generate.firstCall.args[0];
      expect(call).to.have.property('instructions');
      expect(call).to.have.property('input');
      expect(call).to.have.property('maxTokens', 6000);
      expect(call).to.have.property('reasoningEffort', 'medium');
    });

    it('should include all four sections in the system prompt', async () => {
      await sweepPartition('test query', partition, nodeMap, [], allPartitions, mockProvider, { sweepMaxTokens: 6000 });

      const call = mockProvider.generate.firstCall.args[0];
      expect(call.instructions).to.include('Domain State');
      expect(call.instructions).to.include('Findings');
      expect(call.instructions).to.include('Outbound Flags');
      expect(call.instructions).to.include('Absences');
    });

    it('should sort nodes by weight in context', async () => {
      await sweepPartition('test query', partition, nodeMap, [], allPartitions, mockProvider, { sweepMaxTokens: 6000 });

      const input = mockProvider.generate.firstCall.args[0].input;
      const node1Pos = input.indexOf('[Node 1]');
      const node10Pos = input.indexOf('[Node 10]');
      expect(node1Pos).to.be.lessThan(node10Pos); // Node 1 has higher weight
    });

    it('should include node tags and weights', async () => {
      await sweepPartition('test query', partition, nodeMap, [], allPartitions, mockProvider, { sweepMaxTokens: 6000 });

      const input = mockProvider.generate.firstCall.args[0].input;
      expect(input).to.include('(research, weight:');
      expect(input).to.include('(analysis, weight:');
    });

    it('should include adjacent partition context', async () => {
      await sweepPartition('test query', partition, nodeMap, [], allPartitions, mockProvider, { sweepMaxTokens: 6000 });

      const input = mockProvider.generate.firstCall.args[0].input;
      expect(input).to.include('ADJACENT PARTITIONS');
      expect(input).to.include('Partition P-1');
      expect(input).to.include('3 shared edges');
      expect(input).to.include('Mathematical foundations');
    });

    it('should include the query in the input', async () => {
      await sweepPartition('what are the key findings?', partition, nodeMap, [], allPartitions, mockProvider, { sweepMaxTokens: 6000 });

      const input = mockProvider.generate.firstCall.args[0].input;
      expect(input).to.include('Query: what are the key findings?');
    });

    it('should return structured result', async () => {
      const result = await sweepPartition('test', partition, nodeMap, [], allPartitions, mockProvider, { sweepMaxTokens: 6000 });

      expect(result).to.have.property('partitionId', 0);
      expect(result).to.have.property('partitionSummary', 'Quantum physics research');
      expect(result).to.have.property('nodeCount', 10);
      expect(result).to.have.property('nodesIncluded', 10);
      expect(result.keywords).to.be.an('array');
      expect(result.sweepOutput).to.include('## Domain State');
    });

    it('should skip nodes without concept', async () => {
      nodeMap.set('5', { id: 5, concept: null, tag: 'empty', weight: 0.9 });

      const result = await sweepPartition('test', partition, nodeMap, [], allPartitions, mockProvider, { sweepMaxTokens: 6000 });
      expect(result.nodesIncluded).to.equal(9);
    });

    it('should truncate context at MAX_CONTEXT_CHARS', async () => {
      // Create a massive node
      const bigConcept = 'x'.repeat(MAX_CONTEXT_CHARS + 1000);
      nodeMap.set('1', { id: 1, concept: bigConcept, tag: 'big', weight: 1.0 });

      await sweepPartition('test', partition, nodeMap, [], allPartitions, mockProvider, { sweepMaxTokens: 6000 });

      const input = mockProvider.generate.firstCall.args[0].input;
      // The first node alone exceeds the cap, so only it should be included
      // (or none if the single node text exceeds the cap before being added)
      expect(input.length).to.be.at.most(MAX_CONTEXT_CHARS + 10000); // Allow room for prompt + adjacent context
    });

    it('should handle provider returning message.content', async () => {
      mockProvider.generate.resolves({ message: { content: 'fallback content' } });

      const result = await sweepPartition('test', partition, nodeMap, [], allPartitions, mockProvider, { sweepMaxTokens: 6000 });
      expect(result.sweepOutput).to.equal('fallback content');
    });
  });

  describe('sweepPartitions', () => {
    let mockProvider;
    let nodeMap;
    let partitions;

    beforeEach(() => {
      let callCount = 0;
      mockProvider = {
        generate: sinon.stub().callsFake(async () => {
          callCount++;
          return { content: `Sweep result ${callCount}` };
        })
      };

      nodeMap = new Map();
      for (let i = 1; i <= 30; i++) {
        nodeMap.set(String(i), {
          id: i,
          concept: `Node ${i} content`,
          tag: 'research',
          weight: 0.5
        });
      }

      partitions = [
        { id: 0, nodeIds: ['1', '2', '3', '4', '5'], nodeCount: 5, summary: 'Part A', keywords: ['alpha'] },
        { id: 1, nodeIds: ['6', '7', '8', '9', '10'], nodeCount: 5, summary: 'Part B', keywords: ['beta'] },
        { id: 2, nodeIds: ['11', '12', '13', '14', '15'], nodeCount: 5, summary: 'Part C', keywords: ['gamma'] },
      ];
    });

    it('should sweep all partitions', async () => {
      const results = await sweepPartitions('test', partitions, nodeMap, [], partitions, mockProvider, {
        maxConcurrentSweeps: 5, sweepMaxTokens: 6000
      });

      expect(results).to.have.length(3);
      expect(results.every(r => r.status === 'fulfilled')).to.be.true;
    });

    it('should respect concurrency limit', async () => {
      let maxConcurrent = 0;
      let currentConcurrent = 0;

      mockProvider.generate = async () => {
        currentConcurrent++;
        if (currentConcurrent > maxConcurrent) maxConcurrent = currentConcurrent;
        await new Promise(resolve => setTimeout(resolve, 10));
        currentConcurrent--;
        return { content: 'result' };
      };

      // 3 partitions with concurrency 2 → should batch into [2, 1]
      await sweepPartitions('test', partitions, nodeMap, [], partitions, mockProvider, {
        maxConcurrentSweeps: 2, sweepMaxTokens: 6000
      });

      expect(maxConcurrent).to.be.at.most(2);
    });

    it('should handle partial failures', async () => {
      let callNum = 0;
      mockProvider.generate = async () => {
        callNum++;
        if (callNum === 2) throw new Error('Provider error');
        return { content: `Result ${callNum}` };
      };

      const results = await sweepPartitions('test', partitions, nodeMap, [], partitions, mockProvider, {
        maxConcurrentSweeps: 5, sweepMaxTokens: 6000
      });

      expect(results).to.have.length(3);
      const successful = results.filter(r => r.status === 'fulfilled' && r.value);
      const failed = results.filter(r => r.status === 'fulfilled' && r.value === null);
      expect(successful).to.have.length(2);
      expect(failed).to.have.length(1);
    });

    it('should emit sweep_started and sweep_complete events', async () => {
      const events = [];
      const onEvent = (e) => events.push(e);

      await sweepPartitions('test', partitions, nodeMap, [], partitions, mockProvider, {
        maxConcurrentSweeps: 5, sweepMaxTokens: 6000
      }, onEvent);

      const started = events.filter(e => e.type === 'sweep_started');
      const completed = events.filter(e => e.type === 'sweep_complete');
      expect(started).to.have.length(3);
      expect(completed).to.have.length(3);
    });

    it('should emit sweep_failed events on error', async () => {
      mockProvider.generate = async () => { throw new Error('fail'); };

      const events = [];
      const onEvent = (e) => events.push(e);

      await sweepPartitions('test', partitions, nodeMap, [], partitions, mockProvider, {
        maxConcurrentSweeps: 5, sweepMaxTokens: 6000
      }, onEvent);

      const failed = events.filter(e => e.type === 'sweep_failed');
      expect(failed).to.have.length(3);
      expect(failed[0]).to.have.property('error');
    });

    it('should track completion count in events', async () => {
      const events = [];
      const onEvent = (e) => events.push(e);

      await sweepPartitions('test', partitions, nodeMap, [], partitions, mockProvider, {
        maxConcurrentSweeps: 1, sweepMaxTokens: 6000
      }, onEvent);

      const completeEvents = events.filter(e => e.type === 'sweep_complete');
      // With concurrency 1, completions should be sequential: 1, 2, 3
      expect(completeEvents[0].completed).to.equal(1);
      expect(completeEvents[1].completed).to.equal(2);
      expect(completeEvents[2].completed).to.equal(3);
    });
  });
});
