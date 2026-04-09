const { BaseAgent } = require('./base-agent');
const { ValidationManager } = require('../core/validation-manager');
const { cosmoEvents } = require('../realtime/event-emitter');
const fs = require('fs').promises;
const path = require('path');

/**
 * CodeExecutionAgent - Specialist for computational experiments and validation
 * 
 * Capabilities:
 * - Run Python code in isolated containers
 * - Data analysis and statistical computations
 * - Algorithm testing and validation
 * - Visualization generation
 * - Empirical hypothesis testing
 * 
 * Lifecycle:
 * 1. Create container on start
 * 2. Plan computational experiments
 * 3. Execute code and gather results
 * 4. Interpret results and extract insights
 * 5. Cleanup container on completion/error/timeout
 */
class CodeExecutionAgent extends BaseAgent {
  constructor(mission, config, logger) {
    super(mission, config, logger);
    // Execution backend for code execution (container or local)
    this.executionBackend = this.createExecutionBackend();
    // Keep containerId for backward compatibility
    this.containerId = null;
    this.executionResults = [];
    this.generatedFiles = [];
    
    // Initialize validation manager for persistent tracking across runs
    const runtimeDir = path.join(__dirname, '..', '..', 'runtime');
    this.validationManager = new ValidationManager(runtimeDir, logger);
  }
  
  /**
   * Create execution backend based on config
   * Defaults to container for backward compatibility
   */
  createExecutionBackend() {
    const backendType = this.config?.execution?.backend || 
                        this.config?.architecture?.codeExecution?.backend || 
                        'local'; // Default to local for testing (can change back to container if issues)
    
    if (backendType === 'local') {
      const { LocalPythonBackend } = require('./execution/execution-backend');
      return new LocalPythonBackend(this.config, this.logger, this.gpt5);
    } else {
      const { ContainerBackend } = require('./execution/execution-backend');
      return new ContainerBackend(this.gpt5, this.logger);
    }
  }

  /**
   * Initialize execution backend when agent starts
   */
  async onStart() {
    await super.onStart();
    
    try {
      this.logger.info(`🔧 Initializing ${this.executionBackend.getBackendType()} execution backend...`);
      await this.executionBackend.initialize();
      // For backward compat, set containerId if container backend
      if (this.executionBackend.getBackendType() === 'container') {
        this.containerId = this.executionBackend.containerId;
      }
      this.logger.info('✅ Execution backend ready', { 
        type: this.executionBackend.getBackendType(),
        containerId: this.containerId
      }, 3);
      
      await this.reportProgress(10, 'Execution backend initialized and ready');
      
      // NEW: Upload predecessor artifacts if provided
      if (this.mission.artifactsToUpload && this.mission.artifactsToUpload.length > 0) {
        this.logger.info('📦 Predecessor artifacts detected, uploading to execution environment...', {
          count: this.mission.artifactsToUpload.length
        });
        
        const uploadResults = await this.uploadPredecessorArtifacts(this.mission.artifactsToUpload);
        
        if (uploadResults.uploaded > 0) {
          await this.reportProgress(12, `Uploaded ${uploadResults.uploaded} artifact(s) from previous agents`);
        }
      }
    } catch (error) {
      this.logger.error('❌ Failed to initialize execution backend', { error: error.message }, 3);
      throw new Error(`Execution backend initialization failed: ${error.message}`);
    }
  }

  /**
   * Main execution logic - GENERIC, adapts to available data
   */
  async execute() {
    this.logger.info('🧪 Starting code execution mission', {
      goal: this.mission.description.substring(0, 100)
    }, 3);

    await this.reportProgress(5, 'Querying memory for relevant data');

    // STEP 1: Query memory based on mission (semantic search)
    const relevantKnowledge = await this.memory.query(this.mission.description, 30);
    
    this.logger.info('📚 Memory query complete', {
      nodesFound: relevantKnowledge.length,
      topSimilarity: relevantKnowledge[0]?.similarity || 0
    });

    // NEW: Traverse knowledge graph to find related data
    if (relevantKnowledge.length > 0) {
      const graphTraversal = await this.traverseKnowledgeGraph(this.mission.description, null, 2);
      this.logger.info('🕸️  Knowledge graph traversed', {
        nodesFound: graphTraversal.length,
        maxDepth: Math.max(...graphTraversal.map(n => n.depth), 0)
      });
    }

    // NEW: Get recent insights that might contain relevant data
    const recentData = await this.getRecentInsights(7200000); // Last 2 hours
    this.logger.info('⏱️  Recent activity', {
      recentNodes: recentData.length,
      tags: [...new Set(recentData.map(n => n.tag))]
    });

    // STEP 2: Check for code files created by CodeCreationAgent (PRIORITY CHECK)
    this.logger.info('🔍 Searching for code files from CodeCreationAgent...', {}, 3);
    
    // Check if this mission has a linked CodeCreationAgent
    const linkedAgentId = this.mission.metadata?.codeCreationAgentId || null;
    const linkedOutputDir = this.mission.metadata?.codeCreationOutputDir || null;

    if (linkedAgentId) {
      this.logger.info('🔗 Mission linked to specific CodeCreationAgent', {
        linkedAgentId,
        outputDir: linkedOutputDir
      }, 3);
    }

    const fileDiscoveryOptions = {
      agentTypes: ['code_creation'],
      sourceAgentId: linkedAgentId, // Filter to specific agent if linked
      fileType: null,  // Accept all file types
      limit: 50,
      maxAgeMs: 3600000, // Last 1 hour (reduced from 24h to prevent accumulation)
      missionContext: this.mission.description, // CRITICAL: Enable semantic filtering
      semanticLimit: 15 // Max files per source agent when semantic filtering is active
    };

    const createdCodeFiles = await this.waitForDiscoveredFiles(fileDiscoveryOptions);

    if (createdCodeFiles.length > 0) {
      this.logger.info('🎯 Found code files to test!', {
        fileCount: createdCodeFiles.length,
        files: createdCodeFiles.map(f => ({
          name: f.filename,
          path: f.relativePath,
          source: f.sourceAgentId
        }))
      }, 3);
      
      await this.reportProgress(15, `Found ${createdCodeFiles.length} code file(s) to validate`);
      
      // Test the discovered code - this is the primary purpose
      return await this.testDiscoveredCode(createdCodeFiles);
    } else {
      this.logger.info('ℹ️  No code files found from CodeCreationAgent - will execute standalone computation', {}, 3);
    }

    // STEP 3: Check what other structured data is available
    const structuredData = await this.queryMemoryForData(
      ['data', 'code', 'analysis', 'inventory', 'document', 'contents'],
      ['source_code_analysis', 'source_code_file', 'file_inventory', 'research', 'document_contents_for_analysis'],
      10
    );

    // NEW: Check for document contents from DocumentAnalysisAgent
    const documentContents = structuredData.filter(d => d.tag === 'document_contents_for_analysis');

    if (documentContents.length > 0) {
      this.logger.info('📁 Found document contents from DocumentAnalysisAgent', {
        documentSets: documentContents.length,
        totalDocuments: documentContents[0]?.data?.documentCount || 0
      });
      
      // Upload documents to container for computational analysis
      await this.uploadDocumentsToContainer(documentContents[0].data);
      
      // Now execute computational analysis with files available
      return await this.analyzeDocumentsInContainer(documentContents[0].data);
    }

    // STEP 3: Adapt execution based on available data
    if (structuredData.length > 0) {
      this.logger.info('✅ Found structured data in memory → will analyze it', {
        dataObjects: structuredData.length,
        tags: [...new Set(structuredData.map(d => d.tag))].join(', ')
      });
      return await this.analyzeAvailableData(structuredData, relevantKnowledge);
    }
    
    this.logger.info('ℹ️  No structured data in memory → will execute standalone computation');

    // NEW: Check if similar validation already done
    const existingValidation = await this.checkExistingKnowledge(this.mission.description, 2);
    if (existingValidation && existingValidation.hasKnowledge) {
      this.logger.info('⚠️  Similar computational work found in memory', {
        relevantNodes: existingValidation.relevantNodes,
        topMatch: existingValidation.topMatches[0]?.concept.substring(0, 80)
      });
      
      await this.addInsight(
        `Found ${existingValidation.relevantNodes} related computational results in memory. ` +
        `This execution will provide fresh validation or explore different parameters.`
      );
    }

    // NEW: Check strategic priority
    const strategicContext = await this.getStrategicContext();
    if (strategicContext && strategicContext.priorities) {
      this.logger.info('🎯 Aligning computation with strategic priorities');
    }

    // Step 1: Plan computational approach
    await this.reportProgress(20, 'Planning computational approach');
    const plan = await this.planExecution();
    
    if (plan.approach) {
      await this.addInsight(`Computational Plan: ${plan.approach.substring(0, 200)}`);
    }

    // Step 2: Execute experiments
    await this.reportProgress(40, 'Executing code experiments');
    const executionResults = await this.runExperiments(plan);

    // Step 3: Analyze and interpret results
    await this.reportProgress(70, 'Analyzing results and extracting insights');
    const insights = await this.interpretResults(executionResults);

    // Step 4: Store insights in memory
    for (const insight of insights) {
      await this.addInsight(insight);
    }

    // Step 5: Store key findings
    if (executionResults.summary) {
      await this.addFinding(executionResults.summary);
    }

    // NEW: If results are interesting, suggest follow-up experiments
    if (insights.length >= 3 && !executionResults.response?.hadError) {
      // Check if results warrant deeper exploration
      const hasInterestingResults = insights.some(i => 
        i.toLowerCase().includes('unexpected') ||
        i.toLowerCase().includes('surprising') ||
        i.toLowerCase().includes('novel')
      );

      if (hasInterestingResults) {
        this.logger.info('🔬 Interesting results - suggesting follow-up experiments');
        
        // Inject follow-up topic for deeper exploration
        await this.injectFollowUpTopic(
          `Follow-up computational validation of: ${this.mission.description.substring(0, 100)}`,
          'medium',
          'Unexpected results warrant deeper investigation'
        );
      }
    }

    await this.reportProgress(100, 'Code execution complete');

    return {
      success: true,
      plan,
      executionResults: this.executionResults,
      insights,
      filesGenerated: this.generatedFiles.length,
      metadata: {
        filesCreated: this.generatedFiles.length,
        executionAttempted: true,
        insightsGenerated: insights.length,
        status: 'complete'
      }
    };
  }

  /**
   * Plan what code to write and execute
   */
  async planExecution() {
    this.logger.info('📋 Planning computational experiments...');

    try {
      const response = await this.gpt5.generateWithRetry({
        model: this.config.models?.strategicModel || 'gpt-5.2',
        instructions: `You are planning a computational experiment to address this goal:

GOAL: ${this.mission.description}

Your task:
1. Determine what computation, analysis, or code execution is needed
2. Identify what data or inputs are required
3. Outline the specific experiments or tests to run
4. Define what outputs or results will answer the goal

Be specific and focused. Plan 1-3 concrete, executable experiments that will provide meaningful results.

Respond with a clear execution plan.`,
        messages: [{ role: 'user', content: 'Create computational execution plan' }],
        reasoningEffort: 'high', // Multi-step planning - core reasoning use case per OpenAI
        max_output_tokens: 4096
      }, 3);

      this.logger.info('✅ Execution plan created', {
        planLength: response.content?.length || 0
      }, 3);

      return {
        approach: response.content,
        reasoning: response.reasoning
      };
    } catch (error) {
      this.logger.error('Failed to create execution plan', { error: error.message }, 3);
      // Return a fallback plan
      return {
        approach: `Execute code to explore: ${this.mission.description}`,
        reasoning: null
      };
    }
  }

  /**
   * Execute code experiments in container
   */
  async runExperiments(plan) {
    this.logger.info('⚗️  Executing code experiments in container...');

    try {
      const response = await this.executionBackend.executeCode({
        input: `Execute this computational plan using Python code:

${plan.approach}

REQUIREMENTS:
- Write clean, well-commented Python code
- Include print statements to show intermediate results
- Generate visualizations if appropriate (use matplotlib, seaborn, etc.)
- Return clear, interpretable output
- Handle errors gracefully

Execute the code and provide the results.`,
        max_output_tokens: 12000,  // Increased for comprehensive test output
        reasoningEffort: 'high',
        retryCount: 3
      });

      // Store execution results
      const executionRecord = {
        timestamp: new Date(),
        content: response.content,
        reasoning: response.reasoning,
        codeResults: response.codeResults || [],
        hadError: response.hadError || false
      };

      this.executionResults.push(executionRecord);

      // Track generated files
      if (response.codeResults) {
        for (const result of response.codeResults) {
          if (result.files && result.files.length > 0) {
            this.generatedFiles.push(...result.files);
          }
        }
      }

      this.logger.info('✅ Code execution complete', {
        resultsLength: response.content?.length || 0,
        filesGenerated: this.generatedFiles.length,
        hadError: executionRecord.hadError
      }, 3);

      // Create summary
      const summary = this.summarizeExecution(response);

      return {
        response,
        summary,
        executionRecord,
        
        // NEW: Explicitly set DoD fields for Executive Ring validation
        metadata: {
          executionAttempted: true,
          outputFiles: this.generatedFiles.length,
          hadError: executionRecord.hadError
        }
      };
    } catch (error) {
      this.logger.error('Code execution failed', { error: error.message }, 3);
      
      // Store error as a result
      this.executionResults.push({
        timestamp: new Date(),
        error: error.message,
        hadError: true
      });

      return {
        response: null,
        summary: `Code execution failed: ${error.message}`,
        executionRecord: null
      };
    }
  }

  /**
   * Summarize execution results
   */
  summarizeExecution(response) {
    const parts = [];

    if (response.content) {
      const contentPreview = response.content.substring(0, 300);
      parts.push(`Output: ${contentPreview}${response.content.length > 300 ? '...' : ''}`);
    }

    if (response.codeResults && response.codeResults.length > 0) {
      parts.push(`Generated ${response.codeResults.length} code execution result(s)`);
    }

    if (this.generatedFiles.length > 0) {
      parts.push(`Created ${this.generatedFiles.length} file(s)`);
    }

    return parts.join('. ');
  }

  /**
   * Interpret results and extract insights
   */
  async interpretResults(executionResults) {
    if (!executionResults.response) {
      this.logger.warn('No execution results to interpret');
      return ['Code execution encountered an error - unable to extract insights'];
    }

    this.logger.info('🔍 Interpreting execution results...');

    try {
      const response = await this.gpt5.generateWithRetry({
        model: this.config.models?.strategicModel || 'gpt-5.2',
        instructions: `Analyze these code execution results and extract key insights:

ORIGINAL GOAL: ${this.mission.description}

EXECUTION RESULTS:
${executionResults.response.content}

${executionResults.response.reasoning ? `\nREASONING:\n${executionResults.response.reasoning}` : ''}

Your task:
1. Identify KEY FINDINGS from the computational results
2. Extract INSIGHTS that address the original goal
3. Note any UNEXPECTED RESULTS or patterns
4. Suggest FOLLOW-UP questions or experiments

Provide 3-5 specific, actionable insights. Be concise and cite actual results from the execution.`,
        messages: [{ role: 'user', content: 'Extract insights from execution results' }],
        reasoningEffort: 'medium', // Keep medium - appropriate for interpretation
        max_output_tokens: 3000
      }, 3);

      // Parse insights from response
      const insights = this.extractInsightsFromText(response.content);

      this.logger.info('✅ Extracted insights', { count: insights.length }, 3);
      cosmoEvents.emitEvent('insights_extracted', {
        count: insights.length,
        agentId: this.agentId,
        preview: insights.length > 0 ? insights[0].substring(0, 100) : ''
      });

      return insights;
    } catch (error) {
      this.logger.error('Failed to interpret results', { error: error.message }, 3);
      return ['Results generated but interpretation failed'];
    }
  }

  /**
   * Extract individual insights from LLM response text
   */
  extractInsightsFromText(text) {
    const insights = [];
    const lines = text.split('\n');

    for (const line of lines) {
      // Match numbered lists, bullet points, or dashes
      const match = line.match(/^(?:\d+\.|[-•*])\s+(.+)$/);
      if (match) {
        const insight = match[1].trim();
        // Filter out very short or header-like lines
        if (insight.length > 30 && !insight.match(/^(Key Findings|Insights|Follow-up|Unexpected)/i)) {
          insights.push(insight);
        }
      }
    }

    // If no structured insights found, try to extract paragraphs
    if (insights.length === 0) {
      const paragraphs = text.split('\n\n').filter(p => p.length > 50);
      insights.push(...paragraphs.slice(0, 5).map(p => p.trim()));
    }

    return insights.slice(0, 5); // Top 5 insights max
  }

  /**
   * Upload documents to container for computational analysis
   */
  async uploadDocumentsToContainer(documentData) {
    if (!this.containerId && this.executionBackend.getBackendType() === 'container') {
      this.logger.warn('No container available for document upload');
      return;
    }

    this.logger.info('📤 Uploading documents to container', {
      documentCount: documentData.documentCount,
      containerId: this.containerId
    });

    for (const doc of documentData.documents) {
      try {
        // Create file buffer from content
        const buffer = Buffer.from(doc.content, 'utf8');
        
        // Upload to execution backend
        await this.executionBackend.uploadFile(buffer, doc.filename);
        
        this.logger.info(`   ✓ Uploaded: ${doc.filename} (${doc.size} bytes)`);
      } catch (error) {
        this.logger.warn(`   ✗ Failed to upload: ${doc.filename}`, {
          error: error.message
        });
      }
    }

    this.logger.info('✅ Documents uploaded to container');
  }

  /**
   * Analyze documents in container with computational tools
   */
  async analyzeDocumentsInContainer(documentData) {
    await this.reportProgress(30, 'Analyzing documents in container');

    const instructions = `You have ${documentData.documentCount} documents uploaded to this container. Analyze them computationally:

Documents:
${documentData.documents.map(d => `- ${d.filename} (${d.wordCount} words, modified: ${d.modified})`).join('\n')}

Tasks:
1. Compute cryptographic hashes (SHA-256) for each document
2. Generate line-by-line diffs between versions
3. Calculate similarity scores between documents
4. Extract temporal patterns from timestamps
5. Identify structural changes (sections added/removed)
6. Quantify edit magnitude (lines/words changed)

Produce:
- Version comparison matrix
- Edit timeline
- Change statistics
- Evolution insights`;

    try {
      const response = await this.executionBackend.executeCode({
        input: instructions,
        max_output_tokens: 12000,  // Increased for comprehensive test output
        reasoningEffort: 'high',
        retryCount: 3
      });

      // Extract results
      const results = {
        insights: [],
        summary: response?.content || 'Analysis completed',
        codeResults: response?.codeResults || []
      };

      if (response?.content) {
        results.insights.push(response.content.substring(0, 2000));
      }
      
      // Store insights
      for (const insight of results.insights) {
        await this.addInsight(insight, 'document_computational_analysis');
      }

      await this.reportProgress(90, 'Document analysis complete');

      return {
        success: true,
        analysisType: 'document_comparison',
        documentsAnalyzed: documentData.documentCount,
        computationalResults: results,
        metadata: {
          documentsAnalyzed: documentData.documentCount,
          filesCreated: this.generatedFiles.length,
          status: 'complete'
        }
      };

    } catch (error) {
      this.logger.error('Document analysis in container failed', {
        error: error.message
      });
      
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Test code files discovered from CodeCreationAgent
   * CRITICAL: Enables testing of actual implementation files created by other agents
   * 
   * @param {Array} codeFiles - File references from discoverFiles()
   * @returns {Object} Test results with pass/fail status
   */
  async testDiscoveredCode(codeFiles) {
    this.logger.info('⚡ Testing code files created by CodeCreationAgent', {
      fileCount: codeFiles.length,
      files: codeFiles.map(f => f.filename)
    }, 3);
    
    const testResults = [];
    
    for (const fileRef of codeFiles) {
      try {
        const fileNum = testResults.length + 1;
        await this.reportProgress(30 + (testResults.length * 15), `Testing file ${fileNum}/${codeFiles.length}: ${fileRef.filename}`);
        
        // CRITICAL: Check if timeout was triggered (allows graceful exit before container deletion)
        if (this._timeoutTriggered) {
          this.logger.warn(`⏱️ Timeout detected, stopping tests gracefully at file ${fileNum}/${codeFiles.length}`, {
            testedSoFar: testResults.length,
            remaining: codeFiles.length - testResults.length
          }, 3);
          
          // Add finding about partial completion
          await this.addFinding(
            `Code validation stopped by timeout: Tested ${testResults.length}/${codeFiles.length} files before time limit. Remaining files require new validation run with increased timeout.`,
            'code_validation'
          );
          
          break; // Exit loop before container cleanup
        }
        
        // CRITICAL: Check if container still exists (shouldn't happen with timeout flag, but defensive)
        if (!this.containerId && this.executionBackend.getBackendType() === 'container') {
          this.logger.error(`❌ Container lost unexpectedly at file ${fileNum}/${codeFiles.length}`, {
            testedSoFar: testResults.length
          }, 3);
          
          await this.addFinding(
            `Code validation aborted: Container lost after testing ${testResults.length}/${codeFiles.length} files. This indicates a system error.`,
            'code_validation'
          );
          
          break;
        }
        
        // Read the actual code file via MCP
        this.logger.info(`📖 Reading code file via MCP: ${fileRef.relativePath}`, {}, 3);
        const codeContent = await this.readFileViaMCP(fileRef.relativePath);
        
        this.logger.info(`✅ Code file loaded`, {
          filename: fileRef.filename,
          size: codeContent.length,
          sourceAgent: fileRef.sourceAgentId
        }, 3);
        
        // Test the code in container
        this.logger.info(`🧪 Executing test for: ${fileRef.filename}`, {}, 3);
        
        let testResult;
        try {
          testResult = await this.executionBackend.executeCode({
            input: `Test this code file that was created by another agent (CodeCreationAgent):

File: ${fileRef.filename}
Source Agent: ${fileRef.sourceAgentId}
Created: ${fileRef.createdAt}

Code:
\`\`\`python
${codeContent}
\`\`\`

Your task:
1. Read and understand what this code does
2. Execute it to verify it works (run the main functionality)
3. Test edge cases if applicable (empty inputs, invalid data, etc.)
4. Check for any bugs, errors, or issues
5. Evaluate code quality (readability, efficiency, completeness)
6. Provide specific recommendations for improvements if needed

Execute the code and provide comprehensive test results with:
- ✅ What works correctly
- ❌ What fails or has issues
- 💡 Suggested improvements
- 📊 Test coverage assessment`,
          max_output_tokens: 6000,
          reasoningEffort: 'high',
          retryCount: 3
        });
        } catch (containerError) {
          // Container execution failed completely - log and continue to next file
          this.logger.warn(`Container execution failed for ${fileRef.filename}, continuing to next file`, {
            error: containerError.message
          }, 3);
          
          testResults.push({
            file: fileRef.filename,
            path: fileRef.relativePath,
            sourceAgent: fileRef.sourceAgentId,
            testPassed: false,
            results: `Container execution failed: ${containerError.message}`,
            hadError: true
          });
          
          await this.addFinding(
            `Code Validation - ${fileRef.filename}: Container execution failed - ${containerError.message}`,
            'code_validation'
          );
          
          continue; // Skip to next file
        }
        
        // Handle response.incomplete gracefully
        const isIncomplete = testResult?.errorType === 'response.incomplete';
        const contentIsError = typeof testResult?.content === 'string' && testResult.content.startsWith('[Error:');
        
        if (isIncomplete || contentIsError) {
          this.logger.warn(`⚠️ Test response incomplete or errored for ${fileRef.filename}, continuing to next file`, {
            errorType: testResult?.errorType,
            contentPreview: testResult?.content?.substring(0, 100)
          }, 3);
        }
        
        // Use available content or fallback message
        const resultContent = testResult?.content || '[No test output received]';
        
        const testPassed = !testResult.hadError && 
                          testResult.content && 
                          !contentIsError &&
                          !testResult.content.toLowerCase().includes('error:') &&
                          !testResult.content.toLowerCase().includes('failed');
        
        testResults.push({
          file: fileRef.filename,
          path: fileRef.relativePath,
          sourceAgent: fileRef.sourceAgentId,
          testPassed: testPassed,
          results: resultContent,
          reasoning: testResult.reasoning,
          hadError: testResult.hadError,
          incomplete: isIncomplete
        });
        
        // Store test results as findings (always, even if incomplete)
        await this.addFinding(
          `Code Validation - ${fileRef.filename}: ${resultContent.substring(0, 800)}`,
          'code_validation'
        );
        
        // Store detailed results if test generated files
        if (testResult.codeResults) {
          for (const result of testResult.codeResults) {
            if (result.files) {
              this.generatedFiles.push(...result.files);
            }
          }
        }
        
        this.logger.info(`${testPassed ? '✅' : '⚠️'} Test ${testPassed ? 'PASSED' : 'FAILED'}: ${fileRef.filename}`, {
          hadError: testResult.hadError,
          contentLength: testResult.content?.length || 0
        }, 3);
        
      } catch (error) {
        this.logger.error(`Failed to test ${fileRef.filename}`, {
          error: error.message,
          stack: error.stack
        }, 3);
        
        testResults.push({
          file: fileRef.filename,
          testPassed: false,
          error: error.message
        });
      }
    }
    
    // Summary (always runs, even if some tests failed/incomplete)
    const passedCount = testResults.filter(r => r.testPassed).length;
    const failedCount = testResults.length - passedCount;
    const incompleteCount = testResults.filter(r => r.incomplete).length;
    
    const summaryMessage = `Code Validation Complete: Tested ${testResults.length} file(s) created by CodeCreationAgent. ` +
                          `${passedCount} passed, ${failedCount} ${failedCount === 1 ? 'had' : 'have'} issues` +
                          `${incompleteCount > 0 ? ` (${incompleteCount} incomplete due to API limits)` : ''}.`;
    
    // Always log summary as insight (critical for audit trail)
    try {
    await this.addInsight(summaryMessage);
    } catch (summaryError) {
      this.logger.warn('Failed to add summary insight (non-fatal)', {
        error: summaryError.message
      }, 3);
    }
    
    this.logger.info('✅ Code testing summary', {
      filesTotal: testResults.length,
      passed: passedCount,
      failed: failedCount,
      incomplete: incompleteCount
    }, 3);
    
    await this.reportProgress(100, 'Code testing complete');
    
    // Return success if we tested anything (even if some failed)
    return {
      success: testResults.length > 0,
      testingType: 'code_file_validation',
      filesTested: testResults.length,
      testsPassed: passedCount,
      testsFailed: failedCount,
      incompleteTests: incompleteCount,
      testResults: testResults,
      
      // NEW: Explicitly set DoD fields for Executive Ring validation
      metadata: {
        executionAttempted: true,
        testsRun: testResults.length,
        outputFiles: this.generatedFiles.length,
        filesCreated: this.generatedFiles.length,
        testsPassed: passedCount,
        status: 'complete'
      }
    };
  }

  /**
   * Cleanup: Delete container when done
   */
  async onComplete() {
    await this.cleanupContainer();
    await super.onComplete();
  }

  /**
   * Cleanup on error
   */
  async onError(error) {
    await this.cleanupContainer();
    await super.onError(error);
  }

  /**
   * Cleanup on timeout
   */
  async onTimeout() {
    // Set flag so test loop can detect timeout and exit gracefully
    this._timeoutTriggered = true;
    
    // Give execute() a moment to detect flag and exit cleanly
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Now safe to cleanup
    await this.cleanupContainer();
    await super.onTimeout();
  }

  /**
   * Detect file type from content and return extension
   * @param {Buffer} content - File content buffer
   * @returns {Object} - { type, extension }
   */
  detectFileType(content) {
    if (!Buffer.isBuffer(content)) {
      return { type: 'unknown', extension: '.bin' };
    }
    
    // Check magic bytes for common types
    const header = content.slice(0, 16);
    
    // PNG: 89 50 4E 47
    if (header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4E && header[3] === 0x47) {
      return { type: 'png', extension: '.png' };
    }
    
    // JPEG: FF D8 FF
    if (header[0] === 0xFF && header[1] === 0xD8 && header[2] === 0xFF) {
      return { type: 'jpeg', extension: '.jpg' };
    }
    
    // ZIP: 50 4B 03 04 or 50 4B 05 06
    if (header[0] === 0x50 && header[1] === 0x4B && (header[2] === 0x03 || header[2] === 0x05)) {
      return { type: 'zip', extension: '.zip' };
    }
    
    // PDF: 25 50 44 46
    if (header[0] === 0x25 && header[1] === 0x50 && header[2] === 0x44 && header[3] === 0x46) {
      return { type: 'pdf', extension: '.pdf' };
    }
    
    // Try to detect text-based formats
    const sample = content.slice(0, 512).toString('utf8', 0, Math.min(512, content.length));
    
    // JSON
    if (sample.trim().startsWith('{') || sample.trim().startsWith('[')) {
      return { type: 'json', extension: '.json' };
    }
    
    // CSV
    if (sample.includes(',') && (sample.match(/\n/g) || []).length > 2) {
      return { type: 'csv', extension: '.csv' };
    }
    
    // Python
    if (sample.includes('def ') || sample.includes('import ') || sample.includes('class ')) {
      return { type: 'python', extension: '.py' };
    }
    
    // Markdown
    if (sample.includes('# ') || sample.includes('## ') || sample.includes('```')) {
      return { type: 'markdown', extension: '.md' };
    }
    
    // Default to binary
    return { type: 'unknown', extension: '.bin' };
  }

  /**
   * Download and save generated files from container before cleanup
   */
  async downloadAndSaveGeneratedFiles() {
    if (!this.containerId && this.executionBackend.getBackendType() === 'container') {
      return [];
    }

    const savedFiles = [];
    const outputDir = this.config.logsDir
      ? path.join(this.config.logsDir, 'outputs', 'code-execution', this.agentId)
      : path.join(process.cwd(), 'runtime', 'outputs', 'code-execution', this.agentId);
    
    try {
      await fs.mkdir(outputDir, { recursive: true });
      
      // CRITICAL: List ALL files in container, not just annotated ones
      // Files may exist without being cited in annotations
      let filesToDownload = [];
      
      try {
        const containerFiles = await this.executionBackend.listFiles();
        
        // Filter out directories (path ends with / or bytes is null)
        filesToDownload = (containerFiles || []).filter(f => {
          const isDirectory = Boolean(f.path?.endsWith('/'));
          if (isDirectory) {
            this.logger.debug('Skipping directory in container listing', {
              path: f.path
            }, 3);
          }
          return !isDirectory;
        });
        
        this.logger.info('📁 Files found in container', {
          total: containerFiles?.length || 0,
          files: filesToDownload.length,
          directories: (containerFiles?.length || 0) - filesToDownload.length,
          annotated: this.generatedFiles.length,
          method: 'container_listing'
        }, 3);
      } catch (listError) {
        this.logger.warn('Could not list container files, using annotations only', {
          error: listError.message
        }, 3);
        filesToDownload = this.generatedFiles;
      }
      
      // Fallback to annotations if listing returned nothing
      if (filesToDownload.length === 0 && this.generatedFiles.length > 0) {
        filesToDownload = this.generatedFiles;
        this.logger.info('Using annotated files only', {
          count: filesToDownload.length
        }, 3);
      }
      
      if (filesToDownload.length === 0) {
        this.logger.warn('⚠️  No files to download from container', {
          containerId: this.containerId,
          note: 'Container may be empty or model did not generate files'
        }, 3);
        return [];
      }
      
      this.logger.info('📥 Downloading files from container', {
        containerId: this.containerId,
        fileCount: filesToDownload.length,
        outputDir
      }, 3);

      // Cleanup any orphaned temp files from previous runs
      await this.cleanupOrphanedTempFiles(outputDir);

      // PARALLEL DOWNLOADS: Process files in batches to improve performance
      // Batch size of 3 balances speed vs API limits and memory usage
      const BATCH_SIZE = 3;
      
      for (let i = 0; i < filesToDownload.length; i += BATCH_SIZE) {
        const batch = filesToDownload.slice(i, i + BATCH_SIZE);
        
        this.logger.info(`📥 Processing batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(filesToDownload.length / BATCH_SIZE)}`, {
          batchSize: batch.length,
          total: filesToDownload.length
        }, 3);
        
        // Process batch in parallel
        const batchResults = await Promise.all(batch.map(async (fileRef, batchIndex) => {
        try {
          // Extract file ID - support both annotation format and container listing format
          const fileId = fileRef.file_id || fileRef.id || (typeof fileRef === 'string' ? fileRef : null);
          
          if (!fileId) {
            this.logger.warn('Skipping file with missing ID', { fileRef }, 3);
              return null;
          }

          // Download file content from container (cfile_... IDs)
          const fileContent = await this.executionBackend.downloadFile(fileId);
          
          // CRITICAL: Ensure unique filenames to prevent overwrites
          // Use provided filename if available; otherwise generate unique name based on fileId + counter
          let filename = fileRef.filename || fileRef.name;
          if (!filename || filename === 'file_' + fileId.substring(6, 14)) {
            // No unique filename provided - generate one with global counter
            const globalIndex = i + batchIndex;
            const contentType = this.detectFileType(fileContent);
            filename = `file_${fileId.substring(6, 14)}_${globalIndex}${contentType.extension}`;
          }
          
          const filePath = path.join(outputDir, filename);
          
            // ATOMIC WRITE: Use temp-file-then-rename to prevent partial files
            await this.writeFileAtomic(filePath, fileContent);
          
          const relativePath = `runtime/outputs/code-execution/${this.agentId}/${filename}`;
          
          const fileSize = Buffer.isBuffer(fileContent) ? fileContent.length : (fileContent.length || 0);
          
            const sizeKB = (fileSize / 1024).toFixed(1);
            this.logger.info(`   ✓ Saved: ${filename} (${sizeKB}KB)`, {}, 3);
            
            return {
            fileId,
            filename,
            filePath,
            relativePath,
            size: fileSize
            };
        } catch (error) {
          this.logger.warn(`   ✗ Failed to download file`, {
            fileRef,
            error: error.message
          }, 3);
            return null;
        }
        }));
        
        // Collect successful downloads from this batch
        savedFiles.push(...batchResults.filter(r => r !== null));
      }

      if (savedFiles.length > 0) {
        // Write completion marker (LAST STEP - atomic)
        await this.writeCompletionMarker(outputDir, {
          fileCount: savedFiles.length,
          totalSize: savedFiles.reduce((sum, f) => sum + (f.size || 0), 0),
          files: savedFiles.map(f => ({
            filename: f.filename,
            size: f.size
          }))
        });
        
        // Store file paths in memory for later discovery
        const filePathsData = {
          agentId: this.agentId,
          containerId: this.containerId,
          timestamp: new Date().toISOString(),
          files: savedFiles.map(f => ({
            filename: f.filename,
            relativePath: f.relativePath,
            size: f.size
          }))
        };

        await this.addFinding(
          JSON.stringify(filePathsData),
          'code_execution_output_files'
        );

        this.logger.info('✅ Files downloaded and saved atomically', {
          saved: savedFiles.length,
          total: this.generatedFiles.length,
          outputDir
        }, 3);
      }

      return savedFiles;
    } catch (error) {
      this.logger.error('Failed to download generated files', {
        error: error.message,
        containerId: this.containerId
      }, 3);
      // Don't throw - allow cleanup to proceed even if download fails
      return [];
    }
  }

  /**
   * Delete container and cleanup resources
   */
  async cleanupContainer() {
    if (this.containerId) {
      // CRITICAL: ALWAYS try to download files if container exists
      // downloadAndSaveGeneratedFiles() will list container to find files
      // even if this.generatedFiles is empty (no annotations)
      try {
        await this.downloadAndSaveGeneratedFiles();
      } catch (error) {
        this.logger.warn('Failed to download files before cleanup (non-fatal)', {
          error: error.message
        }, 3);
      }

      this.logger.info('🧹 Cleaning up execution backend', { 
        type: this.executionBackend.getBackendType(),
        containerId: this.containerId 
      }, 3);
      
      try {
        await this.executionBackend.cleanup();
        this.logger.info('✅ Execution backend cleaned up successfully');
      } catch (error) {
        // Non-fatal - just log
        this.logger.warn('Execution backend cleanup failed (non-fatal)', { 
          error: error.message 
        }, 3);
      }
      
      // Keep containerId null for backward compat
      this.containerId = null;
    }
  }

  /**
   * Analyze available data from memory (GENERIC method)
   * Adapts to whatever data types are present - no hardcoded branching
   */
  async analyzeAvailableData(structuredData, contextualKnowledge) {
    this.logger.info('📊 Analyzing data from memory network');
    await this.reportProgress(20, 'Processing data from memory');
    
    // Build analysis context from all available data
    const dataContext = {
      structured: structuredData.map(item => ({
        tag: item.tag,
        data: item.data,
        concept: item.sourceNode?.concept?.substring(0, 100)
      })),
      contextual: contextualKnowledge.slice(0, 10).map(node => ({
        concept: node.concept?.substring(0, 150),
        similarity: node.similarity
      }))
    };
    
    // Generate analysis plan based on available data (adaptive)
    const analysisPlan = await this.planDataAnalysis(dataContext);
    
    // Execute the plan
    return await this.executeDataAnalysis(analysisPlan, dataContext);
  }

  /**
   * Plan data analysis based on available context (GENERIC planning)
   * LLM decides what to analyze based on mission + data available
   */
  async planDataAnalysis(dataContext) {
    this.logger.info('📋 Planning data analysis based on available context');

    const dataDescription = dataContext.structured.map((item, i) =>
      `DATA ${i + 1} (tag: ${item.tag}):\n${typeof item.data === 'object' ? JSON.stringify(item.data, null, 2).substring(0, 500) : item.data}`
    ).join('\n\n');

    const contextDescription = dataContext.contextual.map(node =>
      `- ${node.concept} (similarity: ${node.similarity.toFixed(2)})`
    ).join('\n');

    try {
      const response = await this.gpt5.generateWithRetry({
        model: this.config.models?.strategicModel || 'gpt-5.2',
        instructions: `You are planning a data analysis based on available memory data.

MISSION: ${this.mission.description}

AVAILABLE STRUCTURED DATA:
${dataDescription}

RELEVANT CONTEXT FROM MEMORY:
${contextDescription}

Your task:
1. Determine what analysis would best address the mission
2. Identify what computations or visualizations to create
3. Plan how to use the available data effectively
4. Define what outputs will answer the mission goals

Be specific and adaptive - work with whatever data is available.

Respond with a clear, executable analysis plan.`,
        messages: [{ role: 'user', content: 'Create data analysis plan' }],
        reasoningEffort: 'high',
        max_output_tokens: 4096
      }, 3);

      return {
        plan: response.content,
        reasoning: response.reasoning
      };
    } catch (error) {
      this.logger.error('Failed to create analysis plan', { error: error.message });
      return {
        plan: `Analyze available data to address: ${this.mission.description}`,
        reasoning: null
      };
    }
  }

  /**
   * Execute data analysis plan (GENERIC execution)
   * Runs Python code to analyze whatever data is available
   */
  async executeDataAnalysis(analysisPlan, dataContext) {
    this.logger.info('⚗️  Executing data analysis in container');

    // Prepare data for Python
    const dataSummary = dataContext.structured.map((item, i) =>
      `Data ${i + 1} (${item.tag}): ${JSON.stringify(item.data)}`
    ).join('\n');

    try {
      await this.reportProgress(40, 'Executing Python analysis');
      
      const response = await this.executionBackend.executeCode({
        input: `Execute this data analysis plan using Python:

${analysisPlan.plan}

AVAILABLE DATA:
${dataSummary}

REQUIREMENTS:
- Write clean, well-commented Python code
- Work with the data provided above
- Generate insights that address the mission
- Include visualizations if appropriate
- Handle data gracefully (it may be nested JSON)

Execute the code and provide results.`,
        max_output_tokens: 12000,  // Increased for comprehensive test output
        reasoningEffort: 'high',
        retryCount: 3
      });

      // Store results
      this.executionResults.push({
        timestamp: new Date(),
        content: response.content,
        reasoning: response.reasoning,
        dataSource: 'memory_network',
        hadError: response.hadError || false
      });

      // Extract insights
      await this.reportProgress(70, 'Extracting insights from analysis');
      const insights = await this.interpretResults({ response, summary: response.content });

      // Store findings
      for (const insight of insights) {
        await this.addInsight(insight);
      }

      await this.addFinding(JSON.stringify({
        source: 'memory_network',
        analysis_complete: true,
        insights: insights.length
      }), 'code_analysis');

      await this.reportProgress(100, 'Analysis complete');

      return {
        success: true,
        dataSource: 'memory_network',
        insightsGenerated: insights.length,
        usedFilesystem: false
      };
    } catch (error) {
      this.logger.error('Failed to execute data analysis', { error: error.message });
      throw error;
    }
  }
  
  /**
   * Generic data analysis for non-code data (file inventories, simple datasets)
   * This is the fallback when source code analysis data isn't available
   */
  async analyzeGenericData(memoryData) {
    this.logger.info('📊 Analyzing generic data from memory');
    await this.reportProgress(25, 'Processing generic data');
    
    // Extract and structure all data objects
    const dataObjects = memoryData.map(item => ({
      type: item.type,
      tag: item.tag,
      data: item.data,
      source: item.sourceNode.concept.substring(0, 100)
    }));
    
    // Create analysis prompt with actual data
    const dataDescription = dataObjects.map((obj, i) => 
      `DATA ${i + 1} (${obj.type}, tag: ${obj.tag}):\n${JSON.stringify(obj.data, null, 2)}`
    ).join('\n\n');
    
    const analysisPrompt = `You are analyzing data retrieved from COSMO's memory network.
This data was stored by other agents (research, analysis, etc.) and is now available for computational analysis.

MISSION: ${this.mission.description}

AVAILABLE DATA FROM MEMORY:
${dataDescription}

Your task:
1. Understand the data structure(s) provided
2. Write Python code to analyze this data
3. Generate meaningful statistics, insights, or visualizations
4. Answer the mission objectives using this data

IMPORTANT: 
- Do NOT try to access any filesystem or external files
- Work ONLY with the data provided above
- The data is already in memory from other agents' work

Generate Python code to analyze this data and produce results that address the mission.`;

    try {
      await this.reportProgress(40, 'Executing Python analysis on generic data');
      
      const response = await this.executionBackend.executeCode({
        input: analysisPrompt,
        max_output_tokens: 12000,  // Increased for comprehensive test output
        reasoningEffort: 'high',
        retryCount: 3
      });
      
      // Store and process results
      return await this.processAnalysisResults(response, dataObjects, 'generic');
      
    } catch (error) {
      this.logger.error('Failed to analyze generic data', { error: error.message });
      throw error;
    }
  }
  
  /**
   * Process and store analysis results (shared by both analysis paths)
   * @param {Object} response - GPT-5.2 execution response
   * @param {Object} dataContext - Context about what was analyzed
   * @param {string} analysisType - 'source_code' or 'generic'
   */
  async processAnalysisResults(response, dataContext, analysisType) {
    // Store execution results
    this.executionResults.push({
      timestamp: new Date(),
      content: response.content,
      reasoning: response.reasoning,
      dataSource: 'memory_network',
      analysisType,
      hadError: response.hadError || false
    });
    
    await this.reportProgress(70, 'Interpreting analysis results');
    
    // Create context-aware summary
    const summary = analysisType === 'source_code'
      ? `Deep code quality analysis of ${dataContext.files_analyzed} files (${dataContext.total_lines} lines). ` +
        `Results: ${response.content.substring(0, 200)}`
      : `Analyzed ${dataContext.length || 1} data object(s) from memory network. ` +
        `Results: ${response.content.substring(0, 200)}`;
    
    // Store findings with analysis type tag
    await this.addFinding(JSON.stringify({
      source: 'memory_network',
      analysis_type: analysisType,
      context: analysisType === 'source_code' ? {
        files_analyzed: dataContext.files_analyzed,
        total_lines: dataContext.total_lines
      } : {
        data_objects: dataContext.length || 1
      },
      analysisResults: response.content.substring(0, 1000),  // Store more for code analysis
      fullSummary: summary
    }), analysisType === 'source_code' ? 'code_quality_analysis' : 'code_analysis');
    
    // Extract insights from results
    await this.reportProgress(85, 'Extracting actionable insights');
    const insights = await this.interpretResults({
      response,
      summary
    });
    
    for (const insight of insights) {
      await this.addInsight(insight);
    }
    
    await this.reportProgress(100, 'Code analysis complete');
    
    this.logger.info('✅ Code execution complete using memory data', {
      analysisType,
      insights: insights.length,
      hadError: response.hadError || false
    });
    
    return {
      success: true,
      dataSource: 'memory_network',
      analysisType,
      insightsGenerated: insights.length,
      usedFilesystem: false,
      metadata: {
        filesCreated: this.generatedFiles.length,
        insightsGenerated: insights.length,
        analysisType,
        status: 'complete'
      }
    };
  }

  async waitForDiscoveredFiles(options, retryConfig = {}) {
    const attempts = Math.max(1, Math.floor(retryConfig.attempts ?? 4));
    const delayMs = Math.max(0, Math.floor(retryConfig.delayMs ?? 2000));

    for (let attempt = 1; attempt <= attempts; attempt++) {
      const files = await this.discoverFiles(options);
      if (files.length > 0) {
        if (attempt > 1) {
          this.logger.info('📂 Code files detected after retry', {
            attempts: attempt,
            filesFound: files.length
          }, 3);
        }
        return files;
      }

      if (attempt < attempts) {
        this.logger.debug('Waiting for code creation files to become available', {
          attempt,
          attempts,
          delayMs
        });
        await this.delay(delayMs);
      }
    }

    return [];
  }

  async delay(ms) {
    if (ms <= 0) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Optional: Generate handoff if code execution reveals need for other agents
   */
  generateHandoffSpec() {
    // Check if code execution revealed questions that need research
    const needsResearch = this.executionResults.some(result => 
      result.content?.includes('need more data') || 
      result.content?.includes('requires research')
    );

    if (needsResearch) {
      return {
        type: 'HANDOFF',
        toAgentType: 'research',
        reason: 'Code execution revealed need for additional data/research',
        context: {
          originalGoal: this.mission.goalId,
          findings: this.results.filter(r => r.type === 'finding').map(r => r.content)
        }
      };
    }

    return null; // No handoff needed
  }
}

module.exports = { CodeExecutionAgent };

