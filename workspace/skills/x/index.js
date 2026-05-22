import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const require = createRequire(import.meta.url);
const yaml = require("js-yaml");
const execFileAsync = promisify(execFile);
const BIRD_BIN = process.env.BIRD_BIN || "/opt/homebrew/bin/bird";
const DEFAULT_TIMEOUT = 30_000;
const BASE_URL = "https://api.x.com/2";
const UPLOAD_URL = "https://upload.twitter.com/1.1/media/upload.json";
const MEDIA_METADATA_URL = "https://upload.twitter.com/1.1/media/metadata/create.json";
const SKILL_ID = "x";

function ensureBirdInstalled() {
  if (!fs.existsSync(BIRD_BIN)) {
    throw new Error(`bird CLI not found at ${BIRD_BIN}`);
  }
}

function resolveSkillDir() {
  return path.dirname(fileURLToPath(import.meta.url));
}

function resolveProjectRoot(context = {}) {
  return context?.projectRoot || path.resolve(resolveSkillDir(), "..", "..", "..");
}

function readYamlFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  return yaml.load(fs.readFileSync(filePath, "utf8")) || {};
}

function loadHome23Secrets(context = {}) {
  return readYamlFile(path.join(resolveProjectRoot(context), "config", "secrets.yaml"));
}

function getSecretBlock(context = {}) {
  const secrets = loadHome23Secrets(context);
  return secrets.skills?.[SKILL_ID] || secrets.x || {};
}

function resolveBackend(params = {}, context = {}) {
  const requested = params.backend || process.env.X_SKILL_BACKEND;
  if (requested) return String(requested).toLowerCase();

  try {
    const secrets = getSecretBlock(context);
    if (secrets.bearerToken || process.env.X_BEARER_TOKEN) return "api";
  } catch {
    // fall through
  }

  return "bird";
}

function getBearerToken(context = {}) {
  if (process.env.X_BEARER_TOKEN) return process.env.X_BEARER_TOKEN;
  const secrets = getSecretBlock(context);
  if (secrets.bearerToken) return String(secrets.bearerToken);
  throw new Error("X bearer token not found at secrets.skills.x.bearerToken or X_BEARER_TOKEN");
}

function getOAuth2UserToken(context = {}) {
  if (process.env.X_OAUTH2_ACCESS_TOKEN) return process.env.X_OAUTH2_ACCESS_TOKEN;
  const secrets = getSecretBlock(context);
  if (secrets.oauth2AccessToken) return String(secrets.oauth2AccessToken);
  throw new Error("X OAuth2 user access token not found at secrets.skills.x.oauth2AccessToken or X_OAUTH2_ACCESS_TOKEN");
}

function getOAuth1Credentials(context = {}) {
  const secrets = getSecretBlock(context);
  const creds = {
    consumerKey: process.env.X_API_KEY || process.env.X_CONSUMER_KEY || secrets.apiKey || secrets.consumerKey,
    consumerSecret: process.env.X_API_SECRET || process.env.X_CONSUMER_SECRET || secrets.apiSecret || secrets.consumerSecret,
    accessToken: process.env.X_ACCESS_TOKEN || secrets.accessToken,
    accessTokenSecret: process.env.X_ACCESS_TOKEN_SECRET || secrets.accessTokenSecret,
  };

  const missing = Object.entries(creds)
    .filter(([, value]) => !value)
    .map(([key]) => key);
  if (missing.length > 0) {
    throw new Error(`X OAuth1 credentials missing: ${missing.join(", ")}. Need apiKey/apiSecret/accessToken/accessTokenSecret in secrets.skills.x.`);
  }

  return Object.fromEntries(Object.entries(creds).map(([key, value]) => [key, String(value)]));
}

function percentEncode(value) {
  return encodeURIComponent(String(value))
    .replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function buildOAuth1Header(method, url, bodyParams = {}, context = {}) {
  const creds = getOAuth1Credentials(context);
  const normalizedBodyParams = bodyParams instanceof URLSearchParams
    ? Object.fromEntries(bodyParams.entries())
    : bodyParams;
  const oauthParams = {
    oauth_consumer_key: creds.consumerKey,
    oauth_nonce: crypto.randomUUID().replace(/-/g, ""),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.floor(Date.now() / 1000),
    oauth_token: creds.accessToken,
    oauth_version: "1.0",
  };

  const parsedUrl = new URL(url);
  const signingParams = [];
  for (const [key, value] of parsedUrl.searchParams.entries()) signingParams.push([key, value]);
  for (const [key, value] of Object.entries(normalizedBodyParams)) {
    if (value !== undefined && value !== null) signingParams.push([key, value]);
  }
  for (const [key, value] of Object.entries(oauthParams)) signingParams.push([key, value]);

  signingParams.sort(([aKey, aValue], [bKey, bValue]) => {
    const keyCompare = percentEncode(aKey).localeCompare(percentEncode(bKey));
    if (keyCompare !== 0) return keyCompare;
    return percentEncode(aValue).localeCompare(percentEncode(bValue));
  });

  const parameterString = signingParams
    .map(([key, value]) => `${percentEncode(key)}=${percentEncode(value)}`)
    .join("&");
  const baseUrl = `${parsedUrl.protocol}//${parsedUrl.host}${parsedUrl.pathname}`;
  const signatureBase = [method.toUpperCase(), percentEncode(baseUrl), percentEncode(parameterString)].join("&");
  const signingKey = `${percentEncode(creds.consumerSecret)}&${percentEncode(creds.accessTokenSecret)}`;
  const signature = crypto.createHmac("sha1", signingKey).update(signatureBase).digest("base64");

  return "OAuth " + Object.entries({ ...oauthParams, oauth_signature: signature })
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${percentEncode(key)}=\"${percentEncode(value)}\"`)
    .join(", ");
}

async function apiRequest(endpoint, options = {}, context = {}) {
  const url = endpoint.startsWith("http") ? endpoint : `${BASE_URL}${endpoint}`;
  const authMode = options.authMode || "bearer";
  const bodyParams = options.bodyParams || {};
  const headers = {
    ...(options.contentType === false ? {} : { "Content-Type": options.contentType || "application/json" }),
    ...(options.headers || {}),
  };

  if (authMode === "oauth1") {
    headers.Authorization = buildOAuth1Header(options.method || "GET", url, bodyParams, context);
  } else if (authMode === "oauth2-user") {
    headers.Authorization = `Bearer ${getOAuth2UserToken(context)}`;
  } else {
    headers.Authorization = `Bearer ${getBearerToken(context)}`;
  }

  const { authMode: _authMode, bodyParams: _bodyParams, contentType: _contentType, ...fetchOptions } = options;
  const res = await fetch(url, {
    ...fetchOptions,
    headers,
  });

  const bodyText = await res.text();
  let body = null;
  if (bodyText) {
    try {
      body = JSON.parse(bodyText);
    } catch {
      body = bodyText;
    }
  }

  if (res.status === 429) {
    const reset = res.headers.get("x-rate-limit-reset");
    const waitSec = reset ? Math.max(Number(reset) - Math.floor(Date.now() / 1000), 1) : 60;
    throw new Error(`X API rate limited. Resets in ${waitSec}s`);
  }

  if (!res.ok) {
    const detail = typeof body === "string" ? body.slice(0, 500) : JSON.stringify(body).slice(0, 500);
    throw new Error(`X API ${res.status}: ${detail}`);
  }

  return body;
}

const TWEET_FIELDS = "tweet.fields=created_at,public_metrics,author_id,conversation_id,entities&expansions=author_id&user.fields=username,name,public_metrics";

function guessMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".png") return "image/png";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  return "application/octet-stream";
}

async function uploadMediaApi(mediaPath, altText, context = {}) {
  if (!fs.existsSync(mediaPath)) throw new Error(`Media file not found: ${mediaPath}`);
  const data = fs.readFileSync(mediaPath);
  const mimeType = guessMimeType(mediaPath);
  const initParams = {
    command: "INIT",
    media_type: mimeType,
    total_bytes: String(data.length),
    media_category: "tweet_image",
  };

  const initPayload = await apiRequest(UPLOAD_URL, {
    method: "POST",
    authMode: "oauth1",
    bodyParams: initParams,
    body: new URLSearchParams(initParams),
    contentType: "application/x-www-form-urlencoded;charset=UTF-8",
  }, context);

  const mediaId = initPayload.media_id_string || String(initPayload.media_id || "");
  if (!mediaId) throw new Error(`X media upload INIT did not return media_id: ${JSON.stringify(initPayload).slice(0, 500)}`);

  const appendParams = {
    command: "APPEND",
    media_id: mediaId,
    segment_index: "0",
    media_data: data.toString("base64"),
  };
  await apiRequest(UPLOAD_URL, {
    method: "POST",
    authMode: "oauth1",
    bodyParams: appendParams,
    body: new URLSearchParams(appendParams),
    contentType: "application/x-www-form-urlencoded;charset=UTF-8",
  }, context);

  const finalizeParams = {
    command: "FINALIZE",
    media_id: mediaId,
  };
  await apiRequest(UPLOAD_URL, {
    method: "POST",
    authMode: "oauth1",
    bodyParams: finalizeParams,
    body: new URLSearchParams(finalizeParams),
    contentType: "application/x-www-form-urlencoded;charset=UTF-8",
  }, context);

  return mediaId;
}

function resolveGeneratedImageDir(context = {}) {
  const workspacePath = context?.workspacePath || path.join(resolveProjectRoot(context), "instances", "jerry", "workspace");
  return path.join(workspacePath, "media", "generated-images");
}

function readGeneratedImageReceipt(receiptPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
    if (!parsed || typeof parsed.path !== "string") return null;
    if (!fs.existsSync(parsed.path)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function latestGeneratedImage(context = {}) {
  const dir = resolveGeneratedImageDir(context);
  if (!fs.existsSync(dir)) return null;
  const receipts = fs.readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => path.join(dir, name))
    .map(readGeneratedImageReceipt)
    .filter(Boolean)
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  return receipts[0] || null;
}

function resolveMediaList(params = {}, context = {}) {
  const media = Array.isArray(params.media) ? [...params.media] : [];
  if (params.generatedImage === "latest" || params.useLatestGeneratedImage === true) {
    const latest = latestGeneratedImage(context);
    if (!latest) throw new Error("No generated image receipt found. Run generate_image first, then post with generatedImage:'latest'.");
    media.push(latest.path);
  }

  const normalized = media.map((item) => String(item));
  if (params.requireMedia === true && normalized.length === 0) {
    throw new Error("requireMedia:true was set, but no media paths were provided or resolved.");
  }

  for (const mediaPath of normalized) {
    if (!path.isAbsolute(mediaPath)) throw new Error(`Media path must be absolute: ${mediaPath}`);
    if (!fs.existsSync(mediaPath)) throw new Error(`Media file not found: ${mediaPath}`);
    if (params.requireGeneratedImage === true) {
      const generatedDir = resolveGeneratedImageDir(context);
      const relative = path.relative(generatedDir, mediaPath);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error(`Media is not from generated-images artifact dir: ${mediaPath}`);
      }
    }
  }

  return normalized;
}

async function uploadMediaListApi(media = [], alt = [], context = {}) {
  if (!Array.isArray(media) || media.length === 0) return [];
  const mediaIds = [];
  for (let index = 0; index < media.length; index += 1) {
    mediaIds.push(await uploadMediaApi(String(media[index]), Array.isArray(alt) ? alt[index] : undefined, context));
  }
  return mediaIds;
}

async function mediaUploadTest(params = {}, context = {}) {
  const media = resolveMediaList(params, context);
  const mediaIds = await uploadMediaListApi(media, params.alt, context);
  return {
    success: true,
    backend: "api",
    media,
    mediaIds,
  };
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
    backend: "bird",
    count,
    following: parseJsonOutput(following.stdout),
    forYou: parseJsonOutput(forYou.stdout),
  };

  const filePath = saveJson(outputDir, "timeline", payload);
  return {
    success: true,
    backend: "bird",
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
  const backend = resolveBackend(params, context);
  const outputDir = resolveOutputDir(context);

  if (backend === "api") {
    const tweetId = extractTweetId(target);
    const payload = await apiRequest(`/tweets/${tweetId}?${TWEET_FIELDS}`, {}, context);
    const filePath = params.save === false ? null : saveJson(outputDir, "read", payload);
    return {
      success: true,
      backend: "api",
      savedTo: filePath,
      data: params.save === false ? payload : undefined,
    };
  }

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
    backend: "bird",
    savedTo: filePath,
    data: params.save === false ? payload : undefined,
  };
}

function extractTweetId(value) {
  const raw = String(value || "");
  const match = raw.match(/status\/(\d+)/) || raw.match(/^(\d+)$/);
  if (!match) throw new Error(`Could not extract tweet id from ${raw}`);
  return match[1];
}

async function search(params = {}, context = {}) {
  if (!params.query) {
    throw new Error("query is required");
  }

  const count = Math.min(Math.max(Number(params.count || 10), 1), 100);
  const backend = resolveBackend(params, context);
  const outputDir = resolveOutputDir(context);

  if (backend === "api") {
    const maxResults = Math.max(count, 10);
    const query = encodeURIComponent(String(params.query));
    const payload = await apiRequest(`/tweets/search/recent?query=${query}&max_results=${maxResults}&${TWEET_FIELDS}`, {}, context);
    const filePath = params.save === false ? null : saveJson(outputDir, "search", payload);
    return {
      success: true,
      backend: "api",
      savedTo: filePath,
      resultCount: estimateItemCount(payload?.data || []),
      data: params.save === false ? payload : undefined,
    };
  }

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
    backend: "bird",
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
    backend: "bird",
    savedTo: filePath,
    resultCount: estimateItemCount(payload),
    data: params.save === false ? payload : undefined,
  };
}

async function post(params = {}, context = {}) {
  if (!params.text) {
    throw new Error("text is required");
  }

  const backend = resolveBackend(params, context);
  if (backend === "api") {
    if (params.confirm !== true) {
      throw new Error("confirm:true is required for public X post actions");
    }
    const media = resolveMediaList(params, context);
    const mediaIds = await uploadMediaListApi(media, params.alt, context);
    const body = { text: String(params.text) };
    if (mediaIds.length > 0) body.media = { media_ids: mediaIds };
    const payload = await apiRequest("/tweets", {
      method: "POST",
      authMode: "oauth1",
      body: JSON.stringify(body),
    }, context);
    return {
      success: true,
      backend: "api",
      data: payload,
    };
  }

  const media = resolveMediaList(params, context);
  const result = await runBird("tweet", [String(params.text)], {
    timeoutMs: Number(params.timeoutMs || DEFAULT_TIMEOUT),
    chromeProfile: params.chromeProfile,
    chromeProfileDir: params.chromeProfileDir,
    media,
    alt: params.alt,
  });

  return {
    success: true,
    backend: "bird",
    output: result.stdout,
  };
}

async function deletePost(params = {}, context = {}) {
  const tweetId = params.tweetId || extractTweetId(params.url);
  if (!tweetId) throw new Error("tweetId or url is required");
  if (params.confirm !== true) {
    throw new Error("confirm:true is required for public X delete actions");
  }

  const payload = await apiRequest(`/tweets/${tweetId}`, {
    method: "DELETE",
    authMode: "oauth1",
  }, context);
  return {
    success: true,
    backend: "api",
    data: payload,
  };
}

async function reply(params = {}, context = {}) {
  if ((!params.url && !params.tweetId) || !params.text) {
    throw new Error("tweetId or url plus text is required");
  }

  const backend = resolveBackend(params, context);
  if (backend === "api") {
    if (params.confirm !== true) {
      throw new Error("confirm:true is required for public X reply actions");
    }
    const tweetId = extractTweetId(params.url || params.tweetId);
    const media = resolveMediaList(params, context);
    const mediaIds = await uploadMediaListApi(media, params.alt, context);
    const body = {
      text: String(params.text),
      reply: { in_reply_to_tweet_id: tweetId },
    };
    if (mediaIds.length > 0) body.media = { media_ids: mediaIds };
    const payload = await apiRequest("/tweets", {
      method: "POST",
      authMode: "oauth1",
      body: JSON.stringify(body),
    }, context);
    return {
      success: true,
      backend: "api",
      data: payload,
    };
  }

  const target = params.url || params.tweetId;
  const media = resolveMediaList(params, context);
  const result = await runBird("reply", [String(target), String(params.text)], {
    timeoutMs: Number(params.timeoutMs || DEFAULT_TIMEOUT),
    chromeProfile: params.chromeProfile,
    chromeProfileDir: params.chromeProfileDir,
    media,
    alt: params.alt,
  });

  return {
    success: true,
    backend: "bird",
    output: result.stdout,
  };
}

export async function execute(action, params, context) {
  if (action === "timeline") return timeline(params, context);
  if (action === "read") return read(params, context);
  if (action === "search") return search(params, context);
  if (action === "mentions") return mentions(params, context);
  if (action === "mediaUploadTest") return mediaUploadTest(params, context);
  if (action === "post") return post(params, context);
  if (action === "delete") return deletePost(params, context);
  if (action === "reply") return reply(params, context);
  throw new Error(`Unknown x action: ${action}`);
}
