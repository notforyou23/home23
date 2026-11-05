export default async function beforeRun(payload) {
  const action = String(payload?.action || "");
  const params = payload?.params && typeof payload.params === "object" ? payload.params : {};

  if (action === "postQueued" && params.confirm !== true) {
    return {
      cancel: true,
      reason: "x-social-distiller postQueued creates public X side effects and requires confirm:true.",
    };
  }

  return null;
}
