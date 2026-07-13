'use strict';

function errorPayload(error) {
  return {
    name: error?.name || 'Error',
    message: error?.message || String(error),
    code: error?.code || null,
  };
}

let index = null;

try {
  const indexPath = process.argv[2];
  const dimension = Number(process.argv[3]);
  const ef = Number(process.argv[4]);
  if (typeof indexPath !== 'string' || indexPath.length === 0
      || !Number.isSafeInteger(dimension) || dimension < 1
      || !Number.isSafeInteger(ef) || ef < 1) {
    throw new TypeError('ANN worker configuration is invalid');
  }
  const hnswlib = require('hnswlib-node');
  index = new hnswlib.HierarchicalNSW('cosine', dimension);
  index.readIndexSync(indexPath);
  index.setEf(ef);
  process.send?.({ type: 'ready' });
  process.on('message', (message) => {
    if (message?.type !== 'search') return;
    const { id, embedding, candidateLimit } = message;
    try {
      if (!Number.isSafeInteger(id) || id < 1
          || !Array.isArray(embedding) || embedding.length !== dimension
          || embedding.some((entry) => typeof entry !== 'number' || !Number.isFinite(entry))
          || !Number.isSafeInteger(candidateLimit) || candidateLimit < 1 || candidateLimit > 1000) {
        throw new TypeError('ANN worker search request is invalid');
      }
      const result = index.searchKnn(embedding, candidateLimit);
      process.send?.({
        type: 'result',
        id,
        neighbors: Array.isArray(result?.neighbors) ? result.neighbors : [],
        distances: Array.isArray(result?.distances) ? result.distances : [],
      });
    } catch (error) {
      process.send?.({ type: 'search-error', id, error: errorPayload(error) });
    }
  });
  process.on('disconnect', () => process.exit(0));
} catch (error) {
  process.send?.({ type: 'fatal', error: errorPayload(error) }, () => process.exit(1));
  if (!process.connected) process.exit(1);
}
