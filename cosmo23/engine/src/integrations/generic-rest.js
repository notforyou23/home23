/**
 * Generic REST API Integration Handler
 * 
 * Provides a generic handler for REST APIs that don't need custom logic.
 * Can be used as-is or extended for specific services.
 */

class GenericRESTIntegration {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.type = 'rest';
    this.description = config.description || `REST API: ${config.baseURL}`;
    
    // Rate limiting config
    this.rateLimit = config.rateLimit || null;
    
    // Validate required fields
    if (!config.baseURL) {
      throw new Error('REST integration requires baseURL');
    }
  }

  /**
   * Call a REST endpoint
   * 
   * @param {string} method - HTTP method and path (e.g., 'GET /users', 'POST /orders')
   * @param {object} params - Request parameters
   * @returns {Promise<any>} Response data
   */
  async call(method, params = {}) {
    const [httpMethod, ...pathParts] = method.split(' ');
    const path = pathParts.join(' ') || '/';
    
    // Build URL
    let url = `${this.config.baseURL}${path}`;
    
    // Build request options
    const options = {
      method: httpMethod || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...this.config.headers || {}
      }
    };
    
    // Add authentication
    if (this.config.auth) {
      if (this.config.auth.type === 'bearer') {
        options.headers['Authorization'] = `Bearer ${this.config.auth.token}`;
      } else if (this.config.auth.type === 'api_key') {
        if (this.config.auth.in === 'header') {
          options.headers[this.config.auth.name] = this.config.auth.value;
        } else if (this.config.auth.in === 'query') {
          const separator = url.includes('?') ? '&' : '?';
          url += `${separator}${this.config.auth.name}=${this.config.auth.value}`;
        }
      }
    }
    
    // Add body for POST/PUT/PATCH
    if (['POST', 'PUT', 'PATCH'].includes(options.method)) {
      options.body = JSON.stringify(params);
    } else {
      // Add query parameters for GET/DELETE
      if (Object.keys(params).length > 0) {
        const queryString = new URLSearchParams(params).toString();
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}${queryString}`;
      }
    }
    
    // Execute request
    const fetch = require('node-fetch');
    const response = await fetch(url, options);
    
    if (!response.ok) {
      const error = new Error(`HTTP ${response.status}: ${response.statusText}`);
      error.statusCode = response.status;
      error.response = await response.text();
      throw error;
    }
    
    // Parse response
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      return await response.json();
    } else {
      return await response.text();
    }
  }

  /**
   * Get available methods (if documented in config)
   */
  getMethods() {
    return this.config.methods || [];
  }

  /**
   * Health check
   */
  async healthCheck() {
    try {
      const healthPath = this.config.healthCheckPath || '/health';
      await this.call(`GET ${healthPath}`, {});
      return true;
    } catch (error) {
      this.logger?.warn(`Health check failed for ${this.config.baseURL}`, {
        error: error.message
      });
      return false;
    }
  }
}

module.exports = GenericRESTIntegration;

