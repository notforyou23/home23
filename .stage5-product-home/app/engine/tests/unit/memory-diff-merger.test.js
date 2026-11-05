const { expect } = require('chai');

const { MemoryDiffMerger } = require('../../src/cluster/memory-merger');

const logger = {
  info() {},
  warn() {},
  error() {},
  debug() {}
};

describe('MemoryDiffMerger', () => {
  it('prefers newer version vectors when merging node updates', () => {
    const merger = new MemoryDiffMerger(logger);

    const diffA = {
      diff_id: 'diffA',
      timestamp: 1000,
      fields: {
        'memory.node.1': {
          op: 'set',
          value: { id: 1, concept: 'Concept A' },
          versionVector: { instA: 1 },
          timestamp: 1000
        }
      }
    };

    const diffB = {
      diff_id: 'diffB',
      timestamp: 2000,
      fields: {
        'memory.node.1': {
          op: 'set',
          value: { id: 1, concept: 'Concept B' },
          versionVector: { instB: 2 },
          timestamp: 2000
        }
      }
    };

    merger.applyDiff(diffA, 'instA');
    merger.applyDiff(diffB, 'instB');

    const merged = merger.build(7);
    expect(merged.memory.sets.nodes).to.have.lengthOf(1);
    expect(merged.memory.sets.nodes[0].concept).to.equal('Concept B');
  });

  it('resolves delete vs set conflicts deterministically', () => {
    const merger = new MemoryDiffMerger(logger);

    const diffSet = {
      diff_id: 'diffSet',
      timestamp: 3000,
      fields: {
        'memory.edge.1->2': {
          op: 'set',
          value: {
            source: 1,
            target: 2,
            weight: 0.5,
            type: 'associative',
            created: new Date().toISOString(),
            accessed: new Date().toISOString()
          },
          versionVector: { instC: 3 },
          timestamp: 3000
        }
      }
    };

    const diffDelete = {
      diff_id: 'diffDelete',
      timestamp: 4000,
      fields: {
        'memory.edge.1->2': {
          op: 'delete',
          versionVector: { instD: 4 },
          timestamp: 4000
        }
      }
    };

    merger.applyDiff(diffSet, 'instC');
    merger.applyDiff(diffDelete, 'instD');

    const merged = merger.build(8);
    expect(merged.memory.deletes.edgeKeys).to.include('1->2');
    expect(merged.memory.sets.edges).to.be.empty;
  });
});
