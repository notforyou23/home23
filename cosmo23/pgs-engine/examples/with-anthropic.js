/**
 * with-anthropic.js — PGS Engine with Anthropic Claude
 *
 * Uses Anthropic's Messages API for sweep and synthesis. Note that
 * Anthropic does not provide an embedding API, so query routing
 * degrades to keyword-based matching (all partitions scored by text
 * overlap rather than cosine similarity). Zero npm dependencies.
 *
 * Requires: ANTHROPIC_API_KEY environment variable
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-... node examples/with-anthropic.js
 */

'use strict';

const fs = require('fs');
const zlib = require('zlib');
const path = require('path');
const { PGSEngine } = require('../src');

// ─── API Key Check ───────────────────────────────────────────────────

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  console.error('Error: ANTHROPIC_API_KEY environment variable is required.');
  console.error('');
  console.error('  export ANTHROPIC_API_KEY=sk-ant-...');
  console.error('  node examples/with-anthropic.js');
  process.exit(1);
}

// ─── Anthropic Provider ──────────────────────────────────────────────

/**
 * Create an Anthropic Claude LLM provider using fetch().
 *
 * @param {object} options
 * @param {string} options.apiKey - Anthropic API key
 * @param {string} [options.model='claude-sonnet-4-20250514'] - Model name
 * @returns {{generate: Function}}
 */
function createAnthropicProvider({ apiKey, model = 'claude-sonnet-4-20250514' }) {
  return {
    generate: async ({ instructions, input, maxTokens = 4096, onChunk }) => {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          system: instructions,
          messages: [
            { role: 'user', content: input },
          ],
        }),
      });

      if (!response.ok) {
        const err = await response.text();
        throw new Error(`Anthropic API error (${response.status}): ${err}`);
      }

      const data = await response.json();
      const content = data.content?.[0]?.text || '';
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
console.log('');
console.log('Note: Anthropic does not provide an embedding API.');
console.log('Query routing will use keyword matching instead of cosine similarity.');

// ─── Create Engine ───────────────────────────────────────────────────

const provider = createAnthropicProvider({
  apiKey: ANTHROPIC_API_KEY,
});

// Use same provider for both sweep and synthesis
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
              console.log(`  [route]     ${event.selectedCount}/${event.totalCount} partitions (keyword-based, no embeddings)`);
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
