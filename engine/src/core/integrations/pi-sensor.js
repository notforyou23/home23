/**
 * Pi (jtrpi/Axiom) Sensor Integration
 * Queries the Pi dashboard API for barometric pressure, temperature, and external data
 */

const PI_BASE_URL = process.env.PI_SENSOR_URL || 'http://192.168.7.136:8765';

/**
 * Fetch current pressure + temp from Pi sensor
 * @returns {Promise<Object>} { pressure_pa, pressure_inhg, temp_c, temp_f, ts }
 */
async function fetchPiSensor() {
  const url = `${PI_BASE_URL}/api/latest`;
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Pi sensor error: ${response.status}`);
  const data = await response.json();
  return data.latest;
}

/**
 * Fetch external data from Pi (sauna status + weather from Ecowitt)
 * @returns {Promise<Object>} { sauna, weather, ts }
 */
async function fetchPiExternal() {
  const url = `${PI_BASE_URL}/api/external`;
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Pi external error: ${response.status}`);
  return response.json();
}

module.exports = {
  fetchPiSensor,
  fetchPiExternal,
  PI_BASE_URL,
};
