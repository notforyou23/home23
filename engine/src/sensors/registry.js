/**
 * Sensor Registry — universal surface for any signal the system observes
 *
 * Principles:
 *   - Plug-and-play: any module (tile, plugin, built-in, third-party) can
 *     publish without the registry knowing about it.
 *   - Zero credentials in registry — credentials live in the publisher's own
 *     config. Registry only holds the normalized snapshot.
 *   - Consumer-agnostic: pulse, dashboard, agent tools all read the same API.
 *   - No historical storage here. This is "latest state." Time-series is a
 *     separate concern (future).
 *
 * Snapshot shape:
 *   {
 *     id:        "system.disk" | "tile.outside-weather" | ...
 *     label:     "Disk" | "Outside" | ...  (human readable)
 *     category:  "system" | "tile" | "plugin"  (for grouping)
 *     value:     string   — "73% free" | "61°F · 45%RH"  (one-line summary)
 *     data:      object   — full structured reading (typed per sensor)
 *     ts:        ISO8601 timestamp of reading
 *     source:    "stock" | "tile:<id>" | "plugin:<name>"
 *     ok:        boolean — false if the last poll failed
 *     error?:    string — present when ok=false
 *   }
 */

const snapshots = new Map(); // sensorId → snapshot
const subscribers = new Set(); // optional — future use for push updates

function publish(snapshot) {
  if (!snapshot || !snapshot.id) return;
  const existing = snapshots.get(snapshot.id);
  const merged = {
    ts: new Date().toISOString(),
    ok: true,
    ...existing,
    ...snapshot,
  };
  snapshots.set(snapshot.id, merged);
  for (const fn of subscribers) {
    try { fn(merged); } catch { /* ok */ }
  }
  return merged;
}

function get(id) {
  return snapshots.get(id) || null;
}

function list({ category, olderThanMs } = {}) {
  const now = Date.now();
  const out = [];
  for (const snap of snapshots.values()) {
    if (category && snap.category !== category) continue;
    if (olderThanMs && snap.ts && (now - Date.parse(snap.ts)) > olderThanMs) continue;
    out.push(snap);
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

function remove(id) {
  snapshots.delete(id);
}

function subscribe(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

function stats() {
  return {
    count: snapshots.size,
    categories: [...new Set([...snapshots.values()].map(s => s.category))],
    sources: [...new Set([...snapshots.values()].map(s => s.source))],
  };
}

module.exports = { publish, get, list, remove, subscribe, stats };
