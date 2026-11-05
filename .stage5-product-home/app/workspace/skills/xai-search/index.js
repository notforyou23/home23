import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const yaml = require("js-yaml");

const BASE_URL = "https://api.x.ai/v1";
const DEFAULT_MODEL = "grok-4.5";
const SKILL_ID = "xai-search";

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

function getApiKey(context = {}) {
  if (process.env.XAI_API_KEY) return process.env.XAI_API_KEY;

  const secrets = readYamlFile(path.join(resolveProjectRoot(context), "config", "secrets.yaml"));
  const key = secrets.xai?.apiKey || secrets.providers?.xai?.apiKey;
  if (key) return String(key);

  throw new Error("xAI API key not found. Set XAI_API_KEY or add xai.apiKey to config/secrets.yaml");
}

/**
 * Call the xAI Responses API with a server-side tool (x_search or web_search).
 * Grok searches X or the web in real-time and returns a synthesized answer with citations.
 */
async function xaiResponsesSearch({ query, tool, model, allowedXHandles, excludedXHandles, fromDate, toDate }, context = {}) {
  const apiKey = getApiKey(context);
  const useModel = model || DEFAULT_MODEL;

  const tools = [];
  if (tool === "x_search") {
    const xSearchConfig = { type: "x_search" };
    if (allowedXHandles?.length) xSearchConfig.allowed_x_handles = allowedXHandles;
    if (excludedXHandles?.length) xSearchConfig.excluded_x_handles = excludedXHandles;
    if (fromDate) xSearchConfig.from_date = fromDate;
    if (toDate) xSearchConfig.to_date = toDate;
    // Note: xAI does not support max_search_results — Grok decides result count based on query scope
    tools.push(xSearchConfig);
  } else if (tool === "web_search") {
    tools.push({ type: "web_search" });
  } else {
    throw new Error(`Unknown search tool: ${tool}. Use "x_search" or "web_search".`);
  }

  const body = {
    model: useModel,
    instructions: "You are a research assistant. Search and report what you find accurately. Cite sources. Be concise but thorough. Do not make things up.",
    input: query,
    tools,
    tool_choice: "required",
  };

  const res = await fetch(`${BASE_URL}/responses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`xAI API ${res.status}: ${errBody.slice(0, 500)}`);
  }

  return res.json();
}

/**
 * Extract the synthesized text and any citation URLs from the Responses API output.
 */
function extractResult(raw) {
  // The Responses API returns output items. We want the message content and any tool call results.
  const output = raw?.output || [];
  let text = "";
  const citations = [];
  const searchResults = [];

  for (const item of output) {
    if (item.type === "message" && item.content) {
      for (const block of item.content) {
        if (block.type === "output_text" || block.type === "text") {
          text += block.text || "";
          if (block.citations) {
            for (const cite of block.citations) {
              if (cite.url) citations.push({ url: cite.url, title: cite.title || cite.uri || "" });
            }
          }
        }
      }
    }
    if (item.type === "x_search_call" || item.type === "web_search_call") {
      // Tool call — may contain the raw search results
      if (item.action?.queries) searchResults.push({ tool: item.type, queries: item.action.queries });
      if (item.results) searchResults.push({ tool: item.type, results: item.results });
    }
  }

  // Fallback: if the API returns a simple choices array (chat completions format)
  if (!text && raw?.choices?.[0]?.message?.content) {
    text = raw.choices[0].message.content;
  }

  // Fallback: if text is in the top-level output_text
  if (!text && raw?.output_text) {
    text = raw.output_text;
  }

  return { text: text.trim(), citations, searchResults, raw };
}

/**
 * Format the result for human-readable output.
 */
function formatResult({ text, citations, searchResults }) {
  let out = text || "(no output)";

  if (citations.length > 0) {
    out += "\n\n---\nSources:";
    for (const cite of citations) {
      out += `\n• ${cite.title ? cite.title + " — " : ""}${cite.url}`;
    }
  }

  if (searchResults.length > 0) {
    out += "\n\nSearch queries used:";
    for (const sr of searchResults) {
      if (sr.queries) out += `\n• [${sr.tool}] ${sr.queries.join(", ")}`;
    }
  }

  return out;
}

// --- Actions ---

const actions = {
  /**
   * Search X/Twitter using Grok's built-in x_search tool.
   *
   * Input:
   * {
   *   "query": "AI agents memory persistence",
   *   "allowedXHandles": ["elonmusk"],       // optional: restrict to these handles
   *   "excludedXHandles": ["spambot"],       // optional: exclude these handles
   *   "fromDate": "2026-07-01",              // optional: ISO date
   *   "toDate": "2026-07-23",                // optional: ISO date
   *   "model": "grok-4.5"                    // optional
   * }
   */
  async search(input = {}, context = {}) {
    if (!input.query) throw new Error("query is required");
    const raw = await xaiResponsesSearch({ ...input, tool: "x_search" }, context);
    const result = extractResult(raw);
    return {
      ok: true,
      action: "search",
      query: input.query,
      answer: formatResult(result),
      citations: result.citations,
      searchResults: result.searchResults,
    };
  },

  /**
   * Search the web using Grok's built-in web_search tool.
   *
   * Input:
   * {
   *   "query": "latest AI agent frameworks 2026",
   *   "model": "grok-4.5"                    // optional
   * }
   */
  async web_search(input = {}, context = {}) {
    if (!input.query) throw new Error("query is required");
    const raw = await xaiResponsesSearch({ ...input, tool: "web_search" }, context);
    const result = extractResult(raw);
    return {
      ok: true,
      action: "web_search",
      query: input.query,
      answer: formatResult(result),
      citations: result.citations,
      searchResults: result.searchResults,
    };
  },
};

export default actions;