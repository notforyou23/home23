/**
 * Neighbor peer config resolution.
 *
 * Supports the original local-instance names plus remote sibling nodes:
 *   peers: auto
 *   peers: [forrest, "http://jtrpi.local:5014"]
 *   remotePeers:
 *     - name: axiom
 *       url: http://jtrpi.local:5014
 */

'use strict';

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isHttpUrl(value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value.trim());
}

function sanitizePeerName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function peerNameFromUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return sanitizePeerName(url.hostname || 'remote-peer');
  } catch {
    return 'remote-peer';
  }
}

function normalizePublicStateUrl(rawUrl) {
  const trimmed = String(rawUrl || '').trim();
  if (!trimmed) return '';
  const url = new URL(trimmed);
  if (!url.pathname || url.pathname === '/') {
    url.pathname = '/__state/public.json';
  }
  return url.toString();
}

function resolveLocalPeer(peerName, { instancesDir, fsImpl = fs, yamlImpl = yaml }) {
  const safeName = sanitizePeerName(peerName);
  if (!safeName) return null;

  const peerCfgPath = path.join(instancesDir, safeName, 'config.yaml');
  let bridgePort = null;
  try {
    const peerCfg = yamlImpl.load(fsImpl.readFileSync(peerCfgPath, 'utf8')) || {};
    bridgePort = peerCfg.ports?.bridge;
  } catch {
    return null;
  }
  if (!bridgePort) return null;
  return {
    peerName: safeName,
    url: `http://localhost:${bridgePort}/__state/public.json`,
    source: 'local',
  };
}

function resolveRemotePeer(spec) {
  const rawUrl = isPlainObject(spec)
    ? (spec.publicStateUrl || spec.url)
    : spec;
  if (!isHttpUrl(rawUrl)) return null;

  const name = isPlainObject(spec)
    ? sanitizePeerName(spec.name || spec.agent || spec.id || peerNameFromUrl(rawUrl))
    : peerNameFromUrl(rawUrl);
  if (!name) return null;

  return {
    peerName: name,
    url: normalizePublicStateUrl(rawUrl),
    token: isPlainObject(spec) ? spec.token || null : null,
    headers: isPlainObject(spec) && isPlainObject(spec.headers) ? spec.headers : null,
    source: 'remote',
  };
}

function discoverLocalPeers({ instancesDir, thisAgent, fsImpl = fs, yamlImpl = yaml }) {
  let names = [];
  try {
    names = fsImpl.readdirSync(instancesDir)
      .filter((name) => name !== thisAgent)
      .filter((name) => fsImpl.statSync(path.join(instancesDir, name)).isDirectory());
  } catch {
    names = [];
  }

  return names
    .map((name) => resolveLocalPeer(name, { instancesDir, fsImpl, yamlImpl }))
    .filter(Boolean);
}

export function resolveNeighborPeers({ neighborCfg = {}, instancesDir, thisAgent, fsImpl = fs, yamlImpl = yaml }) {
  const resolved = [];
  const peers = neighborCfg.peers;

  if (peers === 'auto' || !peers) {
    resolved.push(...discoverLocalPeers({ instancesDir, thisAgent, fsImpl, yamlImpl }));
  } else if (Array.isArray(peers)) {
    for (const spec of peers) {
      const peer = isHttpUrl(spec) || isPlainObject(spec)
        ? resolveRemotePeer(spec)
        : resolveLocalPeer(spec, { instancesDir, fsImpl, yamlImpl });
      if (peer) resolved.push(peer);
    }
  }

  if (Array.isArray(neighborCfg.remotePeers)) {
    for (const spec of neighborCfg.remotePeers) {
      const peer = resolveRemotePeer(spec);
      if (peer) resolved.push(peer);
    }
  }

  const byName = new Map();
  for (const peer of resolved) {
    if (peer.peerName && !byName.has(peer.peerName)) byName.set(peer.peerName, peer);
  }
  return [...byName.values()];
}

export const _test = {
  normalizePublicStateUrl,
  peerNameFromUrl,
  sanitizePeerName,
};
