#!/usr/bin/env node
/**
 * Extract Executive Summaries from COSMO Outputs
 * 
 * Reads actual AI review files and extracts:
 * - Core thesis
 * - Key concepts (bullet points)
 * - Value estimates
 * - Market/domain info
 * 
 * Outputs clean markdown suitable for executive presentation
 */

const fs = require('fs');
const path = require('path');

const AI_REVIEWS_DIR = path.join(__dirname, '..', 'queries-archive', 'ai-reviews');

// Featured outputs to summarize
const FEATURED = [
    'deldemo1-query-1-ai-review.md',
    'enron1-query-1-ai-review.md',
    'crossfit-query-1-ai-review.md',
    'sauna-query-1-ai-review.md',
    'Xfungicom2-query-1-ai-review.md'
];

console.log('# COSMO Research Outputs - Executive Summary\n');
console.log('**Generated**: ' + new Date().toLocaleDateString());
console.log('**Source**: Real COSMO outputs from queries-archive/ai-reviews/\n');
console.log('---\n');

FEATURED.forEach((filename, index) => {
    const filepath = path.join(AI_REVIEWS_DIR, filename);
    
    if (!fs.existsSync(filepath)) {
        console.log(`## Output ${index + 1}: ${filename}`);
        console.log('**Status**: File not found\n');
        return;
    }
    
    const content = fs.readFileSync(filepath, 'utf8');
    
    // Extract timestamp
    const timestampMatch = content.match(/\*\*Timestamp:\*\* (.+)/);
    const timestamp = timestampMatch ? timestampMatch[1] : 'Unknown';
    
    // Extract model
    const modelMatch = content.match(/\*\*Model Used:\*\* (.+)/);
    const model = modelMatch ? modelMatch[1] : 'Unknown';
    
    // Extract essence/core thesis
    let essence = 'Not extracted';
    const essenceMatch = content.match(/(?:Essence|Core Thesis)[:\s]*\n?(.+?)(?:\n\n|Key Outputs|Novelty)/s);
    if (essenceMatch) {
        essence = essenceMatch[1].trim()
            .replace(/^-\s*/, '')
            .replace(/\n/g, ' ')
            .substring(0, 400);
    }
    
    // Extract key outputs section
    const keyOutputsMatch = content.match(/(?:Key Outputs|Key Concepts)[^\n]*\n((?:- .+\n?)+)/);
    let keyOutputs = [];
    if (keyOutputsMatch) {
        keyOutputs = keyOutputsMatch[1]
            .split('\n')
            .filter(line => line.trim().startsWith('-'))
            .slice(0, 8)  // Top 8
            .map(line => line.trim());
    }
    
    // Extract value
    const valueMatch = content.match(/Estimated Value.*?(\$[0-9]+[MBK]?[-–]\$?[0-9]+[MBK]?)/);
    const value = valueMatch ? valueMatch[1] : 'Not specified';
    
    // Print executive summary
    console.log(`## Output ${index + 1}: ${filename.replace('-ai-review.md', '')}\n`);
    console.log(`**File**: \`queries-archive/ai-reviews/${filename}\``);
    console.log(`**Generated**: ${timestamp}`);
    console.log(`**Model**: ${model}`);
    console.log(`**Estimated Value**: ${value}\n`);
    
    console.log(`**Core Thesis**:`);
    console.log(essence + '\n');
    
    if (keyOutputs.length > 0) {
        console.log(`**Key Concepts** (${keyOutputs.length} shown):`);
        keyOutputs.forEach(output => {
            console.log(output);
        });
        console.log('');
    }
    
    console.log(`**Full Output**: \`cat queries-archive/ai-reviews/${filename}\`\n`);
    console.log('---\n');
});

console.log('\n## Complete Portfolio\n');
console.log('**Total Outputs**: 87 files');
console.log('**Location**: `queries-archive/ai-reviews/`');
console.log('**View All**: `ls -lh queries-archive/ai-reviews/`');
console.log('**Verify**: `node scripts/generate-output-summary.js`\n');

