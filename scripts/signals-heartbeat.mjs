#!/usr/bin/env node

const url = process.env.HOME23_SIGNALS_URL || 'http://localhost:5002/api/signals';

const payload = {
  type: 'action_success',
  source: 'signals-heartbeat',
  title: 'signals.jsonl freshness heartbeat',
  message: 'Positive-signal stream heartbeat: dashboard signal channel is writable and fresh.',
  evidence: {
    verifier: 'notification_jsonl_recent_match_channel_ok',
    purpose: 'Keep the positive-signal stream fresh enough for jsonl_recent_match monitoring without requiring incidental resolved-problem churn.',
  },
};

const res = await fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(payload),
});

const text = await res.text();
if (!res.ok) {
  throw new Error(`signals heartbeat failed: HTTP ${res.status} ${text}`);
}

let body;
try {
  body = JSON.parse(text);
} catch {
  body = { raw: text };
}

if (!body.ok || !body.signal?.ts) {
  throw new Error(`signals heartbeat returned unexpected body: ${text}`);
}

console.log(`signals heartbeat emitted ${body.signal.id} at ${body.signal.ts}`);
