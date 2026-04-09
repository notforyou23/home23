/**
 * Codebase Semantic Search Engine
 * Adapted from COSMO's coordinator-indexer.js
 * Provides semantic understanding of code via embeddings
 */

const fs = require('fs').promises;
const path = require('path');

class CodebaseIndexer {
  constructor(openaiClient) {
    this.openai = openaiClient;
    this.indexCache = new Map(); // folderPath → index
    this.embeddingCache = new Map(); // filePath → embedding
  }

  /**
   * Chunk a code file into searchable segments
   * Extracts functions, classes, and logical blocks
   */
  chunkCodeFile(content, filePath) {
    const chunks = [];
    const ext = path.extname(filePath);
    
    // Strategy: Split by function/class boundaries
    const lines = content.split('\n');
    let currentChunk = [];
    let chunkStartLine = 0;
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      
      // Detect function/class boundaries (simplified, works for most languages)
      const isBoundary = 
        trimmed.startsWith('function ') ||
        trimmed.startsWith('async function ') ||
        trimmed.startsWith('class ') ||
        trimmed.startsWith('export function ') ||
        trimmed.startsWith('export class ') ||
        trimmed.startsWith('export const ') && trimmed.includes(' = (') ||
        trimmed.startsWith('def ') || // Python
        trimmed.startsWith('async def ') || // Python async
        (trimmed.startsWith('const ') && trimmed.includes(' = (')) || // Arrow functions
        (trimmed.startsWith('const ') && trimmed.includes(' = async ('));
      
      if (isBoundary && currentChunk.length > 5) {
        // Save previous chunk
        const chunkContent = currentChunk.join('\n').trim();
        if (chunkContent.length > 50) {
          chunks.push({
            content: chunkContent,
            startLine: chunkStartLine + 1,
            endLine: i,
            filePath: filePath,
            type: 'code'
          });
        }
        currentChunk = [];
        chunkStartLine = i;
      }
      
      currentChunk.push(line);
      
      // Also chunk at natural boundaries (every ~50 lines if no functions found)
      if (currentChunk.length > 50 && trimmed === '') {
        const chunkContent = currentChunk.join('\n').trim();
        if (chunkContent.length > 50) {
          chunks.push({
            content: chunkContent,
            startLine: chunkStartLine + 1,
            endLine: i,
            filePath: filePath,
            type: 'code'
          });
        }
        currentChunk = [];
        chunkStartLine = i + 1;
      }
    }
    
    // Add final chunk
    if (currentChunk.length > 0) {
      const chunkContent = currentChunk.join('\n').trim();
      if (chunkContent.length > 50) {
        chunks.push({
          content: chunkContent,
          startLine: chunkStartLine + 1,
          endLine: lines.length,
          filePath: filePath,
          type: 'code'
        });
      }
    }
    
    return chunks;
  }

  /**
   * Index a folder recursively
   */
  async indexFolder(folderPath, files) {
    console.log(`[SEMANTIC INDEX] Indexing ${files.length} files in ${folderPath}...`);
    
    const chunks = [];
    
    // Filter to code files only
    const codeFiles = files.filter(f => {
      if (f.isDirectory) return false;
      const ext = path.extname(f.path).toLowerCase();
      return ['.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.go', '.rs', '.cpp', '.c', '.h', '.cs', '.rb', '.php'].includes(ext);
    });
    
    console.log(`[SEMANTIC INDEX] Processing ${codeFiles.length} code files...`);
    
    // Process each file
    for (const file of codeFiles.slice(0, 100)) { // Limit to 100 files for performance
      try {
        const content = await fs.readFile(file.path, 'utf-8');
        const fileChunks = this.chunkCodeFile(content, file.path);
        chunks.push(...fileChunks);
      } catch (error) {
        console.warn(`[SEMANTIC INDEX] Could not read ${file.path}:`, error.message);
      }
    }
    
    console.log(`[SEMANTIC INDEX] Created ${chunks.length} code chunks`);
    
    // Generate embeddings in batches
    await this.generateEmbeddings(chunks);
    
    // Store in cache
    this.indexCache.set(folderPath, chunks);
    
    return chunks;
  }

  /**
   * Generate embeddings for code chunks (batch processing)
   * Copied from COSMO coordinator-indexer.js
   */
  async generateEmbeddings(chunks) {
    const batchSize = 20;
    
    console.log(`[SEMANTIC INDEX] Generating embeddings for ${chunks.length} chunks...`);
    
    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize);
      const texts = batch.map(chunk => {
        // Include file path and line numbers for context
        const header = `File: ${chunk.filePath} (lines ${chunk.startLine}-${chunk.endLine})`;
        return `${header}\n\n${chunk.content}`;
      });

      try {
        const response = await this.openai.embeddings.create({
          model: 'text-embedding-3-small',
          input: texts
        });

        for (let j = 0; j < batch.length; j++) {
          batch[j].embedding = response.data[j].embedding;
        }
        
        console.log(`[SEMANTIC INDEX] Embedded batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(chunks.length/batchSize)}`);
      } catch (error) {
        console.error('[SEMANTIC INDEX] Failed to generate embeddings:', error);
      }

      // Rate limit protection
      if (i + batchSize < chunks.length) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    
    console.log(`[SEMANTIC INDEX] ✅ Embeddings complete`);
  }

  /**
   * Semantic search through indexed code
   * Copied from COSMO coordinator-indexer.js searchInsights()
   */
  async searchCode(folderPath, query, limit = 10) {
    const chunks = this.indexCache.get(folderPath);
    
    if (!chunks || chunks.length === 0) {
      return { results: [], message: 'No index found - folder not indexed yet' };
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
      console.error('[SEMANTIC SEARCH] Failed to generate query embedding:', error);
      // Fallback to keyword search
      return this.keywordSearch(chunks, query, limit);
    }

    // Calculate similarities (exact COSMO algorithm)
    const scored = chunks
      .filter(chunk => chunk.embedding)
      .map(chunk => ({
        ...chunk,
        similarity: this.cosineSimilarity(queryEmbedding, chunk.embedding)
      }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);

    console.log(`[SEMANTIC SEARCH] Found ${scored.length} matches for "${query}"`);
    
    return { results: scored, message: null };
  }

  /**
   * Fallback keyword search (exact COSMO algorithm)
   */
  keywordSearch(chunks, query, limit) {
    const queryWords = query.toLowerCase().split(/\s+/);
    
    const scored = chunks.map(chunk => {
      const text = chunk.content.toLowerCase();
      const matches = queryWords.filter(word => text.includes(word)).length;
      return {
        ...chunk,
        similarity: matches / queryWords.length
      };
    })
    .filter(chunk => chunk.similarity > 0)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);

    return { results: scored, message: 'Using keyword search (embeddings unavailable)' };
  }

  /**
   * Cosine similarity (exact COSMO algorithm)
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
}

module.exports = CodebaseIndexer;

