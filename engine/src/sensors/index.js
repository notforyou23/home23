/**
 * Sensors — boot entrypoint
 *
 * Registers stock sensors (ship enabled, zero config, work on any install)
 * and starts their individual poll loops. Publishers push into the registry
 * which any consumer can read.
 *
 * Tile-backed sensors publish themselves from home23-tiles.js after each
 * successful tile fetch, so they don't poll here.
 *
 * Third-party plugins (future) will live under engine/src/sensors/plugins/
 * and be auto-loaded here.
 */

const registry = require('./registry');

const STOCK_MODULES = [
  require('./stock/disk'),
  require('./stock/memory'),
  require('./stock/cpu'),
  require('./stock/process'),
];

const timers = new Map();

async function startStock(logger) {
  for (const sensor of STOCK_MODULES) {
    const run = async () => {
      try {
        const result = await Promise.resolve(sensor.poll());
        if (result) {
          registry.publish({
            id: sensor.id,
            label: sensor.label,
            category: sensor.category,
            source: 'stock',
            value: result.value,
            data: result.data,
            ok: result.ok !== false,
            error: result.ok === false ? result.error : undefined,
          });
        }
      } catch (err) {
        logger?.warn?.(`[sensors] ${sensor.id} poll failed`, { error: err.message });
        registry.publish({
          id: sensor.id,
          label: sensor.label,
          category: sensor.category,
          source: 'stock',
          ok: false,
          error: err.message,
        });
      }
    };
    // First run immediately
    await run();
    // Then on the sensor's own interval
    const interval = sensor.intervalMs || 30 * 1000;
    const timer = setInterval(run, interval);
    timers.set(sensor.id, timer);
  }
  logger?.info?.('[sensors] stock sensors registered', {
    count: STOCK_MODULES.length,
    ids: STOCK_MODULES.map(s => s.id),
  });
}

function stopAll() {
  for (const timer of timers.values()) clearInterval(timer);
  timers.clear();
}

module.exports = {
  registry,
  startStock,
  stopAll,
};
