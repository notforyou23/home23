// sensors.js — Weather + Sauna sensor poller for COSMO Home
// Polls Ecowitt (weather) every 5 min, Huum (sauna) every 2 min
// Writes to data/sensor-cache.json for consumption by image-provider + brain
'use strict';

const fs   = require('fs');
const path = require('path');
const { fetchWeatherData } = require('./integrations/weather');
const { fetchSaunaStatus, toggleSauna } = require('./integrations/sauna');

const CACHE_PATH = path.join(__dirname, '..', '..', 'data', 'sensor-cache.json');
const WEATHER_INTERVAL_MS = 5 * 60 * 1000;  // 5 min
const SAUNA_INTERVAL_MS   = 2 * 60 * 1000;  // 2 min

const weatherConfig = {
  application_key: process.env.ECOWITT_APPLICATION_KEY,
  api_key:         process.env.ECOWITT_API_KEY,
  mac:             process.env.ECOWITT_MAC,
};

const saunaConfig = {
  api_url:  process.env.HUUM_API_URL,
  username: process.env.HUUM_USERNAME,
  password: process.env.HUUM_PASSWORD,
};

// In-memory cache (also persisted to disk)
let cache = {
  weather: null,
  sauna:   null,
  updatedAt: null,
};

// Load cache from disk on startup
function loadCache() {
  try {
    if (fs.existsSync(CACHE_PATH)) {
      cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    }
  } catch {}
}

function saveCache() {
  try {
    fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
  } catch (e) {
    console.warn('[SENSORS] Cache write failed:', e.message);
  }
}

async function pollWeather() {
  if (!weatherConfig.application_key) return;
  try {
    const data = await fetchWeatherData(weatherConfig);
    cache.weather = data;
    cache.updatedAt = new Date().toISOString();
    saveCache();
    const temp = data.outdoor?.temperature;
    const humidity = data.outdoor?.humidity;
    console.log(`[SENSORS] Weather: ${temp}°F, ${humidity}% humidity`);
  } catch (e) {
    console.warn('[SENSORS] Weather poll failed:', e.message);
  }
}

async function pollSauna() {
  if (!saunaConfig.api_url) return;
  try {
    const data = await fetchSaunaStatus(saunaConfig);
    cache.sauna = data;
    cache.updatedAt = new Date().toISOString();
    saveCache();
    console.log(`[SENSORS] Sauna: ${data.status} @ ${data.temperature}°F`);
  } catch (e) {
    console.warn('[SENSORS] Sauna poll failed:', e.message);
  }
}

/**
 * Get current sensor context as a human-readable string for CHAOS MODE overlays
 * Returns null if no data available
 */
function getSensorContext() {
  const parts = [];

  if (cache.weather?.outdoor?.temperature != null) {
    const temp = Math.round(cache.weather.outdoor.temperature);
    const humidity = Math.round(cache.weather.outdoor.humidity || 0);
    const wind = Math.round(cache.weather.wind?.speed || 0);
    const uv = cache.weather.solar?.uv != null ? Math.round(cache.weather.solar.uv) : null;

    let weatherDesc = `${temp}°F outdoors`;
    if (humidity > 80) weatherDesc += ', humid';
    else if (humidity < 30) weatherDesc += ', dry';
    if (wind > 15) weatherDesc += `, windy (${wind}mph)`;
    if (uv != null && uv >= 6) weatherDesc += `, UV ${uv}`;
    parts.push(weatherDesc);
  }

  if (cache.sauna) {
    const s = cache.sauna;
    if (s.isHeating) {
      parts.push(`sauna heating to ${s.targetTemperature}°F (currently ${s.temperature}°F)`);
    } else if (s.isLocked) {
      parts.push(`sauna in use at ${s.temperature}°F`);
    } else if (s.temperature > 150) {
      parts.push(`sauna warm at ${s.temperature}°F, cooling down`);
    } else if (s.isOffline) {
      parts.push('sauna offline');
    }
  }

  return parts.length ? parts.join('; ') : null;
}

/**
 * Get structured sensor data for external consumers
 */
function getSensorData() {
  return { ...cache };
}

/**
 * Toggle sauna on/off (pass-through)
 */
async function controlSauna(turnOn, targetTempF = 190, durationMin = 180) {
  return toggleSauna(saunaConfig, turnOn, targetTempF, durationMin);
}

/**
 * Start polling. Call once from dashboard server or standalone.
 */
function startPolling() {
  loadCache();
  // Immediate first polls
  pollWeather();
  pollSauna();
  // Recurring
  setInterval(pollWeather, WEATHER_INTERVAL_MS);
  setInterval(pollSauna,   SAUNA_INTERVAL_MS);
  console.log('[SENSORS] Polling started (weather: 5min, sauna: 2min)');
}

module.exports = { startPolling, getSensorContext, getSensorData, controlSauna };
