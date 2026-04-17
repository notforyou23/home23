/**
 * PromoterWorker
 *
 * Off-engine worker that drains the cognitive NOTIFY stream into the
 * live-problems registry. Cognition emits free-form concerns as NOTIFY
 * tags → notifications.jsonl. This worker reads each unprocessed entry,
 * asks an LLM to classify it into a verifier + remediation spec, dry-runs
 * the verifier against current system state, and promotes to the
 * live-problems registry only if the verifier empirically agrees the
 * concern is real.
 *
 * The goal: free-form brain output becomes evidence-backed tracked problems
 * the engine's 3-tier loop can actually resolve, instead of unverified
 * text piling up on the dashboard.
 */
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';

interface Notification {
  id: string;
  cycle?: number;
  source?: string;
  message?: string;
  severity?: string;
  ts?: string;
  acknowledged?: boolean;
  count?: number;
  last_seen_cycle?: number;
}

interface AckMap {
  [id: string]: { acknowledged_at: string; auto_expired?: boolean; reason?: string };
}

interface RejectionCluster {
  category: 'file' | 'url' | 'pm2' | 'mount' | 'sensor' | 'other';
  count: number;
  firstSeenTs: string;
  lastSeenTs: string;
  notifIds: string[];
  lastSuggestedTs?: string;    // when we last emitted a registry_suggestion signal
}

interface PromoterState {
  processed: Record<string, { ts: string; outcome: PromoterOutcome; reason?: string; problemId?: string }>;
  rejections?: Record<string, RejectionCluster>;    // keyed by "category:target"
}

type PromoterOutcome =
  | 'promoted'           // posted to live-problems as tracked
  | 'false_positive'     // dry-run passed; concern isn't real
  | 'unverifiable'       // LLM couldn't map to a verifier type
  | 'unsupported'        // verifier type needs engine-internal context
  | 'skip_low_signal'    // too short / too vague / duplicate
  | 'error';             // LLM or network error (will retry after backoff)

export interface PromoterOpts {
  brainDir: string;
  dashboardBaseUrl: string;
  client: Anthropic;
  model: string;
  intervalMs?: number;
  logger?: { info?: (msg: string) => void; warn?: (msg: string) => void; error?: (msg: string) => void };
}

const DEFAULT_INTERVAL_MS = 60 * 1000;
const WARMUP_DELAY_MS = 30 * 1000;
const MAX_NOTIFICATIONS_PER_TICK = 3;   // rate-limit LLM calls
const MIN_MESSAGE_LEN = 15;
// Level 3: pattern-driven registry expansion thresholds.
const SUGGESTION_MIN_COUNT = 3;                       // N rejections before suggesting
const SUGGESTION_COOLDOWN_MS = 24 * 60 * 60 * 1000;   // 24h between re-suggestions for same target
const REJECTIONS_AGE_OUT_MS = 7 * 24 * 60 * 60 * 1000; // 7d: forget old rejections

const SYSTEM_PROMPT_HEADER = `You are a live-problem promoter. Your job is to decide whether a free-form concern from a cognitive agent maps to a DETERMINISTIC, MACHINE-VERIFIABLE check about current system state — or whether it's too vague/subjective/opinion-based to track as a problem.

If verifiable, propose a live-problem spec. If not, explain why not.

Available verifier types (ONLY these; proposing anything else = unverifiable):

  file_mtime          args: {path, maxAgeMin}
                      file modified within N minutes
  file_exists         args: {path, minBytes?}
                      file exists (optionally >= N bytes)
  pm2_status          args: {name}
                      PM2 process is "online"
  http_ping           args: {url, timeoutMs?, expectStatus?}
                      URL returns 2xx within timeout
  disk_free           args: {mount, minGiB}
                      filesystem has >= minGiB free
  jsonpath_http       args: {url, path, op, value?, timeoutMs?, expectStatus?}
                      GET url, extract dot/bracket path from JSON, compare.
                      Paths: "foo.bar", "arr[0].x", "sensors[id=system.cpu].ts"
                      Ops: >, >=, <, <=, ==, !=, exists, absent, truthy, falsy, matches, not_matches
                      Value can use templates: "{{now}}", "{{now-60min}}", "{{iso:now-6h}}"
  jsonl_recent_match  args: {path, windowMinutes, tsField?, matchField?, matchValue?, matchOp?, minCount?}
                      Scan tail of a JSONL file, return ok if >=minCount entries match in window.
                      Default tsField is "ts"; thoughts.jsonl uses "timestamp".
  composed            args: {op: "all_of"|"any_of", verifiers: [spec, ...]}
                      Combine other verifiers.

Available remediation types (in order; build a tiered plan):
  TIER 1 (rigid, deterministic):
    exec_command       args: {name: "clean_pm2_logs" | "reload_pm2_logs" | "clean_npm_cache" | "clean_docker_build_cache" | "clean_docker_dangling_images" | "clean_conv_tmp" | "clean_old_engine_logs"}    cooldownMin: 60
    pm2_restart        args: {name}                                                     cooldownMin: 15
    fetch_url          args: {url}                                                      cooldownMin: 15
  TIER 2 (agent dispatch for anything Tier 1 can't cover):
    dispatch_to_agent  args: {budgetHours: 1-12}                                        cooldownMin: 15
  TIER 3 (last resort):
    notify_jtr         args: {severity: "normal"|"urgent", text}                        cooldownMin: 720

Rules:
- ID must be snake_case, descriptive, stable. Example: "ios_health_shortcut_fresh", "feeder_pending_drain_ok".
- Claim must be a positive assertion about the working state ("X is fresh", "Y is online", NOT "X is broken").
- Always include a Tier-2 dispatch_to_agent step as fallback (budget 4h default) unless the concern is purely cosmetic.
- Always include a final Tier-3 notify_jtr as escalation (severity: normal; text = concise description for jtr).
- Reject as unverifiable if: subjective ("I wonder if..."), philosophical, design questions, or references that can't be bound to a concrete file/URL/process/mount in the registry below.
- Reject if the concern is about Home23 internals the agent is forbidden from introspecting.
- YOU MUST ONLY reference targets (files, urls, pm2 names, mounts, sensor ids) that appear in the TARGETS REGISTRY below. Inventing a target = immediate rejection on the harness side. If the concern references something not in the registry, set verifiable:false with reason="target not in registry: <what they referenced>".

Output: STRICT JSON only. No prose, no markdown.
Schema if verifiable:
  {"verifiable": true, "id": "...", "claim": "...", "verifier": {"type": "...", "args": {...}}, "remediation": [...]}
Schema if not:
  {"verifiable": false, "reason": "..."}

`;

export class PromoterWorker {
  private brainDir: string;
  private stateFile: string;
  private notifFile: string;
  private ackFile: string;
  private dashboardBaseUrl: string;
  private client: Anthropic;
  private model: string;
  private intervalMs: number;
  private logger: Required<NonNullable<PromoterOpts['logger']>>;
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private _ticking = false;

  private registryPromptText: string = '';
  private registryLoadedAt: number = 0;
  private static REGISTRY_TTL_MS = 5 * 60 * 1000;

  constructor(opts: PromoterOpts) {
    this.brainDir = opts.brainDir;
    this.stateFile = join(opts.brainDir, 'promoter-state.json');
    this.notifFile = join(opts.brainDir, 'notifications.jsonl');
    this.ackFile = join(opts.brainDir, 'notifications-ack.json');
    this.dashboardBaseUrl = opts.dashboardBaseUrl.replace(/\/$/, '');
    this.client = opts.client;
    this.model = opts.model;
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    const log = opts.logger;
    this.logger = {
      info: log?.info ?? ((m) => console.log(m)),
      warn: log?.warn ?? ((m) => console.warn(m)),
      error: log?.error ?? ((m) => console.error(m)),
    };
  }

  private async fetchRegistryText(): Promise<string> {
    if (this.registryPromptText && (Date.now() - this.registryLoadedAt) < PromoterWorker.REGISTRY_TTL_MS) {
      return this.registryPromptText;
    }
    try {
      const res = await fetch(`${this.dashboardBaseUrl}/api/targets`, { signal: AbortSignal.timeout(5_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { promptText?: string };
      this.registryPromptText = data.promptText || '';
      this.registryLoadedAt = Date.now();
    } catch (err) {
      this.logger.warn(`[promoter] failed to load targets registry: ${err instanceof Error ? err.message : String(err)}`);
      // Keep serving whatever we had; fall back to empty string if first try.
    }
    return this.registryPromptText;
  }

  private async validateViaRegistry(verifier: { type: string; args: Record<string, unknown> }): Promise<{ ok: boolean; reason?: string }> {
    try {
      const res = await fetch(`${this.dashboardBaseUrl}/api/targets/validate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ verifier }),
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) return { ok: false, reason: `validator HTTP ${res.status}` };
      return await res.json() as { ok: boolean; reason?: string };
    } catch (err) {
      return { ok: false, reason: `validator unreachable: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.timer = setTimeout(() => this.tick(), WARMUP_DELAY_MS);
    this.logger.info(`[promoter] worker started (interval=${Math.round(this.intervalMs / 1000)}s, warmup=${Math.round(WARMUP_DELAY_MS / 1000)}s)`);
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private scheduleNext(): void {
    if (!this.running) return;
    this.timer = setTimeout(() => this.tick(), this.intervalMs);
  }

  async tick(): Promise<void> {
    if (this._ticking) { this.scheduleNext(); return; }
    this._ticking = true;
    try {
      const initialState = this.loadState();
      const notifications = this.readNotifications();
      const acks = this.loadAcks();
      const candidates = notifications.filter(n => {
        if (!n.id || !n.message) return false;
        if (n.message.length < MIN_MESSAGE_LEN) return false;
        if (acks[n.id]) return false;                    // user or auto-acked
        if (initialState.processed[n.id]) return false;  // already processed
        return true;
      });
      if (candidates.length === 0) {
        this._ticking = false;
        this.scheduleNext();
        return;
      }
      // Take the most recent first — these are the concerns the brain is
      // most actively focused on. Also rate-limit to N per tick so we don't
      // LLM-flood on first boot with a stale backlog.
      const work = candidates.slice(-MAX_NOTIFICATIONS_PER_TICK);
      this.logger.info(`[promoter] tick: ${candidates.length} pending, processing ${work.length}`);
      for (const n of work) {
        let outcome: { outcome: PromoterOutcome; reason?: string; problemId?: string };
        try {
          outcome = await this.processOne(n);
        } catch (err) {
          outcome = {
            outcome: 'error',
            reason: err instanceof Error ? err.message : String(err),
          };
        }
        // Re-read state: processOne may have written rejection clusters via
        // recordRejection. If we serialized our pre-call copy, we'd clobber
        // those writes.
        const fresh = this.loadState();
        fresh.processed[n.id] = { ts: new Date().toISOString(), ...outcome };
        this.saveState(fresh);
      }
      // Level 3: after processing this tick's notifications, scan rejection
      // clusters and emit registry_suggestion signals for anything that
      // crossed the threshold.
      await this.emitRegistrySuggestions();
    } catch (err) {
      this.logger.warn(`[promoter] tick error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this._ticking = false;
      this.scheduleNext();
    }
  }

  private async processOne(n: Notification): Promise<{ outcome: PromoterOutcome; reason?: string; problemId?: string }> {
    const classification = await this.classify(n);
    if (!classification.verifiable) {
      this.autoAckNotification(n.id, 'unverifiable_by_promoter', classification.reason);
      // If the LLM self-rejected specifically because the target isn't in
      // the registry, treat it the same as a registry-validator rejection —
      // track for pattern-driven registry suggestions (Level 3).
      this.recordRejection(n.id, classification.reason, { type: 'unknown', args: {} });
      return { outcome: 'unverifiable', reason: classification.reason };
    }
    // Pre-flight: ask the engine's targets registry whether the proposed
    // verifier references real targets. This is the authoritative source of
    // truth — if the LLM invented a path/URL/process, the validator rejects.
    const preflight = await this.validateViaRegistry(classification.verifier);
    if (!preflight.ok) {
      this.logger.info(`[promoter] ${n.id} → hallucination_rejected: ${preflight.reason}`);
      this.autoAckNotification(n.id, 'hallucination_rejected_by_promoter', preflight.reason);
      // Level 3: track the rejection so we can surface "add X to the registry?"
      // suggestions when the same target keeps coming up.
      this.recordRejection(n.id, preflight.reason, classification.verifier);
      return { outcome: 'unverifiable', reason: `registry: ${preflight.reason}` };
    }
    // Dry-run the proposed verifier
    const dryRun = await this.dryRunVerifier(classification.verifier);
    if (!dryRun.supported) {
      this.autoAckNotification(n.id, 'unsupported_by_promoter', dryRun.reason);
      return { outcome: 'unsupported', reason: dryRun.reason };
    }
    if (dryRun.result?.ok === true) {
      // Not actually broken — don't promote. Auto-ack as false positive.
      this.logger.info(`[promoter] ${n.id} → false_positive: verifier passed (${classification.id})`);
      this.autoAckNotification(n.id, 'false_positive_by_promoter', `verifier ok: ${dryRun.result?.detail || ''}`);
      return { outcome: 'false_positive', reason: `dry-run verifier returned ok=true: ${dryRun.result?.detail || ''}`, problemId: classification.id };
    }
    // Post-dry-run guard: if the verifier failed because the target itself
    // doesn't exist (missing path, unregistered process, unreachable host),
    // the LLM hallucinated the target — this is NOT a confirmed problem.
    const detail = String(dryRun.result?.detail || '');
    const hallucinationPatterns = [
      /^missing:/i,             // file_mtime / file_exists when path absent
      /^not registered:/i,      // pm2_status with fabricated process name
      /^fetch failed:/i,        // http_ping with unreachable / DNS-fail host
      /^stat failed:/i,         // file_mtime stat error
      /^df output unparseable/i,// disk_free bad mount
      /^name required/i,        // args malformed by LLM
      /^url required/i,
      /^path required/i,
      /^mount required/i,
    ];
    if (hallucinationPatterns.some((p) => p.test(detail))) {
      this.logger.info(`[promoter] ${n.id} → hallucination_rejected (post dry-run): ${detail}`);
      this.autoAckNotification(n.id, 'hallucination_rejected_by_promoter', `dry-run: ${detail}`);
      return { outcome: 'unverifiable', reason: `verifier target does not exist: ${detail}` };
    }
    // Verifier agrees something's wrong — promote to live-problems
    const posted = await this.postProblem(classification);
    if (!posted.ok) {
      return { outcome: 'error', reason: posted.error };
    }
    // Auto-ack the notification since it now lives as a tracked problem.
    this.autoAckNotification(n.id, 'promoted_by_promoter', `→ live-problem:${classification.id}`);
    this.logger.info(`[promoter] promoted ${n.id} → ${classification.id} (${classification.claim})`);
    return { outcome: 'promoted', problemId: classification.id };
  }

  // Preflight is now delegated to the engine's targets registry via
  // /api/targets/validate (see validateViaRegistry above). The registry is
  // the single source of truth for "what exists on this system".

  /**
   * Level 3 — pattern-driven registry expansion.
   *
   * When a concern gets rejected because its target isn't in the registry,
   * we remember the target. When the same target accumulates enough
   * rejections (and we haven't suggested it recently), we emit a
   * `registry_suggestion` signal so jtr can decide whether to add it to
   * config/targets.yaml. This grows the vocabulary from real signal,
   * gated by jtr's judgment, without any LLM-driven auto-expansion.
   */
  private recordRejection(notifId: string, reason: string | undefined, verifier: { type: string; args: Record<string, unknown> }): void {
    if (!reason) return;
    const cluster = this.parseRejectedTarget(reason, verifier);
    if (!cluster) return;  // reason didn't mention a registry-able target
    const state = this.loadState();
    if (!state.rejections) state.rejections = {};
    const key = `${cluster.category}:${cluster.target}`;
    const now = new Date().toISOString();
    const existing = state.rejections[key];
    if (existing) {
      existing.count += 1;
      existing.lastSeenTs = now;
      if (!existing.notifIds.includes(notifId) && existing.notifIds.length < 20) {
        existing.notifIds.push(notifId);
      }
    } else {
      state.rejections[key] = {
        category: cluster.category,
        count: 1,
        firstSeenTs: now,
        lastSeenTs: now,
        notifIds: [notifId],
      };
    }
    this.saveState(state);
  }

  /** Parse a registry-rejection reason string into { category, target }. */
  private parseRejectedTarget(
    reason: string,
    verifier: { type: string; args: Record<string, unknown> },
  ): { category: RejectionCluster['category']; target: string } | null {
    // Registry validator emits:
    //   "file not in registry: <path>"
    //   "pm2 name not in registry: <name>"
    //   "mount not in registry: <mount>"
    //   "url host not in registry and not on local/private network: <url>"
    //   "child[N]: <nested reason>"
    const stripChild = reason.replace(/^child\[\d+\]:\s*/, '');
    const patterns: Array<[RegExp, RejectionCluster['category']]> = [
      [/^file not in registry:\s*(.+)$/,  'file'],
      [/^pm2 name not in registry:\s*(.+)$/, 'pm2'],
      [/^mount not in registry:\s*(.+)$/, 'mount'],
      [/^url host not in registry.*?:\s*(.+)$/, 'url'],
      // LLM self-reject format (it was told to emit reason="target not in registry: X"):
      [/target not in registry:\s*([^\s,—.]+?)(?:[\s,—.]|$)/i, 'other'],
    ];
    for (const [re, category] of patterns) {
      const m = stripChild.match(re);
      if (m && m[1]) {
        let target = m[1].trim();
        // Infer a better category from the target string shape
        let cat: RejectionCluster['category'] = category;
        if (cat === 'other') {
          if (/^https?:\/\//i.test(target)) cat = 'url';
          else if (target.startsWith('/') || target.startsWith('~')) cat = 'file';
          else if (/^home23-/.test(target)) cat = 'pm2';
          else if (/^[a-z.]+$/i.test(target) && target.includes('.')) cat = 'sensor';
        }
        return { category: cat, target };
      }
    }
    // sensor id: jsonpath_http path like "sensors[id=X].ts" may indicate a sensor
    if (verifier.type === 'jsonpath_http') {
      const p = typeof verifier.args?.path === 'string' ? verifier.args.path : '';
      const sm = p.match(/sensors\[id=([^\]]+)\]/);
      if (sm && sm[1]) return { category: 'sensor', target: sm[1].trim() };
    }
    return null;
  }

  /**
   * Scan rejection clusters; emit a registry_suggestion signal for any target
   * that crossed the threshold and hasn't been suggested recently. Called at
   * the end of each tick after regular processing.
   */
  private async emitRegistrySuggestions(): Promise<void> {
    const state = this.loadState();
    if (!state.rejections) return;
    const now = Date.now();
    let touched = false;

    // Age out very old rejection entries so the map doesn't grow unbounded.
    for (const [key, cluster] of Object.entries(state.rejections)) {
      const lastMs = Date.parse(cluster.lastSeenTs || cluster.firstSeenTs || '');
      if (lastMs && now - lastMs > REJECTIONS_AGE_OUT_MS) {
        delete state.rejections[key];
        touched = true;
      }
    }

    for (const [key, cluster] of Object.entries(state.rejections)) {
      if (cluster.count < SUGGESTION_MIN_COUNT) continue;
      const lastSuggested = cluster.lastSuggestedTs ? Date.parse(cluster.lastSuggestedTs) : 0;
      if (lastSuggested && now - lastSuggested < SUGGESTION_COOLDOWN_MS) continue;
      // Emit signal
      const target = key.replace(/^[^:]+:/, '');
      const sig = {
        type: 'registry_suggestion',
        source: 'promoter',
        title: `Add ${cluster.category} to registry: ${target}?`,
        message: `Promoter rejected ${cluster.count} concerns referencing this ${cluster.category} since ${cluster.firstSeenTs}. If this is something you care about, add it to config/targets.yaml so the system can track it.`,
        evidence: {
          category: cluster.category,
          target,
          rejectionCount: cluster.count,
          firstSeenTs: cluster.firstSeenTs,
          lastSeenTs: cluster.lastSeenTs,
          notifIds: cluster.notifIds,
        },
      };
      try {
        const res = await fetch(`${this.dashboardBaseUrl}/api/signals`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(sig),
          signal: AbortSignal.timeout(5_000),
        });
        if (res.ok) {
          cluster.lastSuggestedTs = new Date().toISOString();
          touched = true;
          this.logger.info(`[promoter] registry_suggestion emitted: ${cluster.category}:${target} (${cluster.count} rejections)`);
        } else {
          this.logger.warn(`[promoter] signal post failed: HTTP ${res.status}`);
        }
      } catch (err) {
        this.logger.warn(`[promoter] signal post failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (touched) this.saveState(state);
  }

  private autoAckNotification(id: string, reason: string, detail?: string): void {
    try {
      const acks: AckMap = this.loadAcks();
      if (acks[id]) return;   // already acked
      acks[id] = {
        acknowledged_at: new Date().toISOString(),
        auto_expired: true,
        reason: detail ? `${reason}: ${detail.slice(0, 200)}` : reason,
      };
      writeFileSync(this.ackFile, JSON.stringify(acks, null, 2));
    } catch (err) {
      this.logger.warn(`[promoter] auto-ack failed for ${id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async classify(n: Notification): Promise<
    | { verifiable: true; id: string; claim: string; verifier: { type: string; args: Record<string, unknown> }; remediation: unknown[] }
    | { verifiable: false; reason: string }
  > {
    const userMsg = `Agent role: ${n.source ?? 'unknown'}\nCycle: ${n.cycle ?? 'n/a'}\nTimes seen: ${n.count ?? 1}\n\nNotification message:\n${n.message}`;
    const registryText = await this.fetchRegistryText();
    const system = registryText
      ? `${SYSTEM_PROMPT_HEADER}\n${registryText}`
      : SYSTEM_PROMPT_HEADER;
    const resp = await this.client.messages.create({
      model: this.model,
      max_tokens: 600,
      system,
      messages: [{ role: 'user', content: userMsg }],
    });
    const text = resp.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { type: 'text'; text: string }).text)
      .join('\n')
      .trim();
    // Strip code fences if the model wrapped JSON
    const stripped = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripped);
    } catch {
      // Try to find the first balanced JSON object in the text
      const m = stripped.match(/\{[\s\S]*\}/);
      if (m) {
        try { parsed = JSON.parse(m[0]); } catch { /* fall through */ }
      }
    }
    if (!parsed || typeof parsed !== 'object') {
      return { verifiable: false, reason: `LLM returned unparseable output: ${text.slice(0, 200)}` };
    }
    const obj = parsed as Record<string, unknown>;
    if (obj.verifiable === false) {
      return { verifiable: false, reason: String(obj.reason ?? 'LLM rejected without reason') };
    }
    if (obj.verifiable === true
      && typeof obj.id === 'string'
      && typeof obj.claim === 'string'
      && obj.verifier && typeof obj.verifier === 'object'
      && typeof (obj.verifier as Record<string, unknown>).type === 'string') {
      return {
        verifiable: true,
        id: obj.id,
        claim: obj.claim,
        verifier: obj.verifier as { type: string; args: Record<string, unknown> },
        remediation: Array.isArray(obj.remediation) ? obj.remediation : [],
      };
    }
    return { verifiable: false, reason: 'LLM output missing required fields' };
  }

  private async dryRunVerifier(verifier: { type: string; args: Record<string, unknown> }): Promise<{ supported: boolean; reason?: string; result?: { ok: boolean; detail?: string; observed?: unknown } }> {
    try {
      const res = await fetch(`${this.dashboardBaseUrl}/api/live-problems/dry-run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ verifier }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return { supported: false, reason: `HTTP ${res.status}` };
      const data = await res.json() as { supported?: boolean; reason?: string; result?: { ok: boolean; detail?: string; observed?: unknown } };
      return { supported: data.supported !== false, reason: data.reason, result: data.result };
    } catch (err) {
      return { supported: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  private async postProblem(spec: { id: string; claim: string; verifier: unknown; remediation: unknown[] }): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch(`${this.dashboardBaseUrl}/api/live-problems`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...spec, seedOrigin: 'promoter' }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private loadState(): PromoterState {
    try {
      if (existsSync(this.stateFile)) {
        return JSON.parse(readFileSync(this.stateFile, 'utf-8')) as PromoterState;
      }
    } catch { /* ignore */ }
    return { processed: {} };
  }

  private saveState(state: PromoterState): void {
    try {
      writeFileSync(this.stateFile, JSON.stringify(state, null, 2));
    } catch (err) {
      this.logger.warn(`[promoter] state save failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private readNotifications(): Notification[] {
    try {
      if (!existsSync(this.notifFile)) return [];
      const raw = readFileSync(this.notifFile, 'utf-8');
      const out: Notification[] = [];
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try { out.push(JSON.parse(line) as Notification); } catch { /* skip malformed */ }
      }
      return out;
    } catch {
      return [];
    }
  }

  private loadAcks(): AckMap {
    try {
      if (existsSync(this.ackFile)) return JSON.parse(readFileSync(this.ackFile, 'utf-8')) as AckMap;
    } catch { /* ignore */ }
    return {};
  }
}

