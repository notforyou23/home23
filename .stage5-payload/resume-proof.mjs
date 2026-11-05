#!/usr/bin/env node
/** Untracked Encoder proof: interrupt + Range-resume official nomic ONNX. Not a product script. */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadFile, ensureArtifacts, modelRoot } from '../scripts/embedder/artifacts.mjs';
import { HF_ID, OWNED_ARTIFACTS } from '../scripts/embedder/recipe.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const sourceRoot = join(here, '..');
const cacheDir = process.argv[2];
const stage1Root = process.argv[3];
if (!cacheDir || !stage1Root) {
  throw new Error('usage: resume-proof.mjs CACHE_DIR STAGE1_MODEL_ROOT');
}
if (cacheDir === '~' || cacheDir.startsWith('~/') || cacheDir === process.env.HOME || cacheDir.includes('/release/home23')) {
  throw new Error('refuse home/release cache');
}

const rel = 'onnx/model.onnx';
const expectedSha = OWNED_ARTIFACTS[rel];
const url = `https://huggingface.co/${HF_ID}/resolve/main/${rel}`;
const dest = join(modelRoot(cacheDir), rel);
const part = `${dest}.part`;
const interruptBytes = 8 * 1024 * 1024;
const receipt = {
  schema: 'home23.embedder-encoder-resume-proof.v1',
  claimedStage5: false,
  cacheDir,
  url,
  expectedSha,
  workerPids: { interrupt: null, resume: process.pid },
  fetchLog: [],
};

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

mkdirSync(dirname(dest), { recursive: true });
for (const small of ['config.json', 'tokenizer.json', 'tokenizer_config.json']) {
  copyFileSync(join(stage1Root, small), join(modelRoot(cacheDir), small));
}

const interruptScript = `
import { downloadFile } from ${JSON.stringify(join(sourceRoot, 'scripts/embedder/artifacts.mjs'))};
await downloadFile(${JSON.stringify(url)}, ${JSON.stringify(dest)}, { expectedSha: ${JSON.stringify(expectedSha)} });
`;

const child = spawn(process.execPath, ['--input-type=module', '-e', interruptScript], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
receipt.workerPids.interrupt = child.pid;
writeFileSync(join(cacheDir, 'download.lock'), JSON.stringify({
  pid: child.pid,
  dest,
  startedAt: new Date().toISOString(),
}), 'utf8');

const started = Date.now();
await new Promise((resolve, reject) => {
  const timer = setInterval(() => {
    if (existsSync(part) && statSync(part).size >= interruptBytes) {
      clearInterval(timer);
      child.kill('SIGTERM');
      resolve();
    } else if (Date.now() - started > 120_000) {
      clearInterval(timer);
      child.kill('SIGTERM');
      reject(new Error('interrupt-timeout-before-part'));
    } else if (existsSync(dest)) {
      clearInterval(timer);
      child.kill('SIGTERM');
      reject(new Error('download-finished-before-interrupt'));
    }
  }, 200);
  child.on('error', (error) => {
    clearInterval(timer);
    reject(error);
  });
});

await new Promise((resolve) => {
  if (child.exitCode !== null || child.signalCode) return resolve();
  child.on('close', resolve);
  setTimeout(() => {
    if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL');
  }, 2000);
});

if (!existsSync(part) || existsSync(dest)) {
  throw new Error(`interrupt did not leave a .part (part=${existsSync(part)} dest=${existsSync(dest)})`);
}
receipt.interrupt = {
  method: 'SIGTERM-downloadFile-child',
  partBytes: statSync(part).size,
  destExists: existsSync(dest),
  childPid: child.pid,
  childExit: child.exitCode,
  childSignal: child.signalCode,
  survivingAfterInterrupt: [process.pid],
};

const origFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const res = await origFetch(input, init);
  receipt.fetchLog.push({
    url: String(input),
    range: init.headers?.Range ?? null,
    status: res.status,
    contentLength: res.headers.get('content-length'),
    acceptRanges: res.headers.get('accept-ranges'),
    at: new Date().toISOString(),
    workerPid: process.pid,
  });
  return res;
};

receipt.resumeStartedAt = new Date().toISOString();
const verified = await ensureArtifacts(cacheDir, { fetchIfMissing: true });
receipt.resumeFinishedAt = new Date().toISOString();
receipt.ensureArtifacts = verified;
receipt.final = {
  destBytes: existsSync(dest) ? statSync(dest).size : 0,
  destSha256: existsSync(dest) ? sha256File(dest) : null,
  partSurvived: existsSync(part),
  digestMatches: existsSync(dest) && sha256File(dest) === expectedSha,
  resumeUsedRange: receipt.fetchLog.some((row) => row.url.includes(rel) && row.range === `bytes=${receipt.interrupt.partBytes}-`),
  resumeHttp206: receipt.fetchLog.some((row) => row.url.includes(rel) && row.status === 206),
  oneSurvivingWorker: receipt.fetchLog.every((row) => row.workerPid === process.pid),
};
writeFileSync(join(cacheDir, 'download.lock'), JSON.stringify({
  pid: process.pid,
  dest,
  status: receipt.final.digestMatches ? 'complete' : 'failed',
  finishedAt: new Date().toISOString(),
}), 'utf8');

if (!verified.ok || !receipt.final.digestMatches) {
  console.error(JSON.stringify(receipt, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify(receipt, null, 2));
}
