#!/usr/bin/env node

/**
 * COSMO IP Snapshot Script
 * 
 * Creates a verifiable snapshot of the codebase for IP protection:
 * 1. Creates git tag
 * 2. Exports git archive
 * 3. Generates SHA-256 hash
 * 4. Creates IP register document
 * 
 * Follows procedure for defensible proof of authorship for patents and IP sale.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const crypto = require('crypto');

const WORKSPACE_ROOT = process.cwd();
const DATE = new Date().toISOString().split('T')[0].replace(/-/g, '_');
const TAG_NAME = `cosmo_ip_snapshot_${DATE}`;
const ARCHIVE_NAME = `${TAG_NAME}.tar.gz`;
const REGISTER_NAME = `COSMO_IP_REGISTER_${DATE}.md`;

/**
 * Execute shell command and return output
 */
function exec(command, options = {}) {
  try {
    return execSync(command, {
      encoding: 'utf-8',
      cwd: WORKSPACE_ROOT,
      ...options
    }).trim();
  } catch (error) {
    console.error(`❌ Error executing: ${command}`);
    console.error(error.message);
    throw error;
  }
}

/**
 * Check if git repo is clean
 */
function checkGitStatus() {
  console.log('🔍 Checking git status...\n');
  
  const status = exec('git status --porcelain');
  if (status) {
    console.warn('⚠️  Warning: You have uncommitted changes:');
    console.log(status);
    console.log('\n💡 Consider committing changes before creating snapshot.\n');
    
    const readline = require('readline').createInterface({
      input: process.stdin,
      output: process.stdout
    });
    
    return new Promise((resolve) => {
      readline.question('Continue anyway? (yes/no): ', (answer) => {
        readline.close();
        if (answer.toLowerCase() !== 'yes' && answer.toLowerCase() !== 'y') {
          console.log('❌ Aborted.');
          process.exit(1);
        }
        resolve();
      });
    });
  }
  
  console.log('✅ Git working directory is clean.\n');
  return Promise.resolve();
}

/**
 * Step 1: Create git tag
 */
function createGitTag() {
  console.log('📌 Step 1: Creating git tag...\n');
  
  // Check if tag already exists
  try {
    exec(`git rev-parse --verify ${TAG_NAME} 2>/dev/null`);
    console.warn(`⚠️  Tag ${TAG_NAME} already exists!`);
    const readline = require('readline').createInterface({
      input: process.stdin,
      output: process.stdout
    });
    
    return new Promise((resolve) => {
      readline.question('Delete existing tag and create new one? (yes/no): ', (answer) => {
        readline.close();
        if (answer.toLowerCase() === 'yes' || answer.toLowerCase() === 'y') {
          exec(`git tag -d ${TAG_NAME}`);
          exec(`git push origin :refs/tags/${TAG_NAME} 2>/dev/null || true`);
        } else {
          console.log('❌ Aborted.');
          process.exit(1);
        }
        resolve();
      });
    }).then(() => {
      _createTag();
    });
  } catch (e) {
    _createTag();
    return Promise.resolve();
  }
  
  function _createTag() {
    const message = `Snapshot for IP protection - ${DATE}`;
    exec(`git tag -a ${TAG_NAME} -m "${message}"`);
    console.log(`✅ Created tag: ${TAG_NAME}\n`);
    
    // Try to push tag (may fail if no remote, that's okay)
    try {
      exec(`git push origin ${TAG_NAME}`);
      console.log(`✅ Pushed tag to remote\n`);
    } catch (e) {
      console.log(`ℹ️  Tag not pushed to remote (no remote or connection issue)\n`);
    }
  }
}

/**
 * Step 2: Export git archive
 */
function exportArchive() {
  console.log('📦 Step 2: Exporting git archive...\n');
  
  const archivePath = path.join(WORKSPACE_ROOT, ARCHIVE_NAME);
  
  // Remove existing archive if present
  if (fs.existsSync(archivePath)) {
    fs.unlinkSync(archivePath);
  }
  
  exec(`git archive --format=tar.gz --output=${ARCHIVE_NAME} ${TAG_NAME}`);
  
  if (!fs.existsSync(archivePath)) {
    throw new Error('Archive creation failed');
  }
  
  const stats = fs.statSync(archivePath);
  const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
  
  console.log(`✅ Created archive: ${ARCHIVE_NAME}`);
  console.log(`   Size: ${sizeMB} MB\n`);
  
  return archivePath;
}

/**
 * Step 3: Generate SHA-256 hash
 */
function generateHash(archivePath) {
  console.log('🔐 Step 3: Generating SHA-256 hash...\n');
  
  const fileBuffer = fs.readFileSync(archivePath);
  const hashSum = crypto.createHash('sha256');
  hashSum.update(fileBuffer);
  const hash = hashSum.digest('hex');
  
  console.log(`✅ SHA-256 Hash:`);
  console.log(`   ${hash}\n`);
  
  return hash;
}

/**
 * Step 4: Get commit SHA
 */
function getCommitSha() {
  return exec(`git rev-parse ${TAG_NAME}`);
}

/**
 * Step 5: Create IP register document
 */
function createIPRegister(archivePath, hash, commitSha) {
  console.log('📄 Step 4: Creating IP register document...\n');
  
  const stats = fs.statSync(archivePath);
  const sizeBytes = stats.size;
  const timestamp = new Date().toISOString();
  
  const registerContent = `# COSMO IP Register

**Copyright © 2025 Jason T. Regina. All Rights Reserved.**

---

## Snapshot Information

| Field | Value |
|-------|-------|
| **Snapshot Name** | ${TAG_NAME} |
| **Archive File** | ${ARCHIVE_NAME} |
| **Commit SHA** | \`${commitSha}\` |
| **SHA-256 Hash** | \`${hash}\` |
| **Date Created** | ${timestamp} |
| **Archive Size** | ${sizeBytes} bytes (${(sizeBytes / (1024 * 1024)).toFixed(2)} MB) |
| **Git Tag** | ${TAG_NAME} |
| **Repository** | COSMO - Autonomous AI Research System |

---

## Purpose

This snapshot serves as verifiable proof of authorship and content for:
- Provisional patent filings
- IP sale/licensing due diligence
- Legal defensibility

---

## Verification

### Verify Archive Integrity

\`\`\`bash
shasum -a 256 ${ARCHIVE_NAME}
\`\`\`

Expected output:
\`\`\`
${hash}  ${ARCHIVE_NAME}
\`\`\`

### Verify Git Tag

\`\`\`bash
git show ${TAG_NAME}
git rev-parse ${TAG_NAME}
\`\`\`

Expected commit SHA:
\`\`\`
${commitSha}
\`\`\`

### Restore Archive

\`\`\`bash
tar -xzf ${ARCHIVE_NAME}
\`\`\`

---

## Timestamping Instructions

### 1. Email Timestamp
Email this hash to yourself:
\`\`\`
${hash}
\`\`\`

Subject: COSMO IP Snapshot ${DATE} - SHA-256 Hash

### 2. Blockchain Timestamping (Optional)
Post the hash (NOT the file) to a blockchain timestamping service:
- [OpenTimestamps](https://opentimestamps.org)
- [WIPO Proof](https://wipoproof.wipo.int/)

### 3. Notarization
Convert this document to PDF and have it notarized with your IP attorney.

---

## Storage Instructions

1. Copy \`${ARCHIVE_NAME}\` and this register to **two offline media** (USB or SSD)
2. Keep one local, one off-site (bank box, attorney, or trusted relative)
3. Do **not** alter this repository copy afterward

---

## Legal Notes

- This snapshot matches the codebase state referenced in provisional patent filings
- The combination of git tag, archive hash, and timestamped register makes the codebase legally defensible
- Include the hash and commit ID in Information Disclosure Statement (IDS) when converting to non-provisional
- This register can be included in licensing packets for due diligence

---

**Generated:** ${timestamp}
**Copyright:** © 2025 Jason T. Regina. All Rights Reserved.

`;

  const registerPath = path.join(WORKSPACE_ROOT, REGISTER_NAME);
  fs.writeFileSync(registerPath, registerContent);
  
  console.log(`✅ Created IP register: ${REGISTER_NAME}\n`);
  
  return registerPath;
}

/**
 * Main execution
 */
async function main() {
  console.log('🔒 COSMO IP Snapshot Creation\n');
  console.log('='.repeat(50));
  console.log(`Date: ${DATE}`);
  console.log(`Tag: ${TAG_NAME}`);
  console.log('='.repeat(50));
  console.log();
  
  try {
    // Check git status
    await checkGitStatus();
    
    // Step 1: Create git tag
    await createGitTag();
    
    // Step 2: Export archive
    const archivePath = exportArchive();
    
    // Step 3: Generate hash
    const hash = generateHash(archivePath);
    
    // Step 4: Get commit SHA
    const commitSha = getCommitSha();
    
    // Step 5: Create register
    const registerPath = createIPRegister(archivePath, hash, commitSha);
    
    // Summary
    console.log('='.repeat(50));
    console.log('✅ IP Snapshot Complete!\n');
    console.log('Summary:');
    console.log(`  📌 Git Tag: ${TAG_NAME}`);
    console.log(`  📦 Archive: ${ARCHIVE_NAME}`);
    console.log(`  🔐 SHA-256: ${hash}`);
    console.log(`  📄 Register: ${REGISTER_NAME}`);
    console.log();
    console.log('Next Steps:');
    console.log('  1. Email the hash to yourself for timestamp');
    console.log('  2. Optionally timestamp hash on blockchain');
    console.log('  3. Convert register to PDF and notarize');
    console.log('  4. Store archive and register on offline media');
    console.log('  5. Keep one copy local, one off-site');
    console.log();
    
  } catch (error) {
    console.error('\n❌ Error creating IP snapshot:');
    console.error(error.message);
    process.exit(1);
  }
}

// Run if executed directly
if (require.main === module) {
  main();
}

module.exports = { main };

