import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const STOPWORDS = new Set([
  "about", "after", "again", "agent", "agents", "also", "because", "been", "being", "between", "could", "every", "from", "have", "into", "just", "like", "more", "most", "need", "needs", "only", "over", "than", "that", "their", "there", "these", "thing", "things", "this", "through", "when", "where", "with", "without", "would", "your",
]);

function resolveSkillDir() {
  return path.dirname(fileURLToPath(import.meta.url));
}

function resolveProjectRoot(context = {}) {
  return context?.projectRoot || path.resolve(resolveSkillDir(), "..", "..", "..");
}

function resolveOutputDir(context = {}) {
  if (context?.workspacePath) return path.join(context.workspacePath, "reports", "x-social-distiller");
  return path.join(resolveProjectRoot(context), "workspace", "skills", "x-social-distiller", "outputs");
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function slugify(value, fallback = "source") {
  const slug = String(value || "")
    .replace(/https?:\/\//g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase()
    .slice(0, 70);
  return slug || fallback;
}

function extractTweetId(urlOrId) {
  const value = String(urlOrId || "");
  const match = value.match(/status\/(\d+)/) || value.match(/^(\d{10,})$/);
  return match ? match[1] : null;
}

async function fetchSourceUrl(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Home23 x-social-distiller/0.1",
      Accept: "text/html, text/plain;q=0.9, */*;q=0.5",
    },
  });
  if (!response.ok) throw new Error(`Failed to fetch sourceUrl ${url}: ${response.status} ${response.statusText}`);
  const html = await response.text();
  return htmlToText(html);
}

function htmlToText(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/h[1-6]>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+\n/g, "\n")
    .replace(/\n\s+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function resolveSource(params = {}) {
  if (params.sourceText) return String(params.sourceText);
  if (params.sourcePath) {
    const filePath = String(params.sourcePath);
    if (!path.isAbsolute(filePath)) throw new Error(`sourcePath must be absolute: ${filePath}`);
    return fs.readFileSync(filePath, "utf8");
  }
  if (params.sourceUrl) return fetchSourceUrl(String(params.sourceUrl));
  if (params.topic) return String(params.topic);
  throw new Error("sourceUrl, sourceText, sourcePath, or topic is required");
}

function sentences(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 40 && line.length < 320);
}

function keywordCounts(text) {
  const counts = new Map();
  const words = String(text || "").toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) || [];
  for (const word of words) {
    if (STOPWORDS.has(word)) continue;
    counts.set(word, (counts.get(word) || 0) + 1);
  }
  return counts;
}

function topKeywords(text, limit = 12) {
  return [...keywordCounts(text).entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([word]) => word);
}

function scoreSentence(sentence, keywords) {
  const lower = sentence.toLowerCase();
  let score = 0;
  for (const keyword of keywords) if (lower.includes(keyword)) score += 3;
  if (/memory|state|receipt|verify|stale|agent|workflow|context|projection|claim|evidence|lifecycle/i.test(sentence)) score += 12;
  if (/not |isn't|don't|doesn't|trap|problem|wrong|fail/i.test(sentence)) score += 5;
  if (sentence.length >= 80 && sentence.length <= 220) score += 4;
  return score;
}

function inferTheme(text, params = {}) {
  const topic = params.topic ? String(params.topic) : "";
  const combined = `${topic}\n${text}`.toLowerCase();
  if (/memory|context|stale|remember|recall/.test(combined)) return "agent memory lifecycle";
  if (/newsletter|publish|issue|essay|article/.test(combined)) return "publishing useful AI lessons";
  if (/workflow|handoff|receipt|verify|verification/.test(combined)) return "agent workflow verification";
  if (/model|provider|agnostic|api/.test(combined)) return "model-agnostic AI infrastructure";
  return topic || topKeywords(text, 4).join(" ") || "AI systems";
}

function buildLessonCards(source, params = {}) {
  const theme = inferTheme(source, params);
  const keywords = topKeywords(`${params.topic || ""}\n${source}`, 14);
  const rankedSentences = sentences(source)
    .map((text) => ({ text, score: scoreSentence(text, keywords) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);

  const lessonSeeds = rankedSentences.length > 0 ? rankedSentences : [{ text: String(params.topic || theme), score: 1 }];
  const limit = Math.max(1, Math.min(Number(params.limit || 3), 5));

  return lessonSeeds.slice(0, limit).map((seed, index) => {
    const cardTheme = index === 0 ? theme : `${theme}: ${keywords.slice(index, index + 3).join(" / ")}`;
    const publicProblem = makePublicProblem(cardTheme, seed.text);
    const takeaway = makeTakeaway(cardTheme, seed.text);
    return {
      id: `lesson-${index + 1}`,
      theme: cardTheme,
      sourceSnippet: seed.text,
      publicAudience: params.audience || "AI builders, agent-runtime people, and operators",
      publicProblem,
      usefulTakeaway: takeaway,
      whatNotToOverclaim: "Do not claim the system solves the whole field; present this as a useful operating lesson.",
      searchQueries: makeSearchQueries(cardTheme, keywords),
      standaloneText: makeStandaloneTweet(cardTheme, publicProblem, takeaway),
      replyText: makeReplyDraft(cardTheme, takeaway),
      imagePrompt: makeImagePrompt(cardTheme),
      includeRepoLink: false,
    };
  });
}

function makePublicProblem(theme, seed) {
  if (/memory/.test(theme)) return "Agents keep old context around until stale assumptions become load-bearing.";
  if (/verification|workflow/.test(theme)) return "Autonomous work fails when handoffs lack evidence of what changed and what was verified.";
  if (/model/.test(theme)) return "AI systems break when provider/model details leak into the work instead of staying behind infrastructure.";
  return `People talk about ${theme}, but the useful lesson gets buried under demo language.`;
}

function makeTakeaway(theme, seed) {
  if (/memory/.test(theme)) return "Memory needs lifecycle: verify, revise, expire, compost.";
  if (/verification|workflow/.test(theme)) return "Receipts matter more than vibes: what changed, why, where it lives, and how future-you can trust it.";
  if (/model/.test(theme)) return "Model-agnostic only counts if the work survives provider weirdness, latency, cost, and model disagreement.";
  return String(seed || "Make the lesson useful outside the source artifact.").replace(/\s+/g, " ").slice(0, 180);
}

function makeSearchQueries(theme, keywords) {
  const base = [];
  if (/memory/.test(theme)) {
    base.push('("agent memory" OR "AI memory") (stale OR context OR lifecycle OR persistent) -is:retweet lang:en');
    base.push('("persistent memory" "AI agents") -is:retweet lang:en');
    base.push('("context engineering" memory agents) -is:retweet lang:en');
  } else if (/verification|workflow/.test(theme)) {
    base.push('("AI agents" receipts OR verification OR handoff) -is:retweet lang:en');
    base.push('("agent workflow" verification) -is:retweet lang:en');
  } else if (/model/.test(theme)) {
    base.push('("model agnostic" AI agents) -is:retweet lang:en');
    base.push('("AI infrastructure" provider agnostic) -is:retweet lang:en');
  }
  const keywordQuery = keywords.slice(0, 4).join(" ");
  if (keywordQuery) base.push(`(${keywordQuery}) AI agents -is:retweet lang:en`);
  return [...new Set(base)].slice(0, 4);
}

function makeStandaloneTweet(theme, problem, takeaway) {
  if (/memory/.test(theme)) {
    return "agent memory gets weird when old context becomes trusted context forever\n\nthe useful loop is simple:\n\nverify what changed\nrevise what was wrong\nexpire what got stale\ncompost what no longer helps\n\nmore memory is not the same thing as better continuity";
  }
  if (/verification|workflow/.test(theme)) {
    return "multi-agent systems don’t usually fail because the agents aren’t clever enough\n\nthey fail when nobody can tell what changed, what was verified, what’s blocked, and what should not be retried\n\nthe boring receipt layer is the part that makes autonomy real";
  }
  if (/model/.test(theme)) {
    return "model agnostic doesn’t just mean you can switch API keys\n\nit means the work survives when models disagree, providers get weird, latency changes, or costs spike\n\nif the system stops moving when one model changes, the abstraction wasn’t real yet";
  }
  return `${problem}\n\n${takeaway}`.slice(0, 270);
}

function makeReplyDraft(theme, takeaway) {
  if (/memory/.test(theme)) {
    return "yea. persistent memory is the right direction, but lifecycle is the hard part\n\nif old notes become trusted context forever, you don’t get compounding intelligence. you get stale assumptions with better recall\n\nagents need verify/revise/expire/compost loops";
  }
  if (/verification|workflow/.test(theme)) {
    return "yep. this is where receipts matter\n\nnot just what the agent said it did — what changed, what verified it, what’s blocked, and what future runs should stop trusting\n\nwithout that layer, handoffs turn into vibes fast";
  }
  return `yea, the useful bit imo is: ${takeaway}`.slice(0, 270);
}

function makeImagePrompt(theme) {
  if (/memory/.test(theme)) return "abstract technical illustration of AI memory lifecycle, layered cards and receipts on a desk, fresh records glowing, stale notes composting, small autonomous agents sorting verified context from old assumptions, warm cybernetic home office aesthetic, no text, no logos";
  if (/verification|workflow/.test(theme)) return "abstract technical illustration of autonomous AI agents passing work receipts across a dashboard, checkpoints, verified logs, clean handoff trails, warm cybernetic operations room, no text, no logos";
  return `abstract useful AI infrastructure illustration about ${theme}, warm cybernetic home office aesthetic, no text, no logos`;
}

function scoreCandidate(tweet, card) {
  const text = `${tweet.text || ""}`.toLowerCase();
  const themeWords = topKeywords(`${card.theme} ${card.publicProblem} ${card.usefulTakeaway}`, 12);
  let score = 0;
  for (const word of themeWords) if (text.includes(word)) score += 6;
  const metrics = tweet.metrics || {};
  score += Math.min(35, Math.log10(Number(metrics.impressions || 0) + 1) * 7);
  score += Math.min(25, Math.log10(Number(metrics.likes || 0) + 1) * 8);
  if (tweet.username) score += 3;
  if (/giveaway|airdrop|token|crypto|price|follow for|dm me/i.test(tweet.text || "")) score -= 25;
  if (/agent|memory|context|workflow|verify|receipt|persistent|state/i.test(tweet.text || "")) score += 12;
  return Math.round(score);
}

function normalizeTweetUrl(tweet) {
  return tweet.tweet_url || tweet.url || (tweet.id && tweet.username ? `https://x.com/${tweet.username}/status/${tweet.id}` : undefined);
}

function buildQueue(cards, searchResults, params = {}) {
  const items = [];
  let counter = 1;
  for (const card of cards) {
    const tweets = searchResults[card.id] || [];
    for (const tweet of tweets) {
      const score = scoreCandidate(tweet, card);
      if (score < Number(params.minScore || 25)) continue;
      items.push({
        id: `candidate-${counter++}`,
        kind: "reply",
        score,
        lessonId: card.id,
        reason: `Matches ${card.theme}; useful chance to add lifecycle/receipt framing without link-dropping.`,
        targetUrl: normalizeTweetUrl(tweet),
        targetTweetId: tweet.id,
        targetAuthor: tweet.username,
        targetMetrics: tweet.metrics,
        targetText: tweet.text,
        text: card.replyText,
        fallbackStandaloneText: card.standaloneText,
        imagePrompt: card.imagePrompt,
        includeRepoLink: false,
        riskNotes: ["No repo/newsletter link by default", "Verify read-back before claiming posted"],
      });
    }
    items.push({
      id: `candidate-${counter++}`,
      kind: "post",
      score: 40,
      lessonId: card.id,
      reason: "Standalone useful lesson from source material; use if reply targets are weak or blocked.",
      text: card.standaloneText,
      imagePrompt: card.imagePrompt,
      includeRepoLink: false,
      riskNotes: ["Generated image recommended", "No private internal source claims"],
    });
  }
  return items.sort((a, b) => b.score - a.score);
}

function saveArtifact(context, prefix, data) {
  const outputDir = resolveOutputDir(context);
  ensureDir(outputDir);
  const filePath = path.join(outputDir, `${prefix}-${timestamp()}.json`);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
  return filePath;
}

async function loadSkillRunner(context = {}) {
  const projectRoot = resolveProjectRoot(context);
  const skills = await import(path.join(projectRoot, "workspace", "skills", "index.js"));
  return skills.executeSkill;
}

async function actionDistill(params = {}, context = {}) {
  const source = await resolveSource(params);
  const cards = buildLessonCards(source, params);
  const result = {
    success: true,
    source: {
      sourceUrl: params.sourceUrl,
      sourcePath: params.sourcePath,
      topic: params.topic,
      chars: source.length,
    },
    cards,
  };
  if (params.save !== false) result.savedTo = saveArtifact(context, `distill-${slugify(params.topic || params.sourceUrl)}`, result);
  return result;
}

async function actionSearch(params = {}, context = {}) {
  const executeSkill = await loadSkillRunner(context);
  const distill = await actionDistill({ ...params, save: false }, context);
  const searchResults = {};
  const errors = [];

  for (const card of distill.cards) {
    searchResults[card.id] = [];
    for (const query of card.searchQueries.slice(0, Number(params.queryLimit || 3))) {
      try {
        const result = await executeSkill("x-research", "search", {
          query,
          since: params.since || "7d",
          minLikes: params.minLikes || 10,
          minImpressions: params.minImpressions || 0,
          limit: params.limit || 10,
          pages: params.pages || 1,
          sort: params.sort || "likes",
          includeData: true,
          saveMarkdown: false,
          saveJson: false,
        });
        searchResults[card.id].push(...(result.tweets || []));
      } catch (error) {
        errors.push({ cardId: card.id, query, error: error instanceof Error ? error.message : String(error) });
      }
    }
    const seen = new Set();
    searchResults[card.id] = searchResults[card.id].filter((tweet) => {
      if (!tweet?.id || seen.has(tweet.id)) return false;
      seen.add(tweet.id);
      return true;
    });
  }

  const items = buildQueue(distill.cards, searchResults, params);
  const result = {
    success: true,
    source: distill.source,
    cards: distill.cards,
    errors,
    itemCount: items.length,
    recommendedAction: items[0]?.kind || "skip",
    items: items.slice(0, Math.max(1, Math.min(Number(params.outputLimit || 12), 30))),
  };
  if (params.save !== false) result.queuePath = saveArtifact(context, `queue-${slugify(params.topic || params.sourceUrl)}`, result);
  return result;
}

async function actionQueue(params = {}, context = {}) {
  return actionSearch(params, context);
}

function loadQueue(queuePath) {
  if (!queuePath || !path.isAbsolute(String(queuePath))) throw new Error("queuePath must be absolute");
  return JSON.parse(fs.readFileSync(String(queuePath), "utf8"));
}

function findQueueItem(queue, params = {}) {
  const itemId = params.itemId || params.id;
  if (itemId) {
    const found = (queue.items || []).find((item) => item.id === itemId);
    if (!found) throw new Error(`Queue item not found: ${itemId}`);
    return found;
  }
  const kind = params.mode || params.kind;
  if (kind) {
    const found = (queue.items || []).find((item) => item.kind === kind);
    if (!found) throw new Error(`No queue item found for kind: ${kind}`);
    return found;
  }
  if (!queue.items?.[0]) throw new Error("Queue has no items");
  return queue.items[0];
}

function extractCreatedTweetId(postResult) {
  return postResult?.data?.data?.id || extractTweetId(postResult?.output || "");
}

async function actionPostQueued(params = {}, context = {}) {
  if (params.confirm !== true) throw new Error("confirm:true is required for public X postQueued actions");
  const queue = loadQueue(params.queuePath);
  const item = findQueueItem(queue, params);
  const executeSkill = await loadSkillRunner(context);
  const kind = params.forceMode || params.mode || item.kind;
  const text = params.text || item.text;
  if (!text) throw new Error(`Queue item ${item.id} has no text`);

  const common = {
    text,
    confirm: true,
    backend: params.backend || "api",
    media: params.media,
    alt: params.alt,
    generatedImage: params.generatedImage,
    requireMedia: params.requireMedia,
    requireGeneratedImage: params.requireGeneratedImage,
  };

  let postResult;
  if (kind === "reply") {
    const target = params.targetUrl || item.targetUrl || item.targetTweetId;
    if (!target) throw new Error(`Queue item ${item.id} has no reply target`);
    postResult = await executeSkill("x", "reply", { ...common, url: target });
  } else if (kind === "post") {
    postResult = await executeSkill("x", "post", common);
  } else {
    throw new Error(`Unsupported postQueued kind: ${kind}`);
  }

  const tweetId = extractCreatedTweetId(postResult);
  if (!tweetId) throw new Error(`X write returned no tweet id; not verified. Raw result: ${JSON.stringify(postResult)}`);

  const readBack = await executeSkill("x", "read", { tweetId, backend: "api", save: false });
  return {
    success: true,
    verified: true,
    item,
    tweetId,
    tweetUrl: `https://x.com/i/status/${tweetId}`,
    postResult,
    readBack,
  };
}

export async function execute(action, params = {}, context = {}) {
  if (action === "distill") return actionDistill(params, context);
  if (action === "search") return actionSearch(params, context);
  if (action === "queue") return actionQueue(params, context);
  if (action === "postQueued") return actionPostQueued(params, context);
  throw new Error(`Unknown x-social-distiller action: ${action}`);
}
