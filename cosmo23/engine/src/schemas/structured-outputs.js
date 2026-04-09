/**
 * Structured Output Schemas for Cosmo
 * Inspired by OpenAI Agents SDK - replaces string parsing with typed structures
 */

/**
 * Goal Curator Structured Outputs
 */
const CampaignDecisionSchema = {
  name: 'campaign_decision',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      shouldCreateCampaign: {
        type: 'boolean',
        description: 'Whether to create a new campaign from these goals'
      },
      campaignName: {
        type: 'string',
        description: 'Name for the campaign if creating one'
      },
      campaignTheme: {
        type: 'string',
        description: 'Central theme connecting these goals'
      },
      goalIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'IDs of goals to include in campaign'
      },
      expectedDuration: {
        type: 'integer',
        description: 'Expected campaign duration in cycles'
      },
      priority: {
        type: 'string',
        enum: ['critical', 'high', 'medium', 'low'],
        description: 'Campaign priority level'
      },
      reasoning: {
        type: 'string',
        description: 'Why these goals form a coherent campaign'
      }
    },
    required: ['shouldCreateCampaign', 'reasoning'],
    additionalProperties: false
  }
};

const SynthesisDecisionSchema = {
  name: 'synthesis_decision',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      shouldSynthesize: {
        type: 'boolean',
        description: 'Whether goals are ready for synthesis'
      },
      goalIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Goals to synthesize together'
      },
      synthesisType: {
        type: 'string',
        enum: ['abstraction', 'integration', 'generalization', 'theory_building'],
        description: 'Type of synthesis to perform'
      },
      higherOrderGoal: {
        type: 'string',
        description: 'The new higher-order goal emerging from synthesis'
      },
      expectedInsights: {
        type: 'array',
        items: { type: 'string' },
        description: 'Expected insights from this synthesis'
      },
      reasoning: {
        type: 'string',
        description: 'Why these goals are ready for synthesis'
      }
    },
    required: ['shouldSynthesize', 'reasoning'],
    additionalProperties: false
  }
};

/**
 * Meta-Coordinator Structured Outputs
 */
const StrategicPlanSchema = {
  name: 'strategic_plan',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      overallAssessment: {
        type: 'object',
        properties: {
          cognitiveQuality: {
            type: 'number',
            description: 'Overall quality score 0-1'
          },
          diversityScore: {
            type: 'number',
            description: 'Theme diversity score 0-1'
          },
          memoryHealth: {
            type: 'number',
            description: 'Memory network health 0-1'
          },
          goalPortfolioHealth: {
            type: 'number',
            description: 'Goal portfolio health 0-1'
          }
        },
        required: ['cognitiveQuality', 'diversityScore', 'memoryHealth', 'goalPortfolioHealth'],
        additionalProperties: false
      },
      strategicDirectives: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            directive: {
              type: 'string',
              enum: ['enforce_diversity', 'spawn_agents', 'consolidate_memory', 
                     'prioritize_campaigns', 'explore_new_domains', 'deepen_existing'],
              description: 'Type of strategic directive'
            },
            priority: {
              type: 'string',
              enum: ['critical', 'high', 'medium', 'low']
            },
            reasoning: {
              type: 'string',
              description: 'Why this directive is needed'
            },
            targetMetrics: {
              type: 'object',
              properties: {
                metric: { type: 'string' },
                currentValue: { type: 'number' },
                targetValue: { type: 'number' }
              },
              required: ['metric', 'currentValue', 'targetValue'],
              additionalProperties: false
            }
          },
          required: ['directive', 'priority', 'reasoning'],
          additionalProperties: false
        }
      },
      agentSpawningDecisions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            agentType: {
              type: 'string',
              enum: ['research', 'analysis', 'synthesis', 'exploration', 
                     'code_execution', 'quality_assurance', 'planning', 'integration']
            },
            goalId: {
              type: 'string',
              description: 'Goal this agent should pursue'
            },
            priority: {
              type: 'string',
              enum: ['critical', 'high', 'medium', 'low']
            },
            expectedOutcome: {
              type: 'string',
              description: 'What this agent should accomplish'
            },
            reasoning: {
              type: 'string',
              description: 'Why spawn this specific agent type for this goal'
            }
          },
          required: ['agentType', 'goalId', 'priority', 'reasoning'],
          additionalProperties: false
        }
      },
      domainMandates: {
        type: 'array',
        items: { type: 'string' },
        description: 'New domains to explore (if diversity low)'
      },
      consolidationTargets: {
        type: 'array',
        items: { type: 'string' },
        description: 'Memory clusters to consolidate'
      }
    },
    required: ['overallAssessment', 'strategicDirectives', 'agentSpawningDecisions'],
    additionalProperties: false
  }
};

/**
 * Quality Assurance Structured Outputs
 */
const QAValidationSchema = {
  name: 'qa_validation',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      overallScore: {
        type: 'number',
        description: 'Overall quality score 0-1'
      },
      passed: {
        type: 'boolean',
        description: 'Whether validation passed'
      },
      dimensions: {
        type: 'object',
        properties: {
          consistency: {
            type: 'object',
            properties: {
              score: { type: 'number' },
              issues: {
                type: 'array',
                items: { type: 'string' }
              }
            },
            required: ['score', 'issues'],
            additionalProperties: false
          },
          factuality: {
            type: 'object',
            properties: {
              score: { type: 'number' },
              concerns: {
                type: 'array',
                items: { type: 'string' }
              }
            },
            required: ['score', 'concerns'],
            additionalProperties: false
          },
          novelty: {
            type: 'object',
            properties: {
              score: { type: 'number' },
              duplicateOf: {
                type: 'array',
                items: { type: 'string' }
              }
            },
            required: ['score', 'duplicateOf'],
            additionalProperties: false
          },
          completeness: {
            type: 'object',
            properties: {
              score: { type: 'number' },
              gaps: {
                type: 'array',
                items: { type: 'string' }
              }
            },
            required: ['score', 'gaps'],
            additionalProperties: false
          },
          value: {
            type: 'object',
            properties: {
              score: { type: 'number' },
              reasoning: { type: 'string' }
            },
            required: ['score', 'reasoning'],
            additionalProperties: false
          }
        },
        required: ['consistency', 'factuality', 'novelty', 'completeness', 'value'],
        additionalProperties: false
      },
      recommendations: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              enum: ['improve', 'revise', 'expand', 'verify', 'reject']
            },
            target: {
              type: 'string',
              description: 'What to improve/revise/expand'
            },
            suggestion: {
              type: 'string',
              description: 'Specific recommendation'
            },
            priority: {
              type: 'string',
              enum: ['critical', 'high', 'medium', 'low']
            }
          },
          required: ['type', 'target', 'suggestion', 'priority'],
          additionalProperties: false
        }
      },
      escalations: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              enum: ['novel_insight', 'breakthrough', 'contradiction', 'error']
            },
            description: {
              type: 'string'
            },
            impact: {
              type: 'string',
              enum: ['critical', 'high', 'medium', 'low']
            }
          },
          required: ['type', 'description', 'impact'],
          additionalProperties: false
        }
      }
    },
    required: ['overallScore', 'passed', 'dimensions', 'recommendations'],
    additionalProperties: false
  }
};

/**
 * Planning Agent Structured Outputs
 */
const GoalDecompositionSchema = {
  name: 'goal_decomposition',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      originalGoal: {
        type: 'string',
        description: 'The goal being decomposed'
      },
      subGoals: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            description: { type: 'string' },
            priority: {
              type: 'string',
              enum: ['critical', 'high', 'medium', 'low']
            },
            estimatedCycles: { type: 'integer' },
            dependencies: {
              type: 'array',
              items: { type: 'string' },
              description: 'IDs of sub-goals this depends on'
            },
            suggestedAgentType: {
              type: 'string',
              enum: ['research', 'analysis', 'synthesis', 'exploration', 
                     'code_execution', 'quality_assurance', 'planning', 'integration']
            },
            successCriteria: {
              type: 'array',
              items: { type: 'string' }
            }
          },
          required: ['id', 'description', 'priority', 'suggestedAgentType', 'successCriteria'],
          additionalProperties: false
        }
      },
      executionStrategy: {
        type: 'string',
        enum: ['sequential', 'parallel', 'mixed'],
        description: 'How sub-goals should be pursued'
      },
      totalEstimatedCycles: {
        type: 'integer'
      }
    },
    required: ['originalGoal', 'subGoals', 'executionStrategy', 'totalEstimatedCycles'],
    additionalProperties: false
  }
};

/**
 * Integration Agent Structured Outputs
 */
const CrossAgentInsightsSchema = {
  name: 'cross_agent_insights',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      patterns: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              enum: ['convergence', 'divergence', 'complementary', 'contradictory']
            },
            description: {
              type: 'string'
            },
            agentTypes: {
              type: 'array',
              items: { type: 'string' }
            },
            significance: {
              type: 'string',
              enum: ['high', 'medium', 'low']
            },
            implications: {
              type: 'string'
            }
          },
          required: ['type', 'description', 'agentTypes', 'significance', 'implications'],
          additionalProperties: false
        }
      },
      contradictions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            agentA: { type: 'string' },
            agentB: { type: 'string' },
            conflictingClaims: {
              type: 'array',
              items: { type: 'string' }
            },
            resolutionNeeded: { type: 'boolean' },
            suggestedResolution: { type: 'string' }
          },
          required: ['agentA', 'agentB', 'conflictingClaims', 'resolutionNeeded'],
          additionalProperties: false
        }
      },
      metaInsights: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            insight: { type: 'string' },
            evidenceFromAgents: {
              type: 'array',
              items: { type: 'string' }
            },
            confidence: { type: 'number' },
            suggestedAction: {
              type: 'string',
              enum: ['new_goal', 'memory_consolidation', 'campaign_synthesis', 'research_direction']
            }
          },
          required: ['insight', 'evidenceFromAgents', 'confidence'],
          additionalProperties: false
        }
      }
    },
    required: ['patterns', 'contradictions', 'metaInsights'],
    additionalProperties: false
  }
};

/**
 * Convert a JSON schema to a human-readable prompt for local LLMs
 * that don't support response_format parameter
 */
function schemaToPromptInstructions(schema) {
  const schemaObj = schema.schema || schema;
  const properties = schemaObj.properties || {};
  const required = schemaObj.required || [];

  let instructions = 'You MUST respond with valid JSON matching this exact structure:\n{\n';

  const fields = [];
  for (const [key, value] of Object.entries(properties)) {
    let fieldDesc = `  "${key}": `;

    if (value.type === 'boolean') {
      fieldDesc += 'true or false';
    } else if (value.type === 'string') {
      if (value.enum) {
        fieldDesc += `one of: ${value.enum.map(e => `"${e}"`).join(', ')}`;
      } else {
        fieldDesc += '"string value"';
      }
    } else if (value.type === 'integer' || value.type === 'number') {
      fieldDesc += 'number';
    } else if (value.type === 'array') {
      fieldDesc += '["array", "of", "values"]';
    } else if (value.type === 'object') {
      fieldDesc += '{...}';
    } else {
      fieldDesc += 'value';
    }

    if (value.description) {
      fieldDesc += `  // ${value.description}`;
    }
    if (required.includes(key)) {
      fieldDesc += ' (REQUIRED)';
    }

    fields.push(fieldDesc);
  }

  instructions += fields.join(',\n') + '\n}\n';
  instructions += '\nRespond with ONLY the JSON object, no other text.';

  return instructions;
}

/**
 * Helper function to create structured output request
 * Works with both OpenAI (uses json_schema) and local LLMs (uses prompt instructions)
 *
 * @param {object} schema - The JSON schema for structured output
 * @param {string} systemPrompt - System prompt for the LLM
 * @param {string} userPrompt - User prompt for the LLM
 * @param {string} model - Model name (default: gpt-4o-2024-08-06)
 * @param {boolean} isLocal - Whether using local LLM (default: false)
 */
function createStructuredOutputRequest(schema, systemPrompt, userPrompt, model = 'gpt-4o-2024-08-06', isLocal = false) {
  if (isLocal) {
    // For local LLMs: embed schema requirements in the prompt
    const schemaInstructions = schemaToPromptInstructions(schema);
    return {
      model,
      messages: [
        { role: 'system', content: `${systemPrompt}\n\n${schemaInstructions}` },
        { role: 'user', content: userPrompt }
      ]
    };
  }

  // For OpenAI: use native json_schema response_format
  return {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    response_format: {
      type: 'json_schema',
      json_schema: schema
    }
  };
}

/**
 * Helper to parse and validate structured output
 */
function parseStructuredOutput(response, schemaName) {
  try {
    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error('No content in response');
    }
    
    const parsed = JSON.parse(content);
    
    // Basic validation that required fields exist
    if (!parsed || typeof parsed !== 'object') {
      throw new Error(`Invalid ${schemaName} structure`);
    }
    
    return parsed;
  } catch (error) {
    throw new Error(`Failed to parse ${schemaName}: ${error.message}`);
  }
}

module.exports = {
  // Schemas
  CampaignDecisionSchema,
  SynthesisDecisionSchema,
  StrategicPlanSchema,
  QAValidationSchema,
  GoalDecompositionSchema,
  CrossAgentInsightsSchema,

  // Helpers (schemaToPromptInstructions for local LLM compatibility)
  schemaToPromptInstructions,
  createStructuredOutputRequest,
  parseStructuredOutput
};

