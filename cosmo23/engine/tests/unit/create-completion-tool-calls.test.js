/**
 * Tests for createCompletion tool call normalization across ALL providers.
 *
 * createCompletion is the bridge between the agentic loop (execution agents, IDE agent)
 * and the LLM providers. It must correctly normalize tool calls from every provider
 * format into OpenAI Chat Completions format that the agentic loop expects.
 *
 * Provider return formats:
 *   Anthropic client:   response.output = [{ type: 'function', id, function: { name, arguments } }]
 *   OpenAI Responses:   response.output = [{ type: 'function_call', call_id, name, arguments }]
 *   Ollama Cloud/xAI:   response.output = [{ type: 'function_call', call_id, name, arguments }]
 *   Anthropic native:   response.output = [{ type: 'tool_use', id, name, input: {...} }]
 *   Fallback:           response.tool_calls = [{ id, type: 'function', function: { name, arguments } }]
 *
 * Expected output (OpenAI Chat Completions format):
 *   { choices: [{ message: { role: 'assistant', content, tool_calls: [
 *     { id, type: 'function', function: { name, arguments: 'json string' } }
 *   ] } }] }
 */

/* eslint-disable mocha/no-top-level-hooks */
const { expect } = require('chai');
const sinon = require('sinon');

// Suppress global leak detection for debug/node-client globals
before(function () { this.timeout(5000); });

// Minimal config for UnifiedClient
const config = {
  models: { primary: 'test-model' },
  architecture: { memory: { embedding: { model: 'text-embedding-3-small', dimensions: 512 } } }
};
const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

describe('createCompletion — tool call normalization across providers', () => {
  let UnifiedClient, client;

  before(() => {
    ({ UnifiedClient } = require('../../src/core/unified-client'));
  });

  beforeEach(() => {
    client = new UnifiedClient(config, logger);
  });

  afterEach(() => {
    sinon.restore();
  });

  // Helper: stub generate() to return a specific response shape
  function stubGenerate(response) {
    sinon.stub(client, 'generate').resolves(response);
  }

  // Helper: standard tool for tests
  const testTools = [{
    type: 'function',
    function: {
      name: 'execute_bash',
      description: 'Run a shell command',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command' }
        },
        required: ['command']
      }
    }
  }];

  const testMessages = [
    { role: 'system', content: 'You are an execution agent.' },
    { role: 'user', content: 'Install playwright' }
  ];

  // ════════════════════════════════════════════════════════════════
  // Anthropic client format: { type: 'function', function: { name, arguments } }
  // This is the format AnthropicClient.generate() actually returns
  // ════════════════════════════════════════════════════════════════

  describe('Anthropic client format (type: "function")', () => {
    it('should extract tool calls with type "function" from response.output', async () => {
      stubGenerate({
        content: null,
        output: [{
          type: 'function',
          id: 'toolu_01abc',
          function: {
            name: 'execute_bash',
            arguments: '{"command":"npm install playwright"}'
          }
        }]
      });

      const result = await client.createCompletion({ messages: testMessages, tools: testTools });

      expect(result.choices[0].message.tool_calls).to.have.length(1);
      expect(result.choices[0].message.tool_calls[0]).to.deep.include({
        id: 'toolu_01abc',
        type: 'function',
        function: {
          name: 'execute_bash',
          arguments: '{"command":"npm install playwright"}'
        }
      });
    });

    it('should handle multiple Anthropic tool calls', async () => {
      stubGenerate({
        content: 'Let me install dependencies.',
        output: [
          {
            type: 'function',
            id: 'toolu_01',
            function: { name: 'execute_bash', arguments: '{"command":"pip install requests"}' }
          },
          {
            type: 'function',
            id: 'toolu_02',
            function: { name: 'execute_bash', arguments: '{"command":"pip install beautifulsoup4"}' }
          }
        ]
      });

      const result = await client.createCompletion({ messages: testMessages, tools: testTools });

      expect(result.choices[0].message.tool_calls).to.have.length(2);
      expect(result.choices[0].message.tool_calls[0].function.name).to.equal('execute_bash');
      expect(result.choices[0].message.tool_calls[1].function.name).to.equal('execute_bash');
      expect(result.choices[0].message.tool_calls[0].id).to.equal('toolu_01');
      expect(result.choices[0].message.tool_calls[1].id).to.equal('toolu_02');
      expect(result.choices[0].message.content).to.equal('Let me install dependencies.');
    });
  });

  // ════════════════════════════════════════════════════════════════
  // OpenAI Responses API format: { type: 'function_call', call_id, name, arguments }
  // Also used by Ollama Cloud and xAI via ChatCompletionsClient
  // ════════════════════════════════════════════════════════════════

  describe('OpenAI Responses API format (type: "function_call")', () => {
    it('should extract tool calls with type "function_call" from response.output', async () => {
      stubGenerate({
        content: null,
        output: [{
          type: 'function_call',
          call_id: 'call_abc123',
          name: 'execute_bash',
          arguments: '{"command":"curl https://example.com"}'
        }]
      });

      const result = await client.createCompletion({ messages: testMessages, tools: testTools });

      expect(result.choices[0].message.tool_calls).to.have.length(1);
      expect(result.choices[0].message.tool_calls[0].id).to.equal('call_abc123');
      expect(result.choices[0].message.tool_calls[0].function.name).to.equal('execute_bash');
      expect(result.choices[0].message.tool_calls[0].function.arguments).to.equal('{"command":"curl https://example.com"}');
    });

    it('should handle Ollama Cloud / xAI tool calls (same format)', async () => {
      stubGenerate({
        content: 'Running command.',
        output: [{
          type: 'function_call',
          call_id: 'ollama_call_1',
          name: 'execute_python',
          arguments: '{"script":"print(42)"}'
        }]
      });

      const result = await client.createCompletion({ messages: testMessages, tools: testTools });

      expect(result.choices[0].message.tool_calls).to.have.length(1);
      expect(result.choices[0].message.tool_calls[0].id).to.equal('ollama_call_1');
      expect(result.choices[0].message.tool_calls[0].function.name).to.equal('execute_python');
    });
  });

  // ════════════════════════════════════════════════════════════════
  // Anthropic native format: { type: 'tool_use', id, name, input }
  // In case tool calls arrive without pre-conversion
  // ════════════════════════════════════════════════════════════════

  describe('Anthropic native format (type: "tool_use")', () => {
    it('should extract tool calls with type "tool_use" from response.output', async () => {
      stubGenerate({
        content: null,
        output: [{
          type: 'tool_use',
          id: 'toolu_native_01',
          name: 'write_file',
          input: { path: '/tmp/test.txt', content: 'hello' }
        }]
      });

      const result = await client.createCompletion({ messages: testMessages, tools: testTools });

      expect(result.choices[0].message.tool_calls).to.have.length(1);
      expect(result.choices[0].message.tool_calls[0].id).to.equal('toolu_native_01');
      expect(result.choices[0].message.tool_calls[0].function.name).to.equal('write_file');
      // input (object) should be stringified
      const args = JSON.parse(result.choices[0].message.tool_calls[0].function.arguments);
      expect(args.path).to.equal('/tmp/test.txt');
      expect(args.content).to.equal('hello');
    });
  });

  // ════════════════════════════════════════════════════════════════
  // Fallback: response.tool_calls (some providers)
  // ════════════════════════════════════════════════════════════════

  describe('Fallback: response.tool_calls array', () => {
    it('should use response.tool_calls when response.output has no tool calls', async () => {
      stubGenerate({
        content: null,
        output: [],  // empty output
        tool_calls: [{
          id: 'tc_fallback_1',
          type: 'function',
          function: { name: 'execute_bash', arguments: '{"command":"ls"}' }
        }]
      });

      const result = await client.createCompletion({ messages: testMessages, tools: testTools });

      expect(result.choices[0].message.tool_calls).to.have.length(1);
      expect(result.choices[0].message.tool_calls[0].id).to.equal('tc_fallback_1');
      expect(result.choices[0].message.tool_calls[0].function.name).to.equal('execute_bash');
    });

    it('should prefer response.output over response.tool_calls when both have data', async () => {
      stubGenerate({
        content: null,
        output: [{
          type: 'function',
          id: 'from_output',
          function: { name: 'execute_bash', arguments: '{"command":"from output"}' }
        }],
        tool_calls: [{
          id: 'from_tool_calls',
          type: 'function',
          function: { name: 'execute_bash', arguments: '{"command":"from tool_calls"}' }
        }]
      });

      const result = await client.createCompletion({ messages: testMessages, tools: testTools });

      expect(result.choices[0].message.tool_calls).to.have.length(1);
      expect(result.choices[0].message.tool_calls[0].id).to.equal('from_output');
    });
  });

  // ════════════════════════════════════════════════════════════════
  // No tool calls — clean exit
  // ════════════════════════════════════════════════════════════════

  describe('No tool calls (text-only response)', () => {
    it('should return message without tool_calls when LLM returns text only', async () => {
      stubGenerate({
        content: 'Task completed successfully.',
        output: null
      });

      const result = await client.createCompletion({ messages: testMessages, tools: testTools });

      expect(result.choices[0].message.content).to.equal('Task completed successfully.');
      expect(result.choices[0].message.tool_calls).to.be.undefined;
      expect(result.choices[0].finish_reason).to.equal('stop');
    });

    it('should set finish_reason to "tool_calls" when tool calls present', async () => {
      stubGenerate({
        content: null,
        output: [{
          type: 'function_call',
          call_id: 'call_1',
          name: 'execute_bash',
          arguments: '{"command":"echo hi"}'
        }]
      });

      const result = await client.createCompletion({ messages: testMessages, tools: testTools });
      expect(result.choices[0].finish_reason).to.equal('tool_calls');
    });
  });

  // ════════════════════════════════════════════════════════════════
  // Edge cases
  // ════════════════════════════════════════════════════════════════

  describe('Edge cases', () => {
    it('should generate an ID when tool call has no id or call_id', async () => {
      stubGenerate({
        content: null,
        output: [{
          type: 'function_call',
          name: 'execute_bash',
          arguments: '{"command":"echo test"}'
        }]
      });

      const result = await client.createCompletion({ messages: testMessages, tools: testTools });

      expect(result.choices[0].message.tool_calls[0].id).to.be.a('string');
      expect(result.choices[0].message.tool_calls[0].id).to.match(/^call_/);
    });

    it('should stringify object arguments', async () => {
      stubGenerate({
        content: null,
        output: [{
          type: 'function_call',
          call_id: 'call_obj',
          name: 'execute_bash',
          arguments: { command: 'echo hello' }  // object, not string
        }]
      });

      const result = await client.createCompletion({ messages: testMessages, tools: testTools });

      expect(result.choices[0].message.tool_calls[0].function.arguments).to.be.a('string');
      const parsed = JSON.parse(result.choices[0].message.tool_calls[0].function.arguments);
      expect(parsed.command).to.equal('echo hello');
    });

    it('should handle mixed tool call types in single response.output', async () => {
      stubGenerate({
        content: null,
        output: [
          { type: 'function', id: 'anth_1', function: { name: 'execute_bash', arguments: '{"command":"a"}' } },
          { type: 'function_call', call_id: 'oai_1', name: 'write_file', arguments: '{"path":"b"}' },
          { type: 'tool_use', id: 'native_1', name: 'read_file', input: { path: 'c' } }
        ]
      });

      const result = await client.createCompletion({ messages: testMessages, tools: testTools });

      expect(result.choices[0].message.tool_calls).to.have.length(3);
      expect(result.choices[0].message.tool_calls[0].function.name).to.equal('execute_bash');
      expect(result.choices[0].message.tool_calls[1].function.name).to.equal('write_file');
      expect(result.choices[0].message.tool_calls[2].function.name).to.equal('read_file');
    });

    it('should filter non-tool items from response.output', async () => {
      stubGenerate({
        content: 'Some text',
        output: [
          { type: 'text', text: 'ignore me' },
          { type: 'function', id: 'tc1', function: { name: 'execute_bash', arguments: '{"command":"ls"}' } },
          { type: 'web_search_results', data: [] }
        ]
      });

      const result = await client.createCompletion({ messages: testMessages, tools: testTools });

      expect(result.choices[0].message.tool_calls).to.have.length(1);
      expect(result.choices[0].message.tool_calls[0].function.name).to.equal('execute_bash');
    });
  });

  // ════════════════════════════════════════════════════════════════
  // Multi-turn agentic loop — the exact pattern execution agents use
  // This tests the FULL cycle: LLM returns tool calls → execute →
  // send results back → LLM continues. This is where the
  // "no corresponding tool_use block" error occurred.
  // ════════════════════════════════════════════════════════════════

  describe('Multi-turn agentic loop (tool results sent back)', () => {
    it('should produce messages that work on the second iteration', async () => {
      // Iteration 1: LLM returns tool calls
      sinon.stub(client, 'generate')
        .onFirstCall().resolves({
          content: null,
          output: [{
            type: 'function',
            id: 'toolu_01abc',
            function: {
              name: 'execute_bash',
              arguments: '{"command":"curl https://example.com"}'
            }
          }]
        })
        .onSecondCall().resolves({
          content: 'Done. I fetched the page successfully.',
          output: null
        });

      // Simulate agentic loop iteration 1
      const messages = [
        { role: 'system', content: 'You are an agent.' },
        { role: 'user', content: 'Fetch example.com' }
      ];

      const result1 = await client.createCompletion({ messages, tools: testTools });

      // Push assistant message (with tool_calls) to messages
      const assistantMsg = result1.choices[0].message;
      expect(assistantMsg.tool_calls).to.have.length(1);
      expect(assistantMsg.tool_calls[0].id).to.equal('toolu_01abc');

      messages.push(assistantMsg);

      // Push tool result
      messages.push({
        role: 'tool',
        tool_call_id: 'toolu_01abc',
        content: '<html>Example page</html>'
      });

      // Iteration 2: send conversation with tool results back
      // This must NOT throw "no corresponding tool_use block"
      const result2 = await client.createCompletion({
        messages: messages.filter(m => m.role !== 'system'),
        tools: testTools
      });

      expect(result2.choices[0].message.content).to.equal('Done. I fetched the page successfully.');
      expect(result2.choices[0].finish_reason).to.equal('stop');
    });

    it('second iteration messages include tool_calls in assistant message', async () => {
      // Verify that the messages passed to generate() on iteration 2
      // include the assistant message WITH tool_calls intact
      const generateStub = sinon.stub(client, 'generate');
      generateStub.onFirstCall().resolves({
        content: null,
        output: [{
          type: 'function',
          id: 'toolu_iter2',
          function: { name: 'execute_bash', arguments: '{"command":"ls"}' }
        }]
      });
      generateStub.onSecondCall().resolves({ content: 'Listed files.', output: null });

      const messages = [
        { role: 'user', content: 'List files' }
      ];

      const r1 = await client.createCompletion({ messages, tools: testTools });
      messages.push(r1.choices[0].message);
      messages.push({ role: 'tool', tool_call_id: 'toolu_iter2', content: 'file1.txt\nfile2.txt' });

      await client.createCompletion({ messages, tools: testTools });

      // Check what was passed to generate() on the second call
      const secondCallArgs = generateStub.secondCall.args[0];

      // The messages passed should include the assistant message with tool_calls
      const assistantInConv = secondCallArgs.messages.find(
        m => m.role === 'assistant' && m.tool_calls
      );
      expect(assistantInConv).to.exist;
      expect(assistantInConv.tool_calls[0].id).to.equal('toolu_iter2');
      expect(assistantInConv.tool_calls[0].function.name).to.equal('execute_bash');

      // And the tool result
      const toolResultInConv = secondCallArgs.messages.find(m => m.role === 'tool');
      expect(toolResultInConv).to.exist;
      expect(toolResultInConv.tool_call_id).to.equal('toolu_iter2');
    });
  });

  // ════════════════════════════════════════════════════════════════
  // Full 10-iteration agentic loop simulation
  // Tests the COMPLETE lifecycle that an execution agent goes through:
  // install tool → check → write script → execute → read output →
  // write file → verify → etc. Each iteration the messages array
  // grows with assistant+tool_calls and tool results.
  // ════════════════════════════════════════════════════════════════

  describe('Full 10-iteration agentic loop (Anthropic format)', () => {
    it('should survive 10 iterations of tool calls and results', async () => {
      const generateStub = sinon.stub(client, 'generate');

      // Set up 9 iterations with tool calls + 1 final text-only response
      for (let i = 0; i < 9; i++) {
        generateStub.onCall(i).resolves({
          content: i < 8 ? null : 'Almost done.',
          output: [{
            type: 'function',
            id: `toolu_iter${i}`,
            function: {
              name: i % 2 === 0 ? 'execute_bash' : 'write_file',
              arguments: i % 2 === 0
                ? `{"command":"step ${i}"}`
                : `{"path":"/tmp/file${i}.txt","content":"data ${i}"}`
            }
          }]
        });
      }
      // Final iteration: no tool calls, just conclusion
      generateStub.onCall(9).resolves({
        content: 'All 9 steps completed successfully. Files written and verified.',
        output: null
      });

      // Simulate the agentic loop
      const messages = [
        { role: 'user', content: 'Execute the full pipeline' }
      ];

      for (let iter = 0; iter < 10; iter++) {
        const result = await client.createCompletion({
          messages,
          tools: testTools
        });

        const msg = result.choices[0].message;
        messages.push(msg);

        if (!msg.tool_calls || msg.tool_calls.length === 0) {
          // Loop should end on iteration 10 (index 9)
          expect(iter).to.equal(9);
          expect(msg.content).to.include('9 steps completed');
          break;
        }

        // Verify tool call structure on every iteration
        expect(msg.tool_calls[0].id).to.equal(`toolu_iter${iter}`);
        expect(msg.tool_calls[0].type).to.equal('function');
        expect(msg.tool_calls[0].function.name).to.be.a('string');
        expect(msg.tool_calls[0].function.arguments).to.be.a('string');

        // Push tool result
        messages.push({
          role: 'tool',
          tool_call_id: msg.tool_calls[0].id,
          content: `Result of step ${iter}: success`
        });
      }

      // Verify generate was called 10 times
      expect(generateStub.callCount).to.equal(10);

      // Verify the final call's messages contain ALL prior turns
      const finalCallMessages = generateStub.getCall(9).args[0].messages;
      // Should have: user + 9*(assistant+tool) + final assistant = user + 18 conversation msgs
      // (system is stripped by createCompletion)
      expect(finalCallMessages.length).to.equal(19); // 1 user + 9 assistant + 9 tool

      // Verify every assistant message in the chain has tool_calls
      const assistantMsgs = finalCallMessages.filter(m => m.role === 'assistant' && m.tool_calls);
      expect(assistantMsgs).to.have.length(9);

      // Verify every tool result has a matching tool_call_id
      const toolMsgs = finalCallMessages.filter(m => m.role === 'tool');
      expect(toolMsgs).to.have.length(9);
      for (let i = 0; i < 9; i++) {
        expect(toolMsgs[i].tool_call_id).to.equal(`toolu_iter${i}`);
      }
    });

    it('should handle multiple tool calls per iteration over 5 turns', async () => {
      const generateStub = sinon.stub(client, 'generate');

      // Each iteration returns 3 parallel tool calls
      for (let i = 0; i < 4; i++) {
        generateStub.onCall(i).resolves({
          content: null,
          output: [
            { type: 'function', id: `tc_${i}_a`, function: { name: 'execute_bash', arguments: `{"command":"cmd_${i}_a"}` } },
            { type: 'function', id: `tc_${i}_b`, function: { name: 'write_file', arguments: `{"path":"f_${i}","content":"d"}` } },
            { type: 'function', id: `tc_${i}_c`, function: { name: 'read_file', arguments: `{"path":"r_${i}"}` } }
          ]
        });
      }
      generateStub.onCall(4).resolves({ content: 'Pipeline complete.', output: null });

      const messages = [{ role: 'user', content: 'Run parallel pipeline' }];

      for (let iter = 0; iter < 5; iter++) {
        const result = await client.createCompletion({ messages, tools: testTools });
        const msg = result.choices[0].message;
        messages.push(msg);

        if (!msg.tool_calls) break;

        expect(msg.tool_calls).to.have.length(3);

        // Push results for all 3 tool calls
        for (const tc of msg.tool_calls) {
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: `result for ${tc.function.name}`
          });
        }
      }

      expect(generateStub.callCount).to.equal(5);

      // Final call should have 1 user + 4*(1 assistant + 3 tool) = 17 messages
      const finalMsgs = generateStub.getCall(4).args[0].messages;
      expect(finalMsgs).to.have.length(17);
    });

    it('should work with OpenAI function_call format over multiple turns', async () => {
      const generateStub = sinon.stub(client, 'generate');

      for (let i = 0; i < 3; i++) {
        generateStub.onCall(i).resolves({
          content: null,
          output: [{
            type: 'function_call',
            call_id: `oai_call_${i}`,
            name: 'execute_bash',
            arguments: `{"command":"openai step ${i}"}`
          }]
        });
      }
      generateStub.onCall(3).resolves({ content: 'OpenAI pipeline done.', output: null });

      const messages = [{ role: 'user', content: 'Run with OpenAI' }];

      for (let iter = 0; iter < 4; iter++) {
        const result = await client.createCompletion({ messages, tools: testTools });
        const msg = result.choices[0].message;
        messages.push(msg);
        if (!msg.tool_calls) break;
        messages.push({ role: 'tool', tool_call_id: msg.tool_calls[0].id, content: `ok ${iter}` });
      }

      expect(generateStub.callCount).to.equal(4);
      const finalMsgs = generateStub.getCall(3).args[0].messages;
      const assistants = finalMsgs.filter(m => m.role === 'assistant' && m.tool_calls);
      expect(assistants).to.have.length(3);
    });
  });
});
