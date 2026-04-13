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
const os = require('os');

let brainLoader = null;
let brainQueryEngine = null;

// Get embeddings API key from config or env
function getEmbeddingsApiKey() {
  // Try config first
  const configPath = path.join(os.homedir(), '.evobrew', 'config.json');
  try {
    const config = JSON.parse(fsSync.readFileSync(configPath, 'utf8'));
    if (config.embeddings?.api_key) {
      return config.embeddings.api_key;
    }
  } catch (e) {
    // Config not readable, fall through
  }
  // Fall back to env
  return process.env.OPENAI_API_KEY;
}

function unloadBrain() {
  if (brainQueryEngine) {
    if (typeof brainQueryEngine.dispose === 'function') brainQueryEngine.dispose();
    if (typeof brainQueryEngine.close === 'function') brainQueryEngine.close();
  }
  brainQueryEngine = null;
  brainLoader = null;
}

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

  // QueryEngine handles missing OpenAI gracefully (falls back to keyword search)
  const embeddingsKey = getEmbeddingsApiKey();
  brainQueryEngine = new BrainQueryEngine(brainPath, embeddingsKey);
  console.log(`✅ Brain loaded: ${brainLoader.nodes.length} nodes, ${brainLoader.edges.length} edges\n`);
  
  return { brainLoader, brainQueryEngine };
}

function getBrainLoader() {
  return brainLoader;
}

function getQueryEngine() {
  return brainQueryEngine;
}

module.exports = { loadBrain, unloadBrain, getBrainLoader, getQueryEngine };
