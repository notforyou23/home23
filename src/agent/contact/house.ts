import type { HouseEntityState, HouseLane } from './types.js';
import type { HomeAssistantCreds } from './secrets.js';

const AUTONOMOUS_DOMAINS = new Set([
  'light',
  'media_player',
  'fan',
  'scene',
  'notify',
  'input_button',
  'remote',
]);

const POLICY_DOMAINS = new Set([
  'climate',
  'camera',
  'cover',
  'lock',
  'alarm_control_panel',
  'valve',
  'water_heater',
  'humidifier',
  'siren',
]);

const POLICY_NAME = /garage|lock|camera|thermostat|water.?shut|sprinkler|alarm|security|valve/i;

export interface HouseClientOptions {
  creds: HomeAssistantCreds;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

function asEntity(raw: Record<string, unknown>): HouseEntityState {
  const entityId = String(raw.entity_id ?? '');
  const attributes = (raw.attributes && typeof raw.attributes === 'object')
    ? raw.attributes as Record<string, unknown>
    : {};
  return {
    entity_id: entityId,
    name: typeof attributes.friendly_name === 'string' ? attributes.friendly_name : entityId,
    state: String(raw.state ?? 'unknown'),
    domain: entityId.split('.')[0] ?? 'unknown',
    updated_at: typeof raw.last_updated === 'string' ? raw.last_updated : undefined,
    attributes,
  };
}

export function classifyHouseAction(entityId: string, domain = entityId.split('.')[0] ?? ''): HouseLane {
  if (!entityId || entityId === 'unknown') return 'forbidden';
  if (POLICY_DOMAINS.has(domain) || POLICY_NAME.test(entityId)) return 'policy';
  if (AUTONOMOUS_DOMAINS.has(domain)) return 'autonomous';
  if (domain === 'switch' && !POLICY_NAME.test(entityId)) return 'autonomous';
  return 'policy';
}

export class HouseClient {
  private readonly creds: HomeAssistantCreds;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: HouseClientOptions) {
    this.creds = opts.creds;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async getEntity(entityId: string): Promise<HouseEntityState> {
    const res = await this.fetchImpl(`${this.creds.url}/api/states/${encodeURIComponent(entityId)}`, {
      headers: headers(this.creds.token),
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 404) throw new Error(`entity not found: ${entityId}`);
    if (!res.ok) throw new Error(`Home Assistant HTTP ${res.status}`);
    return asEntity(await res.json() as Record<string, unknown>);
  }

  async listStates(): Promise<HouseEntityState[]> {
    const res = await this.fetchImpl(`${this.creds.url}/api/states`, {
      headers: headers(this.creds.token),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`Home Assistant HTTP ${res.status}`);
    const raw = await res.json() as Array<Record<string, unknown>>;
    return raw.map(asEntity);
  }

  async getArea(area: string): Promise<{ area: string; entity_ids: string[]; entities: HouseEntityState[] }> {
    const template = `{{ area_entities(${JSON.stringify(area)}) | list | tojson }}`;
    const res = await this.fetchImpl(`${this.creds.url}/api/template`, {
      method: 'POST',
      headers: headers(this.creds.token),
      body: JSON.stringify({ template }),
      signal: AbortSignal.timeout(8000),
    });
    let entityIds: string[] = [];
    if (res.ok) {
      const body = (await res.text()).trim();
      try {
        const parsed = JSON.parse(body);
        if (Array.isArray(parsed)) entityIds = parsed.map(String);
      } catch {
        const fallback = body.replace(/^"|"$/g, '');
        if (fallback.startsWith('[')) {
          try { entityIds = JSON.parse(fallback).map(String); } catch { entityIds = []; }
        }
      }
    }
    const states = await this.listStates();
    if (entityIds.length === 0) {
      const needle = area.toLowerCase();
      const matched = states.filter((entity) => (
        entity.entity_id.toLowerCase().includes(needle)
        || entity.name.toLowerCase().includes(needle)
        || String(entity.attributes?.area_id ?? '').toLowerCase() === needle
      ));
      return { area, entity_ids: matched.map((entity) => entity.entity_id), entities: matched };
    }
    const wanted = new Set(entityIds);
    return {
      area,
      entity_ids: entityIds,
      entities: states.filter((entity) => wanted.has(entity.entity_id)),
    };
  }

  async history(entityId: string, hours = 24): Promise<unknown> {
    const start = new Date(Date.now() - hours * 3600_000).toISOString();
    const url = `${this.creds.url}/api/history/period/${encodeURIComponent(start)}?filter_entity_id=${encodeURIComponent(entityId)}`;
    const res = await this.fetchImpl(url, {
      headers: headers(this.creds.token),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`Home Assistant HTTP ${res.status}`);
    return res.json();
  }

  async callService(domain: string, service: string, data: Record<string, unknown>): Promise<unknown> {
    const res = await this.fetchImpl(`${this.creds.url}/api/services/${encodeURIComponent(domain)}/${encodeURIComponent(service)}`, {
      method: 'POST',
      headers: headers(this.creds.token),
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Home Assistant HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
    }
    const text = await res.text();
    if (!text) return { ok: true };
    try { return JSON.parse(text); } catch { return { ok: true, raw: text.slice(0, 200) }; }
  }

  async actClosedLoop(input: {
    entityId: string;
    domain: string;
    service: string;
    data?: Record<string, unknown>;
    dryRun?: boolean;
    confirm?: boolean;
    settleMs?: number;
  }): Promise<{
    lane: HouseLane;
    dryRun: boolean;
    before: HouseEntityState;
    after: HouseEntityState | null;
    verified: boolean;
    called: boolean;
    refused?: string;
  }> {
    const lane = classifyHouseAction(input.entityId, input.domain);
    const before = await this.getEntity(input.entityId);
    if (lane === 'forbidden') {
      return { lane, dryRun: true, before, after: before, verified: false, called: false, refused: 'forbidden entity' };
    }
    if (lane === 'policy' && !input.confirm && !input.dryRun) {
      return {
        lane,
        dryRun: true,
        before,
        after: before,
        verified: false,
        called: false,
        refused: 'policy lane requires confirm=true (thermostat/camera/garage/lock/security/water)',
      };
    }
    if (input.dryRun) {
      return { lane, dryRun: true, before, after: before, verified: false, called: false };
    }
    await this.callService(input.domain, input.service, {
      entity_id: input.entityId,
      ...(input.data ?? {}),
    });
    await this.sleep(input.settleMs ?? 800);
    const after = await this.getEntity(input.entityId);
    return {
      lane,
      dryRun: false,
      before,
      after,
      verified: after.state !== before.state || JSON.stringify(after.attributes) !== JSON.stringify(before.attributes),
      called: true,
    };
  }
}
