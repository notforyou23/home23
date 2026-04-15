import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const BIRD_BIN = process.env.BIRD_BIN || "/opt/homebrew/bin/bird";
const DEFAULT_TIMEOUT = 30_000;

function ensureBirdInstalled() {
  if (!fs.existsSync(BIRD_BIN)) {
    throw new Error(`bird CLI not found at ${BIRD_BIN}`);
  }
}

function resolveOutputDir(context) {
  const workspacePath = context?.workspacePath;
  if (workspacePath) {
    return path.join(workspacePath, "reports", "x");
  }
  const projectRoot = context?.projectRoot || process.cwd();
  return path.join(projectRoot, "workspace", "skills", "x", "outputs");
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function buildBirdArgs(command, commandArgs = [], options = {}) {
  const args = [];

  if (options.chromeProfile) {
    args.push("--chrome-profile", options.chromeProfile);
  }
  if (options.chromeProfileDir) {
    args.push("--chrome-profile-dir", options.chromeProfileDir);
  }
  if (options.timeoutMs) {
    args.push("--timeout", String(options.timeoutMs));
  }
  if (options.quoteDepth != null) {
    args.push("--quote-depth", String(options.quoteDepth));
  }
  if (options.media && Array.isArray(options.media)) {
    for (const mediaPath of options.media) {
      args.push("--media", mediaPath);
    }
  }
  if (options.alt && Array.isArray(options.alt)) {
    for (const altText of options.alt) {
      args.push("--alt", altText);
    }
  }

  args.push("--plain", command);
  if (options.json) {
    args.push("--json");
  }
  args.push(...commandArgs);

  return args;
}

async function runBird(command, commandArgs = [], options = {}) {
  ensureBirdInstalled();

  const args = buildBirdArgs(command, commandArgs, options);
  const { stdout, stderr } = await execFileAsync(BIRD_BIN, args, {
    timeout: (options.timeoutMs || DEFAULT_TIMEOUT) + 5_000,
    maxBuffer: 1024 * 1024 * 10,
  });

  return {
    stdout: stdout?.trim() || "",
    stderr: stderr?.trim() || "",
  };
}

function parseJsonOutput(raw) {
  if (!raw) return null;
  return JSON.parse(raw);
}

function estimateItemCount(value) {
  if (Array.isArray(value)) return value.length;
  if (!value || typeof value !== "object") return 0;
  for (const key of ["tweets", "results", "entries", "data", "instructions"]) {
    if (Array.isArray(value[key])) return value[key].length;
  }
  return 1;
}

function saveJson(outputDir, prefix, data) {
  ensureDir(outputDir);
  const filePath = path.join(outputDir, `${prefix}-${timestamp()}.json`);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
  return filePath;
}

async function timeline(params = {}, context = {}) {
  const count = Math.min(Math.max(Number(params.count || 20), 1), 100);
  const timeoutMs = Number(params.timeoutMs || DEFAULT_TIMEOUT);
  const outputDir = resolveOutputDir(context);

  const following = await runBird("home", ["--following", "--count", String(count)], {
    json: true,
    timeoutMs,
    chromeProfile: params.chromeProfile,
    chromeProfileDir: params.chromeProfileDir,
  });
  const forYou = await runBird("home", ["--count", String(count)], {
    json: true,
    timeoutMs,
    chromeProfile: params.chromeProfile,
    chromeProfileDir: params.chromeProfileDir,
  });

  const payload = {
    generatedAt: new Date().toISOString(),
    count,
    following: parseJsonOutput(following.stdout),
    forYou: parseJsonOutput(forYou.stdout),
  };

  const filePath = saveJson(outputDir, "timeline", payload);
  return {
    success: true,
    savedTo: filePath,
    followingCount: estimateItemCount(payload.following),
    forYouCount: estimateItemCount(payload.forYou),
  };
}

async function read(params = {}, context = {}) {
  if (!params.url && !params.tweetId) {
    throw new Error("url or tweetId is required");
  }

  const target = params.url || params.tweetId;
  const outputDir = resolveOutputDir(context);
  const result = await runBird("read", [String(target)], {
    json: true,
    timeoutMs: Number(params.timeoutMs || DEFAULT_TIMEOUT),
    quoteDepth: params.quoteDepth != null ? Number(params.quoteDepth) : 1,
    chromeProfile: params.chromeProfile,
    chromeProfileDir: params.chromeProfileDir,
  });

  const payload = parseJsonOutput(result.stdout);
  const filePath = params.save === false ? null : saveJson(outputDir, "read", payload);
  return {
    success: true,
    savedTo: filePath,
    data: params.save === false ? payload : undefined,
  };
}

async function search(params = {}, context = {}) {
  if (!params.query) {
    throw new Error("query is required");
  }

  const count = Math.min(Math.max(Number(params.count || 10), 1), 100);
  const outputDir = resolveOutputDir(context);
  const result = await runBird("search", ["--count", String(count), String(params.query)], {
    json: true,
    timeoutMs: Number(params.timeoutMs || DEFAULT_TIMEOUT),
    chromeProfile: params.chromeProfile,
    chromeProfileDir: params.chromeProfileDir,
  });

  const payload = parseJsonOutput(result.stdout);
  const filePath = params.save === false ? null : saveJson(outputDir, "search", payload);
  return {
    success: true,
    savedTo: filePath,
    resultCount: estimateItemCount(payload),
    data: params.save === false ? payload : undefined,
  };
}

async function mentions(params = {}, context = {}) {
  const count = Math.min(Math.max(Number(params.count || 10), 1), 100);
  const commandArgs = ["--count", String(count)];
  if (params.user) {
    commandArgs.unshift(String(params.user));
    commandArgs.unshift("--user");
  }

  const outputDir = resolveOutputDir(context);
  const result = await runBird("mentions", commandArgs, {
    json: true,
    timeoutMs: Number(params.timeoutMs || DEFAULT_TIMEOUT),
    chromeProfile: params.chromeProfile,
    chromeProfileDir: params.chromeProfileDir,
  });

  const payload = parseJsonOutput(result.stdout);
  const filePath = params.save === false ? null : saveJson(outputDir, "mentions", payload);
  return {
    success: true,
    savedTo: filePath,
    resultCount: estimateItemCount(payload),
    data: params.save === false ? payload : undefined,
  };
}

async function post(params = {}) {
  if (!params.text) {
    throw new Error("text is required");
  }

  const result = await runBird("tweet", [String(params.text)], {
    timeoutMs: Number(params.timeoutMs || DEFAULT_TIMEOUT),
    chromeProfile: params.chromeProfile,
    chromeProfileDir: params.chromeProfileDir,
    media: params.media,
    alt: params.alt,
  });

  return {
    success: true,
    output: result.stdout,
  };
}

async function reply(params = {}) {
  if ((!params.url && !params.tweetId) || !params.text) {
    throw new Error("tweetId or url plus text is required");
  }

  const target = params.url || params.tweetId;
  const result = await runBird("reply", [String(target), String(params.text)], {
    timeoutMs: Number(params.timeoutMs || DEFAULT_TIMEOUT),
    chromeProfile: params.chromeProfile,
    chromeProfileDir: params.chromeProfileDir,
    media: params.media,
    alt: params.alt,
  });

  return {
    success: true,
    output: result.stdout,
  };
}

export async function execute(action, params, context) {
  if (action === "timeline") return timeline(params, context);
  if (action === "read") return read(params, context);
  if (action === "search") return search(params, context);
  if (action === "mentions") return mentions(params, context);
  if (action === "post") return post(params, context);
  if (action === "reply") return reply(params, context);
  throw new Error(`Unknown x action: ${action}`);
}
