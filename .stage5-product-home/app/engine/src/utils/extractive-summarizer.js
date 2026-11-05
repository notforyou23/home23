/**
 * Extractive Summarization - Zero API Cost
 * Uses TF-IDF and sentence ranking to extract key phrases
 */

class ExtractiveSummarizer {
  constructor(logger) {
    this.logger = logger;
  }

  /**
   * Summarize text using extractive methods
   * @param {string} text - Full text to summarize
   * @returns {Object} { summary, keyPhrase, quality }
   */
  summarize(text) {
    if (!text || text.length < 50) {
      return { summary: text, keyPhrase: text, quality: 1.0 };
    }

    // Split into sentences
    const sentences = this.splitSentences(text);
    
    if (sentences.length === 0) {
      return { summary: text.substring(0, 150), keyPhrase: text.substring(0, 50), quality: 0.5 };
    }

    // For short text, use first sentence
    if (sentences.length <= 2) {
      const firstSentence = sentences[0];
      const keyPhrase = this.extractKeyPhrase(firstSentence);
      return { 
        summary: firstSentence, 
        keyPhrase, 
        quality: 0.9 
      };
    }

    // Score sentences by importance
    const scoredSentences = this.scoreSentences(sentences, text);
    
    // Get top sentence for summary
    const topSentence = scoredSentences[0];
    
    // Extract key phrase from top sentence
    const keyPhrase = this.extractKeyPhrase(topSentence.text);
    
    // Quality based on score distribution
    const quality = this.assessQuality(scoredSentences);

    return {
      summary: topSentence.text,
      keyPhrase,
      quality
    };
  }

  /**
   * Split text into sentences
   */
  splitSentences(text) {
    // Remove markdown formatting
    text = text.replace(/\*\*/g, '').replace(/\*/g, '');
    
    // Split on sentence boundaries
    const sentences = text
      .split(/[.!?]+/)
      .map(s => s.trim())
      .filter(s => s.length > 20); // Filter very short fragments
    
    return sentences;
  }

  /**
   * Score sentences by importance using multiple signals
   */
  scoreSentences(sentences, fullText) {
    const words = this.tokenize(fullText.toLowerCase());
    const wordFreq = this.calculateWordFrequency(words);
    const idf = this.calculateIDF(sentences);
    
    const scored = sentences.map((sentence, idx) => {
      let score = 0;
      
      // Position score (first sentences often important)
      score += (sentences.length - idx) / sentences.length * 2;
      
      // Length score (prefer medium-length sentences)
      const wordCount = sentence.split(/\s+/).length;
      if (wordCount >= 8 && wordCount <= 25) {
        score += 2;
      } else if (wordCount < 5) {
        score -= 1;
      }
      
      // TF-IDF score
      const sentenceWords = this.tokenize(sentence.toLowerCase());
      for (const word of sentenceWords) {
        const tf = (wordFreq[word] || 0);
        const idfScore = (idf[word] || 0);
        score += tf * idfScore;
      }
      
      // Keyword boost
      const keywordBoost = this.hasKeywords(sentence);
      score += keywordBoost;
      
      return { text: sentence, score, index: idx };
    });
    
    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);
    
    return scored;
  }

  /**
   * Calculate word frequency
   */
  calculateWordFrequency(words) {
    const freq = {};
    const total = words.length;
    
    for (const word of words) {
      freq[word] = (freq[word] || 0) + 1;
    }
    
    // Normalize
    for (const word in freq) {
      freq[word] = freq[word] / total;
    }
    
    return freq;
  }

  /**
   * Calculate IDF scores
   */
  calculateIDF(sentences) {
    const docCount = sentences.length;
    const wordDocs = {};
    
    // Count documents containing each word
    for (const sentence of sentences) {
      const words = new Set(this.tokenize(sentence.toLowerCase()));
      for (const word of words) {
        wordDocs[word] = (wordDocs[word] || 0) + 1;
      }
    }
    
    // Calculate IDF
    const idf = {};
    for (const word in wordDocs) {
      idf[word] = Math.log(docCount / wordDocs[word]);
    }
    
    return idf;
  }

  /**
   * Tokenize text into words
   */
  tokenize(text) {
    return text
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 3) // Remove short words
      .filter(w => !this.isStopWord(w));
  }

  /**
   * Check if word is a stop word
   */
  isStopWord(word) {
    const stopWords = new Set([
      'this', 'that', 'these', 'those', 'the', 'and', 'but', 'for', 'with',
      'about', 'from', 'into', 'through', 'during', 'before', 'after',
      'above', 'below', 'between', 'under', 'again', 'further', 'then',
      'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all', 'both',
      'each', 'more', 'most', 'other', 'some', 'such', 'only', 'same', 'than',
      'very', 'will', 'just', 'should', 'would', 'could', 'might', 'must'
    ]);
    return stopWords.has(word);
  }

  /**
   * Check for important keywords
   */
  hasKeywords(sentence) {
    const lower = sentence.toLowerCase();
    let boost = 0;
    
    // Domain-specific keywords
    const keywords = [
      'insight:', 'finding:', 'conclusion:', 'evidence:', 'suggest',
      'demonstrate', 'reveal', 'indicate', 'show', 'prove', 'discover',
      'important', 'significant', 'critical', 'key', 'essential', 'vital',
      'require', 'must', 'need', 'should', 'framework', 'approach', 'method'
    ];
    
    for (const keyword of keywords) {
      if (lower.includes(keyword)) {
        boost += 1;
      }
    }
    
    return boost;
  }

  /**
   * Extract key phrase (3-6 words)
   */
  extractKeyPhrase(sentence) {
    const words = sentence
      .replace(/^(Insight:|Finding:|Conclusion:)/i, '')
      .trim()
      .split(/\s+/);
    
    // Find the most important continuous phrase
    const stopWords = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for']);
    
    let phrases = [];
    let currentPhrase = [];
    
    for (const word of words) {
      const cleanWord = word.replace(/[^\w]/g, '').toLowerCase();
      
      if (stopWords.has(cleanWord) && currentPhrase.length > 0) {
        if (currentPhrase.length >= 2) {
          phrases.push(currentPhrase.join(' '));
        }
        currentPhrase = [];
      } else if (!stopWords.has(cleanWord)) {
        currentPhrase.push(word);
        if (currentPhrase.length === 5) {
          phrases.push(currentPhrase.join(' '));
          currentPhrase = [];
        }
      }
    }
    
    if (currentPhrase.length >= 2) {
      phrases.push(currentPhrase.join(' '));
    }
    
    // Return longest phrase, or first 5 words
    if (phrases.length > 0) {
      phrases.sort((a, b) => b.split(' ').length - a.split(' ').length);
      return phrases[0];
    }
    
    return words.slice(0, 5).join(' ');
  }

  /**
   * Assess quality of extractive summary
   */
  assessQuality(scoredSentences) {
    if (scoredSentences.length === 0) return 0;
    
    const topScore = scoredSentences[0].score;
    const avgScore = scoredSentences.reduce((sum, s) => sum + s.score, 0) / scoredSentences.length;
    
    // If top sentence is clearly better than average, high quality
    const ratio = topScore / (avgScore || 1);
    
    if (ratio > 2.0) return 0.9;
    if (ratio > 1.5) return 0.8;
    if (ratio > 1.2) return 0.7;
    return 0.6;
  }
}

module.exports = { ExtractiveSummarizer };

