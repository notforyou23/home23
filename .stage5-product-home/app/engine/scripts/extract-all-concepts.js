#!/usr/bin/env node
/**
 * Extract ALL concepts from ALL 87 COSMO outputs
 * This is the REAL work - read every file, extract every concept
 */

const fs = require('fs');
const path = require('path');

const AI_REVIEWS_DIR = path.join(__dirname, '..', 'queries-archive', 'ai-reviews');

// Read all AI review files
const files = fs.readdirSync(AI_REVIEWS_DIR)
    .filter(f => f.endsWith('-ai-review.md'))
    .sort();

console.log(`Reading ${files.length} files...\n`);

const allConcepts = [];
let totalValue = 0;

files.forEach((filename, idx) => {
    const filepath = path.join(AI_REVIEWS_DIR, filename);
    const content = fs.readFileSync(filepath, 'utf8');
    
    // Extract basic metadata
    const timestampMatch = content.match(/\*\*Timestamp:\*\* (.+)/);
    const runMatch = content.match(/\*\*Run:\*\* (.+)/);
    const queryMatch = content.match(/\*\*Original Query:\*\* (.+)/);
    
    // Extract essence
    const essenceMatch = content.match(/(?:Essence|Core Thesis)[:\s]*\n?(.+?)(?:\n\n|Key Outputs|Novelty)/s);
    const essence = essenceMatch ? essenceMatch[1].trim().replace(/^-\s*/, '').replace(/\n/g, ' ').substring(0, 250) : null;
    
    // Extract key concepts (the bullet points)
    const keyOutputsMatch = content.match(/(?:Key Outputs|Key Concepts)[^\n]*\n((?:- .+(?:\n|$))+)/);
    let concepts = [];
    if (keyOutputsMatch) {
        concepts = keyOutputsMatch[1]
            .split('\n')
            .filter(line => line.trim().startsWith('-'))
            .map(line => {
                // Extract concept name (before colon) and description
                const match = line.match(/^-\s*(.+?):/);
                const name = match ? match[1].trim() : line.replace(/^-\s*/, '').substring(0, 100);
                return name;
            })
            .filter(Boolean);
    }
    
    // Extract value if present
    const valueMatch = content.match(/Estimated Value.*?(\$[0-9]+[MBK]?[-–]\$?[0-9]+[MBK]?)/i);
    const value = valueMatch ? valueMatch[1] : null;
    
    if (concepts.length > 0 || essence) {
        allConcepts.push({
            filename,
            run: runMatch ? runMatch[1] : null,
            timestamp: timestampMatch ? timestampMatch[1] : null,
            query: queryMatch ? queryMatch[1].substring(0, 80) : null,
            essence,
            concepts,
            value
        });
    }
    
    if ((idx + 1) % 10 === 0) {
        console.log(`Processed ${idx + 1}/${files.length}...`);
    }
});

console.log(`\nCompleted ${allConcepts.length} outputs with extractable content.\n`);

// Save to JSON
const outputPath = path.join(__dirname, '..', 'all-concepts-extracted.json');
fs.writeFileSync(outputPath, JSON.stringify(allConcepts, null, 2));

console.log(`✅ Saved to: all-concepts-extracted.json\n`);

// Print summary
console.log('='.repeat(80));
console.log('SUMMARY BY DOMAIN');
console.log('='.repeat(80) + '\n');

// Group by query similarity
const domains = {};
allConcepts.forEach(item => {
    // Simple domain detection
    let domain = 'Other';
    const text = (item.essence || '') + ' ' + item.concepts.join(' ');
    
    if (text.match(/AI.*governance|compliance|receipt|audit|GDPR|HIPAA/i)) domain = 'AI Governance & Compliance';
    else if (text.match(/legal|eDiscovery|litigation|regulatory/i)) domain = 'Legal Tech';
    else if (text.match(/health|clinical|medical|therapeutic|patient/i)) domain = 'Healthcare & Life Sciences';
    else if (text.match(/bio|fungal|network|IoT|sensor/i)) domain = 'Biotech & Emerging Tech';
    else if (text.match(/ARC|solver|program synthesis|reasoning/i)) domain = 'AI Research';
    else if (text.match(/market|trading|financial|collectible/i)) domain = 'Business & Markets';
    
    if (!domains[domain]) domains[domain] = [];
    domains[domain].push(item);
});

Object.entries(domains).sort((a, b) => b[1].length - a[1].length).forEach(([domain, items]) => {
    console.log(`\n${domain} (${items.length} outputs)`);
    console.log('-'.repeat(80));
    
    items.slice(0, 3).forEach(item => {
        console.log(`\n• ${item.run || item.filename}`);
        if (item.essence) {
            console.log(`  ${item.essence.substring(0, 200)}...`);
        }
        console.log(`  Concepts: ${item.concepts.length}`);
        if (item.value) {
            console.log(`  Value: ${item.value}`);
        }
    });
    
    if (items.length > 3) {
        console.log(`\n  ... and ${items.length - 3} more in this domain`);
    }
});

console.log('\n\n' + '='.repeat(80));
console.log(`Total: ${allConcepts.length} outputs with ${allConcepts.reduce((sum, item) => sum + item.concepts.length, 0)} concepts identified`);
console.log('='.repeat(80) + '\n');

