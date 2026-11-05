import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const BASE_URL = "https://api.x.com/2";
const RATE_DELAY_MS = 350;
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_CACHE_TTL_MS = 15 * 60 * 1000;
const SKILL_ID = "x-research";
const require = createRequire(import.meta.url);
const yaml = require("js-yaml");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function slugify(value, fallback = "query") {
  const slug = String(value || "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase()
    .slice(0, 60);
  return slug || fallback;
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

function loadHome23Config(context = {}) {
  return readYamlFile(path.join(resolveProjectRoot(context), "config", "home.yaml"));
}

function loadHome23Secrets(context = {}) {
  return readYamlFile(path.join(resolveProjectRoot(context), "config", "secrets.yaml"));
}

function getSkillHostConfig(context = {}) {
  const homeConfig = loadHome23Config(context);
  const stored = homeConfig.skills?.[SKILL_ID] || {};
  const defaults = stored.defaults && typeof stored.defaults === "object" ? stored.defaults : {};
  return {
    defaults: {
      quick: defaults.quick === true,
      saveMarkdown: defaults.saveMarkdown !== false,
    },
  };
}

function resolveDataDir() {
  return path.join(resolveSkillDir(), "data");
}

function resolveCacheDir() {
  return path.join(resolveDataDir(), "cache");
}

function resolveWatchlistPath() {
  return path.join(resolveDataDir(), "watchlist.json");
}

function resolveOutputDir(context) {
  if (context?.workspacePath) {
    return path.join(context.workspacePath, "reports", "x-research");
  }
  const projectRoot = context?.projectRoot || process.cwd();
  return path.join(projectRoot, "workspace", "skills", "x-research", "outputs");
}

function writeJsonFile(dirPath, prefix, data) {
  ensureDir(dirPath);
  const filePath = path.join(dirPath, `${prefix}-${timestamp()}.json`);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
  return filePath;
}

function writeTextFile(dirPath, prefix, ext, content) {
  ensureDir(dirPath);
  const filePath = path.join(dirPath, `${prefix}-${timestamp()}.${ext}`);
  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
}

function compactNumber(value) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

function timeAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function cleanTweetText(text) {
  return String(text || "").replace(/https:\/\/t\.co\/\S+/g, "").trim();
}

function parseSince(since) {
  const match = String(since || "").match(/^(\d+)(m|h|d)$/);
  if (match) {
    const num = Number(match[1]);
    const unit = match[2];
    const ms = unit === "m" ? num * 60_000 : unit === "h" ? num * 3_600_000 : num * 86_400_000;
    return new Date(Date.now() - ms).toISOString();
  }

  if (String(since || "").includes("T") || String(since || "").includes("-")) {
    const parsed = new Date(since);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }

  return null;
}

function getToken(context = {}) {
  if (process.env.X_BEARER_TOKEN) return process.env.X_BEARER_TOKEN;

  try {
    const secrets = loadHome23Secrets(context);
    const configured = secrets.skills?.[SKILL_ID]?.bearerToken;
    if (configured) return String(configured);
  } catch {
    // ignore
  }

  try {
    const globalEnv = fs.readFileSync(path.join(process.env.HOME || "", ".config", "env", "global.env"), "utf8");
    const match = globalEnv.match(/X_BEARER_TOKEN=["']?([^"'\n]+)/);
    if (match) return match[1];
  } catch {
    // ignore
  }

  throw new Error("X_BEARER_TOKEN not found in env or ~/.config/env/global.env");
}

async function apiGet(url) {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${getToken()}`,
    },
  });

  if (res.status === 429) {
    const reset = res.headers.get("x-rate-limit-reset");
    const waitSec = reset
      ? Math.max(Number(reset) - Math.floor(Date.now() / 1000), 1)
      : 60;
    throw new Error(`Rate limited by X API. Resets in ${waitSec}s`);
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`X API ${res.status}: ${body.slice(0, 200)}`);
  }

  return res.json();
}

const TWEET_FIELDS = "tweet.fields=created_at,public_metrics,author_id,conversation_id,entities&expansions=author_id&user.fields=username,name,public_metrics";

function parseTweets(raw) {
  if (!raw?.data) return [];

  const userMap = {};
  for (const user of raw.includes?.users || []) {
    userMap[user.id] = user;
  }

  const data = Array.isArray(raw.data) ? raw.data : [raw.data];
  return data.map((tweet) => {
    const user = userMap[tweet.author_id] || {};
    const metrics = tweet.public_metrics || {};
    return {
      id: tweet.id,
      text: tweet.text,
      author_id: tweet.author_id,
      username: user.username || "?",
      name: user.name || "?",
      created_at: tweet.created_at,
      conversation_id: tweet.conversation_id,
      metrics: {
        likes: metrics.like_count || 0,
        retweets: metrics.retweet_count || 0,
        replies: metrics.reply_count || 0,
        quotes: metrics.quote_count || 0,
        impressions: metrics.impression_count || 0,
        bookmarks: metrics.bookmark_count || 0,
      },
      urls: (tweet.entities?.urls || []).map((entry) => entry.expanded_url).filter(Boolean),
      mentions: (tweet.entities?.mentions || []).map((entry) => entry.username).filter(Boolean),
      hashtags: (tweet.entities?.hashtags || []).map((entry) => entry.tag).filter(Boolean),
      tweet_url: `https://x.com/${user.username || "i"}/status/${tweet.id}`,
    };
  });
}

function dedupeTweets(tweets) {
  const seen = new Set();
  return tweets.filter((tweet) => {
    if (seen.has(tweet.id)) return false;
    seen.add(tweet.id);
    return true;
  });
}

function sortTweets(tweets, metric = "likes") {
  return [...tweets].sort((a, b) => (b.metrics?.[metric] || 0) - (a.metrics?.[metric] || 0));
}

function filterEngagement(tweets, options = {}) {
  return tweets.filter((tweet) => {
    if (options.minLikes && tweet.metrics.likes < options.minLikes) return false;
    if (options.minImpressions && tweet.metrics.impressions < options.minImpressions) return false;
    return true;
  });
}

function cacheFileFor(query, params) {
  const hash = crypto.createHash("md5").update(`${query}|${params}`).digest("hex").slice(0, 12);
  return path.join(resolveCacheDir(), `${hash}.json`);
}

function getCachedTweets(query, params, ttlMs = DEFAULT_CACHE_TTL_MS) {
  ensureDir(resolveCacheDir());
  const filePath = cacheFileFor(query, params);
  if (!fs.existsSync(filePath)) return null;

  try {
    const entry = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (Date.now() - entry.timestamp > ttlMs) {
      fs.unlinkSync(filePath);
      return null;
    }
    return entry.tweets;
  } catch {
    return null;
  }
}

function setCachedTweets(query, params, tweets) {
  ensureDir(resolveCacheDir());
  fs.writeFileSync(cacheFileFor(query, params), JSON.stringify({
    query,
    params,
    timestamp: Date.now(),
    tweets,
  }, null, 2), "utf8");
}

function clearCache() {
  ensureDir(resolveCacheDir());
  const files = fs.readdirSync(resolveCacheDir()).filter((file) => file.endsWith(".json"));
  for (const file of files) {
    try {
      fs.unlinkSync(path.join(resolveCacheDir(), file));
    } catch {
      // ignore
    }
  }
  return files.length;
}

async function searchTweets(query, options = {}) {
  const maxResults = Math.max(Math.min(Number(options.maxResults || DEFAULT_PAGE_SIZE), DEFAULT_PAGE_SIZE), 10);
  const pages = Math.max(1, Math.min(Number(options.pages || 1), 5));
  const sortOrder = options.sortOrder || "relevancy";
  const encodedQuery = encodeURIComponent(query);
  const startTime = options.since ? parseSince(options.since) : null;
  const timeFilter = startTime ? `&start_time=${startTime}` : "";

  let nextToken;
  let allTweets = [];

  for (let page = 0; page < pages; page++) {
    const pagination = nextToken ? `&pagination_token=${nextToken}` : "";
    const url = `${BASE_URL}/tweets/search/recent?query=${encodedQuery}&max_results=${maxResults}&${TWEET_FIELDS}&sort_order=${sortOrder}${timeFilter}${pagination}`;
    const raw = await apiGet(url);
    allTweets.push(...parseTweets(raw));
    nextToken = raw.meta?.next_token;
    if (!nextToken) break;
    if (page < pages - 1) await sleep(RATE_DELAY_MS);
  }

  return allTweets;
}

async function getTweet(tweetId) {
  const url = `${BASE_URL}/tweets/${tweetId}?${TWEET_FIELDS}`;
  const raw = await apiGet(url);
  const tweets = parseTweets(raw);
  return tweets[0] || null;
}

async function getThread(conversationId, options = {}) {
  const tweets = await searchTweets(`conversation_id:${conversationId}`, {
    pages: options.pages || 2,
    sortOrder: "recency",
  });

  try {
    const rootTweet = await getTweet(conversationId);
    if (rootTweet) {
      tweets.unshift(rootTweet);
    }
  } catch {
    // root tweet may be unavailable
  }

  return dedupeTweets(tweets);
}

async function getProfile(username, options = {}) {
  const cleanUsername = String(username || "").replace(/^@/, "");
  const userUrl = `${BASE_URL}/users/by/username/${cleanUsername}?user.fields=public_metrics,description,created_at`;
  const userData = await apiGet(userUrl);
  if (!userData?.data) {
    throw new Error(`User @${cleanUsername} not found`);
  }

  await sleep(RATE_DELAY_MS);
  const replyFilter = options.includeReplies ? "" : " -is:reply";
  const tweets = await searchTweets(`from:${cleanUsername} -is:retweet${replyFilter}`, {
    maxResults: Math.min(Number(options.count || 20), DEFAULT_PAGE_SIZE),
    sortOrder: "recency",
  });

  return {
    user: userData.data,
    tweets,
  };
}

function formatTweetText(tweet, options = {}) {
  const prefix = options.index != null ? `${options.index + 1}. ` : "";
  const engagement = `${compactNumber(tweet.metrics.likes)}L ${compactNumber(tweet.metrics.impressions)}I`;
  const time = timeAgo(tweet.created_at);
  const text = options.full || tweet.text.length <= 200 ? tweet.text : `${tweet.text.slice(0, 197)}...`;
  let output = `${prefix}@${tweet.username} (${engagement} · ${time})\n${cleanTweetText(text)}`;
  if (tweet.urls.length > 0) {
    output += `\n${tweet.urls[0]}`;
  }
  output += `\n${tweet.tweet_url}`;
  return output;
}

function formatTweetMarkdown(tweet) {
  let output = `- **@${tweet.username}** (${tweet.metrics.likes}L ${tweet.metrics.impressions}I) [Tweet](${tweet.tweet_url})\n`;
  output += `  > ${cleanTweetText(tweet.text).replace(/\n/g, "\n  > ")}`;
  if (tweet.urls.length > 0) {
    output += `\n  Links: ${tweet.urls.join(", ")}`;
  }
  return output;
}

function formatResearchMarkdown(title, tweets, meta = {}) {
  const date = new Date().toISOString().split("T")[0];
  let output = `# X Research: ${title}\n\n`;
  output += `**Date:** ${date}\n`;
  output += `**Tweets found:** ${tweets.length}\n`;
  if (meta.estimatedCostUsd != null) {
    output += `**Estimated cost:** ~$${Number(meta.estimatedCostUsd).toFixed(2)}\n`;
  }
  output += "\n## Results\n\n";
  output += tweets.slice(0, 30).map(formatTweetMarkdown).join("\n\n");
  output += "\n\n---\n\n## Metadata\n";
  if (meta.query) output += `- Query: \`${meta.query}\`\n`;
  if (meta.queries?.length) {
    output += "- Queries:\n";
    for (const query of meta.queries) {
      output += `  - \`${query}\`\n`;
    }
  }
  if (meta.username) output += `- Username: @${meta.username}\n`;
  if (meta.tweetId) output += `- Tweet ID: ${meta.tweetId}\n`;
  output += `- Tweets scanned: ${tweets.length}\n`;
  return output;
}

function ensureWatchlistFile() {
  ensureDir(resolveDataDir());
  const watchlistPath = resolveWatchlistPath();
  if (!fs.existsSync(watchlistPath)) {
    fs.writeFileSync(watchlistPath, JSON.stringify({ accounts: [] }, null, 2), "utf8");
  }
}

function loadWatchlist() {
  ensureWatchlistFile();
  return JSON.parse(fs.readFileSync(resolveWatchlistPath(), "utf8"));
}

function saveWatchlist(data) {
  ensureWatchlistFile();
  fs.writeFileSync(resolveWatchlistPath(), JSON.stringify(data, null, 2), "utf8");
}

function parseTweetId(target) {
  if (!target) return null;
  const value = String(target).trim();
  const match = value.match(/status\/(\d+)/);
  return match ? match[1] : value.replace(/\D/g, "") || value;
}

function buildSearchQuery(params = {}) {
  const quick = Boolean(params.quick);
  const noRetweets = Boolean(params.noRetweets);
  const noReplies = Boolean(params.noReplies);
  const fromUser = params.from ? String(params.from).replace(/^@/, "") : "";
  let query = String(params.query || "").trim();

  if (!query) {
    throw new Error("query is required");
  }

  if (fromUser && !query.toLowerCase().includes("from:")) {
    query += ` from:${fromUser}`;
  }
  if (!query.includes("is:retweet") && !noRetweets) {
    query += " -is:retweet";
  }
  if ((quick || noReplies) && !query.includes("is:reply")) {
    query += " -is:reply";
  }

  return query;
}

function resolveSaveMarkdown(params, context) {
  if (params.saveMarkdown !== undefined) return params.saveMarkdown !== false;
  return getSkillHostConfig(context).defaults.saveMarkdown !== false;
}

function resolveSearchQuick(params, context) {
  if (params.quick !== undefined) return params.quick === true;
  return getSkillHostConfig(context).defaults.quick === true;
}

async function actionSearch(params = {}, context = {}) {
  const outputDir = resolveOutputDir(context);
  const quick = resolveSearchQuick(params, context);
  const sort = String(params.sort || "likes");
  const pages = quick ? 1 : Math.max(1, Math.min(Number(params.pages || 1), 5));
  const limit = quick ? Math.min(Number(params.limit || 10), 10) : Math.max(1, Math.min(Number(params.limit || 15), 50));
  const cacheTtlMs = quick ? 3_600_000 : DEFAULT_CACHE_TTL_MS;
  const finalQuery = buildSearchQuery(params);
  const cacheParams = `sort=${sort}&pages=${pages}&since=${params.since || "7d"}`;
  let tweets = getCachedTweets(finalQuery, cacheParams, cacheTtlMs);
  let cached = true;

  if (!tweets) {
    cached = false;
    tweets = await searchTweets(finalQuery, {
      pages,
      sortOrder: sort === "recent" ? "recency" : "relevancy",
      since: params.since,
    });
    setCachedTweets(finalQuery, cacheParams, tweets);
  }

  const rawTweetCount = tweets.length;
  if (params.minLikes || params.minImpressions) {
    tweets = filterEngagement(tweets, {
      minLikes: Number(params.minLikes || 0) || undefined,
      minImpressions: Number(params.minImpressions || 0) || undefined,
    });
  }
  if (params.quality) {
    tweets = filterEngagement(tweets, { minLikes: 10 });
  }
  if (sort !== "recent") {
    tweets = sortTweets(tweets, sort);
  }
  tweets = dedupeTweets(tweets);

  const shownTweets = tweets.slice(0, limit);
  const estimatedCostUsd = rawTweetCount * 0.005;
  const result = {
    success: true,
    query: finalQuery,
    cached,
    quick,
    sort,
    pages,
    resultCount: tweets.length,
    shownCount: shownTweets.length,
    estimatedCostUsd,
    tweets: params.includeData === true ? shownTweets : undefined,
  };

  if (params.saveJson) {
    result.savedJsonTo = writeJsonFile(outputDir, `search-${slugify(finalQuery)}`, {
      query: finalQuery,
      generatedAt: new Date().toISOString(),
      cached,
      quick,
      sort,
      pages,
      rawTweetCount,
      tweets,
    });
  }

  if (resolveSaveMarkdown(params, context)) {
    result.savedMarkdownTo = writeTextFile(
      outputDir,
      `search-${slugify(finalQuery)}`,
      "md",
      formatResearchMarkdown(finalQuery, shownTweets, {
        query: finalQuery,
        queries: [finalQuery],
        estimatedCostUsd,
      }),
    );
  }

  return result;
}

async function actionThread(params = {}, context = {}) {
  const tweetId = parseTweetId(params.tweetId || params.url);
  if (!tweetId) {
    throw new Error("tweetId or url is required");
  }

  const outputDir = resolveOutputDir(context);
  const tweets = await getThread(tweetId, { pages: Math.max(1, Math.min(Number(params.pages || 2), 5)) });
  const result = {
    success: true,
    tweetId,
    resultCount: tweets.length,
    tweets: params.includeData === true ? tweets : undefined,
  };

  if (params.saveJson) {
    result.savedJsonTo = writeJsonFile(outputDir, `thread-${tweetId}`, {
      tweetId,
      generatedAt: new Date().toISOString(),
      tweets,
    });
  }
  if (resolveSaveMarkdown(params, context)) {
    result.savedMarkdownTo = writeTextFile(
      outputDir,
      `thread-${tweetId}`,
      "md",
      formatResearchMarkdown(`thread ${tweetId}`, tweets, { tweetId }),
    );
  }

  return result;
}

async function actionProfile(params = {}, context = {}) {
  const username = String(params.username || "").replace(/^@/, "");
  if (!username) {
    throw new Error("username is required");
  }

  const outputDir = resolveOutputDir(context);
  const profile = await getProfile(username, {
    count: params.count,
    includeReplies: params.includeReplies,
  });
  const result = {
    success: true,
    username,
    tweetCount: profile.tweets.length,
    user: params.includeData === true ? profile.user : undefined,
    tweets: params.includeData === true ? profile.tweets : undefined,
  };

  if (params.saveJson) {
    result.savedJsonTo = writeJsonFile(outputDir, `profile-${username}`, {
      username,
      generatedAt: new Date().toISOString(),
      ...profile,
    });
  }
  if (resolveSaveMarkdown(params, context)) {
    result.savedMarkdownTo = writeTextFile(
      outputDir,
      `profile-${username}`,
      "md",
      formatResearchMarkdown(`@${username}`, profile.tweets, { username }),
    );
  }

  return result;
}

async function actionTweet(params = {}, context = {}) {
  const tweetId = parseTweetId(params.tweetId || params.url);
  if (!tweetId) {
    throw new Error("tweetId or url is required");
  }

  const tweet = await getTweet(tweetId);
  if (!tweet) {
    throw new Error(`Tweet ${tweetId} not found`);
  }

  const outputDir = resolveOutputDir(context);
  const result = {
    success: true,
    tweetId,
    formatted: formatTweetText(tweet, { full: true }),
    tweet: params.includeData === true ? tweet : undefined,
  };

  if (params.saveJson) {
    result.savedJsonTo = writeJsonFile(outputDir, `tweet-${tweetId}`, tweet);
  }
  if (resolveSaveMarkdown(params, context)) {
    result.savedMarkdownTo = writeTextFile(
      outputDir,
      `tweet-${tweetId}`,
      "md",
      formatResearchMarkdown(`tweet ${tweetId}`, [tweet], { tweetId }),
    );
  }

  return result;
}

async function actionWatchlistShow() {
  const watchlist = loadWatchlist();
  return {
    success: true,
    count: watchlist.accounts.length,
    accounts: watchlist.accounts,
  };
}

async function actionWatchlistAdd(params = {}) {
  const username = String(params.username || "").replace(/^@/, "");
  if (!username) {
    throw new Error("username is required");
  }

  const watchlist = loadWatchlist();
  if (watchlist.accounts.some((account) => account.username.toLowerCase() === username.toLowerCase())) {
    return {
      success: true,
      added: false,
      message: `@${username} already on watchlist.`,
      count: watchlist.accounts.length,
    };
  }

  watchlist.accounts.push({
    username,
    note: params.note ? String(params.note) : undefined,
    addedAt: new Date().toISOString(),
  });
  saveWatchlist(watchlist);

  return {
    success: true,
    added: true,
    count: watchlist.accounts.length,
    accounts: watchlist.accounts,
  };
}

async function actionWatchlistRemove(params = {}) {
  const username = String(params.username || "").replace(/^@/, "");
  if (!username) {
    throw new Error("username is required");
  }

  const watchlist = loadWatchlist();
  const before = watchlist.accounts.length;
  watchlist.accounts = watchlist.accounts.filter((account) => account.username.toLowerCase() !== username.toLowerCase());
  saveWatchlist(watchlist);

  return {
    success: true,
    removed: watchlist.accounts.length < before,
    count: watchlist.accounts.length,
    accounts: watchlist.accounts,
  };
}

async function actionWatchlistCheck(params = {}, context = {}) {
  const watchlist = loadWatchlist();
  if (watchlist.accounts.length === 0) {
    return {
      success: true,
      count: 0,
      accounts: [],
      message: "Watchlist is empty.",
    };
  }

  const outputDir = resolveOutputDir(context);
  const count = Math.max(1, Math.min(Number(params.count || 5), 20));
  const reports = [];

  for (const account of watchlist.accounts) {
    try {
      const profile = await getProfile(account.username, { count });
      reports.push({
        username: account.username,
        note: account.note || "",
        ok: true,
        tweetCount: profile.tweets.length,
        tweets: params.includeData === true ? profile.tweets.slice(0, 3) : undefined,
      });
    } catch (error) {
      reports.push({
        username: account.username,
        note: account.note || "",
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const lines = ["# X Research Watchlist Check", "", `Generated: ${new Date().toISOString()}`, ""];
  for (const report of reports) {
    const label = report.note ? ` (${report.note})` : "";
    if (!report.ok) {
      lines.push(`## @${report.username}${label}`);
      lines.push("");
      lines.push(`Error: ${report.error}`);
      lines.push("");
      continue;
    }
    lines.push(`## @${report.username}${label}`);
    lines.push("");
    lines.push(`Recent tweets captured: ${report.tweetCount}`);
    lines.push("");
  }

  const result = {
    success: true,
    count: reports.length,
    reports,
  };

  if (resolveSaveMarkdown(params, context)) {
    result.savedMarkdownTo = writeTextFile(outputDir, "watchlist-check", "md", lines.join("\n"));
  }

  return result;
}

async function actionCacheClear() {
  return {
    success: true,
    removed: clearCache(),
  };
}

export async function execute(action, params = {}, context = {}) {
  if (action === "search") return actionSearch(params, context);
  if (action === "thread") return actionThread(params, context);
  if (action === "profile") return actionProfile(params, context);
  if (action === "tweet") return actionTweet(params, context);
  if (action === "watchlist_show") return actionWatchlistShow(params, context);
  if (action === "watchlist_add") return actionWatchlistAdd(params, context);
  if (action === "watchlist_remove") return actionWatchlistRemove(params, context);
  if (action === "watchlist_check") return actionWatchlistCheck(params, context);
  if (action === "cache_clear") return actionCacheClear(params, context);
  throw new Error(`Unknown x-research action: ${action}`);
}
