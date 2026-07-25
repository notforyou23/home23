#!/usr/bin/env node
// Stage an email as a VISIBLE DRAFT in Mail.app — composes, never sends.
// jtr reviews the draft and presses Send; that click is the approval.
//
//   node scripts/shakedown-stage-mail.mjs <draft.md> [--to a@b.c] [--bcc-csv file]
//
// Draft format: a "Subject: ..." line; everything after it is the body.
// BCC csv: one address per line (the private/ segment CSVs).

import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const draftPath = args[0];
if (!draftPath) { console.error("usage: shakedown-stage-mail.mjs <draft.md> [--to addr] [--bcc-csv file]"); process.exit(1); }
const opt = (name) => { const i = args.indexOf(name); return i > -1 ? args[i + 1] : null; };
const to = opt("--to");
const bccCsv = opt("--bcc-csv");

const raw = readFileSync(draftPath, "utf-8");
const m = raw.match(/^Subject: (.+)$/m);
if (!m) { console.error("draft has no 'Subject:' line"); process.exit(1); }
const subject = m[1];
const body = raw.split(/^Subject: .+$/m)[1].trim();
const bcc = bccCsv ? readFileSync(bccCsv, "utf-8").split("\n").map((l) => l.trim()).filter((l) => l.includes("@")) : [];

const esc = (s) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, '" & return & "');
const lines = [
  'tell application "Mail"', "  activate",
  `  set msg to make new outgoing message with properties {subject:"${esc(subject)}", content:"${esc(body)}", visible:true}`,
  "  tell msg",
  ...(to ? [`    make new to recipient at end of to recipients with properties {address:"${to}"}`] : []),
  ...bcc.map((a) => `    make new bcc recipient at end of bcc recipients with properties {address:"${a}"}`),
  "  end tell", "end tell",
];
const tmp = `/tmp/stage-mail-${process.pid}.scpt`;
writeFileSync(tmp, lines.join("\n"));
try { execFileSync("osascript", [tmp], { stdio: "pipe" }); } finally { unlinkSync(tmp); }
console.log(JSON.stringify({ staged: true, subject, to: to ?? null, bccCount: bcc.length,
  note: "draft is open in Mail.app — review the From dropdown, then Send" }));
