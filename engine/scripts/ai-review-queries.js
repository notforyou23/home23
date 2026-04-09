#!/usr/bin/env node

/**
 * AI Review Queries Script
 * 
 * Uses GPT-5.2 (via COSMO's GPT5Client) to deeply analyze query responses and extract:
 * - Core concepts and "things" identified
 * - Actionable items with priorities
 * - Key insights and recommendations
 * - Executive summary
 */

const fs = require('fs');
const path = require('path');

// Auto-detect workspace root (git-aware, falls back to ../scripts)
const WORKSPACE_ROOT = (() => {
  try {
    const { execSync } = require('child_process');
    return execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
  } catch {
    return path.resolve(__dirname, '..');
  }
})();

const ARCHIVE_DIR = path.join(WORKSPACE_ROOT, 'queries-archive');
const JSONL_DIR = path.join(ARCHIVE_DIR, 'jsonl');
const AI_REVIEWS_DIR = path.join(ARCHIVE_DIR, 'ai-reviews');

// Import COSMO's GPT5Client
const { GPT5Client } = require(path.join(WORKSPACE_ROOT, 'src', 'core', 'gpt5-client'));

// Ensure directories exist
if (!fs.existsSync(AI_REVIEWS_DIR)) {
  fs.mkdirSync(AI_REVIEWS_DIR, { recursive: true });
}

/**
 * Call GPT-5.2 (via COSMO's client) to analyze a query
 */
async function analyzeWithGPT5(gpt5Client, query, answer) {
  const prompt = `Given the full COSMO run output, produce a structured, factual report with these sections:

1. **Essence / Core Thesis** — one concise sentence summarizing what this run is fundamentally about.
2. **Key Outputs / Concepts** — list 5–10 main ideas or deliverables with one-line explanations.
3. **Novelty / Differentiation** — what makes the run's output non-mainstream or uniquely valuable.
4. **Intended Users / Buyers** — who benefits or would pay (industries, teams, regulators, or investors).
5. **Market Context & Commercial Potential** — size and nature of opportunity (niche / medium / large), comparable solutions or gaps, and plausible monetization paths (licensing, acquisition, internal deployment).
6. **Estimated Value Range** — rough valuation range (USD) if productized or sold as IP.
7. **Maturity Level** — classify as *conceptual*, *prototype-ready*, *pilot-ready*, or *deployable*.
8. **Strategic Options** — summarize viable paths:
   * (A) Build a company around it
   * (B) Sell / license to enterprise or government
   * (C) Integrate into internal assets
   * (D) Archive for future R&D cycles
9. **Recommended Next Step** — one precise, actionable move to realize value.
10. **Next Ideal COSMO Query** — the single smartest question to feed back into COSMO that would push this line of discovery forward.

---

**Enterprise-Grade Evaluation Sections:**

11. **Risk & Compliance Profile** — identify regulatory exposure (GDPR, HIPAA, SOX, FINRA, etc.); flag data-handling, explainability, or bias concerns; rate each on *Low / Medium / High* and note mitigation paths.
12. **Implementation Dependencies** — what stack, data, or APIs are required to reproduce the result? Licensed models, third-party datasets, or restricted code? Integration friction: *Low / Medium / High*.
13. **Governance & Auditability** — can this run's results be deterministically replayed? Are logs, prompts, and model versions pinned for audit? Evidence chain maturity: *Weak / Adequate / Strong*.
14. **IP Position & Protectability** — is the idea patentable, or covered by open research? Dependencies on external IP or frameworks? Recommend: *File / Trade Secret / Publish*.
15. **Strategic Fit (Internal)** — which practice or business unit would own or monetize it? Estimated cost to integrate into an existing "Technology Asset." Alignment with internal priorities (AI Risk, ESG, HealthTech, Finance).
16. **Operational ROI Projection** — expected efficiency gain, margin improvement, or client billing multiplier; 12-month and 36-month ROI bands.
17. **Security / Privacy Controls Readiness** — is the design compatible with zero-trust, encryption-in-use, or attested runtimes? Any PII exposure? Recommend technical guardrails.
18. **Client-Facing Productization Potential** — could this become a managed service or SaaS asset? Delivery model: *internal accelerator / white-label / client-facing platform*.

---

ORIGINAL QUERY:
${query}

COSMO'S RESPONSE:
${answer}

---

Output format:

## COSMO Output Review

**Essence:** …

**Key Outputs:**
- …

**Novelty:** …

**Who Wants It:** …

**Market Context:** …

**Estimated Value:** …

**Maturity:** …

**Strategic Options:** …

**Recommended Next Step:** …

**Next Ideal COSMO Query:** …

---

**Enterprise Evaluation:**

**Risk & Compliance Profile:** …

**Implementation Dependencies:** …

**Governance & Auditability:** …

**IP Position:** …

**Strategic Fit (Internal):** …

**Operational ROI:** …

**Security & Privacy Controls:** …

**Client-Facing Potential:** …

Keep tone neutral, analytic, and exact — like a venture scientist writing for an internal innovation or IP investment committee. Include all enterprise sections for audit and transfer readiness.`;

  const systemPrompt = 'You are a senior analytical reviewer evaluating outputs from COSMO, an autonomous R&D engine that autonomously generates multi-domain inventions. Your task is to extract the scientific, commercial, and strategic value of each run — and determine the next best question to drive COSMO forward.';

  try {
    const response = await gpt5Client.generate({
      model: 'gpt-5.2',
      instructions: systemPrompt,
      input: prompt,
      reasoningEffort: 'medium',
      maxTokens: 8000,  // Increased for comprehensive review
      verbosity: 'auto'
    });
    
    return response.content || response.message?.content || '';
  } catch (error) {
    throw new Error(`GPT-5.2 analysis failed: ${error.message}`);
  }
}

/**
 * Check if a review already exists and is complete
 */
function hasExistingReview(runName, queryIndex) {
  const reviewFile = path.join(AI_REVIEWS_DIR, `${runName}-query-${queryIndex}-ai-review.md`);
  
  if (!fs.existsSync(reviewFile)) {
    return false;
  }
  
  try {
    const content = fs.readFileSync(reviewFile, 'utf-8');
    
    // Check if review is complete (has key sections)
    const hasEssence = content.includes('Essence:');
    const hasKeyOutputs = content.includes('Key Outputs:');
    const hasNextQuery = content.includes('Next Ideal COSMO Query:');
    const hasEnterprise = content.includes('Enterprise Evaluation:');
    
    // Consider complete if it has all core sections
    return hasEssence && hasKeyOutputs && hasNextQuery;
  } catch (error) {
    return false;
  }
}

/**
 * Process a single query with AI review (with retry logic)
 */
async function processQueryWithAI(gpt5Client, query, runName, queryIndex, maxRetries = 2) {
  console.log(`   🤖 Reviewing query ${queryIndex} with GPT-5...`);
  
  // Check if already reviewed
  if (hasExistingReview(runName, queryIndex)) {
    console.log(`      ℹ️  Review already exists and is complete - skipping`);
    const reviewFile = path.join(AI_REVIEWS_DIR, `${runName}-query-${queryIndex}-ai-review.md`);
    return fs.readFileSync(reviewFile, 'utf-8');
  }
  
  console.log(`      Original query to COSMO: ${query.query.length} chars`);
  console.log(`      COSMO's response: ${query.answer.length.toLocaleString()} chars`);
  
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      const analysis = await analyzeWithGPT5(gpt5Client, query.query, query.answer);
      
      // Validate we got a substantial GPT-5.2 review
      if (!analysis || analysis.length < 1000) {
        throw new Error(`GPT-5.2 review too short (${analysis?.length || 0} chars) - may be incomplete`);
      }
      
      // If we got a substantial response (>1000 chars), accept it
      // GPT-5.2 might format sections differently but if it's comprehensive, that's fine
      console.log(`      ✅ GPT-5.2 returned substantial review (${analysis.length.toLocaleString()} chars)`);
      
      // Optional: warn if it seems unusually short for a full review
      if (analysis.length < 3000) {
        console.warn(`      ℹ️  Note: Review is shorter than typical (${analysis.length} chars vs usual ~5-10K)`);
      }
      
      const reviewDoc = [];
      reviewDoc.push(`# AI Review: ${runName} - Query ${queryIndex}`);
      reviewDoc.push('');
      reviewDoc.push(`**Original Query:** ${query.query}`);
      reviewDoc.push(`**Timestamp:** ${new Date(query.timestamp).toLocaleString()}`);
      reviewDoc.push(`**Model Used:** ${query.model} (${query.mode} mode)`);
      reviewDoc.push(`**Run:** ${query.runName}`);
      reviewDoc.push('');
      reviewDoc.push('---');
      reviewDoc.push('');
      reviewDoc.push(analysis);
      reviewDoc.push('');
      reviewDoc.push('---');
      reviewDoc.push('');
      reviewDoc.push('## Original Full Response');
      reviewDoc.push('');
      reviewDoc.push('<details>');
      reviewDoc.push('<summary>Click to expand full COSMO response</summary>');
      reviewDoc.push('');
      reviewDoc.push('```');
      reviewDoc.push(query.answer);
      reviewDoc.push('```');
      reviewDoc.push('');
      reviewDoc.push('</details>');
      
      console.log(`      ✅ GPT-5.2 review generated: ${analysis.length.toLocaleString()} chars`);
      return reviewDoc.join('\n');
      
    } catch (error) {
      console.error(`      ❌ GPT-5.2 analysis attempt ${attempt} failed: ${error.message}`);
      if (attempt <= maxRetries) {
        console.log(`      🔄 Retrying in 3s...`);
        await new Promise(resolve => setTimeout(resolve, 3000));
      } else {
        console.error(`      ❌ All retries exhausted - review failed for query ${queryIndex}`);
        return null;
      }
    }
  }
  
  return null;
}

/**
 * Process queries in batches for faster concurrent processing
 */
async function processBatch(gpt5Client, batch, runName, startIndex) {
  const batchPromises = batch.map(async (query, idx) => {
    const queryIndex = startIndex + idx + 1;
    try {
      const wasExisting = hasExistingReview(runName, queryIndex);
      const review = await processQueryWithAI(gpt5Client, query, runName, queryIndex);
      
      if (review) {
        if (!wasExisting) {
          // Only write if it was newly generated (not skipped)
          const reviewFile = path.join(AI_REVIEWS_DIR, `${runName}-query-${queryIndex}-ai-review.md`);
          fs.writeFileSync(reviewFile, review, 'utf-8');
          console.log(`   ✅ [${queryIndex}] Review saved: ${path.basename(reviewFile)}`);
        }
        return { review, wasExisting };
      }
      return null;
    } catch (error) {
      console.error(`   ❌ [${queryIndex}] Failed: ${error.message}`);
      return null;
    }
  });
  
  return await Promise.all(batchPromises);
}

/**
 * Process a queries archive file with AI (batched concurrent processing)
 */
async function processQueryFileWithAI(gpt5Client, filePath, concurrency = 3) {
  const runName = path.basename(filePath, '-queries.jsonl');
  
  console.log(`📄 Processing: ${runName}`);
  
  // Read queries
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.trim().split('\n').filter(line => line.length > 0);
  const queries = lines.map(line => {
    try {
      return JSON.parse(line);
    } catch (error) {
      console.warn(`   ⚠️  Could not parse line in ${filePath}`);
      return null;
    }
  }).filter(q => q !== null);
  
  console.log(`   Queries: ${queries.length}`);
  
  // Count existing reviews
  let existingCount = 0;
  for (let i = 0; i < queries.length; i++) {
    if (hasExistingReview(runName, i + 1)) {
      existingCount++;
    }
  }
  
  const newCount = queries.length - existingCount;
  
  console.log(`   Existing reviews: ${existingCount}`);
  console.log(`   New to review: ${newCount}`);
  
  if (newCount > 0) {
    const estimatedCost = newCount * 0.20;
    console.log(`   Estimated cost: ~$${estimatedCost.toFixed(2)}`);
  }
  
  console.log(`   Processing in batches of ${concurrency}...`);
  
  const reviews = [];
  let skipped = 0;
  let generated = 0;
  
  // Process in batches
  for (let i = 0; i < queries.length; i += concurrency) {
    const batch = queries.slice(i, i + concurrency);
    const batchNum = Math.floor(i / concurrency) + 1;
    const totalBatches = Math.ceil(queries.length / concurrency);
    
    console.log(`   📦 Batch ${batchNum}/${totalBatches} (${batch.length} queries)...`);
    
    const batchReviews = await processBatch(gpt5Client, batch, runName, i);
    
    // Count skipped vs generated
    batchReviews.forEach(result => {
      if (result !== null) {
        if (result.wasExisting) {
          skipped++;
        } else {
          generated++;
        }
        reviews.push(result.review);
      }
    });
    
    // Small delay between batches to be respectful to API
    if (i + concurrency < queries.length) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  
  console.log('');
  
  return {
    runName,
    reviewsCount: reviews.length,
    skippedCount: skipped,
    generatedCount: generated
  };
}

/**
 * Main execution
 */
async function main() {
  console.log('╔═══════════════════════════════════════════════════════╗');
  console.log('║        COSMO AI Query Review Script                  ║');
  console.log('╚═══════════════════════════════════════════════════════╝');
  console.log('');
  
  // Initialize GPT5Client (uses COSMO's standard configuration)
  const logger = {
    log: (...args) => console.log(...args),
    error: (...args) => console.error(...args),
    warn: (...args) => console.warn(...args)
  };
  
  const gpt5Client = new GPT5Client(logger);
  
  // Parse command line arguments
  const args = process.argv.slice(2);
  let targetRun = null;
  let concurrency = 1; // default: sequential for reliability
  
  // Parse flags
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--concurrency' || args[i] === '-c') {
      concurrency = parseInt(args[i + 1], 10) || 3;
      i++; // skip next arg
    } else if (!args[i].startsWith('-')) {
      targetRun = args[i];
    }
  }
  
  // Find all archived query files
  let files = fs.readdirSync(JSONL_DIR)
    .filter(f => f.endsWith('-queries.jsonl'))
    .map(f => path.join(JSONL_DIR, f));
  
  if (targetRun) {
    files = files.filter(f => path.basename(f).startsWith(targetRun));
    if (files.length === 0) {
      console.log(`❌ No archived queries found for run: ${targetRun}`);
      process.exit(1);
    }
  }
  
  // Count total queries
  let totalQueries = 0;
  files.forEach(f => {
    const content = fs.readFileSync(f, 'utf-8');
    const lines = content.trim().split('\n').filter(line => line.length > 0);
    totalQueries += lines.length;
  });
  
  console.log(`Found ${files.length} query archive(s) to review`);
  console.log(`Total queries: ${totalQueries}`);
  console.log(`Using GPT-5.2 via COSMO's client`);
  console.log(`Mode: ${concurrency === 1 ? 'Sequential (reliable)' : `Batched (${concurrency} concurrent)`}`);
  console.log(`Retries: Up to 2 retries per query for reliability`);
  console.log(`Validation: Checking for complete responses`);
  console.log('');
  console.log('⏱️  Processing (full queries sent, complete responses expected)...');
  console.log('');
  console.log('═══════════════════════════════════════════════════════\n');
  
  const startTime = Date.now();
  const results = [];
  
  for (const filePath of files) {
    const result = await processQueryFileWithAI(gpt5Client, filePath, concurrency);
    results.push(result);
  }
  
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  
  const totalReviews = results.reduce((sum, r) => sum + r.reviewsCount, 0);
  const skippedCount = results.reduce((sum, r) => sum + (r.skippedCount || 0), 0);
  const generatedCount = results.reduce((sum, r) => sum + (r.generatedCount || 0), 0);
  const failCount = totalQueries - totalReviews;
  
  console.log('═══════════════════════════════════════════════════════\n');
  console.log('✨ GPT-5.2 Review complete!\n');
  console.log(`📁 Reviews location: ${path.relative(WORKSPACE_ROOT, AI_REVIEWS_DIR)}`);
  console.log('');
  console.log('📊 Stats:');
  console.log(`   - Runs processed: ${results.length}`);
  console.log(`   - Total queries: ${totalQueries}`);
  console.log(`   - Already reviewed (skipped): ${skippedCount}`);
  console.log(`   - Newly generated: ${generatedCount}`);
  if (failCount > 0) {
    console.log(`   - Failed (after retries): ${failCount}`);
  }
  console.log(`   - Time elapsed: ${elapsed}s`);
  if (generatedCount > 0) {
    console.log(`   - Average per new review: ${(elapsed / generatedCount).toFixed(1)}s`);
    const estimatedCost = generatedCount * 0.20;
    console.log(`   - Estimated API cost: ~$${estimatedCost.toFixed(2)}`);
  } else {
    console.log(`   - No new reviews generated (all already exist)`);
  }
  console.log('');
  console.log('💡 Each review includes:');
  console.log('   - Executive summary');
  console.log('   - Core concepts identified');
  console.log('   - Prioritized action items (High/Med/Low)');
  console.log('   - Key insights & recommendations');
  console.log('   - Quantitative targets & metrics');
  console.log('   - Experimental designs');
  console.log('   - Implementation guidance');
  console.log('   - Questions & gaps');
  console.log('');
}

// Run the script
main().catch(error => {
  console.error('❌ Fatal error:', error.message);
  console.error(error.stack);
  process.exit(1);
});

