/**
 * Brain Coordinator Insights Indexer
 * 
 * Indexes and searches through coordinator review files in a .brain package.
 * Adapted from COSMO's coordinator-indexer.js pattern.
 * 
 * Coordinator reviews contain meta-level insights about the run:
 * - Strategic assessments
 * - Pattern observations
 * - Recommendations
 * - Quality metrics
 */

const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');

class BrainCoordinatorIndexer {
  constructor(brainPath, openaiClient) {
    this.brainPath = brainPath;
    this.coordinatorDir = path.join(brainPath, 'coordinator');
    this.openai = openaiClient;
    this.insightsCache = null;
    this.lastIndexTime = 0;
    this.cacheValidityMs = 300000; // 5 minutes
  }

  /**
   * Check if coordinator directory exists
   */
  hasCoordinatorData() {
    return fsSync.existsSync(this.coordinatorDir);
  }

  /**
   * Get searchable coordinator insights (cached)
   */
  async getSearchableInsights() {
    const now = Date.now();
    if (this.insightsCache && (now - this.lastIndexTime) < this.cacheValidityMs) {
      return this.insightsCache;
    }

    const insights = await this.loadAndIndexInsights();
    this.insightsCache = insights;
    this.lastIndexTime = now;
    
    return insights;
  }

  /**
   * Load all coordinator reviews and extract insights
   * (Exact COSMO pattern)
   */
  async loadAndIndexInsights() {
    if (!this.hasCoordinatorData()) {
      console.log('[COORDINATOR] No coordinator directory found');
      return [];
    }

    try {
      const files = await fs.readdir(this.coordinatorDir);
      const reviewFiles = files.filter(f => 
        f.startsWith('review_') && f.endsWith('.md')
      );

      console.log(`[COORDINATOR] Found ${reviewFiles.length} review files`);

      const insights = [];

      for (const file of reviewFiles) {
        const filepath = path.join(this.coordinatorDir, file);
        const content = await fs.readFile(filepath, 'utf-8');
        
        const extractedInsights = this.extractInsightsFromReview(content, file);
        insights.push(...extractedInsights);
      }

      console.log(`[COORDINATOR] Extracted ${insights.length} insights`);

      // Generate embeddings for all insights
      if (insights.length > 0 && this.openai) {
        await this.generateEmbeddings(insights);
      }

      return insights;

    } catch (error) {
      console.error('[COORDINATOR] Failed to index insights:', error);
      return [];
    }
  }

  /**
   * Extract individual insights from a review document
   * (Exact COSMO algorithm)
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

      // Look for key insight markers (COSMO pattern)
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

    // Also extract bullet points that look insightful (COSMO pattern)
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
   * (Exact COSMO pattern)
   */
  async generateEmbeddings(insights) {
    if (!this.openai) {
      console.log('[COORDINATOR] No OpenAI client, skipping embeddings');
      return;
    }

    // Process in batches to avoid rate limits
    const batchSize = 20;
    
    console.log(`[COORDINATOR] Generating embeddings for ${insights.length} insights...`);

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

        console.log(`[COORDINATOR] Batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(insights.length/batchSize)} complete`);
      } catch (error) {
        console.error('[COORDINATOR] Failed to generate embeddings:', error);
        // Continue without embeddings
      }

      // Small delay between batches
      if (i + batchSize < insights.length) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    console.log('[COORDINATOR] ✅ Embeddings complete');
  }

  /**
   * Search coordinator insights semantically
   * (Exact COSMO algorithm)
   */
  async searchInsights(query, limit = 10) {
    const insights = await this.getSearchableInsights();
    
    if (insights.length === 0) {
      return {
        results: [],
        stats: { method: 'none', total: 0 }
      };
    }

    // Generate query embedding
    if (this.openai) {
      try {
        const response = await this.openai.embeddings.create({
          model: 'text-embedding-3-small',
          input: query
        });
        const queryEmbedding = response.data[0].embedding;

        // Calculate similarities (COSMO algorithm)
        const scored = insights
          .filter(ins => ins.embedding)
          .map(ins => ({
            ...ins,
            similarity: this.cosineSimilarity(queryEmbedding, ins.embedding)
          }))
          .sort((a, b) => b.similarity - a.similarity)
          .slice(0, limit);

        return {
          results: scored,
          stats: { method: 'semantic', total: insights.length }
        };
      } catch (error) {
        console.error('[COORDINATOR] Failed to generate query embedding:', error);
        // Fall through to keyword search
      }
    }

    // Fallback: keyword search
    return this.keywordSearch(insights, query, limit);
  }

  /**
   * Fallback keyword search
   * (Exact COSMO algorithm)
   */
  keywordSearch(insights, query, limit) {
    const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    
    if (queryWords.length === 0) {
      return {
        results: insights.slice(0, limit),
        stats: { method: 'keyword', total: insights.length }
      };
    }

    const scored = insights.map(ins => {
      const text = `${ins.title} ${ins.content}`.toLowerCase();
      const matches = queryWords.filter(word => text.includes(word)).length;
      const similarity = matches / queryWords.length;

      return { ...ins, similarity };
    })
    .filter(ins => ins.similarity > 0)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);

    return {
      results: scored,
      stats: { method: 'keyword', total: insights.length }
    };
  }

  /**
   * Cosine similarity (exact COSMO algorithm)
   */
  cosineSimilarity(vec1, vec2) {
    if (!vec1 || !vec2 || vec1.length !== vec2.length) {
      return 0;
    }

    let dotProduct = 0;
    let norm1 = 0;
    let norm2 = 0;

    for (let i = 0; i < vec1.length; i++) {
      dotProduct += vec1[i] * vec2[i];
      norm1 += vec1[i] * vec1[i];
      norm2 += vec2[i] * vec2[i];
    }

    if (norm1 === 0 || norm2 === 0) {
      return 0;
    }

    return dotProduct / (Math.sqrt(norm1) * Math.sqrt(norm2));
  }

  /**
   * Get statistics about coordinator insights
   */
  async getStats() {
    const insights = await this.getSearchableInsights();
    
    const typeCounts = {};
    for (const ins of insights) {
      typeCounts[ins.type] = (typeCounts[ins.type] || 0) + 1;
    }

    return {
      total: insights.length,
      byType: typeCounts,
      hasData: insights.length > 0
    };
  }
}

module.exports = BrainCoordinatorIndexer;

