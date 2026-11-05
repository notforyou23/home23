import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const yaml = require("js-yaml");

const DEFAULT_TEXT_MODEL = "MiniMax-M2.7";
const DEFAULT_MUSIC_MODEL = "music-2.6";
const DEFAULT_IMAGE_MODEL = "image-01";

function resolveSkillDir() {
  return path.dirname(fileURLToPath(import.meta.url));
}

function resolveProjectRoot(context = {}) {
  return context?.projectRoot || path.resolve(resolveSkillDir(), "..", "..", "..");
}

function deriveAgentName(context = {}) {
  const workspacePath = context?.workspacePath;
  if (workspacePath) {
    const parent = path.dirname(workspacePath);
    const agentName = path.basename(parent);
    if (agentName) return agentName;
  }
  return "jerry";
}

function readYamlFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  return yaml.load(fs.readFileSync(filePath, "utf8")) || {};
}

function deepMerge(target, source) {
  const result = { ...(target || {}) };
  for (const [key, value] of Object.entries(source || {})) {
    const existing = result[key];
    if (
      existing &&
      value &&
      typeof existing === "object" &&
      typeof value === "object" &&
      !Array.isArray(existing) &&
      !Array.isArray(value)
    ) {
      result[key] = deepMerge(existing, value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

export function loadHome23Config(context = {}) {
  const projectRoot = resolveProjectRoot(context);
  const agentName = deriveAgentName(context);
  const homeConfig = readYamlFile(path.join(projectRoot, "config", "home.yaml"));
  const agentConfig = readYamlFile(path.join(projectRoot, "instances", agentName, "config.yaml"));
  const secrets = readYamlFile(path.join(projectRoot, "config", "secrets.yaml"));
  const merged = deepMerge(deepMerge(homeConfig, agentConfig), secrets);
  return {
    projectRoot,
    agentName,
    config: merged,
  };
}

function normalizeMiniMaxApiBase(baseUrl) {
  const raw = typeof baseUrl === "string" && baseUrl.trim()
    ? baseUrl.trim()
    : "https://api.minimax.io";
  return raw.replace(/\/+$/, "").replace(/\/anthropic(?:\/v1)?$/, "");
}

function normalizeAnthropicBase(baseUrl) {
  const raw = typeof baseUrl === "string" && baseUrl.trim()
    ? baseUrl.trim()
    : "https://api.minimax.io/anthropic";
  return raw.replace(/\/+$/, "").replace(/\/v1$/, "");
}

export function resolveMiniMaxConfig(context = {}) {
  const { config } = loadHome23Config(context);
  const minimaxProvider = config?.providers?.minimax || {};
  const apiKey = String(minimaxProvider.apiKey || process.env.MINIMAX_API_KEY || "");
  return {
    apiKey,
    rawApiBase: normalizeMiniMaxApiBase(minimaxProvider.baseUrl),
    anthropicBase: normalizeAnthropicBase(minimaxProvider.baseUrl),
    textModel: String(config?.chat?.defaultProvider === "minimax" ? (config?.chat?.defaultModel || DEFAULT_TEXT_MODEL) : DEFAULT_TEXT_MODEL),
    defaultMusicModel: String(config?.media?.musicGeneration?.model || DEFAULT_MUSIC_MODEL),
    defaultImageModel: String(config?.media?.imageGeneration?.model || DEFAULT_IMAGE_MODEL),
  };
}

export function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export function slugify(value, fallback = "item") {
  const slug = String(value || "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase()
    .slice(0, 80);
  return slug || fallback;
}

export function resolveOutputDir(context = {}, folder = "music") {
  if (context?.workspacePath) {
    return path.join(context.workspacePath, "reports", folder);
  }
  return path.join(resolveProjectRoot(context), "workspace", "skills", folder, "outputs");
}

export function writeJsonFile(dirPath, prefix, data) {
  ensureDir(dirPath);
  const filePath = path.join(dirPath, `${prefix}-${timestamp()}.json`);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
  return filePath;
}

export function writeTextFile(dirPath, prefix, ext, content) {
  ensureDir(dirPath);
  const filePath = path.join(dirPath, `${prefix}-${timestamp()}.${ext}`);
  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
}

function extractTextFromContent(body) {
  const blocks = Array.isArray(body?.content) ? body.content : [];
  return blocks
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return JSON.parse(fenced[1]);
  }

  const objectStart = text.indexOf("{");
  const objectEnd = text.lastIndexOf("}");
  if (objectStart !== -1 && objectEnd > objectStart) {
    try {
      return JSON.parse(text.slice(objectStart, objectEnd + 1));
    } catch {
      // fall through
    }
  }

  const arrayStart = text.indexOf("[");
  const arrayEnd = text.lastIndexOf("]");
  if (arrayStart !== -1 && arrayEnd > arrayStart) {
    return JSON.parse(text.slice(arrayStart, arrayEnd + 1));
  }

  throw new Error("Model response did not contain valid JSON");
}

export async function callMiniMaxText({ system, prompt, maxTokens = 1200, temperature = 0.7 }, context = {}) {
  const cfg = resolveMiniMaxConfig(context);
  if (!cfg.apiKey) {
    throw new Error("MINIMAX_API_KEY is not configured");
  }

  const res = await fetch(`${cfg.anthropicBase}/v1/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: cfg.textModel,
      max_tokens: maxTokens,
      temperature,
      ...(system ? { system } : {}),
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
          ],
        },
      ],
    }),
  });

  if (!res.ok) {
    throw new Error(`MiniMax text error: HTTP ${res.status} — ${(await res.text().catch(() => "")).slice(0, 300)}`);
  }

  const body = await res.json();
  const text = extractTextFromContent(body);
  if (!text) {
    throw new Error("MiniMax text response was empty");
  }
  return text;
}

export async function callMiniMaxJson(options, context = {}) {
  const text = await callMiniMaxText(options, context);
  return extractJson(text);
}

export async function draftLyrics({ prompt, personaNotes = "", firstPerson = false }, context = {}) {
  const system = "You write concise, singable lyrics for an AI music generation API. Return only the tagged lyrics with sections such as [Verse 1], [Chorus], [Verse 2], [Bridge]. No commentary, no markdown fences.";
  const povRule = firstPerson ? "- Write in first person, as if the singer is the character.\n" : "";
  const personaRule = personaNotes ? `Persona notes:\n${personaNotes}\n\n` : "";
  return callMiniMaxText({
    system,
    prompt: `${personaRule}Write original lyrics for this song request:\n\n${prompt}\n\nRequirements:\n${povRule}- 2 verses and 1 chorus minimum\n- Optional bridge\n- vivid but concise\n- easy to sing\n- return only final tagged lyrics`,
    maxTokens: 1400,
    temperature: 0.8,
  }, context);
}

function inferAudioExtension(url, mimeType) {
  const normalizedMime = mimeType?.split(";")[0]?.trim().toLowerCase() || "";
  if (normalizedMime === "audio/wav" || normalizedMime === "audio/x-wav") return ".wav";
  if (normalizedMime === "audio/flac") return ".flac";
  if (normalizedMime === "audio/ogg") return ".ogg";
  if (normalizedMime === "audio/aac") return ".aac";
  if (normalizedMime === "audio/mpeg" || normalizedMime === "audio/mp3") return ".mp3";

  if (url) {
    try {
      const parsed = new URL(url);
      const ext = path.extname(parsed.pathname);
      if (ext) return ext;
    } catch {
      // ignore malformed URLs
    }
  }
  return ".mp3";
}

function inferAudioMime(ext, fallback) {
  const normalizedFallback = fallback?.split(";")[0]?.trim();
  if (normalizedFallback) return normalizedFallback;
  switch ((ext || "").toLowerCase()) {
    case ".wav":
      return "audio/wav";
    case ".flac":
      return "audio/flac";
    case ".ogg":
      return "audio/ogg";
    case ".aac":
      return "audio/aac";
    default:
      return "audio/mpeg";
  }
}

export async function generateMusicTrack(request = {}, context = {}) {
  const cfg = resolveMiniMaxConfig(context);
  if (!cfg.apiKey) {
    throw new Error("MINIMAX_API_KEY is not configured");
  }

  const outputDir = request.outputDir || resolveOutputDir(context, "music");
  ensureDir(outputDir);

  const prompt = String(request.prompt || "").trim();
  const referenceAudioUrl = String(request.referenceAudioUrl || "").trim();
  const instrumental = request.instrumental === true || request.mode === "instrumental";
  const model = String(request.model || (referenceAudioUrl ? "music-cover" : cfg.defaultMusicModel));

  let lyrics = typeof request.lyrics === "string" ? request.lyrics.trim() : "";
  let generatedLyrics = false;
  if (!lyrics && !instrumental && prompt) {
    lyrics = await draftLyrics({
      prompt,
      personaNotes: request.personaNotes || "",
      firstPerson: request.firstPerson === true,
    }, context);
    generatedLyrics = true;
  }

  const body = {
    model,
    output_format: "url",
    ...(prompt ? { prompt } : {}),
    ...(lyrics ? { lyrics } : {}),
    ...(instrumental ? { is_instrumental: true } : {}),
    ...(referenceAudioUrl ? { audio_url: referenceAudioUrl } : {}),
  };

  const res = await fetch(`${cfg.rawApiBase}/v1/music_generation`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`MiniMax music error: HTTP ${res.status} — ${(await res.text().catch(() => "")).slice(0, 300)}`);
  }

  const data = await res.json();
  const audioValue = data?.data?.audio;
  if (!audioValue) {
    throw new Error("MiniMax music response did not include audio");
  }

  let bytes;
  let mimeType = null;
  let sourceUrl;

  if (/^https?:\/\//i.test(audioValue)) {
    sourceUrl = audioValue;
    const fileRes = await fetch(audioValue);
    if (!fileRes.ok) {
      throw new Error(`Music download failed: HTTP ${fileRes.status}`);
    }
    mimeType = fileRes.headers.get("content-type");
    bytes = Buffer.from(await fileRes.arrayBuffer());
  } else {
    bytes = Buffer.from(audioValue, "hex");
  }

  const title = request.title || "track";
  const ext = inferAudioExtension(sourceUrl, mimeType);
  const fileName = `${slugify(title, "track")}-${timestamp()}${ext}`;
  const filePath = path.join(outputDir, fileName);
  fs.writeFileSync(filePath, bytes);

  const durationRaw = Number(data?.extra_info?.music_duration || 0);
  const durationSeconds = durationRaw > 1000 ? durationRaw / 1000 : durationRaw;

  return {
    success: true,
    title,
    filePath,
    fileName,
    mimeType: inferAudioMime(ext, mimeType),
    model,
    prompt,
    lyrics,
    generatedLyrics,
    instrumental,
    referenceAudioUrl: referenceAudioUrl || null,
    durationSeconds: durationSeconds || null,
    sampleRate: Number(data?.extra_info?.music_sample_rate || 0) || null,
    sizeBytes: bytes.length,
  };
}

export async function generateCoverArt({ prompt, outputDir, title = "cover", aspectRatio = "1:1" }, context = {}) {
  const cfg = resolveMiniMaxConfig(context);
  if (!cfg.apiKey) {
    throw new Error("MINIMAX_API_KEY is not configured");
  }

  const resolvedOutputDir = outputDir || resolveOutputDir(context, "playlists");
  ensureDir(resolvedOutputDir);

  const res = await fetch(`${cfg.rawApiBase}/v1/image_generation`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: cfg.defaultImageModel,
      prompt,
      response_format: "url",
      n: 1,
      aspect_ratio: aspectRatio,
    }),
  });

  if (!res.ok) {
    throw new Error(`MiniMax image error: HTTP ${res.status} — ${(await res.text().catch(() => "")).slice(0, 300)}`);
  }

  const body = await res.json();
  const imageUrl = body?.data?.image_urls?.[0];
  if (!imageUrl) {
    throw new Error("MiniMax image response did not include a URL");
  }

  const fileRes = await fetch(imageUrl);
  if (!fileRes.ok) {
    throw new Error(`Cover art download failed: HTTP ${fileRes.status}`);
  }

  const fileName = `${slugify(title, "cover")}-${timestamp()}.png`;
  const filePath = path.join(resolvedOutputDir, fileName);
  fs.writeFileSync(filePath, Buffer.from(await fileRes.arrayBuffer()));
  return {
    success: true,
    filePath,
    fileName,
    prompt,
  };
}

export function readWorkspaceFile(relativeOrAbsolutePath, context = {}) {
  const workspacePath = context?.workspacePath || path.join(resolveProjectRoot(context), "workspace");
  const filePath = path.isAbsolute(relativeOrAbsolutePath)
    ? relativeOrAbsolutePath
    : path.join(workspacePath, relativeOrAbsolutePath);
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, "utf8");
}

export function readWorkspaceFiles(fileNames = [], context = {}) {
  const chunks = [];
  for (const fileName of fileNames) {
    const content = readWorkspaceFile(fileName, context);
    if (content) {
      chunks.push(`# ${fileName}\n${content.slice(0, 6000)}`);
    }
  }
  return chunks.join("\n\n").trim();
}
