const fs = require('fs').promises;
const path = require('path');
const { UnifiedClient } = require('../core/unified-client');

/**
 * Topic Queue System
 * User-injectable topic queue for guided exploration
 * 
 * Features:
 * - File-based topic injection (user adds topics to queue file)
 * - API-based injection (programmatic)
 * - Priority management
 * - Status tracking (pending, active, completed)
 * - Integration with goals system
 * - Automatic goal generation from topics
 * 
 * Usage:
 * 1. User adds topics to topics-queue.json
 * 2. System polls file and processes new topics
 * 3. Topics converted to exploration goals
 * 4. Results tracked and logged
 */
class TopicQueueSystem {
  constructor(config, goals, logger) {
    this.config = config;
    this.goals = goals; // Reference to IntrinsicGoalSystem
    this.logger = logger;
    
    // Queue storage
    this.pendingTopics = [];
    this.activeTopics = [];
    this.completedTopics = [];
    
    // File-based injection
    this.queueFilePath = path.join(
      config.logsDir || './runtime',
      'topics-queue.json'
    );
    
    this.processedFilePath = path.join(
      config.logsDir || './runtime',
      'topics-processed.json'
    );
    
    // Configuration
    this.maxPendingTopics = config.topicQueue?.maxPending || 50;
    this.maxActiveTopics = config.topicQueue?.maxActive || 3;
    this.pollInterval = config.topicQueue?.pollInterval || 60; // seconds
    this.lastPoll = null;
    
    // Stats
    this.topicsInjected = 0;
    this.topicsCompleted = 0;
    
    this.gpt5 = new UnifiedClient(config, logger);
  }

  /**
   * Initialize topic queue system
   */
  async initialize() {
    // DISABLED: Topic queue no longer needed with guided mode system
    // Don't create template files or inject example topics
    
    this.logger?.info('Topic queue system disabled (use guided mode instead)');
    
    // Still try to load existing queue for backward compatibility
    // but don't create new files
    try {
      await this.loadQueue();
    } catch (error) {
      // File doesn't exist - that's fine, no topics to load
    }
  }

  /**
   * Create template queue file with instructions
   */
  async createQueueTemplate() {
    const template = {
      _instructions: "Add topics below. Each topic will be explored by the AI. Remove this _instructions field when adding real topics.",
      _format: {
        topic: "Topic description or question to explore",
        priority: "high, medium, or low (optional, defaults to medium)",
        context: "Additional context or constraints (optional)",
        depth: "shallow, normal, or deep (optional, defaults to normal)"
      },
      topics: [
        {
          topic: "How do emergent behaviors arise in complex systems?",
          priority: "high",
          context: "Focus on self-organization and phase transitions",
          depth: "deep"
        },
        {
          topic: "What are the implications of quantum computing for cryptography?",
          priority: "medium"
        }
      ]
    };

    await fs.writeFile(
      this.queueFilePath,
      JSON.stringify(template, null, 2),
      'utf8'
    );

    this.logger?.info('Created topic queue template', { 
      path: this.queueFilePath 
    });
  }

  /**
   * Poll queue file for new topics (called periodically by orchestrator)
   * DISABLED: Topic queue system no longer active - use guided mode instead
   */
  async pollQueue() {
    // Skip polling entirely - guided mode handles task specification
    return 0;
  }

  /**
   * Check if topic has already been processed
   */
  isTopicProcessed(topicData) {
    const topicText = topicData.topic?.toLowerCase() || '';
    
    // Check pending
    if (this.pendingTopics.some(t => (t.originalTopic || t.topic || '').toLowerCase() === topicText)) {
      return true;
    }

    // Check active
    if (this.activeTopics.some(t => (t.originalTopic || t.topic || '').toLowerCase() === topicText)) {
      return true;
    }

    // Check completed
    if (this.completedTopics.some(t => (t.originalTopic || t.topic || '').toLowerCase() === topicText)) {
      return true;
    }

    return false;
  }

  /**
   * Inject a topic into the queue
   */
  async injectTopic(topicData) {
    if (!topicData.topic || typeof topicData.topic !== 'string') {
      this.logger?.warn('Invalid topic data', { topicData });
      return null;
    }

    if (this.pendingTopics.length >= this.maxPendingTopics) {
      this.logger?.warn('Topic queue full, rejecting new topic');
      return null;
    }

    // Enrich topic with AI analysis
    const enriched = await this.enrichTopic(topicData);

    const topic = {
      id: `topic_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      originalTopic: topicData.topic,
      enrichedPrompt: enriched.prompt,
      priority: this.parsePriority(topicData.priority),
      context: topicData.context || null,
      depth: topicData.depth || 'normal',
      suggestedGoals: enriched.goals || [],
      status: 'pending',
      injectedAt: new Date(),
      activatedAt: null,
      completedAt: null,
      explorationNotes: []
    };

    this.pendingTopics.push(topic);
    this.topicsInjected++;

    this.logger?.info('📥 Topic injected', {
      id: topic.id,
      topic: topic.originalTopic.substring(0, 60),
      priority: topic.priority,
      goals: topic.suggestedGoals.length
    });

    return topic;
  }

  /**
   * Enrich topic using AI analysis
   */
  async enrichTopic(topicData) {
    try {
      const response = await this.gpt5.generate({
        model: 'gpt-5-mini',
        instructions: 'You are an expert at breaking down exploration topics into actionable investigation prompts and sub-goals.',
        messages: [{
          role: 'user',
          content: `Analyze this exploration topic:

Topic: "${topicData.topic}"
Context: ${topicData.context || 'none'}
Depth: ${topicData.depth || 'normal'}

Provide:
1. An enriched exploration prompt (2-3 sentences) that captures the essence
2. 2-4 sub-goals or questions to investigate

Format as JSON:
{
  "prompt": "enriched prompt here",
  "goals": ["goal 1", "goal 2", "goal 3"]
}`
        }],
        max_completion_tokens: 2000, // Increased from 500 - priority calculation needs space
        reasoningEffort: 'low'
      });

      // Parse JSON response
      const jsonMatch = response.content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          prompt: parsed.prompt || topicData.topic,
          goals: parsed.goals || []
        };
      }

    } catch (error) {
      this.logger?.error('Topic enrichment failed', { 
        error: error.message 
      });
    }

    // Fallback
    return {
      prompt: topicData.topic,
      goals: []
    };
  }

  /**
   * Parse priority string to numeric value
   */
  parsePriority(priority) {
    const priorityMap = {
      'high': 0.9,
      'medium': 0.6,
      'low': 0.3
    };

    return priorityMap[priority?.toLowerCase()] || 0.6;
  }

  /**
   * Activate next pending topic (called by orchestrator)
   */
  async activateNextTopic() {
    if (this.pendingTopics.length === 0) {
      return null;
    }

    if (this.activeTopics.length >= this.maxActiveTopics) {
      return null; // Already at max active
    }

    // Sort by priority and get highest
    this.pendingTopics.sort((a, b) => b.priority - a.priority);
    const topic = this.pendingTopics.shift();

    topic.status = 'active';
    topic.activatedAt = new Date();
    this.activeTopics.push(topic);

    // Convert to goals
    await this.convertTopicToGoals(topic);

    this.logger?.info('🎯 Topic activated', {
      id: topic.id,
      topic: topic.originalTopic.substring(0, 60),
      goalsCreated: topic.suggestedGoals.length
    });

    return topic;
  }

  /**
   * Convert topic to exploration goals
   */
  async convertTopicToGoals(topic) {
    // Add main topic as goal
    const mainGoal = this.goals.addGoal({
      description: topic.enrichedPrompt,
      reason: `User-injected topic: ${topic.id}`,
      uncertainty: topic.priority,
      source: 'topic_queue',
      topicId: topic.id
    });

    // Add sub-goals
    for (const subGoal of topic.suggestedGoals) {
      if (subGoal && subGoal.length > 10) {
        this.goals.addGoal({
          description: subGoal,
          reason: `Sub-goal of topic: ${topic.id}`,
          uncertainty: topic.priority * 0.8,
          source: 'topic_queue_subgoal',
          topicId: topic.id
        });
      }
    }

    this.logger?.info('Goals created from topic', {
      topicId: topic.id,
      goalsCreated: 1 + topic.suggestedGoals.length
    });
  }

  /**
   * Check if topic exploration is complete
   */
  checkTopicCompletion(topicId) {
    const topic = this.activeTopics.find(t => t.id === topicId);
    if (!topic) return false;

    // Don't check completion if topic was just activated (give it time)
    const timeSinceActivation = Date.now() - new Date(topic.activatedAt).getTime();
    if (timeSinceActivation < 60000) { // Less than 1 minute
      return false; // Too soon to check
    }

    // Check if all related goals are completed
    const relatedGoals = this.goals.getGoals().filter(g => g.topicId === topicId);
    
    if (relatedGoals.length === 0) {
      // No active goals remaining, topic is complete
      return true;
    }

    // If all related goals have high progress, topic is complete
    const allComplete = relatedGoals.every(g => g.progress >= 0.8);
    return allComplete;
  }

  /**
   * Mark topic as complete
   */
  async completeTopic(topicId, notes = '') {
    const index = this.activeTopics.findIndex(t => t.id === topicId);
    if (index === -1) return;

    const topic = this.activeTopics.splice(index, 1)[0];
    topic.status = 'completed';
    topic.completedAt = new Date();
    topic.completionNotes = notes;
    topic.duration = topic.completedAt - topic.activatedAt;

    this.completedTopics.push(topic);
    this.topicsCompleted++;

    // Save to processed file
    await this.saveProcessedTopics();

    this.logger?.info('✅ Topic completed', {
      id: topic.id,
      topic: topic.originalTopic.substring(0, 60),
      duration: Math.round(topic.duration / 1000) + 's',
      notes: notes.substring(0, 100)
    });
  }

  /**
   * Update active topics (called periodically)
   */
  async updateActiveTopics() {
    for (const topic of this.activeTopics) {
      // Check if complete
      if (this.checkTopicCompletion(topic.id)) {
        await this.completeTopic(
          topic.id,
          'All related goals completed or removed'
        );
      }
    }
  }

  /**
   * Record exploration note for topic
   */
  recordExplorationNote(topicId, note) {
    const topic = this.activeTopics.find(t => t.id === topicId);
    if (topic) {
      topic.explorationNotes.push({
        note,
        timestamp: new Date()
      });
    }
  }

  /**
   * Save processed topics to file
   */
  async saveProcessedTopics() {
    try {
      const data = {
        completed: this.completedTopics.map(t => ({
          id: t.id,
          topic: t.originalTopic,
          status: t.status,
          injectedAt: t.injectedAt,
          completedAt: t.completedAt,
          duration: t.duration,
          notes: t.completionNotes
        })),
        stats: this.getStats()
      };

      await fs.writeFile(
        this.processedFilePath,
        JSON.stringify(data, null, 2),
        'utf8'
      );
    } catch (error) {
      this.logger?.error('Failed to save processed topics', { 
        error: error.message 
      });
    }
  }

  /**
   * Load queue from file
   */
  async loadQueue() {
    // Load processed topics to avoid duplicates
    try {
      const data = await fs.readFile(this.processedFilePath, 'utf8');
      const processed = JSON.parse(data);
      
      if (processed.completed) {
        this.completedTopics = processed.completed;
      }
    } catch (error) {
      // File doesn't exist yet, that's fine
    }
  }

  /**
   * Get statistics
   */
  getStats() {
    return {
      pending: this.pendingTopics.length,
      active: this.activeTopics.length,
      completed: this.completedTopics.length,
      totalInjected: this.topicsInjected,
      totalCompleted: this.topicsCompleted,
      queueFile: this.queueFilePath,
      processedFile: this.processedFilePath,
      averageCompletionTime: this.getAverageCompletionTime(),
      topicsByPriority: this.getTopicsByPriority()
    };
  }

  getAverageCompletionTime() {
    if (this.completedTopics.length === 0) return 0;
    
    const durations = this.completedTopics
      .filter(t => t.duration)
      .map(t => t.duration);
    
    if (durations.length === 0) return 0;
    
    const avgMs = durations.reduce((sum, d) => sum + d, 0) / durations.length;
    return Math.round(avgMs / 1000); // seconds
  }

  getTopicsByPriority() {
    const counts = { high: 0, medium: 0, low: 0 };
    
    for (const topic of [...this.pendingTopics, ...this.activeTopics]) {
      if (topic.priority >= 0.8) counts.high++;
      else if (topic.priority >= 0.5) counts.medium++;
      else counts.low++;
    }
    
    return counts;
  }

  /**
   * Get all topics
   */
  getAllTopics() {
    return {
      pending: this.pendingTopics,
      active: this.activeTopics,
      completed: this.completedTopics.slice(-20)
    };
  }

  /**
   * Export for persistence
   */
  export() {
    return {
      pending: this.pendingTopics,
      active: this.activeTopics,
      completed: this.completedTopics.slice(-50),
      topicsInjected: this.topicsInjected,
      topicsCompleted: this.topicsCompleted
    };
  }

  /**
   * Import from persistence
   */
  import(data) {
    if (data.pending) this.pendingTopics = data.pending;
    if (data.active) this.activeTopics = data.active;
    if (data.completed) this.completedTopics = data.completed;
    if (data.topicsInjected) this.topicsInjected = data.topicsInjected;
    if (data.topicsCompleted) this.topicsCompleted = data.topicsCompleted;

    this.logger?.info('Topic queue imported', {
      pending: this.pendingTopics.length,
      active: this.activeTopics.length,
      completed: this.completedTopics.length
    });
  }
}

module.exports = { TopicQueueSystem };
