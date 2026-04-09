/**
 * Model Configuration for Raspberry Pi
 * 
 * Pi cannot run local models (Ollama) effectively.
 * All AI operations use cloud providers.
 * 
 * Copy this to model-config.js on Pi deployments.
 */

module.exports = {
  // Cloud-only model assignments
  modelAssignments: {
    default: {
      provider: 'anthropic',
      model: 'claude-sonnet-4-5'
    },
    fast: {
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      // No fallback to local - cloud is the only option
    },
    reasoning: {
      provider: 'anthropic',
      model: 'claude-opus-4-6'
    }
  },

  // Performance profiles - Pi-optimized (no local)
  performanceProfiles: {
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
    },
    xai: {
      maxConcurrentTools: 8,
      maxToolsPerIteration: 10,
      pollingInterval: 600,
      reducedParallelism: false,
      conservativeTokens: false,
      maxOutputTokens: 8000
    }
  },

  // All cloud providers support all tools
  toolCompatibility: {
    anthropic: ['*'],
    openai: ['*'],
    xai: ['*']
  },

  // Pi-specific settings
  platform: {
    disableLocalModels: true,
    preferredProvider: 'anthropic',
    logLevel: 'info'
  }
};
