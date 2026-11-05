# Jerry Cron Root Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the structural issues behind Jerry's chronic cron failures — prompts-as-data, state machines in prompts, per-job history accumulation, and copy-pasted delivery targets — so future failures are single-job problems, not N-job problems.

**Architecture:** Four infrastructure changes to the scheduler/harness layer (`messagePath`, `sessionHistory`, `deliveryProfile`, tool surface), plus one content-side refactor (Jerry's `run-cycle.sh` stops clobbering agent output, cron prompt shrinks to a dispatcher). All changes are additive and back-compat — existing jobs continue working untouched, new fields opt in per-job.

**Tech Stack:** TypeScript (harness, `src/scheduler/`, `src/agent/tools/`), JSON (`cron-jobs.json`), YAML (`instances/<agent>/config.yaml`), Bash (Jerry's `run-cycle.sh`).

---

## File Structure

### Modify

- **`src/scheduler/cron.ts`** — extend `JobPayload` union with `messagePath` + `sessionHistory` fields (agentTurn variant only)
- **`src/home.ts`** (cron handler around line 551) — resolve `messagePath` before dispatch; honor `sessionHistory` by rotating history pre-run; resolve `delivery.profile` via new `DeliveryProfileResolver`
- **`src/scheduler/delivery.ts`** — add `DeliveryProfileResolver` + accept `profile` in `DeliveryConfig`, expanding to `channels[]` at send time
- **`src/agent/tools/cron.ts`** — surface `message_path`, `session_history`, `delivery_profile` in `cron_schedule` and `cron_update` input schemas
- **`src/types.ts`** — add `deliveryProfiles` section to agent config type
- **`instances/jerry/config.yaml`** — add `deliveryProfiles:` block with `ticker-broadcast` and `owner-only`
- **`instances/jerry/conversations/cron-jobs.json`** — migrate 6 agentTurn jobs to `messagePath` + `sessionHistory: "fresh"` on housekeeping/tickers, + `delivery.profile` on ticker jobs
- **`instances/jerry/projects/from-the-inside/bin/run-cycle.sh`** — remove all content-scaffolding writes; script becomes a pure state dispatcher that writes `NEXT_TASK.md`

### Create

- **`instances/jerry/workspace/cron-prompts/field-report-cycle.md`** — short dispatcher prompt (runs script, executes `NEXT_TASK.md`)
- **`instances/jerry/workspace/cron-prompts/brain-housekeeping.md`** — extracted from inline
- **`instances/jerry/workspace/cron-prompts/ticker-pre-market.md`** — extracted from inline
- **`instances/jerry/workspace/cron-prompts/ticker-mid-session.md`** — extracted from inline
- **`instances/jerry/workspace/cron-prompts/ticker-evening-research.md`** — extracted from inline
- **`instances/jerry/workspace/cron-prompts/x-timeline-morning.md`** — extracted from inline
- **`instances/jerry/workspace/cron-prompts/x-timeline-evening.md`** — extracted from inline

---

## Task 1: Schema — `messagePath` on agentTurn payloads

**Files:**
- Modify: `src/scheduler/cron.ts:23-27` (JobPayload union)
- Modify: `src/home.ts:556-585` (agentTurn dispatch)

- [ ] **Step 1: Extend JobPayload type**

In `src/scheduler/cron.ts`, replace the `JobPayload` type at lines 23-27 with:

```typescript
export type JobPayload =
  | { kind: 'agentTurn'; message?: string; messagePath?: string; model?: string; timeoutSeconds?: number; sessionHistory?: 'persistent' | 'fresh' }
  | { kind: 'exec'; command: string; timeoutSeconds?: number }
  | { kind: 'query'; message: string; mode?: string; model?: string; timeoutSeconds?: number }
  | { kind: 'systemEvent'; text: string };
```

- [ ] **Step 2: Resolve messagePath in the cron handler**

In `src/home.ts`, replace the `agentTurn` branch (around line 556-585) to resolve `messagePath`. Find:

```typescript
        if (job.payload.kind === 'agentTurn') {
          // Full AgentLoop — 19 tools, isolated chat history per job
          const timeoutMs = (job.payload.timeoutSeconds ?? 900) * 1000;
```

Replace with:

```typescript
        if (job.payload.kind === 'agentTurn') {
          // Full AgentLoop — 19 tools, isolated chat history per job
          const timeoutMs = (job.payload.timeoutSeconds ?? 900) * 1000;

          // Resolve message: prefer messagePath if set (and readable), else inline message.
          let resolvedMessage = job.payload.message ?? '';
          if (job.payload.messagePath) {
            const abs = job.payload.messagePath.startsWith('/')
              ? job.payload.messagePath
              : resolve(PROJECT_ROOT, job.payload.messagePath);
            try {
              resolvedMessage = readFileSync(abs, 'utf-8');
            } catch (err) {
              const errMsg = err instanceof Error ? err.message : String(err);
              const durationMs = Date.now() - startMs;
              return {
                status: 'error',
                error: `Cannot read messagePath "${job.payload.messagePath}": ${errMsg}`,
                durationMs,
              };
            }
          }
          if (!resolvedMessage) {
            const durationMs = Date.now() - startMs;
            return { status: 'error', error: 'agentTurn payload has neither message nor readable messagePath', durationMs };
          }
```

Then replace the single line `const agentPromise = agent.run(cronChatId, job.payload.message);` with:

```typescript
            const agentPromise = agent.run(cronChatId, resolvedMessage);
```

- [ ] **Step 3: Verify `readFileSync` + `resolve` are imported in home.ts**

Run: `grep -n "readFileSync\|from 'node:path'" /Users/jtr/_JTR23_/release/home23/src/home.ts | head -5`

Expected: both should appear. If `readFileSync` is missing, add it to the existing `node:fs` import. If `resolve` from `node:path` is missing, add it.

- [ ] **Step 4: Build**

Run: `cd /Users/jtr/_JTR23_/release/home23 && npx tsc 2>&1 | head -20`

Expected: no output (clean compile).

- [ ] **Step 5: Commit**

```bash
git add src/scheduler/cron.ts src/home.ts
git commit -m "feat(cron): support messagePath on agentTurn jobs"
```

---

## Task 2: Schema — `sessionHistory: fresh` rotation

**Files:**
- Modify: `src/home.ts` (agentTurn dispatch, after messagePath resolution)
- Modify: `src/agent/history.ts` (add a `rotate` method)

- [ ] **Step 1: Add `rotate(chatId)` to ConversationHistory**

In `src/agent/history.ts`, add this method before the `private filePath` method:

```typescript
  /** Move history aside so the next load() returns empty. Used by cron jobs with sessionHistory="fresh". */
  rotate(chatId: string): void {
    const filePath = this.filePath(chatId);
    if (!existsSync(filePath)) return;
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const archivePath = filePath.replace(/\.jsonl$/, `.${ts}.jsonl`);
    try {
      renameSync(filePath, archivePath);
    } catch {
      // Best-effort; if rename fails, leave in place — next run will still see old history
      console.warn(`[history] Failed to rotate ${filePath}`);
    }
  }
```

- [ ] **Step 2: Import `renameSync` at the top of history.ts**

In `src/agent/history.ts` line 8, change:

```typescript
import { readFileSync, appendFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
```

to:

```typescript
import { readFileSync, appendFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, renameSync } from 'node:fs';
```

- [ ] **Step 3: Honor sessionHistory in cron handler**

In `src/home.ts`, in the `agentTurn` branch, immediately before `const agentPromise = agent.run(cronChatId, resolvedMessage);`, add:

```typescript
            if (job.payload.kind === 'agentTurn' && job.payload.sessionHistory === 'fresh') {
              agent.getHistory().rotate(cronChatId);
            }
```

- [ ] **Step 4: Expose `getHistory` on the agent**

In `src/agent/loop.ts`, find the `getClient()` method (around line 329) and add immediately after it:

```typescript
  getHistory(): ConversationHistory { return this.history; }
```

- [ ] **Step 5: Build**

Run: `cd /Users/jtr/_JTR23_/release/home23 && npx tsc 2>&1 | head -20`

Expected: clean compile.

- [ ] **Step 6: Commit**

```bash
git add src/agent/history.ts src/agent/loop.ts src/home.ts
git commit -m "feat(cron): sessionHistory=fresh rotates chat JSONL before run"
```

---

## Task 3: Delivery profiles

**Files:**
- Modify: `src/types.ts` (add `deliveryProfiles` to agent config)
- Modify: `src/scheduler/cron.ts` (add `profile` to `DeliveryConfig`)
- Modify: `src/scheduler/delivery.ts` (resolve profile at send time)
- Modify: `src/home.ts` (pass profile map to `DeliveryManager`)

- [ ] **Step 1: Add deliveryProfiles to config type**

In `src/types.ts`, find the top-level `Config` or `AgentConfig` interface. Add this property (adjust placement to match the file's existing style):

```typescript
  deliveryProfiles?: Record<string, {
    channels: Array<{ channel: string; to: string }>;
  }>;
```

- [ ] **Step 2: Find the correct interface location**

Run: `grep -n "interface.*Config\|deliveryProfiles\|export interface" /Users/jtr/_JTR23_/release/home23/src/types.ts | head -20`

Place the new property in the top-level agent/home config interface (the one that already contains `scheduler`, `channels`, etc.). If unclear, use the interface that's loaded by `loadConfig` in `src/home.ts`.

- [ ] **Step 3: Add `profile` to DeliveryConfig**

In `src/scheduler/cron.ts`, replace the `DeliveryConfig` interface (around lines 29-34):

```typescript
export interface DeliveryConfig {
  mode: 'none' | 'failures' | 'summary' | 'full';
  channel?: string;
  channels?: Array<{ channel: string; to: string }>;
  to?: string;
  profile?: string;
}
```

- [ ] **Step 4: Resolve profile in DeliveryManager**

In `src/scheduler/delivery.ts`, replace the class with this expanded version — the constructor now takes a profiles map, and `deliver()` expands `profile` into `channels[]` before the existing target-building loop.

Replace lines 14-54 (class declaration + constructor + start of `deliver`):

```typescript
export type DeliveryProfiles = Record<string, {
  channels: Array<{ channel: string; to: string }>;
}>;

export class DeliveryManager {
  private adapters: Map<string, ChannelAdapter>;
  private profiles: DeliveryProfiles;

  constructor(adapters: Map<string, ChannelAdapter>, profiles: DeliveryProfiles = {}) {
    this.adapters = adapters;
    this.profiles = profiles;
  }

  /**
   * Deliver a job result to the configured channel(s).
   * Respects job.delivery.mode — if 'none' or missing, does nothing.
   * Supports profile (expanded from profiles map), channels[] (multi), and channel/to (single).
   */
  async deliver(job: CronJob, result: JobResult): Promise<void> {
    if (!job.delivery || job.delivery.mode === 'none') {
      return;
    }

    if (job.delivery.mode === 'failures' && result.status !== 'error') {
      return;
    }

    const text = this.formatText(job, result);
    if (!text) {
      return;
    }

    const targets: Array<{ channel: string; to: string }> = [];

    if (job.delivery.profile) {
      const profile = this.profiles[job.delivery.profile];
      if (!profile) {
        console.warn(`[delivery] Job ${job.id} references unknown profile "${job.delivery.profile}"`);
      } else {
        for (const t of profile.channels) targets.push({ channel: t.channel, to: t.to });
      }
    } else if (job.delivery.channels && job.delivery.channels.length > 0) {
      for (const t of job.delivery.channels) {
        targets.push({ channel: t.channel, to: t.to });
      }
    } else if (job.delivery.channel) {
      targets.push({ channel: job.delivery.channel, to: job.delivery.to ?? 'scheduler' });
    }
```

Keep the rest of `deliver()` (the `for (const target of targets)` loop through end) unchanged.

- [ ] **Step 5: Pass profiles to DeliveryManager**

In `src/home.ts`, find the line `const delivery = new DeliveryManager(adapterMap);` (around line 547) and replace with:

```typescript
  const delivery = new DeliveryManager(adapterMap, config.deliveryProfiles ?? {});
```

- [ ] **Step 6: Build**

Run: `cd /Users/jtr/_JTR23_/release/home23 && npx tsc 2>&1 | head -20`

Expected: clean compile.

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/scheduler/cron.ts src/scheduler/delivery.ts src/home.ts
git commit -m "feat(cron): delivery profiles resolved at send time"
```

---

## Task 4: Cron tool surface — accept new fields

**Files:**
- Modify: `src/agent/tools/cron.ts` (cron_schedule + cron_update)

- [ ] **Step 1: Add fields to cron_schedule input schema**

In `src/agent/tools/cron.ts`, in `cronScheduleTool.input_schema.properties` (lines 33-49), add:

```typescript
      message_path: { type: 'string', description: 'Path to a prompt file (alternative to message). Relative paths resolve from the home23 project root. Preferred for long prompts — makes them editable as files.' },
      session_history: { type: 'string', enum: ['persistent', 'fresh'], description: 'Session lifecycle for agentTurn jobs. "fresh" rotates chat history before each run (cleanest for stateless jobs). Default: "persistent".' },
      delivery_profile: { type: 'string', description: 'Name of a delivery profile from config.yaml deliveryProfiles. If set, overrides delivery_channel/delivery_to.' },
```

- [ ] **Step 2: Remove `required: ['name', 'schedule_kind', 'message']`**

Since `message_path` is now an alternative to `message`, replace:

```typescript
    required: ['name', 'schedule_kind', 'message'],
```

with:

```typescript
    required: ['name', 'schedule_kind'],
```

and add a runtime check in `execute` — in the validation block, right after the schedule is built and before building the payload, add:

```typescript
    const msgPath = typeof input.message_path === 'string' ? input.message_path : undefined;
    const msg = typeof input.message === 'string' ? input.message : undefined;
    if (!msg && !msgPath) {
      return { content: 'Either "message" or "message_path" is required.', is_error: true };
    }
```

- [ ] **Step 3: Honor the new fields when building the payload**

Replace the payload-building block (around lines 95-102):

```typescript
    let payload: JobPayload;
    if (payloadKind === 'exec') {
      payload = { kind: 'exec', command: message, ...(timeoutSeconds ? { timeoutSeconds } : {}), ...(cwd ? { cwd } : {}) } as JobPayload;
    } else if (payloadKind === 'query') {
      payload = { kind: 'query', message, ...(model ? { model } : {}), ...(timeoutSeconds ? { timeoutSeconds } : {}) };
    } else {
      payload = { kind: 'agentTurn', message, ...(model ? { model } : {}), ...(timeoutSeconds ? { timeoutSeconds } : {}) };
    }
```

with:

```typescript
    const sessionHistory = input.session_history === 'fresh' ? 'fresh' : undefined;

    let payload: JobPayload;
    if (payloadKind === 'exec') {
      payload = { kind: 'exec', command: msg ?? '', ...(timeoutSeconds ? { timeoutSeconds } : {}), ...(cwd ? { cwd } : {}) } as JobPayload;
    } else if (payloadKind === 'query') {
      payload = { kind: 'query', message: msg ?? '', ...(model ? { model } : {}), ...(timeoutSeconds ? { timeoutSeconds } : {}) };
    } else {
      payload = {
        kind: 'agentTurn',
        ...(msg ? { message: msg } : {}),
        ...(msgPath ? { messagePath: msgPath } : {}),
        ...(model ? { model } : {}),
        ...(timeoutSeconds ? { timeoutSeconds } : {}),
        ...(sessionHistory ? { sessionHistory } : {}),
      };
    }
```

- [ ] **Step 4: Honor delivery_profile when building the job**

In the same function, find the `delivery:` construction (around lines 121-125):

```typescript
      delivery: {
        mode: ((input.announce_mode as 'none' | 'failures' | 'summary' | 'full') || 'failures'),
        channel: (input.delivery_channel as string) || 'auto',
        to: deliveryTo,
      },
```

Replace with:

```typescript
      delivery: {
        mode: ((input.announce_mode as 'none' | 'failures' | 'summary' | 'full') || 'failures'),
        ...(typeof input.delivery_profile === 'string' && input.delivery_profile
          ? { profile: input.delivery_profile }
          : {
              channel: (input.delivery_channel as string) || 'auto',
              to: deliveryTo,
            }),
      },
```

- [ ] **Step 5: Add the same fields to cron_update**

In `cronUpdateTool.input_schema.properties` (lines 271-284), add:

```typescript
      message_path: { type: 'string', description: 'New messagePath for agentTurn jobs' },
      session_history: { type: 'string', enum: ['persistent', 'fresh'], description: 'New sessionHistory value' },
      delivery_profile: { type: 'string', description: 'New delivery profile name (replaces channel/to when set)' },
```

And in `cronUpdateTool.execute`, before the `if (changes.length === 0)` check, add:

```typescript
    if (typeof input.message_path === 'string' && job.payload.kind === 'agentTurn') {
      (job.payload as Record<string, unknown>).messagePath = input.message_path;
      // Clear inline message — messagePath takes precedence
      delete (job.payload as Record<string, unknown>).message;
      changes.push(`messagePath → "${input.message_path}"`);
    }
    if (typeof input.session_history === 'string' && job.payload.kind === 'agentTurn') {
      if (input.session_history === 'persistent') {
        delete (job.payload as Record<string, unknown>).sessionHistory;
      } else {
        (job.payload as Record<string, unknown>).sessionHistory = input.session_history;
      }
      changes.push(`sessionHistory → "${input.session_history}"`);
    }
    if (typeof input.delivery_profile === 'string' && job.delivery) {
      if (input.delivery_profile === '') {
        delete (job.delivery as Record<string, unknown>).profile;
      } else {
        job.delivery.profile = input.delivery_profile;
      }
      changes.push(`delivery.profile → "${input.delivery_profile}"`);
    }
```

- [ ] **Step 6: Build**

Run: `cd /Users/jtr/_JTR23_/release/home23 && npx tsc 2>&1 | head -20`

Expected: clean compile.

- [ ] **Step 7: Commit**

```bash
git add src/agent/tools/cron.ts
git commit -m "feat(cron-tools): expose message_path, session_history, delivery_profile"
```

---

## Task 5: Extract existing inline prompts to files

**Files:**
- Create: `instances/jerry/workspace/cron-prompts/*.md` (7 files)

- [ ] **Step 1: Create the prompts directory**

Run: `mkdir -p /Users/jtr/_JTR23_/release/home23/instances/jerry/workspace/cron-prompts`

- [ ] **Step 2: Extract brain-housekeeping prompt**

Write `instances/jerry/workspace/cron-prompts/brain-housekeeping.md` with exactly:

```
Run the brain housekeeping script at /Users/jtr/brain-housekeeping/brain-housekeeping.js. Read the resulting digest at /Users/jtr/brain-housekeeping-digest.json and summarize the action items for jtr. Keep it brief — one line per item, max 5 items. If there are no action items, just confirm "Brain housekeeping: no action items." Do NOT take any actions — only report what needs attention.
```

- [ ] **Step 3: Extract ticker-pre-market prompt**

Write `instances/jerry/workspace/cron-prompts/ticker-pre-market.md` with exactly:

```
Run the PRE-MARKET session for Ticker Home23. Work only inside /Users/jtr/_JTR23_/release/home23/instances/jerry/workspace/projects/ticker-home23. Read prompts/MISSION_PORT.md, prompts/PREMARKET_PROMPT.md, state/ticker-agent-handoff.md, state/portfolio.json, and recent data artifacts. Produce or update today's signals JSON, research markdown, handoff, and portfolio only if state truly changed. End with a concise Telegram-ready summary.
```

- [ ] **Step 4: Extract ticker-mid-session prompt**

Write `instances/jerry/workspace/cron-prompts/ticker-mid-session.md` with exactly:

```
Run the MID-SESSION for Ticker Home23. Work only inside /Users/jtr/_JTR23_/release/home23/instances/jerry/workspace/projects/ticker-home23. Read prompts/MISSION_PORT.md, prompts/MIDSESSION_PROMPT.md, state/ticker-agent-handoff.md, state/portfolio.json, and today's data artifacts. Update today's signals JSON, research markdown, and handoff only if state truly changed. End with a concise Telegram-ready summary.
```

- [ ] **Step 5: Extract ticker-evening-research prompt**

Write `instances/jerry/workspace/cron-prompts/ticker-evening-research.md` with exactly:

```
Run the EVENING-RESEARCH session for Ticker Home23. Work only inside /Users/jtr/_JTR23_/release/home23/instances/jerry/workspace/projects/ticker-home23. Read prompts/MISSION_PORT.md, prompts/EVENING_PROMPT.md, state/ticker-agent-handoff.md, state/portfolio.json, latest signals JSON, and recent research artifacts. Review the day, write research markdown, update signals if evening posture changed, update the handoff, and propose only provisional rule changes unless evidence is repeated. End with a concise Telegram-ready summary.
```

- [ ] **Step 6: Extract x-timeline-morning prompt**

Write `instances/jerry/workspace/cron-prompts/x-timeline-morning.md` with exactly:

```
X Timeline Morning Digest — $(date +%Y-%m-%d)

You are running jerry's X timeline morning digest.

**Step 1 — Fetch the raw timeline:**
Run: `bash /Users/jtr/_JTR23_/release/home23/scripts/x-timeline-fetch.sh 50`

**Step 2 — Read the raw output:**
The script outputs RAW_TL_FILE and TIMESTAMP env vars. Read the JSON file at that path.

**Step 3 — Summarize:**
Analyze the tweets. Produce a digest with:
- **Coverage period:** last ~24h
- **Total posts analyzed:** approximate count
- **Top themes** (bulleted, with tweet examples and handles)
- **Notable engagement** (high RT/likes, conversations)
- **Anything worth acting on** (mentions, opportunities, news)

**Step 4 — Deliver:**
Post the full digest as a message in this Telegram chat.

Format it to be readable — this is jtr's morning catch-up. Make it count.
```

- [ ] **Step 7: Extract x-timeline-evening prompt**

Write `instances/jerry/workspace/cron-prompts/x-timeline-evening.md` with exactly:

```
X Timeline Evening Digest — $(date +%Y-%m-%d)

You are running jerry's X timeline evening digest.

**Step 1 — Fetch the raw timeline:**
Run: `bash /Users/jtr/_JTR23_/release/home23/scripts/x-timeline-fetch.sh 75`

**Step 2 — Read the raw output:**
The script outputs RAW_TL_FILE and TIMESTAMP env vars. Read the JSON file at that path.

**Step 3 — Summarize:**
Analyze the tweets. Produce a digest with:
- **Coverage period:** full day (morning through evening)
- **Total posts analyzed:** approximate count
- **Top themes** (bulleted, with tweet examples and handles)
- **Notable engagement** (high RT/likes, conversations)
- **Anything worth acting on** (mentions, opportunities, news)
- **Culture/file/links spotted**

**Step 4 — Deliver:**
Post the full digest as a message in this Telegram chat.

Format it well — this is jtr's evening catch-up. Thematic grouping, concrete examples, honest signal over noise.
```

- [ ] **Step 8: Commit**

```bash
git add instances/jerry/workspace/cron-prompts/
git commit -m "chore(jerry): extract inline cron prompts to files"
```

Note: `instances/` is gitignored per CLAUDE.md, so this commit will be empty — verify with `git status` and skip the commit step if so. The files will still exist on disk.

---

## Task 6: Field-report refactor — script decides, agent executes

**Files:**
- Modify: `instances/jerry/projects/from-the-inside/bin/run-cycle.sh` (remove scaffolding writes; output NEXT_TASK.md instead)
- Create: `instances/jerry/workspace/cron-prompts/field-report-cycle.md` (short dispatcher)

**Why this exists:** The current `run-cycle.sh` writes empty-scaffold artifact files AND bumps `units_completed` AND exits — so when the agent then tries to write real content, either (a) the script already wrote an empty template over the artifact path, or (b) the state has already been advanced past the step the agent is working on. The real content never survives. Fix: script only decides state + writes a `NEXT_TASK.md` describing what the agent should write. The agent does all content + file writes + state update.

- [ ] **Step 1: Rewrite run-cycle.sh**

Overwrite `/Users/jtr/_JTR23_/release/home23/instances/jerry/projects/from-the-inside/bin/run-cycle.sh` with this content. This script no longer writes artifact content — it only picks the next state transition and emits `NEXT_TASK.md` for the agent to execute.

```bash
#!/bin/bash
# run-cycle.sh — From The Inside autostudy cycle dispatcher
# Called first by cron. Decides the next task and writes NEXT_TASK.md.
# The agent reads NEXT_TASK.md and does all real content generation + state updates.

set -e

BASE="/Users/jtr/_JTR23_/release/home23/instances/jerry/projects/from-the-inside"
STATE="$BASE/curriculum/autostudy/STATE.json"
TOPIC_POOL="$BASE/curriculum/autostudy/TOPIC_POOL.md"
QUEUE_DIR="$BASE/curriculum/autostudy/queue"
CURRICULA_DIR="$BASE/curriculum/autostudy/curricula"
ARTIFACTS_DIR="$BASE/curriculum/autostudy/artifacts"
NEXT_TASK="$BASE/NEXT_TASK.md"
NEXT_ISSUE_FILE="$BASE/state/next-issue.txt"

LOG="$BASE/logs/cycle-$(date +%Y%m%d-%H%M).log"
mkdir -p "$BASE/logs" "$QUEUE_DIR" "$CURRICULA_DIR" "$ARTIFACTS_DIR"

echo "[$(date)] Dispatcher starting" >> "$LOG"

active_topic=$(python3 -c "import json; d=json.load(open('$STATE')); print((d.get('active_topic') or {}).get('topic','') or '')")
topic_slug=$(python3 -c "import json; d=json.load(open('$STATE')); print((d.get('active_topic') or {}).get('slug','') or '')")
status=$(python3 -c "import json; d=json.load(open('$STATE')); print((d.get('active_topic') or {}).get('status','') or '')")
units_done=$(python3 -c "import json; d=json.load(open('$STATE')); print(d.get('progress',{}).get('units_completed',0))")
diss_done=$(python3 -c "import json; d=json.load(open('$STATE')); print(d.get('progress',{}).get('dissertation',False))")
issue_done=$(python3 -c "import json; d=json.load(open('$STATE')); print(d.get('progress',{}).get('issue_published',False))")

echo "[$(date)] State: topic='$active_topic' status='$status' units=$units_done diss=$diss_done issue=$issue_done" >> "$LOG"

# --- No active topic: need to pick or generate ---
if [ -z "$active_topic" ]; then
    # Check if pool is exhausted
    available=$(python3 << 'PYEOF'
import json, re
pool = '/Users/jtr/_JTR23_/release/home23/instances/jerry/projects/from-the-inside/curriculum/autostudy/TOPIC_POOL.md'
state_f = '/Users/jtr/_JTR23_/release/home23/instances/jerry/projects/from-the-inside/curriculum/autostudy/STATE.json'
with open(pool) as f: content = f.read()
topics = [l[2:].strip() for l in content.split('\n') if l.strip().startswith('- ') and '<!-- DONE' not in l]
with open(state_f) as f: state = json.load(f)
completed = state.get('completed_topics', [])
avail = [t for t in topics if t not in completed]
print(len(avail))
PYEOF
)
    if [ "$available" = "0" ]; then
        cat > "$NEXT_TASK" << 'EOF'
# Next Task: Generate Topic Wave

TOPIC_POOL.md is exhausted. Generate the next wave of 20 study topics.

Use `brain_query` with innovation mode. Prompt:

> You are jerry. Generate the next wave of 20 study topics for your internal curriculum. You have a track record of studying distributed systems, control theory, consciousness, ecology, and applied technical topics. Generate 20 new topics that feel like a natural continuation — some obvious, some lateral, some deeply weird. Include variety: hard science, philosophy, applied craft, personal. Output: a markdown list with a Wave header.

Append the output to `instances/jerry/projects/from-the-inside/curriculum/autostudy/TOPIC_POOL.md`.

Then: do nothing else. Next cron will pick a topic.
EOF
        echo "[$(date)] Task: wave generation" >> "$LOG"
        exit 0
    fi

    cat > "$NEXT_TASK" << 'EOF'
# Next Task: Pick Topic

Read `instances/jerry/projects/from-the-inside/curriculum/autostudy/TOPIC_POOL.md` and `instances/jerry/projects/from-the-inside/curriculum/autostudy/STATE.json`.

Pick ONE available topic (one not already in `completed_topics`). Compute its slug (lowercase, non-alphanumeric → `-`).

Update STATE.json:
- `active_topic` = { topic, slug, picked_at: ISO now, status: "queued" }
- `progress` = { units_completed: 0, total_units: 6, dissertation: false, issue_published: false }

Then: do nothing else. Next cron will generate the curriculum.
EOF
    echo "[$(date)] Task: pick topic" >> "$LOG"
    exit 0
fi

# --- Active topic, no curriculum yet ---
if [ "$status" = "queued" ] || [ "$status" = "building_curriculum" ]; then
    cat > "$NEXT_TASK" << EOF
# Next Task: Build Curriculum

Topic: **$active_topic** (slug: $topic_slug)

Write a real 6-unit curriculum to \`$CURRICULA_DIR/$topic_slug.md\`. Format: 6 sections titled \`## Unit N: <title>\` with a paragraph describing what each unit will cover. Make the units substantive and specific to this topic — not generic filler.

Then update STATE.json: \`active_topic.status = "curriculum_done"\`.

Then: do nothing else. Next cron will work unit 1.
EOF
    echo "[$(date)] Task: build curriculum" >> "$LOG"
    exit 0
fi

# --- Curriculum built, work one unit ---
if [ "$units_done" -lt 6 ]; then
    next_unit=$((units_done + 1))
    padded=$(printf '%02d' $next_unit)
    cat > "$NEXT_TASK" << EOF
# Next Task: Work Unit $next_unit

Topic: **$active_topic** (slug: $topic_slug)

1. Read \`$CURRICULA_DIR/$topic_slug.md\` to see what Unit $next_unit covers.
2. Actually think about this unit. Read recent unit artifacts in \`$ARTIFACTS_DIR/$topic_slug/\` to stay consistent.
3. Write real content to \`$ARTIFACTS_DIR/$topic_slug/unit-$padded.md\` — structured markdown with sections like Key Concepts, Implications for Agent Systems, Open Questions, Connection to Practice. No placeholders.
4. Update STATE.json: \`progress.units_completed = $next_unit\`, \`active_topic.status = "in_progress"\`.

Then: do nothing else. Next cron picks up the next unit or the dissertation.
EOF
    echo "[$(date)] Task: work unit $next_unit" >> "$LOG"
    exit 0
fi

# --- All units done, need dissertation ---
if [ "$units_done" -ge 6 ] && [ "$diss_done" != "True" ]; then
    cat > "$NEXT_TASK" << EOF
# Next Task: Write Dissertation

Topic: **$active_topic** (slug: $topic_slug)

1. Read all 6 unit artifacts in \`$ARTIFACTS_DIR/$topic_slug/unit-*.md\`.
2. Synthesize a real dissertation to \`$ARTIFACTS_DIR/$topic_slug/DISSERTATION.md\` — sections: Executive Summary, Theoretical Framework, Key Insights, Applications to Agent Systems, Connections to Prior Learning, Proposed Improvements, Score and Reflection. First person. Honest. No placeholders.
3. Update STATE.json: \`progress.dissertation = true\`.

Then: do nothing else. Next cron will publish the issue.
EOF
    echo "[$(date)] Task: dissertation" >> "$LOG"
    exit 0
fi

# --- Dissertation done, publish issue ---
if [ "$diss_done" = "True" ] && [ "$issue_done" != "True" ]; then
    issue_num=$(cat "$NEXT_ISSUE_FILE")
    padded_issue=$(printf '%03d' $issue_num)
    cat > "$NEXT_TASK" << EOF
# Next Task: Publish Issue #$issue_num

Topic: **$active_topic** (slug: $topic_slug)

1. Read \`$ARTIFACTS_DIR/$topic_slug/DISSERTATION.md\`.
2. Write a real Field Report issue (first person, honest, NOT a summary) to \`$BASE/issues/$padded_issue.json\` with fields: number=$issue_num, title="$active_topic", date=(today), slug="$topic_slug", description (1-2 sentences), content (the full report), published=true, publishedAt=ISO now.
3. Run: \`bash $BASE/bin/publish-issue.sh $issue_num\`.
4. Increment \`$NEXT_ISSUE_FILE\` (write $(($issue_num + 1))).
5. Update STATE.json: append "$active_topic" to completed_topics; set active_topic=null; reset progress to zeros with dissertation=false and issue_published=false.

Then: done. Next cron picks a new topic.
EOF
    echo "[$(date)] Task: publish issue $issue_num" >> "$LOG"
    exit 0
fi

# Fallback — cycle is complete, reset
cat > "$NEXT_TASK" << 'EOF'
# Next Task: (nothing)

Cycle is idle. State appears complete but wasn't reset. Report this to jtr.
EOF
echo "[$(date)] Task: idle fallback" >> "$LOG"
```

- [ ] **Step 2: Make it executable**

Run: `chmod +x /Users/jtr/_JTR23_/release/home23/instances/jerry/projects/from-the-inside/bin/run-cycle.sh`

- [ ] **Step 3: Create the short dispatcher cron prompt**

Write `instances/jerry/workspace/cron-prompts/field-report-cycle.md` with exactly:

```
You are running the Field Report cycle — jerry's internal newsletter from the inside.

Identity: read `instances/jerry/projects/from-the-inside/AGENTS.md`. This is who you are.

**Step 1.** Run: `bash /Users/jtr/_JTR23_/release/home23/instances/jerry/projects/from-the-inside/bin/run-cycle.sh`

The script will decide the next state transition and write the task description to `/Users/jtr/_JTR23_/release/home23/instances/jerry/projects/from-the-inside/NEXT_TASK.md`.

**Step 2.** Read `NEXT_TASK.md`.

**Step 3.** Execute exactly what it describes — ONE step per cron run. Think hard. Write real content. Update state. Do not do more than the task describes.

**Step 4.** End with a one-paragraph Telegram-ready note describing what you just did.
```

- [ ] **Step 4: Verify run-cycle.sh executes cleanly**

Run: `bash /Users/jtr/_JTR23_/release/home23/instances/jerry/projects/from-the-inside/bin/run-cycle.sh && cat /Users/jtr/_JTR23_/release/home23/instances/jerry/projects/from-the-inside/NEXT_TASK.md`

Expected: script exits 0, NEXT_TASK.md is created and describes a sensible next step based on current STATE.json.

- [ ] **Step 5: Commit**

```bash
git add instances/jerry/projects/from-the-inside/bin/run-cycle.sh instances/jerry/workspace/cron-prompts/field-report-cycle.md
git commit -m "refactor(from-the-inside): script dispatches, agent executes"
```

Note: this path is inside `instances/`, which is gitignored. Verify with `git status` and skip commit if so — the files persist on disk regardless.

---

## Task 7: Migrate jerry's jobs to new schema

**Files:**
- Modify: `instances/jerry/config.yaml` (add deliveryProfiles)
- Modify: `instances/jerry/conversations/cron-jobs.json` (7 agentTurn jobs)

- [ ] **Step 1: Stop the harness so scheduler won't overwrite edits**

Run: `pm2 stop home23-jerry-harness`

Expected: harness shows as stopped in pm2 list.

- [ ] **Step 2: Add deliveryProfiles to jerry's config.yaml**

In `/Users/jtr/_JTR23_/release/home23/instances/jerry/config.yaml`, append at the end (respecting existing indentation):

```yaml
deliveryProfiles:
  ticker-broadcast:
    channels:
      - channel: telegram
        to: "8317115546"
  owner-telegram:
    channels:
      - channel: telegram
        to: "8317115546"
```

(Discord is intentionally dropped per previous decision — when the Discord bot is re-permissioned into the ticker channel, add a `discord` entry here only and all three ticker jobs inherit.)

- [ ] **Step 3: Migrate brain-housekeeping job**

In `/Users/jtr/_JTR23_/release/home23/instances/jerry/conversations/cron-jobs.json`, find the brain-housekeeping job's `payload` block. Replace:

```json
    "payload": {
      "kind": "agentTurn",
      "message": "Run the brain housekeeping script..."
    },
```

with:

```json
    "payload": {
      "kind": "agentTurn",
      "messagePath": "instances/jerry/workspace/cron-prompts/brain-housekeeping.md",
      "sessionHistory": "fresh"
    },
```

- [ ] **Step 4: Migrate field-report-cycle job**

Find the field-report-cycle `payload` block. Replace with:

```json
    "payload": {
      "kind": "agentTurn",
      "messagePath": "instances/jerry/workspace/cron-prompts/field-report-cycle.md",
      "sessionHistory": "fresh",
      "timeoutSeconds": 1800
    },
```

And change its `delivery` block from the inline telegram-only config to:

```json
    "delivery": {
      "mode": "summary",
      "profile": "owner-telegram"
    },
```

- [ ] **Step 5: Migrate ticker-home23-pre-market job**

Replace its `payload`:

```json
    "payload": {
      "kind": "agentTurn",
      "messagePath": "instances/jerry/workspace/cron-prompts/ticker-pre-market.md",
      "sessionHistory": "fresh"
    },
```

And replace its `delivery`:

```json
    "delivery": {
      "mode": "full",
      "profile": "ticker-broadcast"
    },
```

- [ ] **Step 6: Migrate ticker-home23-mid-session job**

Replace its `payload`:

```json
    "payload": {
      "kind": "agentTurn",
      "messagePath": "instances/jerry/workspace/cron-prompts/ticker-mid-session.md",
      "sessionHistory": "fresh"
    },
```

And replace its `delivery`:

```json
    "delivery": {
      "mode": "full",
      "profile": "ticker-broadcast"
    },
```

- [ ] **Step 7: Migrate ticker-home23-evening-research job**

Replace its `payload`:

```json
    "payload": {
      "kind": "agentTurn",
      "messagePath": "instances/jerry/workspace/cron-prompts/ticker-evening-research.md",
      "sessionHistory": "fresh"
    },
```

And replace its `delivery`:

```json
    "delivery": {
      "mode": "full",
      "profile": "ticker-broadcast"
    },
```

- [ ] **Step 8: Migrate x-timeline-morning job**

Replace its `payload`:

```json
    "payload": {
      "kind": "agentTurn",
      "messagePath": "instances/jerry/workspace/cron-prompts/x-timeline-morning.md",
      "sessionHistory": "fresh",
      "timeoutSeconds": 1800
    },
```

Delivery stays as-is (already telegram-only from the earlier fix).

- [ ] **Step 9: Migrate x-timeline-evening job**

Replace its `payload`:

```json
    "payload": {
      "kind": "agentTurn",
      "messagePath": "instances/jerry/workspace/cron-prompts/x-timeline-evening.md",
      "sessionHistory": "fresh"
    },
```

Delivery stays as-is.

- [ ] **Step 10: Validate cron-jobs.json**

Run: `python3 -c "import json; d=json.load(open('/Users/jtr/_JTR23_/release/home23/instances/jerry/conversations/cron-jobs.json')); print(f'{len(d)} jobs valid')"`

Expected: `17 jobs valid` (or whatever the count is). If JSON parse fails, fix the syntax error.

- [ ] **Step 11: Quick sanity-check the migrations**

Run:

```bash
python3 -c "
import json
d = json.load(open('/Users/jtr/_JTR23_/release/home23/instances/jerry/conversations/cron-jobs.json'))
for j in d:
    if j['payload']['kind'] != 'agentTurn': continue
    has_path = 'messagePath' in j['payload']
    sh = j['payload'].get('sessionHistory', 'persistent')
    prof = j.get('delivery', {}).get('profile', '(inline)')
    print(f\"{j['name']:40s} path={'yes' if has_path else 'NO':3s} hist={sh:10s} delivery={prof}\")
"
```

Expected: all six target jobs show `path=yes` and `hist=fresh` (or `persistent` if intentionally kept). Tickers show `delivery=ticker-broadcast`.

- [ ] **Step 12: Start the harness**

Run: `pm2 start home23-jerry-harness && sleep 4 && pm2 logs home23-jerry-harness --lines 20 --nostream`

Expected: startup logs show `Cron: 17 job(s)` and no "malformed job" warnings. If any job was rejected, inspect the log and fix the JSON.

- [ ] **Step 13: Commit**

```bash
git add instances/jerry/config.yaml instances/jerry/conversations/cron-jobs.json
git commit -m "migrate(jerry): cron jobs to messagePath + sessionHistory + delivery profiles"
```

Note: `instances/` is gitignored — `git status` will likely show nothing to commit. The disk state is what matters.

---

## Task 8: Verify end-to-end

**Files:** none — observational only.

- [ ] **Step 1: Watch for the next brain-housekeeping fire**

Brain-housekeeping runs at `*/30 7-22` ET. The next fire will be at the next :00 or :30. After it runs, verify:

Run:

```bash
tail -1 /Users/jtr/_JTR23_/release/home23/instances/jerry/conversations/cron-runs/agent-97ef393d-8b3a-4402-b5aa-3d2632cc9769.jsonl | python3 -c "import json,sys; r=json.loads(sys.stdin.read()); print(f'status={r[\"status\"]} duration={r[\"durationMs\"]}ms error={r.get(\"error\",\"(none)\")[:120]}')"
```

Expected: `status=ok`, no "Invalid signature" error, no "fetch failed".

- [ ] **Step 2: Verify history was rotated**

Run: `ls -la /Users/jtr/_JTR23_/release/home23/instances/jerry/conversations/jerry__cron-agent-97ef393d-8b3a-4402-b5aa-3d2632cc9769* 2>/dev/null`

Expected: a base `.jsonl` file AND one or more rotated archives with timestamps (e.g., `.2026-04-17T...-jsonl`). The base file should have ~1-3 messages (current run only), not 125 turns of historical context.

- [ ] **Step 3: Verify a ticker job delivers to Telegram only**

Wait for the next `ticker-home23-mid-session` fire (`30 11 * * *` ET) or manually trigger a test via a `ticker-delivery-test-now`-style one-shot job. Confirm:
- No Discord 403 in the run log
- Telegram message arrives
- `delivery.lastDeliveryError` is `null` in the run log

- [ ] **Step 4: Verify field-report-cycle produces a real artifact**

Wait for the next `field-report-cycle` fire (`7 */2 * * *` ET), or inspect after a cycle completes:

```bash
# Check that NEXT_TASK.md exists and has meaningful content
cat /Users/jtr/_JTR23_/release/home23/instances/jerry/projects/from-the-inside/NEXT_TASK.md

# Check the last-written unit artifact is not scaffolding
ls -t /Users/jtr/_JTR23_/release/home23/instances/jerry/projects/from-the-inside/curriculum/autostudy/artifacts/*/unit-*.md 2>/dev/null | head -1 | xargs wc -l
```

Expected: the most recent unit artifact has ≥30 lines (real content), not the 12-line scaffolding pattern.

- [ ] **Step 5: Clean up old rotated histories older than 7 days (optional)**

After a few days of confirmed working, old rotated histories can be archived or deleted:

```bash
find /Users/jtr/_JTR23_/release/home23/instances/jerry/conversations -name "jerry__cron-agent-*.20*.jsonl" -mtime +7 -delete
```

---

## Rollback

If any change breaks in production:

1. **Immediate**: `pm2 stop home23-jerry-harness`
2. **Config rollback**: restore previous `cron-jobs.json` from `git` (the file is tracked in some form) or from rotated backup — the scheduler writes `.tmp-<uuid>` files during saves; the last-known-good state is the pre-migration content.
3. **Code rollback**: `git revert HEAD~N..HEAD` for the task commits. TypeScript changes are all additive and back-compat — existing inline-message jobs continue working even with the new schema, so partial rollback is safe.
4. **Rebuild + restart**: `npx tsc && pm2 start home23-jerry-harness`

The back-compat guarantee matters: a job with `message` but no `messagePath` still works. A `delivery` block with `channels[]` but no `profile` still works. A payload without `sessionHistory` defaults to persistent. This means any single task's rollback doesn't require rolling back later tasks.
