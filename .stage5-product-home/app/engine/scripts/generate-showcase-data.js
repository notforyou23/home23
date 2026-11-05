#!/usr/bin/env node
/**
 * Generate showcase data from ACTUAL files
 * Only includes data that can be verified from existing files
 * NO fabricated data - everything sourced from real COSMO outputs
 */

const fs = require('fs');
const path = require('path');

const AI_REVIEWS_DIR = path.join(__dirname, '..', 'queries-archive', 'ai-reviews');
const JSONL_DIR = path.join(__dirname, '..', 'queries-archive', 'jsonl');

// Read actual AI review files and extract REAL data
function extractRealData(filename) {
    const content = fs.readFileSync(path.join(AI_REVIEWS_DIR, filename), 'utf8');
    
    // Extract only data that actually exists in the file
    const data = {
        filename,
        title: null,
        timestamp: null,
        model: null,
        run: null,
        essence: null,
        value: null,
        concepts: [],
        compliance: []
    };
    
    // Extract timestamp
    const timestampMatch = content.match(/\*\*Timestamp:\*\* (.+)/);
    if (timestampMatch) data.timestamp = timestampMatch[1];
    
    // Extract model
    const modelMatch = content.match(/\*\*Model Used:\*\* (.+)/);
    if (modelMatch) data.model = modelMatch[1];
    
    // Extract run name
    const runMatch = content.match(/\*\*Run:\*\* (.+)/);
    if (runMatch) data.run = runMatch[1];
    
    // Extract essence/core thesis
    const essenceMatch = content.match(/(?:Essence|Core Thesis)[:\n]+(.+?)(?:\n\n|Key Outputs)/s);
    if (essenceMatch) {
        data.essence = essenceMatch[1].trim().replace(/^-\s*/, '').substring(0, 300);
    }
    
    // Extract value estimate
    const valueMatch = content.match(/Estimated Value.*?(\$[0-9]+[MBK]?[-–]?\$?[0-9]+[MBK]?)/i);
    if (valueMatch) data.value = valueMatch[1];
    
    // Extract compliance frameworks
    const complianceMatches = content.match(/GDPR|HIPAA|SOX|SEC|FINRA|ISO 27001|EU AI Act/g);
    if (complianceMatches) {
        data.compliance = [...new Set(complianceMatches)];
    }
    
    // Extract concept count
    const conceptsMatch = content.match(/Top (\d+)|(\d+) novel concepts/i);
    if (conceptsMatch) {
        data.conceptCount = parseInt(conceptsMatch[1] || conceptsMatch[2]);
    }
    
    return data;
}

// Get all AI review files
const reviews = fs.readdirSync(AI_REVIEWS_DIR)
    .filter(f => f.endsWith('-ai-review.md'))
    .sort();

console.log(`Processing ${reviews.length} AI review files...\n`);

// Extract data from first 10 (representative sample)
const sampleData = reviews.slice(0, 10).map(file => {
    try {
        const data = extractRealData(file);
        console.log(`✓ ${file}`);
        console.log(`  Timestamp: ${data.timestamp || 'N/A'}`);
        console.log(`  Value: ${data.value || 'N/A'}`);
        console.log(`  Compliance: ${data.compliance.join(', ') || 'N/A'}`);
        console.log('');
        return data;
    } catch (error) {
        console.error(`✗ ${file}: ${error.message}`);
        return null;
    }
}).filter(Boolean);

// Output as JSON for use in HTML
const outputPath = path.join(__dirname, '..', 'showcase-data.json');
fs.writeFileSync(outputPath, JSON.stringify(sampleData, null, 2));

console.log(`\n✅ Generated showcase-data.json with ${sampleData.length} verified outputs`);
console.log(`\nAll data extracted from actual files - nothing fabricated.`);

