export async function beforeRun(payload = {}) {
  const params = { ...(payload.params || {}) };

  if (!params.count) {
    params.count = 3;
  }

  const count = Math.max(1, Math.min(Number(params.count || 3), 5));
  params.count = count;

  if (payload.action === "create" && !params.brief && !params.tasteProfile && !params.plan) {
    return {
      cancel: true,
      reason: "playlist create requires a brief, tasteProfile, or precomputed plan",
    };
  }

  return {
    params,
    notes: count !== Number(payload.params?.count || 3)
      ? [`Playlist count was clamped to ${count}.`]
      : undefined,
  };
}
