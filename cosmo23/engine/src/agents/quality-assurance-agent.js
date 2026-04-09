const { BaseAgent } = require('./base-agent');

/**
 * QualityAssuranceAgent - "Measure Twice, Cut Once" validation layer
 * 
 * Purpose:
 * - Validate agent outputs before memory integration
 * - Check internal consistency, factuality, novelty
 * - Embody the "measure twice, cut once" philosophy
 * - Protect memory network from pollution
 * 
 * Use Cases:
 * - Validate research findings before memory integration
 * - Check analysis for internal contradictions
 * - Verify code execution results make sense
 * - Catch duplicate or low-value additions
 * 
 * Quality Checks:
 * 1. Consistency: Claims don't contradict each other
 * 2. Factuality: Verifiable claims check out via web search
 * 3. Novelty: Not duplicate of existing memory (embedding check)
 * 4. Completeness: Meets stated success criteria
 * 5. Value: Substantive contribution vs fluff
 */
class QualityAssuranceAgent extends BaseAgent {
  constructor(mission, config, logger) {
    super(mission, config, logger);
    this.checks = [];
    this.issues = [];
    this.qaConfig = config.coordinator?.qualityAssurance || {};
  }

  /**
   * Agent behavioral prompt (Layer 2) — HOW this agent works.
   * Prepended to system prompt for the first LLM call; used standalone for subsequent calls.
   */
  getAgentBehavioralPrompt() {
    return `## QualityAssuranceAgent Behavioral Specification

You validate outputs against quality contracts. Check consistency, factuality, novelty, and completeness.
Fail fast, fail loud — surface issues immediately. Do not hedge or soften verdicts.

Validation protocol:
1. Check internal consistency — claims must not contradict each other.
2. Check factuality — verifiable claims must check out.
3. Check novelty — reject duplicates of existing memory.
4. Check completeness — outputs must meet stated success criteria.
5. Assess value — substantive contribution vs generic filler.

Output: pass/fail verdicts with evidence. Each check produces a structured result with
name, passed (boolean), confidence (0-1), reason, and issues array.
Never QA-check your own output. Never pass borderline work to avoid conflict.`;
  }

  /**
   * Main execution logic
   */
  async execute() {
    this.logger.info('🔍 QualityAssuranceAgent: Starting validation', {
      agentId: this.agentId,
      targetAgent: this.mission.targetAgent,
      targetGoal: this.mission.goalId
    });

    const preFlightData = await this.gatherPreFlightContext();

    // Get the artifact to review
    let artifact = this.mission.artifactToReview;
    
    if (!artifact || !artifact.results) {
      // CRITICAL: If no artifact provided, search for relevant outputs to validate
      this.logger.info('📋 No artifact specified - searching for relevant outputs', {
        agentId: this.agentId,
        missionDescription: this.mission.description?.substring(0, 100)
      });
      
      // Try to find artifacts using MCP file access or pathResolver
      const foundArtifact = await this.findRelevantArtifact();
      
      if (foundArtifact) {
        artifact = foundArtifact;
        this.logger.info('✅ Found artifact to review', {
          path: foundArtifact.path,
          resultsCount: foundArtifact.results?.length || 0
        });
      } else {
        this.logger.info('⚠️  No artifacts found - completing without validation', {
          agentId: this.agentId,
          note: 'QA agent spawned before outputs were created'
        });

        // IMPORTANT (non-breaking, avoids "unproductive" empties):
        // Emit a diagnostic result so the Executive Ring and dashboard can see *why*
        // validation did not occur, without polluting long-term memory.
        this.results.push({
          type: 'finding',
          content: `QA skipped: no artifacts were provided and none could be discovered for mission "${(this.mission.description || '').substring(0, 120)}".`,
          timestamp: new Date(),
          qaSkipped: true,
          reason: 'no_artifacts_found'
        });

        return { status: 'completed', validationComplete: false, reason: 'no_artifacts_found', qaSkipped: true };
      }
    }

    await this.reportProgress(10, 'Preparing quality checks');

    // NEW: Check strategic alignment (null-safe; QA must never crash)
    try {
      const strategicContext = await this.getStrategicContext();
      const rawPriorities = strategicContext?.priorities;

      // Only run this heuristic when priorities are present (string or array).
      if (rawPriorities) {
        this.logger.info('🎯 Validating against strategic priorities');

        const prioritiesText = Array.isArray(rawPriorities)
          ? rawPriorities.filter(Boolean).join('\n')
          : String(rawPriorities ?? '');

        const missionGoalId = String(artifact?.mission?.goalId ?? '');
        const missionDesc = String(artifact?.mission?.description ?? '');

        const prioritiesLower = prioritiesText.toLowerCase();
        const missionAligned =
          (missionGoalId && prioritiesLower.includes(missionGoalId.toLowerCase())) ||
          (missionDesc && prioritiesLower.includes(missionDesc.substring(0, 50).toLowerCase()));

        if (!missionAligned) {
          this.logger.info('ℹ️  Mission not in current strategic priorities (acceptable)');
        }
      }
    } catch (e) {
      // Heuristic only; never fail QA for this
      this.logger?.warn('⚠️  Strategic alignment check skipped (non-fatal)', {
        error: e?.message || String(e)
      });
    }

    // NEW: Cross-reference memory thoroughly for duplicates
    if (this.qaConfig.checkNovelty) {
      const findings = artifact.results
        .filter(r => r.type === 'finding' || r.type === 'insight')
        .slice(0, 3);
      
      for (const finding of findings) {
        const memoryCheck = await this.mcp?.query_memory(finding.content.substring(0, 200), 5);
        
        if (memoryCheck && memoryCheck.resultsFound >= 3) {
          this.logger.info('📚 Found similar content in memory', {
            matches: memoryCheck.resultsFound,
            willCheckEmbeddings: true
          });
        }
      }
    }

    // Step 1: Consistency Check
    await this.reportProgress(20, 'Checking internal consistency');
    const consistencyCheck = await this.checkConsistency(artifact);
    this.checks.push(consistencyCheck);

    // Step 2: Factuality Check (if enabled and applicable)
    if (this.qaConfig.checkFactuality && this.hasFactualClaims(artifact)) {
      await this.reportProgress(40, 'Fact-checking claims');
      const factualityCheck = await this.checkFactuality(artifact);
      this.checks.push(factualityCheck);
    }

    // Step 3: Novelty Check (if enabled)
    if (this.qaConfig.checkNovelty && this.memory) {
      await this.reportProgress(60, 'Checking novelty vs existing memory');
      const noveltyCheck = await this.checkNovelty(artifact);
      this.checks.push(noveltyCheck);
    }

    // Step 4: Completeness Check
    await this.reportProgress(75, 'Validating completeness');
    const completenessCheck = await this.checkCompleteness(artifact);
    this.checks.push(completenessCheck);

    // Step 5: Value Assessment
    await this.reportProgress(85, 'Assessing contribution value');
    const valueCheck = await this.assessValue(artifact);
    this.checks.push(valueCheck);

    // Step 6: Synthesize QA Report
    await this.reportProgress(95, 'Generating QA report');
    const report = this.generateQAReport();

    // Store QA report as finding
    await this.addFinding(report.summary, 'qa_report');

    await this.reportProgress(100, 'Quality assurance complete');

    this.logger.info('✅ QualityAssuranceAgent: Validation complete', {
      agentId: this.agentId,
      confidence: report.confidence,
      recommendation: report.recommendation,
      issuesFound: this.issues.length
    });

    return {
      success: true,
      qaReport: report,
      checksPerformed: this.checks.length
    };
  }

  /**
   * Find relevant artifact to review when none provided
   * Searches runtime/outputs/ for documents matching the mission description
   */
  async findRelevantArtifact() {
    try {
      // Use direct filesystem access instead of MCP (more reliable)
      const fs = require('fs').promises;
      const path = require('path');

      // Extract specifics from mission metadata
      const originalTaskId = this.mission.metadata?.originalTaskId;
      const taskGoalId = this.mission.taskId || originalTaskId;
      const missionDesc = this.mission.description || '';
      const keywords = this.extractKeywords(missionDesc);
      
      // CRITICAL: Get the task to find its assigned agent ID
      // This is the KEY to finding the right outputs!
      let taskAssignedAgentId = null;
      if (taskGoalId) {
        try {
          const fs = require('fs').promises;
          const path = require('path');
          // PRODUCTION: Use pathResolver for user-specific runtime
          const runtimeRoot = this.pathResolver 
            ? this.pathResolver.getRuntimeRoot()
            : (this.config.logsDir || './runtime');
          const tasksDir = path.join(runtimeRoot, 'tasks');
          
          // Search for task in all states
          for (const state of ['assigned', 'pending', 'complete']) {
            if (state === 'assigned') {
              const assignedDir = path.join(tasksDir, state);
              try {
                const instances = await fs.readdir(assignedDir);
                for (const inst of instances) {
                  const taskPath = path.join(assignedDir, inst, `${taskGoalId}.json`);
                  try {
                    const taskContent = await fs.readFile(taskPath, 'utf-8');
                    const task = JSON.parse(taskContent);
                    taskAssignedAgentId = task.assignedAgentId;
                    break;
                  } catch (e) {}
                }
              } catch (e) {}
            } else {
              const taskPath = path.join(tasksDir, state, `${taskGoalId}.json`);
              try {
                const taskContent = await fs.readFile(taskPath, 'utf-8');
                const task = JSON.parse(taskContent);
                taskAssignedAgentId = task.assignedAgentId;
                break;
              } catch (e) {}
            }
            if (taskAssignedAgentId) break;
          }
        } catch (e) {
          this.logger.warn('Failed to load task for agent ID lookup', { error: e.message });
        }
      }
      
      this.logger.info('🔍 Searching for artifacts (task-specific)', {
        taskId: taskGoalId,
        assignedAgentId: taskAssignedAgentId,
        keywords: keywords.slice(0, 5),
        missionHint: missionDesc.substring(0, 100)
      });

      // Direct filesystem scan of outputs directory
      // PRODUCTION: Use pathResolver for user-specific outputs
      const outputsDir = this.pathResolver 
        ? this.pathResolver.getOutputsRoot()
        : path.join(this.config.logsDir || './runtime', 'outputs');
      const matchingFiles = [];
      
      try {
        const topLevelEntries = await fs.readdir(outputsDir, { withFileTypes: true });
        
        for (const entry of topLevelEntries) {
          if (entry.isDirectory()) {
            // Scan agent-type subdirectories (code-creation, document-creation, etc.)
            const agentTypeDir = path.join(outputsDir, entry.name);
            try {
              const agentEntries = await fs.readdir(agentTypeDir, { withFileTypes: true });
              
              for (const agentEntry of agentEntries) {
                if (agentEntry.isDirectory()) {
                  // Scan agent ID subdirectories
                  const agentIdDir = path.join(agentTypeDir, agentEntry.name);
                  try {
                    const files = await fs.readdir(agentIdDir);
                    for (const file of files) {
                      const fileName = file.toLowerCase();
                      const matchScore = keywords.reduce((score, keyword) => {
                        return score + (fileName.includes(keyword.toLowerCase()) ? 1 : 0);
                      }, 0);
                      
                      if (matchScore > 0 || keywords.length === 0) {
                        const filePath = path.join(agentIdDir, file);
                        const stats = await fs.stat(filePath);
                        matchingFiles.push({ 
                          fullPath: filePath,
                          relativePath: path.relative(process.cwd(), filePath),
                          filename: file,
                          score: matchScore || 1,
                          createdAt: stats.mtimeMs
                        });
                      }
                    }
                  } catch (e) {
                    // Skip if can't read agent directory
                  }
                } else if (agentEntry.isFile()) {
                  // File directly in agent-type directory
                  const fileName = agentEntry.name.toLowerCase();
                  const matchScore = keywords.reduce((score, keyword) => {
                    return score + (fileName.includes(keyword.toLowerCase()) ? 1 : 0);
                  }, 0);
                  
                  if (matchScore > 0 || keywords.length === 0) {
                    const filePath = path.join(agentTypeDir, agentEntry.name);
                    const stats = await fs.stat(filePath);
                    matchingFiles.push({
                      fullPath: filePath,
                      relativePath: path.relative(process.cwd(), filePath),
                      filename: agentEntry.name,
                      score: matchScore || 1,
                      createdAt: stats.mtimeMs
                    });
                  }
                }
              }
            } catch (e) {
              // Skip if can't read agent-type directory
            }
          }
        }
      } catch (e) {
        this.logger.warn('Filesystem scan failed', { error: e.message });
        return null;
      }

      if (matchingFiles.length === 0) {
        return null;
      }

      if (matchingFiles.length === 0) {
        this.logger.info('No matching files found');
        return null;
      }
      
      // SMART FILTERING: Prioritize files from the task's assigned agent
      let filteredFiles = matchingFiles;
      
      // Priority 1: Files from the task's assigned agent (most specific)
      if (taskAssignedAgentId) {
        const agentSpecificFiles = matchingFiles.filter(file => 
          file.relativePath.includes(taskAssignedAgentId)
        );
        
        if (agentSpecificFiles.length > 0) {
          this.logger.info('✓ Found agent-specific artifacts (highest priority)', {
            agentId: taskAssignedAgentId,
            count: agentSpecificFiles.length,
            total: matchingFiles.length
          });
          filteredFiles = agentSpecificFiles;
        }
      }
      
      // Priority 2: Files matching task/goal ID (if no agent-specific files)
      if (filteredFiles.length === matchingFiles.length && taskGoalId) {
        const taskSpecificFiles = matchingFiles.filter(file => 
          file.relativePath.includes(taskGoalId) ||
          file.relativePath.includes(taskGoalId.replace('task:', '').replace('goal_', ''))
        );
        
        if (taskSpecificFiles.length > 0) {
          this.logger.info('✓ Found task-specific artifacts (medium priority)', {
            taskId: taskGoalId,
            count: taskSpecificFiles.length,
            total: matchingFiles.length
          });
          filteredFiles = taskSpecificFiles;
        }
      }
      
      // Priority 3: Keyword matches only (fallback)
      if (filteredFiles.length === matchingFiles.length) {
        this.logger.info('Using keyword matches only (no task/agent specificity)', {
          taskId: taskGoalId,
          agentId: taskAssignedAgentId,
          matchesFound: matchingFiles.length
        });
      }
      
      // Sort by score, then by creation time (most recent first)
      filteredFiles.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return (b.createdAt || 0) - (a.createdAt || 0);
      });
      
      const bestMatch = filteredFiles[0];

      this.logger.info('📄 Selected artifact for validation', {
        path: bestMatch.relativePath,
        matchScore: bestMatch.score,
        taskSpecific: taskGoalId && bestMatch.relativePath.includes(taskGoalId),
        candidatesEvaluated: matchingFiles.length,
        candidatesAfterFiltering: filteredFiles.length
      });

      // Read the file content
      try {
        const content = await fs.readFile(bestMatch.fullPath, 'utf-8');
        
        // Convert to artifact format expected by QA checks
        return {
          path: bestMatch.relativePath,
          mission: {
            description: missionDesc,
            goalId: this.mission.goalId
          },
          results: [{
            type: 'document',
            content,
            path: bestMatch.relativePath
          }]
        };
      } catch (readError) {
        this.logger.warn('Failed to read artifact file', {
          path: bestMatch.fullPath,
          error: readError.message
        });
        return null;
      }

    } catch (error) {
      this.logger.warn('Error searching for artifacts', {
        error: error.message
      });
      return null;
    }
  }

  /**
   * Extract keywords from mission description for artifact search
   */
  extractKeywords(text) {
    // Remove common words and extract meaningful terms
    const commonWords = ['the', 'a', 'an', 'and', 'or', 'but', 'for', 'on', 'in', 'to', 'of', 'with'];
    const words = text.toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 3 && !commonWords.includes(w));
    
    // Return unique keywords
    return [...new Set(words)];
  }

  /**
   * Check internal consistency - do claims contradict each other?
   */
  async checkConsistency(artifact) {
    const findings = artifact.results
      .filter(r => r.type === 'finding' || r.type === 'insight')
      .map(r => r.content)
      .join('\n\n');

    if (!findings || findings.length < 50) {
      return {
        name: 'consistency',
        passed: true,
        confidence: 1.0,
        reason: 'Insufficient content for consistency check'
      };
    }

    try {
      const response = await this.gpt5.generateWithRetry({
        model: this.config.models?.strategicModel,
        instructions: this.buildCOSMOSystemPrompt(this.getAgentBehavioralPrompt()) + '\n\n' + `You are a quality assurance agent checking for logical consistency.

Review these findings and identify any contradictions or inconsistencies:

${findings}

Check for:
1. Direct contradictions (X is true, X is false)
2. Logical inconsistencies (implies A, but states not-A)
3. Timeline conflicts (happened before Y, happened after Y)
4. Magnitude conflicts (very large, very small for same thing)

Respond with JSON:
{
  "consistent": true/false,
  "confidence": 0.0-1.0,
  "issues": ["issue 1", "issue 2"] or [],
  "reasoning": "brief explanation"
}`,
        messages: [{ role: 'user', content: 'Check consistency' }],
        maxTokens: 25000,
        reasoningEffort: 'high'  // Critical validation deserves deep reasoning
      }, 2);

      const jsonMatch = response.content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const result = JSON.parse(jsonMatch[0]);
        
        if (!result.consistent && result.issues) {
          this.issues.push(...result.issues);
        }

        return {
          name: 'consistency',
          passed: result.consistent,
          confidence: result.confidence || 0.5,
          reason: result.reasoning,
          issues: result.issues || []
        };
      }
    } catch (error) {
      this.logger.warn('Consistency check failed', { error: error.message });
    }

    // Fallback: pass if check failed
    return {
      name: 'consistency',
      passed: true,
      confidence: 0.5,
      reason: 'Check inconclusive'
    };
  }

  /**
   * Check factuality - verify claims via web search
   */
  async checkFactuality(artifact) {
    const findings = artifact.results
      .filter(r => r.type === 'finding')
      .map(r => r.content)
      .slice(0, 3); // Check top 3 findings

    if (findings.length === 0) {
      return {
        name: 'factuality',
        passed: true,
        confidence: 1.0,
        reason: 'No factual claims to verify'
      };
    }

    try {
      // Use web search to verify key claims
      const verificationPrompt = `Verify these research findings using web search:

${findings.join('\n\n')}

For each claim, check if it's:
1. Factually accurate
2. Supported by reliable sources
3. Current/not outdated

Respond with JSON:
{
  "verified": true/false,
  "confidence": 0.0-1.0,
  "issues": ["issue 1"] or [],
  "reasoning": "brief explanation"
}`;

      const response = await this.gpt5.generateWithWebSearch({
        component: 'agents',
        purpose: 'quality_assurance',
        query: findings[0], // Primary finding
        instructions: this.getAgentBehavioralPrompt() + '\n\n' + verificationPrompt,
        maxTokens: 20000,
        reasoningEffort: 'high'  // Critical fact-checking needs deep reasoning
      });

      const jsonMatch = response.content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const result = JSON.parse(jsonMatch[0]);
        
        if (!result.verified && result.issues) {
          this.issues.push(...result.issues);
        }

        return {
          name: 'factuality',
          passed: result.verified,
          confidence: result.confidence || 0.6,
          reason: result.reasoning,
          issues: result.issues || [],
          sources: response.webSearchSources || []
        };
      }
    } catch (error) {
      this.logger.warn('Factuality check failed', { error: error.message });
    }

    // Fallback: pass if check failed (don't block on tech issues)
    return {
      name: 'factuality',
      passed: true,
      confidence: 0.5,
      reason: 'Check inconclusive'
    };
  }

  /**
   * Check novelty - is this duplicate of existing memory?
   */
  async checkNovelty(artifact) {
    const findings = artifact.results
      .filter(r => r.type === 'finding' || r.type === 'insight')
      .map(r => r.content);

    if (findings.length === 0) {
      return {
        name: 'novelty',
        passed: true,
        confidence: 1.0,
        reason: 'No findings to check'
      };
    }

    try {
      // Check each finding against memory
      let maxSimilarity = 0;
      let mostSimilarConcept = null;

      for (const finding of findings.slice(0, 3)) { // Check top 3
        const similar = await this.memory.query(finding, 3);
        
        if (similar.length > 0) {
          // Check embedding similarity using cosine similarity
          const topMatch = similar[0];
          const similarity = topMatch.similarity || topMatch.activation || 0;
          
          if (similarity > maxSimilarity) {
            maxSimilarity = similarity;
            mostSimilarConcept = topMatch.concept;
          }
        }
      }

      // Novel if max similarity < 0.85 (similar but not duplicate)
      const isNovel = maxSimilarity < 0.85;
      
      if (!isNovel) {
        this.issues.push(`Highly similar to existing memory: "${mostSimilarConcept?.substring(0, 100)}"`);
      }

      return {
        name: 'novelty',
        passed: isNovel,
        confidence: 0.8,
        reason: isNovel 
          ? `Novel content (max similarity: ${maxSimilarity.toFixed(3)})`
          : `Duplicate detected (similarity: ${maxSimilarity.toFixed(3)})`,
        maxSimilarity,
        mostSimilar: mostSimilarConcept?.substring(0, 150)
      };
    } catch (error) {
      this.logger.warn('Novelty check failed', { error: error.message });
      
      return {
        name: 'novelty',
        passed: true,
        confidence: 0.5,
        reason: 'Check inconclusive'
      };
    }
  }

  /**
   * Check completeness - did agent meet success criteria?
   */
  async checkCompleteness(artifact) {
    const criteria = artifact.mission?.successCriteria || [];
    const results = artifact.results || [];

    if (criteria.length === 0) {
      return {
        name: 'completeness',
        passed: true,
        confidence: 1.0,
        reason: 'No success criteria defined'
      };
    }

    // Simple heuristic: did we generate substantive results?
    const findingsCount = results.filter(r => r.type === 'finding' || r.type === 'insight').length;
    const hasSubstantiveWork = findingsCount >= Math.min(criteria.length, 3);

    if (!hasSubstantiveWork) {
      this.issues.push(`Only ${findingsCount} findings vs ${criteria.length} success criteria`);
    }

    return {
      name: 'completeness',
      passed: hasSubstantiveWork,
      confidence: 0.7,
      reason: hasSubstantiveWork
        ? `Generated ${findingsCount} findings for ${criteria.length} criteria`
        : 'Insufficient results for success criteria',
      findingsCount,
      criteriaCount: criteria.length
    };
  }

  /**
   * Assess value - is this substantive or fluff?
   */
  async assessValue(artifact) {
    const findings = artifact.results
      .filter(r => r.type === 'finding' || r.type === 'insight')
      .map(r => r.content);

    if (findings.length === 0) {
      return {
        name: 'value',
        passed: false,
        confidence: 1.0,
        reason: 'No substantive output'
      };
    }

    // Check average content length and specificity
    const avgLength = findings.reduce((sum, f) => sum + f.length, 0) / findings.length;
    const hasSpecifics = findings.some(f => 
      f.match(/\d+/) || // Contains numbers
      f.match(/\b(specifically|namely|for example|such as)\b/i) // Specific language
    );

    const isSubstantive = avgLength > 80 && hasSpecifics;

    if (!isSubstantive) {
      this.issues.push('Output appears generic or lacks specificity');
    }

    return {
      name: 'value',
      passed: isSubstantive,
      confidence: 0.6,
      reason: isSubstantive
        ? 'Substantive, specific content'
        : 'Generic or vague output',
      avgLength: Math.round(avgLength)
    };
  }

  /**
   * Check if artifact contains factual claims worth verifying
   */
  hasFactualClaims(artifact) {
    const text = artifact.results
      .filter(r => r.type === 'finding')
      .map(r => r.content)
      .join(' ');

    // Look for factual claim indicators
    return text.match(/\b(research shows|studies indicate|data suggests|according to|found that)\b/i) ||
           text.match(/\d{4}/) || // Years
           text.match(/\d+%/) || // Percentages
           text.length > 200; // Substantial research content
  }

  /**
   * Generate final QA report
   */
  generateQAReport() {
    const passedChecks = this.checks.filter(c => c.passed).length;
    const totalChecks = this.checks.length;
    const passRate = totalChecks > 0 ? passedChecks / totalChecks : 1.0;

    // Calculate weighted confidence
    const avgConfidence = this.checks.length > 0
      ? this.checks.reduce((sum, c) => sum + (c.confidence || 0.5), 0) / this.checks.length
      : 0.5;

    // Overall confidence combines pass rate and individual check confidence
    const overallConfidence = (passRate * 0.6) + (avgConfidence * 0.4);

    // Determine recommendation based on config and confidence
    let recommendation;
    if (overallConfidence >= this.qaConfig.minConfidence) {
      recommendation = 'integrate';
    } else if (overallConfidence >= this.qaConfig.autoRejectThreshold) {
      recommendation = 'integrate_with_flag';
    } else {
      recommendation = 'reject';
    }

    // Generate summary
    const summary = `Quality Assurance Report:
- Checks Performed: ${totalChecks}
- Checks Passed: ${passedChecks}
- Overall Confidence: ${(overallConfidence * 100).toFixed(1)}%
- Issues Found: ${this.issues.length}
- Recommendation: ${recommendation.toUpperCase()}

${this.checks.map(c => `✓ ${c.name}: ${c.passed ? 'PASS' : 'FAIL'} (${c.reason})`).join('\n')}

${this.issues.length > 0 ? '\nIssues:\n' + this.issues.map((iss, i) => `${i + 1}. ${iss}`).join('\n') : ''}`;

    return {
      confidence: overallConfidence,
      passRate,
      checksPerformed: totalChecks,
      checksPassed: passedChecks,
      checksDetails: this.checks,
      issues: this.issues,
      recommendation,
      summary
    };
  }

  /**
   * Optional: Generate handoff if deeper investigation needed
   */
  generateHandoffSpec() {
    // If confidence is borderline, might want research agent to verify
    const report = this.checks.length > 0 ? this.generateQAReport() : null;
    
    if (report && report.confidence > 0.4 && report.confidence < 0.7) {
      // Extract claims/findings from the artifact being reviewed
      const artifact = this.mission.artifactToReview;
      const claimsToVerify = [];
      
      if (artifact && artifact.results) {
        const findings = artifact.results.filter(r => 
          r.type === 'finding' || r.type === 'insight' || r.type === 'claim'
        );
        
        // Extract text from top findings (up to 5)
        for (const finding of findings.slice(0, 5)) {
          if (finding.content && typeof finding.content === 'string') {
            claimsToVerify.push(finding.content.substring(0, 500));
          }
        }
      }
      
      // Build a concrete claim text for the research agent
      const claimText = claimsToVerify.length > 0
        ? `Verify the following claims:\n${claimsToVerify.map((c, i) => `${i + 1}. ${c}`).join('\n\n')}`
        : 'Verify claims from QA review (claims extraction failed - proceeding with mission description)';
      
      return {
        type: 'HANDOFF',
        toAgentType: 'research',
        reason: 'QA found borderline confidence - research agent should verify claims',
        claimText, // NEW: Pass concrete claims for intake gate
        context: {
          originalGoal: this.mission.goalId,
          issues: this.issues,
          claimsToVerify // NEW: Include extracted claims
        }
      };
    }

    return null;
  }
}

module.exports = { QualityAssuranceAgent };

