import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WeatherChannel } from '../../../../engine/src/channels/domain/weather-channel.js';

test('WeatherChannel emits COLLECTED on successful fetch', async () => {
  const ch = new WeatherChannel({ intervalMs: 10, fetchWeather: async () => ({ tempF: 66.7, humidity: 40, pressureInhg: 30.2, at: '2026-04-21T00:00:00Z' }) });
  const raw = await ch.poll();
  const parsed = ch.parse(raw[0]);
  const obs = ch.verify(parsed);
  assert.equal(obs.flag, 'COLLECTED');
  assert.equal(obs.payload.tempF, 66.7);
});

test('WeatherChannel emits ZERO_CONTEXT when fetchWeather returns null', async () => {
  const ch = new WeatherChannel({ intervalMs: 10, fetchWeather: async () => null });
  const raw = await ch.poll();
  const parsed = ch.parse(raw[0]);
  const obs = ch.verify(parsed);
  assert.equal(obs.flag, 'ZERO_CONTEXT');
  const d = ch.crystallize(obs);
  assert.equal(d.method, 'zero_context_audit');
});

test('WeatherChannel emits UNKNOWN when fetch throws', async () => {
  const ch = new WeatherChannel({ intervalMs: 10, fetchWeather: async () => { throw new Error('net'); } });
  const raw = await ch.poll();
  const parsed = ch.parse(raw[0]);
  const obs = ch.verify(parsed);
  assert.equal(obs.flag, 'UNKNOWN');
  assert.equal(ch.crystallize(obs), null);
});
