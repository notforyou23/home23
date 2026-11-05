// Substack skill — programmatic Substack editing via the publishing-v3 Chrome profile.
// Doctrine: on-demand Chrome, fail loud, backup before every write, no email without
// explicit double confirmation. Proven contract from the 2026-07-26 issue-02 repair.

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

const CHROME_EXECUTABLE = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const CHROME_PROFILE_DIR = "/Users/jtr/.codex/browser-profiles/shakedown-publishing-v3";
const CDP_HOST = "127.0.0.1";
const CDP_PORT = 9223;
const CDP_URL = `http://${CDP_HOST}:${CDP_PORT}`;
const PUBLICATION_HOST = "https://shakedownshuffle.substack.com";
const HOME_URL = `${PUBLICATION_HOST}/publish/home`;
const RECEIPTS_DIR =
  "/Users/jtr/_JTR23_/release/home23/instances/jerry/workspace/projects/shakedownshuffle/content/newsletter/source-receipts";
const LAUNCH_MARKER = "/tmp/substack-skill-chrome-launched.json";
const EVAL_TIMEOUT_MS = 20_000;
const LAUNCH_POLL_MS = 1_000;
const LAUNCH_ATTEMPTS = 30;

function resolveProjectRoot(context = {}) {
  return (
    context?.projectRoot ||
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..")
  );
}

function loadWebSocket(context = {}) {
  const wsPath = path.join(resolveProjectRoot(context), "node_modules", "ws", "index.js");
  if (!fs.existsSync(wsPath)) {
    throw new Error(`FAIL LOUD: ws module not found at ${wsPath} — cannot drive CDP.`);
  }
  return require(wsPath);
}

async function fetchJson(url, timeoutMs = 3_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, cache: "no-store" });
    const body = await res.text();
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    return { ok: false, status: 0, body: "", error: err?.message || String(err) };
  } finally {
    clearTimeout(timer);
  }
}

async function probeCdp() {
  const res = await fetchJson(`${CDP_URL}/json/version`);
  if (!res.ok) return { running: false, reason: res.error || `http-${res.status}` };
  try {
    const version = JSON.parse(res.body);
    return { running: true, browser: version.Browser };
  } catch {
    return { running: false, reason: "cdp-version-unparseable" };
  }
}

async function listPages() {
  const res = await fetchJson(`${CDP_URL}/json`);
  if (!res.ok) {
    throw new Error(`FAIL LOUD: CDP /json unreachable (${res.error || res.status}).`);
  }
  const tabs = JSON.parse(res.body);
  return tabs.filter((t) => t.type === "page");
}

async function launchChrome() {
  if (!fs.existsSync(CHROME_EXECUTABLE)) {
    throw new Error(`FAIL LOUD: Chrome executable missing at ${CHROME_EXECUTABLE}.`);
  }
  if (!fs.existsSync(CHROME_PROFILE_DIR)) {
    throw new Error(
      `FAIL LOUD: publishing-v3 Chrome profile missing at ${CHROME_PROFILE_DIR}. ` +
        "The Substack session lives in that profile; without it there is no auth."
    );
  }
  const child = spawn(
    CHROME_EXECUTABLE,
    [
      `--user-data-dir=${CHROME_PROFILE_DIR}`,
      `--remote-debugging-address=${CDP_HOST}`,
      `--remote-debugging-port=${CDP_PORT}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--new-window",
      HOME_URL,
    ],
    { detached: true, stdio: "ignore" }
  );
  child.unref();
  fs.writeFileSync(
    LAUNCH_MARKER,
    JSON.stringify({ pid: child.pid, launchedAt: new Date().toISOString() })
  );

  for (let i = 0; i < LAUNCH_ATTEMPTS; i += 1) {
    await new Promise((r) => setTimeout(r, LAUNCH_POLL_MS));
    const probe = await probeCdp();
    if (probe.running) return { launched: true, pid: child.pid, browser: probe.browser };
  }
  throw new Error(
    `FAIL LOUD: Chrome launched (pid ${child.pid}) but CDP on :${CDP_PORT} never became ready ` +
      `after ${LAUNCH_ATTEMPTS}s. Another process may hold the port or the profile is locked.`
  );
}

async function ensureChrome() {
  const probe = await probeCdp();
  if (probe.running) return { alreadyRunning: true, browser: probe.browser };
  const result = await launchChrome();
  return { alreadyRunning: false, ...result };
}

async function ensureSubstackTab() {
  const pages = await listPages();
  let tab = pages.find((t) => (t.url || "").includes("substack.com"));
  if (!tab) {
    const res = await fetchJson(`${CDP_URL}/json/new?${encodeURIComponent(HOME_URL)}`, 5_000);
    if (!res.ok) {
      throw new Error(`FAIL LOUD: could not open a Substack tab via CDP (${res.error || res.status}).`);
    }
    tab = JSON.parse(res.body);
    await new Promise((r) => setTimeout(r, 4_000));
  }
  if (!tab?.id) throw new Error("FAIL LOUD: no usable Substack tab id from CDP.");
  return tab;
}

function cdpEvaluate(tabId, expression, context = {}) {
  const WebSocket = loadWebSocket(context);
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${CDP_HOST}:${CDP_PORT}/devtools/page/${tabId}`, {
      perMessageDeflate: false,
    });
    const timer = setTimeout(() => {
      try { ws.close(); } catch { /* ignore */ }
      reject(new Error(`FAIL LOUD: CDP evaluate timed out after ${EVAL_TIMEOUT_MS}ms.`));
    }, EVAL_TIMEOUT_MS);

    let msgId = 0;
    ws.on("open", () => {
      msgId += 1;
      ws.send(
        JSON.stringify({
          id: msgId,
          method: "Runtime.evaluate",
          params: { expression, returnByValue: true, awaitPromise: true },
        })
      );
    });
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id !== msgId) return;
      clearTimeout(timer);
      ws.close();
      if (msg.error) {
        reject(new Error(`FAIL LOUD: CDP error: ${JSON.stringify(msg.error)}`));
        return;
      }
      const details = msg.result?.exceptionDetails;
      if (details) {
        reject(
          new Error(
            `FAIL LOUD: page-context exception: ${details.exception?.description || details.text}`
          )
        );
        return;
      }
      resolve(msg.result?.result?.value);
    });
    ws.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`FAIL LOUD: CDP websocket error: ${err.message}`));
    });
  });
}

async function pageFetch(tabId, urlPath, options = {}, context = {}) {
  const requestUrl = urlPath.startsWith("/") ? `${PUBLICATION_HOST}${urlPath}` : urlPath;
  const expression = `(async () => {
    const res = await fetch(${JSON.stringify(requestUrl)}, ${JSON.stringify(options)});
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, ok: res.ok, json, textLength: text.length };
  })()`;
  const result = await cdpEvaluate(tabId, expression, context);
  if (result === undefined) {
    throw new Error("FAIL LOUD: page fetch returned undefined — tab may have navigated away.");
  }
  return result;
}

async function assertSession(tabId, context = {}) {
  const res = await pageFetch(
    tabId,
    "/api/v1/post_management/published?offset=0&limit=1&order_by=post_date&order_direction=desc",
    {},
    context
  );
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      "FAIL LOUD: SUBSTACK SESSION EXPIRED. The publishing-v3 profile is no longer logged in. " +
        `Fix: open Chrome with profile ${CHROME_PROFILE_DIR}, sign in at ${PUBLICATION_HOST}, then retry.`
    );
  }
  if (!res.ok || !res.json || !Array.isArray(res.json.posts)) {
    throw new Error(
      `FAIL LOUD: Substack post_management API contract changed or errored ` +
        `(status ${res.status}). Do not proceed with writes until inspected.`
    );
  }
  return true;
}

async function connect(context = {}) {
  const chrome = await ensureChrome();
  const tab = await ensureSubstackTab();
  await assertSession(tab.id, context);
  return { chrome, tab };
}

function requirePostId(params) {
  const postId = Number(params.postId);
  if (!Number.isInteger(postId) || postId <= 0) {
    throw new Error("FAIL LOUD: postId (positive integer) is required.");
  }
  return postId;
}

function backupDraft(postId, draftJson) {
  if (!fs.existsSync(RECEIPTS_DIR)) fs.mkdirSync(RECEIPTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(RECEIPTS_DIR, `substack-${postId}-backup-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(draftJson, null, 2));
  const written = fs.statSync(file);
  if (!written.size) throw new Error(`FAIL LOUD: backup write produced empty file at ${file}.`);
  return file;
}

async function getDraft(tabId, postId, context = {}) {
  const res = await pageFetch(tabId, `/api/v1/drafts/${postId}`, {}, context);
  if (res.status === 404) throw new Error(`FAIL LOUD: post ${postId} not found.`);
  if (!res.ok || !res.json) {
    throw new Error(`FAIL LOUD: drafts GET failed (status ${res.status}).`);
  }
  const draft = res.json;
  if (typeof draft.draft_body !== "string" || !draft.draft_body.length) {
    throw new Error(
      `FAIL LOUD: draft ${postId} has no draft_body string — API contract may have changed.`
    );
  }
  return draft;
}

// ---------- actions ----------

async function status(params = {}, context = {}) {
  const probe = await probeCdp();
  if (!probe.running) {
    return {
      success: true,
      chrome: "not-running",
      note: "Chrome will be launched on demand by any other action.",
    };
  }
  const tab = await ensureSubstackTab();
  let session = "valid";
  try {
    await assertSession(tab.id, context);
  } catch (err) {
    session = err.message;
  }
  return { success: true, chrome: "running", browser: probe.browser, tabUrl: tab.url, session };
}

async function listPosts(params = {}, context = {}) {
  const { tab } = await connect(context);
  const limit = Math.min(Number(params.limit) || 25, 50);
  const offset = Number(params.offset) || 0;
  const res = await pageFetch(
    tab.id,
    `/api/v1/post_management/published?offset=${offset}&limit=${limit}&order_by=post_date&order_direction=desc`,
    {},
    context
  );
  if (!res.ok || !res.json) throw new Error(`FAIL LOUD: listPosts failed (status ${res.status}).`);
  return {
    success: true,
    count: res.json.posts.length,
    posts: res.json.posts.map((p) => ({ id: p.id, slug: p.slug, title: p.title })),
  };
}

async function readDraft(params = {}, context = {}) {
  const postId = requirePostId(params);
  const { tab } = await connect(context);
  const draft = await getDraft(tab.id, postId, context);
  const doc = JSON.parse(draft.draft_body);
  return {
    success: true,
    postId,
    title: draft.draft_title,
    isPublished: Boolean(draft.is_published),
    bodyChars: draft.draft_body.length,
    topLevelNodes: Array.isArray(doc.content) ? doc.content.length : 0,
    lastNodes: JSON.stringify((doc.content || []).slice(-2)).slice(0, 800),
  };
}

async function editDraft(params = {}, context = {}) {
  const postId = requirePostId(params);
  const nodes = params.appendNodes;
  if (!Array.isArray(nodes) || !nodes.length) {
    throw new Error(
      "FAIL LOUD: appendNodes (non-empty array of ProseMirror nodes) is required. " +
        "This skill only appends — it never rewrites existing content."
    );
  }
  const marker = params.idempotencyMarker;
  if (!marker || typeof marker !== "string") {
    throw new Error(
      "FAIL LOUD: idempotencyMarker (string that must NOT already exist in the body) is required."
    );
  }

  const { tab } = await connect(context);
  const draft = await getDraft(tab.id, postId, context);
  if (draft.draft_body.includes(marker)) {
    return { success: true, skipped: true, reason: `idempotencyMarker already present in post ${postId}.` };
  }

  const backupFile = backupDraft(postId, draft);
  const doc = JSON.parse(draft.draft_body);
  if (!Array.isArray(doc.content)) {
    throw new Error("FAIL LOUD: draft body is not a ProseMirror doc with content array.");
  }
  doc.content.push(...nodes);

  const putRes = await pageFetch(
    tab.id,
    `/api/v1/drafts/${postId}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ draft_body: JSON.stringify(doc) }),
    },
    context
  );
  if (!putRes.ok) {
    throw new Error(
      `FAIL LOUD: draft PUT failed (status ${putRes.status}). Backup preserved at ${backupFile}.`
    );
  }

  const readback = await getDraft(tab.id, postId, context);
  if (!readback.draft_body.includes(marker)) {
    throw new Error(
      `FAIL LOUD: PUT returned ok but readback does not contain the marker. ` +
        `Inspect manually. Backup at ${backupFile}.`
    );
  }

  return {
    success: true,
    postId,
    backupFile,
    newTopLevelNodes: doc.content.length,
    note: "Draft saved. NOT yet visible publicly — run publish to push the change live.",
  };
}

async function appendCanonicalFooter(params = {}, context = {}) {
  const postId = requirePostId(params);
  const canonicalUrl = params.canonicalUrl;
  if (!canonicalUrl || !/^https:\/\/www\.shakedownshuffle\.com\//.test(canonicalUrl)) {
    throw new Error(
      "FAIL LOUD: canonicalUrl is required and must start with https://www.shakedownshuffle.com/."
    );
  }
  const lead = params.leadText || "This piece's canonical home, with full notes: ";
  const nodes = [
    { type: "horizontal_rule" },
    {
      type: "paragraph",
      attrs: { textAlign: null },
      content: [
        { type: "text", marks: [{ type: "em" }], text: lead },
        {
          type: "text",
          marks: [
            {
              type: "link",
              attrs: { href: canonicalUrl, target: "_blank", rel: "noopener noreferrer nofollow", class: null },
            },
            { type: "em" },
          ],
          // Anchor text IS the URL: the publish-pipeline verifier greps raw HTML
          // for the literal canonical string (textMentionsUrl).
          text: canonicalUrl,
        },
      ],
    },
  ];
  return editDraft(
    { postId, appendNodes: nodes, idempotencyMarker: canonicalUrl },
    context
  );
}

async function publish(params = {}, context = {}) {
  const postId = requirePostId(params);
  const wantsEmail = params.confirmSend === true;
  if (wantsEmail) {
    const { tab } = await connect(context);
    const draft = await getDraft(tab.id, postId, context);
    if (params.confirmSendText !== draft.draft_title) {
      throw new Error(
        "FAIL LOUD: emailing subscribers requires confirmSend:true AND confirmSendText exactly " +
          `matching the post title ("${draft.draft_title}"). Refusing to send email.`
      );
    }
  }

  const { tab } = await connect(context);
  await getDraft(tab.id, postId, context); // asserts the draft is readable before publish

  const res = await pageFetch(
    tab.id,
    `/api/v1/drafts/${postId}/publish`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ send: wantsEmail, share_automatically: false }),
    },
    context
  );
  if (!res.ok || !res.json) {
    throw new Error(`FAIL LOUD: publish POST failed (status ${res.status}).`);
  }
  if (!wantsEmail && res.json.email_sent_at) {
    throw new Error(
      "FAIL LOUD: publish was requested with send:false but Substack reports email_sent_at set. " +
        "STOP and inspect — the no-email contract may have changed."
    );
  }
  return {
    success: true,
    postId,
    isPublished: Boolean(res.json.is_published),
    emailSentAt: res.json.email_sent_at || null,
    emailed: wantsEmail,
    note: "Anonymous page renders may lag behind due to Substack origin cache TTL. Use verifyBacklink.",
  };
}

async function verifyBacklink(params = {}, context = {}) {
  const targetUrl = params.substackUrl;
  const needle = params.needle;
  if (!targetUrl || !needle) {
    throw new Error("FAIL LOUD: substackUrl and needle (string to find in HTML) are required.");
  }

  const anon = await fetchJson(`${targetUrl}${targetUrl.includes("?") ? "&" : "?"}cb=${Date.now()}`, 15_000);
  const anonFound = anon.ok && anon.body.includes(needle);

  let loggedInFound = null;
  try {
    const { tab } = await connect(context);
    const result = await cdpEvaluate(
      tab.id,
      `fetch(${JSON.stringify(targetUrl)}, {credentials:"include"}).then(r=>r.text()).then(t=>t.includes(${JSON.stringify(needle)}))`,
      context
    );
    loggedInFound = Boolean(result);
  } catch (err) {
    loggedInFound = `unavailable: ${err.message}`;
  }

  return {
    success: true,
    anonymous: { httpOk: anon.ok, found: anonFound },
    loggedIn: { found: loggedInFound },
    verdict:
      anonFound
        ? "verified-public"
        : loggedInFound === true
          ? "published-but-anon-cache-stale"
          : "NOT FOUND — edit may not have landed; inspect before retrying",
  };
}

async function stopChrome() {
  const probe = await probeCdp();
  if (!probe.running) return { success: true, note: "Chrome already not running." };
  let marker = null;
  try {
    marker = JSON.parse(fs.readFileSync(LAUNCH_MARKER, "utf8"));
  } catch {
    // no marker — we did not launch it
  }
  if (!marker?.pid) {
    throw new Error(
      "FAIL LOUD: Chrome on :9223 is running but this skill has no launch marker for it. " +
        "Refusing to kill a process this skill did not start. Kill manually if intended."
    );
  }
  try {
    process.kill(marker.pid, "SIGTERM");
  } catch (err) {
    throw new Error(`FAIL LOUD: SIGTERM to pid ${marker.pid} failed: ${err.message}`);
  }
  fs.unlinkSync(LAUNCH_MARKER);
  return { success: true, killedPid: marker.pid };
}

export async function execute(action, params, context) {
  if (action === "status") return status(params, context);
  if (action === "listPosts") return listPosts(params, context);
  if (action === "readDraft") return readDraft(params, context);
  if (action === "editDraft") return editDraft(params, context);
  if (action === "appendCanonicalFooter") return appendCanonicalFooter(params, context);
  if (action === "publish") return publish(params, context);
  if (action === "verifyBacklink") return verifyBacklink(params, context);
  if (action === "stopChrome") return stopChrome(params, context);
  throw new Error(`Unknown substack action: ${action}`);
}
