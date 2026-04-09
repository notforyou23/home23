/**
 * Context Tracker for Interactive Follow-up Queries
 * Maintains conversation state and extracts relevant context
 */

class ContextTracker {
  constructor() {
    this.sessions = new Map();
    this.maxSessions = 50;
    this.sessionTimeoutMs = 3600000; // 1 hour
  }

  /**
   * Create a new session
   */
  createSession(query, answer, metadata) {
    const sessionId = this.generateSessionId();
    
    const session = {
      id: sessionId,
      queries: [{
        query,
        answer,
        metadata,
        timestamp: new Date().toISOString()
      }],
      context: this.extractContext(query, answer, metadata),
      createdAt: Date.now(),
      lastAccessedAt: Date.now()
    };

    this.sessions.set(sessionId, session);
    this.cleanupOldSessions();

    return {
      sessionId,
      context: session.context
    };
  }

  /**
   * Add query to existing session
   */
  addToSession(sessionId, query, answer, metadata) {
    const session = this.sessions.get(sessionId);
    
    if (!session) {
      throw new Error('Session not found');
    }

    // Update session
    session.queries.push({
      query,
      answer,
      metadata,
      timestamp: new Date().toISOString()
    });
    
    session.lastAccessedAt = Date.now();
    
    // Update context with new information
    const newContext = this.extractContext(query, answer, metadata);
    session.context = this.mergeContexts(session.context, newContext);

    return {
      sessionId,
      context: session.context,
      queryCount: session.queries.length
    };
  }

  /**
   * Get session context for follow-up query
   */
  getSessionContext(sessionId) {
    const session = this.sessions.get(sessionId);
    
    if (!session) {
      return null;
    }

    // Check if expired
    if (Date.now() - session.lastAccessedAt > this.sessionTimeoutMs) {
      this.sessions.delete(sessionId);
      return null;
    }

    session.lastAccessedAt = Date.now();

    return {
      sessionId: session.id,
      context: session.context,
      previousQueries: session.queries.map(q => q.query),
      queryCount: session.queries.length
    };
  }

  /**
   * Extract context from query/answer
   */
  extractContext(query, answer, metadata) {
    const context = {
      concepts: new Set(),
      cycles: new Set(),
      tags: new Set(),
      entities: new Set()
    };

    // Extract from query
    this.extractFromText(query, context);

    // Extract from answer  
    this.extractFromText(answer, context);

    // Extract from metadata
    if (metadata) {
      // Get cycles from evidence
      if (metadata.evidenceQuality?.temporal) {
        const temporal = metadata.evidenceQuality.temporal;
        if (temporal.minCycle) context.cycles.add(temporal.minCycle);
        if (temporal.maxCycle) context.cycles.add(temporal.maxCycle);
      }

      // Get insights from synthesis
      if (metadata.synthesis?.patterns) {
        for (const pattern of metadata.synthesis.patterns) {
          if (pattern.theme) {
            pattern.theme.split(',').forEach(t => context.concepts.add(t.trim()));
          }
        }
      }

      // Get coordinator insights
      if (metadata.coordinatorInsights?.insights) {
        for (const insight of metadata.coordinatorInsights.insights) {
          if (insight.title) {
            this.extractFromText(insight.title, context);
          }
        }
      }
    }

    // Convert Sets to Arrays for serialization
    return {
      concepts: Array.from(context.concepts).slice(0, 20),
      cycles: Array.from(context.cycles).slice(0, 10),
      tags: Array.from(context.tags).slice(0, 15),
      entities: Array.from(context.entities).slice(0, 15)
    };
  }

  /**
   * Extract concepts from text
   */
  extractFromText(text, context) {
    if (!text) return;

    const lower = text.toLowerCase();

    // Extract cycle references
    const cycleMatches = text.match(/cycle\s+(\d+)/gi);
    if (cycleMatches) {
      cycleMatches.forEach(match => {
        const num = parseInt(match.match(/\d+/)[0]);
        if (num) context.cycles.add(num);
      });
    }

    // Extract quoted terms (likely concepts)
    const quoted = text.match(/"([^"]+)"|'([^']+)'/g);
    if (quoted) {
      quoted.forEach(q => {
        const clean = q.replace(/['"]/g, '').trim();
        if (clean.length > 2 && clean.length < 50) {
          context.concepts.add(clean.toLowerCase());
        }
      });
    }

    // Extract capitalized words (likely entities)
    const capitalized = text.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/g);
    if (capitalized) {
      capitalized.forEach(word => {
        if (word.length > 2 && !this.isCommonWord(word)) {
          context.entities.add(word);
        }
      });
    }

    // Extract key concepts (frequent meaningful words)
    const words = text.toLowerCase().split(/\s+/);
    const wordCounts = {};
    for (const word of words) {
      if (word.length > 5 && !this.isStopWord(word)) {
        wordCounts[word] = (wordCounts[word] || 0) + 1;
      }
    }

    // Add top words as concepts
    Object.entries(wordCounts)
      .filter(([_, count]) => count >= 2)
      .slice(0, 10)
      .forEach(([word, _]) => context.concepts.add(word));
  }

  /**
   * Merge two contexts
   */
  mergeContexts(context1, context2) {
    return {
      concepts: [...new Set([...context1.concepts, ...context2.concepts])].slice(0, 30),
      cycles: [...new Set([...context1.cycles, ...context2.cycles])].slice(0, 15),
      tags: [...new Set([...context1.tags, ...context2.tags])].slice(0, 20),
      entities: [...new Set([...context1.entities, ...context2.entities])].slice(0, 20)
    };
  }

  /**
   * Build context string for follow-up query
   */
  buildContextString(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return '';

    const parts = [];

    // Previous queries summary
    if (session.queries.length > 0) {
      parts.push('Previous conversation:');
      session.queries.forEach((q, idx) => {
        parts.push(`Q${idx + 1}: ${q.query.substring(0, 100)}`);
      });
    }

    // Context concepts
    if (session.context.concepts.length > 0) {
      parts.push(`\nKey concepts discussed: ${session.context.concepts.slice(0, 10).join(', ')}`);
    }

    // Cycles mentioned
    if (session.context.cycles.length > 0) {
      const cycles = session.context.cycles.sort((a, b) => a - b);
      parts.push(`Cycles mentioned: ${cycles.join(', ')}`);
    }

    return parts.join('\n');
  }

  /**
   * Generate session ID
   */
  generateSessionId() {
    return `session_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }

  /**
   * Clean up old sessions
   */
  cleanupOldSessions() {
    const now = Date.now();
    
    // Remove expired sessions
    for (const [id, session] of this.sessions.entries()) {
      if (now - session.lastAccessedAt > this.sessionTimeoutMs) {
        this.sessions.delete(id);
      }
    }

    // If still too many, remove oldest
    if (this.sessions.size > this.maxSessions) {
      const sorted = Array.from(this.sessions.entries())
        .sort((a, b) => a[1].lastAccessedAt - b[1].lastAccessedAt);
      
      const toRemove = sorted.slice(0, sorted.length - this.maxSessions);
      toRemove.forEach(([id, _]) => this.sessions.delete(id));
    }
  }

  /**
   * Stop words for filtering
   */
  isStopWord(word) {
    const stopWords = new Set([
      'this', 'that', 'these', 'those', 'what', 'which', 'who', 'when', 'where',
      'why', 'how', 'will', 'would', 'could', 'should', 'might', 'must',
      'have', 'been', 'being', 'there', 'their', 'about', 'after', 'before',
      'through', 'during', 'between', 'against', 'across', 'within', 'without'
    ]);
    return stopWords.has(word.toLowerCase());
  }

  /**
   * Common words to exclude as entities
   */
  isCommonWord(word) {
    const common = new Set([
      'The', 'This', 'That', 'What', 'When', 'Where', 'Why', 'How',
      'Are', 'Was', 'Were', 'Been', 'Being', 'Have', 'Has', 'Had',
      'Do', 'Does', 'Did', 'Will', 'Would', 'Could', 'Should'
    ]);
    return common.has(word);
  }

  /**
   * Get session statistics
   */
  getStats() {
    return {
      totalSessions: this.sessions.size,
      activeSessions: Array.from(this.sessions.values()).filter(s => 
        Date.now() - s.lastAccessedAt < this.sessionTimeoutMs
      ).length
    };
  }

  /**
   * Clear all sessions
   */
  clearAll() {
    this.sessions.clear();
  }
}

module.exports = { ContextTracker };

