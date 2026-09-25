// Roots for product scripts, resolved without any developer machine path.
//
// scripts/ ships as hash-verified product payload: an owner cannot edit a
// baked-in default, and on any other machine such a default is simply wrong.
// The app root is HOME23_ROOT when set, otherwise the parent of the scripts/
// directory that holds the calling script (the same rule src/config.ts uses).

import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolve the Home23 app root for a script that lives directly in scripts/.
 * @param {string} scriptUrl  the calling script's import.meta.url
 * @param {NodeJS.ProcessEnv} [env]
 */
export function resolveAppRoot(scriptUrl, env = process.env) {
  const configured = env.HOME23_ROOT;
  if (typeof configured === "string" && configured !== "") {
    if (!isAbsolute(configured) || configured.includes("\0") || resolve(configured) === "/") {
      throw new Error("HOME23_ROOT must be an absolute dedicated Home23 directory");
    }
    return resolve(configured);
  }
  return resolve(dirname(fileURLToPath(scriptUrl)), "..");
}

/**
 * The owner's Shakedown Shuffle site checkout: operational state that lives
 * outside the app root. SHAKEDOWN_SITE_ROOT names it explicitly; the default
 * is its conventional location under the current user's home directory.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function resolveShakedownSiteRoot(env = process.env) {
  const configured = env.SHAKEDOWN_SITE_ROOT;
  if (typeof configured === "string" && configured !== "") return resolve(configured);
  return join(homedir(), "websites", "shakedownshuffle.com");
}
