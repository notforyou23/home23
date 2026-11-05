#!/usr/bin/env node
/**
 * shakedown-supply-scan.mjs — editorial SUPPLY visibility + byte-exact stager.
 *
 * Why this exists (2026-07-26): the daily Substack cadence was republishing the
 * archive because nothing tracked distribution state and nothing surfaced
 * finished-but-unshipped drafts. 12 duplicate posts were scheduled while a
 * finished Bear->Sphere rewrite sat unshipped in the lineage tree.
 *
 * DOCTRINE (projects/shakedownshuffle/RUNBOOK.md):
 *   - Ship from newsletter/_archive/*-rewrite.md. Never rewrite prose here.
 *     Body is lifted BYTE-EXACT. This tool does not author or paraphrase.
 *   - cosmo-content/_private/ is NEVER read. Hard-excluded below.
 *   - Staging is not shipping: no hero, no build, no Substack, no send.
 *     status=needs-review + hero_status=pending gate the rest.
 *
 * Modes:
 *   (default)          supply report -> stdout JSON (+ --text for human)
 *   --stage <path>     stage one candidate into content/newsletter/
 *   --json             machine output
 *
 * Human delivery rule: the daily cron never prints internal paths as work for jtr.
 * It points at the Desk, which holds the readable drafts and review loop.
 */

import { readdir, readFile, writeFile, stat } from "node:fs/promises";
import path from "node:path";

const WORKSPACE = "/Users/jtr/_JTR23_/release/home23/instances/jerry/workspace";
const CORPUS = path.join(WORKSPACE, "jtr/jerry-garcia-deep-dive");
const CONTENT = path.join(WORKSPACE, "projects/shakedownshuffle/content/newsletter");

// Hard privacy guard — never read, never stage, never report.
const FORBIDDEN = [/_private/, /_jtrVoice/i];
const isForbidden = (p) => FORBIDDEN.some((re) => re.test(p));

const CANDIDATE_SOURCES = [
  { dir: path.join(CORPUS, "newsletter/_archive"), match: /-rewrite\.md$/, tier: "lineage-rewrite" },
  { dir: path.join(CORPUS, "newsletter/03_final"), match: /\.md$/, tier: "lineage-final" },
  { dir: path.join(CORPUS, "issues"), match: /\.md$/, tier: "topic-draft" },
];

const norm = (s) =>
  String(s || "")
    .normalize("NFKD")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

function parseFrontmatter(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: md, hadFrontmatter: false };
  const meta = {};
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i === -1) continue;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if (/^".*"$/.test(v) || /^'.*'$/.test(v)) v = v.slice(1, -1);
    if (k) meta[k] = v;
  }
  return { meta, body: m[2], hadFrontmatter: true };
}

/** Title of a raw lineage draft: frontmatter title, else first H1 minus "Newsletter Issue #N —". */
function candidateTitle(md, filename) {
  const { meta, body } = parseFrontmatter(md);
  if (meta.title) return meta.title;
  const h1 = body.split("\n").find((l) => /^#\s+/.test(l));
  if (h1) {
    return h1
      .replace(/^#\s+/, "")
      .replace(/^Newsletter\s+Issue\s*#?\s*\d+\s*[—–-]\s*/i, "")
      .trim();
  }
  return path.basename(filename, ".md").replace(/[-_]+/g, " ");
}

/** Strip the leading "# Newsletter Issue #N — ..." H1 (RUNBOOK Stage 2). Body otherwise byte-exact. */
function stripLeadingH1(body) {
  const lines = body.split("\n");
  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i++;
  if (i < lines.length && /^#\s+/.test(lines[i]) && !/^##/.test(lines[i])) {
    lines.splice(i, 1);
    while (i < lines.length && lines[i].trim() === "") lines.splice(i, 1);
    return lines.join("\n");
  }
  return body;
}

const slugify = (t) =>
  norm(t).replace(/\s+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);

const MIN_VIABLE_WORDS = 250;

/**
 * First-person EXPERIENTIAL claims — assertions that jtr personally did/attended
 * something. These are unverifiable by this tool and have shipped false before
 * (issue-21 claimed attending a Dead & Company Sphere show; jtr: "that's bullshit").
 * Reflective voice ("I keep thinking", "Let me break down") is fine and NOT flagged.
 * Staging never blocks on these — it surfaces them for jtr to confirm or cut.
 */
const EXPERIENTIAL_PATTERNS = [
  /\bI (walked|went|drove|flew|showed up|arrived)\b[^.!?]*/gi,
  /\bI (saw|watched|attended|caught|witnessed)\b[^.!?]*/gi,
  /\bI (was|were) (there|at|in)\b[^.!?]*/gi,
  /\bI (met|spoke with|talked to|interviewed|asked)\b[^.!?]*/gi,
  /\bI (own|owned|bought|have a copy|held|touched)\b[^.!?]*/gi,
  /\bwhen I (was|saw|went|got)\b[^.!?]*/gi,
  /\bmy (first|last|own) (show|time|copy|guitar|visit)\b[^.!?]*/gi,
];

function findExperientialClaims(body) {
  const hits = [];
  const lines = body.split("\n");
  lines.forEach((line, i) => {
    for (const re of EXPERIENTIAL_PATTERNS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line))) {
        hits.push({ line: i + 1, claim: m[0].trim().slice(0, 160) });
      }
    }
  });
  // de-dupe identical claims on the same line
  const seen = new Set();
  return hits.filter((h) => {
    const k = `${h.line}::${h.claim}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
const STOP = new Set(["issue", "the", "a", "an", "of", "and", "or", "to", "in", "jerry", "garcia", "newsletter"]);

/** Filename topic stem: drop issue-NN- / issue- prefixes and -rewrite suffix. */
function topicStem(filename) {
  return path
    .basename(filename, ".md")
    .replace(/-rewrite$/i, "")
    .replace(/^Newsletter_Issue_\d+_/i, "")
    .replace(/^issue[-_]\d+[-_]/i, "")
    .replace(/^issue[-_]/i, "")
    .toLowerCase();
}

const stemTokens = (stem) =>
  new Set(stem.split(/[-_\s]+/).filter((t) => t && t.length > 2 && !STOP.has(t)));

/** Cluster near-duplicate drafts of one topic: exact stem, or >=2 shared distinctive tokens. */
function clusterTopics(items) {
  const groups = [];
  for (const it of items) {
    const toks = stemTokens(it.topicStem);
    let placed = false;
    for (const g of groups) {
      const shared = [...toks].filter((t) => g.tokens.has(t));
      if (g.stem === it.topicStem || shared.length >= 2) {
        g.members.push(it);
        for (const t of toks) g.tokens.add(t);
        placed = true;
        break;
      }
    }
    if (!placed) groups.push({ stem: it.topicStem, tokens: new Set(toks), members: [it] });
  }
  return groups.map((g) => {
    const sorted = [...g.members].sort((a, b) => b.words - a.words);
    const [primary, ...variants] = sorted;
    return {
      topic: primary.title,
      primary,
      variantCount: variants.length,
      variants: variants.map((v) => ({ file: v.file, words: v.words, path: v.path })),
    };
  });
}

async function listShipped() {
  let files = [];
  try {
    files = (await readdir(CONTENT)).filter((f) => /^issue-.*\.md$/.test(f));
  } catch { return { issues: [], claimedSources: new Set(), shippedTitles: new Set() }; }
  const issues = [];
  const claimedSources = new Set();
  const shippedTitles = new Set();
  for (const f of files) {
    const md = await readFile(path.join(CONTENT, f), "utf8");
    const { meta } = parseFrontmatter(md);
    const issueNum = Number.parseInt(meta.issue, 10);
    issues.push({
      file: f,
      title: meta.title || "",
      issue: Number.isFinite(issueNum) ? issueNum : null,
      scheduled_at: meta.scheduled_at || "",
      distribution_state: meta.distribution_state || "unknown",
      substack_publish_count: Number.parseInt(meta.substack_publish_count ?? "0", 10) || 0,
      substack_emailed: meta.substack_emailed === "true",
      source_path: meta.source_path || "",
      hero_status: meta.hero_status || (meta.social_image ? "present" : "missing"),
    });
    if (meta.source_path) claimedSources.add(path.basename(meta.source_path));
    if (meta.title) shippedTitles.add(norm(meta.title));
  }
  return { issues, claimedSources, shippedTitles };
}

async function gatherCandidates() {
  const out = [];
  for (const src of CANDIDATE_SOURCES) {
    let entries = [];
    try { entries = await readdir(src.dir); } catch { continue; }
    for (const name of entries) {
      const full = path.join(src.dir, name);
      if (isForbidden(full)) continue;
      if (!src.match.test(name)) continue;
      let st;
      try { st = await stat(full); } catch { continue; }
      if (!st.isFile()) continue;
      const md = await readFile(full, "utf8");
      const { body } = parseFrontmatter(md);
      const title = candidateTitle(md, name);
      const words = body.trim().split(/\s+/).filter(Boolean).length;
      const sections = (body.match(/^##\s+/gm) || []).length;
      // A finished draft has real prose and section structure. Empty/stub files
      // are not supply — 03_final/Garcia_Model was a 0-byte file.
      const viable = words >= MIN_VIABLE_WORDS && sections >= 2;
      const experientialClaims = findExperientialClaims(body);
      out.push({
        path: full, file: name, tier: src.tier, title, normTitle: norm(title),
        words, sections, viable, experientialClaims,
        topicStem: topicStem(name),
        mtime: st.mtime.toISOString(),
      });
    }
  }
  return out;
}

function nextSlot(issues) {
  const nums = issues.map((i) => i.issue).filter((n) => Number.isFinite(n));
  const nextIssue = nums.length ? Math.max(...nums) + 1 : 1;
  const dates = issues
    .map((i) => String(i.scheduled_at || "").slice(0, 10))
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();
  let nextDate;
  if (dates.length) {
    const d = new Date(`${dates[dates.length - 1]}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    nextDate = d.toISOString().slice(0, 10);
  } else {
    const d = new Date(); d.setUTCDate(d.getUTCDate() + 1);
    nextDate = d.toISOString().slice(0, 10);
  }
  return { nextIssue, nextDate, scheduled_at: `${nextDate}T09:00:00-04:00` };
}

async function scan() {
  const { issues, claimedSources, shippedTitles } = await listShipped();
  const candidates = await gatherCandidates();

  const unshipped = [];
  const alreadyShipped = [];
  for (const c of candidates) {
    const byPath = claimedSources.has(c.file);
    const byTitle = shippedTitles.has(c.normTitle);
    (byPath || byTitle ? alreadyShipped : unshipped).push({
      ...c,
      dedupe: { claimedBySourcePath: byPath, titleMatchesShipped: byTitle },
    });
  }
  unshipped.sort((a, b) => (b.words - a.words) || a.file.localeCompare(b.file));

  const viable = unshipped.filter((u) => u.viable);
  const nonViable = unshipped.filter((u) => !u.viable);
  const topics = clusterTopics(viable).sort((a, b) => b.primary.words - a.primary.words);

  const staged = issues.filter((i) => i.distribution_state === "unpublished");
  const heroPending = issues.filter((i) => i.hero_status === "pending" || i.hero_status === "missing");

  return {
    generatedAt: new Date().toISOString(),
    corpusRoot: CORPUS,
    contentRoot: CONTENT,
    privacyGuard: "cosmo-content/_private and _jtrVoice never read",
    shippedCount: issues.length,
    candidateCount: candidates.length,
    supply: {
      distinctUnshippedTopics: topics.length,
      viableDraftFiles: viable.length,
      nonViableSkipped: nonViable.length,
      stagedAwaitingDistribution: staged.length,
      heroPending: heroPending.length,
    },
    unshippedTopics: topics,
    nonViableSkipped: nonViable.map((n) => ({ file: n.file, words: n.words, sections: n.sections, reason: n.words < MIN_VIABLE_WORDS ? "below-min-words" : "too-few-sections" })),
    stagedAwaitingDistribution: staged.map((i) => ({ file: i.file, title: i.title, issue: i.issue, scheduled_at: i.scheduled_at, hero_status: i.hero_status })),
    nextSlot: nextSlot(issues),
    alreadyShippedCount: alreadyShipped.length,
  };
}

// FORBIDDEN is a privacy deny-list, not a containment boundary: it only knows
// about _private and _jtrVoice. `--stage <path>` publishes a file's contents
// into the newsletter, so it needs an ALLOW-list — anything on disk that simply
// fails to match those two patterns must not become publishable copy.
const STAGEABLE_ROOTS = CANDIDATE_SOURCES.map((source) => path.resolve(source.dir));

function assertStageable(abs) {
  const inRoot = STAGEABLE_ROOTS.some(
    (root) => abs === root || abs.startsWith(root + path.sep),
  );
  if (!inRoot) {
    throw new Error(
      `Refusing to stage a path outside the candidate source roots: ${abs}\n`
      + `Allowed roots:\n  ${STAGEABLE_ROOTS.join("\n  ")}`,
    );
  }
}

async function stage(candidatePath) {
  const abs = path.resolve(candidatePath);
  if (isForbidden(abs)) throw new Error(`Refusing forbidden path (privacy guard): ${abs}`);
  assertStageable(abs);
  const md = await readFile(abs, "utf8");
  const { issues, claimedSources, shippedTitles } = await listShipped();

  const title = candidateTitle(md, path.basename(abs));
  const nt = norm(title);
  if (claimedSources.has(path.basename(abs))) throw new Error(`Already staged/shipped by source_path: ${path.basename(abs)}`);
  if (shippedTitles.has(nt)) throw new Error(`Title already shipped: "${title}"`);

  const { nextIssue, scheduled_at } = nextSlot(issues);
  const num = String(nextIssue).padStart(2, "0");
  const slug = `issue-${num}-${slugify(title)}`;
  const outPath = path.join(CONTENT, `${slug}.md`);
  try { await stat(outPath); throw new Error(`Refusing overwrite: ${outPath}`); } catch (e) {
    if (!/ENOENT/.test(String(e))) if (/Refusing overwrite/.test(String(e))) throw e;
  }

  const { body } = parseFrontmatter(md);
  const cleanBody = stripLeadingH1(body).replace(/^\n+/, "");
  const today = new Date().toISOString().slice(0, 10);

  const fm = [
    "---",
    `title: "${title.replace(/"/g, '\\"')}"`,
    `issue: ${nextIssue}`,
    `date: ${today}`,
    "status: needs-review",
    `source_path: ${abs}`,
    `canonical_target: https://www.shakedownshuffle.com/newsletter/${slug}/`,
    "distribution_note: Substack may distribute excerpts or pointers, but shakedownshuffle.com is the canonical source.",
    "primary_cta: https://www.shakedownshuffle.com/start/",
    `scheduled_at: "${scheduled_at}"`,
    'timezone: "America/New_York"',
    `social_image: /images/publishing-v3/${slug}-hero.png`,
    'social_image_alt: "TODO — hero pass required before ship (RUNBOOK Stage 3)."',
    "distribution_state: unpublished",
    "substack_publish_count: 0",
    "substack_emailed: false",
    "hero_status: pending",
    `staged_by: shakedown-supply-scan.mjs`,
    `staged_at: "${new Date().toISOString()}"`,
    "---",
    "",
  ].join("\n");

  const experientialClaims = findExperientialClaims(cleanBody);
  const doc = fm + cleanBody + (cleanBody.endsWith("\n") ? "" : "\n");
  await writeFile(outPath, doc, "utf8");

  // Verify with the build's own frontmatter contract.
  const check = doc.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const bodyWords = cleanBody.trim().split(/\s+/).filter(Boolean).length;
  const sourceWords = body.trim().split(/\s+/).filter(Boolean).length;
  // True byte-exactness: staged body must equal source body minus the leading H1.
  const expected = cleanBody.endsWith("\n") ? cleanBody : `${cleanBody}\n`;
  const byteExact = check ? check[2] === expected : false;

  return {
    staged: outPath,
    slug,
    issue: nextIssue,
    title,
    scheduled_at,
    frontmatterParses: Boolean(check),
    bodyWords,
    sourceWords,
    byteExactMinusH1: byteExact,
    droppedTokens: sourceWords - bodyWords,
    status: "needs-review",
    heroStatus: "pending",
    experientialClaimCount: experientialClaims.length,
    experientialClaims,
    reviewWarning: experientialClaims.length
      ? `${experientialClaims.length} first-person experiential claim(s) — jtr must confirm each is TRUE or cut it before ship.`
      : null,
    nextSteps: [
      "jtr reviews prose (never rewritten here; lifted byte-exact)",
      ...(experientialClaims.length ? ["CONFIRM OR CUT the flagged first-person claims above"] : []),
      "RUNBOOK Stage 3: generate 1200x630 hero, set social_image_alt, hero_status: present",
      "then: pipeline:scan -> distribute-substack -> browser adapter draft",
    ],
  };
}

const argv = process.argv.slice(2);
const wantJson = argv.includes("--json");
const stageIdx = argv.indexOf("--stage");
try {
  if (stageIdx !== -1) {
    const p = argv[stageIdx + 1];
    if (!p) throw new Error("--stage requires a candidate path");
    const r = await stage(p);
    console.log(JSON.stringify(r, null, 1));
  } else {
    const r = await scan();
    if (wantJson || !argv.includes("--text")) {
      console.log(JSON.stringify(r, null, 1));
    } else {
      console.log(`Shakedown supply — ${r.generatedAt}`);
      console.log(`${r.supply.stagedAwaitingDistribution} new draft(s) ready for your review on the Desk: http://127.0.0.1:7788`);
      console.log(`${r.supply.distinctUnshippedTopics} additional distinct topic(s) remain unshipped (${r.supply.viableDraftFiles} viable source files; ${r.supply.nonViableSkipped} skipped).`);
      console.log(`Next available issue slot: ${r.nextSlot.nextIssue} @ ${r.nextSlot.scheduled_at}`);
      console.log("Open the Desk to read, leave notes, review revisions, and approve publication. No filesystem paths required.");
    }
  }
} catch (e) {
  console.error(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }, null, 1));
  process.exit(1);
}
