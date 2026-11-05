#!/usr/bin/env node
/** Isolated TEST-home Host-path interrupt/resume + Stop. Does not create a home. */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { join } from 'node:path';

const HOME = '/Users/jtr/_JTR23_/development/home23/.home23-worktrees/owned-embedder-stage5-verify/.stage5-product-home';
const NODE = join(HOME, 'bin/node');
const HOST = join(HOME, 'app/scripts/product/host.mjs');
const ONNX = join(HOME, 'runtime/embedder-cache/nomic-ai/nomic-embed-text-v1.5/onnx/model.onnx');
const PART = `${ONNX}.part`;
const KEEP = `${ONNX}.keep`;
const PREP = join(HOME, 'runtime/semantic-prep.json');
const SEED = 32 * 1024 * 1024;
const receipt = {
  schema: 'home23.embedder-stage5-host-interrupt.v1',
  home: '.stage5-product-home',
  startedAt: new Date().toISOString(),
  overlay: ['cli/lib/product-host.js', 'cli/lib/product-embedder.js', 'scripts/embedder/artifacts.mjs', 'scripts/product/semantic-prepare-worker.mjs'],
  steps: [],
};

function host(action) {
  let out = '';
  try {
    out = execFileSync(NODE, [HOST, action, '--home', HOME], {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      env: { PATH: '/usr/bin:/bin', HOME: '/var/empty' },
    });
  } catch (error) {
    out = String(error.stdout || '');
    if (!out.trim()) throw error;
  }
  const line = out.trim().split('\n').pop();
  return JSON.parse(line);
}

function note(name, extra) {
  receipt.steps.push({ name, at: new Date().toISOString(), ...extra });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

try {
  if (!existsSync(ONNX) && !existsSync(KEEP)) throw new Error('missing onnx');
  if (existsSync(ONNX) && !existsSync(KEEP)) renameSync(ONNX, KEEP);
  mkdirSync(join(ONNX, '..'), { recursive: true });
  execFileSync('dd', ['if=' + KEEP, 'of=' + PART, `bs=${SEED}`, 'count=1'], { stdio: 'ignore' });
  const keepBytes = statSync(KEEP).size;
  const prep = JSON.parse(readFileSync(PREP, 'utf8'));
  writeFileSync(PREP, JSON.stringify({
    ...prep,
    phase: 'interrupted',
    workerPid: 0,
    workerLeaseUntil: undefined,
    error: { code: 'host_semantic_interrupted', message: 'Semantic preparation was interrupted. Resume to continue with this home.' },
  }, null, 2));
  note('seeded', { partBytes: statSync(PART).size, keepBytes, phase: 'interrupted' });

  const begin = host('semantic-prepare');
  note('semantic-prepare-1', { ok: begin.ok, phase: begin.semantic?.phase, handle: begin.handle || begin.semantic?.handle });
  let grew = false;
  let workerPid = 0;
  for (let i = 0; i < 90; i += 1) {
    await sleep(2000);
    const live = JSON.parse(readFileSync(PREP, 'utf8'));
    workerPid = live.workerPid || 0;
    const partBytes = existsSync(PART) ? statSync(PART).size : 0;
    if (partBytes > SEED + 1024 * 1024) { grew = true; }
    if (grew && workerPid > 0) break;
    if (live.phase === 'ready') break;
  }
  const beforeKill = existsSync(PART) ? statSync(PART).size : 0;
  if (workerPid > 0) {
    try { process.kill(workerPid, 'SIGTERM'); } catch { /* gone */ }
  }
  await sleep(2500);
  const afterKill = host('status');
  note('killed', {
    workerPid,
    partBytesBeforeKill: beforeKill,
    grew,
    statusPhase: afterKill.semantic?.phase,
    error: afterKill.semantic?.error,
    partBytesAfter: existsSync(PART) ? statSync(PART).size : 0,
    onnxPresent: existsSync(ONNX),
  });

  const resume = host('semantic-prepare');
  note('semantic-prepare-2', { ok: resume.ok, phase: resume.semantic?.phase });
  let ready = false;
  for (let i = 0; i < 180; i += 1) {
    await sleep(2000);
    const live = JSON.parse(readFileSync(PREP, 'utf8'));
    if (live.phase === 'ready' && existsSync(ONNX) && statSync(ONNX).size === keepBytes) {
      ready = true;
      break;
    }
    if (live.phase === 'failed') {
      note('failed', { error: live.error });
      break;
    }
  }
  note('resume-wait', { ready, phase: JSON.parse(readFileSync(PREP, 'utf8')).phase, onnxBytes: existsSync(ONNX) ? statSync(ONNX).size : 0 });

  if (ready) {
    const started = host('start');
    note('start', { ok: started.ok, status: started.status, semanticReady: started.semantic?.semanticReady });
    await sleep(4000);
    const mid = host('status');
    note('status-after-start', { status: mid.status, processes: (mid.processes || []).map(p => ({ name: p.name, status: p.status })) });
    const stopped = host('stop');
    note('stop', {
      ok: stopped.ok,
      status: stopped.status,
      error: stopped.error,
      readyWarm: stopped.semantic?.semanticReady,
    });
    let refused = false;
    try {
      const res = await fetch('http://127.0.0.1:32591/ready', { signal: AbortSignal.timeout(1500) });
      note('ready-after-stop', { http: res.status });
    } catch (error) {
      refused = true;
      note('ready-after-stop', { refused: true, message: String(error.cause?.code || error.message) });
    }
    receipt.stopReadyRefused = refused;
  }

  receipt.ok = grew && ready && receipt.stopReadyRefused === true;
  receipt.finishedAt = new Date().toISOString();
} catch (error) {
  receipt.ok = false;
  receipt.fatal = String(error.message || error);
  receipt.finishedAt = new Date().toISOString();
}

const out = join(new URL('.', import.meta.url).pathname, 'interrupt-stop-receipt.json');
writeFileSync(out, JSON.stringify(receipt, null, 2));
console.log(JSON.stringify({ ok: receipt.ok, out, fatal: receipt.fatal, steps: receipt.steps.map(s => s.name) }, null, 2));
if (!receipt.ok) process.exitCode = 1;
