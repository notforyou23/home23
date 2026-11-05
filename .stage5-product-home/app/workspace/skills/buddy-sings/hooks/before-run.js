export async function beforeRun(payload = {}) {
  const params = { ...(payload.params || {}) };
  const action = payload.action;

  if (action === "sing" && !params.subject && !params.prompt) {
    params.subject = "a song about being a living companion inside Home23";
    return {
      params,
      notes: ["No subject was provided, so buddy-sings used a default Home23 companion prompt."],
    };
  }

  return { params };
}
