/**
 * Coordinator Indexer
 * Makes coordinator review insights searchable via semantic embeddings
 */

const fs = require('fs').promises;
const path = require('path');

class CoordinatorIndexer {
  constructor(coordinatorDir, openaiClient) {
    this.coordinatorDir = coordinatorDir;
    this.openai = openaiClient;
    this.indexCache = null;
    this.lastIndexTime = 0;
    this.cacheValidityMs = 300000; // 5 minutes
  }

  /**
   * Get searchable coordinator insights
   */
  async getSearchableInsights() {
    const now = Date.now();
    if (this.indexCache && (now - this.lastIndexTime) < this.cacheValidityMs) {
      return this.indexCache;
    }

    const insights = await this.loadAndIndexInsights();
    this.indexCache = insights;
    this.lastIndexTime = now;
    
    return insights;
  }

  /**
   * Load all coordinator reviews and extract insights
   */
  async loadAndIndexInsights() {
    try {
      const files = await fs.readdir(this.coordinatorDir);
      const reviewFiles = files.filter(f => 
        f.startsWith('review_') && f.endsWith('.md')
      );

      const insights = [];

      for (const file of reviewFiles) {
        const filepath = path.join(this.coordinatorDir, file);
        const content = await fs.readFile(filepath, 'utf-8');
        
        const extractedInsights = this.extractInsightsFromReview(content, file);
        insights.push(...extractedInsights);
      }

      // Generate embeddings for all insights
      if (insights.length > 0) {
        await this.generateEmbeddings(insights);
      }

      return insights;

    } catch (error) {
      console.error('Failed to index coordinator insights:', error);
      return [];
    }
  }

  /**
   * Extract individual insights from a review document
   */
  extractInsightsFromReview(content, filename) {
    const insights = [];
    
    // Extract cycle number from filename (review_YYYY-MM-DD_cycleN.md)
    const cycleMatch = filename.match(/cycle(\d+)/);
    const cycle = cycleMatch ? parseInt(cycleMatch[1]) : null;

    // Split by headers and major sections
    const sections = content.split(/^#{1,3}\s+/m).filter(s => s.trim());

    for (const section of sections) {
      const lines = section.split('\n');
      const title = lines[0]?.trim();
      const body = lines.slice(1).join('\n').trim();

      if (!title || !body || body.length < 50) continue;

      // Look for key insight markers
      const isKeyInsight = 
        /key insight|breakthrough|discovery|important|critical|significant/i.test(section) ||
        title.toLowerCase().includes('insight') ||
        title.toLowerCase().includes('finding');

      // Look for recommendation markers
      const isRecommendation =
        /recommend|suggest|should|propose|advise/i.test(section) ||
        title.toLowerCase().includes('recommend');

      // Look for pattern observations
      const isPattern =
        /pattern|trend|consistent|regularly|frequently/i.test(section) ||
        title.toLowerCase().includes('pattern');

      if (isKeyInsight || isRecommendation || isPattern) {
        insights.push({
          type: isKeyInsight ? 'insight' : isRecommendation ? 'recommendation' : 'pattern',
          title,
          content: body.substring(0, 500), // Limit content size
          cycle,
          source: filename,
          embedding: null // Will be filled by generateEmbeddings
        });
      }
    }

    // Also extract bullet points that look insightful
    const bulletPoints = content.match(/^[\s]*[-*]\s+(.+)$/gm) || [];
    for (const bullet of bulletPoints) {
      const text = bullet.replace(/^[\s]*[-*]\s+/, '').trim();
      
      if (text.length > 40 && /insight|discover|found|pattern|recommend/i.test(text)) {
        insights.push({
          type: 'observation',
          title: text.substring(0, 80),
          content: text,
          cycle,
          source: filename,
          embedding: null
        });
      }
    }

    return insights;
  }

  /**
   * Generate embeddings for insights
   */
  async generateEmbeddings(insights) {
    // Process in batches to avoid rate limits
    const batchSize = 20;
    
    for (let i = 0; i < insights.length; i += batchSize) {
      const batch = insights.slice(i, i + batchSize);
      const texts = batch.map(ins => `${ins.title}\n${ins.content}`);

      try {
        const response = await this.openai.embeddings.create({
          model: 'text-embedding-3-small',
          input: texts
        });

        for (let j = 0; j < batch.length; j++) {
          batch[j].embedding = response.data[j].embedding;
        }
      } catch (error) {
        console.error('Failed to generate embeddings for insights:', error);
        // Continue without embeddings
      }

      // Small delay between batches
      if (i + batchSize < insights.length) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
  }

  /**
   * Search coordinator insights semantically
   */
  async searchInsights(query, limit = 10) {
    const insights = await this.getSearchableInsights();
    
    if (insights.length === 0) {
      return [];
    }

    // Generate query embedding
    let queryEmbedding;
    try {
      const response = await this.openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: query
      });
      queryEmbedding = response.data[0].embedding;
    } catch (error) {
      console.error('Failed to generate query embedding:', error);
      // Fallback to keyword search
      return this.keywordSearch(insights, query, limit);
    }

    // Calculate similarities
    const scored = insights
      .filter(ins => ins.embedding)
      .map(ins => ({
        ...ins,
        similarity: this.cosineSimilarity(queryEmbedding, ins.embedding)
      }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);

    return scored;
  }

  /**
   * Fallback keyword search
   */
  keywordSearch(insights, query, limit) {
    const queryWords = query.toLowerCase().split(/\s+/);
    
    const scored = insights.map(ins => {
      const text = `${ins.title} ${ins.content}`.toLowerCase();
      const matches = queryWords.filter(word => text.includes(word)).length;
      return {
        ...ins,
        similarity: matches / queryWords.length
      };
    })
    .filter(ins => ins.similarity > 0)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);

    return scored;
  }

  /**
   * Cosine similarity between two vectors
   */
  cosineSimilarity(vec1, vec2) {
    if (!vec1 || !vec2 || vec1.length !== vec2.length) return 0;

    let dotProduct = 0;
    let norm1 = 0;
    let norm2 = 0;

    for (let i = 0; i < vec1.length; i++) {
      dotProduct += vec1[i] * vec2[i];
      norm1 += vec1[i] * vec1[i];
      norm2 += vec2[i] * vec2[i];
    }

    if (norm1 === 0 || norm2 === 0) return 0;
    return dotProduct / (Math.sqrt(norm1) * Math.sqrt(norm2));
  }

  /**
   * Get coordinator insights for context inclusion
   */
  async getInsightsForContext(query, maxCount = 5) {
    const results = await this.searchInsights(query, maxCount);
    
    if (results.length === 0) {
      return null;
    }

    return {
      count: results.length,
      insights: results.map(r => ({
        type: r.type,
        title: r.title,
        content: r.content,
        cycle: r.cycle,
        relevance: Math.round(r.similarity * 100)
      }))
    };
  }

  /**
   * Clear the cache (useful for testing)
   */
  clearCache() {
    this.indexCache = null;
    this.lastIndexTime = 0;
  }
}

module.exports = { CoordinatorIndexer };

