import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RfChannel, _test } from '../../../../engine/src/channels/machine/rf-channel.js';

const ROUTE_WIRED_EN0 = `   route to: default
destination: default
       mask: default
    gateway: 192.168.4.1
  interface: en0
      flags: <UP,GATEWAY,DONE,STATIC,PRCLONING,GLOBAL>
`;

const ROUTE_WIFI_EN1 = ROUTE_WIRED_EN0.replace('interface: en0', 'interface: en1');

// Verbatim shape of `networksetup -listallhardwareports` on this house: en0 is
// wired Ethernet, Wi-Fi lives on en1.
const HARDWARE_PORTS = `
Hardware Port: Ethernet
Device: en0
Ethernet Address: d0:11:e5:d7:d8:fe

Hardware Port: Thunderbolt Bridge
Device: bridge0
Ethernet Address: 02:00:00:00:00:00

Hardware Port: Wi-Fi
Device: en1
Ethernet Address: d0:11:e5:d8:c2:4a

VLAN Configurations
===================
`;

const IFCONFIG_EN1_ACTIVE = `en1: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500
	options=6460<TSO4,TSO6,CHANNEL_IO,PARTIAL_CSUM,ZEROINVERT_CSUM>
	ether d0:11:e5:d8:c2:4a
	inet6 fe80::cb9:562f:773d:dc4b%en1 prefixlen 64 secured scopeid 0xf
	inet 192.168.4.99 netmask 0xfffffc00 broadcast 192.168.7.255
	nd6 options=201<PERFORMNUD,DAD>
	media: autoselect
	status: active
`;

const IFCONFIG_EN1_INACTIVE = `en1: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500
	ether d0:11:e5:d8:c2:4a
	nd6 options=201<PERFORMNUD,DAD>
	media: autoselect (<unknown type>)
	status: inactive
`;

// `ipconfig getsummary` embeds a raw DHCP packet dump whose lines must never be
// mistaken for interface-level facts.
const IPCONFIG_EN1 = `<dictionary> {
  BSSID : <redacted>
  ConnectionID : 1
  IPv4 : <array> {
    0 : <dictionary> {
      ConfigMethod : DHCP
      DHCP : <dictionary> {
        Packet : op = BOOTREPLY
InterfaceType : Bogus
LinkStatusActive : FALSE
SSID : NotTheRealOne
        State : BOUND
      }
    }
  }
  InterfaceType : WiFi
  LinkStatusActive : TRUE
  NetworkID : 8E2C0F00-0000-4000-8000-000000000000
  SSID : Home23
  Security : WPA3_SAE
}
`;

const COREWLAN_EN1 = JSON.stringify({
  interface: 'en1',
  powerOn: true,
  serviceActive: true,
  ssid: null,
  bssid: null,
  // JXA bridges ObjC scalars back as strings.
  rssi: '-51',
  noise: '-93',
  txRateMbps: '1200',
  phyMode: '6',
  channel: '48',
  channelWidthMhz: '80',
});

/**
 * Deterministic execFile stand-in. `plan` maps a command key to either stdout
 * text or an Error to reject with; anything unplanned is a hard test failure.
 */
function fakeExec(plan) {
  const calls = [];
  const exec = async (file, args) => {
    const key = [file, ...(args || [])].join(' ');
    calls.push({ file, args });
    const match = Object.keys(plan).find((prefix) => key.startsWith(prefix));
    if (!match) throw new Error(`unplanned command: ${key}`);
    const result = plan[match];
    if (result instanceof Error) throw result;
    return { stdout: result, stderr: '' };
  };
  exec.calls = calls;
  return exec;
}

const HEALTHY_PLAN = {
  '/sbin/route -n get default': ROUTE_WIRED_EN0,
  '/usr/sbin/networksetup -listallhardwareports': HARDWARE_PORTS,
  '/sbin/ifconfig en1': IFCONFIG_EN1_ACTIVE,
  '/usr/sbin/ipconfig getsummary en1': IPCONFIG_EN1,
  '/usr/bin/osascript -l JavaScript': COREWLAN_EN1,
};

const AT = () => new Date('2026-08-21T18:00:00.000Z');

test('RfChannel parses the macOS default route', () => {
  const route = _test.parseDefaultRoute(ROUTE_WIRED_EN0);
  assert.equal(route.interface, 'en0');
  assert.equal(route.gateway, '192.168.4.1');
  assert.equal(route.destination, 'default');
});

test('RfChannel discovers the Wi-Fi device from networksetup instead of assuming en0', () => {
  const ports = _test.parseHardwarePorts(HARDWARE_PORTS);
  assert.deepEqual(ports.map((entry) => entry.device), ['en0', 'bridge0', 'en1']);
  const wifi = _test.findWifiPort(ports);
  assert.equal(wifi.port, 'Wi-Fi');
  assert.equal(wifi.device, 'en1');
  assert.equal(_test.findWifiPort(ports.filter((entry) => entry.port !== 'Wi-Fi')), null);
});

test('RfChannel parses supported ifconfig / ipconfig / CoreWLAN status evidence', () => {
  const link = _test.parseIfconfig(IFCONFIG_EN1_ACTIVE);
  assert.equal(link.interface, 'en1');
  assert.equal(link.status, 'active');
  assert.equal(link.up, true);
  assert.equal(link.running, true);
  assert.equal(link.inet4, '192.168.4.99');

  const inactive = _test.parseIfconfig(IFCONFIG_EN1_INACTIVE);
  assert.equal(inactive.status, 'inactive');
  assert.equal(inactive.inet4, null);

  const summary = _test.parseIpconfigSummary(IPCONFIG_EN1);
  assert.equal(summary.interfaceType, 'WiFi');
  assert.equal(summary.linkStatusActive, true);
  assert.equal(summary.ssid, 'Home23');
  assert.equal(summary.security, 'WPA3_SAE');
  assert.equal(summary.bssid, null, 'redacted values must read as unknown, not as the literal string');

  const radio = _test.parseCoreWlanJson(COREWLAN_EN1);
  assert.equal(radio.rssi, -51);
  assert.equal(radio.noise, -93);
  assert.equal(radio.snr, 42);
  assert.equal(radio.txRateMbps, 1200);
  assert.equal(radio.phyMode, '802.11ax');
  assert.equal(radio.channel, 48);
  assert.equal(radio.channelWidthMhz, 80);
  assert.equal(radio.powerOn, true);

  assert.equal(_test.parseCoreWlanJson('not json').error, 'corewlan_json_parse_failed');
  assert.equal(_test.parseCoreWlanJson('{"error":"corewlan_interface_missing"}').error, 'corewlan_interface_missing');
});

test('RfChannel never shells to the removed airport binary or system_profiler', async () => {
  const exec = fakeExec(HEALTHY_PLAN);
  await _test.collectRfSample({ exec, now: AT });
  const commands = exec.calls.map((call) => call.file);
  assert.ok(!commands.some((file) => /airport/i.test(file)), commands.join(', '));
  assert.ok(!commands.some((file) => /system_profiler/i.test(file)), commands.join(', '));
  assert.deepEqual(commands.slice(0, 2), ['/sbin/route', '/usr/sbin/networksetup']);
});

test('RfChannel reads a wired en0 default route with an active en1 Wi-Fi radio as clear', async () => {
  const sample = await _test.collectRfSample({ exec: fakeExec(HEALTHY_PLAN), now: AT });

  assert.equal(sample.defaultRoute.interface, 'en0');
  assert.equal(sample.wifi.interface, 'en1');
  assert.equal(sample.wifi.hardwarePort, 'Wi-Fi');
  assert.equal(sample.wifi.status, 'running');
  assert.equal(sample.wifi.interfaceType, 'WiFi');
  assert.equal(sample.wifi.linkStatusActive, true);
  assert.equal(sample.wifi.ssid, 'Home23');
  assert.equal(sample.wifi.rssi, -51);
  assert.equal(sample.wifi.snr, 42);
  assert.equal(sample.wifi.error, undefined);
  assert.equal(sample.wifi.detailsError, undefined);

  assert.equal(sample.posture.physicalLayer, 'wired_or_other');
  assert.equal(sample.posture.severity, 'clear');
  assert.deepEqual(sample.posture.reasons, []);
  assert.deepEqual(sample.posture.sourceIssues, [81]);
});

test('RfChannel does not call an inactive non-route Wi-Fi radio a machine Wi-Fi failure', async () => {
  const sample = await _test.collectRfSample({
    exec: fakeExec({
      ...HEALTHY_PLAN,
      '/sbin/ifconfig en1': IFCONFIG_EN1_INACTIVE,
      '/usr/sbin/ipconfig getsummary en1': '<dictionary> {\n  InterfaceType : WiFi\n  LinkStatusActive : FALSE\n}\n',
      '/usr/bin/osascript -l JavaScript': JSON.stringify({ interface: 'en1', powerOn: false, rssi: '0', noise: '0' }),
    }),
    now: AT,
  });

  assert.equal(sample.wifi.status, 'inactive');
  assert.equal(sample.wifi.error, undefined);
  assert.equal(sample.posture.physicalLayer, 'wired_or_other');
  assert.equal(sample.posture.severity, 'clear');
  assert.deepEqual(sample.posture.reasons, []);
});

test('RfChannel survives optional radio-detail failure without a false wifi_radio_unreadable', async () => {
  const sample = await _test.collectRfSample({
    exec: fakeExec({
      ...HEALTHY_PLAN,
      '/usr/bin/osascript -l JavaScript': new Error('osascript timed out after 6000ms'),
    }),
    now: AT,
  });

  assert.equal(sample.wifi.error, undefined, 'supported link/status evidence means the radio is readable');
  assert.match(sample.wifi.detailsError, /corewlan: osascript timed out/);
  assert.equal(sample.wifi.status, 'running');
  assert.equal(sample.wifi.rssi, null);
  assert.ok(!sample.posture.reasons.includes('wifi_radio_unreadable'));
  assert.equal(sample.posture.severity, 'clear');
});

test('RfChannel keeps ipconfig-only evidence readable when ifconfig fails', async () => {
  const sample = await _test.collectRfSample({
    exec: fakeExec({
      ...HEALTHY_PLAN,
      '/sbin/ifconfig en1': new Error('ifconfig: interface en1 does not exist'),
      '/usr/bin/osascript -l JavaScript': new Error('osascript: execution error'),
    }),
    now: AT,
  });

  assert.equal(sample.wifi.error, undefined);
  assert.equal(sample.wifi.status, 'running', 'LinkStatusActive TRUE is supported status evidence');
  assert.match(sample.wifi.detailsError, /ifconfig: /);
  assert.match(sample.wifi.detailsError, /corewlan: /);
  assert.equal(sample.posture.severity, 'clear');
});

test('RfChannel flags a genuinely unreadable radio when every supported source fails', async () => {
  const sample = await _test.collectRfSample({
    exec: fakeExec({
      ...HEALTHY_PLAN,
      '/sbin/ifconfig en1': new Error('ifconfig: en1: permission denied'),
      '/usr/sbin/ipconfig getsummary en1': new Error('ipconfig: status unavailable'),
      '/usr/bin/osascript -l JavaScript': new Error('osascript: execution error'),
    }),
    now: AT,
  });

  assert.equal(sample.wifi.interface, 'en1');
  assert.match(sample.wifi.error, /ifconfig: |ipconfig: |corewlan: /);
  assert.ok(sample.posture.reasons.includes('wifi_radio_unreadable'));
  assert.equal(sample.posture.severity, 'watch');
});

test('RfChannel reports an absent Wi-Fi device rather than guessing one', async () => {
  const noWifi = await _test.collectRfSample({
    exec: fakeExec({
      '/sbin/route -n get default': ROUTE_WIRED_EN0,
      '/usr/sbin/networksetup -listallhardwareports': '\nHardware Port: Ethernet\nDevice: en0\nEthernet Address: d0:11:e5:d7:d8:fe\n',
    }),
    now: AT,
  });
  assert.equal(noWifi.wifi.error, 'wifi_device_not_found');
  assert.equal(noWifi.posture.physicalLayer, 'wired_or_other');
  assert.deepEqual(noWifi.posture.reasons, ['wifi_radio_unreadable']);

  const discoveryDown = await _test.collectRfSample({
    exec: fakeExec({
      '/sbin/route -n get default': ROUTE_WIRED_EN0,
      '/usr/sbin/networksetup -listallhardwareports': new Error('networksetup timed out after 8000ms'),
    }),
    now: AT,
  });
  assert.match(discoveryDown.wifi.error, /^wifi_device_discovery_failed: networksetup timed out/);
});

test('RfChannel classifies weak Wi-Fi as degraded when Wi-Fi carries the default route', () => {
  const posture = _test.classifyRfPosture({
    defaultRoute: { interface: 'en1' },
    wifi: { interface: 'en1', status: 'running', rssi: -75, noise: -90, snr: 15 },
  });

  assert.equal(posture.physicalLayer, 'wifi');
  assert.equal(posture.severity, 'degraded');
  assert.deepEqual(posture.sourceIssues, [81]);
  assert.ok(posture.reasons.includes('weak_rssi'));
  assert.ok(posture.reasons.includes('weak_snr'));
});

test('RfChannel calls a down radio a failure only when Wi-Fi is the route', async () => {
  const sample = await _test.collectRfSample({
    exec: fakeExec({
      ...HEALTHY_PLAN,
      '/sbin/route -n get default': ROUTE_WIFI_EN1,
      '/sbin/ifconfig en1': IFCONFIG_EN1_INACTIVE,
      '/usr/sbin/ipconfig getsummary en1': '<dictionary> {\n  InterfaceType : WiFi\n  LinkStatusActive : FALSE\n}\n',
      '/usr/bin/osascript -l JavaScript': new Error('osascript: execution error'),
    }),
    now: AT,
  });

  assert.equal(sample.posture.physicalLayer, 'wifi');
  assert.ok(sample.posture.reasons.includes('wifi_not_running'));
  assert.ok(sample.posture.reasons.includes('wifi_radio_details_unavailable'));
  assert.ok(!sample.posture.reasons.includes('wifi_radio_unreadable'));
  assert.equal(sample.posture.severity, 'degraded');
});

test('RfChannel keeps wired or clear transport informational', async () => {
  const channel = new RfChannel({
    sample: async () => ({
      at: '2026-05-11T16:30:00.000Z',
      defaultRoute: { interface: 'en5', gateway: '192.168.7.1' },
      wifi: { error: 'wifi_device_not_found' },
      posture: {
        severity: 'watch',
        reasons: ['wifi_radio_unreadable'],
        physicalLayer: 'wired_or_other',
        sourceIssues: [81],
      },
    }),
  });

  const raw = (await channel.poll())[0];
  const parsed = channel.parse(raw);
  const obs = channel.verify(parsed);

  assert.equal(obs.channelId, 'machine.rf');
  assert.equal(obs.flag, 'COLLECTED');
  assert.equal(obs.confidence, 0.7);
  assert.ok(channel.crystallize(obs));
});

test('RfChannel emits UNKNOWN when default route cannot be measured', async () => {
  const channel = new RfChannel({
    sample: async () => ({
      at: '2026-05-11T16:31:00.000Z',
      defaultRoute: { error: 'route failed' },
      wifi: { error: 'wifi_link_status_unavailable' },
      posture: {
        severity: 'degraded',
        reasons: ['default_route_unknown', 'wifi_radio_unreadable'],
        physicalLayer: 'unknown',
        sourceIssues: [81],
      },
    }),
  });

  const obs = channel.verify(channel.parse((await channel.poll())[0]));
  assert.equal(obs.flag, 'UNKNOWN');
  assert.equal(obs.confidence, 0.35);
  assert.ok(channel.crystallize(obs));
});

test('RfChannel verify reports full confidence on a healthy sample', async () => {
  const sample = await _test.collectRfSample({ exec: fakeExec(HEALTHY_PLAN), now: AT });
  const channel = new RfChannel({ sample: async () => sample });
  const obs = channel.verify(channel.parse((await channel.poll())[0]));

  assert.equal(obs.flag, 'COLLECTED');
  assert.equal(obs.confidence, 0.9);
  assert.equal(obs.verifierId, 'os:route-wifi-rf');
  assert.equal(channel.crystallize(obs), null, 'a clear posture must not crystallize a recurring RF problem');
});
