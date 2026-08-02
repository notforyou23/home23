#!/usr/bin/env node
/**
 * Shakedown Desk — the human control surface.
 *
 * One localhost page (127.0.0.1:7788) that renders the status digest and the
 * pending proposals with real Approve / Reject buttons. A decision rewrites
 * the [proposed] marker in the editorial queue (the same act as editing the
 * file) and re-runs the status assembler so Jerry's context updates too.
 *
 * Deliberately boring: zero dependencies, binds loopback only, writes exactly
 * one file (the queue), and shells out to exactly one script (the assembler).
 */

import { createServer } from "node:http";
import { readFileSync, readdirSync, existsSync, mkdirSync, copyFileSync, unlinkSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import { join, resolve, relative, basename } from "node:path";
import { classify } from "./shakedown-approval-runner.mjs";

const H23 = "/Users/jtr/_JTR23_/release/home23";
const PROJECT = join(H23, "instances/jerry/workspace/projects/shakedownshuffle");
const QUEUE = join(PROJECT, "content/article-editorial-queue.md");
const STATUS = join(PROJECT, "status/latest.json");
const RUNS = join(H23, "instances/workers/shakedown-jerry/workspace/runs");
const RUNNER_LEDGER = join(H23, "instances/workers/shakedown-jerry/workspace/state/approval-runner-ledger.json");
const EDIT_NOTES = join(PROJECT, "content/drafts/editorial/desk-review-notes.json");
const NEWSLETTER = join(PROJECT, "content/newsletter");
const EDITORIAL_STATE = join(PROJECT, "content/drafts/editorial/desk-draft-state.json");
const SITE = "/Users/jtr/websites/shakedownshuffle.com/shakedown-v2";
const LIVE_BASE = "https://www.shakedownshuffle.com/newsletter/";
const REVIEW_ROOTS = [
  join(H23, "instances/jerry/workspace/jtr/jerry-garcia-deep-dive"),
  join(PROJECT, "content"),
];
const PORT = 7788;

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function reviewPath(raw) {
  const full = resolve(decodeURIComponent(raw || ""));
  if (!REVIEW_ROOTS.some((root) => full === root || full.startsWith(`${root}/`))) return null;
  if (!/\.md$/i.test(full) || !existsSync(full)) return null;
  return full;
}

function reviewHref(file) {
  return `/review?file=${encodeURIComponent(file)}`;
}

function titleFromSource(source, fallback) {
  const frontmatterTitle = source.match(/^title:\s*["']?(.+?)["']?\s*$/m)?.[1];
  const heading = source.match(/^#\s+(?:Newsletter Issue\s*[—–-]\s*)?(.+)$/m)?.[1];
  return frontmatterTitle ?? heading ?? fallback.replace(/\.md$/, "").replace(/[-_]/g, " ");
}

function readNotes() {
  try { return JSON.parse(readFileSync(EDIT_NOTES, "utf-8")); } catch { return {}; }
}

function readDraftState() {
  try { return JSON.parse(readFileSync(EDITORIAL_STATE, "utf-8")); } catch { return {}; }
}

function writeDraftState(state) {
  mkdirSync(resolve(EDITORIAL_STATE, ".."), { recursive: true });
  writeFileSync(EDITORIAL_STATE, JSON.stringify(state, null, 2) + "\n");
}

function draftState(file) {
  return readDraftState()[file] ?? { state: "ready-for-review", revision: 1 };
}

function addNote(file, note) {
  if (!note?.trim()) throw new Error("write an edit note first");
  const notes = readNotes();
  notes[file] = [...(notes[file] ?? []), { at: new Date().toISOString(), note: note.trim().slice(0, 5000) }];
  mkdirSync(resolve(EDIT_NOTES, ".."), { recursive: true });
  writeFileSync(EDIT_NOTES, JSON.stringify(notes, null, 2) + "\n");
  const state = readDraftState();
  state[file] = { ...draftState(file), state: "notes-awaiting-revision", updatedAt: new Date().toISOString() };
  writeDraftState(state);
}

function renderReview(file) {
  const source = readFileSync(file, "utf-8");
  const label = relative(H23, file);
  const notes = readNotes()[file] ?? [];
  const state = draftState(file);
  const title = titleFromSource(source, file.split("/").pop());
  const revisionSummary = state.revisionSummary ? `<div class="note"><strong>Revision receipt</strong><br>${esc(state.revisionSummary)}</div>` : "";
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)} · Shakedown Desk</title>
<style>:root{color-scheme:dark}body{font:16px/1.65 -apple-system,system-ui,sans-serif;background:#14120f;color:#e8e2d5;max-width:900px;margin:2rem auto;padding:0 1rem}a{color:#8fc7ee}pre,textarea{box-sizing:border-box;width:100%;white-space:pre-wrap;word-break:break-word;background:#1e1b16;border:1px solid #332d24;border-radius:8px;padding:1.2rem;color:#e8e2d5;font:14px/1.55 ui-monospace,SFMono-Regular,monospace}textarea{min-height:8rem;font:15px/1.5 -apple-system,system-ui,sans-serif}small{color:#a89f8d}button{background:#35552e;border:1px solid #58754e;color:#fff;border-radius:5px;padding:.55rem .8rem;margin-top:.45rem}.note{background:#242018;border-left:3px solid #d9a441;padding:.6rem .8rem;margin:.5rem 0}</style></head><body><p><a href="/">← Back to Desk</a></p><h1>${esc(title)}</h1><small>${esc(label)} · revision ${esc(state.revision ?? 1)} · ${esc(state.state)}</small>${revisionSummary}<h2>Editorial notes</h2><p>Leave the edit, question, or direction here. Saving a note moves this draft to <strong>notes awaiting revision</strong>; the Desk will bring the revised version back to you.</p><form method="POST" action="/review-note"><input type="hidden" name="file" value="${esc(file)}"><textarea name="note" placeholder="Example: Tighten the cold open; verify the TB500 #12 claim before publication."></textarea><br><button>Send notes for revision</button></form>${notes.length ? `<h3>Saved notes</h3>${notes.map((n) => `<div class="note"><small>${esc(n.at)}</small><br>${esc(n.note)}</div>`).join("")}` : ""}${state.state === "ready-for-approval" ? `<h2>Ready to publish?</h2><p>This is the revised draft. Approval builds the Shakedown Shuffle issue, deploys it through the guarded site pipeline, and verifies the public page before this Desk calls it live.</p><form method="POST" action="/approve-draft"><input type="hidden" name="file" value="${esc(file)}"><button>Approve for Shakedown Shuffle publication</button></form>` : ""}<h2>Draft</h2><pre>${esc(source)}</pre></body></html>`;
}

function parseProposals() {
  if (!existsSync(QUEUE)) return [];
  const src = readFileSync(QUEUE, "utf-8");
  const out = [];
  const re = /^### \[(proposed|approved|done|rejected|failed|retired)\] (.+)$/gm;
  let m;
  while ((m = re.exec(src)) !== null) {
    const start = m.index + m[0].length;
    const next = src.slice(start).search(/^### \[/m);
    const body = src.slice(start, next === -1 ? undefined : start + next).trim();
    out.push({ state: m[1], title: m[2].trim(), body });
  }
  return out;
}

function decide(title, decision, reason) {
  const src = readFileSync(QUEUE, "utf-8");
  const from = `### [proposed] ${title}`;
  if (!src.includes(from)) throw new Error("proposal not found or already decided");
  const stamp = new Date().toISOString().slice(0, 10);
  let to;
  if (decision === "approve") to = `### [approved] ${title}`;
  else to = `### [rejected] ${title}\n- rejected ${stamp}${reason ? `: ${reason.slice(0, 300)}` : ""}`;
  writeFileSync(QUEUE, src.replace(from, to));
  execFile("node", [join(H23, "scripts/shakedown-status.mjs")], { cwd: H23 }, () => {});
}

// Real, one-click, always-safe: rewrite an approved card to [retired]. Text
// edit only, fully reversible by re-editing the file. For duplicate/stale
// cards jtr does not want executed or reconsidered.
function retire(title, reason) {
  const src = readFileSync(QUEUE, "utf-8");
  const from = `### [approved] ${title}`;
  if (!src.includes(from)) throw new Error("card not found in [approved] state (already decided or retitled)");
  const stamp = new Date().toISOString().slice(0, 10);
  const to = `### [retired] ${title}\n- retired ${stamp} via Desk${reason ? `: ${reason.slice(0, 300)}` : ""}`;
  writeFileSync(QUEUE, src.replace(from, to));
  execFile("node", [join(H23, "scripts/shakedown-status.mjs")], { cwd: H23 }, () => {});
}

// Real, one-click: jtr did the actual work himself outside Home23 (sent the
// Substack post, sent the outreach email, did the manual edit) and is closing
// the loop. This is the honest alternative to a fake "execute" button for
// actions this system will never auto-trigger (external send, money, editorial
// taste calls) per docs/superpowers/specs/2026-07-25-shakedown-jerry-proposer-design.md.
function markDone(title, note) {
  const src = readFileSync(QUEUE, "utf-8");
  const from = `### [approved] ${title}`;
  if (!src.includes(from)) throw new Error("card not found in [approved] state (already decided or retitled)");
  const stamp = new Date().toISOString().slice(0, 10);
  const to = `### [done] ${title}\n- done ${stamp}, marked manually via Desk by jtr${note ? `: ${note.slice(0, 300)}` : ""}`;
  writeFileSync(QUEUE, src.replace(from, to));
  execFile("node", [join(H23, "scripts/shakedown-status.mjs")], { cwd: H23 }, () => {});
}

// Pull the one line that actually tells a human what to do, plus any absolute
// file paths in the body, so the card reads as an instruction instead of a
// wall of prose with nothing to click.
function extractActionable(body) {
  const actionMatch = body.match(/^-\s*action:\s*(.+)$/m);
  const pathMatches = [...body.matchAll(/`(\/[^`\s]+\.md)`/g)].map((m) => m[1]);
  const uniquePaths = [...new Set(pathMatches)].filter((pth) => reviewPath(pth)).slice(0, 6);
  return { actionLine: actionMatch ? actionMatch[1].trim() : null, paths: uniquePaths };
}

function stagedDrafts() {
  // The review inventory is deliberately broader than the old three-file legacy
  // folder: every unpublished newsletter source already awaiting editorial review,
  // plus legacy source drafts that have not entered that surface yet. Published
  // issues never appear here.
  const legacyRoot = join(H23, "instances/jerry/workspace/jtr/jerry-garcia-deep-dive/issues");
  const newsletter = (() => {
    try {
      return readdirSync(NEWSLETTER)
        .filter((name) => /^issue-.*\.md$/i.test(name))
        .map((name) => join(NEWSLETTER, name))
        .filter((file) => {
          const source = readFileSync(file, "utf-8");
          const status = source.match(/^status:\s*(.+)$/m)?.[1]?.trim().replace(/["']/g, "");
          const distribution = source.match(/^distribution_state:\s*(.+)$/m)?.[1]?.trim().replace(/["']/g, "");
          return ["needs-review", "source-ready", "draft"].includes(status) && distribution !== "published";
        });
    } catch { return []; }
  })();
  const legacy = (() => {
    try { return readdirSync(legacyRoot).filter((name) => /^issue-.*\.md$/i.test(name)).map((name) => join(legacyRoot, name)); } catch { return []; }
  })();
  return [...new Set([...newsletter, ...legacy])].filter((file) => reviewPath(file));
}

function reviseDraft(file) {
  const notes = readNotes()[file] ?? [];
  if (!notes.length) throw new Error("no editorial notes to revise against");
  const state = readDraftState();
  state[file] = { ...draftState(file), state: "revision-requested", revision: Number(draftState(file).revision ?? 1), requestedAt: new Date().toISOString(), notesCount: notes.length };
  writeDraftState(state);
  // The review state is durable and explicit. A revision worker consumes it; this
  // server never pretends to rewrite editorial prose on its own.
}

function readyForApproval(file) {
  const state = readDraftState();
  const old = draftState(file);
  state[file] = { ...old, state: "ready-for-approval", revision: Number(old.revision ?? 1) + 1, revisedAt: new Date().toISOString() };
  writeDraftState(state);
}

function approveDraft(file) {
  const state = draftState(file);
  if (state.state !== "ready-for-approval") throw new Error("this draft is not back from revision yet");
  const source = readFileSync(file, "utf-8");
  const title = titleFromSource(source, basename(file));
  const issue = Number(source.match(/^issue:\s*(\d+)/m)?.[1] ?? basename(file).match(/^issue-(\d+)/i)?.[1] ?? "");
  if (!Number.isInteger(issue) || issue < 1) throw new Error("draft needs an issue number in frontmatter or its filename before publication");
  const slug = basename(file).replace(/\.md$/i, "");
  const target = join(NEWSLETTER, `${slug}.md`);
  const date = new Date().toISOString().slice(0, 10);
  // A Desk draft may already be in content/newsletter/ as needs-review. That
  // is the normal path: preserve its review metadata and promote it in place.
  // Track what this call wrote so a failed deploy can be undone. Publication
  // files used to land in content/newsletter/ BEFORE the deploy ran: a deploy
  // that threw left the issue on disk as published while the draft state still
  // said otherwise, and the retry then hit "publication target already exists"
  // and stuck. Written-then-rolled-back is recoverable; written-then-orphaned
  // is a manual cleanup.
  const wrote = [];
  if (resolve(file) !== resolve(target)) {
    if (existsSync(target)) throw new Error("publication target already exists; refusing to overwrite it");
    const frontmatter = `---\ntitle: ${JSON.stringify(title)}\nissue: ${issue}\ndate: ${date}\nstatus: source-ready\nsource_path: ${file}\ncanonical_target: ${LIVE_BASE}${slug}/\nprimary_cta: https://www.shakedownshuffle.com/start/\ndistribution_state: pending\n---\n`;
    copyFileSync(file, `${target}.source`);
    wrote.push(`${target}.source`);
    writeFileSync(target, frontmatter + source.replace(/^---[\s\S]*?---\s*/m, ""));
    wrote.push(target);
  }

  let run;
  try {
    run = execFileSync("npm", ["run", "pipeline:build-owned:deploy"], { cwd: SITE, timeout: 300_000, encoding: "utf-8" });
    execFileSync("node", [join(H23, "scripts/shakedown-status.mjs")], { cwd: H23, timeout: 30_000, encoding: "utf-8" });
  } catch (error) {
    for (const path of wrote.reverse()) {
      try { unlinkSync(path); } catch { /* best effort: leave what we cannot remove */ }
    }
    throw new Error(
      `Deploy failed; rolled back ${wrote.length} staged publication file(s) so this draft can be retried.\n${error.message}`,
    );
  }
  const next = readDraftState();
  next[file] = { ...state, state: "published", publishedAt: new Date().toISOString(), target, deploymentReceipt: run.slice(-4000) };
  writeDraftState(next);
}

function publishedIssues() {
  try {
    return readdirSync(NEWSLETTER).filter((name) => /^issue-.*\.md$/i.test(name)).map((name) => {
      const source = readFileSync(join(NEWSLETTER, name), "utf-8");
      const slug = name.replace(/\.md$/, "");
      return { title: titleFromSource(source, slug), slug, issue: source.match(/^issue:\s*(\d+)/m)?.[1] ?? "?", url: `${LIVE_BASE}${slug}/` };
    }).sort((a, b) => Number(b.issue) - Number(a.issue));
  } catch { return []; }
}

function readStatus() {
  try { return JSON.parse(readFileSync(STATUS, "utf-8")); } catch { return null; }
}

function readRunnerLedger() {
  try { return JSON.parse(readFileSync(RUNNER_LEDGER, "utf-8")); } catch { return { entries: {} }; }
}

// Approved != needs-you. An approved card only executes once it carries a
// structured opportunityId + machineAction + args contract AND that action is
// on the runner's allowlist (scripts/shakedown-approval-runner.mjs). Everything
// else sits in "needs-structuring" or "blocked" — real states, not silence.
function classifyApproved(approved) {
  const ledger = readRunnerLedger();
  return approved.map((p) => ({ ...p, ...classify(p, ledger) }));
}

function latestRunNotes(n = 5) {
  try {
    return readdirSync(RUNS).filter((f) => f.endsWith(".md")).sort().reverse().slice(0, n);
  } catch { return []; }
}

function page() {
  const s = readStatus();
  const proposals = parseProposals();
  const pending = proposals.filter((p) => p.state === "proposed");
  const approvedRaw = proposals.filter((p) => p.state === "approved");
  const approvedClassified = classifyApproved(approvedRaw);
  const machineReady = approvedClassified.filter((p) => p.classification === "machine-ready");
  const needsStructuring = approvedClassified.filter((p) => p.classification === "needs-structuring");
  const blocked = approvedClassified.filter((p) => p.classification === "blocked");
  const alreadyRun = approvedClassified.filter((p) => p.classification?.startsWith("already-"));
  const decided = proposals.filter((p) => p.state === "done" || p.state === "rejected" || p.state === "failed" || p.state === "retired").slice(-6).reverse();
  const f = s?.funnel ?? {}, c = s?.collection ?? {}, jobs = s?.jobs ?? {};
  const runNotes = latestRunNotes();
  const staged = stagedDrafts();
  const reviewStates = Object.fromEntries(staged.map((file) => [file, draftState(file)]));
  const awaitingRevision = staged.filter((file) => reviewStates[file].state === "notes-awaiting-revision" || reviewStates[file].state === "revision-requested");
  const readyForApproval = staged.filter((file) => reviewStates[file].state === "ready-for-approval");
  const published = publishedIssues();

  // mode: "proposal" -> Approve/Reject (existing). "decision" -> Retire/Mark-done
  // for already-approved cards, which is the missing actionable surface.
  const card = (p, mode) => {
    const { actionLine, paths } = mode === "decision" ? extractActionable(p.body) : { actionLine: null, paths: [] };
    return `
    <div class="card ${p.state}">
      <div class="card-head"><span class="pill ${p.state}">${p.state}</span><strong>${esc(p.title)}</strong></div>
      ${actionLine ? `<div class="whattodo"><strong>Do this:</strong> ${esc(actionLine)}</div>` : ""}
      ${paths.length ? `<div class="filelinks">${paths.map((pth) => `<a href="${reviewHref(pth)}" target="_blank">Read ${esc(pth.split("/").pop())}</a>`).join(" &nbsp;·&nbsp; ")}</div>` : ""}
      ${p.reason ? `<div class="whattodo blocked-reason"><strong>Blocked:</strong> ${esc(p.reason)}</div>` : ""}
      <pre>${esc(p.body)}</pre>
      ${mode === "proposal" ? `<div class="actions">
        <form method="POST" action="/decide"><input type="hidden" name="title" value="${esc(p.title)}"><input type="hidden" name="decision" value="approve"><button class="approve">Approve</button></form>
        <form method="POST" action="/decide"><input type="hidden" name="title" value="${esc(p.title)}"><input type="hidden" name="decision" value="reject"><input name="reason" placeholder="why not (optional)"><button class="reject">Reject</button></form>
      </div>` : ""}
      ${mode === "decision" ? `<div class="actions">
        <form method="POST" action="/mark-done"><input type="hidden" name="title" value="${esc(p.title)}"><input name="note" placeholder="what you actually did (optional)"><button class="approve">I did this — mark done</button></form>
        <form method="POST" action="/retire"><input type="hidden" name="title" value="${esc(p.title)}"><input name="reason" placeholder="why retire (optional)"><button class="reject">Retire — not doing this</button></form>
      </div>` : ""}
    </div>`;
  };

  return `<!doctype html><html><head><meta charset="utf-8"><title>Shakedown Desk</title>
<meta http-equiv="refresh" content="90">
<style>
  :root { color-scheme: dark; }
  body { font: 15px/1.45 -apple-system, system-ui, sans-serif; background: #14120f; color: #e8e2d5; max-width: 880px; margin: 2rem auto; padding: 0 1rem; }
  h1 { font-size: 1.3rem; } h2 { font-size: 1.05rem; margin-top: 1.8rem; border-bottom: 1px solid #3a352c; padding-bottom: .3rem; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: .6rem; margin: 1rem 0; }
  .stat { background: #1e1b16; border: 1px solid #332d24; border-radius: 8px; padding: .6rem .8rem; }
  .stat b { display: block; font-size: 1.4rem; } .stat span { color: #a89f8d; font-size: .8rem; }
  .card { background: #1e1b16; border: 1px solid #332d24; border-radius: 8px; padding: .8rem 1rem; margin: .7rem 0; }
  .card pre { white-space: pre-wrap; color: #bdb4a2; font-size: .82rem; margin: .5rem 0; max-height: 180px; overflow-y: auto; }
  .pill { font-size: .7rem; text-transform: uppercase; padding: .15rem .5rem; border-radius: 99px; margin-right: .6rem; }
  .pill.proposed { background: #7a5c12; } .pill.approved { background: #2d5c2f; } .pill.done { background: #24424a; } .pill.rejected, .pill.failed { background: #5c2727; } .pill.retired { background: #4a4438; }
  .actions { display: flex; gap: .6rem; } .actions form { display: flex; gap: .4rem; }
  button { border: 0; border-radius: 6px; padding: .45rem 1rem; font-weight: 700; cursor: pointer; }
  .approve { background: #3f8a43; color: #fff; } .reject { background: #8a3f3f; color: #fff; }
  input[name=reason], input[name=note] { background: #14120f; border: 1px solid #3a352c; border-radius: 6px; color: #e8e2d5; padding: .35rem .5rem; flex: 1; }
  .whattodo { background: #23301f; border: 1px solid #3a4a34; border-radius: 6px; padding: .5rem .7rem; margin: .5rem 0; font-size: .88rem; }
  .whattodo.blocked-reason { background: #302020; border-color: #4a3434; }
  .filelinks { font-size: .8rem; margin: .3rem 0; }
  .filelinks a, .draftlinks a { color: #8fc7ee; }
  .draftlinks { display: grid; gap: .5rem; margin: .7rem 0; }
  .draftlinks a { background: #23301f; border: 1px solid #3a4a34; border-radius: 6px; padding: .6rem .75rem; text-decoration: none; }
  table { width: 100%; border-collapse: collapse; font-size: .85rem; } td { padding: .3rem .4rem; border-bottom: 1px solid #2a251d; }
  .ok { color: #7fbf7f; } .warn { color: #d9a441; }
  .muted { color: #a89f8d; font-size: .8rem; }
</style></head><body>
  <h1>Shakedown Desk</h1>
  <div class="muted">Editorial control room · refreshed ${esc(s?.generatedAt ?? "?")}</div>
  <div class="stats">
    <div class="stat"><b>${published.length}</b><span>published on Shakedown Shuffle</span></div>
    <div class="stat"><b>${readyForApproval.length}</b><span>revised drafts ready for approval</span></div>
    <div class="stat"><b>${awaitingRevision.length}</b><span>drafts with your notes in revision</span></div>
    <div class="stat"><b>${pending.length}</b><span>other decisions waiting on you</span></div>
    <div class="stat"><b>${esc(s?.site?.checksPassed ?? "?")}/${esc(s?.site?.checksTotal ?? "?")}</b><span>site checks</span></div>
  </div>

  ${readyForApproval.length ? `<h2>Ready for your final approval (${readyForApproval.length})</h2><div class="muted">These drafts came back from revision. Open, verify the changes, then approve from the review page. Approval publishes only through the guarded Shakedown pipeline.</div><div class="draftlinks">${readyForApproval.map((file) => { const source = readFileSync(file, "utf-8"); return `<a href="${reviewHref(file)}"><strong>Review & approve</strong> · ${esc(titleFromSource(source, basename(file)))}</a>`; }).join("")}</div>` : ""}
  ${awaitingRevision.length ? `<h2>In revision — your notes are being worked (${awaitingRevision.length})</h2><div class="muted">Nothing more for you to do until the revised draft returns here for final approval.</div><div class="draftlinks">${awaitingRevision.map((file) => { const source = readFileSync(file, "utf-8"); return `<a href="${reviewHref(file)}"><strong>See notes & current draft</strong> · ${esc(titleFromSource(source, basename(file)))}</a>`; }).join("")}</div>` : ""}

  <h2>Your decisions ${pending.length ? `(${pending.length})` : "— nothing pending"}</h2>
  ${pending.map((p) => card(p, "proposal")).join("") || '<div class="muted">All clear.</div>'}

  ${staged.filter((file) => reviewStates[file].state === "ready-for-review").length ? `<h2>New drafts — edit before publication (${staged.filter((file) => reviewStates[file].state === "ready-for-review").length})</h2><div class="muted">These are new, unpublished work. Open one to read it and leave specific editorial notes for me. Nothing here is published by appearing on this list.</div><div class="draftlinks">${staged.filter((file) => reviewStates[file].state === "ready-for-review").map((file) => { const source = readFileSync(file, "utf-8"); return `<a href="${reviewHref(file)}"><strong>Read & annotate</strong> · ${esc(titleFromSource(source, basename(file)))}</a>`; }).join("")}</div>` : ""}

  <h2>Published on Shakedown Shuffle (${published.length})</h2><div class="muted">The live archive—not pipeline inventory. Opens the public issue.</div><div class="draftlinks">${published.map((p) => `<a href="${esc(p.url)}" target="_blank"><strong>Issue ${esc(p.issue)}</strong> · ${esc(p.title)}</a>`).join("")}</div>

  ${machineReady.length ? `<h2>Approved — machine-ready, executing on next runner tick (${machineReady.length})</h2><div class="muted">Nothing for you to click here — the approval runner will execute these automatically.</div>${machineReady.map((p) => card(p, "view")).join("")}` : ""}
  ${needsStructuring.length ? `<h2>Approved — action needed from you (${needsStructuring.length})</h2>
  <div class="muted">These are decisions you already made, but nothing can execute them for you (editorial judgment, a Substack/email send, or a production build). "Do this" shows the exact next step and file. When you've actually done it (or sent it), click "I did this — mark done". If it's stale or you changed your mind, click "Retire".</div>
  ${needsStructuring.map((p) => card(p, "decision")).join("")}` : ""}
  ${blocked.length ? `<h2>Approved — blocked, needs a fix first (${blocked.length})</h2>${blocked.map((p) => card(p, "decision")).join("")}` : ""}
  ${alreadyRun.length ? `<h2>Approved — already resolved by runner (${alreadyRun.length})</h2><div class="muted">${alreadyRun.map((p) => esc(`${p.title}: ${p.classification}`)).join("<br>")}</div>` : ""}

  <h2>Right now</h2>
  <div class="stats">
    <div class="stat"><b>${esc(f.visitsToday ?? "?")}</b><span>visits today · ${esc(f.visits7d ?? "?")} / 7d</span></div>
    <div class="stat"><b>${esc(f.activeStripeSubscriptions ?? "?")}</b><span>paying subs · rate ${esc(f.checkoutPaidRate ?? "?")}</span></div>
    <div class="stat"><b>${esc(f.authUsers ?? "?")}</b><span>auth users · ${esc(f.emailSignups ?? "?")} email signups</span></div>
    <div class="stat"><b>${esc(c.wanted?.have_audio ?? "?")}</b><span>shows with audio · pass ${esc(c.passNumber ?? "?")}</span></div>
    <div class="stat"><b>${esc(s?.site?.checksPassed ?? "?")}/${esc(s?.site?.checksTotal ?? "?")}</b><span>operator checks</span></div>
  </div>

  <h2>Automations</h2>
  <table>${Object.entries(jobs).map(([id, j]) => j === "not-registered"
    ? `<tr><td>${esc(id)}</td><td class="warn">not registered</td><td></td></tr>`
    : `<tr><td>${esc(id)}</td><td class="${j.consecutiveErrors ? "warn" : "ok"}">${esc(j.lastStatus ?? "no run yet")}${j.consecutiveErrors ? ` · ${j.consecutiveErrors} errors` : ""}</td><td class="muted">next ${esc(j.nextRunAt ?? "?")}</td></tr>`).join("")}
  </table>

  ${runNotes.length ? `<h2>Proposer run notes</h2><div class="muted">${runNotes.map(esc).join("<br>")}</div>` : ""}
  ${decided.length ? `<h2>Recently decided</h2>${decided.map((p) => card(p, "view")).join("")}` : ""}
</body></html>`;
}

function handlePost(req, res, handler) {
  let body = "";
  req.on("data", (d) => { body += d; if (body.length > 10_000) req.destroy(); });
  req.on("end", () => {
    try {
      const params = new URLSearchParams(body);
      handler(params);
      res.writeHead(303, { Location: "/" }).end();
    } catch (e) {
      res.writeHead(400, { "Content-Type": "text/plain" }).end(`action failed: ${e.message}`);
    }
  });
}

const server = createServer((req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
    if (req.method === "GET" && url.pathname === "/review") {
      const file = reviewPath(url.searchParams.get("file"));
      if (!file) return res.writeHead(404, { "Content-Type": "text/plain" }).end("Review file not found or not available on the Desk.");
      return res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(renderReview(file));
    }
    if (req.method === "POST" && url.pathname === "/review-note") {
      return handlePost(req, res, (p) => {
        const file = reviewPath(p.get("file"));
        if (!file) throw new Error("review file not found or not available on the Desk");
        addNote(file, p.get("note") || "");
        reviseDraft(file);
      });
    }
    if (req.method === "POST" && url.pathname === "/approve-draft") {
      return handlePost(req, res, (p) => {
        const file = reviewPath(p.get("file"));
        if (!file) throw new Error("review file not found or not available on the Desk");
        approveDraft(file);
      });
    }
    if (req.method === "POST" && url.pathname === "/decide") {
      return handlePost(req, res, (p) => decide(p.get("title"), p.get("decision"), p.get("reason") || ""));
    }
    if (req.method === "POST" && url.pathname === "/retire") {
      return handlePost(req, res, (p) => retire(p.get("title"), p.get("reason") || ""));
    }
    if (req.method === "POST" && url.pathname === "/mark-done") {
      return handlePost(req, res, (p) => markDone(p.get("title"), p.get("note") || ""));
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(page());
  } catch (e) {
    res.writeHead(500, { "Content-Type": "text/plain" }).end(String(e.message));
  }
});
server.listen(PORT, "127.0.0.1", () => console.log(`[desk] http://127.0.0.1:${PORT}`));
