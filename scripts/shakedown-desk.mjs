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
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { join } from "node:path";

const H23 = "/Users/jtr/_JTR23_/release/home23";
const PROJECT = join(H23, "instances/jerry/workspace/projects/shakedownshuffle");
const QUEUE = join(PROJECT, "content/article-editorial-queue.md");
const STATUS = join(PROJECT, "status/latest.json");
const RUNS = join(H23, "instances/workers/shakedown-jerry/workspace/runs");
const PORT = 7788;

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function parseProposals() {
  if (!existsSync(QUEUE)) return [];
  const src = readFileSync(QUEUE, "utf-8");
  const out = [];
  const re = /^### \[(proposed|approved|done|rejected|failed)\] (.+)$/gm;
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

function readStatus() {
  try { return JSON.parse(readFileSync(STATUS, "utf-8")); } catch { return null; }
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
  const approved = proposals.filter((p) => p.state === "approved");
  const decided = proposals.filter((p) => p.state === "done" || p.state === "rejected" || p.state === "failed").slice(-6).reverse();
  const f = s?.funnel ?? {}, c = s?.collection ?? {}, jobs = s?.jobs ?? {};
  const runNotes = latestRunNotes();

  const card = (p, buttons) => `
    <div class="card ${p.state}">
      <div class="card-head"><span class="pill ${p.state}">${p.state}</span><strong>${esc(p.title)}</strong></div>
      <pre>${esc(p.body)}</pre>
      ${buttons ? `<div class="actions">
        <form method="POST" action="/decide"><input type="hidden" name="title" value="${esc(p.title)}"><input type="hidden" name="decision" value="approve"><button class="approve">Approve</button></form>
        <form method="POST" action="/decide"><input type="hidden" name="title" value="${esc(p.title)}"><input type="hidden" name="decision" value="reject"><input name="reason" placeholder="why not (optional)"><button class="reject">Reject</button></form>
      </div>` : ""}
    </div>`;

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
  .pill.proposed { background: #7a5c12; } .pill.approved { background: #2d5c2f; } .pill.done { background: #24424a; } .pill.rejected, .pill.failed { background: #5c2727; }
  .actions { display: flex; gap: .6rem; } .actions form { display: flex; gap: .4rem; }
  button { border: 0; border-radius: 6px; padding: .45rem 1rem; font-weight: 700; cursor: pointer; }
  .approve { background: #3f8a43; color: #fff; } .reject { background: #8a3f3f; color: #fff; }
  input[name=reason] { background: #14120f; border: 1px solid #3a352c; border-radius: 6px; color: #e8e2d5; padding: .35rem .5rem; }
  table { width: 100%; border-collapse: collapse; font-size: .85rem; } td { padding: .3rem .4rem; border-bottom: 1px solid #2a251d; }
  .ok { color: #7fbf7f; } .warn { color: #d9a441; }
  .muted { color: #a89f8d; font-size: .8rem; }
</style></head><body>
  <h1>Shakedown Desk</h1>
  <div class="muted">Generated ${esc(s?.generatedAt ?? "?")} · auto-refreshes · decisions rewrite the queue and refresh Jerry's context</div>

  <h2>Needs you ${pending.length ? `(${pending.length})` : "— nothing pending"}</h2>
  ${pending.map((p) => card(p, true)).join("") || '<div class="muted">All clear.</div>'}
  ${approved.length ? `<h2>Approved, awaiting run (${approved.length})</h2>${approved.map((p) => card(p, false)).join("")}` : ""}

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
  ${decided.length ? `<h2>Recently decided</h2>${decided.map((p) => card(p, false)).join("")}` : ""}
</body></html>`;
}

const server = createServer((req, res) => {
  try {
    if (req.method === "POST" && req.url === "/decide") {
      let body = "";
      req.on("data", (d) => { body += d; if (body.length > 10_000) req.destroy(); });
      req.on("end", () => {
        try {
          const params = new URLSearchParams(body);
          decide(params.get("title"), params.get("decision"), params.get("reason") || "");
          res.writeHead(303, { Location: "/" }).end();
        } catch (e) {
          res.writeHead(400, { "Content-Type": "text/plain" }).end(`decision failed: ${e.message}`);
        }
      });
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(page());
  } catch (e) {
    res.writeHead(500, { "Content-Type": "text/plain" }).end(String(e.message));
  }
});
server.listen(PORT, "127.0.0.1", () => console.log(`[desk] http://127.0.0.1:${PORT}`));
