/**
 * Output Contracts Registry
 * 
 * Machine-readable contracts that define expected artifacts for different run types.
 * These are the SINGLE SOURCE OF TRUTH for what artifacts should be produced.
 * 
 * Philosophy:
 * - Meta-Coordinator references contracts, doesn't hallucinate filenames
 * - Agents fulfill contracts, don't guess formats
 * - PublisherAgent validates against contracts before promotion
 * 
 * ADDITIVE: This is a new component that doesn't modify existing behavior.
 * Existing code continues working; new contract-aware code uses this registry.
 */

const OutputContracts = {
  /**
   * Evaluation Run Contract
   * For comprehensive baseline evaluations, model testing, etc.
   */
  eval_outputs_v1: {
    contractId: 'eval_outputs_v1',
    version: '1.0.0',
    description: 'Canonical outputs for evaluation runs',
    runType: 'evaluation',
    
    artifacts: [
      {
        name: 'dataset',
        filename: 'dataset.jsonl',
        schema: null,  // Can reference schemas/dataset.schema.json later
        role: 'input_data',
        required: true,
        description: 'Input dataset used for evaluation'
      },
      {
        name: 'predictions',
        filename: 'predictions.jsonl',
        schema: null,
        role: 'primary_output',
        required: true,
        description: 'Model predictions on dataset'
      },
      {
        name: 'metrics',
        filename: 'metrics.json',
        schema: null,
        role: 'summary',
        required: true,
        description: 'Quantitative evaluation metrics'
      },
      {
        name: 'run_manifest',
        filename: 'run_manifest.json',
        schema: null,
        role: 'provenance',
        required: true,
        description: 'Run metadata, config hashes, timestamps'
      },
      {
        name: 'analysis',
        filename: 'analysis_output.json',
        schema: null,
        role: 'analysis',
        required: false,
        description: 'Detailed analysis (disagreement, calibration, etc.)'
      }
    ],
    
    // Optional: validation rules
    validation: {
      datasetPredictionsMatch: 'dataset and predictions must have same number of lines',
      manifestRequired: 'run_manifest must include seed, timestamp, and config hash'
    }
  },

  /**
   * Simple Baseline Contract
   * For minimal reproducible baselines (matches what agent_1764028680932_w6k9vp7 actually produces)
   */
  simple_baseline_v1: {
    contractId: 'simple_baseline_v1',
    version: '1.0.0',
    description: 'Minimal baseline run outputs',
    runType: 'baseline',
    
    artifacts: [
      {
        name: 'metrics',
        filename: 'metrics.json',
        role: 'summary',
        required: true,
        description: 'Core evaluation metrics'
      },
      {
        name: 'baseline_config',
        filename: 'baseline_config.yaml',
        role: 'config',
        required: true,
        description: 'Baseline configuration (seed, size, etc.)'
      },
      {
        name: 'manifest',
        filename: 'manifest.json',
        role: 'provenance',
        required: true,
        description: 'Run manifest with timestamps and artifact list'
      },
      {
        name: 'report',
        filename: 'evaluation_report.md',
        role: 'documentation',
        required: true,
        description: 'Human-readable evaluation report'
      }
    ]
  },

  /**
   * Governance Assessment Contract
   * For compliance, policy, and governance reviews
   */
  governance_assessment_v1: {
    contractId: 'governance_assessment_v1',
    version: '1.0.0',
    description: 'Governance and compliance assessment outputs',
    runType: 'governance',
    
    artifacts: [
      {
        name: 'assessment_report',
        filename: 'governance_report.md',
        role: 'primary_output',
        required: true,
        description: 'Comprehensive governance assessment'
      },
      {
        name: 'compliance_matrix',
        filename: 'compliance_matrix.json',
        role: 'structured_data',
        required: true,
        description: 'Compliance status by control/requirement'
      },
      {
        name: 'evidence_bundle',
        filename: 'evidence_bundle.json',
        role: 'audit_trail',
        required: true,
        description: 'Supporting evidence and references'
      }
    ]
  }
};

/**
 * Get contract by ID
 * @param {string} contractId - Contract identifier
 * @returns {Object} Contract definition
 * @throws {Error} If contract not found
 */
function getContract(contractId) {
  const contract = OutputContracts[contractId];
  if (!contract) {
    throw new Error(`Unknown contract ID: ${contractId}`);
  }
  return contract;
}

/**
 * List all available contracts
 * @returns {Array} Array of contract summaries
 */
function listContracts() {
  return Object.keys(OutputContracts).map(id => ({
    contractId: id,
    version: OutputContracts[id].version,
    description: OutputContracts[id].description,
    runType: OutputContracts[id].runType
  }));
}

/**
 * Validate artifacts against contract
 * @param {string} contractId - Contract to validate against
 * @param {Array} actualArtifacts - Array of {filename, exists, size} objects
 * @returns {Object} Validation result with {contractId, satisfied, missingRequired, extraFiles, presentArtifacts}
 */
function validateAgainstContract(contractId, actualArtifacts) {
  const contract = getContract(contractId);
  const result = {
    contractId,
    satisfied: true,
    missingRequired: [],
    extraFiles: [],
    presentArtifacts: []
  };
  
  // Check required artifacts
  for (const spec of contract.artifacts) {
    const found = actualArtifacts.find(a => a.filename === spec.filename);
    
    if (!found && spec.required) {
      result.satisfied = false;
      result.missingRequired.push(spec.filename);
    } else if (found) {
      result.presentArtifacts.push(spec.filename);
    }
  }
  
  // Check for extra files (info only, not failure)
  const expectedFilenames = contract.artifacts.map(a => a.filename);
  for (const actual of actualArtifacts) {
    if (!expectedFilenames.includes(actual.filename)) {
      result.extraFiles.push(actual.filename);
    }
  }
  
  return result;
}

/**
 * Check if a contract exists
 * @param {string} contractId - Contract identifier to check
 * @returns {boolean} True if contract exists
 */
function hasContract(contractId) {
  return contractId in OutputContracts;
}

/**
 * Get expected artifacts for a contract
 * @param {string} contractId - Contract identifier
 * @returns {Array} Array of artifact filenames
 */
function getExpectedArtifacts(contractId) {
  const contract = getContract(contractId);
  return contract.artifacts
    .filter(a => a.required)
    .map(a => a.filename);
}

module.exports = {
  OutputContracts,
  getContract,
  listContracts,
  validateAgainstContract,
  hasContract,
  getExpectedArtifacts
};

