'use strict';

const { expect } = require('chai');
const { cosineSimilarity, routeQuery } = require('../src/router');

describe('router', () => {

  // ─── cosineSimilarity ──────────────────────────────────────────────

  describe('cosineSimilarity', () => {

    it('should return 1.0 for identical vectors', () => {
      expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).to.equal(1.0);
    });

    it('should return 0.0 for orthogonal vectors', () => {
      expect(cosineSimilarity([1, 0], [0, 1])).to.equal(0.0);
    });

    it('should return correct value for known vectors', () => {
      // [1,2,3] · [4,5,6] = 32, |a| = sqrt(14), |b| = sqrt(77)
      const result = cosineSimilarity([1, 2, 3], [4, 5, 6]);
      const expected = 32 / Math.sqrt(14 * 77);
      expect(result).to.be.closeTo(expected, 1e-10);
    });

    it('should return -1.0 for opposite vectors', () => {
      expect(cosineSimilarity([1, -1], [-1, 1])).to.be.closeTo(-1.0, 1e-10);
    });

    it('should return 0 for null input', () => {
      expect(cosineSimilarity(null, [1, 2])).to.equal(0);
    });

    it('should return 0 for empty arrays', () => {
      expect(cosineSimilarity([], [])).to.equal(0);
    });

    it('should return 0 for length mismatch', () => {
      expect(cosineSimilarity([1, 2], [1, 2, 3])).to.equal(0);
    });

    it('should return 0 for zero vector', () => {
      expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).to.equal(0);
    });

  });

  // ─── routeQuery ────────────────────────────────────────────────────

  describe('routeQuery', () => {

    function makePartition(id, centroid) {
      return { id, centroidEmbedding: centroid };
    }

    const defaultConfig = {
      maxSweepPartitions: 10,
      minSweepPartitions: 0,
      partitionRelevanceThreshold: 0.25
    };

    it('should return all partitions up to max when no embedding provided', () => {
      const partitions = [
        makePartition('a', [1, 0]),
        makePartition('b', [0, 1]),
        makePartition('c', [1, 1])
      ];
      const result = routeQuery('test query', null, partitions, defaultConfig);
      expect(result).to.have.lengthOf(3);
    });

    it('should filter by threshold — only return close partitions', () => {
      // Query embedding points strongly in dimension 0
      const queryEmbedding = [1, 0, 0, 0, 0];

      const partitions = [
        makePartition('close1', [0.9, 0.1, 0, 0, 0]),   // high similarity
        makePartition('close2', [0.8, 0.2, 0, 0, 0]),   // high similarity
        makePartition('far1',   [0, 0, 1, 0, 0]),       // orthogonal
        makePartition('far2',   [0, 0, 0, 1, 0]),       // orthogonal
        makePartition('far3',   [0, 0, 0, 0, 1])        // orthogonal
      ];

      const result = routeQuery('specific topic', queryEmbedding, partitions, defaultConfig);
      expect(result).to.have.lengthOf(2);
      expect(result.map(p => p.id)).to.include('close1');
      expect(result.map(p => p.id)).to.include('close2');
    });

    it('should return all partitions for broad queries regardless of similarity', () => {
      const queryEmbedding = [1, 0, 0];
      const partitions = [
        makePartition('a', [1, 0, 0]),
        makePartition('b', [0, 1, 0]),
        makePartition('c', [0, 0, 1])
      ];
      const result = routeQuery(
        'comprehensive overview of everything',
        queryEmbedding,
        partitions,
        defaultConfig
      );
      expect(result).to.have.lengthOf(3);
    });

    it('should cap results at maxSweepPartitions', () => {
      const queryEmbedding = [1, 0];
      // 20 partitions all similar to query
      const partitions = Array.from({ length: 20 }, (_, i) =>
        makePartition(`p${i}`, [1, 0.01 * i])
      );
      const config = { ...defaultConfig, maxSweepPartitions: 5 };
      const result = routeQuery('test', queryEmbedding, partitions, config);
      expect(result).to.have.lengthOf(5);
    });

    it('should enforce minSweepPartitions floor', () => {
      // Query embedding in dimension 0; only 1 partition close
      const queryEmbedding = [1, 0, 0];
      const partitions = [
        makePartition('close', [0.9, 0.1, 0]),
        makePartition('far1',  [0, 1, 0]),
        makePartition('far2',  [0, 0, 1]),
        makePartition('far3',  [0.1, 0.9, 0.1])
      ];
      const config = { ...defaultConfig, minSweepPartitions: 3 };
      const result = routeQuery('specific query', queryEmbedding, partitions, config);
      expect(result).to.have.lengthOf.at.least(3);
    });

    it('should return partitions sorted by similarity descending', () => {
      const queryEmbedding = [1, 0, 0];
      const partitions = [
        makePartition('low',  [0.3, 0.9, 0]),
        makePartition('high', [1, 0, 0]),
        makePartition('mid',  [0.7, 0.3, 0])
      ];
      const config = { ...defaultConfig, partitionRelevanceThreshold: 0.0 };
      const result = routeQuery('test', queryEmbedding, partitions, config);
      for (let i = 1; i < result.length; i++) {
        expect(result[i - 1].similarity).to.be.at.least(result[i].similarity);
      }
    });

    it('should assign similarity 0 to partitions without centroidEmbedding', () => {
      const queryEmbedding = [1, 0, 0];
      const partitions = [
        makePartition('has', [1, 0, 0]),
        { id: 'none' }  // no centroidEmbedding
      ];
      const config = { ...defaultConfig, partitionRelevanceThreshold: 0.0 };
      const result = routeQuery('test', queryEmbedding, partitions, config);
      const noCentroid = result.find(p => p.id === 'none');
      expect(noCentroid.similarity).to.equal(0);
    });

  });

});
