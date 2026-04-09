#!/usr/bin/env node

/**
 * Manual harness for exercising GPT-5.2 code-interpreter file generation
 * without running the entire COSMO orchestration stack.
 *
 * Usage (examples):
 *   node scripts/manual-codegen-test.js --language python
 *   node scripts/manual-codegen-test.js --prompt ./docs/development/CODE_CREATION_PROMPT_FIX.md
 *   node scripts/manual-codegen-test.js --inline "Create a Python file that prints 'hello'"
 *
 * The script will:
 *   1. Create a dedicated code-interpreter container
 *   2. Execute the supplied prompt using GPT5Client.executeInContainer
 *   3. List and download any files the model wrote inside the container
 *   4. Save outputs to runtime/manual-tests/<timestamp>/
 */

const path = require('path');
const fs = require('fs/promises');
const { existsSync } = require('fs');
const dotenv = require('dotenv');

// Ensure .env is loaded just like the main app
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const { GPT5Client } = require('../src/core/gpt5-client');

const DEFAULT_LANGUAGE = 'python';
const DEFAULT_MAX_OUTPUT_TOKENS = 6000;
const DEFAULT_REASONING_EFFORT = 'high';

function parseArgs(argv) {
  const options = {
    language: DEFAULT_LANGUAGE,
    keepContainer: false,
    inlinePrompt: null,
    promptPath: null,
    outputDir: null,
    maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
    reasoningEffort: DEFAULT_REASONING_EFFORT
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--language':
      case '-l':
        options.language = argv[++i] || DEFAULT_LANGUAGE;
        break;
      case '--prompt':
      case '-p':
        options.promptPath = argv[++i] || null;
        break;
      case '--inline':
        options.inlinePrompt = argv[++i] || null;
        break;
      case '--output-dir':
        options.outputDir = argv[++i] || null;
        break;
      case '--max-output':
        options.maxOutputTokens = parseInt(argv[++i], 10) || DEFAULT_MAX_OUTPUT_TOKENS;
        break;
      case '--reasoning':
        options.reasoningEffort = argv[++i] || DEFAULT_REASONING_EFFORT;
        break;
      case '--keep-container':
        options.keepContainer = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        if (arg && !arg.startsWith('--')) {
          // Positional prompt path fallback
          options.promptPath = arg;
        }
        break;
    }
  }

  return options;
}

function printHelp() {
  const helpText = `Manual GPT-5.2 Code Generation Harness\n\n` +
    `Options:\n` +
    `  -l, --language <name>        Programming language context (default: ${DEFAULT_LANGUAGE})\n` +
    `  -p, --prompt <file>         Path to a prompt snippet to use\n` +
    `      --inline <text>         Provide prompt text directly on the CLI\n` +
    `      --output-dir <path>     Override output directory (defaults to runtime/manual-tests/<timestamp>)\n` +
    `      --max-output <tokens>   Set max_output_tokens (default: ${DEFAULT_MAX_OUTPUT_TOKENS})\n` +
    `      --reasoning <level>     Reasoning effort (low|medium|high, default: ${DEFAULT_REASONING_EFFORT})\n` +
    `      --keep-container        Do not delete container after run (for inspection)\n` +
    `  -h, --help                  Show this message\n`;
  console.log(helpText);
}

function makeLogger() {
  const format = (level, message, data) => {
    const payload = data ? ` ${JSON.stringify(data)}` : '';
    console.log(`[${new Date().toISOString()}] ${level.toUpperCase()}: ${message}${payload}`);
  };

  return {
    info: (msg, data) => format('info', msg, data),
    warn: (msg, data) => format('warn', msg, data),
    error: (msg, data) => format('error', msg, data),
    debug: (msg, data) => format('debug', msg, data)
  };
}

async function loadPrompt(options) {
  if (options.inlinePrompt) {
    return options.inlinePrompt;
  }

  if (options.promptPath) {
    const resolved = path.isAbsolute(options.promptPath)
      ? options.promptPath
      : path.join(process.cwd(), options.promptPath);

    if (!existsSync(resolved)) {
      throw new Error(`Prompt file not found: ${resolved}`);
    }

    return fs.readFile(resolved, 'utf8');
  }

  return defaultPrompt(options.language);
}

function defaultPrompt(language) {
  return `You are running inside the OpenAI code interpreter environment.\n\n` +
    `Create a minimal ${language} implementation that demonstrates file output:\n` +
    `1. Write a ${language} source file to /mnt/data/ named main.${language === 'python' ? 'py' : 'js'}.\n` +
    `2. The file must contain runnable code (no placeholders).\n` +
    `3. After writing the file, run it to show sample output.\n` +
    `4. Report any generated filenames.\n`;
}

function buildOutputDir(baseDir) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = baseDir
    ? path.isAbsolute(baseDir) ? baseDir : path.join(process.cwd(), baseDir)
    : path.join(process.cwd(), 'runtime', 'manual-tests', stamp);

  return target;
}

async function writeFileSafe(destination, buffer) {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, buffer);
}

function summarizeResponse(response) {
  return {
    contentPreview: response?.content ? response.content.slice(0, 400) : null,
    reasoningPreview: response?.reasoning ? response.reasoning.slice(0, 400) : null,
    hadError: Boolean(response?.hadError),
    errorType: response?.errorType || null,
    codeResults: Array.isArray(response?.codeResults)
      ? response.codeResults.map(result => ({
        files: result.files?.map(f => f.file_id || f.filename) || [],
        outputPreview: result.output?.text ? result.output.text.slice(0, 200) : null
      }))
      : []
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    printHelp();
    return;
  }

  const logger = makeLogger();

  try {
    const prompt = await loadPrompt(options);
    const outputDir = buildOutputDir(options.outputDir);

    logger.info('Starting manual code generation test', {
      language: options.language,
      maxOutputTokens: options.maxOutputTokens,
      reasoningEffort: options.reasoningEffort,
      outputDir,
      usingInlinePrompt: Boolean(options.inlinePrompt)
    });

    await fs.mkdir(outputDir, { recursive: true });

    const gpt5 = new GPT5Client(logger);
    const containerId = await gpt5.createContainer();
    logger.info('Container ready', { containerId });

    let response;
    try {
      response = await gpt5.executeInContainer({
        containerId,
        input: prompt,
        max_output_tokens: options.maxOutputTokens,
        reasoningEffort: options.reasoningEffort
      });

      logger.info('Code interpreter response received', summarizeResponse(response));

      // Persist raw response for inspection
      await writeFileSafe(path.join(outputDir, 'response.json'), Buffer.from(JSON.stringify(response, null, 2), 'utf8'));

      const files = await gpt5.listContainerFiles(containerId).catch(err => {
        logger.warn('Failed to list container files', { error: err.message });
        return [];
      });

      if (!files || files.length === 0) {
        logger.warn('No files reported in container listing');
      } else {
        logger.info('Files reported by container', {
          count: files.length,
          entries: files.map(f => ({ id: f.id, path: f.path, bytes: f.bytes }))
        });

        for (const fileMeta of files) {
          if (fileMeta.path && fileMeta.path.endsWith('/')) {
            logger.debug('Skipping directory entry', { path: fileMeta.path });
            continue;
          }

          try {
            const buffer = await gpt5.downloadFileFromContainer(containerId, fileMeta.id);
            const relative = fileMeta.path?.startsWith('/mnt/data/')
              ? fileMeta.path.slice('/mnt/data/'.length)
              : (fileMeta.path || fileMeta.id);
            const targetPath = path.join(outputDir, relative);
            await writeFileSafe(targetPath, buffer);
            logger.info('Downloaded file', { targetPath, bytes: buffer.length });
          } catch (downloadError) {
            logger.error('Failed to download container file', {
              fileId: fileMeta.id,
              path: fileMeta.path,
              error: downloadError.message
            });
          }
        }
      }
    } finally {
      if (!options.keepContainer) {
        await gpt5.deleteContainer(containerId);
        logger.info('Container deleted', { containerId });
      } else {
        logger.warn('Container preserved for manual inspection', { containerId });
      }
    }

    logger.info('Manual code generation test complete', {
      outputDir,
      success: !(response?.hadError)
    });
  } catch (error) {
    console.error('❌ Manual code generation test failed:', error.message);
    if (error.stack) {
      console.error(error.stack);
    }
    process.exitCode = 1;
  }
}

main();


