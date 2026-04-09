const { getDefaultModelAssignments } = require('./platform');

module.exports = {
  modelAssignments: getDefaultModelAssignments(),
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
    },
    ollama: {
      maxConcurrentTools: 3,
      maxToolsPerIteration: 5,
      pollingInterval: 2000,
      reducedParallelism: true,
      conservativeTokens: true,
      maxOutputTokens: 2000
    },
    lmstudio: {
      maxConcurrentTools: 3,
      maxToolsPerIteration: 5,
      pollingInterval: 1500,
      reducedParallelism: true,
      conservativeTokens: true,
      maxOutputTokens: 2000
    }
  },
  toolCompatibility: {
    anthropic: ['*'],
    openai: ['*'],
    xai: ['*'],
    ollama: [
      'file_read',
      'list_directory',
      'grep_search',
      'edit_file',
      'write_file',
      'execute_bash'
    ],
    lmstudio: [
      'file_read',
      'list_directory',
      'grep_search',
      'edit_file',
      'write_file',
      'execute_bash'
    ]
  }
};
