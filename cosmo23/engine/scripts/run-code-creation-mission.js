#!/usr/bin/env node

/**
 * Standalone runner for CodeCreationAgent missions.
 * Executes a single mission end-to-end (parse requirements → generate code in container → download files)
 * so we can debug prompts and container behaviour without launching the full COSMO orchestrator.
 */

const path = require('path');
const fs = require('fs/promises');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { ConfigLoader } = require('../src/core/config-loader');
const { SimpleLogger } = require('../lib/simple-logger');
const { CodeCreationAgent } = require('../src/agents/code-creation-agent');

function parseArgs(argv) {
  const options = {
    missionFile: null,
    missionText: null,
    goalId: `manual_goal_${Date.now()}`,
    maxDuration: 15 * 60 * 1000, // 15 minutes
    outputRoot: null,
    logLevel: process.env.CODE_CREATION_LOG_LEVEL || 'info'
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--mission-file':
      case '-f':
        options.missionFile = argv[++i] || null;
        break;
      case '--mission':
      case '-m':
        options.missionText = argv[++i] || null;
        break;
      case '--goal':
        options.goalId = argv[++i] || options.goalId;
        break;
      case '--max-duration':
        options.maxDuration = parseInt(argv[++i], 10) || options.maxDuration;
        break;
      case '--output-root':
        options.outputRoot = argv[++i] || null;
        break;
      case '--log-level':
        options.logLevel = argv[++i] || options.logLevel;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        // Allow positional mission file if not prefixed with flag
        if (!arg.startsWith('-') && !options.missionFile && !options.missionText) {
          options.missionFile = arg;
        }
        break;
    }
  }

  return options;
}

function printHelp() {
  console.log(`Run a CodeCreationAgent mission outside COSMO\n\n` +
    `Usage:\n` +
    `  node scripts/run-code-creation-mission.js --mission-file ./mission.txt\n` +
    `  node scripts/run-code-creation-mission.js --mission "Build a Python solver..."\n\n` +
    `Options:\n` +
    `  -f, --mission-file <path>   Mission description file (Markdown/text)\n` +
    `  -m, --mission <text>        Mission description provided inline\n` +
    `      --goal <id>             Goal identifier (default: manual_goal_<timestamp>)\n` +
    `      --max-duration <ms>     Timeout before aborting (default: 900000)\n` +
    `      --output-root <path>    Override config.logsDir for outputs/debug\n` +
    `      --log-level <level>     Logger level (debug|info|warn|error)\n` +
    `  -h, --help                  Show this help message\n`);
}

async function loadMissionText(options) {
  if (options.missionFile) {
    const resolved = path.isAbsolute(options.missionFile)
      ? options.missionFile
      : path.join(process.cwd(), options.missionFile);
    const content = await fs.readFile(resolved, 'utf8');
    return content.trim();
  }

  if (options.missionText) {
    return options.missionText.trim();
  }

  throw new Error('Mission description required. Provide --mission-file or --mission.');
}

class LocalMemoryStub {
  constructor(logger) {
    this.logger = logger;
    this.nodes = [];
  }

  async query() {
    return [];
  }

  async addNode(concept, tag) {
    const node = {
      id: `stub_${this.nodes.length + 1}`,
      concept,
      tag: tag || 'agent_finding',
      similarity: 0
    };
    this.nodes.push(node);
    return node;
  }

  async reinforceCooccurrence() {
    return;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const missionDescription = await loadMissionText(options);

  const logger = new SimpleLogger(options.logLevel);
  logger.info('▶️  Running standalone CodeCreationAgent mission');

  const loader = new ConfigLoader();
  const config = loader.load();

  if (options.outputRoot) {
    config.logsDir = path.isAbsolute(options.outputRoot)
      ? options.outputRoot
      : path.join(process.cwd(), options.outputRoot);
    logger.info('Overriding logsDir for outputs', { logsDir: config.logsDir });
  }

  const mission = {
    goalId: options.goalId,
    description: missionDescription,
    successCriteria: ['Generate runnable code files saved under /mnt/data/'],
    maxDuration: options.maxDuration
  };

  const agent = new CodeCreationAgent(mission, config, logger);
  agent.memory = new LocalMemoryStub(logger);
  agent.on('error', (payload) => {
    logger.error('Agent emitted error event', payload || {});
  });
  agent.on('timeout', (payload) => {
    logger.error('Agent timed out', payload || {});
  });

  try {
    const result = await agent.run();

    const outputDir = path.join(
      config.logsDir || path.join(process.cwd(), 'runtime'),
      'outputs',
      'code-creation',
      agent.agentId
    );

    const agentData = result?.agentSpecificData || {};
    const manifest = agentData.manifest;
    const success = agentData.success ?? result?.success ?? false;
    const filesGenerated = manifest?.summary?.completed
      ?? agentData.filesGenerated
      ?? result?.filesGenerated
      ?? agent.generatedFiles.length;

    logger.info('Run complete', {
      status: agent.status,
      success,
      filesGenerated,
      outputDir
    });

    if (manifest) {
      logger.info('Plan manifest summary', {
        status: manifest.status,
        completed: manifest.summary?.completed ?? 0,
        failed: manifest.summary?.failed ?? 0,
        total: manifest.summary?.total ?? manifest.files?.length ?? 0,
        manifestPath: path.join(outputDir, 'manifest.json')
      });
    }

    if (agent.status !== 'completed' || !success) {
      const debugDir = path.join(outputDir, '_debug');
      logger.error('Code creation mission did not succeed. Inspect debug artifacts for details.', {
        debugDir,
        success
      });
      process.exitCode = 1;
    } else {
      logger.info('Code creation mission succeeded', {
        outputDir,
        manifestPath: path.join(outputDir, 'manifest.json'),
        debugDir: path.join(outputDir, '_debug')
      });
    }
  } catch (error) {
    logger.error('Fatal error running CodeCreationAgent mission', {
      error: error.message,
      stack: error.stack
    });
    process.exitCode = 1;
  }
}

main();


