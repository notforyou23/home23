#!/usr/bin/env node

/**
 * Generate Retroactive Injection Manifests
 * 
 * Purpose:
 * - Scan runtime/outputs/injected/* for directories without manifests
 * - Generate .injection-manifest.json with analyzed=true
 * - Prevent COSMO from re-analyzing already-processed documents
 * - Make old injections visible in dashboard provenance
 * 
 * Usage:
 *   node scripts/generate-retroactive-injection-manifests.js [--dry-run]
 */

const fs = require('fs').promises;
const path = require('path');

// Parse args
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  Generate Retroactive Injection Manifests                   ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');
  
  if (dryRun) {
    console.log('🔍 DRY RUN MODE - No files will be created\n');
  }
  
  const injectedDir = path.join(process.cwd(), 'runtime', 'outputs', 'injected');
  
  // Check if directory exists
  try {
    await fs.access(injectedDir);
  } catch (error) {
    console.log('❌ No injected directory found:', injectedDir);
    console.log('   This is normal if you haven\'t injected any documents yet.');
    return;
  }
  
  // Get all injection directories (timestamps)
  const entries = await fs.readdir(injectedDir, { withFileTypes: true });
  const injectionDirs = entries
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .filter(name => /^\d+$/.test(name)); // Only timestamp directories
  
  console.log(`📂 Found ${injectionDirs.length} injection directories\n`);
  
  let created = 0;
  let skipped = 0;
  let errors = 0;
  
  for (const dirName of injectionDirs) {
    const dirPath = path.join(injectedDir, dirName);
    const manifestPath = path.join(dirPath, '.injection-manifest.json');
    
    // Check if manifest already exists
    try {
      await fs.access(manifestPath);
      console.log(`⏭️  [${dirName}] Manifest exists - skipping`);
      skipped++;
      continue;
    } catch (error) {
      // Manifest doesn't exist - need to create
    }
    
    try {
      // Get list of files in this injection
      const files = await fs.readdir(dirPath, { withFileTypes: true });
      const documentFiles = files.filter(f => 
        f.isFile() && !f.name.startsWith('.')
      );
      
      if (documentFiles.length === 0) {
        console.log(`⚠️  [${dirName}] No files found - skipping empty directory`);
        skipped++;
        continue;
      }
      
      // Get file stats
      const fileRecords = [];
      for (const file of documentFiles) {
        const filePath = path.join(dirPath, file.name);
        const relativePath = path.relative(process.cwd(), filePath);
        const stats = await fs.stat(filePath);
        const ext = path.extname(file.name).toLowerCase().replace('.', '');
        
        // Determine file type
        const textExtensions = ['txt', 'md', 'json', 'yaml', 'yml', 'py', 'js', 'ts', 'html', 'css', 'csv'];
        const binaryExtensions = ['pdf', 'docx', 'xlsx', 'doc', 'xls'];
        const fileType = textExtensions.includes(ext) ? 'text' 
                       : binaryExtensions.includes(ext) ? 'binary' 
                       : 'text';
        
        fileRecords.push({
          path: relativePath,
          filename: file.name,
          size: stats.size,
          extension: ext,
          type: fileType,
          injectedAt: new Date(parseInt(dirName)).toISOString(),
          
          // CRITICAL: Mark as already analyzed/in-memory
          // This prevents COSMO from re-analyzing these documents
          readByAgents: [], // Unknown - was processed before tracking
          inMemory: true, // Assume already in memory (safe assumption)
          analyzed: true, // Mark as analyzed to prevent loops
          analysisAgents: [], // Unknown - processed before tracking
          memoryNodeIds: [], // Unknown - would require memory network scan
          
          // Retroactive marker
          retroactive: true,
          retroactiveNote: 'Document was processed before provenance tracking. Marked as analyzed to prevent re-processing.'
        });
      }
      
      // Categorize files
      const textFiles = fileRecords.filter(f => f.type === 'text');
      const binaryFiles = fileRecords.filter(f => f.type === 'binary');
      
      // Create manifest
      const manifest = {
        timestamp: parseInt(dirName),
        timestampISO: new Date(parseInt(dirName)).toISOString(),
        injectedBy: 'unknown', // Pre-tracking
        injectionPath: path.relative(process.cwd(), dirPath),
        mission: null, // Unknown - pre-tracking
        priority: 'unknown', // Unknown - pre-tracking
        immediate: true, // Unknown - assume true
        
        // File inventory
        filesTotal: fileRecords.length,
        filesWritten: fileRecords.length,
        filesFailed: 0,
        
        // Categorization
        textFiles: textFiles.map(f => ({ name: f.filename, size: f.size, type: 'text' })),
        binaryFiles: binaryFiles.map(f => ({ name: f.filename, size: f.size, type: 'binary' })),
        
        // Individual file records
        files: fileRecords,
        
        // Failed files
        failedFiles: [],
        
        // Agent tracking (unknown for retroactive)
        agentsSpawned: [],
        
        // Status
        status: 'complete',
        
        // Metadata
        runName: 'runtime',
        source: 'retroactive_manifest_generator',
        version: 1,
        
        // CRITICAL: Mark as retroactive
        retroactive: true,
        retroactiveGeneratedAt: new Date().toISOString(),
        retroactiveNote: 'This manifest was generated retroactively for documents injected before provenance tracking. Documents marked as analyzed to prevent re-processing loops.'
      };
      
      // Write manifest
      if (dryRun) {
        console.log(`✓  [${dirName}] Would create manifest (${fileRecords.length} files)`);
      } else {
        await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
        console.log(`✅ [${dirName}] Created manifest (${fileRecords.length} files)`);
      }
      
      created++;
      
    } catch (error) {
      console.error(`❌ [${dirName}] Error:`, error.message);
      errors++;
    }
  }
  
  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('');
  console.log('📊 Summary:');
  console.log(`   Manifests created: ${created}`);
  console.log(`   Already had manifest: ${skipped}`);
  console.log(`   Errors: ${errors}`);
  console.log('');
  
  if (dryRun && created > 0) {
    console.log('💡 Run without --dry-run to create manifests:');
    console.log('   node scripts/generate-retroactive-injection-manifests.js');
    console.log('');
  } else if (created > 0) {
    console.log('✅ Retroactive manifests created!');
    console.log('');
    console.log('🎯 What this does:');
    console.log('   • Marks old documents as analyzed=true (prevents re-analysis loops)');
    console.log('   • Makes old injections visible in dashboard provenance');
    console.log('   • Assumes documents are already in memory (safe assumption)');
    console.log('   • Future reads/updates will be tracked normally');
    console.log('');
    console.log('📍 View in dashboard:');
    console.log('   Intelligence → Trace tab → "Load Provenance" button');
    console.log('');
  } else if (skipped > 0) {
    console.log('✅ All injections already have manifests!');
    console.log('');
  }
}

// Run
main().catch(error => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});

