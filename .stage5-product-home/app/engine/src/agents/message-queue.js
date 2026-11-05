/**
 * MessageQueue - Inter-agent communication system
 * 
 * Enables agents to:
 * - Send messages to other agents
 * - Request handoffs to specialist agents
 * - Share insights with coordinator
 * - Request resources or assistance
 * 
 * Message Types:
 * - HANDOFF: Agent requests another agent to continue work
 * - INSIGHT: Agent shares important finding with all
 * - RESOURCE_REQUEST: Agent needs additional resources/tools
 * - STATUS_UPDATE: Agent provides status to coordinator
 * - QUESTION: Agent needs clarification or guidance
 */
class MessageQueue {
  constructor(logger) {
    this.logger = logger;
    this.messages = [];
    this.subscriptions = new Map(); // agentId -> Set<messageTypes>
    this.maxMessages = 500; // Keep last 500 messages
  }

  /**
   * Send/push a message to the queue
   * @param {Object} message - Message object with from, to, type, payload
   */
  async push(message) {
    // Ensure message has required fields
    if (!message.from || !message.to || !message.type) {
      this.logger.error('Invalid message - missing required fields', {
        hasFrom: !!message.from,
        hasTo: !!message.to,
        hasType: !!message.type
      }, 3);
      return;
    }

    // Add message ID if not present
    if (!message.id) {
      message.id = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    }

    // Add timestamp if not present
    if (!message.timestamp) {
      message.timestamp = new Date();
    }

    // Add read flag if not present
    if (message.read === undefined) {
      message.read = false;
    }

    this.messages.push(message);
    
    this.logger.debug('📨 Message queued', {
      id: message.id,
      from: message.from,
      to: message.to,
      type: message.type
    }, 3);

    // Trim queue if too large
    if (this.messages.length > this.maxMessages) {
      const removed = this.messages.splice(0, this.messages.length - this.maxMessages);
      this.logger.debug('Message queue trimmed', {
        removed: removed.length,
        remaining: this.messages.length
      }, 3);
    }
  }

  /**
   * Get messages for specific agent
   * @param {string} agentId - Target agent ID or 'meta_coordinator'
   * @returns {Array}
   */
  getMessagesFor(agentId) {
    return this.messages.filter(m => 
      m.to === agentId || m.to === 'ALL'
    );
  }

  /**
   * Get unread messages for specific agent
   * @param {string} agentId
   * @returns {Array}
   */
  getUnreadFor(agentId) {
    return this.messages.filter(m => 
      (m.to === agentId || m.to === 'ALL') && !m.read
    );
  }

  /**
   * Get messages by type
   * @param {string} type - Message type (HANDOFF, INSIGHT, etc.)
   * @returns {Array}
   */
  getMessagesByType(type) {
    return this.messages.filter(m => m.type === type);
  }

  /**
   * Get messages from specific sender
   * @param {string} agentId
   * @returns {Array}
   */
  getMessagesFrom(agentId) {
    return this.messages.filter(m => m.from === agentId);
  }

  /**
   * Mark message as read
   * @param {string} messageId
   * @param {string} readByAgentId
   */
  markRead(messageId, readByAgentId) {
    const msg = this.messages.find(m => m.id === messageId);
    if (msg) {
      msg.read = true;
      msg.readBy = readByAgentId;
      msg.readAt = new Date();
      
      this.logger.debug('Message marked as read', {
        messageId,
        readBy: readByAgentId
      }, 3);
    }
  }

  /**
   * Mark message as read (alias for backward compatibility)
   * @param {string} messageId
   * @param {string} readByAgentId - Optional
   */
  markAsRead(messageId, readByAgentId = 'coordinator') {
    return this.markRead(messageId, readByAgentId);
  }

  /**
   * Mark multiple messages as read
   * @param {Array<string>} messageIds
   * @param {string} readByAgentId
   */
  markMultipleRead(messageIds, readByAgentId) {
    let marked = 0;
    for (const messageId of messageIds) {
      const msg = this.messages.find(m => m.id === messageId);
      if (msg) {
        msg.read = true;
        msg.readBy = readByAgentId;
        msg.readAt = new Date();
        marked++;
      }
    }
    
    if (marked > 0) {
      this.logger.debug('Multiple messages marked as read', {
        count: marked,
        readBy: readByAgentId
      }, 3);
    }
  }

  /**
   * Subscribe agent to specific message types
   * @param {string} agentId
   * @param {Array<string>} messageTypes
   */
  subscribe(agentId, messageTypes) {
    if (!this.subscriptions.has(agentId)) {
      this.subscriptions.set(agentId, new Set());
    }
    
    const agentSubs = this.subscriptions.get(agentId);
    for (const type of messageTypes) {
      agentSubs.add(type);
    }
    
    this.logger.debug('Agent subscribed to message types', {
      agentId,
      types: Array.from(agentSubs)
    }, 3);
  }

  /**
   * Get subscribed messages for agent
   * @param {string} agentId
   * @returns {Array}
   */
  getSubscribedMessages(agentId) {
    const subs = this.subscriptions.get(agentId);
    if (!subs || subs.size === 0) {
      return [];
    }
    
    return this.messages.filter(m => 
      (m.to === agentId || m.to === 'ALL') && 
      subs.has(m.type) &&
      !m.read
    );
  }

  /**
   * Get HANDOFF requests for coordinator
   * Coordinator should check these on each review
   * @returns {Array}
   */
  getHandoffRequests() {
    return this.messages.filter(m => 
      m.type === 'HANDOFF_REQUEST' && 
      (m.to === 'meta_coordinator' || m.to === 'ALL') &&
      !m.read
    );
  }

  /**
   * Get INSIGHT messages (shared discoveries)
   * @param {boolean} unreadOnly - Only return unread insights
   * @returns {Array}
   */
  getInsights(unreadOnly = true) {
    const insights = this.messages.filter(m => m.type === 'INSIGHT');
    return unreadOnly ? insights.filter(m => !m.read) : insights;
  }

  /**
   * Get RESOURCE_REQUEST messages for coordinator
   * @returns {Array}
   */
  getResourceRequests() {
    return this.messages.filter(m => 
      m.type === 'RESOURCE_REQUEST' && 
      m.to === 'meta_coordinator' &&
      !m.read
    );
  }

  /**
   * Clean up old messages
   * @param {number} maxAge - Max age in milliseconds (default: 1 hour)
   */
  cleanup(maxAge = 3600000) {
    const cutoff = Date.now() - maxAge;
    const initialLength = this.messages.length;
    
    this.messages = this.messages.filter(m => {
      const msgTime = m.timestamp instanceof Date 
        ? m.timestamp.getTime() 
        : new Date(m.timestamp).getTime();
      return msgTime > cutoff;
    }, 3);
    
    const removed = initialLength - this.messages.length;
    
    if (removed > 0) {
      this.logger.info('Message queue cleaned up', {
        removed,
        remaining: this.messages.length
      }, 3);
    }
  }

  /**
   * Get recent messages
   * @param {number} limit - Number of recent messages
   * @returns {Array}
   */
  getRecent(limit = 20) {
    return this.messages.slice(-limit);
  }

  /**
   * Get conversation thread (messages between two agents)
   * @param {string} agentId1
   * @param {string} agentId2
   * @returns {Array}
   */
  getConversation(agentId1, agentId2) {
    return this.messages.filter(m => 
      (m.from === agentId1 && m.to === agentId2) ||
      (m.from === agentId2 && m.to === agentId1)
    ).sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Get statistics
   * @returns {Object}
   */
  getStats() {
    const unreadCount = this.messages.filter(m => !m.read).length;
    const typeDistribution = {};
    
    for (const msg of this.messages) {
      typeDistribution[msg.type] = (typeDistribution[msg.type] || 0) + 1;
    }
    
    return {
      total: this.messages.length,
      unread: unreadCount,
      read: this.messages.length - unreadCount,
      byType: typeDistribution,
      subscriptions: this.subscriptions.size,
      oldestMessage: this.messages.length > 0 
        ? this.messages[0].timestamp 
        : null,
      newestMessage: this.messages.length > 0 
        ? this.messages[this.messages.length - 1].timestamp 
        : null
    };
  }

  /**
   * Export queue state for monitoring/debugging
   * @returns {Object}
   */
  exportState() {
    return {
      messageCount: this.messages.length,
      unreadCount: this.messages.filter(m => !m.read).length,
      recent: this.getRecent(10).map(m => ({
        id: m.id,
        from: m.from,
        to: m.to,
        type: m.type,
        timestamp: m.timestamp,
        read: m.read
      })),
      handoffRequests: this.getHandoffRequests().length,
      insights: this.getInsights().length,
      resourceRequests: this.getResourceRequests().length,
      stats: this.getStats()
    };
  }

  /**
   * Clear all messages (use with caution)
   */
  clear() {
    const count = this.messages.length;
    this.messages = [];
    this.subscriptions.clear();
    
    this.logger.warn('Message queue cleared', {
      messagesRemoved: count
    }, 3);
  }

  /**
   * Get message by ID
   * @param {string} messageId
   * @returns {Object|null}
   */
  getMessage(messageId) {
    return this.messages.find(m => m.id === messageId) || null;
  }
}

module.exports = { MessageQueue };

