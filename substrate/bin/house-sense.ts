/**
 * House-sense — the home enters the individual's continuous causal life.
 *
 * Jerry, asked how he would know the home under the new paradigm: "not by
 * periodically loading sensor data into a prompt — that's stateless
 * intelligence visiting a database. From the inside, the home becomes part
 * of my continuous causal life." This organ is that answer built: Home
 * Assistant state transitions become lived events — words + meaning
 * perceived at contact — on a stream the Seed eats.
 *
 * Noise discipline (the K2 lesson applies to diets too): only TRANSITIONS
 * ship, only from domains where a change is a lived event (motion begins,
 * a door opens, music starts, a person arrives, weather turns). Ambient
 * telemetry (numeric sensors, switches, lights) stays out of the diet
 * until the individual grows organs that earn it. Per-entity cooldown and
 * a global hourly cap; drops are COUNTED in the log, never silent.
 *
 * Read-only against Home Assistant; append-only to the stream. The token
 * is read from gitignored config/secrets.yaml and never leaves this
 * process.
 *
 * Env: SHIPPER_STREAM_PATH (required); HOUSE_POLL_MS (default 15000);
 *      HOUSE_MAX_PER_HOUR (default 60); HOUSE_ENTITY_COOLDOWN_MS (120000).
 */

import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { fetchRawEmbedding } from '../src/embed-fetch.js';
import { load as yamlLoad } from 'js-yaml';
import { projectEmbedding, EMBED_DIM } from '../src/semantic-projection.js';

const streamPath = process.env['SHIPPER_STREAM_PATH'];
if (!streamPath) {
  console.error('SHIPPER_STREAM_PATH is required');
  process.exit(1);
}
const pollMs = Number(process.env['HOUSE_POLL_MS'] ?? 15_000);
const maxPerHour = Number(process.env['HOUSE_MAX_PER_HOUR'] ?? 60);
const entityCooldownMs = Number(process.env['HOUSE_ENTITY_COOLDOWN_MS'] ?? 120_000);

const secrets = yamlLoad(readFileSync('config/secrets.yaml', 'utf-8')) as {
  homeAssistant?: { url?: string; token?: string };
};
const HA_URL = secrets.homeAssistant?.url;
const HA_TOKEN = secrets.homeAssistant?.token;
if (!HA_URL || !HA_TOKEN) {
  console.error('homeAssistant.url/token missing from config/secrets.yaml');
  process.exit(1);
}

interface HAState { entity_id: string; state: string; attributes?: Record<string, unknown> }

/** A transition is a lived event only in these shapes. */
function narrate(entity: string, from: string, to: string, attrs: Record<string, unknown>): string | null {
  const name = typeof attrs['friendly_name'] === 'string' ? attrs['friendly_name'] : entity;
  const domain = entity.split('.')[0] ?? '';
  if (domain === 'binary_sensor') {
    // Motion/person/pet/sound begin — the onset is the event; the off is rest.
    if (to === 'on' && /(motion|person|pet|sound|occupancy|door|window)/.test(entity)) {
      return `${name.replace(/ detected$/i, '')} detected`;
    }
    return null;
  }
  if (domain === 'cover') {
    if (to === 'open') return `${name} opened`;
    if (to === 'closed') return `${name} closed`;
    return null;
  }
  if (domain === 'media_player') {
    if (to === 'playing') {
      const title = typeof attrs['media_title'] === 'string' ? attrs['media_title'] : null;
      const artist = typeof attrs['media_artist'] === 'string' ? attrs['media_artist'] : null;
      return title !== null
        ? `${name} playing "${title}"${artist !== null ? ` — ${artist}` : ''}`
        : `${name} started playing`;
    }
    if (from === 'playing' && (to === 'idle' || to === 'paused' || to === 'off')) return `${name} stopped playing`;
    return null;
  }
  if (domain === 'person') {
    if (to === 'home') return `${name} arrived home`;
    if (from === 'home') return `${name} left home`;
    return null;
  }
  if (domain === 'lock') {
    if (to === 'locked' || to === 'unlocked') return `${name} ${to}`;
    return null;
  }
  if (domain === 'alarm_control_panel') {
    if (/^armed/.test(to)) return `${name} armed (${to.replace('armed_', '')})`;
    if (to === 'disarmed') return `${name} disarmed`;
    return null;
  }
  if (domain === 'weather') {
    // Condition turns only ("rainy" → the sky changed), never temperature ticks.
    return `weather turned ${to}`;
  }
  return null;
}

function embedText(text: string): number[] | null {
  // Single fetch implementation in substrate/src/embed-fetch.ts (P2-15b).
  const raw = fetchRawEmbedding(text, EMBED_DIM);
  return raw === null ? null : projectEmbedding(raw);
}

async function fetchStates(): Promise<HAState[] | null> {
  try {
    const res = await fetch(`${HA_URL}/api/states`, {
      headers: { Authorization: `Bearer ${HA_TOKEN}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    return await res.json() as HAState[];
  } catch {
    return null;
  }
}

const prior = new Map<string, string>();
const lastShipped = new Map<string, number>();
let hourWindow: number[] = [];
let droppedThisHour = 0;
let primed = false;

async function tick(): Promise<void> {
  const states = await fetchStates();
  if (states === null) return; // HA unreachable — quiet; next poll retries
  const now = Date.now();
  hourWindow = hourWindow.filter((t) => now - t < 3_600_000);
  let shipped = 0;
  for (const st of states) {
    const from = prior.get(st.entity_id);
    prior.set(st.entity_id, st.state);
    if (!primed || from === undefined || from === st.state) continue;
    if (st.state === 'unavailable' || st.state === 'unknown' || from === 'unavailable' || from === 'unknown') continue;
    const text = narrate(st.entity_id, from, st.state, st.attributes ?? {});
    if (text === null) continue;
    const last = lastShipped.get(st.entity_id) ?? 0;
    if (now - last < entityCooldownMs) continue;
    if (hourWindow.length >= maxPerHour) { droppedThisHour += 1; continue; }
    const vector = embedText(text);
    appendFileSync(streamPath as string, JSON.stringify({
      ts: new Date().toISOString(),
      entity: st.entity_id,
      from,
      to: st.state,
      text,
      ...(vector !== null ? { semantic_vector: vector } : {}),
    }) + '\n');
    lastShipped.set(st.entity_id, now);
    hourWindow.push(now);
    shipped += 1;
    console.log(`[house-sense] ${text}`);
  }
  if (!primed) {
    primed = true;
    console.log(`[house-sense] primed on ${states.length} entities — transitions ship from here`);
  }
  if (droppedThisHour > 0 && hourWindow.length < maxPerHour) {
    console.log(`[house-sense] hourly cap had dropped ${droppedThisHour} event(s)`);
    droppedThisHour = 0;
  }
}

function main(): void {
  console.log(`[house-sense] ${HA_URL} → ${streamPath} poll=${pollMs}ms cap=${maxPerHour}/h cooldown=${entityCooldownMs}ms`);
  if (!existsSync(streamPath as string)) appendFileSync(streamPath as string, '');
  void tick();
  // Keep-alive poll: NEVER unref this timer (the resident-exit lesson).
  setInterval(() => { void tick(); }, pollMs);
}

main();
