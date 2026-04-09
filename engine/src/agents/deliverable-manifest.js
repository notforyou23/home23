/**
 * DeliverableManifest - Standardized provenance tracking for all agent outputs
 * 
 * Purpose:
 * - Every agent deliverable gets a manifest with complete provenance
 * - Files are self-describing (know which goal, mission, cycle they came from)
 * - Coordinator can track canonical versions and superseded outputs
 * - Dashboard can show lineage and relationships
 * 
 * Design:
 * - All agent types use this schema
 * - Backwards compatible (doesn't break existing manifests)
 * - Extensible (agents can add type-specific fields)
 */

class DeliverableManifest {
  /**
   * Create a standardized deliverable manifest
   * 
   * @param {Object} params
   * @param {string} params.agentId - Unique agent ID
   * @param {string} params.agentType - Type of agent (code-creation, document-creation, etc.)
   * @param {Object} params.mission - Complete mission object from agent
   * @param {number} params.spawnCycle - Cycle when agent was spawned
   * @param {number} params.coordinatorReview - Coordinator review that spawned agent
   * @returns {Object} Standardized manifest
   */
  static create({ agentId, agentType, mission, spawnCycle, coordinatorReview }) {
    return {
      // Schema version
      manifestVersion: '2.0.0',
      
      // Core identification
      agentId,
      agentType,
      goalId: mission?.goalId || null,
      missionId: mission?.missionId || null,
      
      // Provenance tracking
      spawnCycle: spawnCycle || null,
      coordinatorReview: coordinatorReview || null,
      spawnedBy: mission?.createdBy || 'meta_coordinator',
      triggerSource: mission?.triggerSource || 'orchestrator',
      spawningReason: mission?.spawningReason || 'goal_execution',
      
      // Timestamps
      createdAt: new Date().toISOString(),
      completedAt: null, // Set when agent completes
      
      // Coordination & versioning
      canonical: false, // Set true by synthesis agent or coordinator selection
      supersedes: [], // Array of agentIds this replaces
      supersededBy: null, // agentId that replaces this (if any)
      
      // Content metadata
      deliverableType: null, // 'code', 'document', 'analysis', 'synthesis', 'execution_results'
      files: [], // List of files in this deliverable
      
      // Integration status
      integrationStatus: 'pending', // pending → reviewed → integrated
      reviewNotes: null,
      
      // Mission context (for reference)
      missionDescription: mission?.description || null,
      missionSuccessCriteria: mission?.successCriteria || []
    };
  }

  /**
   * Load and parse existing manifest from file
   * 
   * @param {string} manifestPath - Path to manifest.json
   * @returns {Promise<Object|null>} Parsed manifest or null if not found/invalid
   */
  static async load(manifestPath) {
    const fs = require('fs').promises;
    
    try {
      const data = await fs.readFile(manifestPath, 'utf8');
      const manifest = JSON.parse(data);
      
      // Basic validation
      if (!manifest.agentId || !manifest.agentType) {
        throw new Error('Invalid manifest: missing required fields');
      }
      
      return manifest;
    } catch (error) {
      if (error.code === 'ENOENT') {
        return null; // File doesn't exist
      }
      throw error;
    }
  }

  /**
   * Save manifest to file
   * 
   * @param {Object} manifest - Manifest object
   * @param {string} outputPath - Path to save manifest.json
   * @param {Object} options - { capabilities?, agentContext? }
   */
  static async save(manifest, outputPath, options = {}) {
    const fs = require('fs').promises;
    const path = require('path');
    
    // Ensure directory exists
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    
    // Write with formatting
    const payload = JSON.stringify(manifest, null, 2);
    
    if (options?.capabilities && options.capabilities.writeFile) {
      const result = await options.capabilities.writeFile(
        path.relative(process.cwd(), outputPath),
        payload,
        options.agentContext || { agentId: manifest?.agentId, agentType: manifest?.agentType, missionGoal: manifest?.goalId }
      );
      
      // Respect Executive skip (do not bypass)
      if (result?.success || result?.skipped) return;
      
      throw new Error(result?.error || result?.reason || 'Failed to write deliverable manifest');
    }
    
    await fs.writeFile(outputPath, payload, 'utf8');
  }

  /**
   * Mark manifest as canonical
   * Updates the manifest file on disk
   * 
   * @param {string} manifestPath - Path to manifest.json
   * @param {string[]} supersedes - Array of agentIds this version supersedes
   */
  static async markCanonical(manifestPath, supersedes = [], options = {}) {
    const manifest = await DeliverableManifest.load(manifestPath);
    if (!manifest) {
      throw new Error(`Manifest not found: ${manifestPath}`);
    }
    
    manifest.canonical = true;
    manifest.supersedes = Array.isArray(supersedes) ? supersedes : [supersedes];
    manifest.canonicalMarkedAt = new Date().toISOString();
    
    await DeliverableManifest.save(manifest, manifestPath, options);
    
    return manifest;
  }

  /**
   * Mark manifest as superseded
   * Updates the manifest file on disk
   * 
   * @param {string} manifestPath - Path to manifest.json
   * @param {string} supersededBy - agentId that replaces this
   */
  static async markSuperseded(manifestPath, supersededBy, options = {}) {
    const manifest = await DeliverableManifest.load(manifestPath);
    if (!manifest) {
      throw new Error(`Manifest not found: ${manifestPath}`);
    }
    
    manifest.canonical = false;
    manifest.supersededBy = supersededBy;
    manifest.supersededAt = new Date().toISOString();
    
    await DeliverableManifest.save(manifest, manifestPath, options);
    
    return manifest;
  }

  /**
   * Validate manifest has all required fields for version 2.0.0
   * 
   * @param {Object} manifest
   * @returns {Object} { valid: boolean, errors: string[] }
   */
  static validate(manifest) {
    const errors = [];
    
    // Required fields
    const required = ['manifestVersion', 'agentId', 'agentType', 'createdAt'];
    for (const field of required) {
      if (!manifest[field]) {
        errors.push(`Missing required field: ${field}`);
      }
    }
    
    // Type checks
    if (manifest.files && !Array.isArray(manifest.files)) {
      errors.push('files must be an array');
    }
    
    if (manifest.supersedes && !Array.isArray(manifest.supersedes)) {
      errors.push('supersedes must be an array');
    }
    
    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * Migrate v1 manifest to v2 format
   * Handles old manifests that don't have full provenance
   * 
   * @param {Object} oldManifest - v1.x manifest
   * @returns {Object} v2.0.0 manifest
   */
  static migrate(oldManifest) {
    // Preserve all existing fields
    const migrated = { ...oldManifest };
    
    // Add v2 fields if missing
    migrated.manifestVersion = '2.0.0';
    
    if (!migrated.canonical) migrated.canonical = false;
    if (!migrated.supersedes) migrated.supersedes = [];
    if (!migrated.supersededBy) migrated.supersededBy = null;
    if (!migrated.integrationStatus) migrated.integrationStatus = 'pending';
    if (!migrated.reviewNotes) migrated.reviewNotes = null;
    
    return migrated;
  }
}

module.exports = { DeliverableManifest };

