/**
 * Action: refresh_sensor
 * Force-polls a Home23-owned sensor source. No external side effects beyond
 * refreshing cached data for UI + CHAOS overlays.
 */

async function run({ target, sensors, logger }) {
  if (!sensors) {
    return { status: 'rejected', detail: 'sensors module not provided to dispatcher' };
  }

  try {
    if (target === 'weather' && typeof sensors.pollWeather === 'function') {
      await sensors.pollWeather();
      return { status: 'success', detail: 'weather refreshed', memoryDelta: { refreshed: ['weather'] } };
    }
    if (target === 'sauna' && typeof sensors.pollSauna === 'function') {
      await sensors.pollSauna();
      return { status: 'success', detail: 'sauna refreshed', memoryDelta: { refreshed: ['sauna'] } };
    }
    if (target === 'pressure' && typeof sensors.pollPressure === 'function') {
      await sensors.pollPressure();
      return { status: 'success', detail: 'pressure refreshed', memoryDelta: { refreshed: ['pressure'] } };
    }
    return { status: 'rejected', detail: `unknown sensor target '${target}'` };
  } catch (err) {
    return { status: 'rejected', detail: `poll failed: ${err.message}` };
  }
}

module.exports = { run };
