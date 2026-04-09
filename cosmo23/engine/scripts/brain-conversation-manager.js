/**
 * Brain Conversation Manager
 * 
 * Manages conversation history for follow-up queries and context tracking.
 * Simplified version of COSMO's ContextTracker.
 */

class BrainConversationManager {
  constructor() {
    this.conversations = new Map(); // sessionId -> conversation data
    this.maxConversationAge = 3600000; // 1 hour
    this.maxHistoryLength = 10; // Keep last 10 exchanges per conversation
  }

  /**
   * Create a new conversation session
   */
  createSession() {
    const sessionId = this.generateSessionId();
    this.conversations.set(sessionId, {
      id: sessionId,
      created: Date.now(),
      lastActivity: Date.now(),
      exchanges: []
    });
    return sessionId;
  }

  /**
   * Add an exchange to conversation history
   */
  addExchange(sessionId, query, answer, metadata = {}) {
    const conversation = this.conversations.get(sessionId);
    if (!conversation) {
      throw new Error(`Session ${sessionId} not found`);
    }

    conversation.exchanges.push({
      query,
      answer,
      timestamp: Date.now(),
      metadata
    });

    // Keep only last N exchanges
    if (conversation.exchanges.length > this.maxHistoryLength) {
      conversation.exchanges = conversation.exchanges.slice(-this.maxHistoryLength);
    }

    conversation.lastActivity = Date.now();
  }

  /**
   * Get conversation history
   */
  getConversation(sessionId) {
    const conversation = this.conversations.get(sessionId);
    if (!conversation) {
      return null;
    }

    // Check if expired
    if (Date.now() - conversation.lastActivity > this.maxConversationAge) {
      this.conversations.delete(sessionId);
      return null;
    }

    return conversation;
  }

  /**
   * Get prior context for follow-up queries
   */
  getPriorContext(sessionId) {
    const conversation = this.getConversation(sessionId);
    if (!conversation || conversation.exchanges.length === 0) {
      return null;
    }

    const lastExchange = conversation.exchanges[conversation.exchanges.length - 1];
    return {
      query: lastExchange.query,
      answer: lastExchange.answer,
      metadata: lastExchange.metadata
    };
  }

  /**
   * Generate follow-up suggestions based on conversation
   */
  generateFollowUpSuggestions(sessionId, state, nodes) {
    const conversation = this.getConversation(sessionId);
    if (!conversation || conversation.exchanges.length === 0) {
      return this.generateInitialSuggestions(state, nodes);
    }

    const lastExchange = conversation.exchanges[conversation.exchanges.length - 1];
    const suggestions = [];

    // Analyze last query to suggest related follow-ups
    const queryLower = lastExchange.query.toLowerCase();

    // Temporal follow-ups
    if (queryLower.includes('how') || queryLower.includes('what')) {
      suggestions.push({
        text: "Why is that the case?",
        category: 'deeper',
        priority: 1
      });
      suggestions.push({
        text: "Can you elaborate on that?",
        category: 'clarification',
        priority: 1
      });
    }

    // Comparative follow-ups
    if (!queryLower.includes('compare')) {
      suggestions.push({
        text: "How does this compare to related concepts?",
        category: 'comparative',
        priority: 2
      });
    }

    // Application follow-ups
    if (!queryLower.includes('apply') && !queryLower.includes('use')) {
      suggestions.push({
        text: "What are the practical applications?",
        category: 'application',
        priority: 2
      });
    }

    // Related concepts from answer
    const concepts = this.extractConceptsFromAnswer(lastExchange.answer);
    for (const concept of concepts.slice(0, 2)) {
      suggestions.push({
        text: `Tell me more about ${concept}`,
        category: 'exploration',
        priority: 3
      });
    }

    return suggestions.sort((a, b) => a.priority - b.priority).slice(0, 5);
  }

  /**
   * Generate initial suggestions (no conversation history)
   */
  generateInitialSuggestions(state, nodes) {
    const suggestions = [];

    // General exploration
    suggestions.push(
      { text: "What are the key concepts in this brain?", category: 'exploration', priority: 1 },
      { text: "What were the major breakthroughs?", category: 'insights', priority: 2 },
      { text: "Summarize the research findings", category: 'summary', priority: 1 }
    );

    // If we have nodes, suggest specific queries
    if (nodes && nodes.length > 0) {
      const topTags = this.getTopTags(nodes);
      for (const tag of topTags.slice(0, 2)) {
        suggestions.push({
          text: `What did you learn about ${tag}?`,
          category: 'domain',
          priority: 2
        });
      }
    }

    return suggestions.sort((a, b) => a.priority - b.priority).slice(0, 5);
  }

  /**
   * Extract concepts mentioned in answer (simple heuristic)
   */
  extractConceptsFromAnswer(answer) {
    // Look for terms in markdown bold or headers
    const boldMatches = answer.match(/\*\*([^*]+)\*\*/g) || [];
    const concepts = boldMatches.map(m => m.replace(/\*\*/g, '')).filter(c => c.length > 3 && c.length < 50);
    
    // Remove duplicates
    return [...new Set(concepts)];
  }

  /**
   * Get top tags from nodes
   */
  getTopTags(nodes) {
    const tagCounts = new Map();
    for (const node of nodes) {
      const tag = node.tag || 'unknown';
      if (tag !== 'unknown') {
        tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
      }
    }
    
    return Array.from(tagCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([tag]) => tag);
  }

  /**
   * Clean up expired conversations
   */
  cleanup() {
    const now = Date.now();
    for (const [sessionId, conversation] of this.conversations.entries()) {
      if (now - conversation.lastActivity > this.maxConversationAge) {
        this.conversations.delete(sessionId);
      }
    }
  }

  /**
   * Generate session ID
   */
  generateSessionId() {
    return `session_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  }

  /**
   * Get stats
   */
  getStats() {
    return {
      activeSessions: this.conversations.size,
      totalExchanges: Array.from(this.conversations.values()).reduce((sum, conv) => sum + conv.exchanges.length, 0)
    };
  }
}

module.exports = BrainConversationManager;

