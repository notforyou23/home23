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
 *      HOUSE_MAX_PER_HOUR (default 20); HOUSE_ENTITY_COOLDOWN_MS (300000).
 */

import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { fetchRawEmbedding } from '../src/embed-fetch.js';
import { load as yamlLoad } from 'js-yaml';
import { projectEmbedding, EMBED_DIM } from '../src/semantic-projection.js';
import { buildWriterSemanticStamp } from '../src/semantic-provenance.js';
import { createHouseSense, houseSenseConfig, type HAState } from '../src/house-sense.js';

function embedText(text: string): number[] | null {
  const raw = fetchRawEmbedding(text, EMBED_DIM);
  return raw === null ? null : projectEmbedding(raw);
}

function main(): void {
  const streamPath = process.env['SHIPPER_STREAM_PATH'];
  if (!streamPath) throw new Error('SHIPPER_STREAM_PATH is required');
  const { pollMs, maxPerHour, entityCooldownMs } = houseSenseConfig(process.env);
  const secrets = yamlLoad(readFileSync('config/secrets.yaml', 'utf-8')) as {
    homeAssistant?: { url?: string; token?: string };
  };
  const haUrl = secrets.homeAssistant?.url;
  const haToken = secrets.homeAssistant?.token;
  if (!haUrl || !haToken) throw new Error('homeAssistant.url/token missing from config/secrets.yaml');

  const sense = createHouseSense({ maxPerHour, entityCooldownMs, ship(transition) {
    const vector = embedText(transition.text);
    appendFileSync(streamPath, JSON.stringify({ ...transition,
      ...buildWriterSemanticStamp({ vector, text: transition.text }),
    }) + '\n');
    console.log(`[house-sense] ${transition.text}`);
  } });
  // One poll at a time: a slow fetch must not let another tick observe the
  // same prior state and consume the hourly budget concurrently.
  let polling = false;
  const tick = async (): Promise<void> => {
    if (polling) return;
    polling = true;
    try {
      const response = await fetch(`${haUrl}/api/states`, {
        headers: { Authorization: `Bearer ${haToken}` }, signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) return;
      const states = await response.json() as HAState[];
      const result = sense.process(states);
      if (result.primed) console.log(`[house-sense] primed on ${states.length} entities — transitions ship from here`);
      if (result.droppedByCap > 0 || result.droppedByCooldown > 0) {
        console.log(`[house-sense] dropped ${result.droppedByCap} by hourly cap; ${result.droppedByCooldown} by entity cooldown`);
      }
    } catch {
      // Never print the request or error, which could expose authorization.
      console.error('[house-sense] poll failed; next poll will retry');
    } finally {
      polling = false;
    }
  };

  console.log(`[house-sense] ${haUrl} → ${streamPath} poll=${pollMs}ms cap=${maxPerHour}/h cooldown=${entityCooldownMs}ms`);
  if (!existsSync(streamPath)) appendFileSync(streamPath, '');
  void tick();
  // Keep-alive poll: NEVER unref this timer (the resident-exit lesson).
  setInterval(() => { void tick(); }, pollMs);
}

// Importing rate-limit logic must not read credentials or start a writer.
const SELF = /house-sense\.(ts|js)$/;
if (SELF.test(process.argv[1] ?? '') || SELF.test(process.env['pm_exec_path'] ?? '')) main();
