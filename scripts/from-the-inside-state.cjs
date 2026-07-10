#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_STATE = process.env.FROM_THE_INSIDE_STATE
  || path.join(
    process.cwd(),
    'instances',
    'jerry',
    'projects',
    'from-the-inside',
    'curriculum',
    'autostudy',
    'STATE.json',
  );

function slugifyTopic(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 180);
}

function normalizeTopicRef(value, existing = null, now = null) {
  if (!value) return null;
  const input = typeof value === 'string' ? { topic: value } : value;
  const topic = String(input.topic || input.title || '').trim();
  if (!topic) return null;
  const slug = String(
    input.slug
      || input.canonical_slug
      || existing?.slug
      || existing?.canonical_slug
      || slugifyTopic(topic),
  ).trim();
  if (!slug) return null;

  const out = { topic, slug };
  const completedAt = input.completed_at || input.completedAt || existing?.completed_at || existing?.completedAt || null;
  const issue = input.issue ?? existing?.issue ?? null;
  if (completedAt) out.completed_at = completedAt;
  else if (now) out.completed_at = now;
  if (issue !== null && issue !== undefined && issue !== '') out.issue = Number.isFinite(Number(issue)) ? Number(issue) : issue;
  return out;
}

function normalizeCompletedTopicRefs(completedTopics = [], completedTopicRefs = [], opts = {}) {
  const now = opts.now || null;
  const existingBySlug = new Map();
  const existingByTopic = new Map();
  for (const ref of Array.isArray(completedTopicRefs) ? completedTopicRefs : []) {
    const normalized = normalizeTopicRef(ref, null, null);
    if (!normalized) continue;
    existingBySlug.set(normalized.slug, { ...ref, ...normalized });
    existingByTopic.set(normalized.topic.toLowerCase(), { ...ref, ...normalized });
  }

  const refs = [];
  const seen = new Set();
  const add = (candidate) => {
    const topicKey = typeof candidate === 'string'
      ? candidate.trim().toLowerCase()
      : String(candidate?.topic || candidate?.title || '').trim().toLowerCase();
    const initialSlug = typeof candidate === 'string'
      ? slugifyTopic(candidate)
      : String(candidate?.slug || candidate?.canonical_slug || '').trim();
    const existing = (initialSlug && existingBySlug.get(initialSlug)) || existingByTopic.get(topicKey) || null;
    const normalized = normalizeTopicRef(candidate, existing, now);
    if (!normalized || seen.has(normalized.slug)) return;
    refs.push(normalized);
    seen.add(normalized.slug);
  };

  for (const item of Array.isArray(completedTopics) ? completedTopics : []) add(item);
  for (const item of Array.isArray(completedTopicRefs) ? completedTopicRefs : []) add(item);
  return refs;
}

function normalizeState(state, opts = {}) {
  const next = JSON.parse(JSON.stringify(state || {}));
  const active = next.active_topic;
  if (active && typeof active === 'object' && active.topic && !active.slug) {
    active.slug = slugifyTopic(active.topic);
  }
  next.completed_topics = Array.isArray(next.completed_topics) ? next.completed_topics : [];
  next.completed_topic_refs = normalizeCompletedTopicRefs(
    next.completed_topics,
    next.completed_topic_refs,
    { now: opts.now || null },
  );
  return next;
}

function validateState(state, opts = {}) {
  const errors = [];
  const warnings = [];
  const normalized = normalizeState(state, opts);
  const active = normalized.active_topic;

  if (active && typeof active === 'object' && active.topic) {
    const expected = slugifyTopic(active.topic);
    if (!active.slug) errors.push('active_topic.slug missing');
    else if (active.slug !== expected) warnings.push(`active_topic.slug differs from canonical slug: ${active.slug} != ${expected}`);
  }

  const slugs = new Set();
  for (const ref of normalized.completed_topic_refs || []) {
    if (!ref.topic) errors.push('completed_topic_refs row missing topic');
    if (!ref.slug) errors.push(`completed_topic_refs row missing slug for ${ref.topic || '(unknown)'}`);
    if (ref.slug && slugs.has(ref.slug)) errors.push(`duplicate completed_topic_refs slug: ${ref.slug}`);
    if (ref.slug) slugs.add(ref.slug);
  }

  for (const topic of normalized.completed_topics || []) {
    if (typeof topic !== 'string') {
      warnings.push('completed_topics should remain string-compatible for older readers');
      continue;
    }
    const slug = slugifyTopic(topic);
    if (slug && !slugs.has(slug)) errors.push(`completed topic lacks canonical ref: ${topic}`);
  }

  if (active?.slug && slugs.has(active.slug)) {
    errors.push(`active topic already appears in completed_topic_refs: ${active.slug}`);
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    normalized,
  };
}

function parseArgs(argv) {
  const args = { statePath: DEFAULT_STATE, write: false, check: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--state') args.statePath = argv[++i];
    else if (arg === '--write') args.write = true;
    else if (arg === '--check') args.check = true;
    else if (arg === '--json') args.json = true;
  }
  return args;
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const statePath = path.resolve(args.statePath);
  if (!fs.existsSync(statePath)) {
    console.error(`[from-the-inside-state] fail state file not found: ${statePath}`);
    console.error(`[from-the-inside-state] canonical: ${DEFAULT_STATE}`);
    return 1;
  }
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const result = validateState(state);
  if (args.write) {
    fs.writeFileSync(statePath, `${JSON.stringify(result.normalized, null, 2)}\n`, 'utf8');
  }
  if (args.json) {
    process.stdout.write(`${JSON.stringify({ ...result, normalized: undefined }, null, 2)}\n`);
  } else {
    const rel = path.relative(process.cwd(), statePath) || statePath;
    console.log(`[from-the-inside-state] ${result.ok ? 'ok' : 'fail'} ${rel}`);
    for (const warning of result.warnings) console.log(`[from-the-inside-state] warning: ${warning}`);
    for (const error of result.errors) console.log(`[from-the-inside-state] error: ${error}`);
  }
  return result.ok ? 0 : 1;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = {
  normalizeCompletedTopicRefs,
  normalizeState,
  normalizeTopicRef,
  slugifyTopic,
  validateState,
};
