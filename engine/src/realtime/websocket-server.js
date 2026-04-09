/**
 * COSMO Real-time WebSocket Server
 *
 * Streams COSMO's cognitive activity to connected clients in real-time.
 * Subscribes to the singleton event emitter and broadcasts events.
 *
 * Usage:
 *   const { RealtimeServer } = require('./realtime/websocket-server');
 *   const server = new RealtimeServer(3400, logger);
 *   await server.start();
 */

const WebSocket = require('ws');
const http = require('http');
const { cosmoEvents } = require('./event-emitter');

class RealtimeServer {
  constructor(port = 3400, logger = null) {
    this.port = port;
    this.logger = logger || console;
    this.wss = null;
    this.httpServer = null;
    this.clients = new Set();
    this.eventListener = null;
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
          if (req.url === '/health') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              status: 'healthy',
              uptime: Date.now() - this.stats.startTime,
              clients: this.clients.size,
              eventsBroadcast: this.stats.eventsBroadcast
            }));
            return;
          }

          // Stats endpoint
          if (req.url === '/stats') {
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

        // Subscribe to COSMO events
        this.eventListener = (event) => {
          this.broadcast(event);
        };
        cosmoEvents.on('*', this.eventListener);

        // Start listening
        this.httpServer.listen(this.port, () => {
          this.stats.startTime = Date.now();
          this.logger.info?.('🌐 COSMO Realtime WebSocket server started', {
            port: this.port,
            wsUrl: `ws://localhost:${this.port}`,
            healthUrl: `http://localhost:${this.port}/health`
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
   * Handle new WebSocket connection
   */
  handleConnection(ws, req) {
    const clientId = `client_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Track client
    const clientInfo = {
      id: clientId,
      ws,
      connectedAt: Date.now(),
      ip: req.socket.remoteAddress,
      subscriptions: new Set(['*']), // Default: receive all events
      messageCount: 0
    };
    this.clients.add(clientInfo);
    this.stats.clientsConnected++;

    this.logger.info?.('📱 Client connected to realtime stream', {
      clientId,
      totalClients: this.clients.size
    });

    // Send welcome message
    this.sendToClient(clientInfo, {
      type: 'connected',
      clientId,
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
        'web_search', 'code_generation', 'insights_extracted'
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
      this.clients.delete(clientInfo);
      this.stats.clientsDisconnected++;
      this.logger.info?.('📴 Client disconnected from realtime stream', {
        clientId,
        duration: Date.now() - clientInfo.connectedAt,
        messagesReceived: clientInfo.messageCount,
        remainingClients: this.clients.size
      });
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
   * Broadcast event to all subscribed clients
   */
  broadcast(event) {
    if (this.clients.size === 0) return;

    this.stats.eventsBroadcast++;
    const message = JSON.stringify(event);

    for (const clientInfo of this.clients) {
      // Check if client is subscribed to this event type
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
    const emitterStats = cosmoEvents.getStats();
    return {
      server: {
        port: this.port,
        uptime: this.stats.startTime ? Date.now() - this.stats.startTime : 0,
        connectedClients: this.clients.size,
        totalConnections: this.stats.clientsConnected,
        totalDisconnections: this.stats.clientsDisconnected,
        eventsBroadcast: this.stats.eventsBroadcast
      },
      emitter: emitterStats,
      clients: Array.from(this.clients).map(c => ({
        id: c.id,
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
      // Remove event listener
      if (this.eventListener) {
        cosmoEvents.off('*', this.eventListener);
      }

      // Close all client connections
      for (const clientInfo of this.clients) {
        clientInfo.ws.close(1001, 'Server shutting down');
      }
      this.clients.clear();

      // Close WebSocket server
      if (this.wss) {
        this.wss.close(() => {
          // Close HTTP server
          if (this.httpServer) {
            this.httpServer.close(() => {
              this.logger.info?.('🌐 COSMO Realtime WebSocket server stopped');
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
