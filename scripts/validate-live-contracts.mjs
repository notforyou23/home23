import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createContractValidator } = require('../tests/contracts/contract-validator.cjs');

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function baseUrlFor(entry, options) {
  if (entry.base === 'bridge') return options.bridgeBaseUrl;
  return options.dashboardBaseUrl;
}

function formatFailureBody(body) {
  if (typeof body === 'string') return body.slice(0, 240);
  try {
    return JSON.stringify(body).slice(0, 240);
  } catch {
    return String(body).slice(0, 240);
  }
}

function shouldValidateLive(entry, options) {
  if (entry.liveValidation === 'safe') return true;
  if (entry.liveValidation === 'expected-missing') return options.strict;
  return false;
}

function skipReasonFor(entry, options = {}) {
  if (entry.liveValidation === 'requires-action') {
    return options.allowActions
      ? 'requires-action; no bounded action probe is registered for this entry yet'
      : 'requires-action; run with HOME23_LIVE_CONTRACTS_ACTIONS=1 for registered bounded action probes';
  }
  if (entry.liveValidation === 'requires-stream') {
    return 'requires-stream; bounded SSE probes are not implemented in this validator yet';
  }
  if (entry.liveValidation === 'capability-disabled') {
    return 'capability-disabled; route is validated only as an explicit disabled-capability probe';
  }
  return entry.liveValidation || 'disabled';
}

async function fetchJson(url, headers) {
  const response = await fetch(url, { headers });
  const contentType = response.headers.get('content-type') || '';
  const body = contentType.includes('application/json')
    ? await response.json()
    : await response.text();
  return { response, body };
}

async function requestJson(url, { method = 'GET', headers = {}, body } = {}) {
  const response = await fetch(url, {
    method,
    headers: body
      ? { ...headers, 'content-type': 'application/json' }
      : headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const contentType = response.headers.get('content-type') || '';
  const parsed = contentType.includes('application/json')
    ? await response.json()
    : await response.text();
  return { response, body: parsed };
}

function openSseCollector(url, { headers = {}, timeoutMs = 5000 } = {}) {
  const controller = new AbortController();
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const done = (async () => {
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const records = [];
    let buffer = '';
    try {
      const response = await fetch(url, { headers, signal: controller.signal });
      if (!response.ok) throw new Error(`SSE HTTP ${response.status}: ${await response.text().catch(() => '')}`);
      if (!response.body) throw new Error('SSE response missing body');
      readyResolve();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { value, done: readerDone } = await reader.read();
        if (readerDone) break;
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split('\n\n');
        buffer = chunks.pop() || '';
        for (const chunk of chunks) {
          const dataLines = chunk
            .split('\n')
            .filter((line) => line.startsWith('data: '))
            .map((line) => line.slice(6));
          if (dataLines.length === 0) continue;
          const data = dataLines.join('\n');
          if (data === '[DONE]') return records;
          records.push(JSON.parse(data));
        }
      }
      return records;
    } catch (error) {
      readyReject(error);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  })();
  return {
    ready,
    done,
    abort: () => controller.abort(),
  };
}

function manifestEntry(manifest, id) {
  const entry = manifest.entries.find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`manifest entry not found: ${id}`);
  return entry;
}

function validateActionValue({ validator, failures, checked, entry, value, route }) {
  const result = validator.validateValue(entry, value);
  if (!result.valid) {
    failures.push({
      id: entry.id,
      method: entry.method,
      route: route || entry.route,
      schema: entry.schema,
      definition: entry.definition,
      error: result.errorsText,
    });
    return false;
  }
  checked.push({ id: entry.id, route: route || entry.route, mode: 'action-probe' });
  return true;
}

async function runChatActionProbe({ manifest, validator, bridgeBaseUrl, bridgeToken, failures, checked }) {
  const headers = {};
  if (bridgeToken) headers.authorization = `Bearer ${bridgeToken}`;
  const chatId = `ios_contract_probe_${Date.now()}`;
  const startEntry = manifestEntry(manifest, 'chat-turn-start');
  const streamEnvelopeEntry = manifestEntry(manifest, 'chat-turn-envelope-complete');
  const statusEntry = manifestEntry(manifest, 'chat-turn-status');
  const pendingEntry = manifestEntry(manifest, 'chat-pending');
  const stopRequestEntry = manifestEntry(manifest, 'chat-stop-turn-request');
  const stopResponseEntry = manifestEntry(manifest, 'chat-stop-turn-response');
  const stopErrorEntry = manifestEntry(manifest, 'chat-stop-turn-error-response');
  const startUrl = new URL(startEntry.route, bridgeBaseUrl);

  let turnId = null;
  try {
    const start = await requestJson(startUrl, {
      method: 'POST',
      headers,
      body: {
        chatId,
        message: 'Contract validation probe. If this reaches a model, reply with ok.',
      },
    });
    if (!start.response.ok || typeof start.body === 'string') {
      failures.push({
        id: startEntry.id,
        method: startEntry.method,
        route: startEntry.route,
        schema: startEntry.schema,
        definition: startEntry.definition,
        status: start.response.status,
        error: formatFailureBody(start.body),
      });
      return;
    }
    if (!validateActionValue({ validator, failures, checked, entry: startEntry, value: start.body })) return;
    turnId = start.body.turn_id;

    const streamUrl = new URL('/api/chat/stream', bridgeBaseUrl);
    streamUrl.searchParams.set('chatId', chatId);
    streamUrl.searchParams.set('turn_id', turnId);
    streamUrl.searchParams.set('cursor', '-1');
    const stream = openSseCollector(streamUrl, { headers });
    await stream.ready;

    const statusUrl = new URL(statusEntry.route, bridgeBaseUrl);
    statusUrl.searchParams.set('chatId', chatId);
    statusUrl.searchParams.set('turn_id', turnId);
    const firstStatus = await requestJson(statusUrl, { headers });
    if (!firstStatus.response.ok || typeof firstStatus.body === 'string') {
      failures.push({
        id: statusEntry.id,
        method: statusEntry.method,
        route: statusEntry.route,
        schema: statusEntry.schema,
        definition: statusEntry.definition,
        status: firstStatus.response.status,
        error: formatFailureBody(firstStatus.body),
      });
    } else {
      validateActionValue({ validator, failures, checked, entry: statusEntry, value: firstStatus.body, route: statusUrl.pathname });
    }

    const wrongStopPayload = { chatId, turn_id: `${turnId}_wrong` };
    validateActionValue({ validator, failures, checked, entry: stopRequestEntry, value: wrongStopPayload, route: stopRequestEntry.route });
    const wrongStop = await requestJson(new URL('/api/chat/stop-turn', bridgeBaseUrl), {
      method: 'POST',
      headers,
      body: wrongStopPayload,
    });
    if (wrongStop.response.status !== 404 || typeof wrongStop.body === 'string') {
      failures.push({
        id: stopErrorEntry.id,
        method: stopErrorEntry.method,
        route: stopErrorEntry.route,
        schema: stopErrorEntry.schema,
        definition: stopErrorEntry.definition,
        status: wrongStop.response.status,
        error: `expected 404 wrong-turn rejection, got ${formatFailureBody(wrongStop.body)}`,
      });
    } else {
      validateActionValue({ validator, failures, checked, entry: stopErrorEntry, value: wrongStop.body, route: stopErrorEntry.route });
      const statusAfterWrongStop = await requestJson(statusUrl, { headers });
      if (!statusAfterWrongStop.response.ok || typeof statusAfterWrongStop.body === 'string') {
        failures.push({
          id: statusEntry.id,
          method: statusEntry.method,
          route: statusEntry.route,
          schema: statusEntry.schema,
          definition: statusEntry.definition,
          status: statusAfterWrongStop.response.status,
          error: formatFailureBody(statusAfterWrongStop.body),
        });
      } else if (validateActionValue({ validator, failures, checked, entry: statusEntry, value: statusAfterWrongStop.body, route: statusUrl.pathname })) {
        if (statusAfterWrongStop.body.status === 'stopped') {
          failures.push({
            id: stopErrorEntry.id,
            method: stopErrorEntry.method,
            route: stopErrorEntry.route,
            schema: stopErrorEntry.schema,
            definition: stopErrorEntry.definition,
            error: `wrong-turn stop stopped the active probe: ${formatFailureBody(statusAfterWrongStop.body)}`,
          });
        }
      }
    }

    const stopUrl = new URL('/api/chat/stop-turn', bridgeBaseUrl);
    const stopPayload = { chatId, turn_id: turnId };
    validateActionValue({ validator, failures, checked, entry: stopRequestEntry, value: stopPayload, route: stopRequestEntry.route });
    const stop = await requestJson(stopUrl, {
      method: 'POST',
      headers,
      body: stopPayload,
    });
    if (!stop.response.ok || typeof stop.body === 'string') {
      failures.push({
        id: stopResponseEntry.id,
        method: 'POST',
        route: '/api/chat/stop-turn',
        schema: stopResponseEntry.schema,
        definition: stopResponseEntry.definition,
        status: stop.response.status,
        error: formatFailureBody(stop.body),
      });
      return;
    }
    if (validateActionValue({ validator, failures, checked, entry: stopResponseEntry, value: stop.body, route: stopResponseEntry.route })) {
      if (stop.body.turn_id !== turnId) {
        failures.push({
          id: stopResponseEntry.id,
          method: stopResponseEntry.method,
          route: stopResponseEntry.route,
          schema: stopResponseEntry.schema,
          definition: stopResponseEntry.definition,
          error: `stop-turn response did not echo turn_id ${turnId}: ${formatFailureBody(stop.body)}`,
        });
      }
    }

    const streamRecords = await stream.done;
    const terminalEnvelope = streamRecords.find((record) => record?.type === 'turn' && record?.status !== 'pending');
    if (!terminalEnvelope) {
      failures.push({
        id: streamEnvelopeEntry.id,
        method: 'GET',
        route: '/api/chat/stream',
        schema: streamEnvelopeEntry.schema,
        definition: streamEnvelopeEntry.definition,
        error: `SSE probe did not receive terminal envelope for ${turnId}`,
      });
    } else {
      validateActionValue({
        validator,
        failures,
        checked,
        entry: streamEnvelopeEntry,
        value: terminalEnvelope,
        route: '/api/chat/stream',
      });
    }

    const finalStatus = await requestJson(statusUrl, { headers });
    if (!finalStatus.response.ok || typeof finalStatus.body === 'string') {
      failures.push({
        id: statusEntry.id,
        method: statusEntry.method,
        route: statusEntry.route,
        schema: statusEntry.schema,
        definition: statusEntry.definition,
        status: finalStatus.response.status,
        error: formatFailureBody(finalStatus.body),
      });
    } else if (validateActionValue({ validator, failures, checked, entry: statusEntry, value: finalStatus.body, route: statusUrl.pathname })) {
      if (!['stopped', 'complete', 'error'].includes(finalStatus.body.status)) {
        failures.push({
          id: statusEntry.id,
          method: statusEntry.method,
          route: statusEntry.route,
          schema: statusEntry.schema,
          definition: statusEntry.definition,
          error: `expected terminal status after stop, got ${finalStatus.body.status}`,
        });
      }
    }

    const pendingUrl = new URL(pendingEntry.liveRoute || pendingEntry.route, bridgeBaseUrl);
    pendingUrl.searchParams.set('chatId', chatId);
    const pending = await requestJson(pendingUrl, { headers });
    if (!pending.response.ok || typeof pending.body === 'string') {
      failures.push({
        id: pendingEntry.id,
        method: pendingEntry.method,
        route: pendingEntry.route,
        schema: pendingEntry.schema,
        definition: pendingEntry.definition,
        status: pending.response.status,
        error: formatFailureBody(pending.body),
      });
    } else if (validateActionValue({ validator, failures, checked, entry: pendingEntry, value: pending.body, route: pendingUrl.pathname })) {
      const stillPending = Array.isArray(pending.body.pending)
        ? pending.body.pending.some((turn) => turn?.turn_id === turnId)
        : false;
      if (stillPending) {
        failures.push({
          id: pendingEntry.id,
          method: pendingEntry.method,
          route: pendingEntry.route,
          schema: pendingEntry.schema,
          definition: pendingEntry.definition,
          error: `stopped probe turn still pending: ${turnId}`,
        });
      }
    }
  } catch (error) {
    failures.push({
      id: 'chat-action-probe',
      method: 'POST',
      route: '/api/chat/turn',
      schema: 'schemas/chat.schema.json',
      definition: 'startTurnResponse',
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function runDeviceRegistrationProbe({ manifest, validator, bridgeBaseUrl, bridgeToken, failures, checked }) {
  const headers = {};
  if (bridgeToken) headers.authorization = `Bearer ${bridgeToken}`;
  const requestEntry = manifestEntry(manifest, 'device-register-request');
  const responseEntry = manifestEntry(manifest, 'device-register-response');
  const unregisterRequestEntry = manifestEntry(manifest, 'device-unregister-request');
  const unregisterResponseEntry = manifestEntry(manifest, 'device-unregister-response');
  const registryEntry = manifestEntry(manifest, 'device-registry');
  const registerUrl = new URL(requestEntry.route, bridgeBaseUrl);
  const registryUrl = new URL(registryEntry.route, bridgeBaseUrl);
  const stamp = Date.now().toString(16).padStart(16, '0').slice(-16);
  const deviceToken = `${stamp}${'a'.repeat(48)}`;
  const bundleId = 'com.regina6.home23.contract-probe';
  const chatId = `ios_contract_probe_${Date.now()}`;
  const cleanupChatId = `${chatId}_cleanup`;
  const payload = {
    device_token: deviceToken,
    agent_id: 'jerry',
    chat_ids: [chatId, cleanupChatId],
    bundle_id: bundleId,
    env: 'sandbox',
    platform: 'ios',
    app_build: 'contract-probe',
    contract_version: '2026.06.26',
    capabilities_hash: 'sha256:live-contract-probe',
  };

  let registered = false;
  try {
    if (!validateActionValue({ validator, failures, checked, entry: requestEntry, value: payload })) return;

    const result = await requestJson(registerUrl, {
      method: 'POST',
      headers,
      body: payload,
    });
    if (!result.response.ok || typeof result.body === 'string') {
      failures.push({
        id: responseEntry.id,
        method: responseEntry.method,
        route: responseEntry.route,
        schema: responseEntry.schema,
        definition: responseEntry.definition,
        status: result.response.status,
        error: formatFailureBody(result.body),
      });
      return;
    }
    registered = true;
    if (validateActionValue({ validator, failures, checked, entry: responseEntry, value: result.body })) {
      if (result.body.agent_id !== 'jerry' || !Array.isArray(result.body.registered_chat_ids) || !result.body.registered_chat_ids.includes(chatId)) {
        failures.push({
          id: responseEntry.id,
          method: responseEntry.method,
          route: responseEntry.route,
          schema: responseEntry.schema,
          definition: responseEntry.definition,
          error: `unexpected device registration receipt: ${formatFailureBody(result.body)}`,
        });
      }
    }

    const registry = await requestJson(registryUrl, { headers });
    if (!registry.response.ok || typeof registry.body === 'string') {
      failures.push({
        id: registryEntry.id,
        method: registryEntry.method,
        route: registryEntry.route,
        schema: registryEntry.schema,
        definition: registryEntry.definition,
        status: registry.response.status,
        error: formatFailureBody(registry.body),
      });
    } else if (validateActionValue({ validator, failures, checked, entry: registryEntry, value: registry.body, route: registryEntry.route })) {
      const match = Array.isArray(registry.body.devices)
        ? registry.body.devices.find((device) => device.device_token === deviceToken && device.bundle_id === bundleId)
        : null;
      if (!match || !Array.isArray(match.chat_ids) || !match.chat_ids.includes(chatId)) {
        failures.push({
          id: registryEntry.id,
          method: registryEntry.method,
          route: registryEntry.route,
          schema: registryEntry.schema,
          definition: registryEntry.definition,
          error: `device registry did not include synthetic registration: ${formatFailureBody(registry.body)}`,
        });
      }
    }

    const unregisterPayload = {
      device_token: deviceToken,
      bundle_id: bundleId,
      chat_ids: [chatId],
    };
    validateActionValue({ validator, failures, checked, entry: unregisterRequestEntry, value: unregisterPayload });
    const unregisterResult = await requestJson(registerUrl, {
      method: 'DELETE',
      headers,
      body: unregisterPayload,
    });
    if (!unregisterResult.response.ok || typeof unregisterResult.body === 'string') {
      failures.push({
        id: unregisterResponseEntry.id,
        method: unregisterResponseEntry.method,
        route: unregisterResponseEntry.route,
        schema: unregisterResponseEntry.schema,
        definition: unregisterResponseEntry.definition,
        status: unregisterResult.response.status,
        error: formatFailureBody(unregisterResult.body),
      });
      return;
    }
    if (validateActionValue({ validator, failures, checked, entry: unregisterResponseEntry, value: unregisterResult.body })) {
      const removed = unregisterResult.body.removed_chat_ids || [];
      const remaining = unregisterResult.body.remaining_chat_ids || [];
      if (unregisterResult.body.unregistered !== false || !removed.includes(chatId) || !remaining.includes(cleanupChatId)) {
        failures.push({
          id: unregisterResponseEntry.id,
          method: unregisterResponseEntry.method,
          route: unregisterResponseEntry.route,
          schema: unregisterResponseEntry.schema,
          definition: unregisterResponseEntry.definition,
          error: `unexpected device unregister receipt: ${formatFailureBody(unregisterResult.body)}`,
        });
      }
    }
  } catch (error) {
    failures.push({
      id: 'device-register-action-probe',
      method: 'POST',
      route: requestEntry.route,
      schema: responseEntry.schema,
      definition: responseEntry.definition,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    if (registered) {
      const cleanup = await requestJson(registerUrl, {
        method: 'DELETE',
        headers,
        body: { device_token: deviceToken, bundle_id: bundleId },
      }).catch((error) => ({
        response: { ok: false, status: 'cleanup-error' },
        body: error instanceof Error ? error.message : String(error),
      }));
      if (!cleanup.response.ok || typeof cleanup.body === 'string' || cleanup.body.unregistered !== true) {
        failures.push({
          id: 'device-register-cleanup',
          method: 'DELETE',
          route: requestEntry.route,
          schema: unregisterResponseEntry.schema,
          definition: unregisterResponseEntry.definition,
          status: cleanup.response.status,
          error: formatFailureBody(cleanup.body),
        });
      } else {
        validateActionValue({ validator, failures, checked, entry: unregisterResponseEntry, value: cleanup.body });
      }
      const registryAfterCleanup = await requestJson(registryUrl, { headers }).catch((error) => ({
        response: { ok: false, status: 'cleanup-registry-error' },
        body: error instanceof Error ? error.message : String(error),
      }));
      if (!registryAfterCleanup.response.ok || typeof registryAfterCleanup.body === 'string') {
        failures.push({
          id: registryEntry.id,
          method: registryEntry.method,
          route: registryEntry.route,
          schema: registryEntry.schema,
          definition: registryEntry.definition,
          status: registryAfterCleanup.response.status,
          error: formatFailureBody(registryAfterCleanup.body),
        });
      } else if (validateActionValue({ validator, failures, checked, entry: registryEntry, value: registryAfterCleanup.body, route: registryEntry.route })) {
        const stillRegistered = Array.isArray(registryAfterCleanup.body.devices)
          ? registryAfterCleanup.body.devices.some((device) => device.device_token === deviceToken && device.bundle_id === bundleId)
          : false;
        if (stillRegistered) {
          failures.push({
            id: registryEntry.id,
            method: registryEntry.method,
            route: registryEntry.route,
            schema: registryEntry.schema,
            definition: registryEntry.definition,
            error: `device registry still contains synthetic device after cleanup: ${deviceToken}`,
          });
        }
      }
    }
  }
}

async function runQueryFacadeProbe({ manifest, validator, dashboardBaseUrl, failures, checked }) {
  const runEntry = manifestEntry(manifest, 'query-result');
  const exportEntry = manifestEntry(manifest, 'query-export');
  const streamEntry = manifestEntry(manifest, 'query-stream-event');
  const basePayload = {
    agent: 'jerry',
    query: 'Home23 live contract validation dry run',
    model: 'gpt-5.5',
    mode: 'quick',
    includeEvidenceMetrics: false,
    enableSynthesis: false,
    includeCoordinatorInsights: false,
    includeOutputs: false,
    includeThoughts: false,
    allowActions: false,
    enablePGS: false,
    pgsMode: 'full',
    pgsSessionId: '',
    pgsFullSweep: false,
    exportFormat: 'markdown',
    dryRun: true,
  };

  try {
    const runUrl = new URL(runEntry.route, dashboardBaseUrl);
    runUrl.searchParams.set('agent', 'jerry');
    const run = await requestJson(runUrl, { method: 'POST', body: basePayload });
    if (!run.response.ok || typeof run.body === 'string') {
      failures.push({
        id: runEntry.id,
        method: runEntry.method,
        route: runEntry.route,
        schema: runEntry.schema,
        definition: runEntry.definition,
        status: run.response.status,
        error: formatFailureBody(run.body),
      });
    } else if (validateActionValue({ validator, failures, checked, entry: runEntry, value: run.body, route: runEntry.route })) {
      if (run.body.dryRun !== true || run.body?.result?.metadata?.dryRun !== true) {
        failures.push({
          id: runEntry.id,
          method: runEntry.method,
          route: runEntry.route,
          schema: runEntry.schema,
          definition: runEntry.definition,
          error: `query run dry-run receipt was not explicit: ${formatFailureBody(run.body)}`,
        });
      }
    }

    const exportUrl = new URL(exportEntry.route, dashboardBaseUrl);
    exportUrl.searchParams.set('agent', 'jerry');
    const exported = await requestJson(exportUrl, {
      method: 'POST',
      body: {
        query: basePayload.query,
        answer: 'Dry-run answer for export contract validation.',
        format: 'markdown',
        metadata: { model: basePayload.model, mode: basePayload.mode },
        validateOnly: true,
      },
    });
    if (!exported.response.ok || typeof exported.body === 'string') {
      failures.push({
        id: exportEntry.id,
        method: exportEntry.method,
        route: exportEntry.route,
        schema: exportEntry.schema,
        definition: exportEntry.definition,
        status: exported.response.status,
        error: formatFailureBody(exported.body),
      });
    } else if (validateActionValue({ validator, failures, checked, entry: exportEntry, value: exported.body, route: exportEntry.route })) {
      if (exported.body.dryRun !== true || exported.body.success !== true) {
        failures.push({
          id: exportEntry.id,
          method: exportEntry.method,
          route: exportEntry.route,
          schema: exportEntry.schema,
          definition: exportEntry.definition,
          error: `query export dry-run receipt was not explicit: ${formatFailureBody(exported.body)}`,
        });
      }
    }

    const streamUrl = new URL(streamEntry.route, dashboardBaseUrl);
    const stream = openSseCollector(streamUrl, { timeoutMs: 5000 });
    await stream.ready;
    const records = await stream.done;
    const event = records.find((record) => record && typeof record === 'object');
    if (!event) {
      failures.push({
        id: streamEntry.id,
        method: streamEntry.method,
        route: streamEntry.route,
        schema: streamEntry.schema,
        definition: streamEntry.definition,
        error: 'query stream probe did not receive an SSE event',
      });
    } else {
      validateActionValue({ validator, failures, checked, entry: streamEntry, value: event, route: streamEntry.route });
    }
  } catch (error) {
    failures.push({
      id: 'query-facade-action-probe',
      method: 'POST',
      route: '/home23/api/query/run',
      schema: runEntry.schema,
      definition: runEntry.definition,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function runTileActionProbe({ manifest, validator, dashboardBaseUrl, failures, checked }) {
  const entry = manifestEntry(manifest, 'home-tile-action');
  const dryRunEnvelopeEntry = manifestEntry(manifest, 'home-tile-action-dry-run-response');
  const route = '/home23/api/tiles/sauna-control/actions/start';
  const url = new URL(route, dashboardBaseUrl);
  url.searchParams.set('dryRun', '1');

  try {
    const result = await requestJson(url, {
      method: 'POST',
      body: {
        dryRun: true,
        targetTemperature: 190,
        duration: 15,
      },
    });
    if (!result.response.ok || typeof result.body === 'string') {
      failures.push({
        id: entry.id,
        method: entry.method,
        route,
        schema: entry.schema,
        definition: entry.definition,
        status: result.response.status,
        error: formatFailureBody(result.body),
      });
      return;
    }
    if (result.body.dryRun !== true || !result.body.action) {
      failures.push({
        id: dryRunEnvelopeEntry.id,
        method: dryRunEnvelopeEntry.method,
        route,
        schema: dryRunEnvelopeEntry.schema,
        definition: dryRunEnvelopeEntry.definition,
        error: `tile dry-run receipt missing action contract: ${formatFailureBody(result.body)}`,
      });
      return;
    }
    validateActionValue({ validator, failures, checked, entry: dryRunEnvelopeEntry, value: result.body, route });
    validateActionValue({ validator, failures, checked, entry, value: result.body.action, route });
  } catch (error) {
    failures.push({
      id: 'tile-action-probe',
      method: 'POST',
      route,
      schema: entry.schema,
      definition: entry.definition,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function validateLiveContracts({
  rootDir = process.cwd(),
  dashboardBaseUrl = process.env.HOME23_DASHBOARD_URL || 'http://localhost:5002',
  bridgeBaseUrl = process.env.HOME23_BRIDGE_URL || 'http://localhost:5004',
  bridgeToken = process.env.HOME23_BRIDGE_TOKEN || '',
  allowActions = process.env.HOME23_LIVE_CONTRACTS_ACTIONS === '1',
  strict = true,
} = {}) {
  const manifest = loadJson(path.join(rootDir, 'contracts', 'manifest.json'));
  const validator = createContractValidator(rootDir);
  const failures = [];
  const checked = [];
  const skipped = [];

  for (const entry of manifest.entries) {
    if (!shouldValidateLive(entry, { strict, allowActions })) {
      skipped.push({ id: entry.id, reason: skipReasonFor(entry, { allowActions }) });
      continue;
    }
    if (entry.method !== 'GET') {
      skipped.push({ id: entry.id, reason: `method ${entry.method} is not read-only` });
      continue;
    }

    const headers = {};
    if (entry.auth !== 'none' && bridgeToken) headers.authorization = `Bearer ${bridgeToken}`;
    const url = new URL(entry.liveRoute || entry.route, baseUrlFor(entry, { dashboardBaseUrl, bridgeBaseUrl }));

    try {
      const { response, body } = await fetchJson(url, headers);
      if (!response.ok) {
        failures.push({
          id: entry.id,
          method: entry.method,
          route: entry.route,
          schema: entry.schema,
          definition: entry.definition,
          status: response.status,
          error: formatFailureBody(body),
        });
        continue;
      }
      if (typeof body === 'string') {
        failures.push({ id: entry.id, method: entry.method, route: entry.route, schema: entry.schema, definition: entry.definition, error: 'response was not JSON' });
        continue;
      }
      const result = validator.validateValue(entry, body);
      if (!result.valid) {
        failures.push({ id: entry.id, method: entry.method, route: entry.route, schema: entry.schema, definition: entry.definition, error: result.errorsText });
        continue;
      }
      checked.push({ id: entry.id, route: entry.route });
    } catch (error) {
      failures.push({ id: entry.id, method: entry.method, route: entry.route, schema: entry.schema, definition: entry.definition, error: error instanceof Error ? error.message : String(error) });
    }
  }

  if (allowActions) {
    await runChatActionProbe({ manifest, validator, bridgeBaseUrl, bridgeToken, failures, checked });
    await runDeviceRegistrationProbe({ manifest, validator, bridgeBaseUrl, bridgeToken, failures, checked });
    await runQueryFacadeProbe({ manifest, validator, dashboardBaseUrl, failures, checked });
    await runTileActionProbe({ manifest, validator, dashboardBaseUrl, failures, checked });
    const actionChecked = new Set(checked.filter((item) => item.mode === 'action-probe').map((item) => item.id));
    for (let i = skipped.length - 1; i >= 0; i--) {
      if (actionChecked.has(skipped[i].id)) skipped.splice(i, 1);
    }
  }

  if (failures.length > 0) {
    const detail = failures.map((f) => `${f.id} ${f.method} ${f.route} schema=${f.schema} definition=${f.definition}: ${f.status || ''} ${f.error}`).join('\n');
    throw new Error(`Live contract validation failed:\n${detail}`);
  }

  return { checked, skipped };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  validateLiveContracts()
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
