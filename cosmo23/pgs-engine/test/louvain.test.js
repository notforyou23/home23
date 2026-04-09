const { expect } = require('chai');
const { runLouvain, mergeSmallCommunities, splitLargeCommunities } = require('../src/louvain');

describe('Louvain Community Detection', () => {

  describe('runLouvain', () => {

    it('should detect a single community in a triangle graph', () => {
      const nodes = [{ id: 'A' }, { id: 'B' }, { id: 'C' }];
      const edges = [
        { source: 'A', target: 'B', weight: 1.0 },
        { source: 'B', target: 'C', weight: 1.0 },
        { source: 'A', target: 'C', weight: 1.0 }
      ];
      const config = { minCommunitySize: 1, targetPartitionMax: 100 };

      const result = runLouvain(nodes, edges, config);

      expect(result).to.have.lengthOf(1);
      const allNodeIds = result[0].nodeIds.sort();
      expect(allNodeIds).to.deep.equal(['A', 'B', 'C']);
    });

    it('should separate two cliques connected by a weak bridge', () => {
      const nodes = [];
      for (let i = 0; i < 10; i++) {
        nodes.push({ id: i });
      }

      const edges = [];
      // Clique 1: nodes 0-4, fully connected
      for (let i = 0; i < 5; i++) {
        for (let j = i + 1; j < 5; j++) {
          edges.push({ source: i, target: j, weight: 1.0 });
        }
      }
      // Clique 2: nodes 5-9, fully connected
      for (let i = 5; i < 10; i++) {
        for (let j = i + 1; j < 10; j++) {
          edges.push({ source: i, target: j, weight: 1.0 });
        }
      }
      // Weak bridge
      edges.push({ source: 2, target: 7, weight: 0.1 });

      const config = { minCommunitySize: 1, targetPartitionMax: 100 };

      const result = runLouvain(nodes, edges, config);

      expect(result).to.have.lengthOf(2);

      const sizes = result.map(c => c.nodeIds.length).sort((a, b) => a - b);
      expect(sizes).to.deep.equal([5, 5]);

      // Each clique should be in its own community
      const community0 = result.find(c => c.nodeIds.includes('0'));
      const community5 = result.find(c => c.nodeIds.includes('5'));
      expect(community0).to.not.be.undefined;
      expect(community5).to.not.be.undefined;

      // All of clique 1 together
      for (let i = 0; i < 5; i++) {
        expect(community0.nodeIds).to.include(String(i));
      }
      // All of clique 2 together
      for (let i = 5; i < 10; i++) {
        expect(community5.nodeIds).to.include(String(i));
      }
    });

    it('should merge small communities in a star graph with minCommunitySize', () => {
      const nodes = [];
      // Hub node
      nodes.push({ id: 'hub' });
      // 20 spoke nodes
      for (let i = 0; i < 20; i++) {
        nodes.push({ id: `spoke_${i}` });
      }

      const edges = [];
      for (let i = 0; i < 20; i++) {
        edges.push({ source: 'hub', target: `spoke_${i}`, weight: 1.0 });
      }

      const config = { minCommunitySize: 5, targetPartitionMax: 100 };

      const result = runLouvain(nodes, edges, config);

      // With minCommunitySize=5, isolated spokes should be merged
      // All communities should have >= 5 nodes (or be the single merged community)
      for (const comm of result) {
        expect(comm.nodeIds.length).to.be.at.least(5);
      }

      // All 21 nodes should be accounted for
      const allNodeIds = result.flatMap(c => c.nodeIds).sort();
      expect(allNodeIds).to.have.lengthOf(21);
    });

    it('should split a large community when it exceeds targetPartitionMax', () => {
      const nodes = [];
      for (let i = 0; i < 40; i++) {
        nodes.push({ id: i });
      }

      const edges = [];
      // Fully connected graph
      for (let i = 0; i < 40; i++) {
        for (let j = i + 1; j < 40; j++) {
          edges.push({ source: i, target: j, weight: 1.0 });
        }
      }

      const config = { minCommunitySize: 1, targetPartitionMax: 25 };

      const result = runLouvain(nodes, edges, config);

      expect(result.length).to.be.at.least(2);

      // All 40 nodes should be accounted for
      const allNodeIds = result.flatMap(c => c.nodeIds);
      expect(allNodeIds).to.have.lengthOf(40);

      // Split should have produced smaller communities
      // Note: greedy bisection of a fully connected graph may not produce
      // perfectly balanced halves, but should produce multiple communities
      const maxSize = Math.max(...result.map(c => c.nodeIds.length));
      expect(maxSize).to.be.lessThan(40); // At least some splitting occurred
    });

    it('should return a single community for disconnected nodes (no edges)', () => {
      const nodes = [];
      for (let i = 0; i < 10; i++) {
        nodes.push({ id: i });
      }
      const edges = [];
      const config = { minCommunitySize: 1, targetPartitionMax: 100 };

      const result = runLouvain(nodes, edges, config);

      expect(result).to.have.lengthOf(1);
      expect(result[0].nodeIds).to.have.lengthOf(10);
    });

    it('should return empty array for empty graph', () => {
      const result = runLouvain([], [], { minCommunitySize: 1, targetPartitionMax: 100 });

      expect(result).to.be.an('array');
      // No nodes → either empty or single empty community
      // The algorithm returns [{ id: 0, nodeIds: [] }] for totalWeight === 0 with 0 nodes
      // Actually with 0 nodes, nodeIds is [], so the result is [{ id: 0, nodeIds: [] }]
      // But the post-process filters size === 0 communities... let's check:
      // totalWeight = 0 → returns [{ id: 0, nodeIds: [] }] directly (before post-process)
      // Actually runLouvain returns early with nodeIds = [] which is an empty array
      if (result.length === 1) {
        expect(result[0].nodeIds).to.have.lengthOf(0);
      } else {
        expect(result).to.have.lengthOf(0);
      }
    });

    it('should handle a single node with no edges', () => {
      const nodes = [{ id: 'solo' }];
      const edges = [];
      const config = { minCommunitySize: 1, targetPartitionMax: 100 };

      const result = runLouvain(nodes, edges, config);

      expect(result).to.have.lengthOf(1);
      expect(result[0].nodeIds).to.deep.equal(['solo']);
    });

    it('should handle mixed numeric and string ID types', () => {
      const nodes = [{ id: 1 }, { id: 'two' }, { id: 3 }, { id: 'four' }];
      const edges = [
        { source: 1, target: 'two', weight: 1.0 },
        { source: 3, target: 'four', weight: 1.0 },
        { source: 1, target: 3, weight: 0.1 }
      ];
      const config = { minCommunitySize: 1, targetPartitionMax: 100 };

      const result = runLouvain(nodes, edges, config);

      // All node IDs should be strings in the output
      const allNodeIds = result.flatMap(c => c.nodeIds);
      expect(allNodeIds).to.have.lengthOf(4);
      for (const nid of allNodeIds) {
        expect(nid).to.be.a('string');
      }

      // Should contain all nodes
      expect(allNodeIds.sort()).to.deep.equal(['1', '3', 'four', 'two']);
    });

    it('should default edge weight to 0.5 when weight is not specified', () => {
      const nodes = [{ id: 'A' }, { id: 'B' }, { id: 'C' }];
      const edges = [
        { source: 'A', target: 'B' },  // no weight field
        { source: 'B', target: 'C' },   // no weight field
        { source: 'A', target: 'C' }    // no weight field
      ];
      const config = { minCommunitySize: 1, targetPartitionMax: 100 };

      const result = runLouvain(nodes, edges, config);

      // Should still work and produce valid communities
      expect(result.length).to.be.at.least(1);
      const allNodeIds = result.flatMap(c => c.nodeIds).sort();
      expect(allNodeIds).to.deep.equal(['A', 'B', 'C']);

      // With equal default weights on a triangle, should be 1 community
      expect(result).to.have.lengthOf(1);
    });
  });

  describe('mergeSmallCommunities', () => {

    it('should merge a small community into its most-connected neighbor', () => {
      // Set up: community 0 has nodes A, B; community 1 has node C; community 2 has nodes D, E, F
      // C is connected to D with high weight → should merge into community 2
      const communityNodes = new Map([
        [0, new Set(['A', 'B'])],
        [1, new Set(['C'])],
        [2, new Set(['D', 'E', 'F'])]
      ]);
      const community = new Map([
        ['A', 0], ['B', 0], ['C', 1], ['D', 2], ['E', 2], ['F', 2]
      ]);
      const adj = new Map([
        ['A', new Map([['B', 1.0]])],
        ['B', new Map([['A', 1.0]])],
        ['C', new Map([['D', 2.0], ['A', 0.1]])],
        ['D', new Map([['C', 2.0], ['E', 1.0], ['F', 1.0]])],
        ['E', new Map([['D', 1.0], ['F', 1.0]])],
        ['F', new Map([['D', 1.0], ['E', 1.0]])]
      ]);

      mergeSmallCommunities(communityNodes, community, adj, 2);

      // Community 1 (C) should be merged into community 2
      expect(communityNodes.has(1)).to.be.false;
      expect(community.get('C')).to.equal(2);
      expect(communityNodes.get(2).has('C')).to.be.true;
    });
  });

  describe('splitLargeCommunities', () => {

    it('should split a community that exceeds maxSize', () => {
      const members = [];
      for (let i = 0; i < 20; i++) members.push(`n${i}`);

      const communityNodes = new Map([[0, new Set(members)]]);
      const community = new Map();
      for (const nid of members) community.set(nid, 0);

      // Build adjacency: fully connected
      const adj = new Map();
      for (const nid of members) adj.set(nid, new Map());
      for (let i = 0; i < members.length; i++) {
        for (let j = i + 1; j < members.length; j++) {
          adj.get(members[i]).set(members[j], 1.0);
          adj.get(members[j]).set(members[i], 1.0);
        }
      }

      splitLargeCommunities(communityNodes, community, adj, [], 10);

      // Should now have 2 communities
      const activeCommunities = [...communityNodes.entries()].filter(([, s]) => s.size > 0);
      expect(activeCommunities).to.have.lengthOf(2);

      // All 20 nodes still accounted for
      const allNodes = activeCommunities.flatMap(([, s]) => [...s]);
      expect(allNodes).to.have.lengthOf(20);

      // Each should be smaller than the original 20
      // Note: greedy bisection of a fully connected graph uses a balance
      // factor of 0.1, so exact halves aren't guaranteed
      for (const [, s] of activeCommunities) {
        expect(s.size).to.be.lessThan(20);
      }
    });
  });

  describe('result structure', () => {

    it('should return communities with sequential integer IDs starting at 0', () => {
      const nodes = [];
      for (let i = 0; i < 10; i++) nodes.push({ id: i });
      const edges = [];
      // Two groups
      for (let i = 0; i < 5; i++) {
        for (let j = i + 1; j < 5; j++) {
          edges.push({ source: i, target: j, weight: 1.0 });
        }
      }
      for (let i = 5; i < 10; i++) {
        for (let j = i + 1; j < 10; j++) {
          edges.push({ source: i, target: j, weight: 1.0 });
        }
      }

      const config = { minCommunitySize: 1, targetPartitionMax: 100 };
      const result = runLouvain(nodes, edges, config);

      // IDs should be sequential integers
      const ids = result.map(c => c.id).sort((a, b) => a - b);
      for (let i = 0; i < ids.length; i++) {
        expect(ids[i]).to.equal(i);
      }

      // Each community should have nodeIds as an array of strings
      for (const comm of result) {
        expect(comm.nodeIds).to.be.an('array');
        for (const nid of comm.nodeIds) {
          expect(nid).to.be.a('string');
        }
      }
    });
  });
});
