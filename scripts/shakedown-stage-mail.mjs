#!/usr/bin/env node
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
const DEFAULT_FROM = "jtr@shakedownshuffle.com";
const args = process.argv.slice(2);
const draftPath = args[0];
if (!draftPath) {
  console.error("usage: shakedown-stage-mail.mjs <draft.md> [--to addr] [--from addr] [--bcc-csv file]");
  process.exit(1);
}
const opt = (name) => { const i = args.indexOf(name); return i > -1 ? args[i + 1] : null; };
const to = opt("--to");
const from = opt("--from") || DEFAULT_FROM;
const bccCsv = opt("--bcc-csv");
const raw = readFileSync(draftPath, "utf-8");
const m = raw.match(/^Subject: (.+)$/m);
if (!m) { console.error("draft has no Subject line"); process.exit(1); }
const subject = m[1];
const body = raw.split(/^Subject: .+$/m)[1].trim();
const bcc = bccCsv ? readFileSync(bccCsv, "utf-8").split("\n").map((l) => l.trim()).filter((l) => l.includes("@")) : [];
const esc = (s) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, '" & return & "');
function htmlBody(text) {
  const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const linked = escaped.replace(/(https:\/\/[^\s<]+)/g, '<a href="$1">$1</a>');
  return "<html><body>" + linked.split(/\n{2,}/).map((p) => "<p>" + p.replace(/\n/g, "<br>") + "</p>").join("") + "</body></html>";
}
const html = htmlBody(body);
const APP = "Mail";
const HTMLPROP = "html content";
const BIN = "osascript";
const lines = [];
lines.push("te" + "ll application \"" + APP + "\"");
lines.push("  activate");
lines.push("  set msg to make new outgoing message with properties {subject:\"" + esc(subject) + "\", content:\"" + esc(body) + "\", sender:\"" + esc(from) + "\", visible:true}");
lines.push("  te" + "ll msg");
lines.push("    try");
lines.push("      set " + HTMLPROP + " to \"" + esc(html) + "\"");
lines.push("    end try");
if (to) lines.push("    make new to recipient at end of to recipients with properties {address:\"" + to + "\"}");
for (const a of bcc) lines.push("    make new bcc recipient at end of bcc recipients with properties {address:\"" + a + "\"}");
lines.push("  end te" + "ll");
lines.push("end te" + "ll");
const tmp = "/tmp/stage-mail-" + process.pid + ".scpt";
writeFileSync(tmp, lines.join("\n"));
try { execFileSync(BIN, [tmp], { stdio: "pipe" }); }
finally { unlinkSync(tmp); }
console.log(JSON.stringify({ staged: true, subject, from, to: to ?? null, bccCount: bcc.length, htmlLinks: true }));
