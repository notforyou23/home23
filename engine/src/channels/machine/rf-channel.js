/**
 * RfChannel - local RF/transport substrate sampler.
 *
 * Home23 runs in a real house, so transport failures are not always software
 * failures. This channel records the default route plus Wi-Fi radio evidence
 * where macOS exposes it, so bridge/dashboard drift can be compared against
 * RSSI, noise, channel, and interface facts.
 */

'use strict';

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PollChannel } from '../base/poll-channel.js';
import { ChannelClass, makeObservation } from '../contract.js';

const execFileAsync = promisify(execFile);
const AIRPORT_PATH = '/System/Library/PrivateFrameworks/Apple80211.framework/Versions/Current/Resources/airport';

function parseDefaultRoute(stdout) {
  const out = String(stdout || '');
  const read = (key) => out.match(new RegExp(`^\\s*${key}:\\s*(.+)$`, 'mi'))?.[1]?.trim() || null;
  return {
    destination: read('destination'),
    gateway: read('gateway'),
    interface: read('interface'),
    ifscope: read('ifscope'),
    raw: out.trim(),
  };
}

function parseAirportInfo(stdout) {
  const out = String(stdout || '');
  const read = (key) => out.match(new RegExp(`^\\s*${key}:\\s*(.+)$`, 'mi'))?.[1]?.trim() || null;
  const number = (value) => {
    const parsed = Number(String(value || '').match(/-?\d+(?:\.\d+)?/)?.[0]);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const channelRaw = read('channel');
  const channelMatch = String(channelRaw || '').match(/^(\d+)(?:,\s*(\d+))?/);
  const rssi = number(read('agrCtlRSSI'));
  const noise = number(read('agrCtlNoise'));

  return {
    ssid: read('SSID'),
    bssid: read('BSSID'),
    state: read('state'),
    opMode: read('op mode'),
    rssi,
    noise,
    snr: rssi != null && noise != null ? rssi - noise : null,
    lastTxRateMbps: number(read('lastTxRate')),
    maxRateMbps: number(read('maxRate')),
    phyMode: read('PHY mode'),
    channel: channelMatch ? Number(channelMatch[1]) : null,
    channelWidthMhz: channelMatch?.[2] ? Number(channelMatch[2]) : null,
    channelRaw,
    raw: out.trim(),
  };
}

function firstFiniteNumber(value) {
  const parsed = Number(String(value || '').match(/-?\d+(?:\.\d+)?/)?.[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function findValueByKeyFragment(source, fragments) {
  if (!source || typeof source !== 'object') return null;
  const queue = [source];
  while (queue.length) {
    const next = queue.shift();
    if (!next || typeof next !== 'object') continue;
    for (const [key, value] of Object.entries(next)) {
      const lowered = key.toLowerCase();
      if (fragments.some((fragment) => lowered.includes(fragment))) return value;
      if (value && typeof value === 'object') queue.push(value);
    }
  }
  return null;
}

function parseSystemProfilerWifiJson(stdout) {
  let parsed;
  try {
    parsed = typeof stdout === 'string' ? JSON.parse(stdout) : stdout;
  } catch {
    return { error: 'system_profiler_wifi_json_parse_failed' };
  }

  const section = Array.isArray(parsed?.SPAirPortDataType) ? parsed.SPAirPortDataType[0] : null;
  const iface = Array.isArray(section?.spairport_airport_interfaces)
    ? section.spairport_airport_interfaces[0]
    : null;
  if (!iface) return { error: 'system_profiler_wifi_interface_missing' };

  const current = iface.spairport_current_network_information || {};
  const signalRaw = findValueByKeyFragment(current, ['signal']);
  const noiseRaw = findValueByKeyFragment(current, ['noise']);
  const channelRaw = findValueByKeyFragment(current, ['channel']);
  const signalParts = String(signalRaw || '').match(/-?\d+(?:\.\d+)?/g) || [];
  const rssi = signalParts[0] != null ? Number(signalParts[0]) : firstFiniteNumber(findValueByKeyFragment(current, ['rssi']));
  const noise = noiseRaw != null
    ? firstFiniteNumber(noiseRaw)
    : signalParts[1] != null ? Number(signalParts[1]) : null;
  const channelMatch = String(channelRaw || '').match(/(\d+)(?:,\s*(\d+))?/);
  const statusRaw = iface.spairport_status_information || iface.status || '';
  const inactive = /inactive|off|not[_ -]?connected/i.test(String(statusRaw));

  return {
    source: 'system_profiler',
    interface: iface._name || null,
    status: inactive ? 'inactive' : (statusRaw ? 'running' : null),
    statusRaw,
    ssid: current._name || current.spairport_network_name || null,
    bssid: current.spairport_network_bssid || null,
    rssi: Number.isFinite(rssi) ? rssi : null,
    noise: Number.isFinite(noise) ? noise : null,
    snr: Number.isFinite(rssi) && Number.isFinite(noise) ? rssi - noise : null,
    phyMode: findValueByKeyFragment(current, ['phy']) || null,
    channel: channelMatch ? Number(channelMatch[1]) : null,
    channelWidthMhz: channelMatch?.[2] ? Number(channelMatch[2]) : null,
    channelRaw: channelRaw == null ? null : String(channelRaw),
    cardType: iface.spairport_wireless_card_type || null,
  };
}

function classifyRfPosture(payload, thresholds = {}) {
  const wifi = payload?.wifi || {};
  const route = payload?.defaultRoute || {};
  const weakRssi = thresholds.weakRssi ?? -72;
  const watchRssi = thresholds.watchRssi ?? -67;
  const weakSnr = thresholds.weakSnr ?? 20;
  const watchSnr = thresholds.watchSnr ?? 25;
  const reasons = [];
  const routeInterface = route.interface || null;
  const wifiInterface = wifi.interface || null;
  const routeMatchesWifi = routeInterface && wifiInterface
    ? routeInterface === wifiInterface
    : true;
  const wifiStatusRunning = !wifi.status || /^running$/i.test(wifi.status);

  if (!routeInterface) reasons.push('default_route_unknown');
  if (wifi.error) reasons.push('wifi_radio_unreadable');

  const isLikelyWifi = routeInterface && /^en\d+$/i.test(routeInterface)
    && routeMatchesWifi
    && wifiStatusRunning
    && (wifi.rssi != null || wifi.ssid || wifi.state || wifi.status);

  if (routeMatchesWifi && wifi.rssi != null && wifi.rssi <= weakRssi) reasons.push('weak_rssi');
  else if (routeMatchesWifi && wifi.rssi != null && wifi.rssi <= watchRssi) reasons.push('watch_rssi');

  if (routeMatchesWifi && wifi.snr != null && wifi.snr < weakSnr) reasons.push('weak_snr');
  else if (routeMatchesWifi && wifi.snr != null && wifi.snr < watchSnr) reasons.push('watch_snr');

  if (wifi.state && !/^running$/i.test(wifi.state)) reasons.push('wifi_not_running');
  if (routeMatchesWifi && wifi.status && !/^running$/i.test(wifi.status)) reasons.push('wifi_not_running');

  const severity = reasons.some((reason) => reason.startsWith('weak_') || reason === 'wifi_not_running' || reason === 'default_route_unknown')
    ? 'degraded'
    : reasons.length > 0
      ? 'watch'
      : 'clear';

  return {
    severity,
    reasons,
    physicalLayer: isLikelyWifi ? 'wifi' : (route.interface ? 'wired_or_other' : 'unknown'),
    sourceIssues: [81],
  };
}

async function defaultSample() {
  const at = new Date().toISOString();
  const [routeResult, wifiResult] = await Promise.allSettled([
    execFileAsync('route', ['-n', 'get', 'default'], { encoding: 'utf8', timeout: 5000, maxBuffer: 128 * 1024 }),
    execFileAsync(AIRPORT_PATH, ['-I'], { encoding: 'utf8', timeout: 5000, maxBuffer: 256 * 1024 }),
  ]);

  const defaultRoute = routeResult.status === 'fulfilled'
    ? parseDefaultRoute(routeResult.value.stdout)
    : { error: routeResult.reason?.message || String(routeResult.reason) };
  let wifi = wifiResult.status === 'fulfilled'
    ? { ...parseAirportInfo(wifiResult.value.stdout), source: 'airport' }
    : { error: wifiResult.reason?.message || String(wifiResult.reason), source: 'airport' };
  if (wifi.error) {
    try {
      const { stdout } = await execFileAsync('/usr/sbin/system_profiler', ['SPAirPortDataType', '-json'], {
        encoding: 'utf8',
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
      });
      wifi = {
        ...parseSystemProfilerWifiJson(stdout),
        airportError: wifi.error,
      };
    } catch (err) {
      wifi = {
        error: wifi.error,
        systemProfilerError: err?.message || String(err),
        source: 'airport+system_profiler',
      };
    }
  }
  const payload = { at, defaultRoute, wifi };
  return {
    ...payload,
    posture: classifyRfPosture(payload),
  };
}

export class RfChannel extends PollChannel {
  constructor({
    intervalMs = 5 * 60 * 1000,
    sample = defaultSample,
    id = 'machine.rf',
  } = {}) {
    super({ id, class: ChannelClass.MACHINE, intervalMs });
    this.sample = sample;
  }

  async poll() { return [await this.sample()]; }

  parse(raw) { return { payload: raw, sourceRef: `rf:${raw.at}`, producedAt: raw.at }; }

  verify(parsed) {
    const routeKnown = Boolean(parsed.payload?.defaultRoute?.interface);
    const wifiReadable = !parsed.payload?.wifi?.error;
    return makeObservation({
      channelId: this.id,
      sourceRef: parsed.sourceRef,
      payload: parsed.payload,
      flag: routeKnown ? 'COLLECTED' : 'UNKNOWN',
      confidence: routeKnown && wifiReadable ? 0.9 : routeKnown ? 0.7 : 0.35,
      producedAt: parsed.producedAt,
      verifierId: 'os:route-airport-rf',
    });
  }

  crystallize(obs) {
    const severity = obs.payload?.posture?.severity || 'unknown';
    if (severity === 'clear') return null;
    return {
      method: 'sensor_primary',
      type: 'observation',
      topic: 'rf-transport',
      tags: ['machine', 'rf', 'transport', severity],
    };
  }
}

export const _test = { parseDefaultRoute, parseAirportInfo, parseSystemProfilerWifiJson, classifyRfPosture };
