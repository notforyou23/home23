#!/usr/bin/env node

// Offline trainer for the latent projector.
// Currently computes an identity projection sized to the observed vector
// length. This provides a placeholder for future regression logic while
// establishing the pipeline for saving weights under runtime/policies.

const fs = require('fs/promises');
const path = require('path');

async function main() {
  try {
    const projectRoot = path.join(__dirname, '..');
    const datasetPath = path.join(projectRoot, 'runtime', 'training', 'latent-dataset.jsonl');
    const policyDir = path.join(projectRoot, 'runtime', 'policies');
    const policyPath = path.join(policyDir, 'latent-projector.json');

    const lines = await readLines(datasetPath);
    if (lines.length === 0) {
      console.error('No latent dataset entries found. Run COSMO with the latent projector enabled to collect data.');
      process.exit(1);
    }

    const sample = lines.find(entry => Array.isArray(entry.vector) && entry.vector.length > 0);
    if (!sample) {
      console.error('Dataset does not contain vectors.');
      process.exit(1);
    }

    const vectorSize = sample.vector.length;
    const projectionMatrix = buildIdentityMatrix(vectorSize);

    await fs.mkdir(policyDir, { recursive: true });
    await fs.writeFile(
      policyPath,
      JSON.stringify({
        version: 1,
        vectorSize,
        projectionMatrix
      }, null, 2),
      'utf-8'
    );

    console.log(`Latent projector weights written to ${policyPath}`);
  } catch (error) {
    console.error('Failed to train latent projector:', error.message);
    process.exit(1);
  }
}

async function readLines(filePath) {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return content
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => {
        try {
          return JSON.parse(line);
        } catch (error) {
          return null;
        }
      })
      .filter(Boolean);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

function buildIdentityMatrix(size) {
  const matrix = [];
  for (let row = 0; row < size; row += 1) {
    const current = new Array(size).fill(0);
    current[row] = 1;
    matrix.push(current);
  }
  return matrix;
}

main();
