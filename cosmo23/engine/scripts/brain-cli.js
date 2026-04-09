#!/usr/bin/env node

/**
 * COSMO Brain CLI
 * 
 * Package, inspect, and manage .brain knowledge packages.
 * 
 * Usage:
 *   node scripts/brain-cli.js export <run> [--output <path>] [--with-outputs]
 *   node scripts/brain-cli.js import <brain> [--target <path>]
 *   node scripts/brain-cli.js info <brain>
 *   node scripts/brain-cli.js validate <brain>
 *   node scripts/brain-cli.js list
 *   node scripts/brain-cli.js --help
 * 
 * The .brain format is the portable, shareable unit of AI knowledge.
 * See docs/BRAIN_PLATFORM_VISION.md for the full specification.
 */

const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { promisify } = require('util');

const gunzip = promisify(zlib.gunzip);
const gzip = promisify(zlib.gzip);

// ============================================================================
// Configuration
// ============================================================================

const CONFIG = {
  version: '1.0.0',
  runsDir: path.join(__dirname, '..', 'runs'),
  brainVersion: '1.0.0',
  cosmoVersion: '2.0.0',  // TODO: Read from package.json
};

// ============================================================================
// Logger
// ============================================================================

const logger = {
  info: (msg, data) => console.log(`ℹ️  ${msg}`, data ? JSON.stringify(data, null, 2) : ''),
  success: (msg, data) => console.log(`✅ ${msg}`, data ? JSON.stringify(data, null, 2) : ''),
  warn: (msg, data) => console.log(`⚠️  ${msg}`, data ? JSON.stringify(data, null, 2) : ''),
  error: (msg, data) => console.error(`❌ ${msg}`, data ? JSON.stringify(data, null, 2) : ''),
  debug: (msg, data) => process.env.DEBUG && console.log(`🔍 ${msg}`, data || ''),
};

// ============================================================================
// Utility Functions
// ============================================================================

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath) {
  const content = await fs.readFile(filePath, 'utf8');
  return JSON.parse(content);
}

async function writeJson(filePath, data) {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2));
}

async function readGzippedJson(filePath) {
  const compressed = await fs.readFile(filePath);
  const decompressed = await gunzip(compressed);
  return JSON.parse(decompressed.toString());
}

function computeSha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

async function computeFileSha256(filePath) {
  const content = await fs.readFile(filePath);
  return computeSha256(content);
}

async function copyDir(src, dest) {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    
    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

async function getDirSize(dirPath) {
  let size = 0;
  
  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else {
        const stat = await fs.stat(fullPath);
        size += stat.size;
      }
    }
  }
  
  await walk(dirPath);
  return size;
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// ============================================================================
// Export Command
// ============================================================================

async function exportBrain(runName, options = {}) {
  // Handle full paths or just run names
  let runPath;
  if (path.isAbsolute(runName) || runName.startsWith('./') || runName.startsWith('../')) {
    runPath = path.resolve(runName);
  } else {
    runPath = path.join(CONFIG.runsDir, runName);
  }
  
  const baseName = path.basename(runPath);
  const outputPath = options.output || `${baseName}.brain`;
  const withOutputs = options.withOutputs || false;
  
  logger.info(`Exporting run "${baseName}" to "${outputPath}"...`);
  
  // Validate run exists
  if (!await fileExists(runPath)) {
    throw new Error(`Run not found: ${runPath}`);
  }
  
  // Check for required files
  const statePath = path.join(runPath, 'state.json.gz');
  if (!await fileExists(statePath)) {
    throw new Error(`Missing required file: state.json.gz`);
  }
  
  // Create output directory
  await fs.mkdir(outputPath, { recursive: true });
  await fs.mkdir(path.join(outputPath, 'metadata'), { recursive: true });
  
  // 1. Copy state.json.gz
  logger.info('Copying state.json.gz...');
  await fs.copyFile(statePath, path.join(outputPath, 'state.json.gz'));
  
  // 1b. Copy thoughts.jsonl if exists (temporal query capability)
  const thoughtsPath = path.join(runPath, 'thoughts.jsonl');
  if (await fileExists(thoughtsPath)) {
    await fs.copyFile(thoughtsPath, path.join(outputPath, 'thoughts.jsonl'));
    logger.info('Copied thoughts.jsonl');
  }
  
  // 2. Load state for stats
  const state = await readGzippedJson(statePath);
  const nodeCount = state.memory?.nodes?.length || 0;
  const edgeCount = state.memory?.edges?.length || 0;
  const goalCount = (state.goals?.active?.length || 0) + 
                    (state.goals?.completed?.length || 0) +
                    (state.goals?.archived?.length || 0);
  const cycleCount = state.cycleCount || 0;
  
  // 3. Load run metadata if exists
  let runMetadata = {};
  const runMetadataPath = path.join(runPath, 'run-metadata.json');
  if (await fileExists(runMetadataPath)) {
    runMetadata = await readJson(runMetadataPath);
  }
  
  // 4. Load merge report if exists (for lineage)
  let mergeReport = null;
  const mergeReportPath = path.join(runPath, 'merge-report.json');
  if (await fileExists(mergeReportPath)) {
    mergeReport = await readJson(mergeReportPath);
    logger.info('Found merge lineage data');
  }
  
  // 5. Compute checksums
  const stateChecksum = await computeFileSha256(statePath);
  
  // 6. Extract topics from memory nodes
  const topics = extractTopics(state);
  
  // 7. Build manifest
  const manifest = {
    version: CONFIG.brainVersion,
    brain: {
      id: `brain-${computeSha256(baseName + Date.now()).slice(0, 12)}`,
      name: baseName,
      displayName: runMetadata.domain || baseName,
      description: runMetadata.context || '',
      created: runMetadata.created || new Date().toISOString(),
      exported: new Date().toISOString(),
    },
    cosmo: {
      version: CONFIG.cosmoVersion,
      cycles: cycleCount,
      mode: runMetadata.explorationMode || 'unknown',
      executionMode: runMetadata.executionMode || 'unknown',
    },
    content: {
      nodeCount,
      edgeCount,
      goalCount,
      journalEntries: state.journal?.length || state.thoughtHistory?.length || 0,
    },
    topics: topics.slice(0, 20),  // Top 20 topics
    license: 'proprietary',  // Default, can be overridden
    visibility: 'private',   // Default
    lineage: buildLineage(mergeReport),
    checksums: {
      'state.json.gz': stateChecksum,
    },
  };
  
  // 8. Write manifest
  await writeJson(path.join(outputPath, 'manifest.json'), manifest);
  logger.success('Created manifest.json');
  
  // 9. Copy merge confidence if exists
  const mergeConfidencePath = path.join(runPath, 'merge-confidence.json');
  if (await fileExists(mergeConfidencePath)) {
    await fs.copyFile(
      mergeConfidencePath, 
      path.join(outputPath, 'metadata', 'merge-quality.json')
    );
    logger.info('Copied merge quality metrics');
  }
  
  // 10. Aggregate sources if they exist
  await aggregateSources(runPath, outputPath);
  
  // 11. Copy coordinator reviews if they exist (always include, valuable for insights)
  const coordinatorPath = path.join(runPath, 'coordinator');
  if (await fileExists(coordinatorPath)) {
    logger.info('Copying coordinator reviews...');
    await copyDir(coordinatorPath, path.join(outputPath, 'coordinator'));
    logger.success('Copied coordinator reviews');
  }
  
  // 12. Copy outputs if requested
  if (withOutputs) {
    const outputsPath = path.join(runPath, 'outputs');
    if (await fileExists(outputsPath)) {
      logger.info('Copying outputs folder...');
      await copyDir(outputsPath, path.join(outputPath, 'outputs'));
      logger.success('Copied outputs');
    } else {
      logger.warn('No outputs folder found');
    }
  }
  
  // 12. Create lineage file if we have merge data
  if (mergeReport) {
    await fs.mkdir(path.join(outputPath, 'lineage'), { recursive: true });
    await writeJson(
      path.join(outputPath, 'lineage', 'parents.json'),
      transformMergeReportToLineage(mergeReport)
    );
    logger.success('Created lineage/parents.json');
  }
  
  // Final stats
  const totalSize = await getDirSize(outputPath);
  
  logger.success(`\nExport complete!`);
  logger.info(`Location: ${outputPath}`);
  logger.info(`Total size: ${formatBytes(totalSize)}`);
  logger.info(`Nodes: ${nodeCount}, Edges: ${edgeCount}, Goals: ${goalCount}`);
  
  return { outputPath, manifest };
}

function extractTopics(state) {
  const topics = new Map();
  
  // Extract from node tags
  for (const node of state.memory?.nodes || []) {
    const tag = node.tag || 'unknown';
    topics.set(tag, (topics.get(tag) || 0) + 1);
  }
  
  // Sort by frequency
  return Array.from(topics.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([topic, count]) => ({ topic, count }));
}

function buildLineage(mergeReport) {
  if (!mergeReport) {
    return { parents: [], mergedFrom: [] };
  }
  
  return {
    parents: [],  // For forks (not implemented yet)
    mergedFrom: (mergeReport.sourceRuns || []).map(run => ({
      name: run.name,
      cycles: run.cycles,
      nodes: run.nodes,
      domain: run.domain,
    })),
  };
}

function transformMergeReportToLineage(mergeReport) {
  return {
    version: '1.0.0',
    parents: [],
    merges: [{
      timestamp: mergeReport.created,
      duration: mergeReport.mergeTime,
      sources: (mergeReport.sourceRuns || []).map(run => ({
        name: run.name,
        cycles: run.cycles,
        nodes: run.nodes,
        edges: run.edges,
        domain: run.domain,
      })),
      result: mergeReport.mergedState,
      deduplication: mergeReport.deduplication,
      confidence: mergeReport.confidence ? {
        conflictsPrevented: mergeReport.confidence.conflictsPrevented,
        totalMerged: mergeReport.confidence.totalMerged,
      } : null,
    }],
  };
}

async function aggregateSources(runPath, outputPath) {
  const sources = [];
  const outputsPath = path.join(runPath, 'outputs');
  
  if (!await fileExists(outputsPath)) {
    return;
  }
  
  // Walk through outputs looking for sources.json files
  async function findSources(dir) {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await findSources(fullPath);
        } else if (entry.name === 'sources.json') {
          try {
            const content = await readJson(fullPath);
            if (Array.isArray(content)) {
              sources.push(...content);
            } else if (content.sources) {
              sources.push(...content.sources);
            }
          } catch (e) {
            logger.debug(`Could not parse ${fullPath}: ${e.message}`);
          }
        }
      }
    } catch (e) {
      // Directory doesn't exist or not readable
    }
  }
  
  await findSources(outputsPath);
  
  if (sources.length > 0) {
    // Deduplicate by URL
    const seen = new Set();
    const uniqueSources = sources.filter(s => {
      const key = s.url || s.id || JSON.stringify(s);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    
    await writeJson(
      path.join(outputPath, 'metadata', 'sources.json'),
      {
        version: '1.0.0',
        exportedAt: new Date().toISOString(),
        sources: uniqueSources,
        statistics: {
          total: uniqueSources.length,
        },
      }
    );
    logger.info(`Aggregated ${uniqueSources.length} sources`);
  }
}

// ============================================================================
// Import Command
// ============================================================================

async function importBrain(brainPath, options = {}) {
  const targetDir = options.target || CONFIG.runsDir;
  
  logger.info(`Importing brain from "${brainPath}"...`);
  
  // Validate brain exists
  if (!await fileExists(brainPath)) {
    throw new Error(`Brain not found: ${brainPath}`);
  }
  
  // Load manifest
  const manifestPath = path.join(brainPath, 'manifest.json');
  if (!await fileExists(manifestPath)) {
    throw new Error('Invalid brain: missing manifest.json');
  }
  
  const manifest = await readJson(manifestPath);
  const runName = manifest.brain?.name || path.basename(brainPath, '.brain');
  const runPath = path.join(targetDir, runName);
  
  // Check if run already exists
  if (await fileExists(runPath)) {
    throw new Error(`Run already exists: ${runName}. Use a different name or delete existing.`);
  }
  
  // Create run directory
  await fs.mkdir(runPath, { recursive: true });
  
  // Copy state.json.gz
  const stateSrc = path.join(brainPath, 'state.json.gz');
  if (await fileExists(stateSrc)) {
    await fs.copyFile(stateSrc, path.join(runPath, 'state.json.gz'));
    logger.success('Copied state.json.gz');
  } else {
    throw new Error('Invalid brain: missing state.json.gz');
  }
  
  // Transform manifest back to run-metadata.json
  const runMetadata = {
    created: manifest.brain?.created || new Date().toISOString(),
    importedFrom: brainPath,
    importedAt: new Date().toISOString(),
    brainId: manifest.brain?.id,
    domain: manifest.brain?.displayName || manifest.brain?.name || '',
    context: manifest.brain?.description || '',
    explorationMode: manifest.cosmo?.mode || 'guided',
    executionMode: manifest.cosmo?.executionMode || 'mixed',
    launcherVersion: '2.0-web',
    // Defaults for running
    enableWebSearch: true,
    enableSleep: true,
    enableCodingAgents: true,
    enableIntrospection: true,
    enableAgentRouting: true,
    enableMemoryGovernance: true,
    enableFrontier: true,
    enableCapabilities: true,
    frontierMode: 'observe',
    reviewPeriod: 20,
    maxConcurrent: 5,
    maxCycles: '100',
  };
  
  await writeJson(path.join(runPath, 'run-metadata.json'), runMetadata);
  logger.success('Created run-metadata.json');
  
  // Copy outputs if they exist
  const outputsSrc = path.join(brainPath, 'outputs');
  if (await fileExists(outputsSrc)) {
    await copyDir(outputsSrc, path.join(runPath, 'outputs'));
    logger.success('Copied outputs');
  }
  
  // Copy metadata files
  const metadataSrc = path.join(brainPath, 'metadata');
  if (await fileExists(metadataSrc)) {
    await copyDir(metadataSrc, path.join(runPath, 'metadata'));
    logger.info('Copied metadata');
  }
  
  // Create required directories
  await fs.mkdir(path.join(runPath, 'agents'), { recursive: true });
  await fs.mkdir(path.join(runPath, 'coordinator'), { recursive: true });
  
  logger.success(`\nImport complete!`);
  logger.info(`Run created: ${runPath}`);
  logger.info(`You can now continue this brain with COSMO.`);
  
  return { runPath, runName };
}

// ============================================================================
// Info Command
// ============================================================================

async function showInfo(brainPath) {
  // Handle both .brain directories and run folders
  let manifestPath = path.join(brainPath, 'manifest.json');
  let isBrainFormat = true;
  
  if (!await fileExists(manifestPath)) {
    // Maybe it's a run folder, not a .brain
    const statePath = path.join(brainPath, 'state.json.gz');
    if (await fileExists(statePath)) {
      isBrainFormat = false;
      logger.info('Note: This is a COSMO run folder, not a .brain package.\n');
    } else {
      throw new Error('Not a valid brain or run: missing manifest.json and state.json.gz');
    }
  }
  
  console.log('═'.repeat(60));
  console.log('  🧠 BRAIN INFO');
  console.log('═'.repeat(60));
  
  if (isBrainFormat) {
    const manifest = await readJson(manifestPath);
    
    console.log(`
  Name:        ${manifest.brain?.name || 'Unknown'}
  Display:     ${manifest.brain?.displayName || '-'}
  ID:          ${manifest.brain?.id || '-'}
  
  Created:     ${manifest.brain?.created || '-'}
  Exported:    ${manifest.brain?.exported || '-'}
  
  COSMO Version: ${manifest.cosmo?.version || '-'}
  Cycles:        ${manifest.cosmo?.cycles || '-'}
  Mode:          ${manifest.cosmo?.mode || '-'}
  
  Content:
    Nodes:     ${manifest.content?.nodeCount || 0}
    Edges:     ${manifest.content?.edgeCount || 0}
    Goals:     ${manifest.content?.goalCount || 0}
    Journal:   ${manifest.content?.journalEntries || 0}
  
  Topics: ${(manifest.topics || []).slice(0, 5).map(t => t.topic).join(', ')}
  
  Lineage:
    Parents:   ${manifest.lineage?.parents?.length || 0}
    Merged:    ${manifest.lineage?.mergedFrom?.length || 0} sources
`);
    
    if (manifest.lineage?.mergedFrom?.length > 0) {
      console.log('  Merged from:');
      for (const src of manifest.lineage.mergedFrom.slice(0, 10)) {
        console.log(`    - ${src.name} (${src.nodes} nodes, ${src.domain || 'unknown domain'})`);
      }
      if (manifest.lineage.mergedFrom.length > 10) {
        console.log(`    ... and ${manifest.lineage.mergedFrom.length - 10} more`);
      }
    }
  } else {
    // Show info from run folder
    const statePath = path.join(brainPath, 'state.json.gz');
    const state = await readGzippedJson(statePath);
    
    let runMetadata = {};
    const metaPath = path.join(brainPath, 'run-metadata.json');
    if (await fileExists(metaPath)) {
      runMetadata = await readJson(metaPath);
    }
    
    const nodeCount = state.memory?.nodes?.length || 0;
    const edgeCount = state.memory?.edges?.length || 0;
    
    console.log(`
  Name:        ${path.basename(brainPath)}
  Domain:      ${runMetadata.domain || '-'}
  Context:     ${runMetadata.context || '-'}
  
  Created:     ${runMetadata.created || '-'}
  Mode:        ${runMetadata.explorationMode || '-'}
  Cycles:      ${state.cycleCount || 0}
  
  Content:
    Nodes:     ${nodeCount}
    Edges:     ${edgeCount}
    Goals:     ${(state.goals?.active?.length || 0) + (state.goals?.completed?.length || 0)}
    Journal:   ${state.journal?.length || 0}
  
  💡 Run 'brain export ${path.basename(brainPath)}' to create a .brain package.
`);
  }
  
  console.log('═'.repeat(60));
}

// ============================================================================
// Validate Command
// ============================================================================

async function validateBrain(brainPath) {
  logger.info(`Validating brain: ${brainPath}\n`);
  
  const errors = [];
  const warnings = [];
  
  // Check manifest.json
  const manifestPath = path.join(brainPath, 'manifest.json');
  if (!await fileExists(manifestPath)) {
    errors.push('Missing required file: manifest.json');
  } else {
    try {
      const manifest = await readJson(manifestPath);
      if (!manifest.version) warnings.push('manifest.json missing version');
      if (!manifest.brain?.name) warnings.push('manifest.json missing brain.name');
      if (!manifest.content) warnings.push('manifest.json missing content stats');
    } catch (e) {
      errors.push(`Invalid manifest.json: ${e.message}`);
    }
  }
  
  // Check state.json.gz
  const statePath = path.join(brainPath, 'state.json.gz');
  if (!await fileExists(statePath)) {
    errors.push('Missing required file: state.json.gz');
  } else {
    try {
      const state = await readGzippedJson(statePath);
      if (!state.memory) warnings.push('state.json.gz missing memory');
      if (!state.memory?.nodes) warnings.push('state.json.gz missing memory.nodes');
    } catch (e) {
      errors.push(`Invalid state.json.gz: ${e.message}`);
    }
  }
  
  // Check checksums if present
  if (await fileExists(manifestPath)) {
    try {
      const manifest = await readJson(manifestPath);
      if (manifest.checksums && manifest.checksums['state.json.gz']) {
        const actualChecksum = await computeFileSha256(statePath);
        if (actualChecksum !== manifest.checksums['state.json.gz']) {
          errors.push('Checksum mismatch for state.json.gz (file may be corrupted)');
        }
      }
    } catch (e) {
      // Skip checksum validation if manifest read fails
    }
  }
  
  // Report results
  console.log('═'.repeat(60));
  console.log('  🔍 VALIDATION RESULTS');
  console.log('═'.repeat(60));
  
  if (errors.length === 0 && warnings.length === 0) {
    console.log('\n  ✅ Brain is valid!\n');
  } else {
    if (errors.length > 0) {
      console.log('\n  ❌ ERRORS:');
      for (const err of errors) {
        console.log(`     - ${err}`);
      }
    }
    if (warnings.length > 0) {
      console.log('\n  ⚠️  WARNINGS:');
      for (const warn of warnings) {
        console.log(`     - ${warn}`);
      }
    }
    console.log('');
  }
  
  console.log('═'.repeat(60));
  
  return { valid: errors.length === 0, errors, warnings };
}

// ============================================================================
// List Command
// ============================================================================

async function listRuns() {
  logger.info(`Scanning runs in ${CONFIG.runsDir}...\n`);
  
  const entries = await fs.readdir(CONFIG.runsDir, { withFileTypes: true });
  const runs = [];
  
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;
    
    const runPath = path.join(CONFIG.runsDir, entry.name);
    const statePath = path.join(runPath, 'state.json.gz');
    
    if (!await fileExists(statePath)) continue;
    
    try {
      const state = await readGzippedJson(statePath);
      const metaPath = path.join(runPath, 'run-metadata.json');
      let meta = {};
      if (await fileExists(metaPath)) {
        meta = await readJson(metaPath);
      }
      
      runs.push({
        name: entry.name,
        domain: meta.domain || '-',
        cycles: state.cycleCount || 0,
        nodes: state.memory?.nodes?.length || 0,
        edges: state.memory?.edges?.length || 0,
        created: meta.created || '-',
      });
    } catch (e) {
      logger.debug(`Could not read ${entry.name}: ${e.message}`);
    }
  }
  
  // Sort by name
  runs.sort((a, b) => a.name.localeCompare(b.name));
  
  console.log('═'.repeat(80));
  console.log('  📚 AVAILABLE RUNS');
  console.log('═'.repeat(80));
  console.log('');
  console.log('  Name                          Domain                    Nodes   Cycles');
  console.log('  ' + '─'.repeat(76));
  
  for (const run of runs) {
    const name = run.name.padEnd(30).slice(0, 30);
    const domain = (run.domain || '-').padEnd(25).slice(0, 25);
    const nodes = String(run.nodes).padStart(6);
    const cycles = String(run.cycles).padStart(8);
    console.log(`  ${name}${domain}${nodes}${cycles}`);
  }
  
  console.log('');
  console.log(`  Total: ${runs.length} runs`);
  console.log('═'.repeat(80));
  console.log('');
  console.log('  💡 Use "brain export <name>" to create a .brain package');
  console.log('');
}

// ============================================================================
// CLI Parser
// ============================================================================

function showHelp() {
  console.log(`
🧠 COSMO Brain CLI v${CONFIG.version}

Package, inspect, and manage .brain knowledge packages.

USAGE:
  brain export <run> [options]    Export a COSMO run to .brain format
  brain import <brain> [options]  Import a .brain into COSMO runs
  brain info <path>               Show brain/run information
  brain validate <brain>          Validate a .brain package
  brain list                      List available runs

OPTIONS:
  export:
    --output, -o <path>     Output path (default: <run>.brain)
    --with-outputs          Include outputs folder

  import:
    --target, -t <path>     Target directory (default: ./runs)

EXAMPLES:
  # Export a run to .brain format
  brain export Physics2 --output ./my-physics.brain --with-outputs

  # Show info about a brain or run
  brain info ./my-physics.brain
  brain info ./runs/Physics2

  # Import a brain
  brain import ./my-physics.brain

  # List available runs
  brain list

  # Validate a brain package
  brain validate ./my-physics.brain

The .brain format is the portable, shareable unit of AI knowledge.
See docs/BRAIN_PLATFORM_VISION.md for the full specification.
`);
}

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    showHelp();
    return;
  }
  
  const command = args[0];
  
  try {
    switch (command) {
      case 'export': {
        const runName = args[1];
        if (!runName) {
          logger.error('Missing run name. Usage: brain export <run>');
          process.exit(1);
        }
        
        const options = {};
        for (let i = 2; i < args.length; i++) {
          if (args[i] === '--output' || args[i] === '-o') {
            options.output = args[++i];
          } else if (args[i] === '--with-outputs') {
            options.withOutputs = true;
          }
        }
        
        await exportBrain(runName, options);
        break;
      }
      
      case 'import': {
        const brainPath = args[1];
        if (!brainPath) {
          logger.error('Missing brain path. Usage: brain import <brain>');
          process.exit(1);
        }
        
        const options = {};
        for (let i = 2; i < args.length; i++) {
          if (args[i] === '--target' || args[i] === '-t') {
            options.target = args[++i];
          }
        }
        
        await importBrain(brainPath, options);
        break;
      }
      
      case 'info': {
        const brainPath = args[1];
        if (!brainPath) {
          logger.error('Missing path. Usage: brain info <path>');
          process.exit(1);
        }
        await showInfo(brainPath);
        break;
      }
      
      case 'validate': {
        const brainPath = args[1];
        if (!brainPath) {
          logger.error('Missing brain path. Usage: brain validate <brain>');
          process.exit(1);
        }
        const result = await validateBrain(brainPath);
        process.exit(result.valid ? 0 : 1);
        break;
      }
      
      case 'list': {
        await listRuns();
        break;
      }
      
      default:
        logger.error(`Unknown command: ${command}`);
        showHelp();
        process.exit(1);
    }
  } catch (error) {
    logger.error(error.message);
    if (process.env.DEBUG) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

// Run CLI
main();

