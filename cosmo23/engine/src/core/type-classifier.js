/**
 * type-classifier.js - Type Classification and Schema Validation
 * 
 * Classifies nodes into semantic types with validation rules.
 * Supports: concept, entity, event, relationship, attribute
 * 
 * @module core/type-classifier
 */

/**
 * Type schemas define validation rules for each node type
 * @type {Object}
 */
const SCHEMAS = {
  concept: {
    name: 'concept',
    description: 'Abstract ideas and general concepts',
    required: ['id', 'type', 'label'],
    optional: ['weight', 'metadata'],
    constraints: {
      label: { type: 'string', minLength: 1 },
      weight: { type: 'number', min: 0, max: 1 },
    },
  },
  entity: {
    name: 'entity',
    description: 'Concrete things, objects, or beings',
    required: ['id', 'type', 'label'],
    optional: ['weight', 'metadata'],
    constraints: {
      label: { type: 'string', minLength: 1 },
      weight: { type: 'number', min: 0, max: 1 },
    },
  },
  event: {
    name: 'event',
    description: 'Occurrences in time',
    required: ['id', 'type', 'label'],
    optional: ['weight', 'metadata'],
    constraints: {
      label: { type: 'string', minLength: 1 },
      weight: { type: 'number', min: 0, max: 1 },
      metadata: {
        type: 'object',
        properties: {
          timestamp: { type: 'number' },
          duration: { type: 'number' },
        },
      },
    },
  },
  relationship: {
    name: 'relationship',
    description: 'Connections between nodes',
    required: ['id', 'type', 'label'],
    optional: ['weight', 'metadata'],
    constraints: {
      label: { type: 'string', minLength: 1 },
      weight: { type: 'number', min: 0, max: 1 },
      metadata: {
        type: 'object',
        properties: {
          source: { type: 'string' },
          target: { type: 'string' },
          relationshipType: { type: 'string' },
        },
      },
    },
  },
  attribute: {
    name: 'attribute',
    description: 'Properties and characteristics',
    required: ['id', 'type', 'label'],
    optional: ['weight', 'metadata'],
    constraints: {
      label: { type: 'string', minLength: 1 },
      weight: { type: 'number', min: 0, max: 1 },
      metadata: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          value: { type: ['string', 'number', 'boolean'] },
        },
      },
    },
  },
};

/**
 * TypeClassifier - Validates and classifies node types
 * 
 * @class TypeClassifier
 */
class TypeClassifier {
  /**
   * Create a type classifier instance
   */
  constructor() {
    this.schemas = SCHEMAS;
    Object.freeze(this);
  }

  /**
   * Check if a type string is valid.
   * 
   * @param {string} type - Type string to check
   * @returns {boolean} True if valid type
   */
  isValidType(type) {
    return typeof type === 'string' && type in this.schemas;
  }

  /**
   * Get schema for a node type.
   * 
   * @param {string} type - Node type
   * @returns {Object} Schema object for type
   * @throws {Error} If type is invalid
   */
  getSchema(type) {
    if (!this.isValidType(type)) {
      throw new Error(`Invalid node type: "${type}"`);
    }

    return JSON.parse(JSON.stringify(this.schemas[type]));
  }

  /**
   * Get all valid types.
   * 
   * @returns {string[]} Array of valid type names
   */
  getValidTypes() {
    return Object.keys(this.schemas);
  }

  /**
   * Validate a node configuration against its schema.
   * 
   * @param {Object} nodeConfig - Node configuration to validate
   * @returns {Object} Validation result { valid: boolean, errors: [] }
   */
  validate(nodeConfig) {
    const errors = [];

    // Check config is object
    if (!nodeConfig || typeof nodeConfig !== 'object') {
      return {
        valid: false,
        errors: ['Node config must be an object'],
      };
    }

    // Check type exists
    if (!nodeConfig.type) {
      errors.push('Node must have a type');
      return { valid: false, errors };
    }

    // Check type is valid
    if (!this.isValidType(nodeConfig.type)) {
      errors.push(`Invalid node type: "${nodeConfig.type}"`);
      return { valid: false, errors };
    }

    const schema = this.schemas[nodeConfig.type];

    // Validate required fields
    for (const field of schema.required) {
      if (!(field in nodeConfig)) {
        errors.push(`Missing required field: "${field}"`);
      }
    }

    // Validate constraints
    this._validateConstraints(nodeConfig, schema, errors);

    return {
      valid: errors.length === 0,
      errors,
      type: nodeConfig.type,
    };
  }

  /**
   * Validate constraints for a node.
   * Internal helper method.
   * 
   * @private
   * @param {Object} nodeConfig - Node to validate
   * @param {Object} schema - Schema to validate against
   * @param {Array} errors - Error array to populate
   */
  _validateConstraints(nodeConfig, schema, errors) {
    const constraints = schema.constraints || {};

    // Validate label
    if ('label' in nodeConfig) {
      if (constraints.label) {
        if (typeof nodeConfig.label !== 'string') {
          errors.push('Field "label" must be a string');
        } else if (
          constraints.label.minLength &&
          nodeConfig.label.length < constraints.label.minLength
        ) {
          errors.push(`Field "label" must be at least ${constraints.label.minLength} characters`);
        }
      }
    }

    // Validate weight
    if ('weight' in nodeConfig) {
      if (constraints.weight) {
        if (typeof nodeConfig.weight !== 'number') {
          errors.push('Field "weight" must be a number');
        } else if (
          nodeConfig.weight < constraints.weight.min ||
          nodeConfig.weight > constraints.weight.max
        ) {
          errors.push(
            `Field "weight" must be between ${constraints.weight.min} and ${constraints.weight.max}`
          );
        }
      }
    }

    // Validate metadata if present
    if ('metadata' in nodeConfig && nodeConfig.metadata) {
      if (typeof nodeConfig.metadata !== 'object') {
        errors.push('Field "metadata" must be an object');
      }
    }
  }

  /**
   * Throw validation error if config is invalid.
   * Shorthand for validate() + throw.
   * 
   * @param {Object} nodeConfig - Node configuration
   * @throws {Error} If validation fails
   */
  validateOrThrow(nodeConfig) {
    const result = this.validate(nodeConfig);
    if (!result.valid) {
      throw new Error(`Validation failed: ${result.errors.join('; ')}`);
    }
    return result;
  }
}

/**
 * Check if a type string is valid.
 * 
 * @param {string} type - Type string to check
 * @returns {boolean} True if valid
 */
function isValidType(type) {
  return typeof type === 'string' && type in SCHEMAS;
}

/**
 * Get schema for a type.
 * 
 * @param {string} type - Node type
 * @returns {Object} Schema object
 * @throws {Error} If type invalid
 */
function getSchema(type) {
  if (!isValidType(type)) {
    throw new Error(`Invalid node type: "${type}"`);
  }

  return JSON.parse(JSON.stringify(SCHEMAS[type]));
}

/**
 * Get all valid types.
 * 
 * @returns {string[]} Array of type names
 */
function getValidTypes() {
  return Object.keys(SCHEMAS);
}

/**
 * Type predicate: check if node is a concept.
 * 
 * @param {Object} node - Node to check
 * @returns {boolean} True if node.type === 'concept'
 */
function isConcept(node) {
  return (node && node.type === 'concept') ? true : false;
}

/**
 * Type predicate: check if node is an entity.
 * 
 * @param {Object} node - Node to check
 * @returns {boolean} True if node.type === 'entity'
 */
function isEntity(node) {
  return (node && node.type === 'entity') ? true : false;
}

/**
 * Type predicate: check if node is an event.
 * 
 * @param {Object} node - Node to check
 * @returns {boolean} True if node.type === 'event'
 */
function isEvent(node) {
  return (node && node.type === 'event') ? true : false;
}

/**
 * Type predicate: check if node is a relationship.
 * 
 * @param {Object} node - Node to check
 * @returns {boolean} True if node.type === 'relationship'
 */
function isRelationship(node) {
  return (node && node.type === 'relationship') ? true : false;
}

/**
 * Type predicate: check if node is an attribute.
 * 
 * @param {Object} node - Node to check
 * @returns {boolean} True if node.type === 'attribute'
 */
function isAttribute(node) {
  return (node && node.type === 'attribute') ? true : false;
}

// Export public API
module.exports = {
  TypeClassifier,
  SCHEMAS,
  isValidType,
  getSchema,
  getValidTypes,
  isConcept,
  isEntity,
  isEvent,
  isRelationship,
  isAttribute,
};
