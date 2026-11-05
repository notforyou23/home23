// Focused deterministic tests for scripts/shakedown-editorial.mjs — the
// three-role editorial pipeline spine. These cover the gates that agent claims
// alone cannot be trusted for, plus the "deploy only after both checks" ordering.
//
// Run directly: node --test tests/scripts/shakedown-editorial.test.mjs
// Everything runs in temp dirs; nothing here touches production.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  validateDraft,
  promoteReadiness,
  checkForbiddenPrivatePath,
  checkStructure,
  checkProhibitedLanguage,
  checkFirstPerson,
  checkSources,
  checkDuplicate,
  checkHero,
  runPublish,
  slugify,
  parseFrontmatter,
  promoteDraft,
} from "../../scripts/shakedown-editorial.mjs";

// A structurally complete, sourced, third-person manuscript that PASSES.
const GOOD_FRONTMATTER = `---
title: "The Test Issue About Nothing In Particular"
issue: 99
date: 2026-08-08
canonical_target: https://www.shakedownshuffle.com/newsletter/issue-99-the-test-issue/
scheduled_at: "2026-08-15T09:00:00-04:00"
social_image: /images/publishing-v3/issue-99-the-test-issue-hero.png
social_image_alt: "A test hero image description."
primary_cta: https://www.shakedownshuffle.com/start/
---`;

const GOOD_BODY = `
## SET I — Cold Open

Garcia built systems. The band was one output among several, and the record shows it plainly.

## SET I — Act One

He worked the tape machines the way an engineer works a bench.

## SET II — The Sound

The rig changed three times and each change taught the next one.

## DRUMS/SPACE — The Philosophy

Everything served the signal chain.

## ENCORE — What Was Built

A partial inventory of the work that outlived the shows.

Forward this to a friend, and subscribe at https://www.shakedownshuffle.com/start/.

## Sources / Further Reading

- **Owsley Stanley Foundation** — preservation updates
- **Robert Greenfield, Bear** — biography
- **Meyer Sound company history** — the lineage
`;

const GOOD_DRAFT = `${GOOD_FRONTMATTER}\n${GOOD_BODY}`;

test("clean third-person sourced draft passes validateDraft", () => {
  const res = validateDraft(GOOD_DRAFT, { canonicalSlugs: [], canonicalTitles: [] });
  assert.equal(res.ok, true, JSON.stringify(res.failures));
});

test("forbidden private-corpus path is rejected", () => {
  const bad = GOOD_DRAFT.replace(
    "## Sources / Further Reading",
    "Sourced from cosmo-content/_private/_jtrVoice.md\n\n## Sources / Further Reading"
  );
  assert.equal(checkForbiddenPrivatePath(bad).ok, false);
  const res = validateDraft(bad, {});
  assert.equal(res.ok, false);
  assert.match(res.failures.join("\n"), /private/i);
});

test("a NEGATIVE attestation about the private corpus is allowed", () => {
  const attested = "<!-- Provenance: ... No material from cosmo-content/_private/. -->";
  assert.equal(checkForbiddenPrivatePath(attested).ok, true);
  assert.equal(checkForbiddenPrivatePath("Excludes cosmo-content/_private entirely.").ok, true);
  // But an actual citation alongside an attestation still fails.
  const mixed = "No material from cosmo-content/_private. Quote from cosmo-content/_private/_jtrVoice.md here.";
  assert.equal(checkForbiddenPrivatePath(mixed).ok, false);
});

test("missing sources section fails", () => {
  const body = GOOD_BODY.replace(/## Sources \/ Further Reading[\s\S]*$/, "");
  assert.equal(checkSources(body, {}).ok, false);
});

test("too few sources fails the minimum", () => {
  const body = GOOD_BODY.replace(
    /## Sources \/ Further Reading[\s\S]*$/,
    "## Sources / Further Reading\n\n- **One source** only\n"
  );
  assert.equal(checkSources(body, {}).ok, false);
  assert.equal(checkSources(body, {}).count, 1);
});

test("missing set structure / footer fails", () => {
  const noEncore = GOOD_BODY.replace("## ENCORE — What Was Built", "## Something Else");
  assert.equal(checkStructure(noEncore).ok, false);
  assert.match(checkStructure(noEncore).missing.join(","), /ENCORE/);

  const noFooter = GOOD_BODY.replace(
    "Forward this to a friend, and subscribe at https://www.shakedownshuffle.com/start/.",
    ""
  );
  assert.equal(checkStructure(noFooter).ok, false);
  assert.match(checkStructure(noFooter).missing.join(","), /footer/);
});

test("prohibited language is caught (words + this-isnt-x-its-y)", () => {
  assert.equal(checkProhibitedLanguage("We must leverage the landscape.").ok, false);
  assert.equal(checkProhibitedLanguage("This furthermore matters.").ok, false);
  assert.equal(checkProhibitedLanguage("This isn't a band, it's a laboratory.").ok, false);
  assert.equal(checkProhibitedLanguage("This is not a band, it's a lab.").ok, false);
  assert.equal(checkProhibitedLanguage("The rig changed three times.").ok, true);
});

test("first-person gate: unattested narration fails, attestation or quotes pass", () => {
  assert.equal(checkFirstPerson("I remember the first time I heard it.", {}).ok, false);
  // Attested via frontmatter.
  assert.equal(checkFirstPerson("I remember the first time.", { first_person_ok: "true" }).ok, true);
  // First-person INSIDE a sourced quote does not trip the narrator gate.
  assert.equal(checkFirstPerson('> "I built it," Bear said.', {}).ok, true);
  assert.equal(checkFirstPerson('Bear said "I built it."', {}).ok, true);
  // Editorial "you"/"we" is fine.
  assert.equal(checkFirstPerson("You will fail. We know why.", {}).ok, true);
});

test("duplicate slug and duplicate title are both gated", () => {
  const meta = parseFrontmatter(GOOD_DRAFT).meta;
  const selfSlug = "issue-99-the-test-issue";
  assert.equal(checkDuplicate(meta, { canonicalSlugs: [], canonicalTitles: [] }).ok, true);
  assert.equal(
    checkDuplicate(meta, { canonicalSlugs: [selfSlug], canonicalTitles: [] }).ok,
    false
  );
  assert.equal(
    checkDuplicate(meta, { canonicalSlugs: [], canonicalTitles: ["The Test Issue About Nothing In Particular"] }).ok,
    false
  );
  // selfSlug + selfTitle are excluded so re-promoting the same issue is not "duplicate".
  assert.equal(
    checkDuplicate(meta, {
      canonicalSlugs: [selfSlug],
      canonicalTitles: [meta.title],
      selfSlug,
      selfTitle: meta.title,
    }).ok,
    true
  );
});

test("mandatory hero: missing social_image, missing alt, and missing file all fail; present file passes", async () => {
  const meta = parseFrontmatter(GOOD_DRAFT).meta;
  // No image roots have the file yet.
  const tmp = await mkdtemp(path.join(os.tmpdir(), "shakedown-hero-"));
  try {
    assert.equal(checkHero(meta, { imageRoots: [tmp] }).ok, false); // file absent
    assert.equal(checkHero({ ...meta, social_image: "" }, { imageRoots: [tmp] }).ok, false);
    assert.equal(checkHero({ ...meta, social_image_alt: "" }, { imageRoots: [tmp] }).ok, false);
    // Now create the file and it passes.
    const rel = meta.social_image.replace(/^\/+/, "");
    await mkdir(path.join(tmp, path.dirname(rel)), { recursive: true });
    await writeFile(path.join(tmp, rel), "png-bytes");
    assert.equal(checkHero(meta, { imageRoots: [tmp] }).ok, true);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("runPublish: deploy is NOT called when Check A (editorial) fails", async () => {
  let deployCalled = false;
  const res = await runPublish({
    checkEditorial: async () => ({ ok: false, failures: ["structure: bad"] }),
    checkRender: async () => ({ ok: true }),
    promote: async () => ({ ok: true }),
    deploy: async () => {
      deployCalled = true;
      return { ok: true };
    },
    verifyLive: async () => ({ ok: true }),
  });
  assert.equal(deployCalled, false);
  assert.equal(res.status, "blocked");
  assert.equal(res.stage, "editorial");
  assert.equal(res.receipt.deployCalled, false);
});

test("runPublish: deploy is NOT called when Check B (render) fails", async () => {
  let deployCalled = false;
  const res = await runPublish({
    checkEditorial: async () => ({ ok: true }),
    checkRender: async () => ({ ok: false, problems: ["no hero card"] }),
    promote: async () => ({ ok: true }),
    deploy: async () => {
      deployCalled = true;
      return { ok: true };
    },
    verifyLive: async () => ({ ok: true }),
  });
  assert.equal(deployCalled, false);
  assert.equal(res.status, "blocked");
  assert.equal(res.stage, "render");
});

test("runPublish: deploy runs only after BOTH checks pass and promotion succeeds", async () => {
  const order = [];
  const res = await runPublish({
    checkEditorial: async () => {
      order.push("A");
      return { ok: true };
    },
    checkRender: async () => {
      order.push("B");
      return { ok: true };
    },
    promote: async () => {
      order.push("promote");
      return { ok: true };
    },
    deploy: async () => {
      order.push("deploy");
      return { ok: true };
    },
    verifyLive: async () => {
      order.push("live");
      return { ok: true };
    },
  });
  assert.deepEqual(order, ["A", "B", "promote", "deploy", "live"]);
  assert.equal(res.status, "published");
  assert.equal(res.receipt.liveVerified, true);
});

test("runPublish: skipped dry-run deploy reports ready, never published", async () => {
  const res = await runPublish({
    checkEditorial: async () => ({ ok: true }),
    checkRender: async () => ({ ok: true }),
    promote: async () => ({ ok: true, dryRun: true }),
    deploy: async () => ({ ok: true, skipped: true }),
    verifyLive: async () => ({ ok: true, skipped: true }),
  });
  assert.equal(res.status, "ready");
  assert.equal(res.receipt.promoted, false);
  assert.equal(res.receipt.deployed, false);
  assert.equal(res.receipt.liveVerified, false);
});

test("runPublish: a failed guarded deploy fails closed (does not report published)", async () => {
  const res = await runPublish({
    checkEditorial: async () => ({ ok: true }),
    checkRender: async () => ({ ok: true }),
    promote: async () => ({ ok: true }),
    deploy: async () => ({ ok: false, error: "preflight blocked cutover" }),
    verifyLive: async () => ({ ok: true }),
  });
  assert.equal(res.status, "failed");
  assert.equal(res.stage, "deploy");
});

test("promoteReadiness blocks a draft with no hero even if editorial passes", () => {
  // GOOD_DRAFT has social_image but the file does not exist under a bogus root.
  const res = promoteReadiness(GOOD_DRAFT, { canonicalSlugs: [], canonicalTitles: [], imageRoots: ["/nonexistent-root"] });
  assert.equal(res.ok, false);
  assert.match(res.failures.join("\n"), /hero/i);
});

test("promoteDraft writes canonical issue + publisher receipt only when the full gate passes", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "shakedown-promote-"));
  try {
    const newsletterDir = path.join(tmp, "newsletter");
    const receiptsDir = path.join(tmp, "receipts");
    const imageRoot = path.join(tmp, "images-root");
    await mkdir(newsletterDir, { recursive: true });
    // Create the hero so the hero gate passes.
    const rel = parseFrontmatter(GOOD_DRAFT).meta.social_image.replace(/^\/+/, "");
    await mkdir(path.join(imageRoot, path.dirname(rel)), { recursive: true });
    await writeFile(path.join(imageRoot, rel), "png");

    const draftPath = path.join(tmp, "issue-99-the-test-issue.md");
    await writeFile(draftPath, GOOD_DRAFT);

    const res = await promoteDraft(draftPath, { newsletterDir, receiptsDir, imageRoots: [imageRoot] });
    assert.equal(res.ok, true, JSON.stringify(res.failures));
    assert.equal(res.slug, "issue-99-the-test-issue");
    // Canonical file exists.
    const { readFile } = await import("node:fs/promises");
    const canon = await readFile(path.join(newsletterDir, "issue-99-the-test-issue.md"), "utf8");
    assert.match(canon, /The Test Issue About Nothing In Particular/);
    // Receipt exists.
    const { readdir } = await import("node:fs/promises");
    const receipts = await readdir(path.join(receiptsDir, "publisher"));
    assert.equal(receipts.length, 1);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("promoteDraft can replace its own canonical issue without treating itself as a duplicate", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "shakedown-repromote-"));
  try {
    const newsletterDir = path.join(tmp, "newsletter");
    const receiptsDir = path.join(tmp, "receipts");
    const imageRoot = path.join(tmp, "images-root");
    await mkdir(newsletterDir, { recursive: true });
    const rel = parseFrontmatter(GOOD_DRAFT).meta.social_image.replace(/^\/+/, "");
    await mkdir(path.join(imageRoot, path.dirname(rel)), { recursive: true });
    await writeFile(path.join(imageRoot, rel), "png");
    await writeFile(path.join(newsletterDir, "issue-99-the-test-issue.md"), GOOD_DRAFT);

    const draftPath = path.join(tmp, "draft.md");
    const revised = GOOD_DRAFT.replace("Garcia built systems.", "Garcia built durable systems.");
    await writeFile(draftPath, revised);

    const res = await promoteDraft(draftPath, { newsletterDir, receiptsDir, imageRoots: [imageRoot] });
    assert.equal(res.ok, true, JSON.stringify(res.failures));
    const { readFile } = await import("node:fs/promises");
    const canon = await readFile(path.join(newsletterDir, "issue-99-the-test-issue.md"), "utf8");
    assert.match(canon, /durable systems/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("promoteDraft refuses (no write) when hero is missing", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "shakedown-promote-fail-"));
  try {
    const newsletterDir = path.join(tmp, "newsletter");
    await mkdir(newsletterDir, { recursive: true });
    const draftPath = path.join(tmp, "issue-99-the-test-issue.md");
    await writeFile(draftPath, GOOD_DRAFT);
    const res = await promoteDraft(draftPath, {
      newsletterDir,
      receiptsDir: path.join(tmp, "receipts"),
      imageRoots: ["/nonexistent"],
    });
    assert.equal(res.ok, false);
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(newsletterDir);
    assert.equal(files.length, 0, "no canonical file written on a failed gate");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("slugify is stable and strips apostrophes", () => {
  assert.equal(slugify("Garcia's Other Bands"), "garcias-other-bands");
});
