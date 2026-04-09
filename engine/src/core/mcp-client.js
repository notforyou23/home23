const fetch = require('node-fetch');
const { spawn } = require('child_process');
const readline = require('readline');
const path = require('path');

/**
 * MCP Client - Call remote MCP servers as tools
 * 
 * Follows OpenAI Responses API pattern for MCP tool integration.
 * Supports both HTTP POST and external process (stdio) transports.
 * 
 * Transport Types:
 *   - http: HTTP POST to URL (existing behavior)
 *   - external_process: Spawn process and communicate via stdio (new)
 * 
 * Usage:
 *   const client = new MCPClient(serverConfig, logger);
 *   const tools = await client.listTools();
 *   const result = await client.callTool('tool_name', { arg1: 'value' });
 */
class MCPClient {
  constructor(serverConfig, logger) {
    this.config = serverConfig;
    this.logger = logger;
    this.timeout = serverConfig.timeout || 30000;
    this.type = serverConfig.type || 'http'; // Default to 'http' for backward compatibility
    
    // For external process servers
    this.process = null;
    this.messageQueue = [];
    this.pendingRequests = new Map(); // requestId -> {resolve, reject}
    this.nextRequestId = 1;
    
    // Validate required fields based on type
    if (this.type === 'http') {
      if (!serverConfig.url) {
        throw new Error('MCP server URL is required for HTTP transport');
      }
    } else if (this.type === 'external_process') {
      if (!serverConfig.command) {
        throw new Error('Command is required for external_process transport');
      }
      // Start external process
      this.startExternalProcess();
    } else {
      throw new Error(`Unsupported MCP transport type: ${this.type}`);
    }
  }

  /**
   * Start external process server
   * @private
   */
  startExternalProcess() {
    const { command, args = [], env = {} } = this.config;
    
    this.logger?.info('Starting external MCP server', {
      label: this.config.label,
      command,
      args
    });
    
    try {
      // Spawn process with combined environment
      this.process = spawn(command, args, {
        env: { ...process.env, ...env },
        stdio: ['pipe', 'pipe', 'inherit'] // stdin, stdout, stderr
      });
      
      // Setup readline to parse JSON-RPC messages from stdout
      const rl = readline.createInterface({
        input: this.process.stdout,
        crlfDelay: Infinity
      });
      
      rl.on('line', (line) => {
        try {
          const message = JSON.parse(line);
          this.handleMessage(message);
        } catch (error) {
          this.logger?.warn('Failed to parse MCP message', {
            server: this.config.label,
            line,
            error: error.message
          });
        }
      });
      
      // Handle process errors
      this.process.on('error', (error) => {
        this.logger?.error('External MCP process error', {
          server: this.config.label,
          error: error.message
        });
      });
      
      // Handle process exit
      this.process.on('exit', (code, signal) => {
        this.logger?.warn('External MCP process exited', {
          server: this.config.label,
          code,
          signal
        });
        this.process = null;
      });
      
    } catch (error) {
      this.logger?.error('Failed to start external MCP server', {
        server: this.config.label,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Handle message from external process
   * @private
   */
  handleMessage(message) {
    if (message.id && this.pendingRequests.has(message.id)) {
      const { resolve, reject } = this.pendingRequests.get(message.id);
      this.pendingRequests.delete(message.id);
      
      if (message.error) {
        reject(new Error(message.error.message || 'MCP server error'));
      } else {
        resolve(message);
      }
    }
  }

  /**
   * Send request to external process
   * @private
   */
  async sendToProcess(payload) {
    if (!this.process) {
      throw new Error(`External MCP process not running: ${this.config.label}`);
    }
    
    return new Promise((resolve, reject) => {
      const requestId = this.nextRequestId++;
      const message = {
        jsonrpc: '2.0',
        id: requestId,
        ...payload
      };
      
      // Setup timeout
      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`MCP request timeout after ${this.timeout}ms`));
      }, this.timeout);
      
      // Store promise handlers
      this.pendingRequests.set(requestId, {
        resolve: (response) => {
          clearTimeout(timeoutId);
          resolve(response);
        },
        reject: (error) => {
          clearTimeout(timeoutId);
          reject(error);
        }
      });
      
      // Send message
      try {
        this.process.stdin.write(JSON.stringify(message) + '\n');
      } catch (error) {
        clearTimeout(timeoutId);
        this.pendingRequests.delete(requestId);
        reject(error);
      }
    });
  }

  /**
   * Cleanup external process
   */
  async cleanup() {
    if (this.process) {
      this.logger?.info('Stopping external MCP server', {
        label: this.config.label
      });
      
      this.process.kill('SIGTERM');
      this.process = null;
    }
  }

  /**
   * List available tools from the MCP server
   */
  async listTools() {
    try {
      const response = await this.makeRequest({
        method: 'tools/list'
      });

      if (response.result && response.result.tools) {
        return response.result.tools;
      }

      // Handle different response formats
      if (Array.isArray(response.tools)) {
        return response.tools;
      }

      this.logger?.warn('Unexpected tools list response format', { response });
      return [];
    } catch (error) {
      this.logger?.error('Failed to list MCP tools', {
        server: this.config.label,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Call a tool on the MCP server
   * @param {string} name - Tool name
   * @param {object} args - Tool arguments
   */
  async callTool(name, args = {}) {
    try {
      // Enforce path restrictions if configured
      if (this.config.allowedPaths && Array.isArray(this.config.allowedPaths)) {
        // Check if this is a file operation
        if (name === 'read_file' || name === 'list_directory') {
          const requestedPath = args.path || '';
          
          // Get the COSMO root directory (assuming config.yaml is in src/)
          const cosmoRoot = path.resolve(__dirname, '..', '..');
          
          // Resolve the requested path (supports both absolute and relative)
          const resolvedRequested = path.isAbsolute(requestedPath)
            ? path.resolve(requestedPath)
            : path.resolve(cosmoRoot, requestedPath);
          
          // Check if path is allowed
          const isAllowed = this.config.allowedPaths.some(allowedPath => {
            // Resolve allowed path (supports both absolute and COSMO-relative paths)
            const resolvedAllowed = path.isAbsolute(allowedPath)
              ? path.resolve(allowedPath)
              : path.resolve(cosmoRoot, allowedPath);
            
            return resolvedRequested.startsWith(resolvedAllowed);
          });
          
          if (!isAllowed) {
            this.logger?.warn('MCP path access denied', {
              server: this.config.label,
              tool: name,
              requestedPath,
              allowedPaths: this.config.allowedPaths
            });
            throw new Error(`Access denied: ${requestedPath} not in allowed paths`);
          }
        }
      }
      
      const response = await this.makeRequest({
        method: 'tools/call',
        params: {
          name,
          arguments: args
        }
      });

      if (response.result) {
        return response.result;
      }

      return response;
    } catch (error) {
      this.logger?.error('Failed to call MCP tool', {
        server: this.config.label,
        tool: name,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Make request to MCP server (routes to appropriate transport)
   * Supports both HTTP and external process (stdio) transports.
   */
  async makeRequest(payload) {
    if (this.type === 'external_process') {
      return await this.sendToProcess(payload);
    } else {
      return await this.makeHTTPRequest(payload);
    }
  }

  /**
   * Make HTTP request to MCP server
   * Supports both JSON-RPC and direct HTTP formats
   * @private
   */
  async makeHTTPRequest(payload) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      // Prepare request
      const url = this.config.url;
      const headers = {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream'
      };

      // Add authorization if configured
      if (this.config.auth) {
        headers['Authorization'] = `Bearer ${this.config.auth}`;
      }

      // Make request
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: Date.now(),
          ...payload
        }),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      // Parse response - handle both JSON and SSE formats
      const contentType = response.headers.get('content-type') || '';
      let data;
      
      if (contentType.includes('text/event-stream')) {
        // Parse SSE format: event: message\ndata: {...}
        const text = await response.text();
        const dataMatch = text.match(/data: ({.*})/);
        if (dataMatch) {
          data = JSON.parse(dataMatch[1]);
        } else {
          throw new Error('Invalid SSE response format');
        }
      } else {
        // Standard JSON response
        data = await response.json();
      }

      // Check for JSON-RPC error
      if (data.error) {
        throw new Error(data.error.message || 'MCP server returned an error');
      }

      return data;
    } catch (error) {
      clearTimeout(timeoutId);
      
      if (error.name === 'AbortError') {
        throw new Error(`MCP request timeout after ${this.timeout}ms`);
      }
      
      throw error;
    }
  }

  /**
   * Check if a specific tool is available
   */
  async hasTool(toolName) {
    try {
      const tools = await this.listTools();
      return tools.some(t => t.name === toolName);
    } catch (error) {
      return false;
    }
  }

  /**
   * Get tool definition by name
   */
  async getTool(toolName) {
    try {
      const tools = await this.listTools();
      return tools.find(t => t.name === toolName);
    } catch (error) {
      return null;
    }
  }
}

module.exports = { MCPClient };

