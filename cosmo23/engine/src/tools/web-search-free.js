/**
 * Free Web Search Tool for Local LLM Mode
 *
 * Uses DuckDuckGo's HTML search (no API key required)
 * Provides web search capability without any costs
 *
 * This is designed to work when COSMO is running in local LLM mode
 * where OpenAI's built-in web_search tool isn't available.
 */

const https = require('https');
const http = require('http');

// Real-time event streaming - fallback singleton for CLI mode
let _singletonEvents = null;
function getSingletonEvents() {
  if (!_singletonEvents) {
    _singletonEvents = require('../realtime/event-emitter').cosmoEvents;
  }
  return _singletonEvents;
}

class FreeWebSearch {
  constructor(logger = null, config = {}, eventEmitter = null) {
    this.logger = logger;
    this.events = eventEmitter;  // Multi-tenant event emitter
    this.userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    this.maxResults = 8;
    this.timeout = 10000; // 10 seconds

    // Brave Search API (most reliable, free tier: 2000 queries/month)
    this.braveApiKey = config.braveApiKey || process.env.BRAVE_API_KEY || '';

    // SearXNG configuration (self-hosted meta-search)
    const rawSearxngUrl = config.searxngUrl || process.env.SEARXNG_URL || null;
    this.searxngUrl = rawSearxngUrl ? rawSearxngUrl.replace(/\/+$/, '') : null;

    // Rate limiting and failure tracking (only for DuckDuckGo fallback)
    this.lastSearchTime = 0;
    this.minSearchInterval = 4000; // 4 seconds between searches (DuckDuckGo rate limit safe)
    this.consecutiveFailures = 0;
    this.maxConsecutiveFailures = 5; // Give up after 5 failures
    this.failureCooldown = 120000; // 2 minute cooldown after max failures
    this.lastFailureTime = 0;

    if (this.braveApiKey) {
      this.logger?.info?.('Brave Search configured as primary', { hasKey: true });
    }
    if (this.searxngUrl) {
      this.logger?.info?.('SearXNG configured as fallback search', { url: this.searxngUrl });
    }
  }

  /**
   * Get the event emitter for this search context.
   */
  _getEvents() {
    if (this.events) return this.events;
    return getSingletonEvents();
  }

  /**
   * Check if we should skip search due to rate limiting or consecutive failures
   */
  shouldSkipSearch() {
    const now = Date.now();

    // If we've had too many consecutive failures, check cooldown
    if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
      if (now - this.lastFailureTime < this.failureCooldown) {
        this.logger?.info?.('Web search in cooldown after consecutive failures', {
          cooldownRemaining: Math.round((this.failureCooldown - (now - this.lastFailureTime)) / 1000) + 's'
        });
        return true;
      }
      // Cooldown expired, reset counter
      this.consecutiveFailures = 0;
    }

    return false;
  }

  /**
   * Apply rate limiting delay if needed
   */
  async applyRateLimit() {
    const now = Date.now();
    const timeSinceLastSearch = now - this.lastSearchTime;

    if (timeSinceLastSearch < this.minSearchInterval) {
      const delay = this.minSearchInterval - timeSinceLastSearch;
      await new Promise(r => setTimeout(r, delay));
    }

    this.lastSearchTime = Date.now();
  }

  /**
   * Perform a web search
   * Priority: Brave API → SearXNG → DuckDuckGo
   * @param {string} query - Search query
   * @param {object} options - Search options
   * @returns {Promise<object>} Search results
   */
  async search(query, options = {}) {
    const { maxResults = this.maxResults } = options;

    // 1. Try Brave Search API first (most reliable, no CAPTCHA/rate issues)
    if (this.braveApiKey) {
      try {
        this.logger?.info?.('Web search (Brave)', { query, maxResults });
        const results = await this.searchBrave(query, maxResults);

        if (results.length > 0) {
          this._getEvents().emitEvent('web_search', {
            query, resultCount: results.length, source: 'brave',
            sources: results.slice(0, 3).map(r => r.title || r.url).filter(Boolean)
          });
          return { success: true, query, results, source: 'brave', resultCount: results.length };
        }
        this.logger?.warn?.('Brave returned no results, trying SearXNG');
      } catch (error) {
        this.logger?.warn?.('Brave search failed, trying SearXNG', { error: error.message });
      }
    }

    // 2. Try SearXNG if configured
    if (this.searxngUrl) {
      try {
        this.logger?.info?.('Web search (SearXNG)', { query, maxResults });
        const results = await this.searchSearXNG(query, maxResults);

        if (results.length > 0) {
          this._getEvents().emitEvent('web_search', {
            query, resultCount: results.length, source: 'searxng',
            sources: results.slice(0, 3).map(r => r.title || r.url).filter(Boolean)
          });
          return { success: true, query, results, source: 'searxng', resultCount: results.length };
        }
        this.logger?.warn?.('SearXNG returned no results, trying DuckDuckGo');
      } catch (error) {
        this.logger?.warn?.('SearXNG search failed, falling back to DuckDuckGo', {
          error: error.message
        });
      }
    }

    // Check if we should skip DuckDuckGo due to consecutive failures
    if (this.shouldSkipSearch()) {
      return {
        success: false,
        query,
        results: [],
        error: 'Search temporarily disabled due to rate limiting',
        message: 'Web search is in cooldown. Using AI training knowledge instead.',
        skipped: true
      };
    }

    // Apply rate limiting for DuckDuckGo
    await this.applyRateLimit();

    this.logger?.info?.('Web search (DuckDuckGo)', { query, maxResults });

    try {
      // Try DuckDuckGo HTML search
      const results = await this.searchDuckDuckGo(query, maxResults);

      if (results.length > 0) {
        // Success - reset failure counter
        this.consecutiveFailures = 0;

        // Emit web search event for Watch Panel
        this._getEvents().emitEvent('web_search', {
          query: query,
          resultCount: results.length,
          source: 'duckduckgo',
          sources: results.slice(0, 3).map(r => r.title || r.url).filter(Boolean)
        });

        return {
          success: true,
          query,
          results,
          source: 'duckduckgo',
          resultCount: results.length
        };
      }

      // No results but no error - don't count as failure
      return {
        success: true,
        query,
        results: [],
        source: 'duckduckgo',
        resultCount: 0,
        message: 'No results found. Try a different query.'
      };

    } catch (error) {
      // Track failure
      this.consecutiveFailures++;
      this.lastFailureTime = Date.now();

      this.logger?.error?.('Web search failed', {
        query,
        error: error.message,
        consecutiveFailures: this.consecutiveFailures
      });

      return {
        success: false,
        query,
        results: [],
        error: error.message,
        message: 'Search temporarily unavailable. The AI will use its training knowledge instead.'
      };
    }
  }

  /**
   * Search using Brave Search API (reliable, free tier: 2000 queries/month)
   */
  async searchBrave(query, maxResults) {
    if (!this.braveApiKey) return [];

    const encodedQuery = encodeURIComponent(query);
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodedQuery}&count=${Math.min(maxResults, 20)}`;

    const response = await this.fetchJson(url, {
      'X-Subscription-Token': this.braveApiKey,
      'Accept': 'application/json'
    });

    if (!response?.web?.results) return [];

    return response.web.results.slice(0, maxResults).map((result, i) => ({
      title: result.title || 'Untitled',
      url: result.url,
      snippet: result.description?.replace(/<\/?[^>]+(>|$)/g, '') || '',
      position: i + 1,
      engine: 'brave'
    }));
  }

  /**
   * Search using SearXNG (self-hosted meta-search engine)
   * @param {string} query - Search query
   * @param {number} maxResults - Maximum results to return
   * @returns {Promise<Array>} Search results
   */
  async searchSearXNG(query, maxResults) {
    const encodedQuery = encodeURIComponent(query);
    const url = `${this.searxngUrl}/search?q=${encodedQuery}&format=json&categories=general`;

    const response = await this.fetchJson(url);

    if (!response) {
      return [];
    }

    // Primary: use search results
    if (response.results && response.results.length > 0) {
      return response.results.slice(0, maxResults).map((result, i) => ({
        title: result.title || 'Untitled',
        url: result.url,
        snippet: result.content || result.snippet || 'No description available',
        position: i + 1,
        engine: result.engine || 'unknown'
      }));
    }

    // Fallback: extract from infoboxes (Wikipedia/Wikidata data still available when engines are blocked)
    if (response.infoboxes && response.infoboxes.length > 0) {
      const results = [];
      for (const box of response.infoboxes) {
        if (box.content || box.infobox) {
          results.push({
            title: box.infobox || 'Info',
            url: box.id || box.urls?.[0]?.url || '',
            snippet: box.content || '',
            position: results.length + 1,
            engine: 'infobox'
          });
          // Add linked URLs as additional results
          if (box.urls) {
            for (const link of box.urls.slice(0, 3)) {
              results.push({
                title: `${box.infobox} - ${link.title}`,
                url: link.url,
                snippet: box.content?.substring(0, 200) || '',
                position: results.length + 1,
                engine: 'infobox'
              });
            }
          }
        }
      }
      if (results.length > 0) {
        this.logger?.info?.('SearXNG: using infobox data (search engines unavailable)', { resultCount: results.length });
        return results.slice(0, maxResults);
      }
    }

    // Log unresponsive engines for diagnostics
    if (response.unresponsive_engines?.length > 0) {
      this.logger?.warn?.('SearXNG: all search engines unavailable', {
        engines: response.unresponsive_engines.map(e => `${e[0]}: ${e[1]}`).join(', ')
      });
    }

    return [];
  }

  /**
   * Fetch JSON from URL
   */
  fetchJson(url, extraHeaders = {}) {
    return new Promise((resolve, reject) => {
      const protocol = url.startsWith('https') ? https : http;

      const req = protocol.get(url, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': this.userAgent,
          ...extraHeaders
        },
        timeout: this.timeout
      }, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }

        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error('Invalid JSON response'));
          }
        });
        res.on('error', reject);
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });
    });
  }

  /**
   * Search using DuckDuckGo HTML (no API key needed)
   */
  async searchDuckDuckGo(query, maxResults) {
    const encodedQuery = encodeURIComponent(query);

    // Try HTML version first, then Lite as fallback
    const endpoints = [
      `https://html.duckduckgo.com/html/?q=${encodedQuery}&kl=us-en`,
      `https://lite.duckduckgo.com/lite/?q=${encodedQuery}&kl=us-en`
    ];

    let lastError;

    for (const url of endpoints) {
      // Retry logic for rate limiting (HTTP 202) with exponential backoff + jitter
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const html = await this.fetchUrl(url, attempt);
          const results = this.parseDuckDuckGoHTML(html, maxResults);
          if (results.length > 0) {
            return results;
          }
          // If no results, try next attempt/endpoint
        } catch (error) {
          lastError = error;
          if (error.message.includes('202') && attempt < 3) {
            // Exponential backoff with jitter to avoid thundering herd
            const baseDelay = 2000 * Math.pow(2, attempt - 1); // 2s, 4s
            const jitter = baseDelay * (0.3 + Math.random() * 0.7); // 30-100% of base
            await new Promise(r => setTimeout(r, jitter));
            this.logger?.debug?.('Retrying DuckDuckGo search (202 rate limit)', { attempt: attempt + 1, delayMs: Math.round(jitter), endpoint: url.split('?')[0] });
            continue;
          }
          // Try next endpoint
          break;
        }
      }
    }

    // If all endpoints failed, throw the last error
    if (lastError) {
      throw lastError;
    }
    return [];
  }

  /**
   * Parse DuckDuckGo HTML results (handles both HTML and Lite versions)
   */
  parseDuckDuckGoHTML(html, maxResults) {
    let results = [];

    // Try HTML version format first (class="result__a")
    const resultPattern = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/gi;
    const snippetPattern = /<a[^>]*class="result__snippet"[^>]*>([^<]*(?:<[^>]*>[^<]*)*)<\/a>/gi;

    const titleMatches = [...html.matchAll(resultPattern)];
    const snippetMatches = [...html.matchAll(snippetPattern)];

    if (titleMatches.length > 0) {
      // Parse HTML version
      for (let i = 0; i < Math.min(titleMatches.length, maxResults); i++) {
        const result = this.extractResult(titleMatches[i], snippetMatches[i]);
        if (result) {
          result.position = results.length + 1;
          results.push(result);
        }
      }
    } else {
      // Try Lite version format (simpler table-based layout)
      // Lite uses: <a rel="nofollow" href="...">Title</a> in table cells
      const litePattern = /<a[^>]*rel="nofollow"[^>]*href="([^"]*)"[^>]*>([^<]+)<\/a>/gi;
      const liteMatches = [...html.matchAll(litePattern)];

      for (let i = 0; i < Math.min(liteMatches.length, maxResults); i++) {
        const result = this.extractResult(liteMatches[i], null);
        if (result) {
          result.position = results.length + 1;
          results.push(result);
        }
      }
    }

    return results;
  }

  /**
   * Extract a single result from regex match
   */
  extractResult(titleMatch, snippetMatch) {
    if (!titleMatch) return null;

    let url = titleMatch[1];
    const title = this.cleanText(titleMatch[2]);

    // DuckDuckGo wraps URLs in a redirect - extract the actual URL
    if (url.includes('uddg=')) {
      const uddgMatch = url.match(/uddg=([^&]*)/);
      if (uddgMatch) {
        url = decodeURIComponent(uddgMatch[1]);
      }
    }

    // Get snippet if available
    let snippet = '';
    if (snippetMatch) {
      snippet = this.cleanText(snippetMatch[1]);
    }

    // Skip ads and internal DDG links
    if (url.startsWith('http') && !url.includes('duckduckgo.com')) {
      return {
        title: title || 'Untitled',
        url,
        snippet: snippet || 'No description available'
      };
    }

    return null;
  }

  /**
   * Clean HTML text
   */
  cleanText(text) {
    if (!text) return '';
    return text
      .replace(/<[^>]*>/g, '') // Remove HTML tags
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Fetch URL with timeout
   * @param {string} url - URL to fetch
   * @param {number} attempt - Attempt number (for varying headers)
   */
  fetchUrl(url, attempt = 1) {
    return new Promise((resolve, reject) => {
      const protocol = url.startsWith('https') ? https : http;

      // Vary user agent slightly between attempts to avoid rate limiting
      const userAgents = [
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      ];

      const req = protocol.get(url, {
        headers: {
          'User-Agent': userAgents[(attempt - 1) % userAgents.length],
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'identity',  // Must NOT advertise gzip — Node http.get doesn't auto-decompress
          'DNT': '1',
          'Connection': 'keep-alive',
          'Upgrade-Insecure-Requests': '1',
        },
        timeout: this.timeout
      }, (res) => {
        // Handle redirects
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          this.fetchUrl(res.headers.location, attempt).then(resolve).catch(reject);
          return;
        }

        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }

        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(data));
        res.on('error', reject);
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });
    });
  }

  /**
   * Format results for LLM consumption
   */
  formatForLLM(searchResult) {
    if (!searchResult.success || searchResult.results.length === 0) {
      return `Web search for "${searchResult.query}" returned no results. ${searchResult.message || ''}`;
    }

    let formatted = `Web search results for "${searchResult.query}":\n\n`;

    for (const result of searchResult.results) {
      formatted += `${result.position}. ${result.title}\n`;
      formatted += `   URL: ${result.url}\n`;
      formatted += `   ${result.snippet}\n\n`;
    }

    return formatted;
  }

  /**
   * Search and format in one call (convenience method)
   */
  async searchAndFormat(query, options = {}) {
    const results = await this.search(query, options);
    return {
      ...results,
      formatted: this.formatForLLM(results)
    };
  }
}

// Singleton instance
let searchInstance = null;
let lastConfig = null;

function getSearchInstance(logger = null, config = {}) {
  // Recreate instance if config changed (e.g., SearXNG URL added)
  const configKey = JSON.stringify({ searxngUrl: config.searxngUrl });
  if (!searchInstance || lastConfig !== configKey) {
    searchInstance = new FreeWebSearch(logger, config);
    lastConfig = configKey;
  }
  return searchInstance;
}

module.exports = {
  FreeWebSearch,
  getSearchInstance
};
