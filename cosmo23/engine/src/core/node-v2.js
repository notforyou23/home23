/**
 * node-v2.js - Immutable Node Structure for COSMO 2.0 Phase 1
 * 
 * Implements completely immutable nodes with type safety and validation.
 * Every node is frozen at creation and cannot be modified.
 * Uses Proxy to enforce strict mutation prevention with errors.
 * 
 * @module core/node-v2
 */

const VALID_TYPES = new Set(['concept', 'entity', 'event', 'relationship', 'attribute']);

/**
 * Node class - Immutable data structure for COSMO nodes
 * 
 * @class Node
 * @property {string} id - Unique identifier
 * @property {string} type - Node type: concept|entity|event|relationship|attribute
 * @property {string} label - Human-readable label
 * @property {number} weight - Importance weight [0.0, 1.0]
 * @property {number} lastUpdated - Unix timestamp (ms) of creation
 * @property {Object} metadata - Additional metadata (frozen)
 */
class Node {
  /**
   * Create an immutable node.
   * 
   * @param {Object} config - Node configuration
   * @param {string} config.id - Unique identifier (required)
   * @param {string} config.type - Node type (required)
   * @param {string} config.label - Human-readable label (required)
   * @param {number} [config.weight=1.0] - Importance weight
   * @param {Object} [config.metadata={}] - Additional data
   * @throws {TypeError} If required fields missing or invalid
   * @throws {Error} If type not valid
   */
  constructor(config) {
    // Validate required fields
    if (!config || typeof config !== 'object') {
      throw new TypeError('Node config must be an object');
    }

    const { id, type, label, weight = 1.0, metadata = {} } = config;

    if (!id || typeof id !== 'string') {
      throw new TypeError('Node.id is required and must be a string');
    }

    if (!type || typeof type !== 'string' || !VALID_TYPES.has(type)) {
      throw new Error(`Invalid node type. Must be one of: ${Array.from(VALID_TYPES).join(', ')}`);
    }

    if (!label || typeof label !== 'string') {
      throw new TypeError('Node.label is required and must be a string');
    }

    if (typeof weight !== 'number' || weight < 0 || weight > 1) {
      throw new TypeError('Node.weight must be a number between 0.0 and 1.0');
    }

    if (typeof metadata !== 'object' || metadata === null) {
      throw new TypeError('Node.metadata must be an object');
    }

    // Set immutable properties using Object.defineProperty
    Object.defineProperty(this, 'id', {
      value: id,
      writable: false,
      enumerable: true,
      configurable: false,
    });

    Object.defineProperty(this, 'type', {
      value: type,
      writable: false,
      enumerable: true,
      configurable: false,
    });

    Object.defineProperty(this, 'label', {
      value: label,
      writable: false,
      enumerable: true,
      configurable: false,
    });

    Object.defineProperty(this, 'weight', {
      value: weight,
      writable: false,
      enumerable: true,
      configurable: false,
    });

    Object.defineProperty(this, 'lastUpdated', {
      value: Date.now(),
      writable: false,
      enumerable: true,
      configurable: false,
    });

    Object.defineProperty(this, 'metadata', {
      value: Object.freeze(JSON.parse(JSON.stringify(metadata))),
      writable: false,
      enumerable: true,
      configurable: false,
    });

    // Freeze the object
    Object.freeze(this);
  }

  /**
   * Create a new node with the same properties but different metadata.
   * Returns a new immutable Node (original is unchanged).
   * 
   * @param {Object} newMetadata - New metadata object
   * @returns {Node} New node with updated metadata
   */
  withMetadata(newMetadata) {
    if (typeof newMetadata !== 'object' || newMetadata === null) {
      throw new TypeError('newMetadata must be an object');
    }

    return new Node({
      id: this.id,
      type: this.type,
      label: this.label,
      weight: this.weight,
      metadata: { ...this.metadata, ...newMetadata },
    });
  }

  /**
   * Create a new node with updated weight.
   * Returns a new immutable Node (original is unchanged).
   * 
   * @param {number} newWeight - New weight value
   * @returns {Node} New node with updated weight
   */
  withWeight(newWeight) {
    if (typeof newWeight !== 'number' || newWeight < 0 || newWeight > 1) {
      throw new TypeError('newWeight must be a number between 0.0 and 1.0');
    }

    return new Node({
      id: this.id,
      type: this.type,
      label: this.label,
      weight: newWeight,
      metadata: this.metadata,
    });
  }

  /**
   * Serialize node to plain object.
   * 
   * @returns {Object} Plain object representation
   */
  toJSON() {
    return {
      id: this.id,
      type: this.type,
      label: this.label,
      weight: this.weight,
      lastUpdated: this.lastUpdated,
      metadata: this.metadata,
    };
  }

  /**
   * Get readable string representation.
   * 
   * @returns {string} String representation
   */
  toString() {
    return `Node(id=${this.id}, type=${this.type}, label="${this.label}")`;
  }
}

/**
 * Factory function to create a new node.
 * 
 * @param {Object} config - Node configuration
 * @returns {Node} Immutable node instance wrapped in Proxy
 * @throws {TypeError|Error} If validation fails
 */
function createNode(config) {
  // Create base node
  const node = new Node(config);
  
  // Wrap in immutability Proxy
  return new Proxy(node, {
    set(target, prop, value) {
      throw new TypeError(`Cannot assign to immutable property "${String(prop)}"`);
    },
    defineProperty(target, prop, descriptor) {
      throw new TypeError(`Cannot define immutable property "${String(prop)}"`);
    },
    deleteProperty(target, prop) {
      throw new TypeError(`Cannot delete immutable property "${String(prop)}"`);
    },
    preventExtensions(target) {
      return true;
    },
    isExtensible(target) {
      return false;
    },
  });
}

/**
 * Check if object is a Node instance.
 * 
 * @param {*} obj - Object to check
 * @returns {boolean} True if obj is a Node instance
 */
function isNode(obj) {
  return obj instanceof Node;
}

/**
 * Get list of valid node types.
 * 
 * @returns {string[]} Array of valid type strings
 */
function getValidTypes() {
  return Array.from(VALID_TYPES);
}

/**
 * Check if a type string is valid.
 * 
 * @param {string} type - Type to validate
 * @returns {boolean} True if type is valid
 */
function isValidType(type) {
  return typeof type === 'string' && VALID_TYPES.has(type);
}

// Export public API
module.exports = {
  Node,
  createNode,
  isNode,
  getValidTypes,
  isValidType,
};
