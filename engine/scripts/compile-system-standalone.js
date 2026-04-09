#!/usr/bin/env node
/**
 * Standalone System Compiler
 * 
 * Compiles system documentation from ANY run without requiring orchestrator
 * 
 * Features:
 * - Works on runtime/ or any runs/* directory
 * - No orchestrator dependency
 * - Immediate execution (no queue delay)
 * - Fully self-contained
 * 
 * Usage:
 *   node scripts/compile-system-standalone.js <runDir> <systemId> [queryTimestamps...]
 * 
 * Examples:
 *   # Compile runtime with specific queries
 *   node scripts/compile-system-standalone.js runtime my-system 2025-12-06T10:00:00.000Z 2025-12-06T10:15:00.000Z
 * 
 *   # Compile historical run
 *   node scripts/compile-system-standalone.js runs/Philosophy philosophy-synthesis
 * 
 *   # Compile with all queries from a run
 *   node scripts/compile-system-standalone.js runs/Research research-findings
 */

const { SystemBundleBuilder } = require('../src/system/system-bundle-builder');
const { DocumentCompilerAgent } = require('../src/agents/document-compiler-agent');
const fs = require('fs').promises;
const path = require('path');

// Colors for terminal output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m'
};

function log(msg, color = 'reset') {
  console.log(`${colors[color]}${msg}${colors.reset}`);
}

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length < 2) {
    console.log('');
    log('╔════════════════════════════════════════════════════════════╗', 'cyan');
    log('║   COSMO Standalone System Compiler                        ║', 'cyan');
    log('╚════════════════════════════════════════════════════════════╝', 'cyan');
    console.log('');
    console.log('Usage:');
    console.log('  node scripts/compile-system-standalone.js <runDir> <systemId> [queryTimestamps...]');
    console.log('');
    console.log('Arguments:');
    console.log('  runDir           - Run directory (runtime or runs/Name)');
    console.log('  systemId         - System identifier (alphanumeric, dashes, underscores)');
    console.log('  queryTimestamps  - Optional: ISO timestamps to include (space-separated)');
    console.log('');
    console.log('Examples:');
    console.log('  # All artifacts from runtime');
    console.log('  node scripts/compile-system-standalone.js runtime my-system');
    console.log('');
    console.log('  # Specific queries from runtime');
    console.log('  node scripts/compile-system-standalone.js runtime my-system \\');
    console.log('    2025-12-06T10:00:00.000Z 2025-12-06T10:15:00.000Z');
    console.log('');
    console.log('  # Historical run');
    console.log('  node scripts/compile-system-standalone.js runs/Philosophy phil-synthesis');
    console.log('');
    process.exit(1);
  }
  
  const [runDir, systemId, ...queryTimestamps] = args;
  
  console.log('');
  log('╔════════════════════════════════════════════════════════════╗', 'cyan');
  log('║   COSMO Standalone System Compiler                        ║', 'cyan');
  log('╚════════════════════════════════════════════════════════════╝', 'cyan');
  console.log('');
  
  // Validate inputs
  if (!/^[a-zA-Z0-9_-]+$/.test(systemId)) {
    log('❌ Invalid systemId: must be alphanumeric with dashes/underscores only', 'red');
    process.exit(1);
  }
  
  // Verify run directory exists
  try {
    await fs.access(runDir);
  } catch {
    log(`❌ Run directory not found: ${runDir}`, 'red');
    process.exit(1);
  }
  
  log(`📁 Run Directory: ${runDir}`, 'bright');
  log(`🎯 System ID: ${systemId}`, 'bright');
  if (queryTimestamps.length > 0) {
    log(`📋 Query Filter: ${queryTimestamps.length} timestamps provided`, 'bright');
  } else {
    log(`📋 Query Filter: All artifacts (no query filter)`, 'yellow');
  }
  console.log('');
  
  // ========================================
  // STEP 1: Create System Bundle
  // ========================================
  
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'cyan');
  log('STEP 1: Creating System Bundle', 'cyan');
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'cyan');
  console.log('');
  
  const builder = new SystemBundleBuilder({ logsDir: runDir }, console);
  
  // Build query context if timestamps provided
  let queryContext = null;
  let selectedQueries = [];
  
  if (queryTimestamps.length > 0) {
    log('Loading queries from queries.jsonl...', 'bright');
    const queriesPath = path.join(runDir, 'queries.jsonl');
    
    try {
      const content = await fs.readFile(queriesPath, 'utf-8');
      const allQueries = content.trim().split('\n')
        .filter(Boolean)
        .map(line => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      
      selectedQueries = allQueries.filter(q => queryTimestamps.includes(q.timestamp));
      
      if (selectedQueries.length === 0) {
        log(`⚠️  Warning: No matching queries found for provided timestamps`, 'yellow');
        log(`   Total queries in file: ${allQueries.length}`, 'yellow');
      } else {
        log(`✓ Found ${selectedQueries.length} matching queries`, 'green');
        
        // Build query context for bundle
        const timestamps = selectedQueries.map(q => new Date(q.timestamp).getTime());
        queryContext = {
          queries: selectedQueries.map(q => ({
            timestamp: q.timestamp,
            query: q.query,
            answer: q.answer,
            model: q.model,
            mode: q.mode,
            answerLength: q.answer?.length || 0,
            filesAccessed: q.filesAccessed
          })),
          timeRange: {
            start: new Date(Math.min(...timestamps)).toISOString(),
            end: new Date(Math.max(...timestamps)).toISOString()
          },
          totalAnswerLength: selectedQueries.reduce((sum, q) => sum + (q.answer?.length || 0), 0)
        };
      }
    } catch (error) {
      log(`⚠️  Warning: Could not load queries.jsonl: ${error.message}`, 'yellow');
      log(`   Proceeding with artifact-only compilation`, 'yellow');
    }
  }
  
  console.log('');
  log('Creating bundle...', 'bright');
  
  const { bundle, bundleDir } = await builder.build(systemId, {
    runDir,
    name: systemId,
    description: `Standalone compilation from ${runDir}`,
    agentTypes: [
      'code-creation',
      'code-execution',
      'document-creation',
      'document-analysis',
      'synthesis',
      'analysis'
    ],
    includeMemory: false,
    selectedQueries,  // NEW: Pass for query-driven artifact collection
    notes: selectedQueries.length > 0 
      ? `Compiled from ${selectedQueries.length} selected queries` 
      : 'Compiled from all available artifacts',
    queryContext
  });
  
  // Write source queries if we have them
  if (selectedQueries.length > 0) {
    const queriesFilePath = path.join(bundleDir, 'source_queries.jsonl');
    await fs.writeFile(
      queriesFilePath,
      selectedQueries.map(q => JSON.stringify(q)).join('\n') + '\n',
      'utf-8'
    );
    log(`✓ Source queries saved: ${selectedQueries.length} queries`, 'green');
  }
  
  log(`✓ Bundle created: ${bundleDir}`, 'green');
  log(`  Artifacts: ${bundle.metadata.totalArtifacts} files`, 'bright');
  log(`  - Code: ${bundle.artifacts.code.length}`, 'bright');
  log(`  - Schemas: ${bundle.artifacts.schemas.length}`, 'bright');
  log(`  - Documents: ${bundle.artifacts.documents.length}`, 'bright');
  console.log('');
  
  // ========================================
  // STEP 2: Compile Documentation (STANDALONE)
  // ========================================
  
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'cyan');
  log('STEP 2: Compiling Documentation (Standalone Mode)', 'cyan');
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'cyan');
  console.log('');
  
  // Create agent WITHOUT orchestrator integration
  const agent = new DocumentCompilerAgent(
    {
      systemId,
      runDir,
      goalId: `standalone_${Date.now()}`,
      description: `Standalone compilation: ${systemId} from ${runDir}`,
      successCriteria: [
        'Load system bundle',
        'Generate 3 professional documents',
        'Write complete suite'
      ],
      maxDuration: 600000  // 10 minutes
    },
    { logsDir: runDir },  // Config
    console  // Logger
  );
  
  // CRITICAL: No injection - memory/goals remain null
  // Agent will gracefully skip optional integrations
  
  log('Starting DocumentCompilerAgent (no orchestrator)...', 'bright');
  console.log('');
  
  // Run agent standalone
  const startTime = Date.now();
  const agentResult = await agent.run();
  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  
  console.log('');
  
  if (agentResult.result?.success) {
    log('✅ Compilation Successful!', 'green');
    console.log('');
    log(`📄 Generated Documents:`, 'bright');
    log(`   ${agentResult.result.documents} files created`, 'green');
    log(`   Output: ${runDir}/compiled-docs/${systemId}/`, 'green');
    console.log('');
    log(`⏱️  Duration: ${duration} seconds`, 'bright');
    console.log('');
    
    // List generated files
    const outputDir = path.join(runDir, 'compiled-docs', systemId);
    try {
      const files = await fs.readdir(outputDir);
      log('Files:', 'bright');
      for (const file of files) {
        const filePath = path.join(outputDir, file);
        const stat = await fs.stat(filePath);
        const size = (stat.size / 1024).toFixed(1);
        log(`  ✓ ${file} (${size} KB)`, 'green');
      }
    } catch (error) {
      log(`  Could not list files: ${error.message}`, 'yellow');
    }
    
    console.log('');
    log('════════════════════════════════════════════════════════════', 'green');
    log('COMPILATION COMPLETE - Documents ready for use', 'green');
    log('════════════════════════════════════════════════════════════', 'green');
    console.log('');
    
  } else {
    log('❌ Compilation Failed', 'red');
    console.log('');
    if (agentResult.result?.errors) {
      log('Errors:', 'red');
      agentResult.result.errors.forEach(err => {
        log(`  • ${err.type}: ${err.error || err.message}`, 'red');
      });
    }
    console.log('');
    process.exit(1);
  }
}

main().catch(error => {
  console.error('');
  log('❌ Fatal Error:', 'red');
  log(`   ${error.message}`, 'red');
  if (error.stack) {
    console.error('');
    console.error(error.stack);
  }
  console.error('');
  process.exit(1);
});

