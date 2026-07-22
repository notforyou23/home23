const { expect } = require('chai');

// Reproduces the 2026-07-22 Phase 1 live-proof failure: Home23's PM2 commonEnv
// leaks its own engine embedding profile (EMBEDDING_MODEL=nomic-embed-text,
// EMBEDDING_PROVIDER=ollama-local, EMBEDDING_BASE_URL=...11434/v1) into the
// cosmo23 server, whose engine subprocess inherited it. The env model then
// overrode the run config's text-embedding-3-small while the client stayed
// pointed at api.openai.com — every embed call 404'd and the run persisted a
// 0-node brain while reporting success.
describe('NetworkMemory embedding routing', () => {
  let NetworkMemory;
  const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  const ENV_KEYS = [
    'EMBEDDING_MODEL',
    'EMBEDDING_PROVIDER',
    'EMBEDDING_BASE_URL',
    'EMBEDDING_API_KEY',
    'EMBEDDING_DIMENSIONS',
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
  ];
  let savedEnv;

  before(() => {
    ({ NetworkMemory } = require('../../src/memory/network-memory'));
  });

  beforeEach(() => {
    savedEnv = {};
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  function leakHome23Env() {
    process.env.EMBEDDING_MODEL = 'nomic-embed-text';
    process.env.EMBEDDING_PROVIDER = 'ollama-local';
    process.env.EMBEDDING_BASE_URL = 'http://127.0.0.1:11434/v1';
    process.env.EMBEDDING_API_KEY = 'ollama';
    process.env.EMBEDDING_DIMENSIONS = '768';
  }

  function captureClient(capture) {
    return {
      embeddings: {
        create: async (params) => {
          capture.push(params);
          return { data: [{ index: 0, embedding: new Array(4).fill(0.1) }] };
        },
      },
    };
  }

  describe('run config beats ambient env', () => {
    it('sends the run-configured model and dimensions even when Home23 env vars leak in', async () => {
      leakHome23Env();
      const captured = [];
      const memory = new NetworkMemory(
        { embedding: { model: 'text-embedding-3-small', dimensions: 1536 } },
        logger,
        null,
        { getEmbeddingClient: () => captureClient(captured) },
      );

      const embedding = await memory.embed('hello world');

      expect(embedding).to.be.an('array');
      expect(captured).to.have.length(1);
      expect(captured[0].model).to.equal('text-embedding-3-small');
      expect(captured[0].dimensions).to.equal(1536);
      expect(captured[0].encoding_format).to.equal('float');
    });

    it('routes config-specified embeddings to the OpenAI endpoint, not the leaked EMBEDDING_BASE_URL', () => {
      leakHome23Env();
      process.env.OPENAI_API_KEY = 'sk-test-dummy';
      delete process.env.OPENAI_BASE_URL;
      const memory = new NetworkMemory(
        { embedding: { model: 'text-embedding-3-small', dimensions: 1536 } },
        logger,
      );

      const routing = memory.resolveEmbeddingRouting();

      expect(routing.source).to.equal('config');
      expect(routing.model).to.equal('text-embedding-3-small');
      expect(String(routing.client.baseURL)).to.include('api.openai.com');
    });
  });

  describe('coherent env fallback when the run config has no embedding block', () => {
    it('uses the env model AND the env base URL together', () => {
      leakHome23Env();
      const memory = new NetworkMemory({}, logger);

      const routing = memory.resolveEmbeddingRouting();

      expect(routing.source).to.equal('env');
      expect(routing.model).to.equal('nomic-embed-text');
      expect(String(routing.client.baseURL)).to.include('127.0.0.1:11434');
    });

    it('omits OpenAI-only params on the ollama endpoint', async () => {
      leakHome23Env();
      const captured = [];
      const memory = new NetworkMemory({}, logger, null, {
        getEmbeddingClient: () => captureClient(captured),
      });

      await memory.embed('hello world');

      expect(captured[0].model).to.equal('nomic-embed-text');
      expect(captured[0]).to.not.have.property('dimensions');
      expect(captured[0]).to.not.have.property('encoding_format');
    });
  });

  describe('embedding failure cascade (fail loud)', () => {
    function failingClient() {
      return {
        embeddings: {
          create: async () => {
            const err = new Error('404 The model `nomic-embed-text` does not exist or you do not have access to it');
            err.status = 404;
            throw err;
          },
        },
      };
    }

    it('throws EMBEDDING_FAILURE_CASCADE after maxConsecutiveFailures consecutive failures', async () => {
      const memory = new NetworkMemory(
        { embedding: { model: 'text-embedding-3-small', dimensions: 512, maxConsecutiveFailures: 3 } },
        logger,
        null,
        { getEmbeddingClient: failingClient },
      );

      expect(await memory.embed('one')).to.equal(null);
      expect(await memory.embed('two')).to.equal(null);

      let thrown = null;
      try {
        await memory.embed('three');
      } catch (error) {
        thrown = error;
      }
      expect(thrown, 'third consecutive failure should throw').to.be.an('error');
      expect(thrown.code).to.equal('EMBEDDING_FAILURE_CASCADE');
      expect(thrown.message).to.include('nomic-embed-text');
    });

    it('resets the failure counter after a success', async () => {
      let fail = true;
      const client = {
        embeddings: {
          create: async () => {
            if (fail) throw new Error('transient outage');
            return { data: [{ index: 0, embedding: new Array(4).fill(0.1) }] };
          },
        },
      };
      const memory = new NetworkMemory(
        { embedding: { model: 'text-embedding-3-small', dimensions: 512, maxConsecutiveFailures: 3 } },
        logger,
        null,
        { getEmbeddingClient: () => client },
      );

      expect(await memory.embed('one')).to.equal(null);
      expect(await memory.embed('two')).to.equal(null);
      fail = false;
      expect(await memory.embed('recovers')).to.be.an('array');
      fail = true;
      expect(await memory.embed('four')).to.equal(null);
      expect(await memory.embed('five')).to.equal(null);
    });

    it('propagates the cascade error through addNode instead of silently dropping nodes', async () => {
      const memory = new NetworkMemory(
        { embedding: { model: 'text-embedding-3-small', dimensions: 512, maxConsecutiveFailures: 1 } },
        logger,
        null,
        { getEmbeddingClient: failingClient },
      );

      let thrown = null;
      try {
        await memory.addNode(
          'Cosine similarity between embedding vectors measures semantic relatedness across the knowledge graph, enabling cluster formation.',
          'insight',
        );
      } catch (error) {
        thrown = error;
      }
      expect(thrown, 'addNode should propagate the cascade error').to.be.an('error');
      expect(thrown.code).to.equal('EMBEDDING_FAILURE_CASCADE');
    });
  });
});
