#!/usr/bin/env node

/**
 * PGS Benchmark Comparison
 *
 * Runs the same query against the physics2 brain using three approaches:
 *   1. Standard — Top-K retrieval + single LLM call
 *   2. Full PGS — Partition → route → sweep all → synthesize
 *   3. Layered — Standard query → PGS pass with prior context
 *
 * Captures: input size, timing, coverage, and full response text.
 * Writes results to benchmark/results/ and analysis to benchmark/COMPARISON.md
 *
 * Requires: OPENAI_API_KEY environment variable
 */

'use strict';

const fs = require('fs');
const zlib = require('zlib');
const path = require('path');
const { PGSEngine, cosineSimilarity } = require('../src');

// ─── Configuration ────────────────────────────────────────────────────

const QUERY = 'What are the most surprising or counterintuitive findings in this research, and what important questions remain unanswered?';
const TOP_K = 20;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SWEEP_MODEL = 'gpt-4o-mini';
const SYNTHESIS_MODEL = 'gpt-4o';
const EMBEDDING_MODEL = 'text-embedding-3-small';

if (!OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY is required for benchmark comparison.');
  console.error('Usage: OPENAI_API_KEY=sk-... node benchmark/run-comparison.js');
  process.exit(1);
}

// ─── Provider Factories ───────────────────────────────────────────────

function makeOpenAIProvider(model) {
  return {
    generate: async ({ instructions, input, maxTokens, reasoningEffort, onChunk }) => {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OPENAI_API_KEY}`
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: instructions },
            { role: 'user', content: input }
          ],
          max_completion_tokens: maxTokens,
          temperature: 0.7
        })
      });

      if (!response.ok) {
        const err = await response.text();
        throw new Error(`OpenAI API error (${response.status}): ${err}`);
      }

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content || '';
      if (onChunk) onChunk(content);
      return {
        content,
        usage: data.usage
      };
    }
  };
}

function makeEmbeddingProvider() {
  return {
    embed: async (text) => {
      const response = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OPENAI_API_KEY}`
        },
        body: JSON.stringify({
          model: EMBEDDING_MODEL,
          input: text.substring(0, 8000),
          dimensions: 512
        })
      });

      if (!response.ok) {
        throw new Error(`Embedding API error: ${response.status}`);
      }

      const data = await response.json();
      return data.data?.[0]?.embedding || null;
    },
    dimensions: 512
  };
}

// ─── Load Brain ───────────────────────────────────────────────────────

function loadBrain() {
  const brainPath = path.join(__dirname, '..', 'examples', 'data', 'physics2.json.gz');
  const gz = fs.readFileSync(brainPath);
  const data = JSON.parse(zlib.gunzipSync(gz).toString());
  return { nodes: data.nodes, edges: data.edges, metadata: data.metadata };
}

// ─── Approach 1: Standard Query ───────────────────────────────────────

async function runStandard(graph, queryEmbedding) {
  console.log('\n--- APPROACH 1: Standard Top-K Retrieval ---\n');
  const start = Date.now();

  // Score all nodes by cosine similarity
  const scored = graph.nodes
    .filter(n => n.embedding && Array.isArray(n.embedding))
    .map(n => ({
      ...n,
      similarity: cosineSimilarity(queryEmbedding, n.embedding)
    }))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, TOP_K);

  const retrievalTime = Date.now() - start;
  console.log(`  Retrieved top ${scored.length} nodes in ${retrievalTime}ms`);

  // Build context
  const context = scored
    .map(n => `[Node ${n.id}] (${n.tag || 'general'}, sim: ${n.similarity.toFixed(3)}, weight: ${(n.weight || 0).toFixed(2)})\n${n.concept}`)
    .join('\n\n');

  const contextChars = context.length;
  console.log(`  Context size: ${(contextChars / 1024).toFixed(1)} KB (${scored.length} nodes)`);

  // Single LLM call
  const provider = makeOpenAIProvider(SYNTHESIS_MODEL);
  const llmStart = Date.now();

  const response = await provider.generate({
    instructions: `You are analyzing a knowledge graph about conformal field theory / conformal bootstrap research. Answer the query thoroughly, citing Node IDs where relevant.`,
    input: `${context}\n\nQuery: ${QUERY}`,
    maxTokens: 8000,
    reasoningEffort: 'high'
  });

  const llmTime = Date.now() - llmStart;
  const totalTime = Date.now() - start;

  console.log(`  LLM call: ${llmTime}ms`);
  console.log(`  Total time: ${totalTime}ms`);
  console.log(`  Coverage: ${scored.length}/${graph.nodes.length} nodes (${(scored.length / graph.nodes.length * 100).toFixed(1)}%)`);
  console.log(`  Response length: ${response.content.length} chars`);

  return {
    approach: 'Standard Top-K',
    answer: response.content,
    timing: {
      retrievalMs: retrievalTime,
      llmMs: llmTime,
      totalMs: totalTime
    },
    coverage: {
      nodesExamined: scored.length,
      totalNodes: graph.nodes.length,
      percentage: (scored.length / graph.nodes.length * 100).toFixed(1)
    },
    context: {
      chars: contextChars,
      tokens: Math.ceil(contextChars / 4) // rough estimate
    },
    usage: response.usage
  };
}

// ─── Approach 2: Full PGS ────────────────────────────────────────────

async function runPGS(graph) {
  console.log('\n--- APPROACH 2: Full PGS ---\n');
  const start = Date.now();

  const engine = new PGSEngine({
    sweepProvider: makeOpenAIProvider(SWEEP_MODEL),
    synthesisProvider: makeOpenAIProvider(SYNTHESIS_MODEL),
    embeddingProvider: makeEmbeddingProvider(),
    config: {
      maxSweepPartitions: 15,
      maxConcurrentSweeps: 5
    }
  });

  const events = [];

  const result = await engine.execute(QUERY, graph, {
    fullSweep: true,
    onEvent: (event) => {
      events.push({ ...event, timestamp: Date.now() - start });
      if (event.type === 'partitioning' && event.partitionCount) {
        console.log(`  Partitioned into ${event.partitionCount} communities`);
      } else if (event.type === 'sweep_complete') {
        console.log(`  Swept partition ${event.partitionId} (${event.completed}/${event.total})`);
      } else if (event.type === 'synthesizing') {
        console.log(`  Synthesizing across all partitions...`);
      }
    }
  });

  const totalTime = Date.now() - start;
  console.log(`  Total time: ${totalTime}ms`);
  console.log(`  Partitions swept: ${result.metadata.pgs.sweptPartitions}/${result.metadata.pgs.totalPartitions}`);
  console.log(`  Successful sweeps: ${result.metadata.pgs.successfulSweeps}`);
  console.log(`  Response length: ${result.answer.length} chars`);

  // Calculate total nodes examined
  const sweepStartEvents = events.filter(e => e.type === 'sweep_started');
  const totalNodesExamined = sweepStartEvents.reduce((sum, e) => sum + (e.nodeCount || 0), 0);

  return {
    approach: 'Full PGS',
    answer: result.answer,
    timing: {
      totalMs: totalTime,
      phases: events
    },
    coverage: {
      nodesExamined: totalNodesExamined,
      totalNodes: result.metadata.pgs.totalNodes,
      partitionsSwept: result.metadata.pgs.sweptPartitions,
      totalPartitions: result.metadata.pgs.totalPartitions,
      percentage: (totalNodesExamined / result.metadata.pgs.totalNodes * 100).toFixed(1)
    },
    metadata: result.metadata
  };
}

// ─── Approach 3: Layered Search ───────────────────────────────────────

async function runLayered(graph) {
  console.log('\n--- APPROACH 3: Layered (Standard → PGS) ---\n');
  const start = Date.now();

  const engine = new PGSEngine({
    sweepProvider: makeOpenAIProvider(SWEEP_MODEL),
    synthesisProvider: makeOpenAIProvider(SYNTHESIS_MODEL),
    embeddingProvider: makeEmbeddingProvider(),
    config: {
      maxSweepPartitions: 15,
      maxConcurrentSweeps: 5
    }
  });

  const events = [];

  const result = await engine.layeredSearch(QUERY, graph, {
    topK: TOP_K,
    fullSweep: true,
    onEvent: (event) => {
      events.push({ ...event, timestamp: Date.now() - start });
      if (event.type === 'layered_standard') {
        console.log(`  ${event.message}`);
      } else if (event.type === 'layered_standard_complete') {
        console.log(`  Standard query complete: ${event.nodesUsed} nodes, ${event.answerLength} char answer`);
      } else if (event.type === 'sweep_complete') {
        console.log(`  Swept partition ${event.partitionId} (${event.completed}/${event.total})`);
      } else if (event.type === 'synthesizing') {
        console.log(`  Synthesizing with standard context + PGS findings...`);
      }
    }
  });

  const totalTime = Date.now() - start;
  console.log(`  Total time: ${totalTime}ms`);
  console.log(`  Standard answer length: ${result.standardAnswer.length} chars`);
  console.log(`  PGS answer length: ${result.answer.length} chars`);
  console.log(`  Standard nodes used: ${result.metadata.layered.standardNodesUsed}`);

  return {
    approach: 'Layered (Standard + PGS)',
    answer: result.answer,
    standardAnswer: result.standardAnswer,
    timing: {
      totalMs: totalTime,
      phases: events
    },
    coverage: {
      standardNodes: result.metadata.layered.standardNodesUsed,
      totalNodes: result.metadata.pgs.totalNodes,
      partitionsSwept: result.metadata.pgs.sweptPartitions,
      totalPartitions: result.metadata.pgs.totalPartitions
    },
    metadata: result.metadata
  };
}

// ─── Main ─────────────────────────────────────────────────────────────

async function main() {
  console.log('PGS Benchmark Comparison');
  console.log('========================\n');
  console.log(`Query: "${QUERY}"`);
  console.log(`Brain: physics2 (conformal bootstrap research)`);
  console.log(`Sweep model: ${SWEEP_MODEL}`);
  console.log(`Synthesis model: ${SYNTHESIS_MODEL}`);

  const { nodes, edges, metadata } = loadBrain();
  const graph = { nodes, edges };
  console.log(`\nLoaded: ${metadata.nodeCount} nodes, ${metadata.edgeCount} edges\n`);

  // Get query embedding for standard approach
  const embeddingProvider = makeEmbeddingProvider();
  const queryEmbedding = await embeddingProvider.embed(QUERY);

  // Run all three approaches
  const results = {};

  try {
    results.standard = await runStandard(graph, queryEmbedding);
  } catch (err) {
    console.error('Standard approach failed:', err.message);
  }

  try {
    results.pgs = await runPGS(graph);
  } catch (err) {
    console.error('PGS approach failed:', err.message);
  }

  try {
    results.layered = await runLayered(graph);
  } catch (err) {
    console.error('Layered approach failed:', err.message);
  }

  // Save raw results
  const resultsDir = path.join(__dirname, 'results');
  fs.mkdirSync(resultsDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

  for (const [key, result] of Object.entries(results)) {
    if (result) {
      fs.writeFileSync(
        path.join(resultsDir, `${key}-${timestamp}.json`),
        JSON.stringify(result, null, 2)
      );
    }
  }

  // Generate comparison markdown
  const comparison = generateComparison(results, metadata);
  fs.writeFileSync(path.join(__dirname, 'COMPARISON.md'), comparison);

  console.log('\n\n============================');
  console.log('Results saved to benchmark/results/');
  console.log('Comparison written to benchmark/COMPARISON.md');
  console.log('============================');

  // Print summary table
  console.log('\n--- Summary ---\n');
  console.log('| Approach | Time | Coverage | Response Length |');
  console.log('|----------|------|----------|----------------|');
  for (const [, result] of Object.entries(results)) {
    if (result) {
      const time = `${(result.timing.totalMs / 1000).toFixed(1)}s`;
      const coverage = result.coverage.percentage ? `${result.coverage.percentage}%` : `${result.coverage.partitionsSwept}/${result.coverage.totalPartitions} partitions`;
      const length = `${result.answer.length} chars`;
      console.log(`| ${result.approach} | ${time} | ${coverage} | ${length} |`);
    }
  }
}

function generateComparison(results, metadata) {
  const lines = [];
  lines.push('# PGS Benchmark Comparison');
  lines.push('');
  lines.push(`**Date:** ${new Date().toISOString()}`);
  lines.push(`**Brain:** physics2 — ${metadata.description}`);
  lines.push(`**Graph:** ${metadata.nodeCount} nodes, ${metadata.edgeCount} edges, ${metadata.embeddingDimensions}-dim embeddings`);
  lines.push(`**Query:** "${QUERY}"`);
  lines.push(`**Sweep model:** ${SWEEP_MODEL}`);
  lines.push(`**Synthesis model:** ${SYNTHESIS_MODEL}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push('| Approach | Time | Coverage | Nodes Examined | Response Length |');
  lines.push('|----------|------|----------|----------------|----------------|');

  for (const [, result] of Object.entries(results)) {
    if (result) {
      const time = `${(result.timing.totalMs / 1000).toFixed(1)}s`;
      const coverage = result.coverage.percentage ? `${result.coverage.percentage}%` : 'N/A';
      const nodes = result.coverage.nodesExamined || result.coverage.standardNodes || 'N/A';
      const length = `${result.answer.length}`;
      lines.push(`| ${result.approach} | ${time} | ${coverage} | ${nodes} | ${length} |`);
    }
  }

  lines.push('');

  // Write full responses
  for (const [key, result] of Object.entries(results)) {
    if (result) {
      lines.push(`## ${result.approach}`);
      lines.push('');
      lines.push('### Timing');
      lines.push(`- Total: ${(result.timing.totalMs / 1000).toFixed(1)}s`);
      if (result.timing.retrievalMs) {
        lines.push(`- Retrieval: ${result.timing.retrievalMs}ms`);
        lines.push(`- LLM: ${result.timing.llmMs}ms`);
      }
      lines.push('');
      lines.push('### Coverage');
      for (const [k, v] of Object.entries(result.coverage)) {
        lines.push(`- ${k}: ${v}`);
      }
      lines.push('');
      lines.push('### Full Response');
      lines.push('');
      lines.push('```');
      lines.push(result.answer);
      lines.push('```');
      lines.push('');

      if (result.standardAnswer) {
        lines.push('### Standard Answer (prior context for PGS)');
        lines.push('');
        lines.push('```');
        lines.push(result.standardAnswer);
        lines.push('```');
        lines.push('');
      }
    }
  }

  return lines.join('\n');
}

main().catch(err => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
