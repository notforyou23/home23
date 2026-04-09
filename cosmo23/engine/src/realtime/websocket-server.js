/**
 * COSMO Real-time WebSocket Server
 *
 * Streams COSMO's cognitive activity to connected clients in real-time.
 * Now supports multi-tenant context routing - each client subscribes to
 * a specific context and only receives events for that context.
 *
 * Connection modes:
 * 1. Context-aware: ws://localhost:3400?context=userId_runId
 * 2. Legacy (single-tenant): ws://localhost:3400 (uses default context)
 *
 * Usage:
 *   const { RealtimeServer } = require('./realtime/websocket-server');
 *   const server = new RealtimeServer(3400, logger, { contextId: 'user123_run456' });
 *   await server.start();
 */

const WebSocket = require('ws');
const http = require('http');
const url = require('url');

// Support both old singleton and new context-aware event system
let cosmoEvents = null;
let contextEventRegistry = null;

try {
  // Try new context-aware system first
  const contextEvents = require('./context-events');
  contextEventRegistry = contextEvents.contextEventRegistry;
} catch (e) {
  // Fall back to singleton
}

try {
  // Also load singleton for backward compatibility
  const eventEmitter = require('./event-emitter');
  cosmoEvents = eventEmitter.cosmoEvents;
} catch (e) {
  // May not be available
}

class RealtimeServer {
  /**
   * @param {number} port - WebSocket port
   * @param {Object} logger - Logger instance
   * @param {Object} options - Server options
   * @param {string} options.contextId - Default context ID (for single-tenant mode)
   * @param {boolean} options.legacyMode - Use singleton event emitter (default: auto-detect)
   */
  constructor(port = 3400, logger = null, options = {}) {
    this.port = port;
    this.logger = logger || console;
    this.contextId = options.contextId || null; // Default context for this server
    // Multi-tenant mode: Use context-aware events (engine refactored 2026-01-04)
    // Legacy mode (true) broadcasts ALL events to ALL clients (single-tenant fallback)
    // Context mode (false) routes events by contextId for multi-tenant isolation
    this.legacyMode = options.legacyMode ?? false;

    this.wss = null;
    this.httpServer = null;
    this.clients = new Map(); // ws -> clientInfo (changed from Set for faster lookup)
    this.eventListeners = new Map(); // contextId -> listener function
    this.stats = {
      eventsBroadcast: 0,
      clientsConnected: 0,
      clientsDisconnected: 0,
      startTime: null
    };
  }

  /**
   * Start the WebSocket server
   */
  async start() {
    return new Promise((resolve, reject) => {
      try {
        // Create HTTP server for WebSocket upgrade
        this.httpServer = http.createServer((req, res) => {
          // Health check endpoint
          if (req.url === '/health' || req.url.startsWith('/health?')) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              status: 'healthy',
              uptime: Date.now() - this.stats.startTime,
              clients: this.clients.size,
              eventsBroadcast: this.stats.eventsBroadcast,
              contextId: this.contextId,
              multiTenant: !this.legacyMode
            }));
            return;
          }

          // Stats endpoint
          if (req.url === '/stats' || req.url.startsWith('/stats?')) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(this.getStats()));
            return;
          }

          // Default: not found
          res.writeHead(404);
          res.end('Not found');
        });

        // Create WebSocket server
        this.wss = new WebSocket.Server({ server: this.httpServer });

        // Handle new connections
        this.wss.on('connection', (ws, req) => {
          this.handleConnection(ws, req);
        });

        // Subscribe to events based on mode
        if (this.legacyMode && cosmoEvents) {
          // Legacy: subscribe to singleton emitter
          this._subscribeToContext(null);
        } else if (this.contextId && contextEventRegistry) {
          // Single-context mode: subscribe to specific context
          this._subscribeToContext(this.contextId);
        }
        // Multi-context mode: subscriptions happen per-client

        // Start listening
        this.httpServer.listen(this.port, () => {
          this.stats.startTime = Date.now();
          this.logger.info?.('COSMO Realtime WebSocket server started', {
            port: this.port,
            wsUrl: `ws://localhost:${this.port}`,
            healthUrl: `http://localhost:${this.port}/health`,
            contextId: this.contextId,
            multiTenant: !this.legacyMode
          }) || console.log(`WebSocket server started on port ${this.port}`);
          resolve();
        });

        this.httpServer.on('error', (err) => {
          this.logger.error?.('WebSocket server error', { error: err.message }) ||
            console.error('WebSocket server error:', err);
          reject(err);
        });

      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Subscribe to events for a specific context
   * @private
   */
  _subscribeToContext(contextId) {
    // Don't double-subscribe
    if (this.eventListeners.has(contextId)) return;

    const listener = (event) => {
      this.broadcast(event, contextId);
    };

    if (this.legacyMode || !contextId) {
      // Legacy mode: subscribe to singleton
      if (cosmoEvents) {
        cosmoEvents.on('*', listener);
        this.eventListeners.set(null, listener);
      }
    } else {
      // Context mode: subscribe to specific context
      if (contextEventRegistry) {
        contextEventRegistry.subscribe(contextId, listener);
        this.eventListeners.set(contextId, listener);
      }
    }
  }

  /**
   * Unsubscribe from a context's events
   * @private
   */
  _unsubscribeFromContext(contextId) {
    const listener = this.eventListeners.get(contextId);
    if (!listener) return;

    if (this.legacyMode || !contextId) {
      if (cosmoEvents) {
        cosmoEvents.off('*', listener);
      }
    }
    // For context-aware mode, the registry handles cleanup

    this.eventListeners.delete(contextId);
  }

  /**
   * Handle new WebSocket connection
   * Supports optional authentication via URL query token or Authorization header
   */
  handleConnection(ws, req) {
    const clientId = `client_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Parse context and auth from URL query params
    const parsedUrl = url.parse(req.url, true);
    const clientContextId = parsedUrl.query.context || this.contextId;

    // MULTI-TENANT: Extract auth token for context verification
    // Token can come from URL query or Authorization header
    const authToken = parsedUrl.query.token ||
                      (req.headers['authorization']?.startsWith('Bearer ')
                        ? req.headers['authorization'].slice(7)
                        : null);
    const requestedUserId = parsedUrl.query.userId;

    // If strict auth is enabled and no token provided, reject
    if (this.options?.requireAuth && !authToken) {
      this.logger.warn?.('WebSocket connection rejected: no auth token', {
        ip: req.socket.remoteAddress,
        contextId: clientContextId
      });
      ws.close(4001, 'Authentication required');
      return;
    }

    // Context ownership verification (if context ID includes userId)
    // Format: contextId = "userId_runId"
    // We verify that the requestedUserId matches the context's userId prefix
    if (clientContextId && requestedUserId && clientContextId.includes('_')) {
      const contextOwner = clientContextId.split('_')[0];
      if (contextOwner !== requestedUserId && contextOwner !== 'anon') {
        this.logger.warn?.('WebSocket connection rejected: context ownership mismatch', {
          clientId,
          requestedUserId,
          contextOwner,
          contextId: clientContextId
        });
        ws.close(4003, 'Context access denied');
        return;
      }
    }

    // Track client with auth info
    const clientInfo = {
      id: clientId,
      ws,
      connectedAt: Date.now(),
      ip: req.socket.remoteAddress,
      contextId: clientContextId,
      userId: requestedUserId || null,  // Track userId for context filtering
      authenticated: !!authToken,
      subscriptions: new Set(['*']), // Event type subscriptions (default: all)
      messageCount: 0
    };
    this.clients.set(ws, clientInfo);
    this.stats.clientsConnected++;

    this.logger.info?.('Client connected to realtime stream', {
      clientId,
      contextId: clientContextId,
      totalClients: this.clients.size
    });

    // If client requested a specific context, ensure we're subscribed
    if (clientContextId && !this.legacyMode && contextEventRegistry) {
      this._subscribeToContext(clientContextId);
    }

    // Send welcome message
    this.sendToClient(clientInfo, {
      type: 'connected',
      clientId,
      contextId: clientContextId,
      timestamp: Date.now(),
      message: 'Connected to COSMO realtime stream',
      availableEventTypes: [
        'cycle_start', 'cycle_complete',
        'thought_generated',
        'agent_spawned', 'agent_completed', 'agent_failed',
        'node_created', 'edge_created', 'memory_consolidated',
        'sleep_triggered', 'wake_triggered', 'dream_rewiring', 'dream_started', 'dream_phase', 'sleep_consolidation_complete',
        'cognitive_state_changed', 'cognitive_state_update', 'oscillator_mode_changed',
        'coordinator_review', 'coordinator_phase', 'executive_decision',
        'insight_detected', 'goal_created', 'goal_completed',
        'web_search', 'code_generation', 'insights_extracted',
        'run_status', 'research_complete'
      ]
    });

    // Handle client messages
    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        this.handleClientMessage(clientInfo, message);
      } catch (error) {
        this.sendToClient(clientInfo, {
          type: 'error',
          message: 'Invalid JSON message',
          timestamp: Date.now()
        });
      }
    });

    // Handle disconnection
    ws.on('close', () => {
      this.clients.delete(ws);
      this.stats.clientsDisconnected++;
      this.logger.info?.('Client disconnected from realtime stream', {
        clientId,
        contextId: clientContextId,
        duration: Date.now() - clientInfo.connectedAt,
        messagesReceived: clientInfo.messageCount,
        remainingClients: this.clients.size
      });

      // Check if we should unsubscribe from this context
      // (only if no other clients need it)
      if (clientContextId && !this.legacyMode) {
        let hasOtherClients = false;
        for (const info of this.clients.values()) {
          if (info.contextId === clientContextId) {
            hasOtherClients = true;
            break;
          }
        }
        if (!hasOtherClients && clientContextId !== this.contextId) {
          this._unsubscribeFromContext(clientContextId);
        }
      }
    });

    // Handle errors
    ws.on('error', (error) => {
      this.logger.warn?.('WebSocket client error', {
        clientId,
        error: error.message
      });
    });
  }

  /**
   * Handle messages from clients
   */
  handleClientMessage(clientInfo, message) {
    clientInfo.messageCount++;

    switch (message.type) {
      case 'subscribe':
        // Subscribe to specific event types
        if (Array.isArray(message.events)) {
          clientInfo.subscriptions = new Set(message.events);
          this.sendToClient(clientInfo, {
            type: 'subscribed',
            events: Array.from(clientInfo.subscriptions),
            timestamp: Date.now()
          });
        }
        break;

      case 'unsubscribe':
        // Unsubscribe from specific event types
        if (Array.isArray(message.events)) {
          message.events.forEach(e => clientInfo.subscriptions.delete(e));
          this.sendToClient(clientInfo, {
            type: 'unsubscribed',
            events: message.events,
            remaining: Array.from(clientInfo.subscriptions),
            timestamp: Date.now()
          });
        }
        break;

      case 'switch_context':
        // Switch to a different context (multi-tenant)
        if (message.contextId && !this.legacyMode) {
          const oldContext = clientInfo.contextId;
          clientInfo.contextId = message.contextId;

          // Ensure we're subscribed to new context
          if (contextEventRegistry) {
            this._subscribeToContext(message.contextId);
          }

          this.sendToClient(clientInfo, {
            type: 'context_switched',
            oldContext,
            newContext: message.contextId,
            timestamp: Date.now()
          });

          this.logger.info?.('Client switched context', {
            clientId: clientInfo.id,
            oldContext,
            newContext: message.contextId
          });
        }
        break;

      case 'ping':
        // Respond to ping
        this.sendToClient(clientInfo, {
          type: 'pong',
          timestamp: Date.now(),
          serverUptime: Date.now() - this.stats.startTime
        });
        break;

      case 'get_stats':
        // Send server stats
        this.sendToClient(clientInfo, {
          type: 'stats',
          ...this.getStats()
        });
        break;

      default:
        this.sendToClient(clientInfo, {
          type: 'error',
          message: `Unknown message type: ${message.type}`,
          timestamp: Date.now()
        });
    }
  }

  /**
   * Send message to a specific client
   */
  sendToClient(clientInfo, message) {
    if (clientInfo.ws.readyState === WebSocket.OPEN) {
      try {
        clientInfo.ws.send(JSON.stringify(message));
      } catch (error) {
        this.logger.warn?.('Failed to send to client', {
          clientId: clientInfo.id,
          error: error.message
        });
      }
    }
  }

  /**
   * Broadcast event to subscribed clients
   * @param {Object} event - Event to broadcast
   * @param {string} contextId - Context this event belongs to (null for legacy mode)
   */
  broadcast(event, contextId = null) {
    if (this.clients.size === 0) return;

    this.stats.eventsBroadcast++;
    const message = JSON.stringify(event);
    const eventContextId = event.contextId || contextId;

    for (const clientInfo of this.clients.values()) {
      // Context filtering: only send to clients subscribed to this context
      if (!this.legacyMode && eventContextId) {
        if (clientInfo.contextId !== eventContextId) {
          continue; // Skip clients subscribed to different contexts
        }
      }

      // Event type filtering
      if (clientInfo.subscriptions.has('*') || clientInfo.subscriptions.has(event.type)) {
        if (clientInfo.ws.readyState === WebSocket.OPEN) {
          try {
            clientInfo.ws.send(message);
          } catch (error) {
            this.logger.warn?.('Failed to broadcast to client', {
              clientId: clientInfo.id,
              eventType: event.type,
              error: error.message
            });
          }
        }
      }
    }
  }

  /**
   * Get server statistics
   */
  getStats() {
    const contextStats = {};
    const clientsByContext = {};

    for (const clientInfo of this.clients.values()) {
      const ctx = clientInfo.contextId || 'default';
      clientsByContext[ctx] = (clientsByContext[ctx] || 0) + 1;
    }

    // Get context emitter stats if available
    if (contextEventRegistry && !this.legacyMode) {
      contextStats.registry = contextEventRegistry.getStats();
    }

    // Get legacy emitter stats if in legacy mode
    let emitterStats = {};
    if (this.legacyMode && cosmoEvents) {
      emitterStats = cosmoEvents.getStats();
    }

    return {
      server: {
        port: this.port,
        uptime: this.stats.startTime ? Date.now() - this.stats.startTime : 0,
        connectedClients: this.clients.size,
        totalConnections: this.stats.clientsConnected,
        totalDisconnections: this.stats.clientsDisconnected,
        eventsBroadcast: this.stats.eventsBroadcast,
        contextId: this.contextId,
        legacyMode: this.legacyMode,
        clientsByContext
      },
      emitter: emitterStats,
      contextStats,
      clients: Array.from(this.clients.values()).map(c => ({
        id: c.id,
        contextId: c.contextId,
        connectedAt: c.connectedAt,
        duration: Date.now() - c.connectedAt,
        subscriptions: Array.from(c.subscriptions),
        messagesReceived: c.messageCount
      }))
    };
  }

  /**
   * Stop the WebSocket server
   */
  async stop() {
    return new Promise((resolve) => {
      // Remove all event listeners
      for (const [contextId, listener] of this.eventListeners.entries()) {
        if (this.legacyMode || !contextId) {
          if (cosmoEvents) {
            cosmoEvents.off('*', listener);
          }
        }
      }
      this.eventListeners.clear();

      // Close all client connections
      for (const clientInfo of this.clients.values()) {
        clientInfo.ws.close(1001, 'Server shutting down');
      }
      this.clients.clear();

      // Close WebSocket server
      if (this.wss) {
        this.wss.close(() => {
          // Close HTTP server
          if (this.httpServer) {
            this.httpServer.close(() => {
              this.logger.info?.('COSMO Realtime WebSocket server stopped');
              resolve();
            });
          } else {
            resolve();
          }
        });
      } else {
        resolve();
      }
    });
  }
}

module.exports = { RealtimeServer };
