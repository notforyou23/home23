/**
 * novelty-finder.js — PGS full sweep for novelty and absence detection
 *
 * Asks PGS specifically to find the most novel, unexpected, or
 * counterintuitive findings in the research — and to report what
 * important topics are completely absent. Uses fullSweep: true to
 * examine every partition, ensuring nothing is missed.
 *
 * This is where PGS shines over standard RAG: standard retrieval
 * returns what's most similar to the query, but novelty and absences
 * are by definition dissimilar — they live in the partitions that
 * cosine similarity would rank lowest.
 *
 * Requires: OPENAI_API_KEY environment variable
 *
 * Usage:
 *   OPENAI_API_KEY=sk-... node examples/novelty-finder.js
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
  console.error('  node examples/novelty-finder.js');
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

// ─── Run Novelty Query ───────────────────────────────────────────────

async function main() {
  const query = 'What is the most novel, unexpected, or counterintuitive finding in this research? What important topics are completely absent?';

  console.log(`\nQuery: "${query}"`);
  console.log('\nRunning full sweep (all partitions, no routing shortcuts)...');
  console.log('This examines every corner of the knowledge graph for novelty and gaps.\n');

  const startTime = Date.now();
  let sweptCount = 0;
  let totalPartitions = 0;

  try {
    const result = await engine.execute(query, graph, {
      fullSweep: true,  // Bypass routing — sweep every partition
      onEvent: (event) => {
        switch (event.type) {
          case 'partitioning':
            if (event.partitionCount) {
              totalPartitions = event.partitionCount;
              console.log(`  [partition] ${event.partitionCount} partitions to sweep (full coverage)`);
            }
            break;
          case 'routing':
            if (event.selectedCount) {
              console.log(`  [route]     ${event.selectedCount}/${event.totalCount} partitions (full sweep — all selected)`);
            }
            break;
          case 'sweeping':
            console.log(`  [sweep]     ${event.message}`);
            break;
          case 'sweep_complete':
            sweptCount++;
            console.log(`  [sweep]     Partition ${event.partitionId} complete (${sweptCount}/${totalPartitions})`);
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
    console.log('  NOVELTY & ABSENCE ANALYSIS');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(result.answer);

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('  COVERAGE STATS');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    const pgs = result.metadata.pgs;
    console.log(`  Total nodes:         ${pgs.totalNodes}`);
    console.log(`  Total edges:         ${pgs.totalEdges}`);
    console.log(`  Total partitions:    ${pgs.totalPartitions}`);
    console.log(`  Swept partitions:    ${pgs.sweptPartitions} (${((pgs.sweptPartitions / pgs.totalPartitions) * 100).toFixed(0)}% coverage)`);
    console.log(`  Successful sweeps:   ${pgs.successfulSweeps}`);
    console.log(`  Elapsed:             ${elapsed}s`);
    console.log('');
    console.log('  Full sweep ensures novelty detection examines every partition,');
    console.log('  including those that cosine similarity would have ranked lowest.');
    console.log('  Absences are reported per-partition during sweep and aggregated');
    console.log('  during synthesis for a complete gap analysis.');
  } catch (err) {
    console.error(`\nError: ${err.message}`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
