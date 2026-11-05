import { draftLyrics, generateMusicTrack, resolveOutputDir, writeJsonFile, writeTextFile } from "./core.js";

function resolveMode(params = {}) {
  if (params.mode) return String(params.mode);
  if (params.referenceAudioUrl) return "cover";
  if (params.instrumental === true) return "instrumental";
  return "original";
}

export async function compose(params = {}, context = {}) {
  const mode = resolveMode(params);
  const outputDir = resolveOutputDir(context, "music");
  const title = params.title || params.trackTitle || "music-track";
  const prompt = [params.prompt, params.style, params.mood].filter(Boolean).join(" | ");

  const result = await generateMusicTrack({
    title,
    prompt,
    lyrics: params.lyrics,
    instrumental: mode === "instrumental" || params.instrumental === true,
    referenceAudioUrl: params.referenceAudioUrl,
    model: params.model,
    outputDir,
  }, context);

  const metadataPath = writeJsonFile(outputDir, "music-track", {
    generatedAt: new Date().toISOString(),
    mode,
    ...result,
  });

  return {
    success: true,
    mode,
    title: result.title,
    filePath: result.filePath,
    mimeType: result.mimeType,
    metadataPath,
    generatedLyrics: result.generatedLyrics,
    lyricsPreview: result.lyrics ? result.lyrics.slice(0, 800) : null,
    durationSeconds: result.durationSeconds,
    sampleRate: result.sampleRate,
  };
}

export async function draftLyricsAction(params = {}, context = {}) {
  const prompt = [params.prompt, params.style, params.mood].filter(Boolean).join(" | ");
  const lyrics = await draftLyrics({
    prompt,
    personaNotes: params.personaNotes || "",
    firstPerson: params.firstPerson === true,
  }, context);
  const outputDir = resolveOutputDir(context, "music");
  const savedTo = writeTextFile(outputDir, "lyrics", "txt", lyrics);
  return {
    success: true,
    savedTo,
    lyrics,
  };
}

export async function execute(action, params, context) {
  if (action === "compose") return compose(params, context);
  if (action === "draft-lyrics") return draftLyricsAction(params, context);
  throw new Error(`Unknown minimax-music-gen action: ${action}`);
}
