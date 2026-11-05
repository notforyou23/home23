#!/usr/bin/env node
// Build reactivation/comms segments from Supabase + Stripe into a private file.
// Jerry runs this on request: `node scripts/shakedown-comms-segments.mjs`.
//
// Raw emails go ONLY to <site>/private/ (mode 0600, gitignored, denied to the
// proposer). Stdout carries counts and masked previews — never full addresses.
// Segments: seg0 paid+unclaimed pending; seg1 expired-unpaid checkout emails
// (minus active subs); seg2 signups without profiles; seg3 non-active profiles.
// Active subscribers are excluded from every outreach segment.

import { readFileSync, writeFileSync, chmodSync } from "node:fs";

const SITE = "/Users/jtr/websites/shakedownshuffle.com";
const envSrc = readFileSync(`${SITE}/jerry-api/.env`, "utf-8");
const env = Object.fromEntries(envSrc.split("\n").filter((l) => l.includes("=") && !l.startsWith("#"))
  .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]));
const H = { apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}` };
const base = env.SUPABASE_URL.replace(/\/$/, "");
const get = async (p) => (await fetch(`${base}${p}`, { headers: H })).json();
const lower = (e) => (e || "").toLowerCase();
const mask = (e) => (e ? e.slice(0, 3) + "***@" + e.split("@")[1] : "?");

const signups = await get("/rest/v1/email_signups?select=email,signup_source,created_at");
const profiles = await get("/rest/v1/profiles?select=id,subscription_status,subscription_tier,created_at");
const pending = await get("/rest/v1/pending_subscriptions?select=email,subscription_status,subscription_tier,created_at,claimed_by,claimed_at");
const authResp = await fetch(`${base}/auth/v1/admin/users?per_page=200`, { headers: H }).then((r) => r.json());
const auth = (authResp.users ?? []).map((u) => ({ id: u.id, email: u.email, last_sign_in_at: u.last_sign_in_at }));
const emailById = new Map(auth.map((u) => [u.id, u.email]));

const sessions = (await (await fetch("https://api.stripe.com/v1/checkout/sessions?limit=100",
  { headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` } })).json()).data ?? [];

const activeSubEmails = new Set(profiles.filter((p) => p.subscription_status === "active")
  .map((p) => lower(emailById.get(p.id))).filter(Boolean));
const seg0 = pending.filter((p) => p.subscription_status === "active" && !p.claimed_by);
const seg1 = [...new Set(sessions.filter((s) => s.status === "expired" && s.payment_status === "unpaid")
  .map((s) => lower(s.customer_details?.email || s.customer_email)).filter(Boolean))]
  .filter((e) => !activeSubEmails.has(e) && !e.endsWith("@shakedownshuffle.com"));
const seg3 = profiles.filter((p) => p.subscription_status !== "active")
  .map((p) => ({ email: emailById.get(p.id), created: p.created_at })).filter((x) => x.email);
const known = new Set([...seg3.map((x) => lower(x.email)), ...activeSubEmails]);
const seg2 = signups.filter((s) => s.signup_source !== "rls_test" && s.email
  && !known.has(lower(s.email)) && !seg1.includes(lower(s.email)))
  .map((s) => ({ email: s.email, created: s.created_at }));

const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
const path = `${SITE}/private/reactivation-segments-${stamp}.json`;
writeFileSync(path, JSON.stringify({ generatedAt: new Date().toISOString(),
  seg0_paidPending: seg0, seg1_triedToPay: seg1, seg2_signupsOnly: seg2,
  seg3_freeProfiles: seg3, activeSubsExcluded: [...activeSubEmails] }, null, 2));
chmodSync(path, 0o600);
for (const [name, list] of [["seg3-profiles", seg3.map((x) => x.email)], ["seg2-signups", seg2.map((x) => x.email)]]) {
  const p = `${SITE}/private/${name}-bcc-${stamp}.csv`;
  writeFileSync(p, list.join("\n") + "\n"); chmodSync(p, 0o600);
}
console.log(JSON.stringify({ wrote: path,
  seg0: { n: seg0.length, preview: seg0.map((p) => `${mask(p.email)} ${p.subscription_tier} claimed=${Boolean(p.claimed_by)}`) },
  seg1: { n: seg1.length }, seg2: { n: seg2.length }, seg3: { n: seg3.length },
  excludedActive: activeSubEmails.size }, null, 1));
