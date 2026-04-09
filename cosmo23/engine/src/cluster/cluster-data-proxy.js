/**
 * Cluster Data Proxy
 * 
 * Provides unified access to cluster data for dashboard endpoints.
 * Routes requests to appropriate sources (hive dashboard, individual instances, or cluster store).
 */

const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');

class ClusterDataProxy {
  constructor(runMetadata, runDir, logger = console) {
    this.metadata = runMetadata;
    this.runDir = runDir;
    this.logger = logger;
    
    // Extract cluster configuration
    this.clusterEnabled = runMetadata?.clusterEnabled || false;
    this.clusterSize = runMetadata?.clusterSize || 1;
    this.clusterBackend = runMetadata?.clusterBackend || 'none';
    this.hiveDashboardPort = runMetadata?.clusterDashboardPort || 3360;
    this.baseDashboardPort = 3343; // Standard base port for instances
  }

  isClusterRun() {
    return this.clusterEnabled && this.clusterSize > 1;
  }

  /**
   * Check if hive dashboard is accessible
   */
  async isHiveAvailable() {
    if (!this.isClusterRun()) return false;
    
    try {
      const response = await fetch(`http://localhost:${this.hiveDashboardPort}/api/cluster/overview`, {
        signal: AbortSignal.timeout(1000)
      });
      return response.ok;
    } catch (error) {
      return false;
    }
  }

  /**
   * Check if individual instance dashboard is accessible
   */
  async isInstanceAvailable(instanceNumber) {
    const port = this.baseDashboardPort + instanceNumber - 1;
    try {
      const response = await fetch(`http://localhost:${port}/api/state`, {
        signal: AbortSignal.timeout(1000)
      });
      return response.ok;
    } catch (error) {
      return false;
    }
  }

  /**
   * Get aggregated memory from hive dashboard
   */
  async getAggregatedMemory() {
    if (!this.isClusterRun()) return null;

    const hiveAvailable = await this.isHiveAvailable();
    if (!hiveAvailable) {
      this.logger.warn('[ClusterDataProxy] Hive dashboard not available for memory aggregation');
      return null;
    }

    try {
      const response = await fetch(`http://localhost:${this.hiveDashboardPort}/api/cluster/memory`);
      const data = await response.json();
      
      // Transform hive format to Intelligence Dashboard format
      // Merge all instance memory graphs with instance tags
      const allNodes = [];
      const allEdges = [];
      
      if (data.byInstance) {
        for (const [instanceId, instanceData] of Object.entries(data.byInstance)) {
          if (instanceData.nodes) {
            instanceData.nodes.forEach(node => {
              allNodes.push({
                ...node,
                instanceId // Tag with source instance
              });
            });
          }
          if (instanceData.edges) {
            instanceData.edges.forEach(edge => {
              allEdges.push({
                ...edge,
                instanceId
              });
            });
          }
        }
      }

      return {
        nodes: allNodes,
        edges: allEdges,
        clusterMetadata: {
          totalNodes: data.totalNodes || allNodes.length,
          totalEdges: data.totalEdges || allEdges.length,
          instanceCount: this.clusterSize,
          byInstance: data.byInstance
        }
      };
    } catch (error) {
      this.logger.error('[ClusterDataProxy] Failed to get aggregated memory:', error.message);
      return null;
    }
  }

  /**
   * Get memory for specific instance
   */
  async getInstanceMemory(instanceNumber) {
    if (!this.isClusterRun()) return null;
    
    const port = this.baseDashboardPort + instanceNumber - 1;
    const available = await this.isInstanceAvailable(instanceNumber);
    
    if (!available) {
      this.logger.warn(`[ClusterDataProxy] Instance ${instanceNumber} dashboard not available`);
      return null;
    }

    try {
      const response = await fetch(`http://localhost:${port}/api/memory`);
      return await response.json();
    } catch (error) {
      this.logger.error(`[ClusterDataProxy] Failed to get instance ${instanceNumber} memory:`, error.message);
      return null;
    }
  }

  /**
   * Get aggregated thoughts from hive dashboard
   */
  async getAggregatedThoughts(limit = 100) {
    if (!this.isClusterRun()) return null;

    const hiveAvailable = await this.isHiveAvailable();
    if (!hiveAvailable) {
      this.logger.warn('[ClusterDataProxy] Hive dashboard not available for thought aggregation');
      return null;
    }

    try {
      const response = await fetch(`http://localhost:${this.hiveDashboardPort}/api/cluster/thoughts?limit=${limit}`);
      return await response.json();
    } catch (error) {
      this.logger.error('[ClusterDataProxy] Failed to get aggregated thoughts:', error.message);
      return null;
    }
  }

  /**
   * Get thoughts for specific instance
   */
  async getInstanceThoughts(instanceNumber, limit = 100) {
    if (!this.isClusterRun()) return null;
    
    const port = this.baseDashboardPort + instanceNumber - 1;
    const available = await this.isInstanceAvailable(instanceNumber);
    
    if (!available) {
      return null;
    }

    try {
      const response = await fetch(`http://localhost:${port}/api/thoughts?limit=${limit}`);
      return await response.json();
    } catch (error) {
      this.logger.error(`[ClusterDataProxy] Failed to get instance ${instanceNumber} thoughts:`, error.message);
      return null;
    }
  }

  /**
   * Get aggregated state from hive dashboard
   */
  async getAggregatedState() {
    if (!this.isClusterRun()) return null;

    const hiveAvailable = await this.isHiveAvailable();
    if (!hiveAvailable) {
      this.logger.warn('[ClusterDataProxy] Hive dashboard not available for state aggregation');
      return null;
    }

    try {
      const response = await fetch(`http://localhost:${this.hiveDashboardPort}/api/cluster/stats`);
      const stats = await response.json();
      
      // Build pseudo-state that matches single-instance format
      return {
        isCluster: true,
        clusterSize: this.clusterSize,
        clusterBackend: this.clusterBackend,
        hiveDashboardPort: this.hiveDashboardPort,
        instances: stats.instances || [],
        cycleCount: stats.instances?.[0]?.cycles || 0, // Use first instance's cycle
        runMetadata: this.metadata
      };
    } catch (error) {
      this.logger.error('[ClusterDataProxy] Failed to get aggregated state:', error.message);
      return null;
    }
  }

  /**
   * Get state for specific instance
   */
  async getInstanceState(instanceNumber) {
    if (!this.isClusterRun()) return null;
    
    const port = this.baseDashboardPort + instanceNumber - 1;
    const available = await this.isInstanceAvailable(instanceNumber);
    
    if (!available) {
      return null;
    }

    try {
      const response = await fetch(`http://localhost:${port}/api/state`);
      const state = await response.json();
      return {
        ...state,
        instanceId: `cosmo-${instanceNumber}`,
        dashboardPort: port
      };
    } catch (error) {
      this.logger.error(`[ClusterDataProxy] Failed to get instance ${instanceNumber} state:`, error.message);
      return null;
    }
  }

  /**
   * Get cluster overview (instance health, status, etc)
   */
  async getClusterOverview() {
    if (!this.isClusterRun()) return null;

    const hiveAvailable = await this.isHiveAvailable();
    if (!hiveAvailable) {
      return null;
    }

    try {
      const response = await fetch(`http://localhost:${this.hiveDashboardPort}/api/cluster/overview`);
      return await response.json();
    } catch (error) {
      this.logger.error('[ClusterDataProxy] Failed to get cluster overview:', error.message);
      return null;
    }
  }
}

module.exports = { ClusterDataProxy };

