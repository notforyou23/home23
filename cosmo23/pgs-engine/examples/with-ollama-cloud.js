/**
 * with-ollama-cloud.js — PGS Engine with Ollama Cloud
 *
 * Uses Ollama Cloud's OpenAI-compatible API at https://ollama.com/v1
 * for sweep and synthesis. Default model: nemotron-3-super (COSMO's
 * default for Ollama Cloud). Zero npm dependencies.
 *
 * Requires: OLLAMA_CLOUD_API_KEY environment variable
 *
 * Usage:
 *   OLLAMA_CLOUD_API_KEY=... node examples/with-ollama-cloud.js
 */

'use strict';

const fs = require('fs');
const zlib = require('zlib');
const path = require('path');
const { PGSEngine } = require('../src');

// ─── API Key Check ───────────────────────────────────────────────────

const OLLAMA_CLOUD_API_KEY = process.env.OLLAMA_CLOUD_API_KEY;
if (!OLLAMA_CLOUD_API_KEY) {
  console.error('Error: OLLAMA_CLOUD_API_KEY environment variable is required.');
  console.error('');
  console.error('  export OLLAMA_CLOUD_API_KEY=...');
  console.error('  node examples/with-ollama-cloud.js');
  process.exit(1);
}

// ─── OpenAI-Compatible Provider ──────────────────────────────────────

/**
 * Create an OpenAI-compatible LLM provider using fetch().
 * Works with any API that follows the OpenAI chat completions format.
 *
 * @param {object} options
 * @param {string} options.apiKey - API key
 * @param {string} options.baseURL - API base URL
 * @param {string} options.model - Model name
 * @returns {{generate: Function}}
 */
function createChatProvider({ apiKey, baseURL, model }) {
  return {
    generate: async ({ instructions, input, maxTokens = 4096, onChunk }) => {
      const response = await fetch(`${baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: instructions },
            { role: 'user', content: input },
          ],
          max_tokens: maxTokens,
        }),
      });

      if (!response.ok) {
        const err = await response.text();
        throw new Error(`Ollama Cloud API error (${response.status}): ${err}`);
      }

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content || '';
      return { content };
    }
  };
}

// ─── Load Brain ──────────────────────────────────────────────────────

console.log('Loading physics2 brain...');
const gz = fs.readFileSync(path.join(__dirname, 'data', 'physics2.json.gz'));
const data = JSON.parse(zlib.gunzipSync(gz).toString());
const graph = { nodes: data.nodes, edges: data.edges };

console.log(`Brain: ${data.metadata?.name || 'physics2'}`);
console.log(`Nodes: ${graph.nodes.length}, Edges: ${graph.edges.length}`);

// ─── Create Engine ───────────────────────────────────────────────────

const provider = createChatProvider({
  apiKey: OLLAMA_CLOUD_API_KEY,
  baseURL: 'https://ollama.com/v1',
  model: 'nemotron-3-super',
});

const engine = new PGSEngine({
  sweepProvider: provider,
  synthesisProvider: provider,
  // No embeddingProvider — routing degrades to keyword-based
});

// ─── Run Query ───────────────────────────────────────────────────────

async function main() {
  const query = 'What are the most surprising findings in this research?';

  console.log(`\nQuery: "${query}"\n`);

  const startTime = Date.now();

  try {
    const result = await engine.execute(query, graph, {
      onEvent: (event) => {
        switch (event.type) {
          case 'partitioning':
            if (event.partitionCount) {
              console.log(`  [partition] ${event.partitionCount} partitions`);
            }
            break;
          case 'routing':
            if (event.selectedCount) {
              console.log(`  [route]     ${event.selectedCount}/${event.totalCount} partitions selected`);
            }
            break;
          case 'sweeping':
            console.log(`  [sweep]     ${event.message}`);
            break;
          case 'sweep_complete':
            console.log(`  [sweep]     Partition ${event.partitionId} complete`);
            break;
          case 'synthesizing':
            console.log(`  [synth]     ${event.message}`);
            break;
          case 'complete':
            console.log(`  [done]      ${(event.elapsedMs / 1000).toFixed(1)}s`);
            break;
        }
      }
    });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('  ANSWER');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(result.answer);

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('  PGS METADATA');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    const pgs = result.metadata.pgs;
    console.log(`  Nodes:              ${pgs.totalNodes}`);
    console.log(`  Edges:              ${pgs.totalEdges}`);
    console.log(`  Total partitions:   ${pgs.totalPartitions}`);
    console.log(`  Swept partitions:   ${pgs.sweptPartitions}`);
    console.log(`  Successful sweeps:  ${pgs.successfulSweeps}`);
    console.log(`  PGS elapsed:        ${pgs.elapsed}`);
    console.log(`  Total elapsed:      ${elapsed}s`);
  } catch (err) {
    console.error(`\nError: ${err.message}`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
