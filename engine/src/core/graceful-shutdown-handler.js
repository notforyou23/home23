/**
 * GracefulShutdownHandler
 *
 * Phase A: Graceful shutdown with signal handling
 * - Handle SIGINT, SIGTERM, SIGHUP
 * - Save state before exit
 * - Cleanup resources (timers, handles, connections)
 * - Idempotent (safe to call multiple times)
 * - Shutdown timeout (force exit after max time)
 */

class GracefulShutdownHandler {
  constructor(orchestrator, logger, config = {}) {
    this.orchestrator = orchestrator;
    this.logger = logger;
    this.config = config;

    // Shutdown settings
    // CRITICAL: Must be longer than maxAgentWait to allow downloads to complete
    this.shutdownTimeout = config.shutdownTimeoutMs || 180000; // 3 minutes (allows 2min agent wait + 1min cleanup)
    this.isShuttingDown = false;
    this.shutdownComplete = false;
    this.shutdownStartTime = null;
    
    // Signal handlers
    this.signalHandlers = new Map();
    this.registeredSignals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    
    // Cleanup tasks
    this.cleanupTasks = [];
  }

  /**
   * Backward-compatible helper: get active agent IDs from the registry.
   * Some historical registry implementations exposed getActiveAgentIds(), but the current
   * AgentRegistry tracks active IDs via a Set and exposes getActiveAgents()/getActiveCount().
   * This must NEVER throw during shutdown.
   * @param {object|null} registry
   * @returns {string[]}
   */
  getActiveAgentIdsSafe(registry) {
    try {
      if (!registry) return [];

      if (typeof registry.getActiveAgentIds === 'function') {
        const ids = registry.getActiveAgentIds();
        return Array.isArray(ids) ? ids.filter(Boolean) : [];
      }

      // Current AgentRegistry uses a Set of IDs
      if (registry.activeAgents && typeof registry.activeAgents[Symbol.iterator] === 'function') {
        return Array.from(registry.activeAgents).filter(Boolean);
      }

      // Fallback: derive IDs from agent states
      if (typeof registry.getActiveAgents === 'function') {
        const states = registry.getActiveAgents();
        if (!Array.isArray(states)) return [];
        return states
          .map(s => s?.agent?.agentId || s?.agentId || null)
          .filter(Boolean);
      }

      return [];
    } catch (e) {
      return [];
    }
  }

  /**
   * Register signal handlers
   * Call this during orchestrator initialization
   */
  registerHandlers() {
    for (const signal of this.registeredSignals) {
      const handler = this.createSignalHandler(signal);
      this.signalHandlers.set(signal, handler);
      process.on(signal, handler);
      
      this.logger.info(`[GracefulShutdown] Registered handler for ${signal}`);
    }
  }

  /**
   * Create signal handler for a specific signal
   */
  createSignalHandler(signal) {
    return async () => {
      this.logger.info(`[GracefulShutdown] Received ${signal}`);
      
      // Prevent multiple shutdown attempts
      if (this.isShuttingDown) {
        this.logger.warn(`[GracefulShutdown] Already shutting down, ignoring ${signal}`);
        return;
      }

      await this.shutdown(signal);
    };
  }

  /**
   * Perform graceful shutdown
   * @param {string} trigger - what triggered shutdown (signal name or 'manual')
   */
  async shutdown(trigger = 'manual') {
    // Idempotency check
    if (this.shutdownComplete) {
      this.logger.info('[GracefulShutdown] Already completed, skipping');
      return;
    }

    if (this.isShuttingDown) {
      this.logger.warn('[GracefulShutdown] Already in progress, waiting...');
      return;
    }

    this.isShuttingDown = true;
    this.shutdownStartTime = Date.now();

    this.logger.info('[GracefulShutdown] Starting graceful shutdown', { trigger });

    // Setup shutdown timeout (force exit)
    const shutdownTimer = setTimeout(() => {
      const elapsed = Date.now() - this.shutdownStartTime;
      this.logger.error('[GracefulShutdown] Timeout exceeded, forcing exit', {
        timeoutMs: this.shutdownTimeout,
        elapsedMs: elapsed
      });
      process.exit(1);
    }, this.shutdownTimeout);

    try {
      // Step 0: Wait for active agents before stopping orchestrator
      this.logger.info('[GracefulShutdown] Checking for active agents...');
      const activeCount = this.orchestrator.agentExecutor?.registry?.getActiveCount() || 0;
      
      if (activeCount > 0) {
        this.logger.info(`[GracefulShutdown] Waiting for ${activeCount} active agent(s) to complete...`);
        
        // Signal agents that shutdown is in progress (they can prioritize finishing)
        if (this.orchestrator.agentExecutor?.registry) {
          const activeAgents = this.orchestrator.agentExecutor.registry.getActiveAgents();
          for (const {agent} of activeAgents) {
            if (agent && typeof agent.onShutdownSignal === 'function') {
              try {
                agent.onShutdownSignal();
              } catch (e) {
                // Non-fatal
              }
            }
          }
          this.logger.info('[GracefulShutdown] Shutdown signal sent to active agents');
        }
        
        const maxAgentWait = this.config.agentWaitTimeoutMs || 150000; // 2.5 minutes (allows for container downloads)
        const startWait = Date.now();
        
        while (this.orchestrator.agentExecutor?.registry?.getActiveCount() > 0) {
          const elapsed = Date.now() - startWait;
          
          if (elapsed > maxAgentWait) {
            const remaining = this.orchestrator.agentExecutor.registry.getActiveCount();
            this.logger.warn(`[GracefulShutdown] Agent wait timeout (${maxAgentWait}ms), forcing shutdown`, {
              remainingAgents: remaining
            });
            
            // Log which agents were interrupted
            const activeAgents = this.getActiveAgentIdsSafe(this.orchestrator.agentExecutor?.registry);
            this.logger.warn('[GracefulShutdown] Interrupted agents:', {
              agentIds: activeAgents,
              note: 'Partial work may be lost'
            });
            break;
          }
          
          // Wait 1 second and check again
          await new Promise(resolve => setTimeout(resolve, 1000));
          
          // Log progress every 10 seconds
          if (elapsed % 10000 < 1000) {
            const remaining = this.orchestrator.agentExecutor.registry.getActiveCount();
            this.logger.info(`[GracefulShutdown] Still waiting... (${remaining} agents, ${Math.round(elapsed/1000)}s elapsed)`);
          }
        }
        
        const finalCount = this.orchestrator.agentExecutor?.registry?.getActiveCount() || 0;
        if (finalCount === 0) {
          this.logger.info('[GracefulShutdown] ✅ All agents completed successfully');
        }
      } else {
        this.logger.info('[GracefulShutdown] No active agents, proceeding immediately');
      }
      
      // Step 1: Stop the orchestrator (stops cognitive loop)
      this.logger.info('[GracefulShutdown] Stopping orchestrator...');
      if (this.orchestrator && typeof this.orchestrator.stop === 'function') {
        await this.orchestrator.stop();
      }

      // Step 2: Save final state
      this.logger.info('[GracefulShutdown] Dumping final state...');
      await this.dumpState();

      // Step 3: Mark clean shutdown (for crash recovery)
      this.logger.info('[GracefulShutdown] Marking clean shutdown...');
      if (this.orchestrator.crashRecovery) {
        await this.orchestrator.crashRecovery.markCleanShutdown();
      }

      // Step 4: Run custom cleanup tasks
      this.logger.info('[GracefulShutdown] Running cleanup tasks...');
      await this.runCleanupTasks();

      // Step 5: Cleanup resources
      this.logger.info('[GracefulShutdown] Cleaning up resources...');
      await this.cleanup();

      // Clear shutdown timer
      clearTimeout(shutdownTimer);

      const elapsed = Date.now() - this.shutdownStartTime;
      this.logger.info('[GracefulShutdown] Shutdown complete', {
        trigger,
        elapsedMs: elapsed
      });

      this.shutdownComplete = true;

      // Exit cleanly
      process.exit(0);
    } catch (error) {
      clearTimeout(shutdownTimer);
      
      const elapsed = Date.now() - this.shutdownStartTime;
      this.logger.error('[GracefulShutdown] Error during shutdown', {
        error: error.message,
        stack: error.stack,
        elapsedMs: elapsed
      });

      // Exit with error code
      process.exit(1);
    }
  }

  /**
   * Dump final state
   */
  async dumpState() {
    try {
      if (this.orchestrator && typeof this.orchestrator.saveState === 'function') {
        await this.orchestrator.saveState();
        this.logger.info('[GracefulShutdown] State dumped successfully');
      } else {
        this.logger.warn('[GracefulShutdown] No saveState method available');
      }
    } catch (error) {
      this.logger.error('[GracefulShutdown] Failed to dump state', { error: error.message });
      throw error; // Re-throw to trigger error shutdown
    }
  }

  /**
   * Cleanup resources
   * - Stop timers
   * - Close connections
   * - Release handles
   */
  async cleanup() {
    const cleanupErrors = [];

    try {
      // Cleanup timeout manager
      if (this.orchestrator.timeoutManager) {
        this.orchestrator.timeoutManager.cleanup();
        this.logger.info('[GracefulShutdown] TimeoutManager cleaned up');
      }

      // Cleanup resource monitor (no active timers, just state)
      if (this.orchestrator.resourceMonitor) {
        this.logger.info('[GracefulShutdown] ResourceMonitor state preserved');
      }

      // Agent executor cleanup
      // NOTE: Agents were already waited for in Step 0 (lines 96-155)
      // This is just final verification
      if (this.orchestrator.agentExecutor) {
        const remainingAgents = this.orchestrator.agentExecutor.registry?.getActiveCount() || 0;
        if (remainingAgents > 0) {
          this.logger.warn('[GracefulShutdown] Agents still active after wait period', {
            count: remainingAgents,
            note: 'Work may be incomplete'
          });
        } else {
          this.logger.info('[GracefulShutdown] Agent executor verified clean');
        }
      }

      // Close TUI dashboard if active
      if (this.orchestrator.tuiDashboard && this.orchestrator.tuiDashboard.screen) {
        this.orchestrator.tuiDashboard.screen.destroy();
        this.logger.info('[GracefulShutdown] TUI dashboard closed');
      }

      // Unregister signal handlers
      for (const [signal, handler] of this.signalHandlers.entries()) {
        process.removeListener(signal, handler);
        this.logger.info(`[GracefulShutdown] Unregistered ${signal} handler`);
      }
      this.signalHandlers.clear();

    } catch (error) {
      cleanupErrors.push(error);
      this.logger.error('[GracefulShutdown] Cleanup error', { error: error.message });
    }

    if (cleanupErrors.length > 0) {
      this.logger.warn('[GracefulShutdown] Cleanup completed with errors', {
        errorCount: cleanupErrors.length
      });
    } else {
      this.logger.info('[GracefulShutdown] Cleanup completed successfully');
    }
  }

  /**
   * Register a custom cleanup task
   * @param {string} name - task name
   * @param {function} task - async function to run on cleanup
   */
  registerCleanupTask(name, task) {
    this.cleanupTasks.push({ name, task });
    this.logger.info(`[GracefulShutdown] Registered cleanup task: ${name}`);
  }

  /**
   * Run all registered cleanup tasks
   */
  async runCleanupTasks() {
    for (const { name, task } of this.cleanupTasks) {
      try {
        this.logger.info(`[GracefulShutdown] Running cleanup task: ${name}`);
        await task();
      } catch (error) {
        this.logger.error(`[GracefulShutdown] Cleanup task failed: ${name}`, {
          error: error.message
        });
      }
    }
  }

  /**
   * Get shutdown stats
   */
  getStats() {
    return {
      isShuttingDown: this.isShuttingDown,
      shutdownComplete: this.shutdownComplete,
      shutdownStartTime: this.shutdownStartTime,
      elapsedMs: this.shutdownStartTime ? Date.now() - this.shutdownStartTime : 0,
      registeredSignals: this.registeredSignals,
      cleanupTasks: this.cleanupTasks.length
    };
  }
}

module.exports = { GracefulShutdownHandler };

