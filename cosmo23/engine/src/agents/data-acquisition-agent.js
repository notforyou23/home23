/**
 * DataAcquisitionAgent — Web scraping, API consumption, file downloading, feed ingestion
 *
 * Extends ExecutionBaseAgent with data acquisition capabilities:
 *  - Web scraping via curl, wget, playwright, scrapy, cheerio, beautiful-soup
 *  - API consumption with pagination, auth, rate limiting
 *  - File downloading via aria2c, wget, curl
 *  - Feed ingestion (RSS, Atom, JSON feeds)
 *  - Video/audio downloading via yt-dlp
 *  - robots.txt awareness and ethical scraping
 *
 * Tracks all acquisitions in a structured manifest:
 *  - sources contacted, status codes, timestamps, content hashes
 *  - pages acquired, files downloaded, bytes transferred
 *  - discovered schema, quality assessment
 *
 * Output contract:
 *   outputs/data-acquisition/<agentId>/
 *     manifest.json          — Full acquisition manifest
 *     raw/                   — Raw downloaded content (HTML, JSON, files)
 *     extracted/             — Cleaned/extracted content
 *     sources.json           — Source URLs with status, timestamps, hashes
 *     crawl-log.jsonl        — Full crawl audit trail
 *
 * Handoff target: datapipeline (for transformation and loading)
 */

const { ExecutionBaseAgent } = require('./execution-base-agent');
const path = require('path');
const fs = require('fs').promises;

class DataAcquisitionAgent extends ExecutionBaseAgent {
  constructor(mission, config, logger, eventEmitter = null) {
    super(mission, config, logger, eventEmitter);

    // ── Acquisition manifest ────────────────────────────────────────────────
    this.acquisitionManifest = {
      sources: [],           // { url, status, timestamp, contentHash }
      pagesAcquired: 0,
      filesDownloaded: 0,
      bytesAcquired: 0,
      discoveredSchema: null, // { fields: [...], types: {...} }
      qualityAssessment: null,
      errors: [],
      startedAt: null,
      completedAt: null
    };

    // ── Crawl log (JSONL entries) ───────────────────────────────────────────
    this._crawlLog = [];
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Abstract method implementations
  // ═══════════════════════════════════════════════════════════════════════════

  getAgentType() {
    return 'dataacquisition';
  }

  getDomainKnowledge() {
    return `## Role: Data Acquisition Specialist

You acquire data from external sources: websites, APIs, files, feeds.
Your FIRST tool call should be an action, not a plan.

## Operating Procedure
1. ANALYZE mission → identify target URLs, data format, scope
2. CHECK robots.txt for every target domain (use check_robots_txt tool)
3. START with curl (simplest). Escalate to playwright ONLY if curl returns <1KB HTML
4. SAVE raw content to raw/ as you acquire it — don't wait until the end
5. EXTRACT structured data to extracted/ — clean, parse, structure
6. LOG every source via log_source tool after each request
7. WRITE manifest via save_manifest when complete

## Escalation Ladder
curl → wget → cheerio/node → playwright → scrapy
80% of tasks need only curl. Do not over-engineer.

## Ethics
- Always check robots.txt before crawling
- 1-2 second delay between requests to same domain
- Respect Crawl-delay directives
- Never bypass CAPTCHAs or access controls

## Output Contract
- raw/           — original downloaded content (HTML, JSON, files)
- extracted/     — cleaned, structured data
- manifest.json  — acquisition summary (auto-maintained via save_manifest)
- sources.json   — all URLs contacted with status codes`;
  }

  /**
   * Returns relevant sections of domain reference material based on mission keywords.
   * Called by runAgenticLoop when building the context message — NOT part of system prompt.
   */
  _getDomainReferenceForMission() {
    const mission = (this.mission?.description || '').toLowerCase();
    const sections = [];

    // Only include reference material relevant to this specific mission
    if (mission.includes('api') || mission.includes('endpoint') || mission.includes('pagination')) {
      sections.push(`### API Patterns
- Offset/limit: \`?offset=0&limit=100\`, increment offset
- Cursor: response has \`next_cursor\`, pass as \`?cursor=abc\`
- Next-link: follow \`next\` URL in response body or \`Link\` header
- Page number: \`?page=1&per_page=50\`, increment until empty
- Auth: Bearer \`-H "Authorization: Bearer TOKEN"\`, API key \`-H "X-API-Key: KEY"\`
- Rate limiting: respect Retry-After, 429=backoff, default 1-2s between requests`);
    }

    if (mission.includes('javascript') || mission.includes('spa') || mission.includes('react') ||
        mission.includes('dynamic') || mission.includes('rendered')) {
      sections.push(`### JS Rendering
- If curl returns <5KB HTML for a page that should have content → JS-rendered
- Look for: __NEXT_DATA__, window.__INITIAL_STATE__, <div id="root">
- Escalate to playwright: \`npx playwright install chromium\` then script
- Some SPAs expose API endpoints in their JS bundle — check network tab first`);
    }

    if (mission.includes('download') || mission.includes('mirror') || mission.includes('recursive')) {
      sections.push(`### Bulk Downloads
- wget recursive: \`wget -r -l 2 -np -nd -A "*.csv" URL\`
- Resume: \`wget -c URL\`
- Parallel: \`aria2c -x 4 -d /tmp/downloads URL\`
- File list: \`aria2c -i urls.txt -d /tmp/downloads\``);
    }

    if (mission.includes('video') || mission.includes('audio') || mission.includes('youtube')) {
      sections.push(`### Media Downloads
- yt-dlp for video/audio: \`yt-dlp -o "output.%(ext)s" URL\`
- Audio only: \`yt-dlp -x --audio-format mp3 URL\`
- List formats: \`yt-dlp -F URL\``);
    }

    return sections.length > 0 ? sections.join('\n\n') : null;
  }

  getToolSchema() {
    const tools = [...this.getBaseToolSchema()];

    // ── Data acquisition-specific tools ──────────────────────────────────────
    tools.push(
      {
        type: 'function',
        function: {
          name: 'discover_schema',
          description: 'Analyze sample data (JSON, CSV, or HTML table) to identify fields, types, and structure. Pass raw content and get back a schema definition.',
          parameters: {
            type: 'object',
            properties: {
              data: {
                type: 'string',
                description: 'Sample data to analyze (JSON string, CSV text, or HTML table)'
              },
              format: {
                type: 'string',
                enum: ['json', 'csv', 'html', 'auto'],
                description: 'Data format (default: auto-detect)'
              }
            },
            required: ['data'],
            additionalProperties: false
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'check_robots_txt',
          description: 'Fetch and parse robots.txt for a domain. Returns allowed/disallowed paths and crawl-delay directives.',
          parameters: {
            type: 'object',
            properties: {
              domain: {
                type: 'string',
                description: 'Domain to check (e.g., "example.com" or "https://example.com")'
              },
              user_agent: {
                type: 'string',
                description: 'User-agent to check rules for (default: "*")'
              }
            },
            required: ['domain'],
            additionalProperties: false
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'save_manifest',
          description: 'Write the current acquisition manifest to disk. Call this periodically and at the end of acquisition to persist progress.',
          parameters: {
            type: 'object',
            properties: {
              summary: {
                type: 'string',
                description: 'Optional summary text to include in the manifest'
              }
            },
            additionalProperties: false
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'log_source',
          description: 'Record a source URL in the acquisition manifest with its status, timestamp, and optional content hash.',
          parameters: {
            type: 'object',
            properties: {
              url: { type: 'string', description: 'Source URL' },
              status: { type: 'number', description: 'HTTP status code (0 for connection error)' },
              content_hash: { type: 'string', description: 'SHA-256 hash of content (optional)' },
              content_type: { type: 'string', description: 'Content-Type header value (optional)' },
              bytes: { type: 'number', description: 'Content length in bytes (optional)' },
              error: { type: 'string', description: 'Error message if request failed (optional)' }
            },
            required: ['url', 'status'],
            additionalProperties: false
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'update_manifest_stats',
          description: 'Update acquisition statistics in the manifest (pages acquired, files downloaded, bytes).',
          parameters: {
            type: 'object',
            properties: {
              pages_acquired: { type: 'number', description: 'Number of pages/records acquired' },
              files_downloaded: { type: 'number', description: 'Number of files downloaded' },
              bytes_acquired: { type: 'number', description: 'Total bytes acquired' },
              quality_notes: { type: 'string', description: 'Quality assessment notes' }
            },
            additionalProperties: false
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'set_discovered_schema',
          description: 'Store the discovered data schema in the acquisition manifest.',
          parameters: {
            type: 'object',
            properties: {
              fields: {
                type: 'array',
                items: { type: 'string' },
                description: 'Field names discovered in the data'
              },
              types: {
                type: 'object',
                description: 'Mapping of field names to their types (string, number, boolean, date, array, object, null)',
                additionalProperties: { type: 'string' }
              },
              sample_count: {
                type: 'number',
                description: 'Number of records analyzed to determine schema'
              },
              notes: {
                type: 'string',
                description: 'Notes about the schema (e.g., optional fields, nested structures)'
              }
            },
            required: ['fields', 'types'],
            additionalProperties: false
          }
        }
      }
    );

    return tools;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Lifecycle
  // ═══════════════════════════════════════════════════════════════════════════

  async onStart() {
    await super.onStart();

    // Create output directory structure
    const rawDir = path.join(this._outputDir, 'raw');
    const extractedDir = path.join(this._outputDir, 'extracted');

    await fs.mkdir(rawDir, { recursive: true });
    await fs.mkdir(extractedDir, { recursive: true });

    // Initialize manifest timestamp
    this.acquisitionManifest.startedAt = new Date().toISOString();

    this.logger.info('DataAcquisitionAgent started', {
      agentId: this.agentId,
      outputDir: this._outputDir,
      mission: (this.mission.description || '').substring(0, 120)
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Execute — main intelligence
  // ═══════════════════════════════════════════════════════════════════════════

  async execute() {
    this.logger.info('DataAcquisitionAgent executing mission', {
      agentId: this.agentId,
      mission: this.mission.description
    });

    await this.reportProgress(5, 'Initializing data acquisition agent');

    // ── Parse mission context ─────────────────────────────────────────────
    const missionDescription = this.mission.description || '';
    const missionMetadata = this.mission.metadata || {};

    // Check for prior artifacts (from enrichMissionWithArtifacts in agent-executor)
    const priorArtifacts = missionMetadata.priorArtifacts || missionMetadata.artifacts || [];
    const hasPriorWork = priorArtifacts.length > 0;

    if (hasPriorWork) {
      this.logger.info('DataAcquisitionAgent found prior artifacts', {
        count: priorArtifacts.length,
        refs: priorArtifacts.map(a => typeof a === 'string' ? a : a.path || a.ref).slice(0, 5)
      });
    }

    // ── Build system prompt (Layer 1 + Layer 2) ────────────────────────────
    const systemPrompt = this._buildSystemPrompt(hasPriorWork, priorArtifacts);

    // ── Execute agentic loop (Layer 3 context auto-gathered by runAgenticLoop) ──
    // Pass null for initialContext so runAgenticLoop auto-gathers pre-flight context
    // via gatherPreFlightContext() + buildContextMessage() + _getDomainReferenceForMission()
    const result = await this.runAgenticLoop(systemPrompt, null);

    // ── Finalize manifest ────────────────────────────────────────────────────
    this.acquisitionManifest.completedAt = new Date().toISOString();
    await this._writeManifest();
    await this._writeSources();
    await this._writeCrawlLog();

    // ── Auto-consolidate: ingest all scraped JSON into a SQLite database ────
    // This is deterministic work — no LLM needed. The database becomes the
    // handoff artifact for downstream agents (datapipeline, analysis, synthesis).
    try {
      const dbResult = await this._consolidateToDatabase();
      if (dbResult) {
        result.database = dbResult;
        this.logger.info('📦 Auto-consolidated scraped data into database', {
          dbPath: dbResult.dbPath,
          records: dbResult.totalRecords,
          files: dbResult.filesIngested
        });
      }
    } catch (err) {
      this.logger.warn('Auto-consolidation failed (non-fatal)', { error: err.message });
    }

    return result;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // System Prompt Construction
  // ═══════════════════════════════════════════════════════════════════════════

  _buildSystemPrompt(hasPriorWork, priorArtifacts) {
    // Three-layer architecture: COSMO identity + agent behavioral prompt
    // Domain knowledge is NOT here — it goes in the user message via _getDomainReferenceForMission()
    const behavioralPrompt = this.getDomainKnowledge() + `

## Output Directory: ${this._outputDir}
- raw/           — original downloads
- extracted/     — structured data
- manifest.json  — acquisition summary
- sources.json   — URLs + status codes
- crawl-log.jsonl — audit trail`;

    return this.buildCOSMOSystemPrompt(behavioralPrompt);
  }

  _buildMissionContext(hasPriorWork, priorArtifacts) {
    const parts = [
      `Mission: ${this.mission.description}`,
      `Output directory: ${this._outputDir}`,
      `Raw content directory: ${path.join(this._outputDir, 'raw')}`,
      `Extracted content directory: ${path.join(this._outputDir, 'extracted')}`
    ];

    if (this.mission.successCriteria && this.mission.successCriteria.length > 0) {
      parts.push(`Success criteria:\n${this.mission.successCriteria.map(c => `  - ${c}`).join('\n')}`);
    }

    if (this.mission.metadata?.targetUrls) {
      const urls = Array.isArray(this.mission.metadata.targetUrls)
        ? this.mission.metadata.targetUrls
        : [this.mission.metadata.targetUrls];
      parts.push(`Target URLs:\n${urls.map(u => `  - ${u}`).join('\n')}`);
    }

    if (this.mission.metadata?.targetDomain) {
      parts.push(`Target domain: ${this.mission.metadata.targetDomain}`);
    }

    if (this.mission.metadata?.dataFormat) {
      parts.push(`Expected data format: ${this.mission.metadata.dataFormat}`);
    }

    if (this.mission.metadata?.apiKey) {
      parts.push(`API key provided: [available in mission metadata — use via headers]`);
    }

    if (this.mission.metadata?.context) {
      parts.push(`Additional context: ${this.mission.metadata.context}`);
    }

    if (this.mission.metadata?.maxPages) {
      parts.push(`Maximum pages to acquire: ${this.mission.metadata.maxPages}`);
    }

    if (hasPriorWork) {
      parts.push(`\nPrior artifacts are available — check them before starting acquisition.`);
    }

    return parts.join('\n\n');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Tool Dispatch — extends parent with acquisition-specific tools
  // ═══════════════════════════════════════════════════════════════════════════

  async dispatchToolCall(name, args) {
    switch (name) {
      case 'discover_schema':
        return this._discoverSchema(args);

      case 'check_robots_txt':
        return this._checkRobotsTxt(args);

      case 'save_manifest':
        return this._saveManifest(args);

      case 'log_source':
        return this._logSource(args);

      case 'update_manifest_stats':
        return this._updateManifestStats(args);

      case 'set_discovered_schema':
        return this._setDiscoveredSchema(args);

      // Delegate to parent for base execution primitives
      default:
        return super.dispatchToolCall(name, args);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Tool Implementations
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Analyze sample data to discover its schema (fields, types, structure).
   */
  async _discoverSchema(args) {
    const { data, format } = args;

    if (!data || typeof data !== 'string' || data.trim().length === 0) {
      return { error: 'No data provided for schema discovery' };
    }

    const detectedFormat = format || this._detectFormat(data);
    const schema = { fields: [], types: {}, format: detectedFormat, sampleSize: 0 };

    try {
      if (detectedFormat === 'json') {
        const parsed = JSON.parse(data);
        const records = Array.isArray(parsed) ? parsed : (parsed.data || parsed.results || parsed.items || [parsed]);

        schema.sampleSize = records.length;

        // Collect all fields across all records
        const fieldTypes = {};
        for (const record of records) {
          if (typeof record === 'object' && record !== null) {
            for (const [key, value] of Object.entries(record)) {
              const type = this._inferType(value);
              if (!fieldTypes[key]) {
                fieldTypes[key] = new Set();
              }
              fieldTypes[key].add(type);
            }
          }
        }

        schema.fields = Object.keys(fieldTypes).sort();
        schema.types = {};
        for (const [field, types] of Object.entries(fieldTypes)) {
          const typeArr = [...types];
          schema.types[field] = typeArr.length === 1 ? typeArr[0] : typeArr.join('|');
        }

      } else if (detectedFormat === 'csv') {
        const lines = data.trim().split('\n');
        if (lines.length > 0) {
          // Detect delimiter
          const delimiter = this._detectDelimiter(lines[0]);
          const headers = lines[0].split(delimiter).map(h => h.trim().replace(/^["']|["']$/g, ''));
          schema.fields = headers;
          schema.sampleSize = Math.max(0, lines.length - 1);

          // Infer types from first few data rows
          const dataLines = lines.slice(1, Math.min(11, lines.length));
          const fieldTypes = {};
          for (const line of dataLines) {
            const values = line.split(delimiter).map(v => v.trim().replace(/^["']|["']$/g, ''));
            for (let i = 0; i < headers.length && i < values.length; i++) {
              const type = this._inferTypeFromString(values[i]);
              if (!fieldTypes[headers[i]]) {
                fieldTypes[headers[i]] = new Set();
              }
              fieldTypes[headers[i]].add(type);
            }
          }
          schema.types = {};
          for (const [field, types] of Object.entries(fieldTypes)) {
            const typeArr = [...types];
            schema.types[field] = typeArr.length === 1 ? typeArr[0] : typeArr.join('|');
          }
        }

      } else if (detectedFormat === 'html') {
        // Extract table structure from HTML
        const tableMatch = data.match(/<table[^>]*>([\s\S]*?)<\/table>/i);
        if (tableMatch) {
          const headerMatch = tableMatch[1].match(/<th[^>]*>([\s\S]*?)<\/th>/gi);
          if (headerMatch) {
            schema.fields = headerMatch.map(h =>
              h.replace(/<[^>]+>/g, '').trim()
            );
            schema.types = {};
            for (const field of schema.fields) {
              schema.types[field] = 'string'; // HTML tables default to string
            }
          }

          // Count rows
          const rowMatches = tableMatch[1].match(/<tr[^>]*>/gi);
          schema.sampleSize = rowMatches ? Math.max(0, rowMatches.length - 1) : 0;
        } else {
          return { error: 'No table found in HTML data', format: detectedFormat };
        }
      } else {
        return { error: `Unsupported format: ${detectedFormat}`, hint: 'Supported: json, csv, html' };
      }

      // Store in manifest
      this.acquisitionManifest.discoveredSchema = {
        fields: schema.fields,
        types: schema.types,
        sampleCount: schema.sampleSize,
        format: schema.format,
        discoveredAt: new Date().toISOString()
      };

      this._logCrawlEntry('discover_schema', { format: schema.format, fields: schema.fields.length });

      return {
        success: true,
        schema,
        summary: `Discovered ${schema.fields.length} fields from ${schema.sampleSize} ${detectedFormat} records`
      };

    } catch (err) {
      return { error: `Schema discovery failed: ${err.message}`, format: detectedFormat };
    }
  }

  /**
   * Fetch and parse robots.txt for a domain.
   */
  async _checkRobotsTxt(args) {
    let { domain, user_agent } = args;
    const ua = user_agent || '*';

    // Normalize domain to URL
    if (!domain.startsWith('http')) {
      domain = `https://${domain}`;
    }
    // Strip path — only want the origin
    try {
      const url = new URL(domain);
      domain = `${url.protocol}//${url.host}`;
    } catch {
      return { error: `Invalid domain: ${domain}` };
    }

    const robotsUrl = `${domain}/robots.txt`;

    try {
      const result = await this.httpFetch(robotsUrl, { timeout: 10000 });

      if (result.status === 404 || result.status === 0) {
        this._logCrawlEntry('check_robots_txt', { domain, status: result.status, result: 'no_robots_txt' });
        return {
          exists: false,
          domain,
          message: 'No robots.txt found — all paths are allowed by default',
          allowed: true
        };
      }

      if (result.status !== 200) {
        this._logCrawlEntry('check_robots_txt', { domain, status: result.status, result: 'error' });
        return {
          exists: false,
          domain,
          status: result.status,
          message: `robots.txt returned HTTP ${result.status}`,
          allowed: true // assume allowed on error
        };
      }

      // Parse robots.txt
      const parsed = this._parseRobotsTxt(result.body, ua);

      this._logCrawlEntry('check_robots_txt', {
        domain,
        status: 200,
        disallowed: parsed.disallowed.length,
        crawlDelay: parsed.crawlDelay
      });

      return {
        exists: true,
        domain,
        userAgent: ua,
        disallowed: parsed.disallowed,
        allowed: parsed.allowed,
        crawlDelay: parsed.crawlDelay,
        sitemaps: parsed.sitemaps,
        raw: result.body.substring(0, 2000) // Include first 2KB of raw robots.txt
      };

    } catch (err) {
      this._logCrawlEntry('check_robots_txt', { domain, error: err.message });
      return {
        exists: false,
        domain,
        error: err.message,
        message: 'Failed to fetch robots.txt — proceed with caution',
        allowed: true
      };
    }
  }

  /**
   * Write the acquisition manifest to disk.
   */
  async _saveManifest(args) {
    const summary = args?.summary || null;

    try {
      await this._writeManifest(summary);
      return {
        success: true,
        path: path.join(this._outputDir, 'manifest.json'),
        stats: {
          sources: this.acquisitionManifest.sources.length,
          pagesAcquired: this.acquisitionManifest.pagesAcquired,
          filesDownloaded: this.acquisitionManifest.filesDownloaded,
          bytesAcquired: this.acquisitionManifest.bytesAcquired,
          hasSchema: this.acquisitionManifest.discoveredSchema !== null,
          errors: this.acquisitionManifest.errors.length
        }
      };
    } catch (err) {
      return { error: `Failed to save manifest: ${err.message}` };
    }
  }

  /**
   * Record a source URL in the manifest.
   */
  _logSource(args) {
    const entry = {
      url: args.url,
      status: args.status,
      timestamp: new Date().toISOString(),
      contentHash: args.content_hash || null,
      contentType: args.content_type || null,
      bytes: args.bytes || 0,
      error: args.error || null
    };

    this.acquisitionManifest.sources.push(entry);

    // Track successful acquisitions
    if (args.status >= 200 && args.status < 400) {
      if (args.bytes) {
        this.acquisitionManifest.bytesAcquired += args.bytes;
      }
    } else if (args.error) {
      this.acquisitionManifest.errors.push({
        url: args.url,
        status: args.status,
        error: args.error,
        timestamp: entry.timestamp
      });
    }

    this._logCrawlEntry('log_source', {
      url: args.url,
      status: args.status,
      bytes: args.bytes || 0
    });

    return {
      success: true,
      totalSources: this.acquisitionManifest.sources.length,
      totalBytes: this.acquisitionManifest.bytesAcquired,
      totalErrors: this.acquisitionManifest.errors.length
    };
  }

  /**
   * Update manifest statistics.
   */
  _updateManifestStats(args) {
    if (args.pages_acquired !== undefined) {
      this.acquisitionManifest.pagesAcquired = args.pages_acquired;
    }
    if (args.files_downloaded !== undefined) {
      this.acquisitionManifest.filesDownloaded = args.files_downloaded;
    }
    if (args.bytes_acquired !== undefined) {
      this.acquisitionManifest.bytesAcquired = args.bytes_acquired;
    }
    if (args.quality_notes) {
      this.acquisitionManifest.qualityAssessment = {
        notes: args.quality_notes,
        assessedAt: new Date().toISOString(),
        pagesAcquired: this.acquisitionManifest.pagesAcquired,
        filesDownloaded: this.acquisitionManifest.filesDownloaded,
        sourcesContacted: this.acquisitionManifest.sources.length,
        errorsEncountered: this.acquisitionManifest.errors.length
      };
    }

    return {
      success: true,
      manifest: {
        pagesAcquired: this.acquisitionManifest.pagesAcquired,
        filesDownloaded: this.acquisitionManifest.filesDownloaded,
        bytesAcquired: this.acquisitionManifest.bytesAcquired,
        hasQualityAssessment: this.acquisitionManifest.qualityAssessment !== null
      }
    };
  }

  /**
   * Store a discovered schema in the manifest.
   */
  _setDiscoveredSchema(args) {
    this.acquisitionManifest.discoveredSchema = {
      fields: args.fields,
      types: args.types,
      sampleCount: args.sample_count || 0,
      notes: args.notes || null,
      discoveredAt: new Date().toISOString()
    };

    this._logCrawlEntry('set_discovered_schema', {
      fields: args.fields.length,
      sampleCount: args.sample_count || 0
    });

    return {
      success: true,
      schema: this.acquisitionManifest.discoveredSchema,
      summary: `Schema set with ${args.fields.length} fields from ${args.sample_count || 0} samples`
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Progress Tracking — extend with acquisition-specific ops
  // ═══════════════════════════════════════════════════════════════════════════

  _isProgressOperation(toolName) {
    const acquisitionProgressOps = new Set([
      'discover_schema',
      'check_robots_txt',
      'save_manifest',
      'log_source',
      'update_manifest_stats',
      'set_discovered_schema'
    ]);

    return acquisitionProgressOps.has(toolName) || super._isProgressOperation(toolName);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Accomplishment Assessment
  // ═══════════════════════════════════════════════════════════════════════════

  assessAccomplishment(executeResult, results) {
    const manifest = this.acquisitionManifest;

    // Data acquisition succeeds if ANY data was acquired
    const pagesAcquired = manifest.pagesAcquired || 0;
    const filesDownloaded = manifest.filesDownloaded || 0;
    const sourcesContacted = manifest.sources.length;
    const schemaDiscovered = manifest.discoveredSchema !== null;
    const bytesAcquired = manifest.bytesAcquired || 0;

    // Also check base metrics (files written, commands run)
    const baseAssessment = super.assessAccomplishment(executeResult, results);

    const hasAcquiredData = pagesAcquired > 0 || filesDownloaded > 0 || bytesAcquired > 0;
    const accomplished = hasAcquiredData || baseAssessment.accomplished;

    return {
      accomplished,
      reason: accomplished ? null : 'No data acquired (0 pages, 0 files, 0 bytes)',
      metrics: {
        pagesAcquired,
        filesDownloaded,
        bytesAcquired,
        sourcesContacted,
        schemaDiscovered,
        errorsEncountered: manifest.errors.length,
        ...baseAssessment.metrics
      }
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Handoff
  // ═══════════════════════════════════════════════════════════════════════════

  generateHandoffSpec() {
    const manifest = this.acquisitionManifest;

    // No handoff if nothing was acquired
    const hasData = (manifest.pagesAcquired || 0) > 0
                 || (manifest.filesDownloaded || 0) > 0
                 || (manifest.bytesAcquired || 0) > 0;

    if (!hasData) {
      return null;
    }

    // Collect source URLs
    const sourceUrls = manifest.sources
      .filter(s => s.status >= 200 && s.status < 400)
      .map(s => s.url);

    // Build top findings summary
    const topFindings = [];
    if (manifest.pagesAcquired > 0) {
      topFindings.push(`Acquired ${manifest.pagesAcquired} pages from ${manifest.sources.length} sources`);
    }
    if (manifest.filesDownloaded > 0) {
      topFindings.push(`Downloaded ${manifest.filesDownloaded} files (${this._formatBytes(manifest.bytesAcquired)})`);
    }
    if (manifest.discoveredSchema) {
      topFindings.push(`Discovered schema with ${manifest.discoveredSchema.fields.length} fields`);
    }
    if (manifest.qualityAssessment) {
      topFindings.push(`Quality: ${manifest.qualityAssessment.notes}`);
    }
    if (manifest.errors.length > 0) {
      topFindings.push(`Encountered ${manifest.errors.length} errors during acquisition`);
    }

    return {
      targetAgentType: 'datapipeline',
      reason: 'Data acquisition complete — raw data ready for transformation and loading',
      artifactRefs: [this._outputDir],
      context: {
        sourceAgent: this.agentId,
        sourceType: 'dataacquisition',
        outputDir: this._outputDir,
        discoveredSchema: manifest.discoveredSchema,
        topFindings,
        sourceUrls: sourceUrls.slice(0, 50), // Cap at 50 URLs
        manifest: {
          pagesAcquired: manifest.pagesAcquired,
          filesDownloaded: manifest.filesDownloaded,
          bytesAcquired: manifest.bytesAcquired,
          sourcesContacted: manifest.sources.length,
          errors: manifest.errors.length
        }
      }
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Internal Helpers
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Detect data format from content.
   */
  _detectFormat(data) {
    const trimmed = data.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) return 'json';
    if (trimmed.startsWith('<')) return 'html';
    // CSV heuristic: first line has commas or tabs, subsequent lines match
    const firstLine = trimmed.split('\n')[0];
    if (firstLine.includes(',') || firstLine.includes('\t')) return 'csv';
    return 'json'; // default fallback
  }

  /**
   * Detect CSV delimiter from a header line.
   */
  _detectDelimiter(line) {
    const commas = (line.match(/,/g) || []).length;
    const tabs = (line.match(/\t/g) || []).length;
    const pipes = (line.match(/\|/g) || []).length;
    const semicolons = (line.match(/;/g) || []).length;

    const counts = [
      { delim: ',', count: commas },
      { delim: '\t', count: tabs },
      { delim: '|', count: pipes },
      { delim: ';', count: semicolons }
    ];

    counts.sort((a, b) => b.count - a.count);
    return counts[0].count > 0 ? counts[0].delim : ',';
  }

  /**
   * Infer the type of a JavaScript value.
   */
  _inferType(value) {
    if (value === null || value === undefined) return 'null';
    if (Array.isArray(value)) return 'array';
    if (typeof value === 'boolean') return 'boolean';
    if (typeof value === 'number') return 'number';
    if (typeof value === 'string') {
      // Check for date-like strings
      if (/^\d{4}-\d{2}-\d{2}/.test(value)) return 'date';
      return 'string';
    }
    if (typeof value === 'object') return 'object';
    return 'string';
  }

  /**
   * Infer the type of a string value (from CSV).
   */
  _inferTypeFromString(value) {
    if (!value || value.trim() === '') return 'null';
    if (/^-?\d+$/.test(value)) return 'number';
    if (/^-?\d+\.\d+$/.test(value)) return 'number';
    if (/^(true|false)$/i.test(value)) return 'boolean';
    if (/^\d{4}-\d{2}-\d{2}/.test(value)) return 'date';
    return 'string';
  }

  /**
   * Parse robots.txt content.
   */
  _parseRobotsTxt(content, targetUA) {
    const result = {
      disallowed: [],
      allowed: [],
      crawlDelay: null,
      sitemaps: []
    };

    const lines = content.split('\n');
    let currentUA = null;
    let isRelevantSection = false;

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;

      const colonIndex = line.indexOf(':');
      if (colonIndex === -1) continue;

      const directive = line.substring(0, colonIndex).trim().toLowerCase();
      const value = line.substring(colonIndex + 1).trim();

      if (directive === 'user-agent') {
        currentUA = value;
        isRelevantSection = (currentUA === '*' || currentUA.toLowerCase() === targetUA.toLowerCase());
      } else if (isRelevantSection) {
        if (directive === 'disallow' && value) {
          result.disallowed.push(value);
        } else if (directive === 'allow' && value) {
          result.allowed.push(value);
        } else if (directive === 'crawl-delay') {
          result.crawlDelay = parseFloat(value) || null;
        }
      }

      if (directive === 'sitemap') {
        result.sitemaps.push(value);
      }
    }

    return result;
  }

  /**
   * Log a crawl entry (appended to crawl-log.jsonl on disk at finalization).
   */
  _logCrawlEntry(operation, details) {
    this._crawlLog.push({
      timestamp: new Date().toISOString(),
      operation,
      ...details
    });
  }

  /**
   * Write the manifest.json file.
   */
  async _writeManifest(summary = null) {
    if (!this._outputDir) return;

    const manifest = {
      agentId: this.agentId,
      agentType: 'dataacquisition',
      mission: this.mission.description,
      goalId: this.mission.goalId,
      ...this.acquisitionManifest,
      summary: summary || null
    };

    const manifestPath = path.join(this._outputDir, 'manifest.json');
    try {
      await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
      this.logger.debug('Manifest written', { path: manifestPath });
    } catch (err) {
      this.logger.warn('Failed to write manifest', { error: err.message });
    }
  }

  /**
   * Write the sources.json file.
   */
  async _writeSources() {
    if (!this._outputDir) return;
    if (this.acquisitionManifest.sources.length === 0) return;

    const sourcesPath = path.join(this._outputDir, 'sources.json');
    try {
      await fs.writeFile(
        sourcesPath,
        JSON.stringify(this.acquisitionManifest.sources, null, 2),
        'utf8'
      );
      this.logger.debug('Sources written', {
        path: sourcesPath,
        count: this.acquisitionManifest.sources.length
      });
    } catch (err) {
      this.logger.warn('Failed to write sources', { error: err.message });
    }
  }

  /**
   * Write the crawl-log.jsonl file.
   */
  async _writeCrawlLog() {
    if (!this._outputDir) return;
    if (this._crawlLog.length === 0) return;

    const logPath = path.join(this._outputDir, 'crawl-log.jsonl');
    try {
      const lines = this._crawlLog.map(e => JSON.stringify(e)).join('\n') + '\n';
      await fs.writeFile(logPath, lines, 'utf8');
      this.logger.debug('Crawl log written', {
        path: logPath,
        entries: this._crawlLog.length
      });
    } catch (err) {
      this.logger.warn('Failed to write crawl log', { error: err.message });
    }
  }

  /**
   * Auto-consolidate all JSON data files into a SQLite database.
   * Runs as pure code after the agentic loop — no LLM calls.
   *
   * Scans the agent's output directory for JSON files (excluding manifests),
   * loads all records, infers a unified schema, and inserts into a single table.
   * The database path is written to the manifest for downstream agents.
   *
   * @returns {Object|null} { dbPath, totalRecords, filesIngested, columns }
   */
  async _consolidateToDatabase() {
    if (!this._outputDir) return null;

    const { execSync } = require('child_process');

    // Find all JSON data files (exclude operational files)
    const excludes = new Set(['manifest.json', 'sources.json', '.DS_Store']);
    const jsonFiles = [];

    const walk = async (dir) => {
      let entries;
      try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else if (entry.name.endsWith('.json') && !excludes.has(entry.name)) {
          jsonFiles.push(full);
        }
      }
    };
    await walk(this._outputDir);

    if (jsonFiles.length === 0) return null;

    // Load all records
    const allRecords = [];
    const filesSummary = [];

    for (const fp of jsonFiles) {
      try {
        const raw = await fs.readFile(fp, 'utf8');
        const data = JSON.parse(raw);
        let records;

        if (Array.isArray(data)) {
          records = data.filter(r => r && typeof r === 'object' && !Array.isArray(r));
        } else if (typeof data === 'object') {
          // Dict of arrays? Flatten. Otherwise single record.
          const values = Object.values(data);
          if (values.length > 0 && values.every(v => Array.isArray(v))) {
            records = [];
            for (const [key, items] of Object.entries(data)) {
              for (const item of items) {
                if (item && typeof item === 'object') {
                  item._source_key = key;
                  records.push(item);
                }
              }
            }
          } else {
            records = [data];
          }
        } else {
          continue;
        }

        // Skip files with only 1 record that looks like metadata
        if (records.length === 1 && !records[0].date && !records[0].title && !records[0].name) {
          continue;
        }

        const relPath = path.relative(this._outputDir, fp);
        for (const r of records) r._source_file = relPath;

        allRecords.push(...records);
        filesSummary.push({ file: relPath, records: records.length });
      } catch (err) {
        this.logger.debug('Skipping non-data JSON', { file: fp, error: err.message });
      }
    }

    if (allRecords.length === 0) return null;

    // Collect unified schema (all keys across all records)
    const allKeys = [...new Set(allRecords.flatMap(r => Object.keys(r)))].sort();

    // Create database
    const dbPath = path.join(this._outputDir, 'acquired_data.sqlite');
    const tableName = 'records';

    // Build SQL via sqlite3 CLI (no native bindings needed)
    const colsDef = allKeys.map(k => `"${k}" TEXT`).join(', ');
    const createSQL = `CREATE TABLE IF NOT EXISTS "${tableName}" (id INTEGER PRIMARY KEY AUTOINCREMENT, ${colsDef});`;

    // Write data as a temp JSON file for Python to ingest
    const tempDataPath = path.join(this._outputDir, '_ingest_temp.json');
    const tempSchemaPath = path.join(this._outputDir, '_ingest_schema.json');

    await fs.writeFile(tempDataPath, JSON.stringify(allRecords), 'utf8');
    await fs.writeFile(tempSchemaPath, JSON.stringify(allKeys), 'utf8');

    // Python one-liner to do the actual INSERT (sqlite3 is stdlib)
    const pyScript = `
import json, sqlite3, sys
with open("${tempDataPath}") as f: records = json.load(f)
with open("${tempSchemaPath}") as f: keys = json.load(f)
conn = sqlite3.connect("${dbPath}")
cur = conn.cursor()
cur.execute('DROP TABLE IF EXISTS "${tableName}"')
cur.execute('CREATE TABLE "${tableName}" (id INTEGER PRIMARY KEY AUTOINCREMENT, ${allKeys.map(k => `"${k}" TEXT`).join(", ")})')
inserted = 0
for r in records:
    vals = [json.dumps(r.get(k)) if isinstance(r.get(k), (dict, list)) else str(r[k]) if r.get(k) is not None else None for k in keys]
    cur.execute('INSERT INTO "${tableName}" (${allKeys.map(k => `"${k}"`).join(", ")}) VALUES (${allKeys.map(() => '?').join(', ')})', vals)
    inserted += 1
conn.commit()
conn.close()
print(inserted)
`;

    try {
      const result = execSync(`python3 -c ${JSON.stringify(pyScript)}`, {
        timeout: 30000,
        encoding: 'utf8'
      }).trim();

      const inserted = parseInt(result) || 0;

      // Clean up temp files
      await fs.unlink(tempDataPath).catch(() => {});
      await fs.unlink(tempSchemaPath).catch(() => {});

      // Update manifest with database path
      this.acquisitionManifest.database = {
        path: dbPath,
        table: tableName,
        records: inserted,
        columns: allKeys,
        files: filesSummary
      };
      await this._writeManifest();

      // Register as finding for memory integration
      await this.addFinding(
        `Data consolidated into SQLite database at ${dbPath}: ${inserted} records from ${filesSummary.length} files. ` +
        `Columns: ${allKeys.filter(k => !k.startsWith('_')).join(', ')}`,
        'execution_result'
      );

      return {
        dbPath,
        totalRecords: inserted,
        filesIngested: filesSummary.length,
        columns: allKeys,
        filesSummary
      };
    } catch (err) {
      // Clean up temp files on failure too
      await fs.unlink(tempDataPath).catch(() => {});
      await fs.unlink(tempSchemaPath).catch(() => {});
      throw err;
    }
  }

  /**
   * Format bytes into human-readable string.
   */
  _formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    const value = (bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1);
    return `${value} ${units[i]}`;
  }
}

module.exports = { DataAcquisitionAgent };
