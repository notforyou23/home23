import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import type { WorkerConfig, WorkerTemplateSummary } from './types.js';

function readJson(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function readYaml(filePath: string): unknown {
  return yaml.load(readFileSync(filePath, 'utf8'));
}

function assertObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function normalizeStringList(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const strings = value.filter((item): item is string => typeof item === 'string' && item.trim() !== '');
  return strings.length > 0 ? strings : fallback;
}

function normalizeWorkerConfig(raw: unknown, rootPath: string, configPath: string): WorkerConfig {
  assertObject(raw, configPath);
  const kind = asString(raw.kind, 'kind');
  if (kind !== 'worker') throw new Error(`${configPath} kind must be worker`);

  const ownerAgent = asString(raw.ownerAgent, 'ownerAgent');
  return {
    kind: 'worker',
    name: asString(raw.name, 'name'),
    displayName: asString(raw.displayName, 'displayName'),
    ownerAgent,
    class: asString(raw.class, 'class'),
    purpose: asString(raw.purpose, 'purpose'),
    provider: typeof raw.provider === 'string' ? raw.provider : undefined,
    model: typeof raw.model === 'string' ? raw.model : undefined,
    tools: raw.tools && typeof raw.tools === 'object' && !Array.isArray(raw.tools) ? raw.tools as Record<string, boolean> : {},
    safetyPolicy: raw.safetyPolicy && typeof raw.safetyPolicy === 'object' && !Array.isArray(raw.safetyPolicy) ? raw.safetyPolicy as Record<string, unknown> : {},
    feedsBrains: normalizeStringList(raw.feedsBrains, [ownerAgent]),
    visibleTo: normalizeStringList(raw.visibleTo, [ownerAgent]),
    limits: raw.limits && typeof raw.limits === 'object' && !Array.isArray(raw.limits) ? raw.limits as WorkerConfig['limits'] : {},
    rootPath,
    configPath
  };
}

export function workersDir(projectRoot: string): string {
  return path.join(projectRoot, 'instances', 'workers');
}

export function listWorkerTemplates(projectRoot: string): WorkerTemplateSummary[] {
  const filePath = path.join(projectRoot, 'config', 'workers.json');
  if (!existsSync(filePath)) return [];
  const raw = readJson(filePath);
  assertObject(raw, filePath);
  assertObject(raw.templates, 'templates');

  return Object.entries(raw.templates)
    .map(([name, value]) => {
      assertObject(value, `templates.${name}`);
      return {
        name,
        displayName: asString(value.displayName, `${name}.displayName`),
        class: asString(value.class, `${name}.class`),
        ownerAgent: asString(value.ownerAgent, `${name}.ownerAgent`),
        purpose: asString(value.purpose, `${name}.purpose`)
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function listWorkers(projectRoot: string): WorkerConfig[] {
  const dir = workersDir(projectRoot);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => path.join(dir, entry.name))
    .map(rootPath => path.join(rootPath, 'worker.yaml'))
    .filter(filePath => existsSync(filePath))
    .map(filePath => normalizeWorkerConfig(readYaml(filePath), path.dirname(filePath), filePath))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function loadWorker(projectRoot: string, name: string): WorkerConfig {
  const worker = listWorkers(projectRoot).find(w => w.name === name);
  if (!worker) throw new Error(`Worker not found: ${name}`);
  return worker;
}
