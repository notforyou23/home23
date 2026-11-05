import {
  callMiniMaxJson,
  generateCoverArt,
  generateMusicTrack,
  resolveOutputDir,
  slugify,
  writeJsonFile,
} from "../minimax-music-gen/core.js";

function playlistOutputDir(context) {
  return resolveOutputDir(context, "playlists");
}

async function buildTasteProfile(params = {}, context = {}) {
  if (params.tasteProfile && typeof params.tasteProfile === "object") {
    return params.tasteProfile;
  }

  const brief = [
    params.brief,
    params.favoriteArtists ? `Favorite artists: ${params.favoriteArtists}` : "",
    params.favoriteSongs ? `Favorite songs: ${params.favoriteSongs}` : "",
    params.moods ? `Desired moods: ${params.moods}` : "",
  ].filter(Boolean).join("\n");

  return callMiniMaxJson({
    system: "You build compact but actionable music taste profiles. Return strict JSON only.",
    prompt: `Turn this listening brief into a music taste profile.\n\n${brief}\n\nReturn JSON with this shape:\n{\n  "listenerSummary": string,\n  "genres": string[],\n  "moods": string[],\n  "energyCurve": string,\n  "vocalPreference": string,\n  "productionHints": string[],\n  "referenceArtists": string[]\n}`,
    maxTokens: 1000,
    temperature: 0.6,
  }, context);
}

async function buildPlaylistPlan(params = {}, context = {}) {
  const count = Math.max(1, Math.min(Number(params.count || 3), 5));
  const tasteProfile = await buildTasteProfile(params, context);
  const instrumentalRatio = params.includeInstrumentals ? "Include one instrumental if it fits." : "Prefer vocal tracks unless the brief strongly suggests an instrumental.";

  const plan = await callMiniMaxJson({
    system: "You design compact AI music playlists. Return strict JSON only.",
    prompt: `Create a ${count}-track custom playlist plan.\n\nTaste profile:\n${JSON.stringify(tasteProfile, null, 2)}\n\nPlaylist brief:\n${params.brief || "No extra brief provided."}\n\nRules:\n- each track should feel distinct but coherent with the whole\n- give every track a title\n- include a short concept\n- include a generation prompt suitable for a music model\n- mark whether the track should be instrumental\n- include one playlist-level coverArtPrompt\n- return strict JSON with:\n{\n  "playlistTitle": string,\n  "playlistSummary": string,\n  "coverArtPrompt": string,\n  "tracks": [{ "title": string, "concept": string, "prompt": string, "instrumental": boolean }]\n}\n\n${instrumentalRatio}`,
    maxTokens: 1600,
    temperature: 0.75,
  }, context);

  return {
    count,
    tasteProfile,
    ...plan,
  };
}

export async function profile(params = {}, context = {}) {
  const tasteProfile = await buildTasteProfile(params, context);
  const savedTo = writeJsonFile(playlistOutputDir(context), "playlist-profile", {
    generatedAt: new Date().toISOString(),
    tasteProfile,
    input: params,
  });
  return {
    success: true,
    savedTo,
    tasteProfile,
  };
}

export async function plan(params = {}, context = {}) {
  const playlistPlan = await buildPlaylistPlan(params, context);
  const savedTo = writeJsonFile(playlistOutputDir(context), "playlist-plan", {
    generatedAt: new Date().toISOString(),
    input: params,
    ...playlistPlan,
  });
  return {
    success: true,
    savedTo,
    playlistTitle: playlistPlan.playlistTitle,
    playlistSummary: playlistPlan.playlistSummary,
    trackCount: Array.isArray(playlistPlan.tracks) ? playlistPlan.tracks.length : 0,
    tracks: playlistPlan.tracks,
  };
}

export async function create(params = {}, context = {}) {
  const outputDir = playlistOutputDir(context);
  const playlistPlan = params.plan && typeof params.plan === "object"
    ? params.plan
    : await buildPlaylistPlan(params, context);

  const tracks = [];
  for (const trackPlan of playlistPlan.tracks || []) {
    const track = await generateMusicTrack({
      title: trackPlan.title,
      prompt: trackPlan.prompt,
      instrumental: trackPlan.instrumental === true,
      outputDir,
    }, context);
    tracks.push({
      title: trackPlan.title,
      concept: trackPlan.concept,
      prompt: trackPlan.prompt,
      instrumental: trackPlan.instrumental === true,
      filePath: track.filePath,
      durationSeconds: track.durationSeconds,
      generatedLyrics: track.generatedLyrics,
    });
  }

  let coverArt = null;
  if (params.includeCoverArt !== false && playlistPlan.coverArtPrompt) {
    coverArt = await generateCoverArt({
      prompt: playlistPlan.coverArtPrompt,
      outputDir,
      title: `${playlistPlan.playlistTitle || "playlist"} cover`,
    }, context);
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    playlistTitle: playlistPlan.playlistTitle,
    playlistSummary: playlistPlan.playlistSummary,
    tasteProfile: playlistPlan.tasteProfile || null,
    coverArt,
    tracks,
  };
  const savedTo = writeJsonFile(outputDir, `playlist-${slugify(playlistPlan.playlistTitle, "playlist")}`, manifest);
  return {
    success: true,
    playlistTitle: playlistPlan.playlistTitle,
    savedTo,
    coverArtPath: coverArt?.filePath || null,
    trackCount: tracks.length,
    tracks,
  };
}

export async function execute(action, params, context) {
  if (action === "profile") return profile(params, context);
  if (action === "plan") return plan(params, context);
  if (action === "create") return create(params, context);
  throw new Error(`Unknown minimax-music-playlist action: ${action}`);
}
