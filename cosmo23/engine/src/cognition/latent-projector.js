const path = require('path');

/**
 * LatentProjector
 *
 * Generates a compact latent vector and human-readable hint derived from
 * recent memory context and active goals. The current implementation relies on
 * existing memory embeddings (if present) and an optional projection matrix
 * stored in `runtime/policies/latent-projector.json`.
 */
class LatentProjector {
  constructor(config = {}, logger = console) {
    this.logger = logger;
    this.config = {
      maxMemoryNodes: config.maxMemoryNodes || 5,
      maxGoalCount: config.maxGoalCount || 3,
      hintMaxLength: config.hintMaxLength || 140,
      vectorSize: config.vectorSize || 128,
      autoTrain: config.autoTrain !== false,  // Default enabled
      autoTrainThreshold: config.autoTrainThreshold || 100,  // Train after 100 samples
      autoTrainInterval: config.autoTrainInterval || 50  // Check every 50 new samples
    };

    // PRODUCTION: Use COSMO_RUNTIME_PATH from environment (user-specific)
    // FALLBACK: Use engine/runtime for local development
    const projectRoot = path.join(__dirname, '..', '..');  // src/cognition -> src -> COSMO root
    const runtimeRoot = process.env.COSMO_RUNTIME_PATH || path.join(projectRoot, 'runtime');
    
    this.policyDir = path.join(runtimeRoot, 'policies');
    this.policyPath = path.join(this.policyDir, 'latent-projector.json');
    this.trainingDir = path.join(runtimeRoot, 'training');
    this.datasetPath = path.join(this.trainingDir, 'latent-dataset.jsonl');

    this.initialized = false;
    this.weights = null;
    this.lastTrainingSampleCount = 0;
    this.trainingInProgress = false;
  }

  async initialize() {
    if (this.initialized) return;

    try {
      const fs = require('fs').promises;
      const raw = await fs.readFile(this.policyPath, 'utf-8');
      const parsed = JSON.parse(raw);

      if (parsed.version === 1 && Array.isArray(parsed.projectionMatrix)) {
        this.weights = parsed;
        this.logger.info?.('Latent projector weights loaded', {
          vectorSize: parsed.vectorSize,
          rows: parsed.projectionMatrix.length
        });
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.logger.warn?.('Latent projector weights unavailable, using fallback', {
          error: error.message
        });
      }
    }

    this.initialized = true;
  }

  async generateContext(memoryNodes = [], goalDescriptions = []) {
    await this.initialize();

    const nodes = memoryNodes.slice(0, this.config.maxMemoryNodes);
    const goals = goalDescriptions.slice(0, this.config.maxGoalCount);

    const baseVector = this.buildBaseVector(nodes);
    const projectedVector = this.projectVector(baseVector);
    const hint = this.buildHint(nodes, goals);

    if (!projectedVector && !hint) {
      return null;
    }

    return {
      vector: projectedVector || null,
      hint: hint || null,
      metadata: {
        memoryCount: nodes.length,
        goalCount: goals.length
      }
    };
  }

  buildBaseVector(nodes) {
    const vectors = nodes
      .map(node => Array.isArray(node.embedding) ? node.embedding : null)
      .filter(Boolean);

    if (vectors.length === 0) {
      return null;
    }

    const length = vectors[0].length;
    const accumulator = new Array(length).fill(0);

    vectors.forEach(vec => {
      for (let i = 0; i < length; i += 1) {
        accumulator[i] += vec[i];
      }
    });

    const factor = 1 / vectors.length;
    for (let i = 0; i < length; i += 1) {
      accumulator[i] *= factor;
    }

    return accumulator;
  }

  projectVector(baseVector) {
    if (!Array.isArray(baseVector) || baseVector.length === 0) {
      return null;
    }

    if (this.weights && Array.isArray(this.weights.projectionMatrix)) {
      const matrix = this.weights.projectionMatrix;
      const result = matrix.map(row => {
        let sum = 0;
        const limit = Math.min(row.length, baseVector.length);
        for (let i = 0; i < limit; i += 1) {
          sum += row[i] * baseVector[i];
        }
        return sum;
      });
      return result;
    }

    // Fallback: truncate or pad the base vector to configured size
    const target = this.config.vectorSize;
    const vector = new Array(target).fill(0);
    const limit = Math.min(target, baseVector.length);
    for (let i = 0; i < limit; i += 1) {
      vector[i] = baseVector[i];
    }
    return vector;
  }

  buildHint(nodes, goals) {
    const parts = [];

    nodes.forEach(node => {
      if (node.keyPhrase) {
        parts.push(node.keyPhrase);
      } else if (node.summary) {
        parts.push(node.summary);
      } else if (node.concept) {
        parts.push(node.concept.substring(0, 60));
      }
    });

    goals.forEach(goal => {
      if (typeof goal === 'string' && goal.trim().length > 0) {
        parts.push(goal.trim());
      } else if (goal && goal.description) {
        parts.push(goal.description.substring(0, 80));
      }
    });

    if (parts.length === 0) {
      return null;
    }

    const hint = parts.join('; ');
    if (hint.length <= this.config.hintMaxLength) {
      return hint;
    }
    return hint.substring(0, this.config.hintMaxLength - 1) + '…';
  }

  /**
   * Check if auto-training should be triggered
   * Returns true if we have enough new samples since last training
   */
  async shouldAutoTrain() {
    if (!this.config.autoTrain) {
      return false;
    }

    if (this.trainingInProgress) {
      return false;
    }

    try {
      const fs = require('fs').promises;
      const content = await fs.readFile(this.datasetPath, 'utf-8');
      const lines = content.split('\n').filter(line => line.trim().length > 0);
      const currentCount = lines.length;

      // Check if we have enough samples total
      if (currentCount < this.config.autoTrainThreshold) {
        return false;
      }

      // Check if we've accumulated enough new samples since last training
      const newSamples = currentCount - this.lastTrainingSampleCount;
      if (newSamples >= this.config.autoTrainInterval) {
        this.logger.info?.('Auto-training threshold reached', {
          totalSamples: currentCount,
          newSamples,
          threshold: this.config.autoTrainThreshold,
          interval: this.config.autoTrainInterval
        });
        return true;
      }

      return false;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.logger.warn?.('Failed to check training dataset', {
          error: error.message
        });
      }
      return false;
    }
  }

  /**
   * Trigger auto-training in background
   * Uses the same training script but runs it asynchronously
   */
  async autoTrain() {
    if (this.trainingInProgress) {
      return;
    }

    this.trainingInProgress = true;

    try {
      this.logger.info?.('🧮 Starting auto-training for latent projector...');
      
      const { spawn } = require('child_process');
      const path = require('path');
      const projectRoot = path.join(__dirname, '..', '..');
      const scriptPath = path.join(projectRoot, 'scripts', 'train-latent-projector.js');

      // Run training script in background
      const training = spawn('node', [scriptPath], {
        detached: false,
        stdio: 'pipe'
      });

      // Capture output for logging
      let output = '';
      training.stdout.on('data', (data) => {
        output += data.toString();
      });

      training.stderr.on('data', (data) => {
        this.logger.warn?.('Training stderr', { message: data.toString() });
      });

      training.on('close', async (code) => {
        this.trainingInProgress = false;

        if (code === 0) {
          this.logger.info?.('✅ Auto-training completed successfully', {
            output: output.trim()
          });

          // Update sample count to avoid re-training immediately
          try {
            const fs = require('fs').promises;
            const content = await fs.readFile(this.datasetPath, 'utf-8');
            const lines = content.split('\n').filter(line => line.trim().length > 0);
            this.lastTrainingSampleCount = lines.length;

            // Reload weights
            this.initialized = false;
            await this.initialize();
          } catch (error) {
            this.logger.warn?.('Failed to update training state', {
              error: error.message
            });
          }
        } else {
          this.logger.error?.('❌ Auto-training failed', {
            exitCode: code,
            output: output.trim()
          });
        }
      });

      training.on('error', (error) => {
        this.trainingInProgress = false;
        this.logger.error?.('Failed to spawn training process', {
          error: error.message
        });
      });

    } catch (error) {
      this.trainingInProgress = false;
      this.logger.error?.('Auto-training error', {
        error: error.message
      });
    }
  }
}

module.exports = {
  LatentProjector
};
