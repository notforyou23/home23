#!/usr/bin/env node
/**
 * Send a bounded, individually addressed Shakedown outreach batch through
 * the local Mail.app account. Requires explicit --send; maintains an
 * append-only JSONL delivery ledger and refuses duplicate addresses.
 *
 * node scripts/shakedown-send-mail-batch.mjs <campaign-dir> --count 10 \
 *   --from jtr@shakedownshuffle.com --interval-seconds 45 --send
 */
import { existsSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const campaignDir = args[0];
const opt = (name, fallback = null) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const count = Number(opt("--count", "0"));
const from = opt("--from");
const intervalSeconds = Number(opt("--interval-seconds", "0"));
const sending = args.includes("--send");
if (!campaignDir || !Number.isInteger(count) || count < 1 || !from || !sending || !Number.isFinite(intervalSeconds) || intervalSeconds < 0) {
  console.error("usage: shakedown-send-mail-batch.mjs <campaign-dir> --count N --from sender@example.com --interval-seconds N --send");
  process.exit(1);
}

const manifestPath = join(campaignDir, "manifest.json");
const ledgerPath = join(campaignDir, "delivery-ledger.jsonl");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const prior = existsSync(ledgerPath)
  ? readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
const alreadySent = new Set(prior.filter((row) => row.status === "sent").map((row) => row.to.toLowerCase()));
const selected = manifest.contacts.filter((contact) => contact.status === "ready_to_stage" && !alreadySent.has(contact.to.toLowerCase())).slice(0, count);
if (selected.length !== count) {
  console.error(`refusing partial batch: requested ${count}, only ${selected.length} unsent ready contacts remain`);
  process.exit(1);
}

const esc = (s) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, '" & return & "');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sendOne = (contact) => {
  const raw = readFileSync(join(campaignDir, contact.draft), "utf8");
  const subjectMatch = raw.match(/^Subject: (.+)$/m);
  if (!subjectMatch) throw new Error(`missing Subject line in ${contact.draft}`);
  const body = raw.split(/^Subject: .+$/m)[1].trim();
  const script = [
    'tell application "Mail"',
    `  set msg to make new outgoing message with properties {subject:"${esc(subjectMatch[1])}", content:"${esc(body)}", visible:false}`,
    '  tell msg',
    `    set sender to "${esc(from)}"`,
    `    make new to recipient at end of to recipients with properties {address:"${esc(contact.to)}"}`,
    '    send',
    '  end tell',
    'end tell',
  ].join("\n");
  execFileSync("osascript", ["-e", script], { stdio: "pipe", timeout: 30000 });
};

const outcomes = [];
for (const [index, contact] of selected.entries()) {
  const startedAt = new Date().toISOString();
  try {
    sendOne(contact);
    const row = { timestamp: new Date().toISOString(), status: "sent", campaign: manifest.campaign, from, number: contact.number, bandName: contact.bandName, to: contact.to, subject: contact.subject, draft: contact.draft, startedAt };
    appendFileSync(ledgerPath, JSON.stringify(row) + "\n", { mode: 0o600 });
    contact.status = "sent";
    contact.sentAt = row.timestamp;
    outcomes.push(row);
  } catch (error) {
    const row = { timestamp: new Date().toISOString(), status: "failed", campaign: manifest.campaign, from, number: contact.number, bandName: contact.bandName, to: contact.to, subject: contact.subject, draft: contact.draft, startedAt, error: String(error.stderr || error.message || error) };
    appendFileSync(ledgerPath, JSON.stringify(row) + "\n", { mode: 0o600 });
    outcomes.push(row);
  }
  if (index < selected.length - 1 && intervalSeconds > 0) await sleep(intervalSeconds * 1000);
}
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
console.log(JSON.stringify({ campaign: manifest.campaign, requested: count, sent: outcomes.filter((x) => x.status === "sent").length, failed: outcomes.filter((x) => x.status === "failed").length, ledgerPath, outcomes }, null, 2));
process.exit(outcomes.some((x) => x.status === "failed") ? 1 : 0);
