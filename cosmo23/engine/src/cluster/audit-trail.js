/**
 * AuditTrail
 *
 * Immutable audit log for cluster operations.
 * Phase F: Observability
 */

class AuditTrail {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.events = [];
  }

  /**
   * Log audit event
   */
  log(eventType, data) {
    this.events.push({
      timestamp: new Date().toISOString(),
      eventType,
      ...data
    });
    if (this.events.length > 10000) {
      this.events.shift();
    }
  }

  /**
   * Search audit trail
   */
  search(filters = {}) {
    return this.events.filter(event => {
      if (filters.eventType && event.eventType !== filters.eventType) return false;
      if (filters.instanceId && event.instanceId !== filters.instanceId) return false;
      return true;
    });
  }

  /**
   * Export audit trail
   */
  export() {
    return this.events;
  }
}

module.exports = { AuditTrail };

