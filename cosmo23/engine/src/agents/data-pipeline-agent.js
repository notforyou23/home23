/**
 * DataPipelineAgent — Transforms raw data into structured, queryable knowledge
 *
 * Extends ExecutionBaseAgent with data transformation capabilities:
 *  - ETL (Extract, Transform, Load) pipelines using jq, csvkit, pandas, miller
 *  - Database creation via sqlite3 (primary), duckdb, psql
 *  - Schema inference, DDL generation, index optimization
 *  - Data profiling: column stats, null rates, distribution analysis
 *  - Validation: row counts, referential integrity, constraint checks
 *  - Multi-format export: CSV, JSON, SQL dump, Parquet
 *
 * This is the natural downstream of DataAcquisitionAgent. The handoff flow:
 *   DataAcquisitionAgent (scrape/fetch) → DataPipelineAgent (transform/load)
 *
 * Tracks all pipeline operations in a structured manifest:
 *  - input sources consumed, transforms applied, databases created
 *  - tables with row counts and schemas, validation results
 *  - export files generated, data profile statistics
 *
 * Output contract:
 *   outputs/data-pipeline/<agentId>/
 *     manifest.json          — Pipeline config, schema, stats, quality report
 *     database.sqlite        — The built database
 *     schema.sql             — DDL for reproduction
 *     transforms/            — Generated transformation scripts
 *     validation-report.json — Quality checks and results
 *     exports/               — CSV, JSON, summary outputs
 *
 * Handoff target: analysis or synthesis (structured data ready for insight extraction)
 */

const { ExecutionBaseAgent } = require('./execution-base-agent');
const path = require('path');
const fs = require('fs').promises;

class DataPipelineAgent extends ExecutionBaseAgent {
  constructor(mission, config, logger, eventEmitter = null) {
    super(mission, config, logger, eventEmitter);

    // ── Pipeline manifest ────────────────────────────────────────────────────
    this.pipelineManifest = {
      inputSources: [],        // What data was consumed
      database: null,          // Path to created database
      tables: [],              // { name, rowCount, schema }
      transforms: [],          // What transformations were applied
      validationResults: null,  // Quality check results
      exports: [],             // Generated export files
      dataProfile: null,       // Statistical profile
      startedAt: null,
      completedAt: null
    };

    // ── Pipeline log (JSONL entries) ─────────────────────────────────────────
    this._pipelineLog = [];
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Abstract method implementations
  // ═══════════════════════════════════════════════════════════════════════════

  getAgentType() {
    return 'datapipeline';
  }

  getDomainKnowledge() {
    return `## Role: Data Pipeline Specialist

You transform raw data into structured, queryable databases and exports.
Your FIRST tool call should be an action, not a plan.

## Operating Procedure
1. READ input artifacts — understand what data is available and its schema
2. DESIGN target schema — tables, fields, types, relationships
3. CREATE database (SQLite or DuckDB) with schema
4. LOAD data — parse, transform, validate each record
5. VALIDATE — row counts match source, no nulls in required fields
6. EXPORT if requested — CSV, JSON, or other formats
7. WRITE manifest with schema, record counts, validation results

## Tools: jq, sqlite3, duckdb, csvkit, python/pandas, miller
## Output: database files, schema.sql, validation-report.json, exports/`;
  }

  /**
   * Returns relevant sections of domain reference material based on mission keywords.
   * Called by runAgenticLoop when building the context message — NOT part of system prompt.
   */
  _getDomainReferenceForMission() {
    const mission = (this.mission?.description || '').toLowerCase();
    const sections = [];

    // ETL / transform patterns
    if (mission.includes('transform') || mission.includes('etl') || mission.includes('clean') || mission.includes('convert')) {
      sections.push(`### ETL Patterns
- jq for JSON: \`jq '[.[] | {name: .name, price: .price}]' data.json\`
- csvkit for CSV: \`csvstat data.csv\`, \`csvsql --query "SELECT ..." data.csv\`
- miller for format conversion: \`mlr --icsv --ojson cat data.csv\`
- pandas for complex transforms: groupby, merge, pivot, fillna
- Data cleaning: trim whitespace, normalize dates to ISO 8601, handle nulls per-column
- Preserve raw data — NEVER modify inputs, only create outputs
- Store transform scripts in transforms/ for reproducibility`);
    }

    // Schema inference / auto-detect
    if (mission.includes('auto-detect') || mission.includes('schema') || mission.includes('infer') || mission.includes('profile')) {
      sections.push(`### Schema Inference
- Examine first 100-1000 records to sample data patterns
- Infer column names from headers (CSV) or keys (JSON)
- Detect types: integer, real, text, date, boolean, json
- Identify constraints: NOT NULL, UNIQUE, PRIMARY KEY, FOREIGN KEY
- Handle mixed types: prefer more general type (REAL over INTEGER)
- Use infer_schema tool or profile_data tool to automate
- Write CREATE TABLE statements to schema.sql with indexes and constraints`);
    }

    // DuckDB / analytics
    if (mission.includes('duckdb') || mission.includes('analytics') || mission.includes('parquet') || mission.includes('large')) {
      sections.push(`### DuckDB / Analytics
- Direct CSV query: \`duckdb -c "SELECT * FROM read_csv_auto('data.csv') LIMIT 10"\`
- Direct Parquet: \`duckdb -c "SELECT * FROM 'data.parquet' WHERE year > 2020"\`
- Create table: \`duckdb db.duckdb -c "CREATE TABLE t AS SELECT * FROM read_csv_auto('data.csv')"\`
- Best for: datasets >100MB, columnar analytics, Parquet support
- Vectorized execution — much faster than SQLite for analytical queries`);
    }

    // SQLite specifics
    if (mission.includes('sqlite') || mission.includes('database') || mission.includes('sql') || mission.includes('import')) {
      sections.push(`### SQLite Patterns
- Import CSV: \`sqlite3 db.sqlite ".mode csv" ".import data.csv table"\`
- Performance: \`PRAGMA journal_mode=WAL;\` and \`PRAGMA synchronous=NORMAL;\`
- Use transactions for bulk inserts: BEGIN / INSERT batch / COMMIT
- Create indexes on WHERE, JOIN, ORDER BY, GROUP BY columns
- Validate after loading: row counts, null checks, integrity_check
- Export: \`sqlite3 -header -csv db.sqlite "SELECT * FROM t;" > export.csv\``);
    }

    // Validation
    if (mission.includes('valid') || mission.includes('quality') || mission.includes('check') || mission.includes('verify')) {
      sections.push(`### Data Validation
- Row count validation: imported rows match source count
- Null checks: required columns have no nulls
- Uniqueness: primary key columns have no duplicates
- Referential integrity: foreign keys reference valid primary keys
- Value ranges: numeric values within expected bounds
- Use validate_database tool for automated checks
- Write results to validation-report.json`);
    }

    return sections.length > 0 ? sections.join('\n\n') : null;
  }

  getToolSchema() {
    const tools = [...this.getBaseToolSchema()];

    // ── Data pipeline-specific tools ─────────────────────────────────────────
    tools.push(
      {
        type: 'function',
        function: {
          name: 'profile_data',
          description: 'Analyze a data file and report statistics: row count, column types, null rates, min/max/mean for numeric columns, unique value counts, and sample values. Supports CSV, JSON, and SQLite database files.',
          parameters: {
            type: 'object',
            properties: {
              file_path: {
                type: 'string',
                description: 'Path to the data file to profile (CSV, JSON, or SQLite .db/.sqlite)'
              },
              format: {
                type: 'string',
                enum: ['csv', 'json', 'sqlite', 'auto'],
                description: 'Data format (default: auto-detect from extension)'
              },
              sample_size: {
                type: 'number',
                description: 'Number of records to sample for profiling (default: all for files < 10MB, 10000 for larger)'
              }
            },
            required: ['file_path'],
            additionalProperties: false
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'infer_schema',
          description: 'Examine data and propose a database schema. Analyzes column names, types, constraints (NOT NULL, UNIQUE, PRIMARY KEY), and relationships. Returns CREATE TABLE DDL and a structured schema description.',
          parameters: {
            type: 'object',
            properties: {
              data: {
                type: 'string',
                description: 'Sample data to analyze (JSON string or CSV text). Provide at least 10 records for accurate inference.'
              },
              format: {
                type: 'string',
                enum: ['json', 'csv', 'auto'],
                description: 'Data format (default: auto-detect)'
              },
              table_name: {
                type: 'string',
                description: 'Name for the proposed table (default: inferred from data or "data")'
              },
              hints: {
                type: 'string',
                description: 'Optional hints about the data (e.g., "id is primary key", "date_col is ISO date")'
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
          name: 'save_pipeline_manifest',
          description: 'Write the current pipeline manifest to disk. Call this periodically and at the end of pipeline execution to persist progress. Includes input sources, database info, table schemas, transforms, validation, exports, and profile data.',
          parameters: {
            type: 'object',
            properties: {
              summary: {
                type: 'string',
                description: 'Optional summary text describing the pipeline run'
              }
            },
            additionalProperties: false
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'validate_database',
          description: 'Run quality checks on a loaded database. Checks row counts, null rates, constraint integrity, value ranges, and uniqueness. Returns a structured validation report.',
          parameters: {
            type: 'object',
            properties: {
              db_path: {
                type: 'string',
                description: 'Path to the SQLite database file to validate'
              },
              expected_row_counts: {
                type: 'object',
                description: 'Expected row counts per table (e.g., {"products": 1000, "categories": 50})',
                additionalProperties: { type: 'number' }
              },
              checks: {
                type: 'array',
                items: { type: 'string' },
                description: 'Specific checks to run: "row_counts", "nulls", "uniqueness", "ranges", "referential_integrity", "all" (default: ["all"])'
              }
            },
            required: ['db_path'],
            additionalProperties: false
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'register_input_source',
          description: 'Register an input data source in the pipeline manifest. Call this for each data source consumed by the pipeline.',
          parameters: {
            type: 'object',
            properties: {
              path: {
                type: 'string',
                description: 'Path to the input file or directory'
              },
              format: {
                type: 'string',
                description: 'Data format (csv, json, html, sqlite, etc.)'
              },
              record_count: {
                type: 'number',
                description: 'Number of records in the source (if known)'
              },
              size_bytes: {
                type: 'number',
                description: 'File size in bytes (if known)'
              },
              description: {
                type: 'string',
                description: 'Description of the data source'
              }
            },
            required: ['path'],
            additionalProperties: false
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'register_transform',
          description: 'Record a transformation applied to the data. Call this after each significant transform step for audit trail.',
          parameters: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                description: 'Transform name (e.g., "clean_nulls", "normalize_dates", "join_tables")'
              },
              description: {
                type: 'string',
                description: 'Description of what the transform does'
              },
              input: {
                type: 'string',
                description: 'Input file/table name'
              },
              output: {
                type: 'string',
                description: 'Output file/table name'
              },
              rows_in: {
                type: 'number',
                description: 'Number of input rows'
              },
              rows_out: {
                type: 'number',
                description: 'Number of output rows'
              },
              script_path: {
                type: 'string',
                description: 'Path to the transform script (if saved)'
              }
            },
            required: ['name', 'description'],
            additionalProperties: false
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'register_table',
          description: 'Record a table created in the database. Call this after creating and loading each table.',
          parameters: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                description: 'Table name'
              },
              row_count: {
                type: 'number',
                description: 'Number of rows loaded'
              },
              columns: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    type: { type: 'string' },
                    nullable: { type: 'boolean' },
                    primary_key: { type: 'boolean' }
                  },
                  required: ['name', 'type']
                },
                description: 'Column definitions'
              },
              indexes: {
                type: 'array',
                items: { type: 'string' },
                description: 'Index names created on this table'
              }
            },
            required: ['name', 'row_count'],
            additionalProperties: false
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'register_export',
          description: 'Record an export file generated by the pipeline.',
          parameters: {
            type: 'object',
            properties: {
              path: {
                type: 'string',
                description: 'Path to the export file'
              },
              format: {
                type: 'string',
                description: 'Export format (csv, json, sql, parquet, etc.)'
              },
              description: {
                type: 'string',
                description: 'Description of the export contents'
              },
              row_count: {
                type: 'number',
                description: 'Number of rows in the export'
              },
              size_bytes: {
                type: 'number',
                description: 'File size in bytes'
              }
            },
            required: ['path', 'format'],
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
    const transformsDir = path.join(this._outputDir, 'transforms');
    const exportsDir = path.join(this._outputDir, 'exports');

    await fs.mkdir(transformsDir, { recursive: true });
    await fs.mkdir(exportsDir, { recursive: true });

    // Initialize manifest timestamp
    this.pipelineManifest.startedAt = new Date().toISOString();

    this.logger.info('DataPipelineAgent started', {
      agentId: this.agentId,
      outputDir: this._outputDir,
      mission: (this.mission.description || '').substring(0, 120)
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Execute — main intelligence
  // ═══════════════════════════════════════════════════════════════════════════

  async execute() {
    this.logger.info('DataPipelineAgent executing mission', {
      agentId: this.agentId,
      mission: this.mission.description
    });

    await this.reportProgress(5, 'Initializing data pipeline agent');

    // ── Build system prompt (Layer 1 + Layer 2) ────────────────────────────
    const systemPrompt = this._buildSystemPrompt();

    // ── Execute agentic loop (Layer 3 context auto-gathered by runAgenticLoop) ──
    // Pass null for initialContext so runAgenticLoop auto-gathers pre-flight context
    // via gatherPreFlightContext() + buildContextMessage() + _getDomainReferenceForMission()
    const result = await this.runAgenticLoop(systemPrompt, null);

    // ── Finalize manifest ───────────────────────────────────────────────────
    this.pipelineManifest.completedAt = new Date().toISOString();
    await this._writeManifest();
    await this._writePipelineLog();

    return result;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // System Prompt Construction
  // ═══════════════════════════════════════════════════════════════════════════

  _buildSystemPrompt() {
    // Three-layer architecture: COSMO identity + agent behavioral prompt
    // Domain knowledge is NOT here — it goes in the user message via _getDomainReferenceForMission()
    const behavioralPrompt = this.getDomainKnowledge() + `

## Output Directory: ${this._outputDir}
- database.sqlite    — primary SQLite database
- schema.sql         — DDL for reproduction
- transforms/        — transformation scripts
- validation-report.json — quality checks
- exports/           — CSV, JSON, other formats
- manifest.json      — pipeline summary`;

    return this.buildCOSMOSystemPrompt(behavioralPrompt);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Tool Dispatch — extends parent with pipeline-specific tools
  // ═══════════════════════════════════════════════════════════════════════════

  async dispatchToolCall(name, args) {
    switch (name) {
      case 'profile_data':
        return this._profileData(args);

      case 'infer_schema':
        return this._inferSchema(args);

      case 'save_pipeline_manifest':
        return this._savePipelineManifest(args);

      case 'validate_database':
        return this._validateDatabase(args);

      case 'register_input_source':
        return this._registerInputSource(args);

      case 'register_transform':
        return this._registerTransform(args);

      case 'register_table':
        return this._registerTable(args);

      case 'register_export':
        return this._registerExport(args);

      // Delegate to parent for base execution primitives
      default:
        return super.dispatchToolCall(name, args);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Tool Implementations
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Profile a data file — report statistics, types, null rates, distributions.
   */
  async _profileData(args) {
    const { file_path, format, sample_size } = args;

    if (!file_path) {
      return { error: 'file_path is required' };
    }

    const detectedFormat = format || this._detectFormatFromPath(file_path);

    try {
      let profile;

      if (detectedFormat === 'csv') {
        profile = await this._profileCSV(file_path, sample_size);
      } else if (detectedFormat === 'json') {
        profile = await this._profileJSON(file_path, sample_size);
      } else if (detectedFormat === 'sqlite') {
        profile = await this._profileSQLite(file_path);
      } else {
        return {
          error: `Unsupported format for profiling: ${detectedFormat}`,
          hint: 'Supported: csv, json, sqlite. Use execute_bash with csvstat or pandas for other formats.'
        };
      }

      // Store in manifest
      this.pipelineManifest.dataProfile = {
        ...profile,
        profiledAt: new Date().toISOString(),
        filePath: file_path
      };

      this._logPipelineEntry('profile_data', {
        file: file_path,
        format: detectedFormat,
        rowCount: profile.rowCount
      });

      return {
        success: true,
        profile,
        summary: `Profiled ${detectedFormat} file: ${profile.rowCount} rows, ${profile.columnCount} columns`
      };

    } catch (err) {
      return { error: `Data profiling failed: ${err.message}`, file_path, format: detectedFormat };
    }
  }

  /**
   * Profile a CSV file using csvstat or Python.
   */
  async _profileCSV(filePath, sampleSize) {
    // Try csvstat first (fast, no Python dependency)
    const csvstatResult = await this.executeBash(
      `csvstat "${filePath}" 2>/dev/null`,
      { timeout: 30000 }
    );

    if (csvstatResult.exitCode === 0 && csvstatResult.stdout.length > 50) {
      // Parse csvstat output
      const rowCountMatch = csvstatResult.stdout.match(/Row count:\s*(\d+)/);
      const rowCount = rowCountMatch ? parseInt(rowCountMatch[1]) : 0;

      // Count columns from csvstat sections
      const columnSections = csvstatResult.stdout.match(/\d+\.\s+"[^"]+"/g) || [];

      return {
        rowCount,
        columnCount: columnSections.length,
        format: 'csv',
        tool: 'csvstat',
        rawProfile: csvstatResult.stdout.substring(0, 5000)
      };
    }

    // Fallback to Python pandas
    const script = `
import json, sys
try:
    import pandas as pd
except ImportError:
    print(json.dumps({"error": "pandas not available, install with: pip install pandas"}))
    sys.exit(0)

df = pd.read_csv("${filePath.replace(/"/g, '\\"')}"${sampleSize ? `, nrows=${sampleSize}` : ''})
profile = {
    "rowCount": len(df),
    "columnCount": len(df.columns),
    "columns": {},
    "format": "csv",
    "tool": "pandas"
}
for col in df.columns:
    col_info = {
        "dtype": str(df[col].dtype),
        "nullCount": int(df[col].isnull().sum()),
        "nullRate": round(float(df[col].isnull().mean()), 4),
        "uniqueCount": int(df[col].nunique())
    }
    if df[col].dtype in ['int64', 'float64']:
        col_info["min"] = float(df[col].min()) if not pd.isna(df[col].min()) else None
        col_info["max"] = float(df[col].max()) if not pd.isna(df[col].max()) else None
        col_info["mean"] = round(float(df[col].mean()), 4) if not pd.isna(df[col].mean()) else None
    else:
        sample_vals = df[col].dropna().head(5).tolist()
        col_info["sampleValues"] = [str(v) for v in sample_vals]
    profile["columns"][col] = col_info
print(json.dumps(profile))
`;

    const pyResult = await this.executePython(script, { timeout: 60000 });

    if (pyResult.exitCode === 0 && pyResult.stdout.trim()) {
      try {
        return JSON.parse(pyResult.stdout.trim());
      } catch {
        return {
          rowCount: 0,
          columnCount: 0,
          format: 'csv',
          tool: 'python-failed-parse',
          rawOutput: pyResult.stdout.substring(0, 2000)
        };
      }
    }

    // Last resort: wc -l for row count, head for columns
    const wcResult = await this.executeBash(`wc -l < "${filePath}"`, { timeout: 5000 });
    const headResult = await this.executeBash(`head -1 "${filePath}"`, { timeout: 5000 });

    const rowCount = parseInt(wcResult.stdout.trim()) - 1; // subtract header
    const columns = headResult.stdout.trim().split(',').map(c => c.trim().replace(/^["']|["']$/g, ''));

    return {
      rowCount: Math.max(0, rowCount),
      columnCount: columns.length,
      columns: Object.fromEntries(columns.map(c => [c, { dtype: 'unknown' }])),
      format: 'csv',
      tool: 'wc+head'
    };
  }

  /**
   * Profile a JSON file.
   */
  async _profileJSON(filePath, sampleSize) {
    const jqCheckResult = await this.executeBash(
      `jq -r 'if type == "array" then length else 1 end' "${filePath}" 2>/dev/null`,
      { timeout: 15000 }
    );

    let rowCount = 0;
    if (jqCheckResult.exitCode === 0) {
      rowCount = parseInt(jqCheckResult.stdout.trim()) || 0;
    }

    // Get keys from first record
    const keysResult = await this.executeBash(
      `jq -r 'if type == "array" then .[0] else . end | keys[]' "${filePath}" 2>/dev/null`,
      { timeout: 15000 }
    );

    const columns = keysResult.exitCode === 0
      ? keysResult.stdout.trim().split('\n').filter(k => k)
      : [];

    // Get types from first record
    const typesResult = await this.executeBash(
      `jq 'if type == "array" then .[0] else . end | to_entries | map({key: .key, type: (.value | type)}) | from_entries' "${filePath}" 2>/dev/null`,
      { timeout: 15000 }
    );

    let columnTypes = {};
    if (typesResult.exitCode === 0) {
      try {
        columnTypes = JSON.parse(typesResult.stdout.trim());
      } catch { /* ignore */ }
    }

    return {
      rowCount,
      columnCount: columns.length,
      columns: Object.fromEntries(columns.map(c => [c, { dtype: columnTypes[c] || 'unknown' }])),
      format: 'json',
      tool: 'jq'
    };
  }

  /**
   * Profile a SQLite database.
   */
  async _profileSQLite(filePath) {
    // Get table list
    const tablesResult = await this.executeBash(
      `sqlite3 "${filePath}" ".tables"`,
      { timeout: 10000 }
    );

    if (tablesResult.exitCode !== 0) {
      throw new Error(`Cannot open SQLite database: ${tablesResult.stderr}`);
    }

    const tables = tablesResult.stdout.trim().split(/\s+/).filter(t => t);
    const tableProfiles = {};
    let totalRows = 0;

    for (const table of tables) {
      const countResult = await this.executeBash(
        `sqlite3 "${filePath}" "SELECT COUNT(*) FROM \\"${table}\\";"`,
        { timeout: 10000 }
      );
      const rowCount = parseInt((countResult.stdout || '').trim()) || 0;
      totalRows += rowCount;

      const schemaResult = await this.executeBash(
        `sqlite3 "${filePath}" "PRAGMA table_info(\\"${table}\\");"`,
        { timeout: 10000 }
      );

      const columns = [];
      if (schemaResult.exitCode === 0) {
        for (const line of schemaResult.stdout.trim().split('\n')) {
          if (!line) continue;
          const parts = line.split('|');
          if (parts.length >= 3) {
            columns.push({
              name: parts[1],
              type: parts[2],
              nullable: parts[3] !== '1',
              primaryKey: parts[5] === '1'
            });
          }
        }
      }

      tableProfiles[table] = { rowCount, columns };
    }

    return {
      rowCount: totalRows,
      columnCount: Object.values(tableProfiles).reduce((sum, t) => sum + t.columns.length, 0),
      tableCount: tables.length,
      tables: tableProfiles,
      format: 'sqlite',
      tool: 'sqlite3'
    };
  }

  /**
   * Infer a database schema from sample data.
   */
  async _inferSchema(args) {
    const { data, format, table_name, hints } = args;

    if (!data || typeof data !== 'string' || data.trim().length === 0) {
      return { error: 'No data provided for schema inference' };
    }

    const detectedFormat = format || this._detectFormatFromContent(data);
    const tableName = table_name || 'data';

    try {
      let columns = [];
      let sampleSize = 0;

      if (detectedFormat === 'json') {
        const parsed = JSON.parse(data);
        const records = Array.isArray(parsed) ? parsed : (parsed.data || parsed.results || parsed.items || [parsed]);
        sampleSize = records.length;

        // Collect all fields and their types across all records
        const fieldInfo = {};
        for (const record of records) {
          if (typeof record === 'object' && record !== null) {
            for (const [key, value] of Object.entries(record)) {
              if (!fieldInfo[key]) {
                fieldInfo[key] = { types: new Set(), nullCount: 0, uniqueValues: new Set(), totalCount: 0 };
              }
              fieldInfo[key].totalCount++;
              if (value === null || value === undefined) {
                fieldInfo[key].nullCount++;
              } else {
                fieldInfo[key].types.add(this._inferSQLType(value));
                if (typeof value !== 'object') {
                  fieldInfo[key].uniqueValues.add(String(value));
                }
              }
            }
          }
        }

        for (const [field, info] of Object.entries(fieldInfo)) {
          const types = [...info.types];
          const sqlType = types.length === 0 ? 'TEXT'
            : types.length === 1 ? types[0]
            : types.includes('REAL') ? 'REAL'
            : types.includes('INTEGER') ? 'INTEGER'
            : 'TEXT';

          const nullable = info.nullCount > 0 || info.totalCount < sampleSize;
          const isUnique = info.uniqueValues.size === info.totalCount && info.nullCount === 0;

          columns.push({
            name: field,
            type: sqlType,
            nullable,
            unique: isUnique,
            primaryKey: false
          });
        }
      } else if (detectedFormat === 'csv') {
        const lines = data.trim().split('\n');
        if (lines.length === 0) {
          return { error: 'Empty CSV data' };
        }

        const delimiter = this._detectDelimiter(lines[0]);
        const headers = lines[0].split(delimiter).map(h => h.trim().replace(/^["']|["']$/g, ''));
        const dataLines = lines.slice(1);
        sampleSize = dataLines.length;

        const fieldInfo = {};
        for (const header of headers) {
          fieldInfo[header] = { types: new Set(), nullCount: 0, uniqueValues: new Set(), totalCount: 0 };
        }

        for (const line of dataLines) {
          const values = line.split(delimiter).map(v => v.trim().replace(/^["']|["']$/g, ''));
          for (let i = 0; i < headers.length && i < values.length; i++) {
            const header = headers[i];
            fieldInfo[header].totalCount++;
            if (!values[i] || values[i] === '') {
              fieldInfo[header].nullCount++;
            } else {
              fieldInfo[header].types.add(this._inferSQLTypeFromString(values[i]));
              fieldInfo[header].uniqueValues.add(values[i]);
            }
          }
        }

        for (const [field, info] of Object.entries(fieldInfo)) {
          const types = [...info.types];
          const sqlType = types.length === 0 ? 'TEXT'
            : types.length === 1 ? types[0]
            : types.includes('REAL') ? 'REAL'
            : types.includes('INTEGER') ? 'INTEGER'
            : 'TEXT';

          const nullable = info.nullCount > 0;
          const isUnique = info.uniqueValues.size === info.totalCount && info.nullCount === 0;

          columns.push({
            name: field,
            type: sqlType,
            nullable,
            unique: isUnique,
            primaryKey: false
          });
        }
      } else {
        return { error: `Unsupported format for schema inference: ${detectedFormat}` };
      }

      // Apply hints for primary key detection
      if (hints) {
        const hintsLower = hints.toLowerCase();
        for (const col of columns) {
          if (hintsLower.includes(`${col.name.toLowerCase()} is primary key`) ||
              hintsLower.includes(`${col.name.toLowerCase()} as primary key`)) {
            col.primaryKey = true;
            col.nullable = false;
          }
        }
      }

      // Auto-detect primary key if none set
      if (!columns.some(c => c.primaryKey)) {
        const idCol = columns.find(c =>
          c.name.toLowerCase() === 'id' && c.unique && !c.nullable
        );
        if (idCol) {
          idCol.primaryKey = true;
        }
      }

      // Generate DDL
      const ddl = this._generateDDL(tableName, columns);

      const schema = {
        tableName,
        columns,
        ddl,
        sampleSize,
        format: detectedFormat
      };

      this._logPipelineEntry('infer_schema', {
        tableName,
        columnCount: columns.length,
        sampleSize
      });

      return {
        success: true,
        schema,
        ddl,
        summary: `Inferred schema for "${tableName}": ${columns.length} columns from ${sampleSize} samples`
      };

    } catch (err) {
      return { error: `Schema inference failed: ${err.message}`, format: detectedFormat };
    }
  }

  /**
   * Save the pipeline manifest to disk.
   */
  async _savePipelineManifest(args) {
    const summary = args?.summary || null;

    try {
      await this._writeManifest(summary);
      return {
        success: true,
        path: path.join(this._outputDir, 'manifest.json'),
        stats: {
          inputSources: this.pipelineManifest.inputSources.length,
          tables: this.pipelineManifest.tables.length,
          transforms: this.pipelineManifest.transforms.length,
          exports: this.pipelineManifest.exports.length,
          hasDatabase: this.pipelineManifest.database !== null,
          hasValidation: this.pipelineManifest.validationResults !== null,
          hasProfile: this.pipelineManifest.dataProfile !== null
        }
      };
    } catch (err) {
      return { error: `Failed to save pipeline manifest: ${err.message}` };
    }
  }

  /**
   * Validate a SQLite database — run quality checks.
   */
  async _validateDatabase(args) {
    const { db_path, expected_row_counts, checks } = args;

    if (!db_path) {
      return { error: 'db_path is required' };
    }

    const checksToRun = checks || ['all'];
    const runAll = checksToRun.includes('all');
    const report = {
      database: db_path,
      validatedAt: new Date().toISOString(),
      passed: true,
      checks: [],
      summary: {}
    };

    try {
      // ── Get table list ─────────────────────────────────────────────────
      const tablesResult = await this.executeBash(
        `sqlite3 "${db_path}" ".tables"`,
        { timeout: 10000 }
      );

      if (tablesResult.exitCode !== 0) {
        return { error: `Cannot open database: ${tablesResult.stderr}` };
      }

      const tables = tablesResult.stdout.trim().split(/\s+/).filter(t => t);
      report.summary.tableCount = tables.length;

      // ── Row count checks ───────────────────────────────────────────────
      if (runAll || checksToRun.includes('row_counts')) {
        for (const table of tables) {
          const countResult = await this.executeBash(
            `sqlite3 "${db_path}" "SELECT COUNT(*) FROM \\"${table}\\";"`,
            { timeout: 10000 }
          );

          const actualCount = parseInt((countResult.stdout || '').trim()) || 0;
          const expectedCount = expected_row_counts?.[table];

          const check = {
            type: 'row_count',
            table,
            actual: actualCount,
            expected: expectedCount || null,
            passed: expectedCount !== undefined ? actualCount === expectedCount : actualCount > 0
          };

          if (!check.passed) report.passed = false;
          report.checks.push(check);
        }
      }

      // ── Null checks ────────────────────────────────────────────────────
      if (runAll || checksToRun.includes('nulls')) {
        for (const table of tables) {
          const schemaResult = await this.executeBash(
            `sqlite3 "${db_path}" "PRAGMA table_info(\\"${table}\\");"`,
            { timeout: 10000 }
          );

          if (schemaResult.exitCode === 0) {
            for (const line of schemaResult.stdout.trim().split('\n')) {
              if (!line) continue;
              const parts = line.split('|');
              if (parts.length >= 4) {
                const colName = parts[1];
                const notNull = parts[3] === '1';

                if (notNull) {
                  const nullCountResult = await this.executeBash(
                    `sqlite3 "${db_path}" "SELECT COUNT(*) FROM \\"${table}\\" WHERE \\"${colName}\\" IS NULL;"`,
                    { timeout: 10000 }
                  );

                  const nullCount = parseInt((nullCountResult.stdout || '').trim()) || 0;
                  const check = {
                    type: 'null_check',
                    table,
                    column: colName,
                    nullCount,
                    passed: nullCount === 0
                  };

                  if (!check.passed) report.passed = false;
                  report.checks.push(check);
                }
              }
            }
          }
        }
      }

      // ── Uniqueness checks ──────────────────────────────────────────────
      if (runAll || checksToRun.includes('uniqueness')) {
        for (const table of tables) {
          // Check for duplicate primary keys
          const pkResult = await this.executeBash(
            `sqlite3 "${db_path}" "PRAGMA table_info(\\"${table}\\");"`,
            { timeout: 10000 }
          );

          if (pkResult.exitCode === 0) {
            const pkColumns = [];
            for (const line of pkResult.stdout.trim().split('\n')) {
              if (!line) continue;
              const parts = line.split('|');
              if (parts.length >= 6 && parts[5] !== '0') {
                pkColumns.push(parts[1]);
              }
            }

            if (pkColumns.length > 0) {
              const pkExpr = pkColumns.map(c => `"${c}"`).join(', ');
              const dupResult = await this.executeBash(
                `sqlite3 "${db_path}" "SELECT COUNT(*) - COUNT(DISTINCT ${pkExpr}) FROM \\"${table}\\";"`,
                { timeout: 10000 }
              );

              const dupCount = parseInt((dupResult.stdout || '').trim()) || 0;
              const check = {
                type: 'uniqueness',
                table,
                columns: pkColumns,
                duplicateCount: dupCount,
                passed: dupCount === 0
              };

              if (!check.passed) report.passed = false;
              report.checks.push(check);
            }
          }
        }
      }

      // ── Integrity check ────────────────────────────────────────────────
      if (runAll || checksToRun.includes('referential_integrity')) {
        const integrityResult = await this.executeBash(
          `sqlite3 "${db_path}" "PRAGMA integrity_check;"`,
          { timeout: 30000 }
        );

        const check = {
          type: 'integrity',
          result: (integrityResult.stdout || '').trim(),
          passed: (integrityResult.stdout || '').trim() === 'ok'
        };

        if (!check.passed) report.passed = false;
        report.checks.push(check);
      }

      // Store validation results in manifest
      this.pipelineManifest.validationResults = report;

      // Write validation report to disk
      const reportPath = path.join(this._outputDir, 'validation-report.json');
      try {
        await this.writeFile(reportPath, JSON.stringify(report, null, 2));
      } catch (writeErr) {
        this.logger.warn('Failed to write validation report', { error: writeErr.message });
      }

      this._logPipelineEntry('validate_database', {
        db: db_path,
        tables: tables.length,
        checks: report.checks.length,
        passed: report.passed
      });

      return {
        success: true,
        report,
        summary: `Validation ${report.passed ? 'PASSED' : 'FAILED'}: ${report.checks.length} checks on ${tables.length} tables`
      };

    } catch (err) {
      return { error: `Database validation failed: ${err.message}` };
    }
  }

  /**
   * Register an input data source in the pipeline manifest.
   */
  _registerInputSource(args) {
    const entry = {
      path: args.path,
      format: args.format || 'unknown',
      recordCount: args.record_count || null,
      sizeBytes: args.size_bytes || null,
      description: args.description || null,
      registeredAt: new Date().toISOString()
    };

    this.pipelineManifest.inputSources.push(entry);

    this._logPipelineEntry('register_input_source', {
      path: args.path,
      format: entry.format,
      records: entry.recordCount
    });

    return {
      success: true,
      totalInputSources: this.pipelineManifest.inputSources.length,
      source: entry
    };
  }

  /**
   * Record a transformation in the manifest.
   */
  _registerTransform(args) {
    const entry = {
      name: args.name,
      description: args.description,
      input: args.input || null,
      output: args.output || null,
      rowsIn: args.rows_in || null,
      rowsOut: args.rows_out || null,
      scriptPath: args.script_path || null,
      appliedAt: new Date().toISOString()
    };

    this.pipelineManifest.transforms.push(entry);

    this._logPipelineEntry('register_transform', {
      name: args.name,
      rowsIn: entry.rowsIn,
      rowsOut: entry.rowsOut
    });

    return {
      success: true,
      totalTransforms: this.pipelineManifest.transforms.length,
      transform: entry
    };
  }

  /**
   * Record a table in the manifest.
   */
  _registerTable(args) {
    const entry = {
      name: args.name,
      rowCount: args.row_count,
      columns: args.columns || [],
      indexes: args.indexes || [],
      createdAt: new Date().toISOString()
    };

    // Replace if table already registered (update row count, etc.)
    const existingIdx = this.pipelineManifest.tables.findIndex(t => t.name === args.name);
    if (existingIdx >= 0) {
      this.pipelineManifest.tables[existingIdx] = entry;
    } else {
      this.pipelineManifest.tables.push(entry);
    }

    this._logPipelineEntry('register_table', {
      name: args.name,
      rowCount: entry.rowCount,
      columns: entry.columns.length
    });

    return {
      success: true,
      totalTables: this.pipelineManifest.tables.length,
      table: entry
    };
  }

  /**
   * Record an export file in the manifest.
   */
  _registerExport(args) {
    const entry = {
      path: args.path,
      format: args.format,
      description: args.description || null,
      rowCount: args.row_count || null,
      sizeBytes: args.size_bytes || null,
      exportedAt: new Date().toISOString()
    };

    this.pipelineManifest.exports.push(entry);

    this._logPipelineEntry('register_export', {
      path: args.path,
      format: entry.format,
      rows: entry.rowCount
    });

    return {
      success: true,
      totalExports: this.pipelineManifest.exports.length,
      export: entry
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Progress Tracking — extend with pipeline-specific ops
  // ═══════════════════════════════════════════════════════════════════════════

  _isProgressOperation(toolName) {
    const pipelineProgressOps = new Set([
      'profile_data',
      'infer_schema',
      'save_pipeline_manifest',
      'validate_database',
      'register_input_source',
      'register_transform',
      'register_table',
      'register_export'
    ]);

    return pipelineProgressOps.has(toolName) || super._isProgressOperation(toolName);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Accomplishment Assessment
  // ═══════════════════════════════════════════════════════════════════════════

  assessAccomplishment(executeResult, results) {
    const manifest = this.pipelineManifest;

    // Pipeline succeeds if database created OR exports generated
    const hasDatabase = manifest.database !== null;
    const hasTables = manifest.tables.length > 0;
    const hasExports = manifest.exports.length > 0;
    const hasTransforms = manifest.transforms.length > 0;
    const validationPassed = manifest.validationResults?.passed !== false;
    const totalRows = manifest.tables.reduce((sum, t) => sum + (t.rowCount || 0), 0);

    // Also check base metrics (files written, commands run)
    const baseAssessment = super.assessAccomplishment(executeResult, results);

    const hasPipelineOutput = (hasDatabase && hasTables) || hasExports || (hasTransforms && totalRows > 0);
    const accomplished = hasPipelineOutput || baseAssessment.accomplished;

    return {
      accomplished,
      reason: accomplished ? null : 'No pipeline output produced (no database, no exports, no transforms)',
      metrics: {
        databaseCreated: hasDatabase,
        tableCount: manifest.tables.length,
        totalRows,
        exportCount: manifest.exports.length,
        transformCount: manifest.transforms.length,
        validationPassed,
        inputSourceCount: manifest.inputSources.length,
        hasProfile: manifest.dataProfile !== null,
        ...baseAssessment.metrics
      }
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Handoff
  // ═══════════════════════════════════════════════════════════════════════════

  generateHandoffSpec() {
    const manifest = this.pipelineManifest;

    // No handoff if nothing was produced
    const hasDatabase = manifest.database !== null;
    const hasTables = manifest.tables.length > 0;
    const hasExports = manifest.exports.length > 0;

    if (!hasDatabase && !hasTables && !hasExports) {
      return null;
    }

    // Build artifact references
    const artifactRefs = [];
    if (manifest.database) {
      artifactRefs.push(manifest.database);
    }
    for (const exp of manifest.exports) {
      if (exp.path) {
        artifactRefs.push(exp.path);
      }
    }
    if (artifactRefs.length === 0) {
      artifactRefs.push(this._outputDir);
    }

    // Build top findings summary
    const topFindings = [];
    const totalRows = manifest.tables.reduce((sum, t) => sum + (t.rowCount || 0), 0);

    if (hasTables) {
      topFindings.push(`Created ${manifest.tables.length} table(s) with ${totalRows} total rows`);
    }
    if (hasDatabase) {
      topFindings.push(`Database: ${manifest.database}`);
    }
    if (manifest.transforms.length > 0) {
      topFindings.push(`Applied ${manifest.transforms.length} transformation(s)`);
    }
    if (hasExports) {
      topFindings.push(`Generated ${manifest.exports.length} export file(s)`);
    }
    if (manifest.validationResults) {
      topFindings.push(`Validation: ${manifest.validationResults.passed ? 'PASSED' : 'FAILED'} (${manifest.validationResults.checks?.length || 0} checks)`);
    }
    if (manifest.dataProfile) {
      topFindings.push(`Data profile available: ${manifest.dataProfile.rowCount || 0} rows, ${manifest.dataProfile.columnCount || 0} columns`);
    }

    // Build schema summary from tables
    const schema = {};
    for (const table of manifest.tables) {
      schema[table.name] = {
        rowCount: table.rowCount,
        columns: (table.columns || []).map(c => ({
          name: c.name,
          type: c.type
        }))
      };
    }

    // Build data profile summary
    const dataProfile = manifest.dataProfile ? {
      rowCount: manifest.dataProfile.rowCount,
      columnCount: manifest.dataProfile.columnCount,
      format: manifest.dataProfile.format,
      tool: manifest.dataProfile.tool
    } : null;

    return {
      targetAgentType: 'analysis',
      reason: 'Data pipeline complete — structured database and exports ready for analysis',
      artifactRefs,
      context: {
        sourceAgent: this.agentId,
        sourceType: 'datapipeline',
        outputDir: this._outputDir,
        schema,
        dataProfile,
        rowCount: totalRows,
        tableCount: manifest.tables.length,
        topFindings,
        manifest: {
          inputSources: manifest.inputSources.length,
          tables: manifest.tables.length,
          transforms: manifest.transforms.length,
          exports: manifest.exports.length,
          validationPassed: manifest.validationResults?.passed
        }
      }
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Internal Helpers
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Detect data format from file extension.
   */
  _detectFormatFromPath(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    switch (ext) {
      case '.csv': case '.tsv': return 'csv';
      case '.json': case '.jsonl': case '.ndjson': return 'json';
      case '.sqlite': case '.db': case '.sqlite3': return 'sqlite';
      case '.parquet': return 'parquet';
      case '.xml': return 'xml';
      default: return 'auto';
    }
  }

  /**
   * Detect data format from content.
   */
  _detectFormatFromContent(data) {
    const trimmed = data.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) return 'json';
    if (trimmed.startsWith('<')) return 'xml';
    const firstLine = trimmed.split('\n')[0];
    if (firstLine.includes(',') || firstLine.includes('\t')) return 'csv';
    return 'json';
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
   * Infer SQL type from a JavaScript value.
   */
  _inferSQLType(value) {
    if (value === null || value === undefined) return 'TEXT';
    if (typeof value === 'boolean') return 'INTEGER'; // SQLite stores booleans as 0/1
    if (typeof value === 'number') {
      return Number.isInteger(value) ? 'INTEGER' : 'REAL';
    }
    if (typeof value === 'string') {
      if (/^\d{4}-\d{2}-\d{2}/.test(value)) return 'TEXT'; // dates stored as TEXT in SQLite
      if (/^-?\d+$/.test(value)) return 'INTEGER';
      if (/^-?\d+\.\d+$/.test(value)) return 'REAL';
      return 'TEXT';
    }
    if (Array.isArray(value) || typeof value === 'object') return 'TEXT'; // serialize as JSON text
    return 'TEXT';
  }

  /**
   * Infer SQL type from a string value (CSV cell).
   */
  _inferSQLTypeFromString(value) {
    if (!value || value.trim() === '') return 'TEXT';
    if (/^-?\d+$/.test(value)) return 'INTEGER';
    if (/^-?\d+\.\d+$/.test(value)) return 'REAL';
    if (/^(true|false)$/i.test(value)) return 'INTEGER';
    return 'TEXT';
  }

  /**
   * Generate CREATE TABLE DDL from column definitions.
   */
  _generateDDL(tableName, columns) {
    const colDefs = columns.map(col => {
      let def = `  "${col.name}" ${col.type}`;
      if (col.primaryKey) def += ' PRIMARY KEY';
      if (!col.nullable && !col.primaryKey) def += ' NOT NULL';
      if (col.unique && !col.primaryKey) def += ' UNIQUE';
      return def;
    });

    return `CREATE TABLE IF NOT EXISTS "${tableName}" (\n${colDefs.join(',\n')}\n);`;
  }

  /**
   * Log a pipeline entry (appended to pipeline-log.jsonl on disk at finalization).
   */
  _logPipelineEntry(operation, details) {
    this._pipelineLog.push({
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
      agentType: 'datapipeline',
      mission: this.mission.description,
      goalId: this.mission.goalId,
      ...this.pipelineManifest,
      summary: summary || null
    };

    const manifestPath = path.join(this._outputDir, 'manifest.json');
    try {
      await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
      this.logger.debug('Pipeline manifest written', { path: manifestPath });
    } catch (err) {
      this.logger.warn('Failed to write pipeline manifest', { error: err.message });
    }
  }

  /**
   * Write the pipeline-log.jsonl file.
   */
  async _writePipelineLog() {
    if (!this._outputDir) return;
    if (this._pipelineLog.length === 0) return;

    const logPath = path.join(this._outputDir, 'pipeline-log.jsonl');
    try {
      const lines = this._pipelineLog.map(e => JSON.stringify(e)).join('\n') + '\n';
      await fs.writeFile(logPath, lines, 'utf8');
      this.logger.debug('Pipeline log written', {
        path: logPath,
        entries: this._pipelineLog.length
      });
    } catch (err) {
      this.logger.warn('Failed to write pipeline log', { error: err.message });
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

module.exports = { DataPipelineAgent };
