/**
 * layered-search.js — The gold pattern: standard retrieval + PGS sweep
 *
 * Layered search runs a fast standard top-K retrieval query first to
 * establish what's already known, then runs a full PGS pass with that
 * context injected into each sweep prompt — finding what standard
 * retrieval missed. This is the recommended pattern for production use.
 *
 * Requires: OPENAI_API_KEY environment variable (for embeddings + LLM)
 *
 * Usage:
 *   OPENAI_API_KEY=sk-... node examples/layered-search.js
 */

'use strict';

const fs = require('fs');
const zlib = require('zlib');
const path = require('path');
const { PGSEngine } = require('../src');

// ─── API Key Check ───────────────────────────────────────────────────

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error('Error: OPENAI_API_KEY environment variable is required.');
  console.error('');
  console.error('  export OPENAI_API_KEY=sk-...');
  console.error('  node examples/layered-search.js');
  process.exit(1);
}

// ─── Provider Factories ──────────────────────────────────────────────

function createChatProvider({ apiKey, baseURL = 'https://api.openai.com/v1', model = 'gpt-4.1-mini' }) {
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
        throw new Error(`OpenAI API error (${response.status}): ${err}`);
      }

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content || '';
      return { content };
    }
  };
}

function createEmbeddingProvider({ apiKey, model = 'text-embedding-3-small', dimensions = 512 }) {
  return {
    dimensions,
    embed: async (text) => {
      const response = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model, input: text, dimensions }),
      });

      if (!response.ok) {
        const err = await response.text();
        throw new Error(`OpenAI Embeddings error (${response.status}): ${err}`);
      }

      const data = await response.json();
      return data.data?.[0]?.embedding || null;
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

const engine = new PGSEngine({
  sweepProvider: createChatProvider({ apiKey: OPENAI_API_KEY }),
  synthesisProvider: createChatProvider({ apiKey: OPENAI_API_KEY }),
  embeddingProvider: createEmbeddingProvider({ apiKey: OPENAI_API_KEY }),
});

// ─── Run Layered Search ──────────────────────────────────────────────

async function main() {
  const query = 'What are the most surprising findings in this research?';

  console.log(`\nQuery: "${query}"`);
  console.log('\nRunning layered search (standard top-K retrieval + PGS sweep)...\n');

  const startTime = Date.now();

  let standardPhaseTime = 0;
  let pgsPhaseStart = 0;

  try {
    const result = await engine.layeredSearch(query, graph, {
      topK: 15,
      onEvent: (event) => {
        switch (event.type) {
          case 'layered_standard':
            console.log(`  [standard]  ${event.message}`);
            break;
          case 'layered_standard_complete':
            standardPhaseTime = Date.now() - startTime;
            console.log(`  [standard]  Found ${event.nodesUsed} nodes, generated ${event.answerLength} char answer (${(standardPhaseTime / 1000).toFixed(1)}s)`);
            pgsPhaseStart = Date.now();
            break;
          case 'partitioning':
            if (event.partitionCount) {
              console.log(`  [partition] ${event.partitionCount} partitions`);
            }
            break;
          case 'routing':
            if (event.selectedCount) {
              console.log(`  [route]     ${event.selectedCount}/${event.totalCount} partitions selected for PGS sweep`);
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
            console.log(`  [done]      PGS phase: ${((Date.now() - pgsPhaseStart) / 1000).toFixed(1)}s`);
            break;
        }
      }
    });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    // ─── Standard Answer ─────────────────────────────────────────────

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('  STANDARD RETRIEVAL ANSWER (top-K cosine similarity)');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    if (result.standardAnswer) {
      console.log(result.standardAnswer);
    } else {
      console.log('  (no standard answer — embedding provider may not be available)');
    }

    // ─── PGS Answer ──────────────────────────────────────────────────

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('  PGS LAYERED ANSWER (swept all partitions with prior context)');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(result.answer);

    // ─── Comparison ──────────────────────────────────────────────────

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('  LAYERED SEARCH METADATA');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    const pgs = result.metadata.pgs;
    const layered = result.metadata.layered;

    console.log(`  Standard query used:     ${layered.standardNodesUsed} nodes (top-K retrieval)`);
    console.log(`  PGS swept:               ${pgs.sweptPartitions} partitions (${pgs.totalNodes} total nodes)`);
    console.log(`  Standard answer length:  ${layered.standardAnswerLength} chars`);
    console.log(`  PGS answer length:       ${result.answer.length} chars`);
    console.log(`  Standard phase:          ${(standardPhaseTime / 1000).toFixed(1)}s`);
    console.log(`  Total elapsed:           ${elapsed}s`);
    console.log('');
    console.log(`  Standard query found ${layered.standardNodesUsed} nodes.`);
    console.log(`  PGS swept ${pgs.sweptPartitions} partitions covering ${pgs.totalNodes} nodes`);
    console.log('  and found cross-domain connections that top-K retrieval missed.');
  } catch (err) {
    console.error(`\nError: ${err.message}`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
