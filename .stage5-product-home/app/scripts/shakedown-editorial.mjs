#!/usr/bin/env node
// shakedown-editorial.mjs — the deterministic spine of the three-role editorial
// pipeline (researcher -> writer -> publisher). It replaces the retired
// card/approval critical path (article-editorial-queue, shakedown-approval-runner)
// with filesystem artifacts + two real, verifiable checks.
//
// The three roles hand off through DIRECTORIES + RECEIPTS, not a card queue:
//
//   content/dossiers/<slug>.md          researcher output (ranked, state: ready|blocked)
//   content/dossiers/<slug>.consumed.json  writer's receipt: dossier -> draft
//   content/drafts/<slug>.md            writer output (complete manuscript)
//   content/newsletter/issue-NN-slug.md canonical (publisher promotes here)
//   content/receipts/publisher/<ts>-<slug>.json  publisher receipt: both checks
//
// This file is ALSO the publisher's mechanical enforcement. Agent judgement
// (Check A editorial/factual verification) is necessary but NOT sufficient — the
// deterministic gates below back it, and the publish orchestration fails CLOSED
// on any concrete failure (private-path leak, missing sources, broken structure,
// prohibited language, unverified first-person, duplicate, missing hero, failed
// render preflight, failed deploy, failed live readback). It never gates on an
// approval label or a card status.
//
// SAFETY: `publish` only performs a production cutover when invoked with --apply,
// and the cutover itself builds a fresh candidate through the publishing pipeline,
// then runs the existing guarded deploy-site.mjs path (snapshot + preflight +
// overlay-without-delete + live readback). Every other
// subcommand touches only temp dirs and the workspace. Tests never touch
// production.
//
// CLI:
//   node scripts/shakedown-editorial.mjs validate  <draft.md>
//   node scripts/shakedown-editorial.mjs preflight <draft.md>   # render Check B (temp only)
//   node scripts/shakedown-editorial.mjs promote   <draft.md>   # gate + write canonical + receipt (NO deploy)
//   node scripts/shakedown-editorial.mjs publish   <draft.md> [--apply]  # both checks -> guarded deploy
//   node scripts/shakedown-editorial.mjs pick-dossier   # print highest-ranked ready, unconsumed dossier
//   node scripts/shakedown-editorial.mjs pick-draft     # print next complete, unpromoted draft

import { readFile, writeFile, readdir, mkdir, stat, cp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Operational paths (absolute — these are operational, per project doctrine).
// ---------------------------------------------------------------------------
export const PROJECT_ROOT =
  "/Users/jtr/_JTR23_/release/home23/instances/jerry/workspace/projects/shakedownshuffle";
export const CONTENT_DIR = path.join(PROJECT_ROOT, "content");
export const DOSSIERS_DIR = path.join(CONTENT_DIR, "dossiers");
export const DRAFTS_DIR = path.join(CONTENT_DIR, "drafts");
export const NEWSLETTER_DIR = path.join(CONTENT_DIR, "newsletter");
export const RECEIPTS_DIR = path.join(CONTENT_DIR, "receipts");
export const SITE_ROOT = "/Users/jtr/websites/shakedownshuffle.com";
export const SHAKEDOWN_V2 = path.join(SITE_ROOT, "shakedown-v2");
export const IMAGE_ROOTS = [
  path.join(SHAKEDOWN_V2, "public"), // /images/... resolves under here (tracked source)
  path.join(SITE_ROOT, "html"), // and its live mirror
];
// The private corpus that MUST NEVER be read by any unattended flow.
export const PRIVATE_PATH_MARKER = "cosmo-content/_private";

// ---------------------------------------------------------------------------
// Prohibited-language contract (mirrors the voicepack verification gate).
// ---------------------------------------------------------------------------
export const PROHIBITED_WORDS = [
  "moreover",
  "furthermore",
  "delve",
  "leverage",
  "landscape",
  "robust",
];
// jtr's #1 tell — "this isn't X, it's Y" in any variant.
export const NOT_X_ITS_Y =
  /\b(?:this|that|it|these|those)\s+(?:is|are|was|were|isn['’]t|wasn['’]t|aren['’]t|weren['’]t)\b[^.?!\n]{0,80}?,?\s*(?:it['’]s|its|they['’]re|that['’]s)\b/i;
// Tighter canonical form: "not X, but/it's Y".
export const NOT_X_BUT_Y = /\bnot\s+[^.?!\n]{1,60}?,\s*(?:it['’]s|but|rather)\b/i;

const REQUIRED_FRONTMATTER = [
  "title",
  "issue",
  "date",
  "canonical_target",
  "scheduled_at",
  "social_image",
  "social_image_alt",
  "primary_cta",
];

// ---------------------------------------------------------------------------
// Parsing helpers (frontmatter parser matches build-newsletter-pages.mjs).
// ---------------------------------------------------------------------------
function unquote(raw) {
  const t = String(raw ?? "").trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

export function parseFrontmatter(markdown) {
  const m = String(markdown ?? "").match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: String(markdown ?? "") };
  const meta = {};
  for (const line of m[1].split("\n")) {
    const at = line.indexOf(":");
    if (at === -1) continue;
    const key = line.slice(0, at).trim();
    if (key) meta[key] = unquote(line.slice(at + 1));
  }
  return { meta, body: m[2] };
}

export function slugify(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function normalizeTitle(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/^issue\s*#?\d+\s*[—:-]\s*/i, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Strip inline "quoted spans" and blockquote lines so a first-person pronoun
// INSIDE a sourced quotation does not trip the gate meant for the narrator.
function narratorProse(body) {
  return String(body ?? "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith(">")) // drop blockquotes
    .filter((line) => !line.trimStart().startsWith("#")) // drop headings ("SET I", "SET II")
    .join("\n")
    .replace(/```[\s\S]*?```/g, "") // drop fenced code
    .replace(/"[^"]*"/g, " ") // drop straight-quoted spans
    .replace(/[“][^”]*[”]/g, " "); // drop curly-quoted spans
}

// ---------------------------------------------------------------------------
// Individual deterministic gates. Each returns { ok, detail }.
// ---------------------------------------------------------------------------
export function checkForbiddenPrivatePath(markdown) {
  // Reject any USE of the private corpus. A NEGATIVE attestation ("No material
  // from cosmo-content/_private/") is exactly the provenance we want and must
  // not be flagged — so a mention preceded by a negation in the same clause is OK.
  const text = String(markdown ?? "");
  const marker = PRIVATE_PATH_MARKER;
  const negation = /\b(no|not|never|without|exclud\w*|omit\w*|avoid\w*|zero|none)\b[^.?!\n]{0,40}$/i;
  let idx = text.indexOf(marker);
  const offending = [];
  while (idx !== -1) {
    const before = text.slice(Math.max(0, idx - 60), idx);
    if (!negation.test(before)) offending.push(idx);
    idx = text.indexOf(marker, idx + marker.length);
  }
  return {
    ok: offending.length === 0,
    detail: offending.length
      ? `draft cites the private corpus (${marker}) without a negation; it must never be sourced or quoted`
      : "no private-corpus citation (negated attestations are allowed)",
  };
}

export function checkStructure(body) {
  const text = String(body ?? "");
  const missing = [];
  if (!/^##\s+SET\s+I\b/im.test(text)) missing.push("SET I");
  if (!/^##\s+SET\s+II\b/im.test(text)) missing.push("SET II");
  if (!/DRUMS|SPACE/i.test(text)) missing.push("DRUMS/SPACE");
  if (!/^##\s+ENCORE\b/im.test(text)) missing.push("ENCORE");
  if (!/sources\s*\/?\s*(further reading)?/i.test(text)) missing.push("Sources");
  // Forward/subscribe footer OR the owned-site capture CTA.
  const hasFooter =
    /\bsubscribe\b/i.test(text) ||
    /\bforward\b/i.test(text) ||
    /\/start\/?/.test(text) ||
    /shakedownshuffle\.com\/subscribe/i.test(text);
  if (!hasFooter) missing.push("forward/subscribe footer");
  return {
    ok: missing.length === 0,
    detail: missing.length ? `missing house structure: ${missing.join(", ")}` : "house setlist structure intact",
    missing,
  };
}

export function checkProhibitedLanguage(body) {
  const text = String(body ?? "");
  const found = [];
  for (const word of PROHIBITED_WORDS) {
    if (new RegExp(`\\b${word}\\b`, "i").test(text)) found.push(word);
  }
  if (NOT_X_ITS_Y.test(text) || NOT_X_BUT_Y.test(text)) found.push('this-isnt-x-its-y');
  return {
    ok: found.length === 0,
    detail: found.length ? `prohibited language: ${found.join(", ")}` : "no prohibited language",
    found,
  };
}

export function checkFirstPerson(body, meta = {}) {
  // First-person SINGULAR in the narrator's own voice signals an unverified
  // personal claim. Editorial "you"/"we" is fine. An explicit attestation in
  // frontmatter (first_person_ok: true) means the writer sourced it deliberately.
  if (String(meta.first_person_ok).toLowerCase() === "true") {
    return { ok: true, detail: "first-person attested (first_person_ok: true)" };
  }
  const prose = narratorProse(body);
  const m = prose.match(/(^|[^A-Za-z])(I|I['’]m|I['’]ve|I['’]d|I['’]ll|me|my|mine|myself)([^A-Za-z]|$)/);
  if (m) {
    return {
      ok: false,
      detail: `unattested first-person narration ("${m[2]}"); source the claim or set first_person_ok: true with provenance`,
    };
  }
  return { ok: true, detail: "no unattested first-person narration" };
}

export function checkSources(body, meta = {}, { minSources = 3 } = {}) {
  const text = String(body ?? "");
  const idx = text.search(/^#{2,3}\s+sources\b/im);
  if (idx === -1) {
    return { ok: false, detail: "no Sources / Further Reading section", count: 0 };
  }
  const section = text.slice(idx);
  const bullets = section.split("\n").filter((l) => /^\s*[-*]\s+\S/.test(l)).length;
  return {
    ok: bullets >= minSources,
    detail: bullets >= minSources ? `${bullets} sources cited` : `only ${bullets} sources (need >= ${minSources})`,
    count: bullets,
  };
}

export function checkDuplicate(
  meta,
  { canonicalSlugs = [], canonicalTitles = [], selfSlug = null, selfTitle = null } = {}
) {
  const slug = slugFromMeta(meta);
  const title = normalizeTitle(meta.title);
  const slugSet = new Set(canonicalSlugs.filter((s) => s !== selfSlug));
  const titleSet = new Set(
    canonicalTitles.map(normalizeTitle).filter((candidate) => candidate !== normalizeTitle(selfTitle))
  );
  if (slug && slugSet.has(slug)) {
    return { ok: false, detail: `duplicate slug "${slug}" already canonical` };
  }
  if (title && titleSet.has(title)) {
    return { ok: false, detail: `duplicate title "${meta.title}" already canonical` };
  }
  return { ok: true, detail: "slug and title are unique" };
}

export function checkHero(meta, { imageRoots = IMAGE_ROOTS } = {}) {
  const img = meta.social_image;
  if (!img) {
    return { ok: false, detail: "missing social_image (mandatory hero contract; card degrades to summary)" };
  }
  if (!meta.social_image_alt) {
    return { ok: false, detail: "missing social_image_alt (accessibility + card contract)" };
  }
  const rel = String(img).replace(/^https?:\/\/[^/]+/, "").replace(/^\/+/, "");
  const resolved = imageRoots.map((root) => path.join(root, rel));
  const found = resolved.find((p) => existsSync(p));
  if (!found) {
    return { ok: false, detail: `hero file not found for ${img} (looked under: ${imageRoots.join(", ")})` };
  }
  return { ok: true, detail: `hero present: ${found}` };
}

export function checkRequiredFrontmatter(meta) {
  const missing = REQUIRED_FRONTMATTER.filter((k) => !meta[k]);
  return {
    ok: missing.length === 0,
    detail: missing.length ? `missing frontmatter: ${missing.join(", ")}` : "required frontmatter present",
    missing,
  };
}

function slugFromMeta(meta) {
  if (meta.slug) return slugify(meta.slug);
  if (meta.canonical_target) {
    const m = String(meta.canonical_target).match(/\/newsletter\/([^/]+)\/?/);
    if (m) return m[1];
  }
  if (meta.issue && meta.title) return `issue-${meta.issue}-${slugify(meta.title)}`;
  return meta.title ? slugify(meta.title) : "";
}

// ---------------------------------------------------------------------------
// Aggregate: Check A (editorial mechanical gates) on a draft's markdown.
// This is the deterministic BACKBONE of the publisher's independent editorial
// verification — the agent's judgement rides on top of it, never instead of it.
// Hero + required frontmatter are enforced at promote/publish time (a draft need
// not carry a hero yet; the canonical issue must).
// ---------------------------------------------------------------------------
export function validateDraft(markdown, ctx = {}) {
  const { meta, body } = parseFrontmatter(markdown);
  const checks = {
    privatePath: checkForbiddenPrivatePath(markdown),
    structure: checkStructure(body),
    prohibitedLanguage: checkProhibitedLanguage(body),
    firstPerson: checkFirstPerson(body, meta),
    sources: checkSources(body, meta, ctx),
    duplicate: checkDuplicate(meta, ctx),
  };
  const failures = Object.entries(checks)
    .filter(([, c]) => !c.ok)
    .map(([name, c]) => `${name}: ${c.detail}`);
  return { ok: failures.length === 0, checks, failures, meta };
}

// Full pre-cutover gate: everything in validateDraft PLUS the canonical-issue
// contract (required frontmatter + mandatory hero on disk).
export function promoteReadiness(markdown, ctx = {}) {
  const base = validateDraft(markdown, ctx);
  const heroCheck = checkHero(base.meta, ctx);
  const fmCheck = checkRequiredFrontmatter(base.meta);
  const checks = { ...base.checks, requiredFrontmatter: fmCheck, hero: heroCheck };
  const failures = Object.entries(checks)
    .filter(([, c]) => !c.ok)
    .map(([name, c]) => `${name}: ${c.detail}`);
  return { ok: failures.length === 0, checks, failures, meta: base.meta };
}

// ---------------------------------------------------------------------------
// Publish orchestration. Both checks must pass BEFORE any deploy. deploy is
// invoked only after editorial (A) and render (B) both pass and promotion
// succeeds. Dependencies are injected so this is unit-testable without touching
// production — the test asserts deploy is never called when a check fails.
// ---------------------------------------------------------------------------
export async function runPublish({ checkEditorial, checkRender, promote, deploy, verifyLive, log = () => {} }) {
  const receipt = { deployCalled: false, promoted: false, deployed: false, liveVerified: false };

  const a = await checkEditorial();
  receipt.editorial = a;
  if (!a.ok) {
    log("BLOCKED at Check A (editorial). deploy not called.");
    return { status: "blocked", stage: "editorial", receipt };
  }

  const b = await checkRender();
  receipt.render = b;
  if (!b.ok) {
    log("BLOCKED at Check B (render/preflight). deploy not called.");
    return { status: "blocked", stage: "render", receipt };
  }

  // Only now — both checks green — do we mutate anything.
  const p = await promote();
  receipt.promote = p;
  receipt.promoted = !!p?.ok && !p?.dryRun && !p?.skipped;
  if (!p?.ok) {
    log("BLOCKED at promote. deploy not called.");
    return { status: "blocked", stage: "promote", receipt };
  }

  receipt.deployCalled = true;
  const d = await deploy();
  receipt.deploy = d;
  receipt.deployed = !!d?.ok && !d?.dryRun && !d?.skipped;
  if (!d?.ok) {
    log("FAILED at deploy (guarded path failed closed).");
    return { status: "failed", stage: "deploy", receipt };
  }

  const live = await verifyLive();
  receipt.live = live;
  receipt.liveVerified = !!live?.ok && !live?.dryRun && !live?.skipped;
  if (!live?.ok) {
    log("FAILED at live readback.");
    return { status: "failed", stage: "live", receipt };
  }

  return { status: receipt.deployed && receipt.liveVerified ? "published" : "ready", receipt };
}

// ---------------------------------------------------------------------------
// Filesystem handoff helpers (researcher -> writer -> publisher).
// ---------------------------------------------------------------------------
async function listMarkdown(dir) {
  if (!existsSync(dir)) return [];
  return (await readdir(dir)).filter((f) => f.endsWith(".md") && !f.endsWith(".consumed.md"));
}

export async function pickDossier(dir = DOSSIERS_DIR) {
  const files = await listMarkdown(dir);
  const ready = [];
  for (const f of files) {
    const { meta } = parseFrontmatter(await readFile(path.join(dir, f), "utf8"));
    const consumed = existsSync(path.join(dir, `${f.replace(/\.md$/, "")}.consumed.json`));
    if (String(meta.state).toLowerCase() === "ready" && !consumed) {
      ready.push({ file: f, rank: Number(meta.rank) || 999, path: path.join(dir, f), meta });
    }
  }
  ready.sort((a, b) => a.rank - b.rank);
  return ready[0] || null;
}

export async function markDossierConsumed(dossierPath, { draftPath, note = "" } = {}) {
  const marker = `${dossierPath.replace(/\.md$/, "")}.consumed.json`;
  const payload = { consumed_at: new Date().toISOString(), dossier: dossierPath, draft: draftPath, note };
  await writeFile(marker, JSON.stringify(payload, null, 2));
  return marker;
}

export async function pickDraft(dir = DRAFTS_DIR, { receiptsDir = RECEIPTS_DIR } = {}) {
  const files = await listMarkdown(dir);
  const promoted = new Set();
  const pubDir = path.join(receiptsDir, "publisher");
  if (existsSync(pubDir)) {
    for (const r of await readdir(pubDir)) {
      if (!r.endsWith(".json")) continue;
      try {
        const rec = JSON.parse(await readFile(path.join(pubDir, r), "utf8"));
        if (rec.slug) promoted.add(rec.slug);
      } catch {}
    }
  }
  const candidates = [];
  for (const f of files) {
    if (/^proposals?-|^proposer-/.test(f)) continue; // legacy proposal artifacts, not manuscripts
    const { meta, body } = parseFrontmatter(await readFile(path.join(dir, f), "utf8"));
    const slug = slugFromMeta(meta) || slugify(f.replace(/\.md$/, ""));
    const complete = String(meta.state).toLowerCase() === "complete" || checkStructure(body).ok;
    if (complete && !promoted.has(slug)) candidates.push({ file: f, path: path.join(dir, f), meta, slug });
  }
  return candidates[0] || null;
}

// Canonical newsletter slug/title corpus for the duplicate gate.
export async function canonicalCorpus(dir = NEWSLETTER_DIR) {
  const slugs = [];
  const titles = [];
  if (!existsSync(dir)) return { canonicalSlugs: slugs, canonicalTitles: titles };
  for (const f of await readdir(dir)) {
    if (!/^issue-\d+-.+\.md$/i.test(f)) continue;
    slugs.push(f.replace(/\.md$/, ""));
    const { meta } = parseFrontmatter(await readFile(path.join(dir, f), "utf8"));
    if (meta.title) titles.push(meta.title);
  }
  return { canonicalSlugs: slugs, canonicalTitles: titles };
}

// ---------------------------------------------------------------------------
// Check B — deterministic render preflight using the REAL build machinery,
// into a throwaway temp dir. Touches nothing under html/. Confirms the issue
// renders with the hero and a large-image card (no icon-512 fallback), a
// canonical link, no stale "Issue #N" leak, and presence in the newsletter index.
// ---------------------------------------------------------------------------
export async function renderPreflight(canonicalIssuePath, { buildScript, tmpBase } = {}) {
  const build = buildScript || path.join(SHAKEDOWN_V2, "scripts", "build-newsletter-pages.mjs");
  const { meta, body } = parseFrontmatter(await readFile(canonicalIssuePath, "utf8"));
  const slug = slugFromMeta(meta) || path.basename(canonicalIssuePath, ".md");

  const tmp = await mkdtempAbs(tmpBase);
  const sourceDir = path.join(tmp, "src");
  const outDir = path.join(tmp, "out");
  await mkdir(sourceDir, { recursive: true });
  await mkdir(outDir, { recursive: true });
  // Bring the whole canonical corpus so the index/sitemap render honestly, then
  // ensure our candidate is present (it may not be canonical yet).
  if (existsSync(NEWSLETTER_DIR)) {
    for (const f of await readdir(NEWSLETTER_DIR)) {
      if (/^issue-\d+-.+\.md$/i.test(f)) await cp(path.join(NEWSLETTER_DIR, f), path.join(sourceDir, f));
    }
  }
  const candidateName = /^issue-\d+-.+$/.test(slug) ? `${slug}.md` : `issue-${meta.issue || "00"}-${slug}.md`;
  await writeFile(path.join(sourceDir, candidateName), await readFile(canonicalIssuePath, "utf8"));
  // updateSitemap() reads then rewrites an existing sitemap; seed a minimal one
  // so the render is self-contained and never reads/writes production.
  await writeFile(
    path.join(outDir, "sitemap.xml"),
    '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n</urlset>\n'
  );

  const problems = [];
  try {
    const { buildNewsletterPages } = await import(pathToFileURL(build).href);
    await buildNewsletterPages({
      sourceDir,
      publicDir: outDir,
      sitemapPath: path.join(outDir, "sitemap.xml"),
      now: meta.scheduled_at ? new Date(meta.scheduled_at) : new Date("2000-01-01T00:00:00Z"),
    });
  } catch (err) {
    problems.push(`build threw: ${err.message}`);
    await safeRm(tmp);
    return { ok: false, problems, slug };
  }

  const pageDir = path.join(outDir, "newsletter", slug);
  const pagePath = path.join(pageDir, "index.html");
  if (!existsSync(pagePath)) {
    problems.push(`rendered page missing: ${pagePath}`);
  } else {
    const html = await readFile(pagePath, "utf8");
    if (/twitter:card"\s+content="summary"/.test(html) && !/summary_large_image/.test(html)) {
      problems.push("twitter card degraded to summary (hero missing at render time)");
    }
    if (!/summary_large_image/.test(html)) problems.push("no summary_large_image card");
    if (!/rel="canonical"/.test(html)) problems.push("no canonical link");
    if (/Issue\s+#\d+/.test(html)) problems.push("stale 'Issue #N' leaked into rendered page");
  }
  const indexPath = path.join(outDir, "newsletter", "index.html");
  if (existsSync(indexPath)) {
    const idx = await readFile(indexPath, "utf8");
    if (!idx.includes(`/newsletter/${slug}/`)) problems.push("issue absent from newsletter index");
  }

  await safeRm(tmp);
  return { ok: problems.length === 0, problems, slug, tmp };
}

async function mkdtempAbs(tmpBase) {
  const base = tmpBase || path.join(os.tmpdir(), "shakedown-editorial-");
  const { mkdtemp } = await import("node:fs/promises");
  return mkdtemp(base);
}
async function safeRm(dir) {
  try {
    await rm(dir, { recursive: true, force: true });
  } catch {}
}

// ---------------------------------------------------------------------------
// promote — write the canonical issue file + a publisher receipt. NO deploy.
// ---------------------------------------------------------------------------
export async function promoteDraft(draftPath, { newsletterDir = NEWSLETTER_DIR, receiptsDir = RECEIPTS_DIR, imageRoots = IMAGE_ROOTS } = {}) {
  const markdown = await readFile(draftPath, "utf8");
  const { meta } = parseFrontmatter(markdown);
  const corpus = await canonicalCorpus(newsletterDir);
  const candidateSlug = slugFromMeta(meta);
  const selfPath = candidateSlug ? path.join(newsletterDir, `${candidateSlug}.md`) : null;
  const replacingSelf = selfPath && existsSync(selfPath);
  const gate = promoteReadiness(markdown, {
    ...corpus,
    imageRoots,
    selfSlug: replacingSelf ? candidateSlug : null,
    selfTitle: replacingSelf ? meta.title : null,
  });
  if (!gate.ok) {
    return { ok: false, failures: gate.failures, checks: gate.checks };
  }
  const slug = slugFromMeta(gate.meta);
  const issueName = /^issue-\d+-/.test(slug) ? `${slug}.md` : `issue-${gate.meta.issue}-${slug}.md`;
  const dest = path.join(newsletterDir, issueName);
  await writeFile(dest, markdown);
  const receipt = await writePublisherReceipt({ slug: issueName.replace(/\.md$/, ""), draftPath, dest, gate, receiptsDir });
  return { ok: true, dest, slug: issueName.replace(/\.md$/, ""), receipt, checks: gate.checks };
}

export async function writePublisherReceipt({ slug, draftPath, dest, gate, render, deploy, receiptsDir = RECEIPTS_DIR }) {
  const dir = path.join(receiptsDir, "publisher");
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(dir, `${stamp}-${slug}.json`);
  const payload = {
    slug,
    at: new Date().toISOString(),
    draft: draftPath,
    canonical: dest,
    checkA_editorial: gate ? { ok: gate.ok, failures: gate.failures } : null,
    checkB_render: render || null,
    deploy: deploy || null,
  };
  await writeFile(file, JSON.stringify(payload, null, 2));
  return file;
}

// ---------------------------------------------------------------------------
// Guarded deploy wrapper — first builds a fresh owned-content candidate, then
// routes its cutover through the publishing pipeline's shared deploy-site guard
// (snapshot + preflight + overlay + live readback). Dry-run by default.
// ---------------------------------------------------------------------------
export async function guardedDeploy({ apply = false, pipelineScript, cwd = SHAKEDOWN_V2 } = {}) {
  const script = pipelineScript || path.join(SHAKEDOWN_V2, "scripts", "shakedown-publish-pipeline.mjs");
  const args = [script, "--mode", "build-owned", "--json"];
  if (apply) args.push("--deploy-owned");
  const { stdout, stderr } = await execFileAsync("node", args, { cwd, maxBuffer: 32 * 1024 * 1024 });
  return { ok: true, apply, stdout, stderr };
}

export async function verifyCanonicalLive(meta) {
  const url = String(meta?.canonical_target || "");
  const title = String(meta?.title || "");
  if (!url || !title) return { ok: false, detail: "canonical_target or title missing" };
  const { stdout } = await execFileAsync("curl", ["-fsSL", "--max-time", "30", url], {
    maxBuffer: 16 * 1024 * 1024,
  });
  const ok = stdout.includes(title) && /rel="canonical"/.test(stdout) && /summary_large_image/.test(stdout);
  return {
    ok,
    url,
    detail: ok ? "canonical page, title, and large-image card verified live" : "canonical live readback did not match the issue",
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
async function cli(argv) {
  const [cmd, ...rest] = argv;
  const apply = rest.includes("--apply");
  const target = rest.find((a) => !a.startsWith("--"));

  if (cmd === "validate") {
    const md = await readFile(path.resolve(target), "utf8");
    const corpus = await canonicalCorpus();
    const res = validateDraft(md, corpus);
    console.log(JSON.stringify(res, null, 2));
    process.exit(res.ok ? 0 : 1);
  }

  if (cmd === "preflight") {
    const res = await renderPreflight(path.resolve(target));
    console.log(JSON.stringify(res, null, 2));
    process.exit(res.ok ? 0 : 1);
  }

  if (cmd === "promote") {
    const res = await promoteDraft(path.resolve(target));
    console.log(JSON.stringify(res, null, 2));
    process.exit(res.ok ? 0 : 1);
  }

  if (cmd === "publish") {
    const draftPath = path.resolve(target);
    const corpus = await canonicalCorpus();
    const result = await runPublish({
      checkEditorial: async () => {
        const md = await readFile(draftPath, "utf8");
        const { meta } = parseFrontmatter(md);
        const candidateSlug = slugFromMeta(meta);
        const selfPath = candidateSlug ? path.join(NEWSLETTER_DIR, `${candidateSlug}.md`) : null;
        const replacingSelf = selfPath && existsSync(selfPath);
        return promoteReadiness(md, {
          ...corpus,
          selfSlug: replacingSelf ? candidateSlug : null,
          selfTitle: replacingSelf ? meta.title : null,
        });
      },
      checkRender: async () => {
        // Render preflight runs against the draft AS IF canonical.
        const r = await renderPreflight(draftPath);
        return { ok: r.ok, problems: r.problems };
      },
      promote: async () => {
        // Dry run never mutates the canonical dir; it reports what would happen.
        if (!apply) return { ok: true, dryRun: true, note: "dry run — pass --apply to promote + deploy" };
        return promoteDraft(draftPath);
      },
      deploy: async () => {
        if (!apply) return { ok: true, skipped: true, note: "dry run — pass --apply for guarded cutover" };
        return guardedDeploy({ apply: true });
      },
      verifyLive: async () => {
        if (!apply) return { ok: true, skipped: true };
        const md = await readFile(draftPath, "utf8");
        return verifyCanonicalLive(parseFrontmatter(md).meta);
      },
      log: (m) => console.error(m),
    });
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.status === "published" || result.receipt?.deploy?.skipped ? 0 : 1);
  }

  if (cmd === "pick-dossier") {
    const d = await pickDossier();
    console.log(d ? d.path : "");
    process.exit(d ? 0 : 1);
  }

  if (cmd === "pick-draft") {
    const d = await pickDraft();
    console.log(d ? d.path : "");
    process.exit(d ? 0 : 1);
  }

  console.error(
    "usage: shakedown-editorial.mjs <validate|preflight|promote|publish [--apply]|pick-dossier|pick-draft> [file]"
  );
  process.exit(2);
}

const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  cli(process.argv.slice(2)).catch((err) => {
    console.error(err?.stack || String(err));
    process.exit(1);
  });
}
