const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

const { handleFunctionCalling } = require('../../evobrew/server/ai-handler.js');
const { LocalAgentAdapter } = require('../../evobrew/server/providers/adapters/local-agent.js');

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((err) => err ? reject(err) : resolve());
  });
}

test('LocalAgentAdapter includes chatId and structured context in bridge requests', async () => {
  let capturedBody = null;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      capturedBody = JSON.parse(raw);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
      });
      res.end('data: {"type":"text","text":"ok"}\n\ndata: [DONE]\n\n');
    });
  });

  const port = await listen(server);
  try {
    const adapter = new LocalAgentAdapter({
      id: 'local:jerry',
      name: 'Jerry',
      url: `http://127.0.0.1:${port}`,
      endpoint: '/api/chat',
    });

    const chunks = [];
    for await (const chunk of adapter.streamMessage({
      model: 'jerry',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      chatId: 'evobrew:jerry:abc123',
      context: {
        source: 'evobrew',
        currentFolder: '/tmp/project',
        fileName: 'src/app.ts',
      },
    })) {
      chunks.push(chunk);
    }

    assert.equal(chunks[0]?.text, 'ok');
    assert.equal(capturedBody.chatId, 'evobrew:jerry:abc123');
    assert.deepEqual(capturedBody.context, {
      source: 'evobrew',
      currentFolder: '/tmp/project',
      fileName: 'src/app.ts',
    });
  } finally {
    await close(server);
  }
});

test('handleFunctionCalling scopes local-agent history to the Evobrew workspace and passes context', async () => {
  let capturedRequest = null;
  const fakeProvider = {
    id: 'local:jerry',
    name: 'Jerry',
    getPerformanceHints: () => ({
      maxConcurrentTools: 10,
      maxToolsPerIteration: 15,
      pollingInterval: 500,
      reducedParallelism: false,
      conservativeTokens: false,
      maxOutputTokens: 64000,
    }),
    filterToolsByCapability: () => [],
    streamMessage: async function* (request) {
      capturedRequest = request;
      yield { type: 'text', text: 'done' };
      yield { type: 'done' };
    },
  };

  const registry = {
    resolveModelSelection: async () => ({
      resolvedModel: 'jerry',
      resolvedSelection: 'local:jerry',
      providerId: 'local:jerry',
      provider: fakeProvider,
    }),
    getProvider: () => fakeProvider,
    getProviderById: () => fakeProvider,
  };

  const result = await handleFunctionCalling(null, null, null, {}, {
    message: 'What are you looking at?',
    currentFolder: '/tmp/evobrew-project',
    model: 'local:jerry',
    fileName: 'src/index.ts',
    language: 'typescript',
    selectedText: 'export const answer = 42;',
    fileTreeContext: 'src/index.ts\nsrc/routes.ts',
    conversationSummary: 'The user asked about routing.',
    conversationHistory: [
      { role: 'user', content: 'Earlier question' },
      { role: 'assistant', content: 'Earlier answer' },
    ],
    workspaceId: 'workspace-a',
    brainPath: '/brains/JerryG-fork-jtr',
    allowedToolNames: [],
  }, () => {}, { registry });

  assert.equal(result.success, true);
  assert.equal(result.response, 'done');
  assert.ok(capturedRequest.chatId.startsWith('evobrew:jerry:'), capturedRequest.chatId);
  assert.notEqual(capturedRequest.chatId, 'evobrew:jerry');
  assert.equal(capturedRequest.context.source, 'evobrew');
  assert.equal(capturedRequest.context.currentFolder, '/tmp/evobrew-project');
  assert.equal(capturedRequest.context.fileName, 'src/index.ts');
  assert.equal(capturedRequest.context.language, 'typescript');
  assert.equal(capturedRequest.context.selectedText, 'export const answer = 42;');
  assert.equal(capturedRequest.context.fileTreeContext, 'src/index.ts\nsrc/routes.ts');
  assert.equal(capturedRequest.context.conversationSummary, 'The user asked about routing.');
  assert.equal(capturedRequest.context.brain.path, '/brains/JerryG-fork-jtr');
});
