const { expect } = require('chai');
const sinon = require('sinon');
const { synthesize, buildSynthesisPrompt } = require('../src/synthesizer');

describe('Synthesizer', () => {
  describe('buildSynthesisPrompt', () => {
    it('should include all four synthesis tasks', () => {
      const prompt = buildSynthesisPrompt(5);
      expect(prompt).to.include('Cross-Domain Connection Discovery');
      expect(prompt).to.include('Absence Detection');
      expect(prompt).to.include('Convergence Identification');
      expect(prompt).to.include('Thesis Formation');
    });

    it('should include sweep count', () => {
      const prompt = buildSynthesisPrompt(7);
      expect(prompt).to.include('7 partitions');
    });

    it('should instruct to cite partition and node IDs', () => {
      const prompt = buildSynthesisPrompt(3);
      expect(prompt).to.include('partition IDs');
      expect(prompt).to.include('node IDs');
    });

    it('should emphasize thesis over literature review', () => {
      const prompt = buildSynthesisPrompt(3);
      expect(prompt).to.include('thesis');
      expect(prompt).to.include('not a literature review');
    });
  });

  describe('synthesize', () => {
    let mockProvider;
    let sweepResults;

    beforeEach(() => {
      mockProvider = {
        generate: sinon.stub().resolves({
          content: '# Synthesis\n\nCross-domain analysis reveals...'
        })
      };

      sweepResults = [
        {
          partitionId: 0,
          partitionSummary: 'Quantum mechanics',
          nodeCount: 100,
          nodesIncluded: 95,
          keywords: ['quantum', 'mechanics', 'wave'],
          sweepOutput: '## Domain State\nQuantum partition.\n\n## Findings\nKey finding [Node 1].\n\n## Outbound Flags\nRelates to P-1.\n\n## Absences\nNo data on gravity.'
        },
        {
          partitionId: 1,
          partitionSummary: 'General relativity',
          nodeCount: 80,
          nodesIncluded: 78,
          keywords: ['gravity', 'relativity', 'spacetime'],
          sweepOutput: '## Domain State\nRelativity partition.\n\n## Findings\nGravitational waves [Node 50].\n\n## Outbound Flags\nConnects to P-0.\n\n## Absences\nNo quantum effects found.'
        }
      ];
    });

    it('should call provider with correct structure', async () => {
      const config = { synthesisMaxTokens: 16000 };
      const context = { totalNodes: 586, totalEdges: 1931, totalPartitions: 5, selectedPartitions: 2 };

      await synthesize('test query', sweepResults, mockProvider, context, config);

      expect(mockProvider.generate.calledOnce).to.be.true;
      const call = mockProvider.generate.firstCall.args[0];
      expect(call).to.have.property('instructions');
      expect(call).to.have.property('input');
      expect(call).to.have.property('maxTokens', 16000);
      expect(call).to.have.property('reasoningEffort', 'high');
    });

    it('should include all sweep outputs in context', async () => {
      const config = { synthesisMaxTokens: 16000 };
      const context = { totalNodes: 100, totalEdges: 200, totalPartitions: 2, selectedPartitions: 2 };

      await synthesize('test', sweepResults, mockProvider, context, config);

      const input = mockProvider.generate.firstCall.args[0].input;
      expect(input).to.include('Partition P-0: Quantum mechanics');
      expect(input).to.include('Partition P-1: General relativity');
      expect(input).to.include('Key finding [Node 1]');
      expect(input).to.include('Gravitational waves [Node 50]');
    });

    it('should include graph statistics in context', async () => {
      const config = { synthesisMaxTokens: 16000 };
      const context = { totalNodes: 586, totalEdges: 1931, totalPartitions: 5, selectedPartitions: 2 };

      await synthesize('test', sweepResults, mockProvider, context, config);

      const input = mockProvider.generate.firstCall.args[0].input;
      expect(input).to.include('586');
      expect(input).to.include('1,931');
      expect(input).to.include('5 partitions');
    });

    it('should include the original query', async () => {
      const config = { synthesisMaxTokens: 16000 };
      const context = { totalNodes: 100, totalEdges: 200, totalPartitions: 2, selectedPartitions: 2 };

      await synthesize('what are the surprising findings?', sweepResults, mockProvider, context, config);

      const input = mockProvider.generate.firstCall.args[0].input;
      expect(input).to.include('Original Query: what are the surprising findings?');
    });

    it('should include keywords for each partition', async () => {
      const config = { synthesisMaxTokens: 16000 };
      const context = { totalNodes: 100, totalEdges: 200, totalPartitions: 2, selectedPartitions: 2 };

      await synthesize('test', sweepResults, mockProvider, context, config);

      const input = mockProvider.generate.firstCall.args[0].input;
      expect(input).to.include('quantum, mechanics, wave');
      expect(input).to.include('gravity, relativity, spacetime');
    });

    it('should pass onChunk to provider for streaming', async () => {
      const onChunk = sinon.stub();
      const config = { synthesisMaxTokens: 16000 };
      const context = { totalNodes: 100, totalEdges: 200, totalPartitions: 2, selectedPartitions: 2, onChunk };

      await synthesize('test', sweepResults, mockProvider, context, config);

      const call = mockProvider.generate.firstCall.args[0];
      expect(call.onChunk).to.equal(onChunk);
    });

    it('should return the response content', async () => {
      const config = { synthesisMaxTokens: 16000 };
      const context = { totalNodes: 100, totalEdges: 200, totalPartitions: 2, selectedPartitions: 2 };

      const result = await synthesize('test', sweepResults, mockProvider, context, config);
      expect(result).to.equal('# Synthesis\n\nCross-domain analysis reveals...');
    });

    it('should handle message.content fallback', async () => {
      mockProvider.generate.resolves({ message: { content: 'fallback synthesis' } });

      const config = { synthesisMaxTokens: 16000 };
      const context = { totalNodes: 100, totalEdges: 200, totalPartitions: 2, selectedPartitions: 2 };

      const result = await synthesize('test', sweepResults, mockProvider, context, config);
      expect(result).to.equal('fallback synthesis');
    });

    it('should handle empty response gracefully', async () => {
      mockProvider.generate.resolves({});

      const config = { synthesisMaxTokens: 16000 };
      const context = { totalNodes: 100, totalEdges: 200, totalPartitions: 2, selectedPartitions: 2 };

      const result = await synthesize('test', sweepResults, mockProvider, context, config);
      expect(result).to.equal('');
    });

    it('should include node counts per partition', async () => {
      const config = { synthesisMaxTokens: 16000 };
      const context = { totalNodes: 100, totalEdges: 200, totalPartitions: 2, selectedPartitions: 2 };

      await synthesize('test', sweepResults, mockProvider, context, config);

      const input = mockProvider.generate.firstCall.args[0].input;
      expect(input).to.include('95 nodes analyzed');
      expect(input).to.include('78 nodes analyzed');
    });
  });
});
