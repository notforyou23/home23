import fs from "node:fs";
import path from "node:path";
import {
  callMiniMaxJson,
  callMiniMaxText,
  generateMusicTrack,
  readWorkspaceFile,
  readWorkspaceFiles,
  resolveOutputDir,
  slugify,
  writeJsonFile,
} from "../minimax-music-gen/core.js";

const DEFAULT_PERSONA_FILES = ["SOUL.md", "MISSION.md", "LEARNINGS.md"];

function personaOutputDir(context) {
  return resolveOutputDir(context, "buddy-sings");
}

function profilesDir(context) {
  return path.join(personaOutputDir(context), "profiles");
}

function profilePath(personaName, context) {
  return path.join(profilesDir(context), `${slugify(personaName, "buddy")}.json`);
}

function defaultPersonaName(context = {}) {
  const workspacePath = context?.workspacePath || "";
  const agentDir = workspacePath ? path.basename(path.dirname(workspacePath)) : "jerry";
  return agentDir.charAt(0).toUpperCase() + agentDir.slice(1);
}

function loadPersonaText(params = {}, context = {}) {
  if (params.personaText) return String(params.personaText);
  if (params.personaFile) {
    return readWorkspaceFile(String(params.personaFile), context) || "";
  }
  return readWorkspaceFiles(DEFAULT_PERSONA_FILES, context);
}

async function buildProfile(params = {}, context = {}) {
  const personaName = params.personaName || defaultPersonaName(context);
  const targetPath = profilePath(personaName, context);
  if (params.refresh !== true && fs.existsSync(targetPath)) {
    return JSON.parse(fs.readFileSync(targetPath, "utf8"));
  }

  const personaText = loadPersonaText(params, context);
  const profile = await callMiniMaxJson({
    system: "You turn a character/persona into a reusable singing identity. Return strict JSON only.",
    prompt: `Build a reusable singing persona profile for this character.\n\nPersona name: ${personaName}\n\nSource context:\n${personaText || "(no persona text provided)"}\n\nReturn JSON with this shape:\n{\n  "personaName": string,\n  "stylePrompt": string,\n  "voiceDescriptors": string[],\n  "lyricThemes": string[],\n  "pointOfViewRules": string[],\n  "signatureLine": string\n}`,
    maxTokens: 1200,
    temperature: 0.7,
  }, context);

  fs.mkdirSync(profilesDir(context), { recursive: true });
  fs.writeFileSync(targetPath, JSON.stringify(profile, null, 2), "utf8");
  return profile;
}

export async function profile(params = {}, context = {}) {
  const result = await buildProfile(params, context);
  return {
    success: true,
    ...result,
    savedTo: profilePath(result.personaName || params.personaName || defaultPersonaName(context), context),
  };
}

export async function sing(params = {}, context = {}) {
  const personaProfile = await buildProfile(params, context);
  const personaName = personaProfile.personaName || params.personaName || defaultPersonaName(context);
  const subject = params.subject || params.prompt || "what it feels like to wake up and notice the house breathing around you";
  const contextText = params.contextText ? `Extra context:\n${params.contextText}\n\n` : "";

  const lyrics = await callMiniMaxText({
    system: "You write first-person lyrics for a character song. Return only tagged lyrics for a music generation API.",
    prompt: `Write a song in first person as ${personaName}.\n\nPersona profile:\n${JSON.stringify(personaProfile, null, 2)}\n\n${contextText}Song request:\n${subject}\n\nRequirements:\n- stay in character\n- first person only\n- 2 verses and 1 chorus minimum\n- concise, singable lines\n- return only tagged lyrics`,
    maxTokens: 1400,
    temperature: 0.8,
  }, context);

  const musicPrompt = [
    params.style || personaProfile.stylePrompt,
    `singing as ${personaName}`,
    subject,
  ].filter(Boolean).join(" | ");

  const outputDir = personaOutputDir(context);
  const track = await generateMusicTrack({
    title: params.title || `${personaName} sings`,
    prompt: musicPrompt,
    lyrics,
    instrumental: false,
    outputDir,
    firstPerson: true,
    personaNotes: JSON.stringify(personaProfile),
  }, context);

  const metadataPath = writeJsonFile(outputDir, "buddy-song", {
    generatedAt: new Date().toISOString(),
    personaProfile,
    subject,
    contextText: params.contextText || "",
    ...track,
  });

  return {
    success: true,
    personaName,
    filePath: track.filePath,
    metadataPath,
    generatedLyrics: track.generatedLyrics,
    lyricsPreview: track.lyrics.slice(0, 800),
    stylePrompt: personaProfile.stylePrompt,
    signatureLine: personaProfile.signatureLine || null,
  };
}

export async function execute(action, params, context) {
  if (action === "profile") return profile(params, context);
  if (action === "sing") return sing(params, context);
  throw new Error(`Unknown buddy-sings action: ${action}`);
}
