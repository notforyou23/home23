#!/usr/bin/env node
/**
 * Generate a self-contained dreams viewer HTML file with embedded data
 * No server needed - works directly in browser!
 */

const fs = require('fs');
const path = require('path');

const dreamsReportPath = path.join(__dirname, '..', 'dreams_report.json');
const templatePath = path.join(__dirname, '..', 'dreams_viewer.html');
const outputPath = path.join(__dirname, '..', 'dreams_viewer_standalone.html');

console.log('📖 Reading dreams data...');
const dreamsData = fs.readFileSync(dreamsReportPath, 'utf8');

console.log('📄 Reading HTML template...');
const template = fs.readFileSync(templatePath, 'utf8');

console.log('🔄 Embedding data into HTML...');

// Replace the fetch call with embedded data
const modifiedHtml = template
    .replace(
        'async function loadDreams() {',
        `// Embedded data - no fetch required!
        const EMBEDDED_DATA = ${dreamsData};
        
        function loadDreams() {`
    )
    .replace(
        /const response = await fetch\('dreams_report\.json'\);[\s\S]*?const data = await response\.json\(\);/,
        'const data = EMBEDDED_DATA;'
    )
    .replace(
        'loadingStatus.textContent = \'Loading dreams database...\';',
        '// Data already embedded, skip loading message'
    )
    .replace(
        'Complete Dream Archive - No Limits',
        'Complete Dream Archive - Standalone, No Server Required'
    )
    .replace(
        'loadingStatus.textContent = `✅ Loaded ${allDreams.length.toLocaleString()} dreams from ${data.length} runs`;',
        'loadingStatus.textContent = `✅ Loaded ${allDreams.length.toLocaleString()} dreams from ${data.length} runs - Standalone!`;'
    );

console.log('💾 Writing standalone HTML...');
fs.writeFileSync(outputPath, modifiedHtml);

const fileSize = fs.statSync(outputPath).size;
const fileSizeMB = (fileSize / 1024 / 1024).toFixed(2);

console.log(`\n✅ Success!`);
console.log(`\n📄 Generated: ${outputPath}`);
console.log(`\n💾 File size: ${fileSizeMB} MB`);
console.log(`\n🚀 Usage: Just open the HTML file in any browser - no server required!`);
console.log(`   The entire dreams database is embedded in the HTML file.`);
console.log(`\n   Open it with:`);
console.log(`   open ${outputPath}`);
