import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RfChannel, _test } from '../../../../engine/src/channels/machine/rf-channel.js';

test('RfChannel parses macOS default route and airport radio facts', () => {
  const route = _test.parseDefaultRoute(`
   route to: default
destination: default
       mask: default
    gateway: 192.168.7.1
  interface: en0
      flags: <UP,GATEWAY,DONE,STATIC,PRCLONING,GLOBAL>
`);
  const wifi = _test.parseAirportInfo(`
     agrCtlRSSI: -74
     agrCtlNoise: -91
          state: running
        op mode: station
     lastTxRate: 144
        maxRate: 866
          SSID: Home23
         BSSID: aa:bb:cc:dd:ee:ff
       channel: 149,80
`);

  assert.equal(route.interface, 'en0');
  assert.equal(route.gateway, '192.168.7.1');
  assert.equal(wifi.rssi, -74);
  assert.equal(wifi.noise, -91);
  assert.equal(wifi.snr, 17);
  assert.equal(wifi.channel, 149);
  assert.equal(wifi.channelWidthMhz, 80);
});

test('RfChannel classifies weak Wi-Fi as degraded physical substrate', () => {
  const posture = _test.classifyRfPosture({
    defaultRoute: { interface: 'en0' },
    wifi: { state: 'running', rssi: -75, noise: -90, snr: 15 },
  });

  assert.equal(posture.physicalLayer, 'wifi');
  assert.equal(posture.severity, 'degraded');
  assert.deepEqual(posture.sourceIssues, [81]);
  assert.ok(posture.reasons.includes('weak_rssi'));
  assert.ok(posture.reasons.includes('weak_snr'));
});

test('RfChannel keeps wired or clear transport informational', async () => {
  const channel = new RfChannel({
    sample: async () => ({
      at: '2026-05-11T16:30:00.000Z',
      defaultRoute: { interface: 'en5', gateway: '192.168.7.1' },
      wifi: { error: 'airport unavailable' },
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
      wifi: { error: 'airport failed' },
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
