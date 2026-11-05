export async function beforeRun(payload = {}) {
  const params = { ...(payload.params || {}) };
  const action = payload.action;

  if (action === "compose") {
    const hasIdea = Boolean(params.prompt || params.lyrics || params.referenceAudioUrl);
    if (!hasIdea) {
      return { cancel: true, reason: "compose requires at least one of: prompt, lyrics, referenceAudioUrl" };
    }
    if (params.mode === "cover" && !params.referenceAudioUrl) {
      return { cancel: true, reason: "cover mode requires referenceAudioUrl" };
    }
  }

  if (action === "draft-lyrics" && !params.prompt) {
    return { cancel: true, reason: "draft-lyrics requires prompt" };
  }

  return { params };
}
