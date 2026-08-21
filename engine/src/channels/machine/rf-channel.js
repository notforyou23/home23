/**
 * RfChannel - local RF/transport substrate sampler.
 *
 * Home23 runs in a real house, so transport failures are not always software
 * failures. This channel records the default route plus Wi-Fi radio evidence
 * where macOS exposes it, so bridge/dashboard drift can be compared against
 * RSSI, noise, channel, and interface facts.
 *
 * Collection uses supported macOS interfaces only:
 *   - /usr/sbin/networksetup -listallhardwareports  -> discovers the Wi-Fi device
 *     (never assume en0; on this house en0 is wired Ethernet and Wi-Fi is en1)
 *   - /sbin/ifconfig <device>                       -> link flags + status
 *   - /usr/sbin/ipconfig getsummary <device>        -> InterfaceType/LinkStatusActive
 *   - /usr/bin/osascript -l JavaScript (CoreWLAN)   -> optional radio values
 *
 * The removed private `airport` binary and the slow `system_profiler` fallback
 * are gone. Radio detail is optional: when CoreWLAN is unavailable but the
 * supported link/status evidence is present, the radio is readable and this
 * channel must not claim otherwise.
 */

'use strict';

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PollChannel } from '../base/poll-channel.js';
import { ChannelClass, makeObservation } from '../contract.js';

const execFileAsync = promisify(execFile);

const ROUTE_PATH = '/sbin/route';
const NETWORKSETUP_PATH = '/usr/sbin/networksetup';
const IFCONFIG_PATH = '/sbin/ifconfig';
const IPCONFIG_PATH = '/usr/sbin/ipconfig';
const OSASCRIPT_PATH = '/usr/bin/osascript';

const DEVICE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,14}$/;

// CWPHYMode -> human label. CoreWLAN returns the raw enum.
const PHY_MODES = { 0: 'none', 1: '802.11a', 2: '802.11b', 3: '802.11g', 4: '802.11n', 5: '802.11ac', 6: '802.11ax' };
// CWChannelWidth -> MHz. 0 is "unknown".
const CHANNEL_WIDTHS = { 1: 20, 2: 40, 3: 80, 4: 160 };

function errorMessage(reason) {
  return reason?.message || String(reason);
}

function toFiniteNumber(value) {
  if (value == null || value === '') return null;
  const parsed = Number(String(value).match(/-?\d+(?:\.\d+)?/)?.[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

/** macOS redacts privileged values (SSID/BSSID) rather than failing the call. */
function readableValue(value) {
  const text = String(value ?? '').trim();
  if (!text || /^<redacted>$/i.test(text) || /^<none>$/i.test(text)) return null;
  return text;
}

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

/** `networksetup -listallhardwareports` -> [{ port, device, macAddress }]. */
function parseHardwarePorts(stdout) {
  const ports = [];
  let current = null;
  for (const line of String(stdout || '').split('\n')) {
    const port = line.match(/^\s*Hardware Port:\s*(.+?)\s*$/);
    if (port) {
      current = { port: port[1], device: null, macAddress: null };
      ports.push(current);
      continue;
    }
    if (!current) continue;
    const device = line.match(/^\s*Device:\s*(.+?)\s*$/);
    if (device) { current.device = device[1]; continue; }
    const mac = line.match(/^\s*Ethernet Address:\s*(.+?)\s*$/);
    if (mac) current.macAddress = readableValue(mac[1]);
  }
  return ports.filter((entry) => entry.device);
}

/** The Wi-Fi hardware port, whatever device macOS assigned it. Never assume en0. */
function findWifiPort(ports) {
  return (ports || []).find((entry) => /wi-?fi|airport/i.test(entry.port || '')) || null;
}

function parseIfconfig(stdout) {
  const out = String(stdout || '');
  const header = out.match(/^(\S+):\s*flags=(\d+)?<([^>]*)>/m);
  const flags = header?.[3] ? header[3].split(',').map((flag) => flag.trim()).filter(Boolean) : [];
  const read = (key) => out.match(new RegExp(`^\\s*${key}:\\s*(.+)$`, 'm'))?.[1]?.trim() || null;
  return {
    interface: header?.[1] || null,
    flags,
    up: flags.includes('UP'),
    running: flags.includes('RUNNING'),
    status: read('status'),
    media: read('media'),
    inet4: out.match(/^\s*inet\s+(\d+\.\d+\.\d+\.\d+)/m)?.[1] || null,
  };
}

/**
 * `ipconfig getsummary <device>` prints a nested dictionary whose interface-level
 * facts sit at the outer indent. Match only that level so DHCP packet dumps and
 * per-service sub-dictionaries cannot masquerade as interface state.
 */
function parseIpconfigSummary(stdout) {
  const summary = {};
  for (const line of String(stdout || '').split('\n')) {
    const entry = line.match(/^ {2}(\w+)\s*:\s*(.*)$/);
    if (entry) summary[entry[1]] = entry[2].trim();
  }
  const linkRaw = summary.LinkStatusActive;
  return {
    interfaceType: readableValue(summary.InterfaceType),
    linkStatusActive: linkRaw == null ? null : /^true$/i.test(linkRaw),
    linkStatusRaw: linkRaw ?? null,
    ssid: readableValue(summary.SSID),
    bssid: readableValue(summary.BSSID),
    security: readableValue(summary.Security),
    networkId: readableValue(summary.NetworkID),
  };
}

/** Output of the CoreWLAN JXA probe. JXA bridges ObjC numbers as strings. */
function parseCoreWlanJson(stdout) {
  let parsed;
  try {
    parsed = typeof stdout === 'string' ? JSON.parse(stdout) : stdout;
  } catch {
    return { error: 'corewlan_json_parse_failed' };
  }
  if (!parsed || typeof parsed !== 'object') return { error: 'corewlan_json_empty' };
  if (parsed.error) return { error: String(parsed.error) };

  const rssi = toFiniteNumber(parsed.rssi);
  const noise = toFiniteNumber(parsed.noise);
  const phyModeRaw = toFiniteNumber(parsed.phyMode);
  return {
    interface: readableValue(parsed.interface),
    powerOn: typeof parsed.powerOn === 'boolean' ? parsed.powerOn : null,
    serviceActive: typeof parsed.serviceActive === 'boolean' ? parsed.serviceActive : null,
    ssid: readableValue(parsed.ssid),
    bssid: readableValue(parsed.bssid),
    rssi,
    noise,
    snr: rssi != null && noise != null ? rssi - noise : null,
    txRateMbps: toFiniteNumber(parsed.txRateMbps),
    phyMode: phyModeRaw == null ? null : (PHY_MODES[phyModeRaw] || `mode_${phyModeRaw}`),
    channel: toFiniteNumber(parsed.channel),
    channelWidthMhz: toFiniteNumber(parsed.channelWidthMhz),
  };
}

/**
 * Supported link/status evidence exists when a named Wi-Fi device reported any
 * of ifconfig status, ipconfig interface facts, or radio values. Optional radio
 * detail is not part of this test - that is the whole point of the split.
 */
function hasSupportedWifiEvidence(wifi) {
  if (!wifi || typeof wifi !== 'object' || wifi.error) return false;
  return Boolean(
    wifi.status
    || wifi.linkStatusActive != null
    || wifi.interfaceType
    || wifi.state
    || wifi.ssid
    || wifi.rssi != null,
  );
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

  // Wi-Fi carries the machine's traffic only when both interfaces are named and
  // identical. A wired default route means an idle radio is not a transport fault.
  const routeIsWifi = Boolean(routeInterface && wifiInterface && routeInterface === wifiInterface);
  const wifiReadable = hasSupportedWifiEvidence(wifi);

  if (!routeInterface) reasons.push('default_route_unknown');
  if (!wifiReadable) reasons.push('wifi_radio_unreadable');
  else if (routeIsWifi && wifi.detailsError && wifi.rssi == null) reasons.push('wifi_radio_details_unavailable');

  if (routeIsWifi && wifi.rssi != null && wifi.rssi <= weakRssi) reasons.push('weak_rssi');
  else if (routeIsWifi && wifi.rssi != null && wifi.rssi <= watchRssi) reasons.push('watch_rssi');

  if (routeIsWifi && wifi.snr != null && wifi.snr < weakSnr) reasons.push('weak_snr');
  else if (routeIsWifi && wifi.snr != null && wifi.snr < watchSnr) reasons.push('watch_snr');

  if (routeIsWifi && wifi.state && !/^running$/i.test(wifi.state)) reasons.push('wifi_not_running');
  else if (routeIsWifi && wifi.status && !/^running$/i.test(wifi.status)) reasons.push('wifi_not_running');

  const severity = reasons.some((reason) => reason.startsWith('weak_') || reason === 'wifi_not_running' || reason === 'default_route_unknown')
    ? 'degraded'
    : reasons.length > 0
      ? 'watch'
      : 'clear';

  return {
    severity,
    reasons,
    physicalLayer: routeIsWifi ? 'wifi' : (routeInterface ? 'wired_or_other' : 'unknown'),
    sourceIssues: [81],
  };
}

function coreWlanScript(device) {
  return `ObjC.import("CoreWLAN");
function num(v) { return v === undefined || v === null ? null : Number(v); }
var iface = $.CWWiFiClient.sharedWiFiClient.interfaceWithName($("${device}"));
if (!iface || iface.isNil()) {
  JSON.stringify({ error: "corewlan_interface_missing" });
} else {
  var channel = iface.wlanChannel;
  var channelNumber = null;
  var channelWidth = null;
  if (channel && !channel.isNil()) {
    channelNumber = num(channel.channelNumber);
    channelWidth = num(channel.channelWidth);
  }
  var ssid = iface.ssid;
  var bssid = iface.bssid;
  JSON.stringify({
    interface: iface.interfaceName.js,
    powerOn: iface.powerOn === true,
    serviceActive: iface.serviceActive === true,
    ssid: ssid && !ssid.isNil() ? ssid.js : null,
    bssid: bssid && !bssid.isNil() ? bssid.js : null,
    rssi: num(iface.rssiValue),
    noise: num(iface.noiseMeasurement),
    txRateMbps: num(iface.transmitRate),
    phyMode: num(iface.activePHYMode),
    channel: channelNumber,
    channelWidthMhz: ${JSON.stringify(CHANNEL_WIDTHS)}[channelWidth] || null
  });
}`;
}

async function collectWifi(exec, wifiPort, discoveryError) {
  const device = wifiPort?.device || null;
  if (!device || !DEVICE_NAME_PATTERN.test(device)) {
    return {
      source: 'networksetup',
      error: discoveryError
        ? `wifi_device_discovery_failed: ${discoveryError}`
        : device
          ? `wifi_device_name_unsupported: ${device}`
          : 'wifi_device_not_found',
    };
  }

  const [linkResult, summaryResult, radioResult] = await Promise.allSettled([
    exec(IFCONFIG_PATH, [device], { encoding: 'utf8', timeout: 4000, maxBuffer: 128 * 1024 }),
    exec(IPCONFIG_PATH, ['getsummary', device], { encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 }),
    exec(OSASCRIPT_PATH, ['-l', 'JavaScript', '-e', coreWlanScript(device)], { encoding: 'utf8', timeout: 6000, maxBuffer: 256 * 1024 }),
  ]);

  const link = linkResult.status === 'fulfilled' ? parseIfconfig(linkResult.value.stdout) : null;
  const summary = summaryResult.status === 'fulfilled' ? parseIpconfigSummary(summaryResult.value.stdout) : null;
  const radioRaw = radioResult.status === 'fulfilled' ? parseCoreWlanJson(radioResult.value.stdout) : null;
  const radio = radioRaw && !radioRaw.error ? radioRaw : null;

  const detailsErrors = [];
  if (linkResult.status === 'rejected') detailsErrors.push(`ifconfig: ${errorMessage(linkResult.reason)}`);
  if (summaryResult.status === 'rejected') detailsErrors.push(`ipconfig: ${errorMessage(summaryResult.reason)}`);
  if (radioResult.status === 'rejected') detailsErrors.push(`corewlan: ${errorMessage(radioResult.reason)}`);
  else if (radioRaw?.error) detailsErrors.push(`corewlan: ${radioRaw.error}`);

  const statusRaw = link?.status
    ?? (summary?.linkStatusActive == null ? null : summary.linkStatusActive ? 'active' : 'inactive');
  const sources = ['networksetup'];
  if (link) sources.push('ifconfig');
  if (summary) sources.push('ipconfig');
  if (radio) sources.push('corewlan');

  const wifi = {
    source: sources.join('+'),
    interface: device,
    hardwarePort: wifiPort.port || null,
    // 'running' | 'inactive' preserves the shape earlier consumers already read.
    status: statusRaw ? (/^active$/i.test(statusRaw) ? 'running' : 'inactive') : null,
    statusRaw,
    linkStatusActive: summary?.linkStatusActive ?? null,
    interfaceType: summary?.interfaceType ?? null,
    flags: link?.flags ?? null,
    media: link?.media ?? null,
    inet4: link?.inet4 ?? null,
    security: summary?.security ?? null,
    ssid: radio?.ssid ?? summary?.ssid ?? null,
    bssid: radio?.bssid ?? summary?.bssid ?? null,
    rssi: radio?.rssi ?? null,
    noise: radio?.noise ?? null,
    snr: radio?.snr ?? null,
    txRateMbps: radio?.txRateMbps ?? null,
    phyMode: radio?.phyMode ?? null,
    channel: radio?.channel ?? null,
    channelWidthMhz: radio?.channelWidthMhz ?? null,
    powerOn: radio?.powerOn ?? null,
  };
  if (detailsErrors.length) wifi.detailsError = detailsErrors.join('; ');
  // Only a total absence of supported link/status evidence is an unreadable radio.
  if (!hasSupportedWifiEvidence(wifi)) {
    wifi.error = detailsErrors.length ? detailsErrors.join('; ') : 'wifi_link_status_unavailable';
  }
  return wifi;
}

async function collectRfSample({ exec = execFileAsync, now = () => new Date() } = {}) {
  const at = now().toISOString();
  const [routeResult, portsResult] = await Promise.allSettled([
    exec(ROUTE_PATH, ['-n', 'get', 'default'], { encoding: 'utf8', timeout: 5000, maxBuffer: 128 * 1024 }),
    exec(NETWORKSETUP_PATH, ['-listallhardwareports'], { encoding: 'utf8', timeout: 8000, maxBuffer: 256 * 1024 }),
  ]);

  const defaultRoute = routeResult.status === 'fulfilled'
    ? parseDefaultRoute(routeResult.value.stdout)
    : { error: errorMessage(routeResult.reason) };
  const hardwarePorts = portsResult.status === 'fulfilled'
    ? parseHardwarePorts(portsResult.value.stdout)
    : [];
  const discoveryError = portsResult.status === 'rejected' ? errorMessage(portsResult.reason) : null;

  const wifi = await collectWifi(exec, findWifiPort(hardwarePorts), discoveryError);
  const payload = { at, defaultRoute, wifi };
  return {
    ...payload,
    posture: classifyRfPosture(payload),
  };
}

async function defaultSample() {
  return collectRfSample();
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
      verifierId: 'os:route-wifi-rf',
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

export const _test = {
  parseDefaultRoute,
  parseHardwarePorts,
  findWifiPort,
  parseIfconfig,
  parseIpconfigSummary,
  parseCoreWlanJson,
  hasSupportedWifiEvidence,
  classifyRfPosture,
  collectRfSample,
};
