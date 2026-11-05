/**
 * Environment Interface
 * Extensible sensors and actuators for world interaction
 * From: "Environmental Feedback and Embodied Interaction" section
 */
class EnvironmentInterface {
  constructor(config, logger) {
    this.config = config.environment;
    this.logger = logger;
    
    this.sensors = new Map();
    this.actuators = new Map();
    this.observations = [];
    this.actions = [];
    
    this.initializeSensors();
    this.initializeActuators();
  }

  /**
   * Initialize sensors from config
   */
  initializeSensors() {
    if (!this.config.sensorsEnabled || !this.config.sensors) return;

    for (const sensorConfig of this.config.sensors) {
      if (!sensorConfig.enabled) continue;

      this.sensors.set(sensorConfig.name, {
        name: sensorConfig.name,
        type: sensorConfig.type,
        pollInterval: sensorConfig.pollInterval || 600,
        lastPoll: null,
        handler: this.getSensorHandler(sensorConfig.name, sensorConfig.type)
      });
    }

    this.logger?.info('Sensors initialized', { count: this.sensors.size });
  }

  /**
   * Initialize actuators from config
   */
  initializeActuators() {
    if (!this.config.actuators) return;

    for (const actuatorConfig of this.config.actuators) {
      if (!actuatorConfig.enabled) continue;

      this.actuators.set(actuatorConfig.name, {
        name: actuatorConfig.name,
        type: actuatorConfig.type,
        handler: this.getActuatorHandler(actuatorConfig.name, actuatorConfig.type)
      });
    }

    this.logger?.info('Actuators initialized', { count: this.actuators.size });
  }

  /**
   * Get sensor handler function
   */
  getSensorHandler(name, type) {
    switch (name) {
      case 'system_time':
        return () => this.senseTime();
      
      case 'memory_stats':
        return () => this.senseMemoryStats();
      
      case 'web_search':
        return (query) => this.senseWebSearch(query);
      
      default:
        return () => ({ sensor: name, value: null, timestamp: new Date() });
    }
  }

  /**
   * Get actuator handler function
   */
  getActuatorHandler(name, type) {
    switch (name) {
      case 'log_insight':
        return (data) => this.actuateLogInsight(data);
      
      case 'web_search':
        return (query) => this.actuateWebSearch(query);
      
      default:
        return (data) => this.logger?.info(`Actuator ${name}`, { data });
    }
  }

  /**
   * Poll all sensors
   */
  async pollSensors() {
    const observations = [];

    for (const [name, sensor] of this.sensors) {
      const now = Date.now();
      const timeSinceLastPoll = sensor.lastPoll 
        ? (now - sensor.lastPoll.getTime()) / 1000 
        : Infinity;

      if (timeSinceLastPoll >= sensor.pollInterval) {
        try {
          const observation = await sensor.handler();
          observation.sensor = name;
          observation.timestamp = new Date();
          
          observations.push(observation);
          this.observations.push(observation);
          
          sensor.lastPoll = new Date();
          
          this.logger?.debug('Sensor polled', { sensor: name });
        } catch (error) {
          this.logger?.error('Sensor poll failed', { sensor: name, error: error.message });
        }
      }
    }

    // Keep last 100 observations
    if (this.observations.length > 100) {
      this.observations = this.observations.slice(-100);
    }

    return observations;
  }

  /**
   * Execute an actuator
   */
  async executeActuator(actuatorName, data) {
    const actuator = this.actuators.get(actuatorName);
    
    if (!actuator) {
      this.logger?.warn('Actuator not found', { actuatorName });
      return null;
    }

    try {
      const result = await actuator.handler(data);
      
      this.actions.push({
        actuator: actuatorName,
        data,
        result,
        timestamp: new Date()
      });

      // Keep last 100 actions
      if (this.actions.length > 100) {
        this.actions.shift();
      }

      this.logger?.debug('Actuator executed', { actuator: actuatorName });

      return result;
    } catch (error) {
      this.logger?.error('Actuator execution failed', { 
        actuator: actuatorName, 
        error: error.message 
      });
      return null;
    }
  }

  /**
   * Sensor: System time
   */
  senseTime() {
    const now = new Date();
    
    return {
      value: {
        timestamp: now.toISOString(),
        hour: now.getHours(),
        dayOfWeek: now.getDay(),
        timeOfDay: this.getTimeOfDay(now.getHours())
      },
      type: 'temporal'
    };
  }

  /**
   * Sensor: Memory statistics
   */
  senseMemoryStats() {
    const usage = process.memoryUsage();
    
    return {
      value: {
        heapUsed: Math.round(usage.heapUsed / 1024 / 1024),
        heapTotal: Math.round(usage.heapTotal / 1024 / 1024),
        rss: Math.round(usage.rss / 1024 / 1024)
      },
      type: 'system',
      unit: 'MB'
    };
  }

  /**
   * Sensor: Web search (stub - would integrate real API)
   */
  async senseWebSearch(query) {
    // This is a stub - in real implementation would call search API
    this.logger?.info('Web search sensor called', { query });
    
    return {
      value: {
        query,
        results: [],
        note: 'Web search not implemented - stub only'
      },
      type: 'external'
    };
  }

  /**
   * Actuator: Log insight
   */
  actuateLogInsight(data) {
    this.logger?.info('💡 INSIGHT', { insight: data });
    return { logged: true, timestamp: new Date() };
  }

  /**
   * Actuator: Web search (stub)
   */
  async actuateWebSearch(query) {
    this.logger?.info('Web search actuator called', { query });
    
    return {
      query,
      results: [],
      note: 'Web search not implemented - stub only'
    };
  }

  /**
   * Calculate surprise from observation
   */
  calculateSurprise(observation, expectedValue = null) {
    // Simple surprise: novelty detection
    const recentSimilar = this.observations
      .filter(o => o.sensor === observation.sensor)
      .slice(-10);

    if (recentSimilar.length === 0) {
      return 1.0; // Completely novel
    }

    // Compare with recent observations (very simple heuristic)
    const surprise = 0.3; // Default moderate surprise
    
    return surprise;
  }

  /**
   * Get time of day category
   */
  getTimeOfDay(hour) {
    if (hour >= 5 && hour < 12) return 'morning';
    if (hour >= 12 && hour < 17) return 'afternoon';
    if (hour >= 17 && hour < 21) return 'evening';
    return 'night';
  }

  /**
   * Get recent observations
   */
  getRecentObservations(count = 10) {
    return this.observations.slice(-count);
  }

  /**
   * Get recent actions
   */
  getRecentActions(count = 10) {
    return this.actions.slice(-count);
  }

  /**
   * Get statistics
   */
  getStats() {
    return {
      sensors: {
        total: this.sensors.size,
        active: Array.from(this.sensors.values()).filter(s => s.lastPoll !== null).length
      },
      actuators: {
        total: this.actuators.size
      },
      observations: this.observations.length,
      actions: this.actions.length,
      recentActivity: {
        observations: this.observations.slice(-5).map(o => o.sensor),
        actions: this.actions.slice(-5).map(a => a.actuator)
      }
    };
  }

  /**
   * Export for visualization
   */
  export() {
    return {
      observations: this.observations.slice(-50),
      actions: this.actions.slice(-50),
      sensors: Array.from(this.sensors.keys()),
      actuators: Array.from(this.actuators.keys())
    };
  }
}

module.exports = { EnvironmentInterface };

