/**
 * Example Model Configuration
 *
 * Copy this to model-config.js and customize for your deployment.
 * This configuration is OPTIONAL - the system works without it using defaults.
 */

module.exports = {
  // === EXAMPLE 1: Local-only mode ===
  // Use Ollama for everything
  /*
  modelAssignments: {
    default: {
      provider: 'ollama',
      model: 'qwen2.5-coder:14b'
    },
    fast: {
      provider: 'ollama',
      model: 'qwen2.5-coder:7b'
    }
  },
  */

  // === EXAMPLE 2: Hybrid cloud + local ===
  // Fast operations on local, complex on cloud
  modelAssignments: {
    default: {
      provider: 'anthropic',
      model: 'claude-sonnet-4-5'
    },
    fast: {
      provider: 'ollama',
      model: 'qwen2.5-coder:7b',
      fallback: 'anthropic/claude-sonnet-4-5'  // Use cloud if Ollama down
    },
    reasoning: {
      provider: 'anthropic',
      model: 'claude-opus-4-6'
    }
  },

  // Performance tuning per provider
  performanceProfiles: {
    ollama: {
      maxConcurrentTools: 3,        // Limited by local GPU
      maxToolsPerIteration: 5,
      pollingInterval: 2000,        // Slower inference
      reducedParallelism: true,     // Sequential execution
      conservativeTokens: true,
      maxOutputTokens: 2000
    },
    anthropic: {
      maxConcurrentTools: 10,
      maxToolsPerIteration: 15,
      pollingInterval: 500,
      reducedParallelism: false,
      conservativeTokens: false,
      maxOutputTokens: 8000
    },
    openai: {
      maxConcurrentTools: 10,
      maxToolsPerIteration: 15,
      pollingInterval: 500,
      reducedParallelism: false,
      conservativeTokens: false,
      maxOutputTokens: 16000
    }
  },

  // Tool compatibility matrix
  toolCompatibility: {
    ollama: [
      'file_read',
      'list_directory',
      'grep_search',
      'edit_file',
      'write_file',
      'execute_bash'
      // Skip: web_search, code_interpreter, mcp (not supported)
    ],
    anthropic: ['*'],  // All tools
    openai: ['*']
  }
};
