#!/usr/bin/env node
/**
 * PathResolver Integration Test
 * 
 * Tests:
 * - PathResolver initialization
 * - Logical path resolution
 * - MCP accessibility validation
 * - Deliverable path generation
 */

const path = require('path');
const fs = require('fs').promises;
const { PathResolver } = require('../../src/core/path-resolver');

// Simple test logger
const testLogger = {
  debug: (msg, data) => console.log(`[DEBUG] ${msg}`, data || ''),
  info: (msg, data) => console.log(`[INFO] ${msg}`, data || ''),
  warn: (msg, data) => console.warn(`[WARN] ${msg}`, data || ''),
  error: (msg, data) => console.error(`[ERROR] ${msg}`, data || '')
};

async function runTests() {
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║         PathResolver Integration Test            ║');
  console.log('╚══════════════════════════════════════════════════╝\n');
  
  let passed = 0;
  let failed = 0;
  
  try {
    // Test 1: Initialize PathResolver
    console.log('Test 1: Initialize PathResolver');
    const runtimeRoot = path.resolve(__dirname, '../../runtime');
    const config = {
      runtimeRoot,
      mcp: {
        allowedPaths: [
          path.join(runtimeRoot, 'outputs'),
          path.join(runtimeRoot, 'exports')
        ]
      }
    };
    
    const pathResolver = new PathResolver(config, testLogger);
    console.log('✅ PathResolver initialized\n');
    passed++;
    
    // Test 2: Resolve logical paths
    console.log('Test 2: Resolve logical paths');
    const outputsPath = pathResolver.resolve('@outputs/test.md');
    const exportsPath = pathResolver.resolve('@exports/data.json');
    const coordPath = pathResolver.resolve('@coordinator/review.json');
    
    console.log(`  @outputs/test.md → ${outputsPath}`);
    console.log(`  @exports/data.json → ${exportsPath}`);
    console.log(`  @coordinator/review.json → ${coordPath}`);
    
    if (outputsPath === path.join(runtimeRoot, 'outputs', 'test.md') &&
        exportsPath === path.join(runtimeRoot, 'exports', 'data.json') &&
        coordPath === path.join(runtimeRoot, 'coordinator', 'review.json')) {
      console.log('✅ All logical paths resolved correctly\n');
      passed++;
    } else {
      console.log('❌ Logical path resolution failed\n');
      failed++;
    }
    
    // Test 3: MCP accessibility check
    console.log('Test 3: MCP accessibility check');
    const accessiblePath = path.join(runtimeRoot, 'outputs', 'test.md');
    const inaccessiblePath = '/tmp/outside.md';
    
    const isAccessible = pathResolver.isPathAccessibleViaMCP(accessiblePath);
    const isInaccessible = !pathResolver.isPathAccessibleViaMCP(inaccessiblePath);
    
    console.log(`  ${accessiblePath}: accessible = ${isAccessible}`);
    console.log(`  ${inaccessiblePath}: accessible = ${!isInaccessible}`);
    
    if (isAccessible && isInaccessible) {
      console.log('✅ MCP accessibility check works correctly\n');
      passed++;
    } else {
      console.log('❌ MCP accessibility check failed\n');
      failed++;
    }
    
    // Test 4: Deliverable path with required accessibility
    console.log('Test 4: Deliverable path with required accessibility');
    const deliverableSpec = {
      location: '@outputs/',
      filename: 'brilliant_paragraph.md',
      accessibility: 'mcp-required'
    };
    
    const deliverablePath = pathResolver.getDeliverablePath({
      deliverableSpec,
      agentType: 'document-creation',
      agentId: 'agent_test_123',
      fallbackName: 'fallback.md'
    });
    
    console.log(`  Full path: ${deliverablePath.fullPath}`);
    console.log(`  Relative path: ${deliverablePath.relativePath}`);
    console.log(`  Directory: ${deliverablePath.directory}`);
    console.log(`  Filename: ${deliverablePath.filename}`);
    console.log(`  MCP accessible: ${deliverablePath.isAccessible}`);
    
    if (deliverablePath.filename === 'brilliant_paragraph.md' &&
        deliverablePath.isAccessible === true &&
        deliverablePath.fullPath.includes('outputs')) {
      console.log('✅ Deliverable path generation works correctly\n');
      passed++;
    } else {
      console.log('❌ Deliverable path generation failed\n');
      failed++;
    }
    
    // Test 5: Error on inaccessible path with required accessibility
    console.log('Test 5: Error on inaccessible path with required accessibility');
    const badSpec = {
      location: '/tmp/not-allowed',
      filename: 'test.md',
      accessibility: 'mcp-required'
    };
    
    try {
      pathResolver.getDeliverablePath({
        deliverableSpec: badSpec,
        agentType: 'document-creation',
        agentId: 'agent_test',
        fallbackName: 'fallback.md'
      });
      console.log('❌ Should have thrown error for inaccessible path\n');
      failed++;
    } catch (error) {
      if (error.message.includes('not accessible via MCP')) {
        console.log('✅ Correctly throws error for inaccessible required path\n');
        passed++;
      } else {
        console.log(`❌ Wrong error: ${error.message}\n`);
        failed++;
      }
    }
    
    // Test 6: Helper methods
    console.log('Test 6: Helper methods');
    const outputsRoot = pathResolver.getOutputsRoot();
    const exportsRoot = pathResolver.getExportsRoot();
    const coordDir = pathResolver.getCoordinatorDir();
    const runtimeRootCheck = pathResolver.getRuntimeRoot();
    
    console.log(`  getOutputsRoot: ${outputsRoot}`);
    console.log(`  getExportsRoot: ${exportsRoot}`);
    console.log(`  getCoordinatorDir: ${coordDir}`);
    console.log(`  getRuntimeRoot: ${runtimeRootCheck}`);
    
    if (outputsRoot === path.join(runtimeRoot, 'outputs') &&
        exportsRoot === path.join(runtimeRoot, 'exports') &&
        coordDir === path.join(runtimeRoot, 'coordinator') &&
        runtimeRootCheck === runtimeRoot) {
      console.log('✅ All helper methods return correct paths\n');
      passed++;
    } else {
      console.log('❌ Helper methods failed\n');
      failed++;
    }
    
    // Test 7: Diagnostics
    console.log('Test 7: Diagnostics');
    const diagnostics = pathResolver.getDiagnostics();
    console.log('  Diagnostics:', JSON.stringify(diagnostics, null, 2));
    
    if (diagnostics.runtimeRoot && 
        diagnostics.mcpAllowedPaths && 
        diagnostics.prefixes &&
        diagnostics.mcpAccessible) {
      console.log('✅ Diagnostics contain all required fields\n');
      passed++;
    } else {
      console.log('❌ Diagnostics incomplete\n');
      failed++;
    }
    
    // Summary
    console.log('═══════════════════════════════════════════════════');
    console.log(`Tests completed: ${passed + failed}`);
    console.log(`✅ Passed: ${passed}`);
    console.log(`❌ Failed: ${failed}`);
    console.log('═══════════════════════════════════════════════════\n');
    
    if (failed === 0) {
      console.log('🎉 All tests passed!\n');
      process.exit(0);
    } else {
      console.log('⚠️  Some tests failed\n');
      process.exit(1);
    }
    
  } catch (error) {
    console.error('\n❌ Test execution failed:', error);
    console.error(error.stack);
    process.exit(1);
  }
}

runTests();

