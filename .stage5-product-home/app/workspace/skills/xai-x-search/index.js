import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const XAI_API_URL = "https://api.x.ai/v1/responses";
const DEFAULT_MODEL = "grok-4.5";
const SKILL_ID = "xai-x-search";
const require = createRequire(import.meta.url);
const yaml = require("js-yaml");

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

function loadSecrets(context = {}) {
  return readYamlFile(path.join(resolveProjectRoot(context), "config", "secrets.yaml"));
}

function getApiKey(context = {}) {
  const secrets = loadSecrets(context);
  const key = secrets?.xai?.apiKey || secrets?.providers?.xai?.apiKey;
  if (!key) {
    throw new Error("xAI API key not found in config/secrets.yaml under xai.apiKey or providers.xai.apiKey");
  }
  return key;
}

function buildXSearchParams(input = {}) {
  const params = {};

  if (input.fromHandle) {
    params.allowed_x_handles = [String(input.fromHandle).replace(/^@/, "")];
  }
  if (input.excludeHandle) {
    params.excluded_x_handles = [String(input.excludeHandle).replace(/^@/, "")];
  }
  if (input.fromDate) {
    params.from_date = String(input.fromDate);
  }
  if (input.toDate) {
    params.to_date = String(input.toDate);
  }
  if (input.enableImageUnderstanding === true) {
    params.enable_image_understanding = true;
  }
  if (input.enableVideoUnderstanding === true) {
    params.enable_video_understanding = true;
  }

  return params;
}

async function callXAI(apiKey, model, systemPrompt, userPrompt, xSearchParams) {
  const body = {
    model: model || DEFAULT_MODEL,
    tools: [
      {
        type: "x_search",
        ...xSearchParams,
      },
    ],
    instructions: systemPrompt,
    input: userPrompt,
  };

  const response = await fetch(XAI_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`xAI API error ${response.status}: ${errText}`);
  }

  return response.json();
}

function extractTextFromResponse(data) {
  // Responses API returns output array with message items
  if (data.output && Array.isArray(data.output)) {
    const messages = data.output.filter((o) => o.type === "message");
    if (messages.length > 0) {
      return messages
        .map((m) =>
          (m.content || [])
            .filter((c) => c.type === "output_text")
            .map((c) => c.text)
            .join("\n")
        )
        .join("\n\n");
    }
    // Fallback: some responses have content directly
    return data.output
      .map((o) => (o.content || []).map((c) => c.text || "").join(""))
      .join("\n");
  }

  // Fallback for chat completions format
  if (data.choices && data.choices.length > 0) {
    return data.choices[0].message?.content || "";
  }

  return JSON.stringify(data, null, 2);
}

function extractCitations(data) {
  const citations = [];
  if (data.output && Array.isArray(data.output)) {
    for (const item of data.output) {
      if (item.content && Array.isArray(item.content)) {
        for (const c of item.content) {
          if (c.citations && Array.isArray(c.citations)) {
            citations.push(...c.citations);
          }
        }
      }
    }
  }
  if (data.citations && Array.isArray(data.citations)) {
    citations.push(...data.citations);
  }
  return citations;
}

function extractToolUsage(data) {
  const usage = {};
  if (data.usage) {
    usage.promptTokens = data.usage.input_tokens || data.usage.prompt_tokens;
    usage.completionTokens = data.usage.output_tokens || data.usage.completion_tokens;
    usage.totalTokens = data.usage.total_tokens;
    usage.costUsd = data.usage.cost_in_usd_ticks
      ? (data.usage.cost_in_usd_ticks / 1_000_000).toFixed(6)
      : undefined;
  }
  if (data.server_side_tool_usage) {
    usage.toolCalls = data.server_side_tool_usage;
  }
  return usage;
}

async function handleSearch(input, context) {
  const apiKey = getApiKey(context);
  const model = input.model || DEFAULT_MODEL;
  const params = buildXSearchParams(input);

  const systemPrompt =
    "You are a research assistant searching X (Twitter) in real-time. " +
    "Find relevant posts about the user's query and synthesize what people are saying. " +
    "Include specific quotes, usernames, and links where possible. " +
    "Be concise but thorough. Highlight key themes and notable takes.";

  const userPrompt = input.query || "What are people talking about on X right now?";

  const data = await callXAI(apiKey, model, systemPrompt, userPrompt, params);
  const text = extractTextFromResponse(data);
  const citations = extractCitations(data);
  const usage = extractToolUsage(data);

  let result = text;
  if (citations.length > 0) {
    result += "\n\n---\n**Sources:**\n";
    citations.forEach((c, i) => {
      result += `${i + 1}. ${c.url || c}\n`;
    });
  }
  if (usage.costUsd) {
    result += `\n_Cost: $${usage.costUsd}_`;
  }

  return {
    ok: true,
    action: "search",
    query: input.query,
    model,
    result,
    citations,
    usage,
  };
}

async function handleThread(input, context) {
  const apiKey = getApiKey(context);
  const model = input.model || DEFAULT_MODEL;

  const systemPrompt =
    "You are a research assistant. The user will give you an X/Twitter URL. " +
    "Use X search to find the thread/conversation around that tweet. " +
    "Summarize the original post, key replies, and notable reactions. " +
    "Include usernames and links.";

  const userPrompt = `Fetch and summarize this X thread: ${input.url}`;

  const data = await callXAI(apiKey, model, systemPrompt, userPrompt, {});
  const text = extractTextFromResponse(data);
  const citations = extractCitations(data);
  const usage = extractToolUsage(data);

  return {
    ok: true,
    action: "thread",
    url: input.url,
    model,
    result: text,
    citations,
    usage,
  };
}

async function handleProfile(input, context) {
  const apiKey = getApiKey(context);
  const model = input.model || DEFAULT_MODEL;
  const username = String(input.username || "").replace(/^@/, "");

  if (!username) {
    return { ok: false, error: "username is required" };
  }

  const params = {
    allowed_x_handles: [username],
  };

  const systemPrompt =
    "You are a research assistant. The user wants to see recent posts from a specific X account. " +
    "Find and summarize their recent posts, main themes, and what they've been talking about. " +
    "Include specific quotes and links where possible.";

  const userPrompt = `What has @${username} been posting about recently? Show their recent posts and summarize their current focus.`;

  const data = await callXAI(apiKey, model, systemPrompt, userPrompt, params);
  const text = extractTextFromResponse(data);
  const citations = extractCitations(data);
  const usage = extractToolUsage(data);

  return {
    ok: true,
    action: "profile",
    username,
    model,
    result: text,
    citations,
    usage,
  };
}

export async function execute(action, input = {}, context = {}) {
  try {
    switch (action) {
      case "search":
        return await handleSearch(input, context);
      case "thread":
        return await handleThread(input, context);
      case "profile":
        return await handleProfile(input, context);
      default:
        return {
          ok: false,
          error: `Unknown action: ${action}. Available: search, thread, profile`,
        };
    }
  } catch (err) {
    return {
      ok: false,
      error: err.message,
      action,
    };
  }
}