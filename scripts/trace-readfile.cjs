// Temporary diagnostic shim for the harness CPU leak hunt.
// Wraps fs.readFileSync to count calls per path and emit a snapshot every 15s.
// Loaded via NODE_OPTIONS=--require=...trace-readfile.cjs.
// Remove after diagnosis.

const fs = require('node:fs');
const orig = fs.readFileSync;
const counts = new Map(); // path -> { calls, bytes, biggest }

fs.readFileSync = function(path, options) {
  const result = orig.apply(this, arguments);
  try {
    const p = typeof path === 'string' ? path : (path && path.toString ? path.toString() : '?');
    const sz = typeof result === 'string' ? Buffer.byteLength(result) : (result && result.length) || 0;
    let c = counts.get(p);
    if (!c) { c = { calls: 0, bytes: 0, biggest: 0 }; counts.set(p, c); }
    c.calls++;
    c.bytes += sz;
    if (sz > c.biggest) c.biggest = sz;
  } catch {}
  return result;
};

setInterval(() => {
  const rows = [...counts.entries()].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 12);
  let out = '\n[trace-readfile] top 12 by total bytes (cumulative since boot):\n';
  for (const [p, c] of rows) {
    out += `  calls=${String(c.calls).padStart(6)} bytes=${(c.bytes/1024/1024).toFixed(1).padStart(7)}MB biggest=${(c.biggest/1024).toFixed(0).padStart(6)}KB  ${p}\n`;
  }
  process.stderr.write(out);
}, 15000).unref();
