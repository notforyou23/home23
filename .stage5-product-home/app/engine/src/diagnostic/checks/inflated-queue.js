'use strict';

/**
 * Inflated Queue Depth
 *
 * Reads the agency state file and the inbox file directly. Compares the
 * reported queueDepth against the actual count of items without decisions.
 *
 * Would have caught: 2,458 "pending" items that were all already processed —
 * the metric was counting inbox file lines, not pending work.
 */

const fs = require('fs');
const path = require('path');

function countNewlines(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    let count = 0;
    const buf = Buffer.alloc(64 * 1024);
    let bytesRead;
    while ((bytesRead = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      for (let i = 0; i < bytesRead; i++) {
        if (buf[i] === 0x0a) count++;
      }
    }
    fs.closeSync(fd);
    return count;
  } catch {
    return 0;
  }
}

async function run(ctx) {
  const agencyStatePath = path.join(ctx.brainDir, 'agency', 'agency-state.json');
  const inboxPath = path.join(ctx.brainDir, 'agency', 'inbox.jsonl');

  if (!fs.existsSync(agencyStatePath)) {
    return { ok: true, findings: [] };
  }

  let agencyState;
  try {
    agencyState = JSON.parse(fs.readFileSync(agencyStatePath, 'utf8'));
  } catch (err) {
    return { ok: false, error: `failed to read agency-state.json: ${err.message}`, findings: [] };
  }

  const reportedQueueDepth = agencyState.queueDepth ?? 0;
  if (reportedQueueDepth === 0) {
    return { ok: true, findings: [] };
  }

  // Count actual inbox lines (cheap byte-scan)
  const actualInboxLines = fs.existsSync(inboxPath) ? countNewlines(inboxPath) : 0;

  // Count items without decisions (requires parsing — sample last 500)
  let pendingCount = 0;
  let parsedCount = 0;
  if (fs.existsSync(inboxPath)) {
    try {
      const stat = fs.statSync(inboxPath);
      const fileSize = stat.size;
      const readSize = Math.min(fileSize, 512 * 1024); // last 512KB
      const fd = fs.openSync(inboxPath, 'r');
      const buf = Buffer.alloc(readSize);
      const bytesRead = fs.readSync(fd, buf, 0, readSize, fileSize - readSize);
      fs.closeSync(fd);
      const text = buf.slice(0, bytesRead).toString('utf8');
      const lines = text.split('\n').filter(l => l.trim());
      for (const line of lines) {
        try {
          const item = JSON.parse(line);
          parsedCount++;
          if (!item.decision || item.decision === 'pending') {
            pendingCount++;
          }
        } catch {}
      }
    } catch {
      // If we can't parse, we can't determine pending count
    }
  }

  const findings = [];

  // Flag if reported queueDepth is significantly higher than actual pending
  // (the metric is lying about how much work is backlogged)
  if (reportedQueueDepth > 100 && pendingCount < reportedQueueDepth * 0.1) {
    findings.push({
      id: 'inflated_queue:queueDepth',
      severity: 'warning',
      code: 'queue_depth_inflated',
      message: `queueDepth reports ${reportedQueueDepth} but only ${pendingCount} of ${parsedCount} sampled items are actually pending`,
      evidence: {
        reportedQueueDepth,
        actualInboxLines,
        sampledPending: pendingCount,
        sampledTotal: parsedCount,
        inflationRatio: reportedQueueDepth > 0 ? +(pendingCount / reportedQueueDepth).toFixed(3) : null,
      },
      autoFixable: false, // requires code fix, not a state fix
    });
  }

  // Flag if queueDepth is counting inbox lines instead of pending items
  if (reportedQueueDepth > 0 && Math.abs(reportedQueueDepth - actualInboxLines) < Math.max(10, reportedQueueDepth * 0.05)) {
    findings.push({
      id: 'inflated_queue:counting_lines_not_items',
      severity: 'warning',
      code: 'queue_depth_counts_file_lines',
      message: `queueDepth (${reportedQueueDepth}) matches inbox file line count (${actualInboxLines}) — likely counting lines, not pending items`,
      evidence: {
        reportedQueueDepth,
        actualInboxLines,
        difference: Math.abs(reportedQueueDepth - actualInboxLines),
      },
      autoFixable: false,
    });
  }

  return { ok: true, findings };
}

module.exports = {
  id: 'inflated_queue',
  label: 'Inflated Queue Depth',
  intervalMs: 10 * 60 * 1000,
  run,
};