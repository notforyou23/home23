#!/usr/bin/env node

/**
 * Archive Queries Script
 * 
 * Recursively finds all queries.jsonl files, copies them to a master archive,
 * and generates human-readable markdown versions with enhanced metadata.
 * 
 * Features:
 * - Recursive search through all subdirectories
 * - Incremental/non-destructive updates (only appends new queries)
 * - Extracts run names from workspace or external paths
 * - Captures new query fields: runName, evidence, filesAccessed
 * 
 * To search a custom folder (e.g., external drive):
 * 1. Edit the searchPaths array in findQueriesFiles() function (around line 45)
 * 2. Change it to: const searchPaths = ['/your/custom/path'];
 * 3. Run the script
 * 
 * Output location: queries-archive/jsonl/ and queries-archive/markdown/
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Auto-detect workspace root (git-aware, falls back to ../scripts)
const WORKSPACE_ROOT = (() => {
  try {
    return execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
  } catch {
    return path.resolve(__dirname, '..');
  }
})();

const ARCHIVE_DIR = path.join(WORKSPACE_ROOT, 'queries-archive');
const JSONL_DIR = path.join(ARCHIVE_DIR, 'jsonl');
const MARKDOWN_DIR = path.join(ARCHIVE_DIR, 'markdown');
const INDEX_FILE = path.join(ARCHIVE_DIR, 'INDEX.md');

// Ensure directories exist
[ARCHIVE_DIR, JSONL_DIR, MARKDOWN_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

/**
 * Find all queries.jsonl files
 */
function findQueriesFiles() {
  console.log('🔍 Searching for queries.jsonl files (recursive)...\n');
  
  // To search a custom folder (like external drive), change searchPaths to:
  // const searchPaths = ['/Volumes/Bertha - Data/_ALL_COZ/cosmoRuns/_allTesting'];
  
  const searchPaths = [
    '/Volumes/Bertha - Data/_ALL_COZ/cosmoRuns/_allTesting'
  ];
  
  const files = [];
  
  searchPaths.forEach(searchPath => {
    try {
      const result = execSync(`find "${searchPath}" -name "queries.jsonl" -type f 2>/dev/null || true`, {
        encoding: 'utf-8'
      });
      
      const foundFiles = result.trim().split('\n').filter(f => f.length > 0);
      files.push(...foundFiles);
    } catch (error) {
      console.warn(`Warning: Could not search ${searchPath}:`, error.message);
    }
  });
  
  return files;
}

/**
 * Extract run name from file path
 */
function getRunName(filePath) {
  const relativePath = path.relative(WORKSPACE_ROOT, filePath);
  const parts = relativePath.split(path.sep);
  
  // Handle workspace-relative paths
  if (parts[0] === 'runtime') {
    return 'runtime';
  } else if (parts[0] === 'runs' && parts.length > 1) {
    return parts[1];
  }
  
  // Handle external/absolute paths - extract parent directory name
  // The queries.jsonl is typically at: <root>/<runname>/queries.jsonl
  const dir = path.dirname(filePath);
  const runName = path.basename(dir);
  
  return runName || 'unknown';
}

/**
 * Get run metadata if available
 */
function getRunMetadata(runDir) {
  const metadataPath = path.join(runDir, 'run-metadata.json');
  
  if (fs.existsSync(metadataPath)) {
    try {
      const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
      return {
        created: metadata.timestamp || metadata.created || null,
        config: metadata.config || null,
        description: metadata.description || null
      };
    } catch (error) {
      console.warn(`Warning: Could not parse metadata for ${runDir}`);
      return null;
    }
  }
  
  return null;
}

/**
 * Parse JSONL and convert to markdown
 */
function convertToMarkdown(queries, runName, metadata, filePath) {
  const lines = [];
  
  // Header
  lines.push(`# Queries: ${runName}`);
  lines.push('');
  lines.push(`**Source:** \`${path.relative(WORKSPACE_ROOT, filePath)}\``);
  lines.push('');
  
  // Metadata section
  if (metadata) {
    lines.push('## Run Metadata');
    lines.push('');
    if (metadata.created) {
      lines.push(`- **Created:** ${new Date(metadata.created).toLocaleString()}`);
    }
    if (metadata.description) {
      lines.push(`- **Description:** ${metadata.description}`);
    }
    if (metadata.config) {
      lines.push(`- **Config:** ${JSON.stringify(metadata.config, null, 2).split('\n').join('\n  ')}`);
    }
    lines.push('');
  }
  
  // Stats
  lines.push('## Summary');
  lines.push('');
  lines.push(`- **Total Queries:** ${queries.length}`);
  
  if (queries.length > 0) {
    const models = [...new Set(queries.map(q => q.model))];
    const modes = [...new Set(queries.map(q => q.mode))];
    
    lines.push(`- **Models Used:** ${models.join(', ')}`);
    lines.push(`- **Modes Used:** ${modes.join(', ')}`);
    
    const firstQuery = new Date(queries[0].timestamp);
    const lastQuery = new Date(queries[queries.length - 1].timestamp);
    
    lines.push(`- **First Query:** ${firstQuery.toLocaleString()}`);
    lines.push(`- **Last Query:** ${lastQuery.toLocaleString()}`);
  }
  
  lines.push('');
  lines.push('---');
  lines.push('');
  
  // Individual queries
  queries.forEach((query, index) => {
    const queryNum = index + 1;
    const timestamp = new Date(query.timestamp).toLocaleString();
    
    lines.push(`## Query ${queryNum}`);
    lines.push('');
    lines.push(`**Timestamp:** ${timestamp}`);
    lines.push(`**Model:** ${query.model || 'N/A'}`);
    lines.push(`**Mode:** ${query.mode || 'N/A'}`);
    
    // Show runName if present (newer format)
    if (query.runName) {
      lines.push(`**Run Name:** ${query.runName}`);
    }
    
    // Show evidence count if present (newer format)
    if (query.evidence !== undefined) {
      lines.push(`**Evidence:** ${query.evidence}`);
    }
    
    // Show files accessed if present (newer format)
    if (query.filesAccessed) {
      const fa = query.filesAccessed;
      lines.push(`**Files Accessed:** ${fa.total || 0} total (${fa.codeFiles || 0} code, ${fa.executionOutputs || 0} outputs, ${fa.documents || 0} docs, ${fa.deliverables || 0} deliverables)`);
    }
    
    // Show metadata if present
    if (query.metadata) {
      lines.push(`**Metadata:** \`${JSON.stringify(query.metadata)}\``);
    }
    
    lines.push('');
    lines.push('### Query');
    lines.push('');
    lines.push('```');
    lines.push(query.query || '(no query text)');
    lines.push('```');
    lines.push('');
    
    // Answer - truncate if too long
    lines.push('### Answer');
    lines.push('');
    
    const answer = query.answer || '(no answer)';
    const MAX_ANSWER_LENGTH = 10000; // characters
    
    if (answer.length > MAX_ANSWER_LENGTH) {
      lines.push('```');
      lines.push(answer.substring(0, MAX_ANSWER_LENGTH));
      lines.push('```');
      lines.push('');
      lines.push(`*[Answer truncated - ${answer.length.toLocaleString()} characters total, showing first ${MAX_ANSWER_LENGTH.toLocaleString()}]*`);
      lines.push('');
      lines.push(`**Full answer available in:** \`${runName}-queries.jsonl\``);
    } else {
      lines.push('```');
      lines.push(answer);
      lines.push('```');
    }
    
    lines.push('');
    lines.push('---');
    lines.push('');
  });
  
  return lines.join('\n');
}

/**
 * Create a unique hash for a query to detect duplicates
 */
function queryHash(query) {
  return `${query.timestamp}::${query.query}::${query.model}`;
}

/**
 * Read existing archived queries
 */
function readExistingArchive(jsonlDest) {
  if (!fs.existsSync(jsonlDest)) {
    return [];
  }
  
  try {
    const content = fs.readFileSync(jsonlDest, 'utf-8');
    const lines = content.trim().split('\n').filter(line => line.length > 0);
    return lines.map(line => {
      try {
        return JSON.parse(line);
      } catch (error) {
        return null;
      }
    }).filter(q => q !== null);
  } catch (error) {
    console.warn(`   ⚠️  Could not read existing archive: ${error.message}`);
    return [];
  }
}

/**
 * Process a single queries.jsonl file (with incremental updates)
 */
function processQueriesFile(filePath, archiveData) {
  const runName = getRunName(filePath);
  const runDir = path.dirname(filePath);
  const metadata = getRunMetadata(runDir);
  
  console.log(`📄 Processing: ${runName}`);
  console.log(`   Source: ${path.relative(WORKSPACE_ROOT, filePath)}`);
  
  // Read source queries
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.trim().split('\n').filter(line => line.length > 0);
  const sourceQueries = lines.map(line => {
    try {
      return JSON.parse(line);
    } catch (error) {
      console.warn(`   ⚠️  Warning: Could not parse line in ${filePath}`);
      return null;
    }
  }).filter(q => q !== null);
  
  console.log(`   Source queries: ${sourceQueries.length}`);
  
  if (sourceQueries.length === 0) {
    console.log(`   ⏭️  Skipping (no valid queries)\n`);
    return null;
  }
  
  // Read existing archived queries
  const jsonlDest = path.join(JSONL_DIR, `${runName}-queries.jsonl`);
  const existingQueries = readExistingArchive(jsonlDest);
  
  // Build set of existing query hashes
  const existingHashes = new Set(existingQueries.map(queryHash));
  
  // Find new queries
  const newQueries = sourceQueries.filter(q => !existingHashes.has(queryHash(q)));
  
  console.log(`   Existing archived: ${existingQueries.length}`);
  console.log(`   New queries: ${newQueries.length}`);
  
  // Append new queries to archive (if any)
  if (newQueries.length > 0) {
    const newLines = newQueries.map(q => JSON.stringify(q)).join('\n') + '\n';
    fs.appendFileSync(jsonlDest, newLines);
    console.log(`   ✅ Appended ${newQueries.length} new queries to JSONL`);
  } else if (existingQueries.length === 0) {
    // First time archiving - write all queries
    const allLines = sourceQueries.map(q => JSON.stringify(q)).join('\n') + '\n';
    fs.writeFileSync(jsonlDest, allLines);
    console.log(`   ✅ Created JSONL archive with ${sourceQueries.length} queries`);
  } else {
    console.log(`   ℹ️  No new queries to archive`);
  }
  
  // Combine all queries (existing + new) for markdown
  const allQueries = [...existingQueries, ...newQueries];
  
  // Generate markdown with ALL queries
  const markdown = convertToMarkdown(allQueries, runName, metadata, filePath);
  const markdownDest = path.join(MARKDOWN_DIR, `${runName}-queries.md`);
  fs.writeFileSync(markdownDest, markdown, 'utf-8');
  console.log(`   ✅ Updated markdown (${allQueries.length} total queries)`);
  console.log('');
  
  return {
    runName,
    filePath: path.relative(WORKSPACE_ROOT, filePath),
    queriesCount: allQueries.length,
    newQueriesCount: newQueries.length,
    jsonlArchive: path.relative(WORKSPACE_ROOT, jsonlDest),
    markdownArchive: path.relative(WORKSPACE_ROOT, markdownDest),
    metadata,
    firstQuery: allQueries[0]?.timestamp,
    lastQuery: allQueries[allQueries.length - 1]?.timestamp,
    models: [...new Set(allQueries.map(q => q.model))],
    modes: [...new Set(allQueries.map(q => q.mode))]
  };
}

/**
 * Generate master index
 */
function generateIndex(archiveData) {
  const lines = [];
  
  lines.push('# Queries Archive Index');
  lines.push('');
  lines.push(`**Generated:** ${new Date().toLocaleString()}`);
  lines.push(`**Total Runs:** ${archiveData.length}`);
  lines.push(`**Total Queries:** ${archiveData.reduce((sum, d) => sum + d.queriesCount, 0)}`);
  lines.push('');
  lines.push('---');
  lines.push('');
  
  // Sort by last query timestamp (most recent first)
  const sorted = [...archiveData].sort((a, b) => {
    const dateA = a.lastQuery ? new Date(a.lastQuery) : new Date(0);
    const dateB = b.lastQuery ? new Date(b.lastQuery) : new Date(0);
    return dateB - dateA;
  });
  
  // Table of contents
  lines.push('## Quick Navigation');
  lines.push('');
  sorted.forEach(data => {
    const lastQueryDate = data.lastQuery ? new Date(data.lastQuery).toLocaleDateString() : 'N/A';
    lines.push(`- **[${data.runName}](#${data.runName.toLowerCase().replace(/[^a-z0-9]/g, '-')})** - ${data.queriesCount} queries (last: ${lastQueryDate})`);
  });
  lines.push('');
  lines.push('---');
  lines.push('');
  
  // Detailed entries
  lines.push('## Runs');
  lines.push('');
  
  sorted.forEach(data => {
    lines.push(`### ${data.runName}`);
    lines.push('');
    lines.push(`- **Original Location:** \`${data.filePath}\``);
    lines.push(`- **Queries:** ${data.queriesCount}`);
    lines.push(`- **Models:** ${data.models.join(', ')}`);
    lines.push(`- **Modes:** ${data.modes.join(', ')}`);
    
    if (data.firstQuery) {
      lines.push(`- **First Query:** ${new Date(data.firstQuery).toLocaleString()}`);
    }
    if (data.lastQuery) {
      lines.push(`- **Last Query:** ${new Date(data.lastQuery).toLocaleString()}`);
    }
    
    if (data.metadata?.description) {
      lines.push(`- **Description:** ${data.metadata.description}`);
    }
    
    lines.push('');
    lines.push('**Archived Files:**');
    lines.push(`- JSONL: [\`${path.basename(data.jsonlArchive)}\`](${data.jsonlArchive})`);
    lines.push(`- Markdown: [\`${path.basename(data.markdownArchive)}\`](${data.markdownArchive})`);
    lines.push('');
    lines.push('---');
    lines.push('');
  });
  
  return lines.join('\n');
}

/**
 * Main execution
 */
function main() {
  console.log('╔═══════════════════════════════════════════════════════╗');
  console.log('║        COSMO Queries Archive Script                  ║');
  console.log('╚═══════════════════════════════════════════════════════╝');
  console.log('');
  
  const files = findQueriesFiles();
  
  if (files.length === 0) {
    console.log('❌ No queries.jsonl files found!');
    process.exit(1);
  }
  
  console.log(`Found ${files.length} queries.jsonl file(s)\n`);
  console.log('═══════════════════════════════════════════════════════\n');
  
  const archiveData = [];
  
  files.forEach(filePath => {
    const result = processQueriesFile(filePath, archiveData);
    if (result) {
      archiveData.push(result);
    }
  });
  
  if (archiveData.length === 0) {
    console.log('❌ No valid queries to archive!');
    process.exit(1);
  }
  
  console.log('═══════════════════════════════════════════════════════\n');
  console.log('📝 Generating master index...\n');
  
  const index = generateIndex(archiveData);
  fs.writeFileSync(INDEX_FILE, index, 'utf-8');
  
  console.log(`✅ Master index: ${path.relative(WORKSPACE_ROOT, INDEX_FILE)}`);
  console.log('');
  console.log('═══════════════════════════════════════════════════════');
  console.log('');
  console.log('✨ Archive complete!');
  console.log('');
  console.log(`📁 Archive location: ${path.relative(WORKSPACE_ROOT, ARCHIVE_DIR)}`);
  console.log(`   - JSONL files: ${path.relative(WORKSPACE_ROOT, JSONL_DIR)}`);
  console.log(`   - Markdown files: ${path.relative(WORKSPACE_ROOT, MARKDOWN_DIR)}`);
  console.log(`   - Index: ${path.relative(WORKSPACE_ROOT, INDEX_FILE)}`);
  console.log('');
  const totalQueries = archiveData.reduce((sum, d) => sum + d.queriesCount, 0);
  const newQueries = archiveData.reduce((sum, d) => sum + (d.newQueriesCount || 0), 0);
  
  console.log(`📊 Stats:`);
  console.log(`   - Runs processed: ${archiveData.length}`);
  console.log(`   - Total queries archived: ${totalQueries}`);
  console.log(`   - New queries this run: ${newQueries}`);
  console.log('');
}

// Run the script
try {
  main();
} catch (error) {
  console.error('❌ Error:', error.message);
  console.error(error.stack);
  process.exit(1);
}

