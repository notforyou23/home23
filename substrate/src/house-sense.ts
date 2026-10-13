/** Pure transition and noise discipline for the credentialed house runner. */
export interface HAState { entity_id: string; state: string; attributes?: Record<string, unknown> }
export interface HouseTransition { ts: string; entity: string; from: string; to: string; text: string }

export const DEFAULT_HOUSE_SENSE_CONFIG = Object.freeze({
  pollMs: 15_000,
  maxPerHour: 20,
  entityCooldownMs: 300_000,
});

export function houseSenseConfig(env: Record<string, string | undefined>) {
  const read = (name: string, fallback: number, minimum: number): number => {
    const value = Number(env[name] ?? fallback);
    if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${name} must be an integer >= ${minimum}`);
    return value;
  };
  return {
    pollMs: read('HOUSE_POLL_MS', DEFAULT_HOUSE_SENSE_CONFIG.pollMs, 1),
    maxPerHour: read('HOUSE_MAX_PER_HOUR', DEFAULT_HOUSE_SENSE_CONFIG.maxPerHour, 0),
    entityCooldownMs: read('HOUSE_ENTITY_COOLDOWN_MS', DEFAULT_HOUSE_SENSE_CONFIG.entityCooldownMs, 0),
  };
}

/** A transition is a lived event only in these shapes. */
export function narrate(entity: string, from: string, to: string, attrs: Record<string, unknown>): string | null {
  const name = typeof attrs['friendly_name'] === 'string' ? attrs['friendly_name'] : entity;
  const domain = entity.split('.')[0] ?? '';
  if (domain === 'binary_sensor') {
    if (to === 'on' && /(motion|person|pet|sound|occupancy|door|window)/.test(entity)) return `${name.replace(/ detected$/i, '')} detected`;
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
      return title !== null ? `${name} playing "${title}"${artist !== null ? ` — ${artist}` : ''}` : `${name} started playing`;
    }
    if (from === 'playing' && (to === 'idle' || to === 'paused' || to === 'off')) return `${name} stopped playing`;
    return null;
  }
  if (domain === 'person') {
    if (to === 'home') return `${name} arrived home`;
    if (from === 'home') return `${name} left home`;
    return null;
  }
  if (domain === 'lock') return to === 'locked' || to === 'unlocked' ? `${name} ${to}` : null;
  if (domain === 'alarm_control_panel') {
    if (/^armed/.test(to)) return `${name} armed (${to.replace('armed_', '')})`;
    if (to === 'disarmed') return `${name} disarmed`;
    return null;
  }
  if (domain === 'weather') return `weather turned ${to}`;
  return null;
}

export function createHouseSense(options: {
  maxPerHour: number;
  entityCooldownMs: number;
  ship(transition: HouseTransition): void;
}) {
  for (const [name, value] of [['maxPerHour', options.maxPerHour], ['entityCooldownMs', options.entityCooldownMs]] as const) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  }
  const prior = new Map<string, string>();
  const lastShipped = new Map<string, number>();
  let hourWindow: number[] = [];
  let primed = false;
  return {
    process(states: HAState[], now = Date.now()) {
      hourWindow = hourWindow.filter(t => now - t < 3_600_000);
      const result = { primed: !primed, shipped: 0, droppedByCap: 0, droppedByCooldown: 0 };
      for (const state of states) {
        const from = prior.get(state.entity_id);
        prior.set(state.entity_id, state.state);
        if (!primed || from === undefined || from === state.state) continue;
        if (state.state === 'unavailable' || state.state === 'unknown' || from === 'unavailable' || from === 'unknown') continue;
        const text = narrate(state.entity_id, from, state.state, state.attributes ?? {});
        if (text === null) continue;
        const last = lastShipped.get(state.entity_id);
        if (last !== undefined && now - last < options.entityCooldownMs) { result.droppedByCooldown += 1; continue; }
        if (hourWindow.length >= options.maxPerHour) { result.droppedByCap += 1; continue; }
        try {
          options.ship({ ts: new Date(now).toISOString(), entity: state.entity_id, from, to: state.state, text });
        } catch (error) {
          prior.set(state.entity_id, from);
          throw error;
        }
        lastShipped.set(state.entity_id, now);
        hourWindow.push(now);
        result.shipped += 1;
      }
      primed = true;
      return result;
    },
  };
}
