/**
 * Brain Loader Module
 * Loads .brain package before server starts
 */

const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const zlib = require('zlib');
const { promisify } = require('util');
const gunzip = promisify(zlib.gunzip);

const { BrainQueryEngine } = require('../lib/brain-query-engine');

let brainLoader = null;
let brainQueryEngine = null;

async function loadBrain(brainPath) {
  console.log(`\n🧠 Loading brain: ${brainPath}`);
  
  const statePath = path.join(brainPath, 'state.json.gz');
  if (!fsSync.existsSync(statePath)) {
    throw new Error('No state.json.gz found in brain');
  }

  const compressed = await fs.readFile(statePath);
  const decompressed = await gunzip(compressed);
  const state = JSON.parse(decompressed.toString());

  brainLoader = {
    brainPath: path.resolve(brainPath),
    state,
    nodes: state.memory?.nodes || [],
    edges: state.memory?.edges || []
  };

  brainQueryEngine = new BrainQueryEngine(brainPath, process.env.OPENAI_API_KEY);

  console.log(`✅ Brain loaded: ${brainLoader.nodes.length} nodes, ${brainLoader.edges.length} edges\n`);
  
  return { brainLoader, brainQueryEngine };
}

function getBrainLoader() {
  return brainLoader;
}

function getQueryEngine() {
  return brainQueryEngine;
}

module.exports = { loadBrain, getBrainLoader, getQueryEngine };
