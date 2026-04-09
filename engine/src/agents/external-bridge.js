/**
 * External Integrations Bridge for Agents
 * 
 * Provides agents with access to external APIs and services.
 * Follows the same pattern as MCPBridge but for outbound integrations.
 * 
 * Design Principles:
 * - Config-driven service registry
 * - Unified error handling and retries
 * - Rate limiting and cost tracking
 * - Easy extension without modifying core code
 * 
 * Usage in agents:
 *   const data = await this.external.call('stripe', 'customers.list', { limit: 10 });
 *   const weather = await this.external.call('weather_api', 'forecast', { city: 'NYC' });
 */

const fs = require('fs').promises;
const path = require('path');

class ExternalBridge {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    
    // Service integrations registry
    this.integrations = new Map();
    
    // Usage tracking
    this.callStats = {
      totalCalls: 0,
      byService: {},
      errors: [],
      lastReset: Date.now()
    };
    
    // Initialize integrations from config
    this.initializeIntegrations();
  }

  /**
   * Initialize integrations from config
   */
  initializeIntegrations() {
    const integrationsConfig = this.config.externalIntegrations || {};
    
    for (const [serviceName, serviceConfig] of Object.entries(integrationsConfig)) {
      if (!serviceConfig.enabled) {
        continue;
      }
      
      try {
        // Load integration handler
        const IntegrationClass = this.loadIntegrationHandler(serviceName, serviceConfig);
        const integration = new IntegrationClass(serviceConfig, this.logger);
        
        this.integrations.set(serviceName, integration);
        
        this.logger?.info(`✅ External integration loaded: ${serviceName}`, {
          type: serviceConfig.type,
          methods: integration.getMethods?.() || []
        });
      } catch (error) {
        this.logger?.error(`❌ Failed to load integration: ${serviceName}`, {
          error: error.message
        });
      }
    }
    
    this.logger?.info('External integrations initialized', {
      count: this.integrations.size,
      services: Array.from(this.integrations.keys())
    });
  }

  /**
   * Load integration handler class
   */
  loadIntegrationHandler(serviceName, serviceConfig) {
    // Try to load from integrations directory
    const handlerPath = path.join(__dirname, '..', 'integrations', `${serviceName}.js`);
    
    try {
      const handler = require(handlerPath);
      return handler;
    } catch (error) {
      // Fallback: Use generic REST/GraphQL handler based on type
      if (serviceConfig.type === 'rest') {
        return require('../integrations/generic-rest');
      } else if (serviceConfig.type === 'graphql') {
        return require('../integrations/generic-graphql');
      } else if (serviceConfig.type === 'grpc') {
        return require('../integrations/generic-grpc');
      }
      
      throw new Error(`No handler found for ${serviceName} (type: ${serviceConfig.type})`);
    }
  }

  /**
   * Call an external service
   * 
   * @param {string} serviceName - Service identifier (e.g., 'stripe', 'salesforce')
   * @param {string} method - Method/endpoint to call (e.g., 'customers.list')
   * @param {object} params - Parameters for the call
   * @param {object} options - Optional: { timeout, retries, priority }
   * @returns {Promise<any>} Response from the service
   */
  async call(serviceName, method, params = {}, options = {}) {
    const integration = this.integrations.get(serviceName);
    
    if (!integration) {
      throw new Error(`External service not configured: ${serviceName}`);
    }
    
    // Track call
    this.callStats.totalCalls++;
    if (!this.callStats.byService[serviceName]) {
      this.callStats.byService[serviceName] = { calls: 0, errors: 0, totalDuration: 0 };
    }
    this.callStats.byService[serviceName].calls++;
    
    const startTime = Date.now();
    
    try {
      // Apply rate limiting if configured
      await this.checkRateLimit(serviceName);
      
      // Execute the call with retry logic
      const result = await this.executeWithRetry(
        () => integration.call(method, params),
        options.retries || 3,
        serviceName,
        method
      );
      
      const duration = Date.now() - startTime;
      this.callStats.byService[serviceName].totalDuration += duration;
      
      this.logger?.debug(`External call succeeded: ${serviceName}.${method}`, {
        duration: `${duration}ms`,
        paramsSize: JSON.stringify(params).length
      }, 3);
      
      return result;
      
    } catch (error) {
      this.callStats.byService[serviceName].errors++;
      this.callStats.errors.push({
        service: serviceName,
        method,
        error: error.message,
        timestamp: new Date().toISOString()
      });
      
      this.logger?.error(`External call failed: ${serviceName}.${method}`, {
        error: error.message,
        params
      });
      
      throw error;
    }
  }

  /**
   * Execute with retry logic
   */
  async executeWithRetry(fn, maxRetries, serviceName, method) {
    let lastError;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        
        // Don't retry on client errors (4xx)
        if (error.statusCode >= 400 && error.statusCode < 500) {
          throw error;
        }
        
        // Wait before retry (exponential backoff)
        if (attempt < maxRetries) {
          const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
          this.logger?.warn(`Retrying ${serviceName}.${method} after ${delay}ms (attempt ${attempt}/${maxRetries})`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }
    
    throw lastError;
  }

  /**
   * Check rate limits
   */
  async checkRateLimit(serviceName) {
    const integration = this.integrations.get(serviceName);
    if (!integration.rateLimit) {
      return; // No rate limit configured
    }
    
    // Simple token bucket implementation
    const limit = integration.rateLimit;
    const stats = this.callStats.byService[serviceName];
    
    if (stats && stats.calls > limit.maxCalls) {
      const timeSinceReset = Date.now() - (stats.lastReset || 0);
      if (timeSinceReset < limit.windowMs) {
        const waitTime = limit.windowMs - timeSinceReset;
        this.logger?.warn(`Rate limit reached for ${serviceName}, waiting ${waitTime}ms`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      } else {
        // Reset counter
        stats.calls = 0;
        stats.lastReset = Date.now();
      }
    }
  }

  /**
   * List available services
   */
  listServices() {
    return Array.from(this.integrations.keys()).map(serviceName => {
      const integration = this.integrations.get(serviceName);
      return {
        name: serviceName,
        type: integration.type,
        methods: integration.getMethods?.() || [],
        description: integration.description || ''
      };
    });
  }

  /**
   * Get usage statistics
   */
  getStats() {
    return {
      ...this.callStats,
      services: Object.entries(this.callStats.byService).map(([service, stats]) => ({
        service,
        calls: stats.calls,
        errors: stats.errors,
        avgDuration: stats.calls > 0 ? Math.round(stats.totalDuration / stats.calls) : 0,
        errorRate: stats.calls > 0 ? (stats.errors / stats.calls * 100).toFixed(2) + '%' : '0%'
      }))
    };
  }

  /**
   * Health check - test all integrations
   */
  async healthCheck() {
    const results = {};
    
    for (const [serviceName, integration] of this.integrations.entries()) {
      try {
        if (integration.healthCheck) {
          const healthy = await integration.healthCheck();
          results[serviceName] = { status: healthy ? 'healthy' : 'degraded' };
        } else {
          results[serviceName] = { status: 'unknown' };
        }
      } catch (error) {
        results[serviceName] = { status: 'unhealthy', error: error.message };
      }
    }
    
    return results;
  }
}

module.exports = { ExternalBridge };

